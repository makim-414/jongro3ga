// Clinic agent skill handlers (02-agents.md 3절, 03-a2a-protocol.md). Answers come only from this clinic's
// own data in namespace "clinic"; the A2A core has already validated `data` with parsePibuData.
import { verifyReferralToken, type ReferralClaims } from "../../a2a/auth";
import type { SkillContext, SkillHandler, SkillResult } from "../../a2a/contract";
import type {
  AvailabilityQueryV1,
  BookingRequestV1,
  CancelRequestV1,
  InputResponseV1,
  OffersQueryV1,
  OffersV1,
  ProcedureRequestV1,
  QuoteV1,
} from "../../a2a/schemas";
import { clock } from "../../clock";
import type { ClinicProfile } from "../../domain/clinic";
import { zkEnabled } from "../../zk";
import { ACCEPT_PROPOSED_SLOT, announceConfirmation, holdSlot, releaseSlot } from "./booking";
import { checkOfferProof, type ProofCheck } from "./offer-proof";
import { freeSlots, quoteValidUntil, selectQuoteItem } from "./quote";
import { ensureClinicData } from "./seed";
import {
  bookingWire,
  clinicStore,
  newId,
  operationOf,
  resolveClinic,
  type ClinicStore,
  type StoredBooking,
  type StoredTask,
} from "./store";

const rejected = (text: string): SkillResult => ({ state: "TASK_STATE_REJECTED", text });
const failed = (text: string): SkillResult => ({ state: "TASK_STATE_FAILED", text });

async function clinicFor(ctx: SkillContext, db: ClinicStore): Promise<ClinicProfile | undefined> {
  await ensureClinicData(db.store);
  return resolveClinic(ctx.self.agentId, db);
}

async function recordTask(db: ClinicStore, ctx: SkillContext, clinicId: string, skillId: string, startedAt: number, fields: Partial<StoredTask>): Promise<void> {
  const existing = await db.task(ctx.taskId);
  await db.putTask({
    id: ctx.taskId,
    clinicId,
    a2aTaskId: ctx.taskId,
    contextId: ctx.contextId,
    skillId,
    summary: "",
    ...existing,
    ...fields,
    state: fields.state ?? existing?.state ?? "TASK_STATE_COMPLETED",
    at: existing?.at ?? clock.nowIso(),
    latencyMs: existing?.latencyMs ?? Math.max(0, clock.now().getTime() - startedAt),
  } as StoredTask);
}

type ReferralCheck = { ok: true; claims: ReferralClaims; token: string } | { ok: false; result: SkillResult };

/** 03 확장 referral/v1: quote and book need a valid platform token for this clinic and this request. */
async function checkReferral(
  ctx: SkillContext,
  clinicId: string,
  scope: "quote" | "book",
  expect: { requestId: string; customerAgentId?: string },
): Promise<ReferralCheck> {
  const token = ctx.metadata.referralToken;
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, result: rejected("referral_token_missing: a PibooK referral token is required in metadata.referralToken") };
  }
  let claims: ReferralClaims | null;
  try {
    claims = await verifyReferralToken(token, clinicId);
  } catch (error) {
    return { ok: false, result: failed(`referral token could not be verified: ${String((error as Error).message ?? error)}`) };
  }
  if (!claims) return { ok: false, result: rejected("referral_token_invalid: signature, expiry or clinic does not match") };
  if (!claims.scope.includes(scope)) return { ok: false, result: rejected(`referral_token_scope: token does not allow ${scope}`) };
  if (claims.requestId !== expect.requestId) return { ok: false, result: rejected("referral_token_request: token was issued for another request") };
  if (expect.customerAgentId && claims.customerAgentId !== expect.customerAgentId) {
    return { ok: false, result: rejected("referral_token_subject: token was issued to another customer agent") };
  }
  return { ok: true, claims, token };
}

/** Inbox summary suffix for the offer proof result; empty when the customer attached none. */
function proofNote(proof: ProofCheck): string {
  if (proof.verified) return " · 오퍼 증명 확인";
  return proof.reason === "no_proof" ? "" : ` · 오퍼 증명 미적용 (${proof.reason})`;
}

// ---- clinic.offers ----

const offers: SkillHandler = async (data, ctx) => {
  const db = clinicStore();
  const clinic = await clinicFor(ctx, db);
  if (!clinic) return rejected("unknown_clinic");
  const query = data as OffersQueryV1;
  const month = query.month ?? clock.today().slice(0, 7);
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-31`;

  const menu = await db.menu(clinic.id);
  const running = (await db.offers(clinic.id)).filter(
    (offer) => offer.active !== false && offer.validFrom <= monthEnd && offer.validUntil >= monthStart,
  );

  const items: OffersV1["items"] = [
    ...menu.map((item) => ({
      procedureId: item.procedureId,
      product: item.product,
      amount: item.amount,
      priceKrw: item.priceKrw,
      vatIncluded: item.vatIncluded,
    })),
    ...running.map((offer) => {
      const facts = menu.find((item) => item.procedureId === offer.procedureId);
      return {
        procedureId: offer.procedureId,
        product: facts?.product ?? offer.title,
        amount: offer.amount,
        priceKrw: offer.priceKrw,
        vatIncluded: facts?.vatIncluded ?? true,
        event: {
          title: offer.title,
          regularPriceKrw: offer.regularPriceKrw,
          validFrom: offer.validFrom,
          validUntil: offer.validUntil,
          conditions: offer.conditions,
          ...(offer.zkClauses?.length ? { zkClauses: offer.zkClauses } : {}),
        },
      };
    }),
  ];
  const result: OffersV1 = { schema: "pibu/offers@1", clinicId: clinic.id, month, items };
  return { state: "TASK_STATE_COMPLETED", data: result };
};

// ---- clinic.quote ----

const quote: SkillHandler = async (data, ctx) => {
  const startedAt = clock.now().getTime();
  const db = clinicStore();
  const clinic = await clinicFor(ctx, db);
  if (!clinic) return rejected("unknown_clinic");
  const request = data as ProcedureRequestV1;
  const base: Partial<StoredTask> = {
    customerAgentId: request.customerAgentId,
    language: request.languages[0],
    procedureId: request.procedureId,
    amount: request.amount,
  };

  const referral = await checkReferral(ctx, clinic.id, "quote", {
    requestId: request.requestId,
    customerAgentId: request.customerAgentId,
  });
  if (!referral.ok) {
    await recordTask(db, ctx, clinic.id, "clinic.quote", startedAt, { ...base, state: referral.result.state, reason: referral.result.text, summary: "견적 거절 (추천 토큰)" });
    return referral.result;
  }

  // Offer proof (docs/INTEGRATION.md 4절), in code, right after the referral token and before the item choice.
  // A proof that fails for any reason only keeps proof-only events off: the quote is the regular price, the
  // customer sees no error, and the reason goes to the server log and the inbox summary.
  const today = clock.today();
  const [menu, offers] = await Promise.all([db.menu(clinic.id), db.offers(clinic.id)]);
  const proof = await checkOfferProof({ clinicId: clinic.id, procedureId: request.procedureId, offers, today, metadata: ctx.metadata });
  if (!proof.verified && proof.reason !== "no_proof") {
    console.warn(`[clinic] ${clinic.id} offer proof not applied: ${proof.reason}`, { offerId: proof.offerId, detail: proof.detail });
  }

  const selection = selectQuoteItem({
    procedureId: request.procedureId,
    amount: request.amount,
    today,
    menu,
    offers,
    verifiedOfferId: proof.verified ? proof.offerId : undefined,
    proofsRequired: zkEnabled(),
  });
  if (!selection) {
    const result = rejected(`procedure_not_offered: ${request.procedureId} is not on this clinic's menu`);
    await recordTask(db, ctx, clinic.id, "clinic.quote", startedAt, { ...base, state: result.state, reason: result.text, summary: "견적 거절 (메뉴 없음)" });
    return result;
  }

  const operation = await operationOf(clinic, db);
  const slots = freeSlots(await db.slots(clinic.id), request.procedureId, request.dateWindow.from, request.dateWindow.to);
  const quoteV1: QuoteV1 = {
    schema: "pibu/quote@1",
    quoteId: newId("qt"),
    requestId: request.requestId,
    clinicId: clinic.id,
    procedureId: request.procedureId,
    product: selection.product,
    amount: selection.amount,
    priceKrw: selection.priceKrw,
    vatIncluded: selection.vatIncluded,
    includes: selection.includes,
    excludes: selection.excludes,
    ...(selection.event ? { event: selection.event } : {}),
    ...(selection.offerApplied ? { offerApplied: selection.offerApplied } : {}),
    slots,
    languages: clinic.languages.map((language) => language.locale),
    indicative: operation.mode === "proxy",
    validUntil: quoteValidUntil(today, selection.event),
    operationMode: operation.mode,
  };

  await db.putQuote({ id: quoteV1.quoteId, clinicId: clinic.id, quote: quoteV1, offerId: selection.offerId, createdAt: clock.nowIso() });
  await recordTask(db, ctx, clinic.id, "clinic.quote", startedAt, {
    ...base,
    state: "TASK_STATE_COMPLETED",
    product: quoteV1.product,
    amount: quoteV1.amount,
    priceKrw: quoteV1.priceKrw,
    quoteId: quoteV1.quoteId,
    summary: `${selection.source === "event" ? "이벤트" : "메뉴"} 견적${proofNote(proof)}`,
  });
  return { state: "TASK_STATE_COMPLETED", data: quoteV1 };
};

// ---- clinic.availability ----

const availability: SkillHandler = async (data, ctx) => {
  const db = clinicStore();
  const clinic = await clinicFor(ctx, db);
  if (!clinic) return rejected("unknown_clinic");
  const query = data as AvailabilityQueryV1;
  const operation = await operationOf(clinic, db);
  return {
    state: "TASK_STATE_COMPLETED",
    data: {
      schema: "pibu/availability@1",
      clinicId: clinic.id,
      slots: freeSlots(await db.slots(clinic.id), query.procedureId, query.from, query.to),
      indicative: operation.mode === "proxy",
    },
  };
};

// ---- clinic.book ----

const SAFETY_FIELDS = [
  {
    key: "pregnantOrBreastfeeding",
    label: { en: "Are you pregnant or breastfeeding? (yes or no)", ja: "妊娠中または授乳中ですか (yes または no)", ko: "임신 중이거나 수유 중인가요? (yes 또는 no)", "zh-CN": "是否怀孕或哺乳期 (yes 或 no)" },
    sensitive: true,
  },
  {
    key: "allergies",
    label: { en: "Allergies (comma separated, or none)", ja: "アレルギー (カンマ区切り、なければ none)", ko: "알레르기 (쉼표로 구분, 없으면 none)", "zh-CN": "过敏 (逗号分隔，没有请填 none)" },
    sensitive: true,
  },
];

const YES = new Set(["yes", "y", "true", "1", "accept", "はい", "예", "네", "是"]);

function wantsYes(value: string | undefined): boolean {
  return value !== undefined && YES.has(value.trim().toLowerCase());
}

function safetyFromInput(values: Record<string, string>): BookingRequestV1["safetyInfo"] | undefined {
  if (values.pregnantOrBreastfeeding === undefined && values.allergies === undefined) return undefined;
  const allergies = (values.allergies ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "" && value.toLowerCase() !== "none");
  return { pregnantOrBreastfeeding: wantsYes(values.pregnantOrBreastfeeding), allergies };
}

/** Pending booking result: WORKING until staff or an operator confirms, unless the clinic auto-confirms. */
async function settle(db: ClinicStore, clinic: ClinicProfile, booking: StoredBooking): Promise<SkillResult> {
  const operation = await operationOf(clinic, db);
  const policy = await db.slotPolicy(clinic.id);
  await holdSlot(db, clinic.id, booking.request.slot);

  if (operation.mode === "clinic" && policy?.autoConfirm) {
    const confirmed: StoredBooking = { ...booking, status: "confirmed", confirmedBy: "auto", confirmedAt: clock.nowIso(), awaitingGuest: undefined };
    await db.putBooking(confirmed);
    await announceConfirmation(confirmed, db);
    return { state: "TASK_STATE_COMPLETED", data: bookingWire(confirmed), text: "Booking confirmed automatically" };
  }

  const pending: StoredBooking = { ...booking, status: "pending_clinic", awaitingGuest: undefined };
  await db.putBooking(pending);
  return {
    state: "TASK_STATE_WORKING",
    data: bookingWire(pending),
    text: operation.mode === "proxy" ? "PibooK is checking with the clinic" : "The clinic is checking the request",
  };
}

async function continueBooking(db: ClinicStore, clinic: ClinicProfile, ctx: SkillContext, response: InputResponseV1, startedAt: number): Promise<SkillResult> {
  const [booking] = await db.bookings({ clinicId: clinic.id, a2aTaskId: ctx.taskId });
  if (!booking || booking.status !== "pending_clinic") return rejected("unknown_booking: no pending booking for this task");
  const values = response.values;
  const guestInput = { ...booking.guestInput, ...values };
  let next: StoredBooking = { ...booking, guestInput };

  if (booking.awaitingGuest?.kind === "propose" && booking.awaitingGuest.proposedSlot) {
    if (!wantsYes(values[ACCEPT_PROPOSED_SLOT])) {
      await releaseSlot(db, clinic.id, booking.request.slot);
      const canceled: StoredBooking = { ...next, status: "canceled", rejectReason: "Guest declined the proposed time", awaitingGuest: undefined };
      await db.putBooking(canceled);
      await recordTask(db, ctx, clinic.id, "clinic.book", startedAt, { state: "TASK_STATE_REJECTED", reason: canceled.rejectReason, bookingId: booking.id });
      return rejected("guest_declined_proposed_time");
    }
    await releaseSlot(db, clinic.id, booking.request.slot);
    next = { ...next, request: { ...next.request, slot: booking.awaitingGuest.proposedSlot } };
  } else {
    const safety = safetyFromInput(values);
    if (safety && !next.request.safetyInfo) next = { ...next, request: { ...next.request, safetyInfo: safety } };
  }

  const result = await settle(db, clinic, next);
  await recordTask(db, ctx, clinic.id, "clinic.book", startedAt, { state: result.state, bookingId: booking.id, summary: "고객이 추가 정보에 답함" });
  return result;
}

const book: SkillHandler = async (data, ctx) => {
  const startedAt = clock.now().getTime();
  const db = clinicStore();
  const clinic = await clinicFor(ctx, db);
  if (!clinic) return rejected("unknown_clinic");

  if (data.schema === "pibu/input-response@1") {
    return continueBooking(db, clinic, ctx, data as InputResponseV1, startedAt);
  }

  const request = data as BookingRequestV1;
  const base: Partial<StoredTask> = { language: request.guest.language };
  const reject = async (result: SkillResult, summary: string) => {
    await recordTask(db, ctx, clinic.id, "clinic.book", startedAt, { ...base, state: result.state, reason: result.text, summary });
    return result;
  };

  if (request.clinicId !== clinic.id) return reject(rejected("clinic_mismatch: booking request is for another clinic"), "예약 거절 (병원 불일치)");
  const referral = await checkReferral(ctx, clinic.id, "book", { requestId: request.requestId });
  if (!referral.ok) return reject(referral.result, "예약 거절 (추천 토큰)");

  const stored = await db.quote(request.quoteId);
  if (!stored || stored.clinicId !== clinic.id || stored.quote.requestId !== request.requestId) {
    return reject(rejected("unknown_quote: this clinic did not issue that quote for this request"), "예약 거절 (견적 없음)");
  }
  const slot = (await db.slots(clinic.id)).find((candidate) => Date.parse(candidate.start) === Date.parse(request.slot));
  if (slot?.held) return reject(rejected("slot_unavailable: the requested time is already taken"), "예약 거절 (시간 마감)");

  const now = clock.nowIso();
  const booking: StoredBooking = {
    id: newId("bkg"),
    clinicId: clinic.id,
    a2aTaskId: ctx.taskId,
    request,
    status: "pending_clinic",
    referralJti: referral.claims.jti,
    customerAgentId: referral.claims.customerAgentId,
    referralToken: referral.token,
    quoteId: request.quoteId,
    procedureId: stored.quote.procedureId,
    product: stored.quote.product,
    amount: stored.quote.amount,
    priceKrw: stored.quote.priceKrw,
    contextId: ctx.contextId,
    createdAt: now,
    updatedAt: now,
  };
  const taskFields: Partial<StoredTask> = {
    ...base,
    customerAgentId: booking.customerAgentId,
    procedureId: booking.procedureId,
    product: booking.product,
    amount: booking.amount,
    priceKrw: booking.priceKrw,
    quoteId: booking.quoteId,
    bookingId: booking.id,
  };

  // Safety answers are needed before a clinic can confirm (02 정보 경계: shared at booking with consent).
  if (!request.safetyInfo) {
    const awaiting = { kind: "ask" as const, fields: SAFETY_FIELDS, at: now };
    await db.putBooking({ ...booking, awaitingGuest: awaiting });
    await recordTask(db, ctx, clinic.id, "clinic.book", startedAt, { ...taskFields, state: "TASK_STATE_INPUT_REQUIRED", summary: "안전 정보 요청" });
    return {
      state: "TASK_STATE_INPUT_REQUIRED",
      text: "The clinic needs safety information before confirming",
      inputRequest: { schema: "pibu/input-request@1", fields: SAFETY_FIELDS },
    };
  }

  const result = await settle(db, clinic, booking);
  await recordTask(db, ctx, clinic.id, "clinic.book", startedAt, {
    ...taskFields,
    state: result.state,
    summary: result.state === "TASK_STATE_COMPLETED" ? "자동 확정" : "예약 확인 대기",
  });
  return result;
};

// ---- clinic.cancel ----

const cancel: SkillHandler = async (data, ctx) => {
  const db = clinicStore();
  const clinic = await clinicFor(ctx, db);
  if (!clinic) return rejected("unknown_clinic");
  const request = data as CancelRequestV1;
  const booking = await db.booking(request.bookingId);
  if (!booking || booking.clinicId !== clinic.id) return rejected("unknown_booking");
  if (ctx.caller.role === "customer" && ctx.caller.agentId !== booking.customerAgentId) {
    return rejected("not_your_booking: only the customer agent that booked can cancel");
  }
  if (booking.status === "canceled") return { state: "TASK_STATE_COMPLETED", data: bookingWire(booking) };
  if (booking.status === "completed" || booking.status === "no_show") return rejected(`booking_${booking.status}: cannot cancel`);

  const canceled: StoredBooking = { ...booking, status: "canceled", rejectReason: `Canceled by customer: ${request.reason}`, awaitingGuest: undefined };
  await releaseSlot(db, clinic.id, booking.request.slot);
  await db.putBooking(canceled);
  const task = await db.task(booking.a2aTaskId);
  if (task) await db.putTask({ ...task, state: "TASK_STATE_CANCELED", reason: canceled.rejectReason });
  return { state: "TASK_STATE_COMPLETED", data: bookingWire(canceled) };
};

export const clinicSkills = {
  "clinic.offers": offers,
  "clinic.quote": quote,
  "clinic.availability": availability,
  "clinic.book": book,
  "clinic.cancel": cancel,
} satisfies Record<string, SkillHandler>;

