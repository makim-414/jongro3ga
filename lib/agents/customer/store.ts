import type { AgentRef } from "../../a2a/contract";
import type { ClinicShortlistV1, InputRequestV1 } from "../../a2a/schemas";
import type {
  ConsentEntry,
  CustomerAccount,
  CustomerBooking,
  CustomerProfile,
  CustomerRequest,
  OutcomeDraft,
  ReceivedQuote,
  TreatmentRecord,
} from "../../domain/customer";
import type { I18nText, IsoDate, IsoDateTime } from "../../domain/common";
import type { NotificationV1 } from "../../a2a/schemas";
import type { Store } from "../../store/types";

// The customer namespace (06-data-model.md). Only lib/agents/customer reads and writes it.
// Collections and their item types; the extra fields beyond the 06 entities are customer agent state.
export const NS = "customer" as const;

export const C = {
  accounts: "accounts",
  profiles: "profiles",
  consents: "consents",
  records: "records",
  requests: "requests",
  shortlists: "shortlists",
  quotes: "quotes",
  bookings: "bookings",
  outcomes: "outcomes",
  inbox: "inbox",
} as const;

export type RequestFailure =
  | "not_eligible_foreign_patient"
  | "platform_unavailable"
  | "no_candidates"
  | "no_quotes"
  | "consent_required";

export interface StoredRequest extends CustomerRequest {
  updatedAt: IsoDateTime;
  failure?: RequestFailure;
}

export interface StoredCandidate {
  clinicId: string;
  agentCardUrl: string;
  score: number;
  reasons: string[];
  referralToken: string;
  /** Clinic-confirmed visits of PibooK users (visit tickets). Display only, never part of the score. */
  verifiedVisits?: number;
  /** Aggregate of verified reviews, present only when n >= 3 (anonymity set, owner decision 2026-10-24: reviews are public). */
  reviewStats?: { n: number; avgRating: number };
}

/** The platform's shortlist for a request (one per request id), with what happened at each clinic. */
export interface StoredShortlist {
  id: string;
  requestId: string;
  matchId: string;
  appliedRuleIds: string[];
  priceReference: ClinicShortlistV1["priceReference"];
  candidates: StoredCandidate[];
  /** Clinics that did not answer with a quote. */
  failures: { clinicId: string; kind: "response_timeout" | "rejection" | "error"; taskId?: string; reason?: string }[];
  /** Clinics that got a ZK offer proof attached (never the reason or the history). */
  zkProofClinicIds: string[];
}

export interface StoredBooking extends CustomerBooking {
  customerId: string;
  quoteId: string;
  slot: IsoDateTime;
  priceKrw: number;
  procedureId: string;
  agentCardUrl: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** Fields a clinic asked for that the agent could not answer from consented profile values. */
  inputRequest?: InputRequestV1;
  failure?: string;
}

export interface StoredOutcome extends OutcomeDraft {
  customerId: string;
  /** False when the customer has not consented to anonymized sharing: kept locally, never sent. */
  shared?: boolean;
  sendError?: string;
}

export type InboxKind = NotificationV1["kind"] | "checkin_due" | "checkin_request";

export interface InboxItem {
  id: string;
  customerId: string;
  kind: InboxKind;
  text: I18nText;
  bookingId?: string;
  /** For check-ins: which checkpoint and the procedure day it follows. */
  checkpoint?: "D7" | "D30";
  procedureDay?: IsoDate;
  /** customer.checkin: the platform task waiting for the answer and its questions. */
  taskId?: string;
  questions?: string[];
  from?: AgentRef;
  /** When it should be shown; future items are "upcoming". */
  dueAt: IsoDateTime;
  createdAt: IsoDateTime;
  readAt?: IsoDateTime;
  status: "open" | "done";
}

export type StoredProfile = CustomerProfile;
export type StoredRecord = TreatmentRecord;
export type StoredQuote = ReceivedQuote;
export type { ConsentEntry, CustomerAccount };

export const listOf = <T>(store: Store, collection: string, filter?: Partial<T>) => store.list<T>(NS, collection, filter);
export const getOf = <T>(store: Store, collection: string, id: string) => store.get<T>(NS, collection, id);
export const putOf = <T extends { id: string }>(store: Store, collection: string, value: T) => store.put<T>(NS, collection, value);

/** Short random suffix for ids ("req_k3j9x2m1a0"), letters and digits only to fit the wire id patterns. */
export function newId(prefix: string): string {
  const raw = globalThis.crypto.randomUUID().replace(/-/g, "");
  return `${prefix}_${raw.slice(0, 12)}`;
}
