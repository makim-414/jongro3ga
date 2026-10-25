import { createHash } from "node:crypto";
import { cardUrl } from "../../a2a/client";
import { ReviewV1Schema, type ReviewV1 } from "../../a2a/schemas";
import { taskArtifactText, type WireTask } from "../../a2a/wire";
import type { CustomerProfile, TreatmentRecord } from "../../domain/customer";
import { zkEnabled } from "../../zk";
import { walletView } from "../../zk/client";
import { toGlowpassClinic, toGlowpassPersona } from "../../zk/identity";
import type { WalletView } from "../../zk/types";
import { isTimeout, withTimeout, type OrchestratorDeps } from "./orchestrator";
import { C, getOf } from "./store";

// 후기 제출 (02 P0 "후기 제출 (ZK 확장)", 03 pibu/review@1, docs/INTEGRATION.md sections 3 and 4). A review is for
// one clinic-confirmed visit anchored on chain and goes to the platform with platform.submit_review when the
// customer wants. P0 is the server wallet transition: GlowPass holds the per-visit Semaphore identity and makes and
// checks the real proof when the platform relays the review (POST /api/reviews). So the agent reads its own wallet
// for the unused visit ticket of that (clinic, procedure), then sends the review with the parts of the proof it can
// compute and a nullifier that stays the same for every attempt on the same visit.

export type ReviewErrorCode =
  | "not_found"
  | "invalid_request"
  | "not_reviewable"
  | "no_record_wallet"
  | "no_visit_ticket"
  | "already_reviewed"
  | "review_rejected"
  | "review_failed"
  | "zk_unavailable"
  | "platform_unavailable";

export class ReviewError extends Error {
  constructor(
    public readonly code: ReviewErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ReviewError";
  }
}

export interface ReviewInput {
  rating: number;
  text?: string;
}

export interface ReviewResult {
  accepted: true;
  recordId: string;
  clinicId: string;
  procedureId: string;
  rating: number;
  /** The platform's confirmation, e.g. "review accepted: n=19, average 4.6". */
  platformText?: string;
}

/** The customer's side of GlowPass: whether it is configured, and the private wallet view (GET /api/wallet/:id). */
export interface ReviewZk {
  enabled: () => boolean;
  wallet: (persona: string) => Promise<WalletView>;
}

export const defaultReviewZk: ReviewZk = { enabled: zkEnabled, wallet: walletView };

/** The wallet is one read; the review waits while GlowPass makes and verifies the Semaphore proof (about 2 s each). */
export const WALLET_TIMEOUT_MS = 5_000;
export const REVIEW_TIMEOUT_MS = 30_000;

/** A decimal field element from a string: sha256 shifted under the BN254 field, the way GlowPass derives its fields. */
const toField = (value: string): string => (BigInt(`0x${createHash("sha256").update(value).digest("hex")}`) >> 8n).toString();

/**
 * The visitProof of pibu/review@1. scope and message follow 03 (`review:<clinicId>:<procedureId>`, `{rating, text}`).
 * The nullifier comes from the wallet subject and the agent's own record id, which the platform never sees, so it is
 * the same for every attempt on one visit and the platform refuses a second review of it. Root and points are P0
 * placeholders: GlowPass builds the real group proof from the visit identity when the platform relays the review.
 */
export function visitProofFor(record: Pick<TreatmentRecord, "id" | "clinicId" | "procedureId" | "anchor">, review: { rating: number; text?: string }): ReviewV1["visitProof"] {
  return {
    merkleTreeDepth: 1,
    merkleTreeRoot: "0",
    nullifier: toField(`pibu/review-nullifier:${record.anchor?.subjectId ?? ""}:${record.id}`),
    message: toField(JSON.stringify({ rating: review.rating, text: review.text })),
    scope: toField(`review:${record.clinicId ?? ""}:${record.procedureId}`),
    points: Array.from({ length: 8 }, () => "0"),
  };
}

const statusText = (task: WireTask): string | undefined => task.status.message?.parts.find((part) => part.text !== undefined)?.text;

/**
 * Sends a review of one visit: the record must be the customer's, clinic-confirmed and anchored, the customer must
 * have a record wallet, and GlowPass must show an unused visit ticket for its clinic and procedure. Throws
 * ReviewError; `zk_unavailable` when GlowPass is not configured or not reached.
 */
export async function submitVisitReview(
  deps: Pick<OrchestratorDeps, "store" | "baseUrl" | "send">,
  customerId: string,
  recordId: string,
  input: ReviewInput,
  zk: ReviewZk = defaultReviewZk,
): Promise<ReviewResult> {
  const profile = await getOf<CustomerProfile>(deps.store, C.profiles, customerId);
  if (!profile) throw new ReviewError("not_found", "customer profile not found");
  const record = await getOf<TreatmentRecord>(deps.store, C.records, recordId);
  if (!record || record.customerId !== customerId) throw new ReviewError("not_found", "record not found");
  if (record.source !== "booking" || !record.clinicId || !record.anchor) {
    throw new ReviewError("not_reviewable", "only a clinic-confirmed visit anchored on chain can be reviewed");
  }
  const persona = toGlowpassPersona(profile.agentId) ?? toGlowpassPersona(customerId);
  if (!persona) throw new ReviewError("no_record_wallet", "this customer has no ZK record wallet");

  const text = input.text?.trim() || undefined;
  const parsed = ReviewV1Schema.safeParse({
    schema: "pibu/review@1",
    clinicId: record.clinicId,
    procedureId: record.procedureId,
    rating: input.rating,
    ...(text ? { text } : {}),
    visitProof: visitProofFor(record, { rating: input.rating, ...(text ? { text } : {}) }),
  });
  if (!parsed.success) throw new ReviewError("invalid_request", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const review = parsed.data;

  // the unused visit ticket the D0 anchor left in the customer's own wallet
  if (!zk.enabled()) throw new ReviewError("zk_unavailable", "the ZK server is not configured (ZK_SERVER_URL)");
  let wallet: WalletView;
  try {
    wallet = await withTimeout(zk.wallet(persona), WALLET_TIMEOUT_MS);
  } catch (error) {
    throw new ReviewError("zk_unavailable", `the ZK server did not answer: ${isTimeout(error) ? "timed out" : error instanceof Error ? error.message : String(error)}`);
  }
  const glowpassClinic = toGlowpassClinic(record.clinicId) ?? record.clinicId;
  const ticket = (wallet?.pendingReviews ?? []).some((t) => t.clinicId === glowpassClinic && t.procedureId === record.procedureId);
  if (!ticket) {
    throw new ReviewError("no_visit_ticket", "no unused visit ticket for this clinic and procedure: the visit was already reviewed or not anchored through GlowPass");
  }

  let task: WireTask;
  try {
    task = await withTimeout(
      deps.send({
        from: { role: "customer", agentId: profile.agentId },
        toCardUrl: cardUrl(deps.baseUrl, { role: "platform", agentId: "platform" }),
        skillId: "platform.submit_review",
        data: review,
        text: `Review of a verified visit to ${record.clinicId}.`,
        contextId: record.id,
        timeoutMs: REVIEW_TIMEOUT_MS,
      }),
      REVIEW_TIMEOUT_MS,
    );
  } catch (error) {
    throw new ReviewError("platform_unavailable", isTimeout(error) ? "the platform did not answer in time" : error instanceof Error ? error.message : String(error));
  }

  const reason = statusText(task) ?? taskArtifactText(task) ?? task.status.state;
  if (task.status.state === "TASK_STATE_COMPLETED") {
    const platformText = taskArtifactText(task);
    return { accepted: true, recordId: record.id, clinicId: record.clinicId, procedureId: record.procedureId, rating: review.rating, ...(platformText ? { platformText } : {}) };
  }
  if (task.status.state === "TASK_STATE_REJECTED") {
    throw new ReviewError(reason.startsWith("nullifier_already_used") ? "already_reviewed" : "review_rejected", reason);
  }
  // FAILED: the platform could not reach GlowPass, or GlowPass answered with an error
  throw new ReviewError(reason.includes("ZK server unreachable") ? "zk_unavailable" : "review_failed", reason);
}
