import type { OfferProofV1 } from "../a2a/schemas";
import type {
  AnchorResult,
  LedgerView,
  OfferMatch,
  ProofBundle,
  ReviewInput,
  ReviewResult,
  VerifyResult,
  WalletView,
  ZkStats,
} from "./types";

// Server-side wrapper for the glowpass HTTP API (docs/INTEGRATION.md section 5).
// Import it from server code only (route handlers, agents); it is not re-exported from ./index.
const DEFAULT_REGISTRY = "0xcf47152e720508bf8c757a55aa30956ca8b58857"; // chain/deployments/base-sepolia.json
const DEFAULT_CHAIN_ID = 84532;

const baseUrl = () => (process.env.ZK_SERVER_URL ?? "http://localhost:4000").replace(/\/+$/, "");

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, {
    method,
    cache: "no-store",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const detail = (parsed as { error?: unknown } | undefined)?.error;
    throw new Error(
      `ZK server ${method} ${path} failed (${response.status}): ${typeof detail === "string" ? detail : text.slice(0, 200)}`,
    );
  }
  return parsed as T;
}

const enc = encodeURIComponent;

export const walletView = (customerId: string) => call<WalletView>("GET", `/api/wallet/${enc(customerId)}`);

export const matchOffers = (customerId: string) =>
  call<OfferMatch[]>("POST", "/api/zk/match-offers", { persona: customerId });

export const proveOffer = (customerId: string, offerId: string) =>
  call<ProofBundle>("POST", "/api/zk/prove-offer", { persona: customerId, offerId });

export const verifyOffer = (clinicId: string, bundle: ProofBundle) =>
  call<VerifyResult>("POST", "/api/zk/verify-offer", { clinicId, bundle });

export const anchorVisit = (customerId: string, clinicId: string, procedureId: string) =>
  call<AnchorResult>("POST", "/api/records/visit", { persona: customerId, clinicId, procedureId });

export const submitReview = (customerId: string, clinicId: string, procedureId: string, review: ReviewInput) =>
  call<ReviewResult>("POST", "/api/reviews", { persona: customerId, clinicId, procedureId, ...review });

export const stats = () => call<ZkStats>("GET", "/api/stats");

export const ledger = () => call<LedgerView>("GET", "/api/ledger");

/** Builds the pibu/offer-proof@1 for a clinic.quote message from a server bundle. */
export function toOfferProof(bundle: ProofBundle, clinicId: string): OfferProofV1 {
  return {
    schema: "pibu/offer-proof@1",
    offerId: bundle.offerId,
    clinicId,
    subjectId: bundle.subjectId,
    chainId: Number(process.env.ZK_CHAIN_ID || DEFAULT_CHAIN_ID),
    // An empty value in .env counts as unset
    registry: process.env.ZK_REGISTRY_ADDRESS || DEFAULT_REGISTRY,
    today: bundle.today,
    proofs: bundle.proofs,
  };
}
