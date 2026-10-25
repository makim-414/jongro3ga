// ZK record layer skills of the platform (docs/INTEGRATION.md sections 3 and 4, 03 record-anchor@1 and review@1):
// platform.anchor_record and platform.submit_review. P0 is the server wallet transition: GlowPass holds the
// customer charts, builds the append proof and the Semaphore proof, and verifies them; the platform checks the
// booking, relays through lib/zk/client and keeps the aggregates (07 "검증 방문과 후기 집계").
import { clock } from "../../clock";
import type { SkillHandler, SkillResult } from "../../a2a/contract";
import type { RecordAnchorV1, ReviewV1 } from "../../a2a/schemas";
import type { AnchorLog, Locale, VerifiedVisitStat } from "../../domain";
import { anchorVisit, submitReview } from "../../zk/client";
import { toGlowpassPersona } from "../../zk/identity";
import { mean, roundTo } from "./stats";
import { platformStore, statKey, type StoredReviewStat } from "./store";

const rejected = (text: string): SkillResult => ({ state: "TASK_STATE_REJECTED", text });
const failed = (text: string): SkillResult => ({ state: "TASK_STATE_FAILED", text });

/**
 * Readable reason for a failed GlowPass call. lib/zk/client throws "ZK server <method> <path> failed (<status>): ..."
 * when the server answered with an error; anything else (fetch failed, refused, DNS) means it was not reached.
 */
function zkFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("ZK server ") ? message : `ZK server unreachable: ${message}`;
}

/** Booking statuses that rule out an anchor even when a D0 outcome is in. */
const NOT_DONE = new Set(["canceled", "no_show"]);

// ---- platform.anchor_record ----

/**
 * The booking must be the caller's and done (status completed, or a D0 outcome in). The record hash is not
 * recomputed in P0: lib/zk has no Pedersen hash, and GlowPass builds the append proof (and its nonce) itself from
 * the server wallet, so the hash in the message is not the one that goes on chain. The relayer also issues the
 * visit ticket for the (clinic, procedure) review group in the same call; the platform counts it as one more
 * verified visit.
 */
export const anchorRecordSkill: SkillHandler = async (data, ctx) => {
  const input = data as unknown as RecordAnchorV1;
  if (ctx.caller.role !== "customer") return rejected("records are anchored for customer agents only");

  const attribution = await platformStore.attribution(input.bookingId);
  // Unknown and foreign bookings get the same answer so a caller cannot probe other customers' booking ids.
  if (!attribution || attribution.customerAgentId !== ctx.caller.agentId) {
    return rejected(`booking_not_owned: ${input.bookingId} is not a booking of this customer agent`);
  }
  if (attribution.clinicId !== input.clinicId) return rejected(`clinic_mismatch: ${input.bookingId} is at ${attribution.clinicId}`);
  const d0 = (await platformStore.outcomes()).find((o) => o.bookingId === input.bookingId && o.checkpoint === "D0");
  const done = attribution.status === "completed" || (d0 !== undefined && !NOT_DONE.has(attribution.status));
  if (!done) return rejected(`booking_not_completed: ${input.bookingId} is ${attribution.status}`);
  if (d0 && d0.procedureId !== input.procedureId) return rejected(`procedure_mismatch: ${input.bookingId} was ${d0.procedureId}`);
  if ((await platformStore.anchorLogs()).some((log) => log.bookingId === input.bookingId)) {
    return rejected(`already_anchored: ${input.bookingId} has a record on chain`);
  }
  const persona = toGlowpassPersona(ctx.caller.agentId);
  if (!persona) return rejected("no_record_wallet: this customer agent has no ZK record wallet");

  let anchored: { tx: string; day: number };
  try {
    anchored = await anchorVisit(persona, input.clinicId, input.procedureId);
  } catch (error) {
    return failed(`anchor_failed: ${zkFailure(error)}`);
  }

  const log: AnchorLog = {
    id: `anc_${input.bookingId}`,
    bookingId: input.bookingId,
    subjectId: input.subjectId,
    tx: anchored.tx,
    day: anchored.day,
    at: clock.nowIso(),
  };
  await platformStore.putAnchorLog(log);

  const stat = (await platformStore.verifiedVisits()).find((v) => v.clinicId === input.clinicId && v.procedureId === input.procedureId);
  const visits: VerifiedVisitStat = stat
    ? { ...stat, count: stat.count + 1 }
    : { id: `vv_${statKey(input.clinicId, input.procedureId)}`, clinicId: input.clinicId, procedureId: input.procedureId, count: 1 };
  await platformStore.putVerifiedVisits(visits);
  return { state: "TASK_STATE_COMPLETED", text: `anchored ${anchored.tx}` };
};

// ---- platform.submit_review ----

/** Locale of a review text from its script, for the published review list. Kana wins over shared CJK ideographs. */
export function detectLocale(text: string): Locale {
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[가-힯ᄀ-ᇿ㄰-㆏]/.test(text)) return "ko";
  if (/[一-鿿]/.test(text)) return "zh-CN";
  return "en";
}

/**
 * One review per visit. A spent nullifier is refused here before GlowPass is asked; the group membership and the
 * Semaphore proof are checked by GlowPass in P0 (it holds the visit identity and makes the proof). Accepted reviews
 * join the (clinic, procedure) aggregate with their text.
 */
export const submitReviewSkill: SkillHandler = async (data, ctx) => {
  const input = data as unknown as ReviewV1;
  if (ctx.caller.role !== "customer") return rejected("reviews come from customer agents only");

  const stat = (await platformStore.reviewStats()).find((r) => r.clinicId === input.clinicId && r.procedureId === input.procedureId);
  if (stat?.nullifiers.includes(input.visitProof.nullifier)) {
    return rejected("nullifier_already_used: this visit has already been reviewed");
  }
  const persona = toGlowpassPersona(ctx.caller.agentId);
  if (!persona) return rejected("no_record_wallet: this customer agent has no ZK record wallet");

  try {
    const result = await submitReview(persona, input.clinicId, input.procedureId, {
      rating: input.rating,
      ...(input.text === undefined ? {} : { text: input.text }),
    });
    if (!result?.ok) return rejected(`review_rejected: ${result?.reason ?? "the visit proof was not accepted"}`);
  } catch (error) {
    return failed(`review_failed: ${zkFailure(error)}`);
  }

  const text = input.text ?? "";
  const reviews = [...(stat?.reviews ?? []), { rating: input.rating, text, locale: detectLocale(text) }];
  const next: StoredReviewStat = {
    id: stat?.id ?? `rs_${statKey(input.clinicId, input.procedureId)}`,
    clinicId: input.clinicId,
    procedureId: input.procedureId,
    n: reviews.length,
    avgRating: roundTo(mean(reviews.map((r) => r.rating)), 1),
    nullifiers: [...(stat?.nullifiers ?? []), input.visitProof.nullifier],
    reviews,
  };
  await platformStore.putReviewStats(next);
  return { state: "TASK_STATE_COMPLETED", text: `review accepted: n=${next.n}, average ${next.avgRating.toFixed(1)}` };
};
