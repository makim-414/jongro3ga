import { cardUrl, getTask as a2aGetTask, sendMessage as a2aSendMessage, type SendOptions } from "../../a2a/client";
import type { AgentRef, TaskCompleter } from "../../a2a/contract";
import {
  BookingV1Schema,
  ClinicShortlistV1Schema,
  FairnessVerdictListV1Schema,
  InputRequestV1Schema,
  OfferProofV1Schema,
  OutcomeV1Schema,
  ProcedureRequestV1Schema,
  QuoteV1Schema,
  RecipeV1Schema,
  type FairnessVerdictV1,
  type InputRequestV1,
  type OfferProofV1,
  type OutcomeV1,
  type ProcedureRequestV1,
  type QuoteV1,
  type SignalReportV1,
} from "../../a2a/schemas";
import { taskCompleter as a2aTaskCompleter } from "../../a2a/tasks";
import { firstDataPart, isTerminalState, taskArtifactData, taskArtifactText, type WireTask } from "../../a2a/wire";
import { clock } from "../../clock";
import type { Amount, Area, IsoDate, Locale } from "../../domain/common";
import type { CustomerAccount, CustomerProfile, TreatmentRecord } from "../../domain/customer";
import { getStore } from "../../store";
import type { Store } from "../../store/types";
import { ZK_CHAIN } from "../../ui-data/customer";
import { matchOffers, proveOffer, zkEnabled, type ZkOfferProofBundle } from "../../zk";
import { clinicEntry } from "./clinic-directory";
import { ConsentError, bookingRequestFor, clinicRequestCopy, consentedAnswers, consentsOf, mayShareOutcome, platformRequestCopy } from "./consent";
import { bookingConfirmedText, checkinDueText } from "./copy";
import { addRecord, renumber } from "./records";
import { fallbackAmount, masterProcedureId, sameProcedure } from "./procedures";
import { canMatchProfile } from "./seed";
import { ANCHOR_TIMEOUT_MS, anchoredTx, d0AnchorFor, d0AnchorRequest, isRelayedAnchor } from "./anchor";
import { addDays, checkinDueAt } from "./schedule";
import {
  C,
  NS,
  getOf,
  listOf,
  newId,
  putOf,
  type InboxItem,
  type RequestFailure,
  type StoredBooking,
  type StoredCandidate,
  type StoredOutcome,
  type StoredQuote,
  type StoredRequest,
  type StoredShortlist,
} from "./store";

// The customer agent's conversation on the customer's behalf (02 "대화 대행", 03 "전체 시퀀스"):
// recipe (when the amount is missing) -> match_clinics -> clinic.quote to every candidate in parallel
// (20s, Promise.allSettled, timeouts and rejections reported with platform.report_signal) -> judge_quote ->
// comparing. Then booking (clinic.book, returnImmediately) with GetTask polling, and outcomes.
// Agents talk only through the A2A client; route handlers call these functions.

export interface OrchestratorDeps {
  store: Store;
  /** PUBLIC_BASE_URL, used for the platform card URL. Clinic card URLs come from the shortlist. */
  baseUrl: string;
  send: (options: SendOptions) => Promise<WireTask>;
  get: (options: { from: AgentRef; toCardUrl: string; taskId: string }) => Promise<WireTask>;
  completer: TaskCompleter;
  quoteTimeoutMs: number;
  pollIntervalMs: number;
  pollMaxMs: number;
  sleep: (ms: number) => Promise<void>;
  zk: { enabled: () => boolean; matchOffers: typeof matchOffers; proveOffer: typeof proveOffer };
}

export const QUOTE_TIMEOUT_MS = 20_000;
export const POLL_INTERVAL_MS = 3_000;
export const POLL_MAX_MS = 10 * 60_000;

export function defaultDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    store: getStore(),
    baseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:3000",
    send: a2aSendMessage,
    get: a2aGetTask,
    completer: a2aTaskCompleter,
    quoteTimeoutMs: QUOTE_TIMEOUT_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
    pollMaxMs: POLL_MAX_MS,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    zk: { enabled: zkEnabled, matchOffers, proveOffer },
    ...overrides,
  };
}

export class OrchestratorError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "not_eligible"
      | "invalid_request"
      | "invalid_state"
      | "slot_unavailable"
      | "consent_required"
      | "clinic_unavailable"
      | "already_booked",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "OrchestratorError";
  }
}

class TimeoutError extends Error {
  constructor() {
    super("timed out");
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError" || /time(d)?\s?out/i.test(error.message);
}

const selfRef = (profile: Pick<CustomerProfile, "agentId">): AgentRef => ({ role: "customer", agentId: profile.agentId });
const platformCard = (deps: OrchestratorDeps) => cardUrl(deps.baseUrl, { role: "platform", agentId: "platform" });

// ---------------------------------------------------------------------------
// Request drafting (02 "요청 정리")
// ---------------------------------------------------------------------------

export interface ConditionInput {
  procedureId: string;
  amount?: Amount;
  budgetKrw?: number;
  areas?: Area[];
  languages?: Locale[];
  dateWindow?: { from: IsoDate; to: IsoDate };
  productPreference?: string;
}

/** Area groups of 07: the stay area stands for its whole group. */
const AREA_GROUP: Record<Area, Area[]> = {
  gangnam: ["sinsa", "gangnam", "apgujeong"],
  sinsa: ["sinsa", "gangnam", "apgujeong"],
  apgujeong: ["sinsa", "gangnam", "apgujeong"],
  myeongdong: ["myeongdong"],
  hongdae: ["hongdae"],
  other: [],
};

export function areaGroup(area: Area | undefined): Area[] {
  return area ? AREA_GROUP[area] : [];
}

/** Defaults of 02: profile budget, stay area group, stay dates, profile languages. */
export function buildProcedureRequest(args: {
  profile: CustomerProfile;
  condition: ConditionInput;
  requestId: string;
  amount: Amount;
  firstKProcedure: boolean;
}): ProcedureRequestV1 {
  const { profile, condition, requestId, amount } = args;
  const today = clock.today();
  const languages = condition.languages?.length ? condition.languages : profile.prefs.languagesNeeded.length ? profile.prefs.languagesNeeded : [profile.locale];
  const dateWindow =
    condition.dateWindow?.from && condition.dateWindow.to
      ? condition.dateWindow
      : profile.trip
        ? { from: profile.trip.arrival, to: profile.trip.departure }
        : { from: today, to: addDays(today, 30) };
  const areas = condition.areas ?? areaGroup(profile.trip?.stayArea);
  const budget = condition.budgetKrw ?? profile.prefs.budgetKrw?.max;
  const request: ProcedureRequestV1 = {
    schema: "pibu/procedure-request@1",
    requestId,
    customerAgentId: profile.agentId,
    procedureId: condition.procedureId,
    productPreference: condition.productPreference ?? "any",
    amount,
    ...(budget !== undefined ? { budgetKrw: { max: budget } } : {}),
    ...(areas.length > 0 ? { areas } : {}),
    languages,
    dateWindow,
    visitorProfile: {
      nationality: profile.nationality,
      ...(profile.residency ? { residency: profile.residency } : {}),
      ageBand: profile.ageBand,
      firstKProcedure: args.firstKProcedure,
    },
  };
  const parsed = ProcedureRequestV1Schema.safeParse(request);
  if (!parsed.success) throw new OrchestratorError("invalid_request", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}

async function loadProfile(store: Store, customerId: string): Promise<CustomerProfile> {
  const profile = await getOf<CustomerProfile>(store, C.profiles, customerId);
  if (!profile) throw new OrchestratorError("not_found", "customer profile not found");
  return profile;
}

async function loadRequest(store: Store, customerId: string, requestId: string): Promise<StoredRequest> {
  const request = await getOf<StoredRequest>(store, C.requests, requestId);
  if (!request || request.customerId !== customerId) throw new OrchestratorError("not_found", "request not found");
  return request;
}

/** platform.recipe: the usual minimum amount Korean women chose (02 default rule). Undefined on any failure. */
async function recipeAmount(deps: OrchestratorDeps, profile: CustomerProfile, procedureId: string, requestId: string): Promise<Amount | undefined> {
  if (profile.skin.concerns.length === 0) return undefined;
  try {
    const task = await deps.send({
      from: selfRef(profile),
      toCardUrl: platformCard(deps),
      skillId: "platform.recipe",
      data: { schema: "pibu/recipe-query@1", concerns: profile.skin.concerns, ageBand: profile.ageBand, procedureIds: [procedureId] },
      text: `Usual amount for ${procedureId}, ${profile.ageBand}.`,
      contextId: requestId,
    });
    if (task.status.state !== "TASK_STATE_COMPLETED") return undefined;
    const recipe = RecipeV1Schema.safeParse(taskArtifactData(task));
    if (!recipe.success) return undefined;
    const match = recipe.data.procedures.find((p) => sameProcedure(p.procedureId, procedureId));
    return match ? { value: match.typicalAmount.min, unit: match.typicalAmount.unit } : undefined;
  } catch {
    return undefined;
  }
}

async function hasBookedBefore(store: Store, customerId: string): Promise<boolean> {
  const records = await listOf<TreatmentRecord>(store, C.records, { customerId });
  return records.length > 0;
}

/**
 * Creates a draft request from a condition card. When the amount is missing the agent asks platform.recipe
 * (logged under the new request id) and fills the usual minimum.
 */
export async function createDraft(
  deps: OrchestratorDeps,
  customerId: string,
  condition: ConditionInput,
  rawUtterance: string,
): Promise<StoredRequest> {
  const profile = await loadProfile(deps.store, customerId);
  if (!canMatchProfile(profile)) throw new OrchestratorError("not_eligible", "matching is open to foreign short-term visitors only");
  const requestId = newId("req");
  const amount = condition.amount ?? (await recipeAmount(deps, profile, condition.procedureId, requestId)) ?? fallbackAmount(condition.procedureId);
  const request = buildProcedureRequest({
    profile,
    condition,
    requestId,
    amount,
    firstKProcedure: !(await hasBookedBefore(deps.store, customerId)),
  });
  const now = clock.nowIso();
  const stored: StoredRequest = { id: requestId, customerId, rawUtterance, request, status: "draft", createdAt: now, updatedAt: now };
  await putOf(deps.store, C.requests, stored);
  return stored;
}

/** Applies the customer's edits from the condition card to a draft (or a finished request being rerun). */
export async function updateDraft(
  deps: OrchestratorDeps,
  customerId: string,
  requestId: string,
  condition: Partial<ConditionInput> = {},
): Promise<StoredRequest> {
  const existing = await loadRequest(deps.store, customerId, requestId);
  const profile = await loadProfile(deps.store, customerId);
  const procedureId = condition.procedureId || existing.request.procedureId;
  const procedureChanged = !sameProcedure(procedureId, existing.request.procedureId);
  const amount = condition.amount ?? (procedureChanged ? fallbackAmount(procedureId) : existing.request.amount);
  const request = buildProcedureRequest({
    profile,
    condition: {
      areas: existing.request.areas ?? [],
      languages: existing.request.languages,
      dateWindow: existing.request.dateWindow,
      budgetKrw: existing.request.budgetKrw?.max,
      productPreference: existing.request.productPreference,
      ...stripUndefined(condition),
      procedureId,
    },
    requestId,
    amount,
    firstKProcedure: existing.request.visitorProfile.firstKProcedure ?? true,
  });
  const next: StoredRequest = { ...existing, request, updatedAt: clock.nowIso() };
  await putOf(deps.store, C.requests, next);
  return next;
}

const RERUNNABLE = new Set<StoredRequest["status"]>(["draft", "comparing", "failed", "closed"]);

/**
 * [이 조건으로 찾기]: applies the card edits and marks the request as matching so the next poll already shows
 * progress. The caller then runs runRequest in the background. A run in progress or a live booking is refused.
 */
export async function startRequest(deps: OrchestratorDeps, customerId: string, requestId: string, condition: Partial<ConditionInput> = {}): Promise<StoredRequest> {
  const existing = await loadRequest(deps.store, customerId, requestId);
  if (!RERUNNABLE.has(existing.status)) throw new OrchestratorError("invalid_state", `request is ${existing.status}`);
  const active = (await listOf<StoredBooking>(deps.store, C.bookings, { requestId })).some((b) => ["requested", "pending_clinic", "confirmed"].includes(b.status));
  if (active) throw new OrchestratorError("already_booked");
  await updateDraft(deps, customerId, requestId, condition);
  return setStatus(deps.store, requestId, "matching");
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

async function setStatus(store: Store, requestId: string, status: StoredRequest["status"], extra: Partial<StoredRequest> = {}): Promise<StoredRequest> {
  const current = (await getOf<StoredRequest>(store, C.requests, requestId)) as StoredRequest;
  const next: StoredRequest = { ...current, ...extra, status, updatedAt: clock.nowIso() };
  if (status !== "failed") delete next.failure;
  await putOf(store, C.requests, next);
  return next;
}

const fail = (store: Store, requestId: string, failure: RequestFailure) => setStatus(store, requestId, "failed", { failure });

// ---------------------------------------------------------------------------
// Match -> parallel quotes -> judge
// ---------------------------------------------------------------------------

export interface RunResult {
  request: StoredRequest;
  quotes: StoredQuote[];
  shortlist?: StoredShortlist;
}

/** ZK persona of the customer (INTEGRATION 2). Only accounts with a persona can hold a ZK wallet. */
async function zkPersona(store: Store, customerId: string): Promise<string | undefined> {
  const account = await getOf<CustomerAccount>(store, C.accounts, customerId);
  return account?.demoPersona;
}

/**
 * Offers this customer is eligible for, by clinic. Matching happens where the chart is (INTEGRATION 4),
 * and nothing is requested for clinics without an eligible offer, so a failed proof never leaks anything.
 */
async function eligibleOffers(deps: OrchestratorDeps, persona: string | undefined): Promise<Map<string, string>> {
  const byClinic = new Map<string, string>();
  if (!persona || !deps.zk.enabled()) return byClinic;
  try {
    const offers = await deps.zk.matchOffers(persona);
    for (const offer of offers ?? []) if (offer.eligible && !byClinic.has(offer.clinicId)) byClinic.set(offer.clinicId, offer.offerId);
  } catch {
    // no wallet or ZK server down: quote without proofs
  }
  return byClinic;
}

/**
 * metadata.offerProof of clinic.quote (03 zk-offer-proof/v1, INTEGRATION 3): the wallet bundle as pibu/offer-proof@1,
 * naming the clinic, chain and registry. A bundle that does not fit the wire schema goes as it is; the clinic reads
 * both shapes.
 */
function offerProofFor(bundle: ZkOfferProofBundle, clinicId: string): OfferProofV1 | ZkOfferProofBundle {
  const chainId = Number(process.env.ZK_CHAIN_ID);
  const parsed = OfferProofV1Schema.safeParse({
    schema: "pibu/offer-proof@1",
    offerId: bundle.offerId,
    clinicId,
    subjectId: bundle.subjectId,
    chainId: Number.isInteger(chainId) && chainId > 0 ? chainId : ZK_CHAIN.chainId,
    registry: process.env.ZK_REGISTRY_ADDRESS || ZK_CHAIN.registry,
    today: bundle.today,
    proofs: bundle.proofs,
  });
  return parsed.success ? parsed.data : bundle;
}

type QuoteOutcome =
  | { kind: "quote"; candidate: StoredCandidate; quote: QuoteV1; taskId: string }
  | { kind: "rejection"; candidate: StoredCandidate; taskId?: string; reason?: string }
  | { kind: "response_timeout"; candidate: StoredCandidate }
  | { kind: "error"; candidate: StoredCandidate; taskId?: string; reason?: string };

function statusText(task: WireTask): string | undefined {
  return task.status.message?.parts.find((part) => part.text !== undefined)?.text;
}

export async function runRequest(deps: OrchestratorDeps, customerId: string, requestId: string): Promise<RunResult> {
  const { store } = deps;
  const stored = await loadRequest(store, customerId, requestId);
  const profile = await loadProfile(store, customerId);
  const from = selfRef(profile);
  const consents = await consentsOf(store, customerId);

  if (!canMatchProfile(profile)) return { request: await fail(store, requestId, "not_eligible_foreign_patient"), quotes: [] };

  let platformCopy: ProcedureRequestV1;
  try {
    platformCopy = platformRequestCopy(stored.request, consents);
  } catch (error) {
    if (error instanceof ConsentError) return { request: await fail(store, requestId, "consent_required"), quotes: [] };
    throw error;
  }

  // a rerun starts from a clean comparison
  for (const old of await listOf<StoredQuote>(store, C.quotes, { requestId })) await store.remove(NS, C.quotes, old.id);
  await setStatus(store, requestId, "matching");

  // 1. platform.match_clinics
  let matchTask: WireTask;
  try {
    matchTask = await deps.send({
      from,
      toCardUrl: platformCard(deps),
      skillId: "platform.match_clinics",
      data: platformCopy,
      text: `Find clinics for ${platformCopy.procedureId} ${platformCopy.amount.value}${platformCopy.amount.unit}, ${platformCopy.dateWindow.from}~${platformCopy.dateWindow.to}.`,
      contextId: requestId,
    });
  } catch {
    return { request: await fail(store, requestId, "platform_unavailable"), quotes: [] };
  }
  if (matchTask.status.state === "TASK_STATE_REJECTED") return { request: await fail(store, requestId, "not_eligible_foreign_patient"), quotes: [] };
  const shortlistParsed = matchTask.status.state === "TASK_STATE_COMPLETED" ? ClinicShortlistV1Schema.safeParse(taskArtifactData(matchTask)) : undefined;
  if (!shortlistParsed?.success) return { request: await fail(store, requestId, "platform_unavailable"), quotes: [] };
  const shortlistData = shortlistParsed.data;

  const shortlist: StoredShortlist = {
    id: requestId,
    requestId,
    matchId: shortlistData.matchId,
    appliedRuleIds: shortlistData.appliedRuleIds,
    priceReference: shortlistData.priceReference,
    candidates: shortlistData.candidates.map((c) => ({ ...c })),
    failures: [],
    zkProofClinicIds: [],
  };
  await putOf(store, C.shortlists, shortlist);
  if (shortlist.candidates.length === 0) return { request: await fail(store, requestId, "no_candidates"), quotes: [], shortlist };

  // 2. clinic.quote to every candidate in parallel
  await setStatus(store, requestId, "quoting", { matchId: shortlist.matchId });
  const clinicCopy = clinicRequestCopy(stored.request);
  const persona = await zkPersona(store, customerId);
  const offers = await eligibleOffers(deps, persona);

  const askClinic = async (candidate: StoredCandidate): Promise<QuoteOutcome> => {
    const metadata: Record<string, unknown> = { referralToken: candidate.referralToken };
    // Only a clinic with an eligible offer gets a proof. The clinic card's zk-offer-proof extension is not
    // checked here: cards are fetched and cached inside the A2A client, out of the orchestrator's reach.
    const offerId = offers.get(candidate.clinicId);
    if (offerId && persona) {
      let bundle: ZkOfferProofBundle | null = null;
      try {
        bundle = await deps.zk.proveOffer(persona, offerId);
      } catch {
        bundle = null;
      }
      if (bundle) {
        metadata.offerProof = offerProofFor(bundle, candidate.clinicId);
        shortlist.zkProofClinicIds.push(candidate.clinicId);
      }
    }
    try {
      const task = await withTimeout(
        deps.send({
          from,
          toCardUrl: candidate.agentCardUrl,
          skillId: "clinic.quote",
          data: clinicCopy,
          text: `Quote request for ${clinicCopy.procedureId} ${clinicCopy.amount.value}${clinicCopy.amount.unit}, ${clinicCopy.dateWindow.from}~${clinicCopy.dateWindow.to}.`,
          contextId: requestId,
          metadata,
          timeoutMs: deps.quoteTimeoutMs,
        }),
        deps.quoteTimeoutMs,
      );
      if (task.status.state === "TASK_STATE_REJECTED") return { kind: "rejection", candidate, taskId: task.id, reason: statusText(task) };
      if (task.status.state !== "TASK_STATE_COMPLETED") return { kind: "error", candidate, taskId: task.id, reason: task.status.state };
      const quote = QuoteV1Schema.safeParse(taskArtifactData(task));
      if (!quote.success) return { kind: "error", candidate, taskId: task.id, reason: "invalid quote" };
      return { kind: "quote", candidate, quote: quote.data, taskId: task.id };
    } catch (error) {
      return isTimeout(error) ? { kind: "response_timeout", candidate } : { kind: "error", candidate, reason: error instanceof Error ? error.message : String(error) };
    }
  };

  const settled = await Promise.allSettled(shortlist.candidates.map(askClinic));
  const outcomes: QuoteOutcome[] = settled.map((result, i) =>
    result.status === "fulfilled" ? result.value : { kind: "error", candidate: shortlist.candidates[i] as StoredCandidate, reason: String(result.reason) },
  );

  const receivedAt = clock.nowIso();
  const quotes: StoredQuote[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "quote") {
      quotes.push({ id: `${requestId}:${outcome.quote.quoteId}`, requestId, quote: outcome.quote, taskId: outcome.taskId, receivedAt });
    } else {
      shortlist.failures.push({
        clinicId: outcome.candidate.clinicId,
        kind: outcome.kind,
        ...("taskId" in outcome && outcome.taskId ? { taskId: outcome.taskId } : {}),
        ...("reason" in outcome && outcome.reason ? { reason: outcome.reason } : {}),
      });
    }
  }
  await putOf(store, C.shortlists, shortlist);
  for (const quote of quotes) await putOf(store, C.quotes, quote);

  // timeouts and rejections go to the platform as signals (02, 03 "에러 처리"); a failed report never blocks
  const signals = shortlist.failures.filter((f) => f.kind === "response_timeout" || f.kind === "rejection");
  await Promise.allSettled(
    signals.map((failure) => {
      const data: SignalReportV1 = {
        schema: "pibu/signal-report@1",
        clinicId: failure.clinicId,
        kind: failure.kind as SignalReportV1["kind"],
        ...(failure.taskId ? { taskId: failure.taskId } : {}),
        requestId,
        at: clock.nowIso(),
      };
      return deps.send({ from, toCardUrl: platformCard(deps), skillId: "platform.report_signal", data, text: `${failure.kind} from ${failure.clinicId}.`, contextId: requestId });
    }),
  );

  if (quotes.length === 0) return { request: await fail(store, requestId, "no_quotes"), quotes, shortlist };

  // 3. platform.judge_quote with every quote
  await setStatus(store, requestId, "judging");
  try {
    const judgeTask = await deps.send({
      from,
      toCardUrl: platformCard(deps),
      skillId: "platform.judge_quote",
      data: {
        schema: "pibu/judge-request@1",
        requestId,
        matchId: shortlist.matchId,
        quotes: quotes.map(({ quote }) => ({
          quoteId: quote.quoteId,
          clinicId: quote.clinicId,
          procedureId: quote.procedureId,
          amount: quote.amount,
          priceKrw: quote.priceKrw,
          vatIncluded: quote.vatIncluded,
          includes: quote.includes,
        })),
      },
      text: `Judge these ${quotes.length} quotes.`,
      contextId: requestId,
    });
    const verdicts = judgeTask.status.state === "TASK_STATE_COMPLETED" ? FairnessVerdictListV1Schema.safeParse(taskArtifactData(judgeTask)) : undefined;
    if (verdicts?.success) {
      const byQuote = new Map<string, FairnessVerdictV1>(verdicts.data.verdicts.map((v) => [v.quoteId, v]));
      for (const quote of quotes) {
        const verdict = byQuote.get(quote.quote.quoteId);
        if (verdict) {
          quote.verdict = verdict;
          await putOf(store, C.quotes, quote);
        }
      }
    }
  } catch {
    // The platform passes judgement, the agent never does (02). Without verdicts the quotes still show.
  }

  const request = await setStatus(store, requestId, "comparing");
  return { request, quotes, shortlist };
}

// ---------------------------------------------------------------------------
// Booking (clinic.book with returnImmediately, then GetTask polling)
// ---------------------------------------------------------------------------

export async function bookQuote(
  deps: OrchestratorDeps,
  customerId: string,
  args: { requestId: string; quoteId: string; slot: string },
): Promise<StoredBooking> {
  const { store } = deps;
  const request = await loadRequest(store, customerId, args.requestId);
  const profile = await loadProfile(store, customerId);
  const received = await getOf<StoredQuote>(store, C.quotes, `${args.requestId}:${args.quoteId}`);
  if (!received) throw new OrchestratorError("not_found", "quote not found");
  if (!["comparing", "booking"].includes(request.status)) throw new OrchestratorError("invalid_state", `request is ${request.status}`);
  if (!received.quote.slots.includes(args.slot)) throw new OrchestratorError("slot_unavailable", "slot is not offered in this quote");
  const active = (await listOf<StoredBooking>(store, C.bookings, { requestId: args.requestId })).find((b) =>
    ["requested", "pending_clinic", "confirmed"].includes(b.status),
  );
  if (active) throw new OrchestratorError("already_booked", active.id);
  const shortlist = await getOf<StoredShortlist>(store, C.shortlists, args.requestId);
  const candidate = shortlist?.candidates.find((c) => c.clinicId === received.quote.clinicId);
  if (!candidate) throw new OrchestratorError("not_found", "clinic is not in the shortlist");

  let bookingRequest;
  try {
    bookingRequest = bookingRequestFor({ profile, consents: await consentsOf(store, customerId), quote: received.quote, requestId: args.requestId, slot: args.slot });
  } catch (error) {
    if (error instanceof ConsentError) throw new OrchestratorError("consent_required", error.message);
    throw error;
  }

  let task: WireTask;
  try {
    task = await deps.send({
      from: selfRef(profile),
      toCardUrl: candidate.agentCardUrl,
      skillId: "clinic.book",
      data: bookingRequest,
      text: `Booking request for ${args.slot}.`,
      contextId: args.requestId,
      metadata: { referralToken: candidate.referralToken, consentRef: bookingRequest.consentRef },
      returnImmediately: true,
    });
  } catch (error) {
    throw new OrchestratorError("clinic_unavailable", error instanceof Error ? error.message : String(error));
  }

  const now = clock.nowIso();
  const booking: StoredBooking = {
    id: newId("cbk"),
    customerId,
    requestId: args.requestId,
    clinicId: received.quote.clinicId,
    clinicTaskId: task.id,
    status: "requested",
    quoteId: received.quote.quoteId,
    slot: args.slot,
    priceKrw: received.quote.priceKrw,
    procedureId: received.quote.procedureId,
    agentCardUrl: candidate.agentCardUrl,
    createdAt: now,
    updatedAt: now,
  };
  await putOf(store, C.bookings, booking);
  await setStatus(store, args.requestId, "booking");
  return applyBookingTask(deps, booking, task);
}

async function loadBooking(store: Store, customerId: string, bookingId: string): Promise<StoredBooking> {
  const booking = await getOf<StoredBooking>(store, C.bookings, bookingId);
  if (!booking || booking.customerId !== customerId) throw new OrchestratorError("not_found", "booking not found");
  return booking;
}

const OPEN_BOOKING = new Set<StoredBooking["status"]>(["requested", "pending_clinic"]);

/** Folds a clinic.book task into the stored booking. Answers INPUT_REQUIRED from consented values when it can. */
export async function applyBookingTask(deps: OrchestratorDeps, booking: StoredBooking, task: WireTask, depth = 0): Promise<StoredBooking> {
  const { store } = deps;
  const next: StoredBooking = { ...booking, clinicTaskId: task.id || booking.clinicTaskId, updatedAt: clock.nowIso() };
  const state = task.status.state;

  if (state === "TASK_STATE_SUBMITTED" || state === "TASK_STATE_WORKING") {
    next.status = "pending_clinic";
    delete next.inputRequest;
  } else if (state === "TASK_STATE_INPUT_REQUIRED") {
    const parsed = InputRequestV1Schema.safeParse(task.status.message ? firstDataPart(task.status.message) : undefined);
    if (parsed.success) {
      const profile = await loadProfile(store, booking.customerId);
      const answers = consentedAnswers(profile, await consentsOf(store, booking.customerId));
      const answerable = parsed.data.fields.every((field) => answers[field.key] !== undefined);
      if (answerable && depth === 0) {
        const values = Object.fromEntries(parsed.data.fields.map((field) => [field.key, answers[field.key] as string]));
        const answered = await sendInputResponse(deps, profile, next, values);
        if (answered) return applyBookingTask(deps, next, answered, depth + 1);
      }
      next.inputRequest = parsed.data;
    }
    next.status = "requested";
  } else if (state === "TASK_STATE_COMPLETED") {
    const parsed = BookingV1Schema.safeParse(taskArtifactData(task));
    if (parsed.success) {
      next.booking = parsed.data;
      next.status = parsed.data.status;
      next.priceKrw = parsed.data.priceKrw;
      delete next.inputRequest;
    } else {
      next.status = "pending_clinic";
    }
  } else if (isTerminalState(state)) {
    next.status = "canceled";
    next.failure = statusText(task) ?? state;
  }

  await putOf(store, C.bookings, next);
  if (next.status === "confirmed" && booking.status !== "confirmed") await onConfirmed(deps, next);
  if (next.status === "canceled" && booking.status !== "canceled") await setStatus(store, next.requestId, "comparing");
  return next;
}

async function sendInputResponse(deps: OrchestratorDeps, profile: CustomerProfile, booking: StoredBooking, values: Record<string, string>): Promise<WireTask | undefined> {
  try {
    return await deps.send({
      from: selfRef(profile),
      toCardUrl: booking.agentCardUrl,
      skillId: "clinic.book",
      data: { schema: "pibu/input-response@1", values },
      contextId: booking.requestId,
      taskId: booking.clinicTaskId,
      returnImmediately: true,
    });
  } catch {
    return undefined;
  }
}

/** Confirmed: the request is booked, the D0 record is due on the procedure day and the inbox says so. */
async function onConfirmed(deps: OrchestratorDeps, booking: StoredBooking): Promise<void> {
  const { store } = deps;
  await setStatus(store, booking.requestId, "booked");
  const draftId = `od_${booking.id}_D0`;
  if (!(await getOf<StoredOutcome>(store, C.outcomes, draftId))) {
    await putOf<StoredOutcome>(store, C.outcomes, { id: draftId, customerId: booking.customerId, bookingId: booking.id, checkpoint: "D0", dueAt: booking.slot });
  }
  const clinicBookingId = booking.booking?.bookingId;
  const items = await listOf<InboxItem>(store, C.inbox, { customerId: booking.customerId });
  const alreadyNotified = items.some((item) => item.kind === "booking_confirmed" && (item.bookingId === booking.id || (clinicBookingId && item.bookingId === clinicBookingId)));
  if (!alreadyNotified) {
    const now = clock.nowIso();
    await putOf<InboxItem>(store, C.inbox, {
      id: `inb_${booking.id}_confirmed`,
      customerId: booking.customerId,
      kind: "booking_confirmed",
      text: bookingConfirmedText(clinicEntry(booking.clinicId)?.name, booking.slot),
      bookingId: booking.id,
      dueAt: now,
      createdAt: now,
      status: "open",
    });
  }
}

/** One GetTask for an open booking (the booking screen calls this on every poll). Errors leave it unchanged. */
export async function refreshBooking(deps: OrchestratorDeps, customerId: string, bookingId: string): Promise<StoredBooking> {
  const booking = await loadBooking(deps.store, customerId, bookingId);
  if (!OPEN_BOOKING.has(booking.status) || booking.inputRequest) return booking;
  const profile = await loadProfile(deps.store, customerId);
  try {
    const task = await deps.get({ from: selfRef(profile), toCardUrl: booking.agentCardUrl, taskId: booking.clinicTaskId });
    return await applyBookingTask(deps, booking, task);
  } catch {
    return booking;
  }
}

/** Polls GetTask every pollIntervalMs (3s) for at most pollMaxMs (10 min) until the booking settles (03). */
export async function pollBooking(deps: OrchestratorDeps, customerId: string, bookingId: string): Promise<StoredBooking> {
  let booking = await loadBooking(deps.store, customerId, bookingId);
  // counted in intervals, not wall time: the demo clock is fixed and must not stretch or cut the loop
  for (let waited = 0; OPEN_BOOKING.has(booking.status) && !booking.inputRequest && waited < deps.pollMaxMs; waited += deps.pollIntervalMs) {
    await deps.sleep(deps.pollIntervalMs);
    booking = await refreshBooking(deps, customerId, bookingId);
  }
  return booking;
}

/** The customer answers fields a clinic asked for (INPUT_REQUIRED) that the agent could not fill. */
export async function answerBookingInput(deps: OrchestratorDeps, customerId: string, bookingId: string, values: Record<string, string>): Promise<StoredBooking> {
  const booking = await loadBooking(deps.store, customerId, bookingId);
  if (!booking.inputRequest) throw new OrchestratorError("invalid_state", "the clinic is not waiting for input");
  const profile = await loadProfile(deps.store, customerId);
  const task = await sendInputResponse(deps, profile, booking, values);
  if (!task) throw new OrchestratorError("clinic_unavailable");
  return applyBookingTask(deps, { ...booking, inputRequest: undefined }, task, 1);
}

// ---------------------------------------------------------------------------
// Outcomes (D0, then D7 / D30 check-ins in the inbox)
// ---------------------------------------------------------------------------

export interface OutcomeForm {
  paidKrw: number;
  receivedAmount: Amount;
  productVerified: string;
  satisfaction: number;
  painScore: number;
  wouldReturn: boolean;
  comment?: string;
  sideEffects?: string[];
  receiptAttached?: boolean;
}

export interface OutcomeResult {
  outcome: OutcomeV1;
  sent: boolean;
  record: TreatmentRecord;
}

async function sendOutcome(deps: OrchestratorDeps, profile: CustomerProfile, requestId: string, outcome: OutcomeV1): Promise<boolean> {
  try {
    const task = await deps.send({
      from: selfRef(profile),
      toCardUrl: platformCard(deps),
      skillId: "platform.submit_outcome",
      data: outcome,
      text: `${outcome.checkpoint} outcome for ${outcome.bookingId}.`,
      contextId: requestId,
    });
    return task.status.state === "TASK_STATE_COMPLETED";
  } catch {
    return false;
  }
}

/**
 * platform.anchor_record for a D0 visit of a customer with a record wallet (INTEGRATION 4 step 4): the platform
 * relays the append through GlowPass and answers "anchored <tx>". Undefined, with the reason logged, when ZK is not
 * configured, the platform refuses or fails, or nothing comes back in time; the caller keeps the demo anchor then.
 */
async function anchorD0(deps: OrchestratorDeps, profile: CustomerProfile, booking: StoredBooking): Promise<string | undefined> {
  const visit = booking.booking;
  if (!visit) return undefined;
  const data = await d0AnchorRequest(deps.store, profile, { bookingId: visit.bookingId, clinicId: booking.clinicId, procedureId: booking.procedureId });
  if (!data) return undefined;
  const keepDemo = (reason: string) => {
    console.warn(`[customer] ${visit.bookingId} keeps the demo anchor: ${reason}`);
    return undefined;
  };
  if (!deps.zk.enabled()) return keepDemo("ZK_SERVER_URL is not set");
  try {
    const task = await withTimeout(
      deps.send({
        from: selfRef(profile),
        toCardUrl: platformCard(deps),
        skillId: "platform.anchor_record",
        data,
        text: `Anchor the D0 record of ${visit.bookingId}.`,
        contextId: booking.requestId,
        timeoutMs: ANCHOR_TIMEOUT_MS,
      }),
      ANCHOR_TIMEOUT_MS,
    );
    const detail = statusText(task) ?? taskArtifactText(task);
    return anchoredTx(task) ?? keepDemo(detail ? `${task.status.state}: ${detail}` : task.status.state);
  } catch (error) {
    return keepDemo(isTimeout(error) ? "no answer in time" : error instanceof Error ? error.message : String(error));
  }
}

/** D0 record: pibu/outcome@1 to the platform (with consent), the booked procedure into the records, D7/D30 due. */
export async function submitOutcome(deps: OrchestratorDeps, customerId: string, bookingId: string, form: OutcomeForm): Promise<OutcomeResult> {
  const { store } = deps;
  const booking = await loadBooking(store, customerId, bookingId);
  if (!booking.booking || !["confirmed", "completed"].includes(booking.status)) throw new OrchestratorError("invalid_state", "the booking is not confirmed yet");
  const profile = await loadProfile(store, customerId);
  const consents = await consentsOf(store, customerId);
  const draftId = `od_${booking.id}_D0`;
  const draft = await getOf<StoredOutcome>(store, C.outcomes, draftId);

  const candidate: OutcomeV1 = {
    schema: "pibu/outcome@1",
    outcomeId: draft?.outcome?.outcomeId ?? newId("out"),
    bookingId: booking.booking.bookingId,
    clinicId: booking.clinicId,
    procedureId: booking.procedureId,
    checkpoint: "D0",
    paidKrw: Math.round(form.paidKrw),
    receivedAmount: form.receivedAmount,
    productVerified: form.productVerified,
    receiptAttached: form.receiptAttached ?? false,
    satisfaction: form.satisfaction,
    painScore: form.painScore,
    downtimeDaysActual: null,
    wouldReturn: form.wouldReturn,
    sideEffects: form.sideEffects ?? [],
    ...(form.comment?.trim() ? { comment: form.comment.trim() } : {}),
    visitorProfile: { nationality: profile.nationality, ageBand: profile.ageBand },
    submittedAt: clock.nowIso(),
  };
  const parsed = OutcomeV1Schema.safeParse(candidate);
  if (!parsed.success) throw new OrchestratorError("invalid_request", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const outcome = parsed.data;

  const shared = mayShareOutcome(consents);
  const sent = shared ? await sendOutcome(deps, profile, booking.requestId, outcome) : false;
  await putOf<StoredOutcome>(store, C.outcomes, {
    id: draftId,
    customerId,
    bookingId: booking.id,
    checkpoint: "D0",
    dueAt: draft?.dueAt ?? booking.slot,
    outcome,
    shared,
    ...(sent ? { sentAt: clock.nowIso() } : {}),
    ...(shared && !sent ? { sendError: "platform did not accept the outcome" } : {}),
  });

  const day = booking.slot.slice(0, 10);
  // The clinic-confirmed visit is appended to the chart on the chain (ZK record layer). Only a shared outcome the
  // platform accepted is anchored through it (its booking check needs the D0 outcome); the tx it relays replaces the
  // demo one. A resubmitted D0 keeps the tx its visit already has, since the platform anchors a booking once.
  const recordId = `rec_${booking.id}`;
  const previous = (await getOf<TreatmentRecord>(store, C.records, recordId))?.anchor;
  let anchor = await d0AnchorFor(store, customerId);
  if (isRelayedAnchor(previous)) anchor = previous;
  else if (anchor && sent) {
    const tx = await anchorD0(deps, profile, booking);
    if (tx) anchor = { ...anchor, tx };
  }
  const record = await addRecord(
    store,
    customerId,
    {
      procedureId: booking.procedureId,
      date: day,
      amount: form.receivedAmount,
      priceKrw: outcome.paidKrw,
      clinicId: booking.clinicId,
      ...(clinicEntry(booking.clinicId)?.name.en ? { clinicName: clinicEntry(booking.clinicId)?.name.en } : {}),
      rating: Math.min(5, Math.max(1, Math.round(form.satisfaction))) as TreatmentRecord["rating"],
      ...(outcome.comment ? { note: outcome.comment } : {}),
    },
    { id: recordId, source: "booking", sharedToPlatform: sent, ...(anchor ? { anchor } : {}) },
  );
  await renumber(store, customerId, masterProcedureId(booking.procedureId));

  await putOf(store, C.bookings, { ...booking, status: "completed", booking: { ...booking.booking, status: "completed" }, updatedAt: clock.nowIso() });
  await setStatus(store, booking.requestId, "closed");

  // D7 and D30 check-ins become due items in the inbox (in-app only)
  const now = clock.nowIso();
  for (const checkpoint of ["D7", "D30"] as const) {
    const dueAt = checkinDueAt(day, checkpoint);
    await putOf<StoredOutcome>(store, C.outcomes, { id: `od_${booking.id}_${checkpoint}`, customerId, bookingId: booking.id, checkpoint, dueAt });
    await putOf<InboxItem>(store, C.inbox, {
      id: `inb_${booking.id}_${checkpoint}`,
      customerId,
      kind: "checkin_due",
      text: checkinDueText(checkpoint),
      bookingId: booking.id,
      checkpoint,
      procedureDay: day,
      dueAt,
      createdAt: now,
      status: "open",
    });
  }

  return { outcome, sent, record: (await getOf<TreatmentRecord>(store, C.records, record.id)) ?? record };
}

export interface CheckinAnswers {
  satisfaction: number;
  downtimeDaysActual: number | null;
  wouldReturn: boolean;
  sideEffects?: string[];
  comment?: string;
}

/**
 * Answers a D7/D30 item: a scheduled check-in is sent with platform.submit_outcome, a platform customer.checkin
 * task is completed with the pibu/outcome@1 it asked for. Without the sharing consent nothing is sent and a
 * platform task is rejected.
 */
export async function answerCheckin(deps: OrchestratorDeps, customerId: string, itemId: string, answers: CheckinAnswers): Promise<{ outcome?: OutcomeV1; sent: boolean }> {
  const { store } = deps;
  const item = await getOf<InboxItem>(store, C.inbox, itemId);
  if (!item || item.customerId !== customerId || (item.kind !== "checkin_due" && item.kind !== "checkin_request")) {
    throw new OrchestratorError("not_found", "check-in not found");
  }
  const profile = await loadProfile(store, customerId);
  const consents = await consentsOf(store, customerId);
  const checkpoint = item.checkpoint ?? "D7";

  // the D0 outcome is the base; the booking id may be ours (scheduled) or the clinic's (platform task)
  const outcomes = await listOf<StoredOutcome>(store, C.outcomes, { customerId });
  const bookings = await listOf<StoredBooking>(store, C.bookings, { customerId });
  const booking = bookings.find((b) => b.id === item.bookingId || b.booking?.bookingId === item.bookingId);
  const base = outcomes.find((o) => o.checkpoint === "D0" && o.bookingId === booking?.id)?.outcome;

  const done = async () => putOf<InboxItem>(store, C.inbox, { ...item, status: "done", readAt: clock.nowIso() });
  const self = selfRef(profile);

  if (!base || !mayShareOutcome(consents)) {
    if (item.kind === "checkin_request" && item.taskId) {
      await deps.completer.complete(self, item.taskId, { state: "TASK_STATE_REJECTED", text: base ? "The customer does not share outcomes." : "No procedure record for this booking." });
    }
    await done();
    return { sent: false };
  }

  const { comment: _baseComment, ...baseRest } = base;
  const outcome = OutcomeV1Schema.parse({
    ...baseRest,
    outcomeId: newId("out"),
    checkpoint,
    satisfaction: Math.round(answers.satisfaction),
    downtimeDaysActual: answers.downtimeDaysActual,
    wouldReturn: answers.wouldReturn,
    sideEffects: answers.sideEffects ?? [],
    ...(answers.comment?.trim() ? { comment: answers.comment.trim() } : {}),
    submittedAt: clock.nowIso(),
  });

  let sent = false;
  if (item.kind === "checkin_request" && item.taskId) {
    await deps.completer.complete(self, item.taskId, { state: "TASK_STATE_COMPLETED", data: outcome as unknown as Record<string, unknown> });
    sent = true;
  } else {
    sent = await sendOutcome(deps, profile, booking?.requestId ?? item.bookingId ?? "req_unknown", outcome);
  }
  if (booking) {
    const draftId = `od_${booking.id}_${checkpoint}`;
    const draft = await getOf<StoredOutcome>(store, C.outcomes, draftId);
    await putOf<StoredOutcome>(store, C.outcomes, {
      id: draftId,
      customerId,
      bookingId: booking.id,
      checkpoint,
      dueAt: draft?.dueAt ?? item.dueAt,
      outcome,
      shared: true,
      ...(sent ? { sentAt: clock.nowIso() } : {}),
    });
  }
  await done();
  return { outcome, sent };
}

export type { InputRequestV1 };
