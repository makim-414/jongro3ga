import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillContext, SkillResult } from "../../a2a/contract";
import { BookingV1Schema, OffersV1Schema, QuoteV1Schema } from "../../a2a/schemas";
import { getStore, resetStore } from "../../store";
import { resetClock, setClock } from "../../clock";

// Cross-track contracts are stubs on this branch: mock them (BUILD-TRACKS.md).
vi.mock("../../a2a/auth", () => ({ verifyReferralToken: vi.fn(), issueAgentToken: vi.fn() }));
vi.mock("../../a2a/tasks", () => ({ taskCompleter: { complete: vi.fn() } }));
vi.mock("../../a2a/client", async (importActual) => {
  const actual = await importActual<typeof import("../../a2a/client")>();
  return { ...actual, sendMessage: vi.fn(), getTask: vi.fn() };
});
// The real verifier needs the owner's wallet and the GlowPass server: mock the HTTP wrapper only.
vi.mock("../../zk/client", () => ({ verifyOffer: vi.fn() }));

import { verifyReferralToken, type ReferralClaims } from "../../a2a/auth";
import { taskCompleter } from "../../a2a/tasks";
import { sendMessage } from "../../a2a/client";
import { verifyOffer } from "../../zk/client";
import { clinicAgent } from "./definition";
import { confirmBooking, proposeBookingTime, rejectBooking } from "./booking";
import { closest, selectQuoteItem } from "./quote";
import { writeClinicSeed } from "./seed";
import { CLINIC_COLLECTIONS, clinicStore } from "./store";

const ENV = { ...process.env };
const CUSTOMER = "cag_7f3k2";
const REQUEST_ID = "req_01J9Z8";

/** Fake referral tokens: "ref|<clinicId>|<customer>|<requestId>|<scopes>", anything else is invalid. */
function token(clinicId: string, overrides: { customer?: string; requestId?: string; scope?: string } = {}): string {
  return ["ref", clinicId, overrides.customer ?? CUSTOMER, overrides.requestId ?? REQUEST_ID, overrides.scope ?? "quote,book"].join("|");
}

let taskSeq = 0;
function ctx(self: string, metadata: Record<string, unknown> = {}, taskId = `tsk_${++taskSeq}`): SkillContext {
  return {
    caller: { role: "customer", agentId: CUSTOMER },
    self: { role: "clinic", agentId: self },
    taskId,
    contextId: REQUEST_ID,
    metadata,
  };
}

function procedureRequest(amountValue: number, procedureId = "rejuran_healer") {
  return {
    schema: "pibu/procedure-request@1",
    requestId: REQUEST_ID,
    customerAgentId: CUSTOMER,
    procedureId,
    amount: { value: amountValue, unit: "cc" },
    languages: ["ja"],
    dateWindow: { from: "2026-11-13", to: "2026-11-15" },
    visitorProfile: { nationality: "JP", firstKProcedure: true },
  };
}

const skill = (id: keyof typeof clinicAgent.skills) => clinicAgent.skills[id]!;

async function quoteAt(clinic: string, amountValue = 2, metadata: Record<string, unknown> = {}) {
  const clinicId = clinic.startsWith("cln_") ? clinic : `cln_${clinic.replace(/-/g, "_")}`;
  const result = await skill("clinic.quote")(procedureRequest(amountValue), ctx(clinic, { referralToken: token(clinicId), ...metadata }));
  return result;
}

function bookingRequest(clinicId: string, quoteId: string, overrides: Record<string, unknown> = {}) {
  return {
    schema: "pibu/booking-request@1",
    requestId: REQUEST_ID,
    quoteId,
    clinicId,
    slot: "2026-11-14T11:00:00+09:00",
    guest: { displayName: "Yuki T.", contactChannel: "line", contactHandle: "yuki_demo", language: "ja" },
    safetyInfo: { pregnantOrBreastfeeding: false, allergies: [] },
    consentRef: "cns_0091",
    ...overrides,
  };
}

beforeEach(async () => {
  process.env.DEMO_MODE = "true";
  delete process.env.ZK_SERVER_URL;
  process.env.PUBLIC_BASE_URL = "https://pibu.example";
  setClock("2026-11-12T10:00:00+09:00");
  resetStore();
  await writeClinicSeed(getStore());
  vi.mocked(verifyReferralToken).mockReset().mockImplementation(async (raw, clinicId): Promise<ReferralClaims | null> => {
    const [kind, aud, customer, requestId, scopes] = raw.split("|");
    if (kind !== "ref" || aud !== clinicId) return null;
    return {
      jti: `jti_${aud}`,
      clinicId: aud,
      customerAgentId: customer,
      requestId,
      matchId: "mt_4401",
      scope: scopes.split(",") as ReferralClaims["scope"],
      exp: 0,
    };
  });
  vi.mocked(taskCompleter.complete).mockReset().mockResolvedValue(undefined);
  vi.mocked(sendMessage).mockReset().mockImplementation(async (options) => ({
    id: "tsk_remote",
    contextId: options.contextId,
    status: { state: "TASK_STATE_COMPLETED" },
  }));
  vi.mocked(verifyOffer).mockReset();
});

afterEach(() => {
  process.env = { ...ENV };
  resetClock();
});

describe("clinic.quote item selection (07)", () => {
  it("answers Mint's 2cc request with the 1cc event, its regular price, period and conditions", async () => {
    const result = await quoteAt("mint");
    expect(result.state).toBe("TASK_STATE_COMPLETED");
    const quote = QuoteV1Schema.parse(result.data);
    expect(quote.clinicId).toBe("cln_mint");
    expect(quote.amount).toEqual({ value: 1, unit: "cc" });
    expect(quote.priceKrw).toBe(99000);
    expect(quote.vatIncluded).toBe(true);
    expect(quote.event).toEqual({
      title: "First visit 1cc event",
      regularPriceKrw: 150000,
      validFrom: "2026-11-01",
      validUntil: "2026-11-30",
      conditions: "First visit only",
    });
    expect(quote.indicative).toBe(true);
    expect(quote.operationMode).toBe("proxy");
  });

  it("quotes Seoul Glow 2cc at 340,000 with VAT, as a firm (not indicative) price", async () => {
    const quote = QuoteV1Schema.parse((await quoteAt("seoul-glow")).data);
    expect(quote.clinicId).toBe("cln_seoul_glow");
    expect(quote.amount).toEqual({ value: 2, unit: "cc" });
    expect(quote.priceKrw).toBe(340000);
    expect(quote.event).toBeUndefined();
    expect(quote.indicative).toBe(false);
    expect(quote.operationMode).toBe("clinic");
    expect(quote.includes).toEqual(["numbing_cream", "soothing_mask"]);
    expect(quote.excludes).toEqual(["recovery_cream"]);
    // 06 slots: 4 a day, 11-13 to 11-15 inclusive.
    expect(quote.slots).toHaveLength(12);
    expect(quote.slots[0]).toBe("2026-11-13T10:00:00+09:00");
    expect(quote.languages).toEqual(["ja", "en"]);
  });

  it("marks every proxy clinic quote indicative and every direct clinic quote firm", async () => {
    for (const [clinic, indicative] of [["ara", true], ["hanbit", true], ["dahye", false], ["cln_seoul_glow", false]] as const) {
      const quote = QuoteV1Schema.parse((await quoteAt(clinic)).data);
      expect(quote.indicative, clinic).toBe(indicative);
    }
    const ara = QuoteV1Schema.parse((await quoteAt("ara")).data);
    expect([ara.priceKrw, ara.vatIncluded]).toEqual([300000, false]);
  });

  it("falls back to the menu once the event has ended", async () => {
    setClock("2026-12-01T10:00:00+09:00");
    const quote = QuoteV1Schema.parse((await quoteAt("mint")).data);
    expect([quote.amount.value, quote.priceKrw, quote.event]).toEqual([1, 150000, undefined]);
  });

  it("ignores an event the clinic switched off", async () => {
    const db = clinicStore();
    const offer = (await db.offer("of_mint_rejuran_first"))!;
    await db.putOffer({ ...offer, active: false });
    const quote = QuoteV1Schema.parse((await quoteAt("mint")).data);
    expect([quote.priceKrw, quote.event]).toEqual([150000, undefined]);
  });

  it("picks the closest menu amount and the larger one on a tie", () => {
    const items = [1, 3].map((value) => ({ amount: { value, unit: "cc" as const } }));
    expect(closest(items, { value: 2, unit: "cc" })?.amount.value).toBe(3);
    expect(closest(items, { value: 1.2, unit: "cc" })?.amount.value).toBe(1);
    expect(selectQuoteItem({ procedureId: "x", amount: { value: 1, unit: "cc" }, today: "2026-11-12", menu: [], offers: [] })).toBeNull();
  });

  it("rejects a procedure the clinic does not offer", async () => {
    const result = await skill("clinic.quote")(procedureRequest(2, "thermage_flx"), ctx("mint", { referralToken: token("cln_mint") }));
    expect(result.state).toBe("TASK_STATE_REJECTED");
    expect(result.text).toMatch(/procedure_not_offered/);
  });

  it("records the quote task for the clinic inbox", async () => {
    await quoteAt("seoul-glow");
    const tasks = await clinicStore().tasks("cln_seoul_glow");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ skillId: "clinic.quote", state: "TASK_STATE_COMPLETED", priceKrw: 340000, customerAgentId: CUSTOMER });
  });
});

describe("referral token (03 referral/v1)", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["missing", {}],
    ["empty", { referralToken: "" }],
    ["invalid or expired", { referralToken: "expired-token" }],
    ["issued for another clinic", { referralToken: token("cln_ara") }],
    ["without quote scope", { referralToken: token("cln_mint", { scope: "book" }) }],
    ["for another request", { referralToken: token("cln_mint", { requestId: "req_other" }) }],
    ["for another customer agent", { referralToken: token("cln_mint", { customer: "cag_other" }) }],
  ];
  it.each(cases)("rejects a quote when the token is %s", async (_label, metadata) => {
    const result = await skill("clinic.quote")(procedureRequest(2), ctx("mint", metadata));
    expect(result.state).toBe("TASK_STATE_REJECTED");
    expect(result.data).toBeUndefined();
  });

  it("checks the token against this clinic id even when routed by slug", async () => {
    await quoteAt("mint");
    expect(verifyReferralToken).toHaveBeenCalledWith(token("cln_mint"), "cln_mint");
  });

  it("rejects a booking without a valid token", async () => {
    const quote = QuoteV1Schema.parse((await quoteAt("seoul-glow")).data);
    const result = await skill("clinic.book")(bookingRequest("cln_seoul_glow", quote.quoteId), ctx("seoul-glow", { referralToken: "nope" }));
    expect(result.state).toBe("TASK_STATE_REJECTED");
    expect(await clinicStore().bookings({ clinicId: "cln_seoul_glow" })).toHaveLength(0);
  });
});

describe("clinic.book and confirmBooking", () => {
  async function bookSeoulGlow(overrides: Record<string, unknown> = {}, taskId = "tsk_book_1") {
    const quote = QuoteV1Schema.parse((await quoteAt("seoul-glow")).data);
    const result = await skill("clinic.book")(
      bookingRequest("cln_seoul_glow", quote.quoteId, overrides),
      ctx("seoul-glow", { referralToken: token("cln_seoul_glow") }, taskId),
    );
    return { quote, result };
  }

  it("stays WORKING with a pending_clinic booking, then confirmBooking completes the task and reports it", async () => {
    const { result } = await bookSeoulGlow();
    expect(result.state).toBe("TASK_STATE_WORKING");
    const pending = BookingV1Schema.parse(result.data);
    expect(pending.status).toBe("pending_clinic");
    expect(pending.priceKrw).toBe(340000);
    expect(taskCompleter.complete).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    const db = clinicStore();
    expect((await db.booking(pending.bookingId))?.status).toBe("pending_clinic");
    const slot = (await db.slots("cln_seoul_glow")).find((candidate) => candidate.start === "2026-11-14T11:00:00+09:00");
    expect(slot?.held).toBe(true);

    const confirmed = await confirmBooking("cln_seoul_glow", pending.bookingId, "clinic_staff");
    expect(confirmed).toEqual({ bookingId: pending.bookingId, status: "confirmed", confirmedBy: "clinic_staff" });

    expect(taskCompleter.complete).toHaveBeenCalledTimes(1);
    const [self, taskId, completion] = vi.mocked(taskCompleter.complete).mock.calls[0] as [unknown, string, SkillResult];
    expect(self).toEqual({ role: "clinic", agentId: "cln_seoul_glow" });
    expect(taskId).toBe("tsk_book_1");
    expect(completion.state).toBe("TASK_STATE_COMPLETED");
    const artifact = BookingV1Schema.parse(completion.data);
    expect(artifact).toMatchObject({ status: "confirmed", confirmedBy: "clinic_staff", referralToken: token("cln_seoul_glow"), customerAgentId: CUSTOMER });

    const calls = vi.mocked(sendMessage).mock.calls.map(([options]) => options);
    const report = calls.find((options) => options.skillId === "platform.report_booking");
    expect(report).toBeDefined();
    expect(report!.toCardUrl).toBe("https://pibu.example/a2a/platform/agent-card.json");
    expect(report!.from).toEqual({ role: "clinic", agentId: "cln_seoul_glow" });
    expect(BookingV1Schema.parse(report!.data)).toEqual(artifact);
    const notify = calls.find((options) => options.skillId === "customer.notify");
    expect(notify!.toCardUrl).toBe(`https://pibu.example/a2a/customers/${CUSTOMER}/agent-card.json`);
    expect(notify!.data).toMatchObject({ schema: "pibu/notification@1", kind: "booking_confirmed", bookingId: pending.bookingId });

    const stored = await db.booking(pending.bookingId);
    expect(stored).toMatchObject({ status: "confirmed", confirmedBy: "clinic_staff" });
    expect(stored?.reports?.platform?.ok).toBe(true);

    // Idempotent: a second confirm calls nobody.
    await confirmBooking("cln_seoul_glow", pending.bookingId, "clinic_staff");
    expect(taskCompleter.complete).toHaveBeenCalledTimes(1);
  });

  it("keeps the confirmation when the platform report fails", async () => {
    vi.mocked(sendMessage).mockRejectedValue(new Error("platform down"));
    const { result } = await bookSeoulGlow();
    const pending = BookingV1Schema.parse(result.data);
    await confirmBooking("cln_seoul_glow", pending.bookingId, "pibu_operator");
    const stored = await clinicStore().booking(pending.bookingId);
    expect(stored?.status).toBe("confirmed");
    expect(stored?.reports?.platform).toMatchObject({ ok: false, error: "platform down" });
  });

  it("refuses to confirm for another clinic or an unknown booking", async () => {
    const { result } = await bookSeoulGlow();
    const pending = BookingV1Schema.parse(result.data);
    await expect(confirmBooking("cln_mint", pending.bookingId, "clinic_staff")).rejects.toThrow(/another clinic/);
    await expect(confirmBooking("cln_seoul_glow", "bkg_missing", "clinic_staff")).rejects.toThrow(/not found/);
    expect(taskCompleter.complete).not.toHaveBeenCalled();
  });

  it("asks for safety information (INPUT_REQUIRED) when it is missing, then continues", async () => {
    const { result } = await bookSeoulGlow({ safetyInfo: undefined });
    expect(result.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(result.inputRequest).toMatchObject({ schema: "pibu/input-request@1" });
    const keys = (result.inputRequest!.fields as { key: string }[]).map((field) => field.key);
    expect(keys).toEqual(["pregnantOrBreastfeeding", "allergies"]);

    const continued = await skill("clinic.book")(
      { schema: "pibu/input-response@1", values: { pregnantOrBreastfeeding: "no", allergies: "lidocaine" } },
      { ...ctx("seoul-glow", {}, "tsk_book_1"), existingTaskState: "TASK_STATE_INPUT_REQUIRED" },
    );
    expect(continued.state).toBe("TASK_STATE_WORKING");
    const [booking] = await clinicStore().bookings({ clinicId: "cln_seoul_glow" });
    expect(booking.request.safetyInfo).toEqual({ pregnantOrBreastfeeding: false, allergies: ["lidocaine"] });
  });

  it("auto-confirms when a directly operated clinic turned autoConfirm on", async () => {
    const db = clinicStore();
    const policy = (await db.slotPolicy("cln_seoul_glow"))!;
    await db.putSlotPolicy({ ...policy, autoConfirm: true });
    const { result } = await bookSeoulGlow();
    expect(result.state).toBe("TASK_STATE_COMPLETED");
    expect(BookingV1Schema.parse(result.data)).toMatchObject({ status: "confirmed", confirmedBy: "auto" });
    expect(vi.mocked(sendMessage).mock.calls.some(([options]) => options.skillId === "platform.report_booking")).toBe(true);
  });

  it("never auto-confirms for a proxy clinic", async () => {
    const db = clinicStore();
    const policy = (await db.slotPolicy("cln_mint"))!;
    await db.putSlotPolicy({ ...policy, autoConfirm: true });
    const quote = QuoteV1Schema.parse((await quoteAt("mint")).data);
    const result = await skill("clinic.book")(bookingRequest("cln_mint", quote.quoteId), ctx("mint", { referralToken: token("cln_mint") }));
    expect(result.state).toBe("TASK_STATE_WORKING");
  });

  it("rejects a taken slot and a quote this clinic never issued", async () => {
    await bookSeoulGlow();
    const second = await bookSeoulGlow({}, "tsk_book_2");
    expect(second.result.state).toBe("TASK_STATE_REJECTED");
    expect(second.result.text).toMatch(/slot_unavailable/);

    const unknown = await skill("clinic.book")(bookingRequest("cln_seoul_glow", "qt_unknown", { slot: "2026-11-15T10:00:00+09:00" }), ctx("seoul-glow", { referralToken: token("cln_seoul_glow") }));
    expect(unknown.text).toMatch(/unknown_quote/);
  });

  it("rejectBooking ends the task REJECTED and frees the slot", async () => {
    const { result } = await bookSeoulGlow();
    const pending = BookingV1Schema.parse(result.data);
    await rejectBooking("cln_seoul_glow", pending.bookingId, "희망 시간이 마감됐어요");
    expect(vi.mocked(taskCompleter.complete).mock.calls[0][2]).toEqual({ state: "TASK_STATE_REJECTED", text: "희망 시간이 마감됐어요" });
    const db = clinicStore();
    expect((await db.booking(pending.bookingId))?.status).toBe("canceled");
    const slot = (await db.slots("cln_seoul_glow")).find((candidate) => candidate.start === "2026-11-14T11:00:00+09:00");
    expect(slot?.held).toBe(false);
  });

  it("proposes another time through INPUT_REQUIRED and moves the booking when the guest accepts", async () => {
    const { result } = await bookSeoulGlow();
    const pending = BookingV1Schema.parse(result.data);
    await proposeBookingTime("cln_seoul_glow", pending.bookingId, "2026-11-15T14:00:00+09:00");
    const [, , asked] = vi.mocked(taskCompleter.complete).mock.calls[0] as [unknown, string, SkillResult];
    expect(asked.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(asked.inputRequest).toMatchObject({ schema: "pibu/input-request@1", fields: [{ key: "acceptProposedSlot" }] });

    const continued = await skill("clinic.book")(
      { schema: "pibu/input-response@1", values: { acceptProposedSlot: "yes" } },
      { ...ctx("seoul-glow", {}, "tsk_book_1"), existingTaskState: "TASK_STATE_INPUT_REQUIRED" },
    );
    expect(continued.state).toBe("TASK_STATE_WORKING");
    expect(BookingV1Schema.parse(continued.data).slot).toBe("2026-11-15T14:00:00+09:00");
  });

  it("cancels on the customer's request and frees the slot", async () => {
    const { result } = await bookSeoulGlow();
    const pending = BookingV1Schema.parse(result.data);
    const stranger = await skill("clinic.cancel")(
      { schema: "pibu/cancel-request@1", bookingId: pending.bookingId, reason: "x" },
      { ...ctx("seoul-glow"), caller: { role: "customer", agentId: "cag_other" } },
    );
    expect(stranger.state).toBe("TASK_STATE_REJECTED");
    const canceled = await skill("clinic.cancel")({ schema: "pibu/cancel-request@1", bookingId: pending.bookingId, reason: "Flight changed" }, ctx("seoul-glow"));
    expect(BookingV1Schema.parse(canceled.data).status).toBe("canceled");
  });
});

describe("clinic.offers and clinic.availability", () => {
  it("lists the regular menu and this month's events", async () => {
    const result = await skill("clinic.offers")({ schema: "pibu/offers-query@1" }, ctx("mint"));
    const offers = OffersV1Schema.parse(result.data);
    expect(offers.month).toBe("2026-11");
    expect(offers.items).toHaveLength(2);
    expect(offers.items.find((item) => item.event)?.event?.regularPriceKrw).toBe(150000);
    const october = OffersV1Schema.parse((await skill("clinic.offers")({ schema: "pibu/offers-query@1", month: "2026-10" }, ctx("mint"))).data);
    expect(october.items.some((item) => item.event)).toBe(false);
  });

  it("returns free slots, indicative for proxy clinics", async () => {
    const query = { schema: "pibu/availability-query@1", procedureId: "rejuran_healer", from: "2026-11-14", to: "2026-11-14" };
    const mint = (await skill("clinic.availability")(query, ctx("mint"))).data!;
    expect(mint).toMatchObject({ schema: "pibu/availability@1", clinicId: "cln_mint", indicative: true });
    expect(mint.slots).toHaveLength(4);
    expect((await skill("clinic.availability")(query, ctx("seoul-glow"))).data!.indicative).toBe(false);
  });
});

describe("ZK offer proof in clinic.quote (03 zk-offer-proof/v1, docs/INTEGRATION.md 3절)", () => {
  const MINT_OFFER = "ofr_mint_rejuran_first_visit";
  const SUBJECT = "0x5c0d6f0a8c2e4b1f9d3a7e6c5b4a39281716050403020100ffeeddccbbaa9988";
  const bundle = (offerId = MINT_OFFER, extra: Record<string, unknown> = {}) => ({
    subjectId: SUBJECT,
    offerId,
    today: 29880272,
    proofs: [{ proof: "0x1f2e3d4c", publicInputs: ["0x0b1c2d3e", "29880272", "0", "2", "0", "100000", "0", "0"] }],
    ...extra,
  });
  const offerProof = (offerId = MINT_OFFER, clinicId = "cln_mint", extra: Record<string, unknown> = {}) => ({
    schema: "pibu/offer-proof@1",
    clinicId,
    chainId: 84532,
    registry: "0xcf47152e720508bf8c757a55aa30956ca8b58857",
    ...bundle(offerId, extra),
  });

  /** Mint's first visit event as a proof-only event (docs/spec/03 quote example), replacing the plain fixture event. */
  async function useProofOnlyMintEvent(): Promise<void> {
    const db = clinicStore();
    const plain = (await db.offer("of_mint_rejuran_first"))!;
    await db.removeOffer(plain.id);
    await db.putOffer({ ...plain, id: MINT_OFFER, zkClauses: [{ clinicId: "cln_mint", maxCount: 0 }] });
  }

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    process.env.ZK_SERVER_URL = "http://localhost:4007";
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await useProofOnlyMintEvent();
  });
  afterEach(() => warn.mockRestore());

  it.each([
    ["metadata.offerProof (pibu/offer-proof@1)", { offerProof: offerProof() }],
    ["metadata.zkOfferProof (bundle from the customer agent)", { zkOfferProof: bundle() }],
  ])("applies the 1cc event at 99,000 with offerApplied for a verified proof in %s", async (_label, metadata) => {
    vi.mocked(verifyOffer).mockResolvedValue({ ok: true, reason: "verified" });
    const result = await quoteAt("mint", 2, metadata);
    expect(result.state).toBe("TASK_STATE_COMPLETED");
    const quote = QuoteV1Schema.parse(result.data);
    expect(quote).toMatchObject({ clinicId: "cln_mint", amount: { value: 1, unit: "cc" }, priceKrw: 99000, vatIncluded: true, indicative: true });
    expect(quote.offerApplied).toEqual({ offerId: MINT_OFFER, verified: true });
    expect(quote.event).toEqual({
      title: "First visit 1cc event",
      regularPriceKrw: 150000,
      validFrom: "2026-11-01",
      validUntil: "2026-11-30",
      conditions: "First visit only",
      zkClauses: [{ clinicId: "cln_mint", maxCount: 0 }],
    });
    expect(verifyOffer).toHaveBeenCalledWith("cln_mint", bundle());
    expect((await clinicStore().quote(quote.quoteId))?.offerId).toBe(MINT_OFFER);
    const [task] = await clinicStore().tasks("cln_mint");
    expect(task?.summary).toBe("이벤트 견적 · 오퍼 증명 확인");
  });

  it("quotes the list price without a proof, and never asks the verifier", async () => {
    const quote = QuoteV1Schema.parse((await quoteAt("mint")).data);
    expect([quote.amount.value, quote.priceKrw, quote.event, quote.offerApplied]).toEqual([1, 150000, undefined, undefined]);
    expect(verifyOffer).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["the verifier refuses", () => vi.mocked(verifyOffer).mockResolvedValue({ ok: false, reason: "증명 검증 실패" }), "rejected"],
    ["the verifier is unreachable", () => vi.mocked(verifyOffer).mockRejectedValue(new Error("fetch failed: ECONNREFUSED")), "verifier_unreachable"],
  ])("quotes the list price, not a rejection, when %s", async (_label, arrange, reason) => {
    arrange();
    const result = await quoteAt("mint", 2, { offerProof: offerProof() });
    expect(result.state).toBe("TASK_STATE_COMPLETED");
    const quote = QuoteV1Schema.parse(result.data);
    expect([quote.priceKrw, quote.event, quote.offerApplied]).toEqual([150000, undefined, undefined]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`cln_mint offer proof not applied: ${reason}`), expect.anything());
    const [task] = await clinicStore().tasks("cln_mint");
    expect(task?.summary).toBe(`메뉴 견적 · 오퍼 증명 미적용 (${reason})`);
  });

  it("applies the event like a plain one when no ZK server is configured, with or without a proof (BUILD-LOG P12)", async () => {
    delete process.env.ZK_SERVER_URL;
    for (const metadata of [{}, { offerProof: offerProof() }]) {
      const quote = QuoteV1Schema.parse((await quoteAt("mint", 2, metadata)).data);
      expect([quote.amount.value, quote.priceKrw, quote.event?.regularPriceKrw, quote.event?.zkClauses, quote.offerApplied]).toEqual([
        1, 99000, 150000, undefined, undefined,
      ]);
    }
    expect(verifyOffer).not.toHaveBeenCalled();
  });

  it("gives up on a verifier that does not answer in time", async () => {
    process.env.ZK_TIMEOUT_MS = "20";
    vi.mocked(verifyOffer).mockReturnValue(new Promise(() => {}));
    const quote = QuoteV1Schema.parse((await quoteAt("mint", 2, { zkOfferProof: bundle() })).data);
    expect([quote.priceKrw, quote.offerApplied]).toEqual([150000, undefined]);
  });

  it("does not send another clinic's proof to the verifier", async () => {
    const otherClinic = QuoteV1Schema.parse((await quoteAt("mint", 2, { offerProof: offerProof("ofr_seoul_glow_rejuran_second", "cln_seoul_glow") })).data);
    const otherOffer = QuoteV1Schema.parse((await quoteAt("mint", 2, { zkOfferProof: bundle("ofr_hanbit_first_visit") })).data);
    expect([otherClinic.priceKrw, otherOffer.priceKrw]).toEqual([150000, 150000]);
    expect(verifyOffer).not.toHaveBeenCalled();
  });

  it("lets an unanchored pseudonym through a first visit event only", async () => {
    vi.mocked(verifyOffer).mockResolvedValue({ ok: true, reason: "빈 차트로 간주", unanchored: true });
    const first = QuoteV1Schema.parse((await quoteAt("mint", 2, { offerProof: offerProof(MINT_OFFER, "cln_mint", { unanchored: true }) })).data);
    expect([first.priceKrw, first.offerApplied?.offerId]).toEqual([99000, MINT_OFFER]);

    const db = clinicStore();
    const second = { ...(await db.offer(MINT_OFFER))!, id: "ofr_mint_rejuran_second", zkClauses: [{ type: "rejuran_healer", minCount: 1, maxCount: 1 }] };
    await db.removeOffer(MINT_OFFER);
    await db.putOffer(second);
    const refused = QuoteV1Schema.parse((await quoteAt("mint", 2, { zkOfferProof: bundle(second.id) })).data);
    expect([refused.priceKrw, refused.offerApplied]).toEqual([150000, undefined]);
  });

  it("without a menu item, quotes the proof-only event's amount at its regular price (data/seed Mint)", async () => {
    await clinicStore().store.remove("clinic", CLINIC_COLLECTIONS.menu, "mi_mint_rejuran_1cc");
    const listPrice = QuoteV1Schema.parse((await quoteAt("mint")).data);
    expect(listPrice).toMatchObject({ product: "Rejuran", amount: { value: 1, unit: "cc" }, priceKrw: 150000, vatIncluded: true });
    expect([listPrice.event, listPrice.offerApplied]).toEqual([undefined, undefined]);

    vi.mocked(verifyOffer).mockResolvedValue({ ok: true, reason: "verified" });
    const proven = QuoteV1Schema.parse((await quoteAt("mint", 2, { zkOfferProof: bundle() })).data);
    expect(proven).toMatchObject({ product: "Rejuran", priceKrw: 99000, offerApplied: { offerId: MINT_OFFER, verified: true } });
  });

  it("keeps plain events for everyone: a failed proof does not switch them off", async () => {
    vi.mocked(verifyOffer).mockResolvedValue({ ok: false, reason: "증명 검증 실패" });
    const quote = QuoteV1Schema.parse((await quoteAt("seoul-glow", 2, { zkOfferProof: bundle() })).data);
    expect(quote.priceKrw).toBe(340000);
    const db = clinicStore();
    await db.putOffer({ ...(await db.offer(MINT_OFFER))!, id: "of_mint_plain", zkClauses: undefined, priceKrw: 120000 });
    const plain = QuoteV1Schema.parse((await quoteAt("mint", 2, { zkOfferProof: bundle() })).data);
    expect([plain.priceKrw, plain.event?.zkClauses, plain.offerApplied]).toEqual([120000, undefined, undefined]);
  });
});

describe("agent card", () => {
  it("builds the proxy card with operation params and a non-required referral extension", async () => {
    const card = (await clinicAgent.card("mint", "https://pibu.example")) as Record<string, any>;
    expect(card.name).toBe("Mint Dermatology Clinic Agent");
    expect(card.supportedInterfaces[0]).toEqual({ url: "https://pibu.example/a2a/clinics/mint/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" });
    expect(card.provider.organization).toMatch(/operating on behalf of Mint/);
    const [operation, referral] = card.capabilities.extensions;
    expect(operation).toMatchObject({
      uri: "https://pibu.app/ext/clinic-operation/v1",
      required: false,
      params: { mode: "proxy", dataSources: ["sms", "public_web"], lastVerifiedAt: "2026-10-20", foreignPatientFacilityRegistered: true },
    });
    expect(referral).toMatchObject({ uri: "https://pibu.app/ext/referral/v1", required: false });
    expect(card.skills.map((s: { id: string }) => s.id)).toEqual(["clinic.offers", "clinic.quote", "clinic.availability", "clinic.book", "clinic.cancel"]);
  });

  it("declares the zk-offer-proof extension (03 card example), empty env values counting as unset", async () => {
    const zkExtension = async () =>
      ((await clinicAgent.card("mint", "https://pibu.example")) as Record<string, any>).capabilities.extensions.find(
        (extension: { uri: string }) => extension.uri === "https://pibu.app/ext/zk-offer-proof/v1",
      );
    delete process.env.ZK_CHAIN_ID;
    delete process.env.ZK_REGISTRY_ADDRESS;
    const declared = { chainId: 84532, registry: "0xcf47152e720508bf8c757a55aa30956ca8b58857" };
    expect(await zkExtension()).toEqual({
      uri: "https://pibu.app/ext/zk-offer-proof/v1",
      description: expect.stringContaining("metadata.offerProof"),
      required: false,
      params: declared,
    });
    process.env.ZK_CHAIN_ID = "";
    process.env.ZK_REGISTRY_ADDRESS = "";
    expect((await zkExtension()).params).toEqual(declared);
    process.env.ZK_REGISTRY_ADDRESS = `0x${"12".repeat(20)}`;
    expect((await zkExtension()).params.registry).toBe(`0x${"12".repeat(20)}`);
  });

  it("builds the direct card for a clinic that took over, with the same skill ids", async () => {
    const card = (await clinicAgent.card("cln_seoul_glow", "https://pibu.example/")) as Record<string, any>;
    expect(card.provider.organization).toBe("Seoul Glow Clinic");
    expect(card.capabilities.extensions[0].params.mode).toBe("clinic");
    expect(card.supportedInterfaces[0].url).toBe("https://pibu.example/a2a/clinics/cln_seoul_glow/rpc");
  });

  it("knows clinics by id and slug", async () => {
    expect(await clinicAgent.exists("cln_mint")).toBe(true);
    expect(await clinicAgent.exists("seoul-glow")).toBe(true);
    expect(await clinicAgent.exists("cln_nope")).toBe(false);
    await expect(clinicAgent.card("cln_nope", "https://pibu.example")).rejects.toThrow(/unknown clinic/);
  });
});
