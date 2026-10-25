// Offer proof check for clinic.quote (03 zk-offer-proof/v1, docs/INTEGRATION.md sections 3 and 4). Code decides,
// right after the referral token and before anything else looks at the request. Every failure means "no proof":
// the clinic then quotes the regular price and never rejects because of a proof (03 "에러 처리").
import { OfferProofV1Schema } from "../../a2a/schemas";
import type { IsoDate } from "../../domain/common";
import { clauseHolds, N, zkEnabled, type ProofBundle, type ZkChart } from "../../zk";
import { verifyOffer } from "../../zk/client";
import { toGlowpassClinic } from "../../zk/identity";
import { currentOffers, isProofOnly } from "./quote";
import type { StoredOffer } from "./store";

/** Spec key first (03 `metadata.offerProof`), then the key the customer agent on main sends today. */
export const OFFER_PROOF_METADATA_KEYS = ["offerProof", "zkOfferProof"] as const;

/** Same as lib/zk/bridge verify: the first verify call starts the prover. ZK_TIMEOUT_MS overrides it. */
const DEFAULT_VERIFY_TIMEOUT_MS = 15_000;

const EMPTY_CHART: ZkChart = {
  types: Array<number>(N).fill(0),
  dates: Array<number>(N).fill(0),
  clinics: Array<number>(N).fill(0),
  salt: "0",
};

// The glowpass bundle (docs/INTEGRATION.md section 5) is pibu/offer-proof@1 without schema, clinicId, chainId and
// registry. It is not a wire object, so fields this check does not read are dropped instead of refused.
const BundleSchema = OfferProofV1Schema.pick({ offerId: true, subjectId: true, today: true, proofs: true }).strip();

export type ProofFailure =
  | "no_proof"
  | "malformed"
  | "other_clinic"
  | "no_such_offer"
  | "zk_disabled"
  | "verifier_unreachable"
  | "verifier_timeout"
  | "rejected"
  | "needs_records";

export type ProofCheck =
  | { verified: true; offerId: string; unanchored: boolean }
  | { verified: false; reason: ProofFailure; offerId?: string; detail?: string };

interface ReadProof {
  bundle: ProofBundle;
  /** Only the full pibu/offer-proof@1 (or a wrapper) names the clinic; a bare bundle does not. */
  clinicId?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Accepts the three shapes a customer agent sends: the full pibu/offer-proof@1, a `{ schema, clinicId?, bundle }`
 * wrapper, and the bare glowpass bundle. `unanchored` and `provingMs` ride along with the bundle but are not
 * pibu/offer-proof@1 fields, so they are taken off before the strict wire schema runs.
 */
function readProof(raw: unknown): ReadProof | null {
  if (!isRecord(raw)) return null;
  if (isRecord(raw.bundle)) {
    const inner = readBundle(raw.bundle);
    if (!inner) return null;
    if (raw.clinicId !== undefined && typeof raw.clinicId !== "string") return null;
    return { bundle: inner, ...(typeof raw.clinicId === "string" ? { clinicId: raw.clinicId } : {}) };
  }
  if (raw.schema === undefined) {
    const bundle = readBundle(raw);
    return bundle ? { bundle } : null;
  }
  const { unanchored, provingMs: _provingMs, ...wire } = raw;
  const parsed = OfferProofV1Schema.safeParse(wire);
  if (!parsed.success) return null;
  const { offerId, subjectId, today, proofs, clinicId } = parsed.data;
  return { bundle: { offerId, subjectId, today, proofs, ...(unanchored === true ? { unanchored: true } : {}) }, clinicId };
}

function readBundle(raw: Record<string, unknown>): ProofBundle | null {
  const parsed = BundleSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { ...parsed.data, ...(raw.unanchored === true ? { unanchored: true } : {}) };
}

/** The empty chart satisfies "0 records" clauses only. A clinic or procedure id unknown to the circuit fails. */
function emptyChartPasses(offer: StoredOffer, today: number): boolean {
  try {
    return (offer.zkClauses ?? []).every((clause) => clauseHolds(EMPTY_CHART, today, clause));
  } catch {
    return false;
  }
}

function verifyTimeoutMs(): number {
  const override = Number(process.env.ZK_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_VERIFY_TIMEOUT_MS;
}

/**
 * Verifies the offer proof in clinic.quote metadata against this clinic's running proof-only events.
 * - The proof must name one of this clinic's events with zkClauses, for the requested procedure, running today.
 * - lib/zk/client verifyOffer must answer ok within the timeout. ZK off, a throw or a timeout fail the check.
 * - An unanchored pseudonym (the verifier or the bundle says `unanchored`) only passes clauses an empty chart
 *   satisfies, i.e. first visit or "0 records" (docs/INTEGRATION.md section 3).
 */
export async function checkOfferProof(input: {
  clinicId: string;
  procedureId: string;
  offers: readonly StoredOffer[];
  today: IsoDate;
  metadata: Record<string, unknown>;
}): Promise<ProofCheck> {
  const raw = OFFER_PROOF_METADATA_KEYS.map((key) => input.metadata[key]).find((value) => value !== undefined && value !== null);
  if (raw === undefined) return { verified: false, reason: "no_proof" };

  const read = readProof(raw);
  if (!read) return { verified: false, reason: "malformed" };
  const { bundle } = read;
  const offerId = bundle.offerId;
  if (read.clinicId !== undefined && read.clinicId !== input.clinicId) {
    return { verified: false, reason: "other_clinic", offerId, detail: read.clinicId };
  }

  const own = input.offers.find((offer) => offer.id === offerId && offer.clinicId === input.clinicId);
  if (!own) return { verified: false, reason: "other_clinic", offerId, detail: "not an offer of this clinic" };
  const offer = currentOffers([own], input.procedureId, input.today).find(isProofOnly);
  if (!offer) return { verified: false, reason: "no_such_offer", offerId, detail: "not a running proof-only event for this procedure" };

  if (!zkEnabled()) return { verified: false, reason: "zk_disabled", offerId, detail: "ZK_SERVER_URL is not set" };
  const registryClinicId = toGlowpassClinic(input.clinicId);
  if (!registryClinicId) return { verified: false, reason: "rejected", offerId, detail: `${input.clinicId} is not in the ZK registry` };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let answer: Awaited<ReturnType<typeof verifyOffer>> | "timeout";
  try {
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), verifyTimeoutMs());
    });
    answer = await Promise.race([verifyOffer(registryClinicId, bundle), timeout]);
  } catch (error) {
    return { verified: false, reason: "verifier_unreachable", offerId, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
  if (answer === "timeout") return { verified: false, reason: "verifier_timeout", offerId };
  if (answer?.ok !== true) {
    return { verified: false, reason: "rejected", offerId, ...(typeof answer?.reason === "string" ? { detail: answer.reason } : {}) };
  }

  const unanchored = answer.unanchored === true || bundle.unanchored === true;
  if (unanchored && !emptyChartPasses(offer, bundle.today)) {
    return { verified: false, reason: "needs_records", offerId, detail: "unanchored pseudonym: only first visit clauses pass" };
  }
  return { verified: true, offerId: offer.id, unanchored };
}
