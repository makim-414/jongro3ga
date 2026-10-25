import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clinic/definition", async () => ({ clinicAgent: (await import("../../a2a/testing/doubles")).testClinicAgent }));
vi.mock("../customer/definition", async () => ({ customerAgent: (await import("../../a2a/testing/doubles")).testCustomerAgent }));

import { araBurstOutcomes } from "../../../data/seed/load";
import { clock } from "../../clock";
import { issueReferralToken, verifyReferralToken } from "../../a2a/auth";
import { cardUrl, sendMessage } from "../../a2a/client";
import type { AgentRef } from "../../a2a/contract";
import { listA2ALog } from "../../a2a/log";
import type { ClinicShortlistV1, FairnessVerdictListV1, ProcedureRequestV1 } from "../../a2a/schemas";
import { BASE, setupA2ATest, teardownA2ATest } from "../../a2a/testing/harness";
import { taskArtifactData, taskArtifactText, type WireTask } from "../../a2a/wire";
import type { Outcome } from "../../domain";
import { getStore } from "../../store";
import { submitOutcomeSkill } from "./skills";
import { platformStore } from "./store";

const YUKI: AgentRef = { role: "customer", agentId: "cag_7f3k2" };
const LIN: AgentRef = { role: "customer", agentId: "cag_5h8w1" };
const EMILY: AgentRef = { role: "customer", agentId: "cag_9c4e6" };
const GLOW: AgentRef = { role: "clinic", agentId: "cln_seoul_glow" };
const MINT: AgentRef = { role: "clinic", agentId: "cln_mint" };
const PLATFORM_CARD = cardUrl(BASE, { role: "platform", agentId: "platform" });

const yukiRequest: ProcedureRequestV1 = {
  schema: "pibu/procedure-request@1",
  requestId: "req_yuki01",
  customerAgentId: "cag_7f3k2",
  procedureId: "rejuran_healer",
  amount: { value: 2, unit: "cc" },
  budgetKrw: { max: 450000 },
  areas: ["sinsa", "gangnam", "apgujeong"],
  languages: ["ja"],
  dateWindow: { from: "2026-11-08", to: "2026-11-10" },
  visitorProfile: { nationality: "JP", residency: "short_term_visitor", ageBand: "25-29", firstKProcedure: true },
};

const call = (from: AgentRef, skillId: Parameters<typeof sendMessage>[0]["skillId"], data: Record<string, unknown>, contextId = "req_yuki01") =>
  sendMessage({ from, toCardUrl: PLATFORM_CARD, skillId, data, contextId });

async function match(from: AgentRef = YUKI, request: ProcedureRequestV1 = yukiRequest): Promise<{ task: WireTask; shortlist: ClinicShortlistV1 }> {
  const task = await call(from, "platform.match_clinics", request as unknown as Record<string, unknown>, request.requestId);
  return { task, shortlist: taskArtifactData(task) as unknown as ClinicShortlistV1 };
}

beforeEach(() => setupA2ATest());
afterEach(() => teardownA2ATest());

describe("platform.match_clinics over A2A", () => {
  it("Yuki gets Seoul Glow, Mint and Ara, appliedRuleIds [], one referral token per clinic", async () => {
    const { task, shortlist } = await match();
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(shortlist.schema).toBe("pibu/clinic-shortlist@1");
    expect(shortlist.candidates.map((c) => c.clinicId)).toEqual(["cln_seoul_glow", "cln_mint", "cln_ara"]);
    expect(shortlist.appliedRuleIds).toEqual([]);
    expect(shortlist.priceReference).toMatchObject({ region: "gangnam_sinsa", sampleSize: 42, p25UnitKrw: 140000, p75UnitKrw: 185000 });
    expect(shortlist.candidates[0].agentCardUrl).toBe(`${BASE}/a2a/clinics/seoul-glow/agent-card.json`);

    for (const c of shortlist.candidates) {
      const claims = await verifyReferralToken(c.referralToken, c.clinicId);
      expect(claims).toMatchObject({ clinicId: c.clinicId, customerAgentId: "cag_7f3k2", requestId: "req_yuki01", matchId: shortlist.matchId });
      expect(await verifyReferralToken(c.referralToken, "cln_hanbit")).toBeNull();
    }
    const jtis = await Promise.all(shortlist.candidates.map(async (c) => (await verifyReferralToken(c.referralToken, c.clinicId))!.jti));
    expect(new Set(jtis).size).toBe(3);

    const log = await platformStore.matchLog(shortlist.matchId);
    expect(log).toMatchObject({ requestId: "req_yuki01", customerAgentId: "cag_7f3k2", appliedRuleIds: [] });
    expect(log!.candidatesBeforeRules.map((c) => c.clinicId)).toEqual(["cln_seoul_glow", "cln_mint", "cln_ara"]);
  });

  it("adds verifiedVisits and reviewStats for display only, and leaves reviewStats out below 3 reviews", async () => {
    const first = await match();
    const [glow, mint, ara] = first.shortlist.candidates;
    expect(glow).toMatchObject({ verifiedVisits: 1240, reviewStats: { n: 18, avgRating: 4.6 } });
    expect(mint).toMatchObject({ verifiedVisits: 980, reviewStats: { n: 6, avgRating: 3.5 } });
    expect(ara).toMatchObject({ verifiedVisits: 640, reviewStats: { n: 5, avgRating: 3 } });

    const mintStat = (await platformStore.reviewStats()).find((r) => r.clinicId === "cln_mint" && r.procedureId === "rejuran_healer")!;
    await platformStore.putReviewStats({ ...mintStat, n: 2, nullifiers: mintStat.nullifiers.slice(0, 2), reviews: mintStat.reviews.slice(0, 2) });
    const second = await match(YUKI, { ...yukiRequest, requestId: "req_yuki02" });
    const mintAgain = second.shortlist.candidates.find((c) => c.clinicId === "cln_mint")!;
    expect(mintAgain.verifiedVisits).toBe(980);
    expect(mintAgain.reviewStats).toBeUndefined();
    // Never scored: the order and the scores stay the same.
    expect(second.shortlist.candidates.map((c) => [c.clinicId, c.score])).toEqual(first.shortlist.candidates.map((c) => [c.clinicId, c.score]));
  });

  it("fills the offer cache through clinic.offers A2A calls, kept out of the customer's timeline", async () => {
    await match();
    expect((await platformStore.offerCache()).map((c) => c.clinicId).sort()).toEqual(["cln_ara", "cln_dahye", "cln_hanbit", "cln_mint", "cln_seoul_glow"]);
    const offers = await listA2ALog(getStore(), { skillId: "clinic.offers" });
    expect(offers).toHaveLength(5);
    expect(offers.every((e) => e.from.role === "platform" && e.state === "TASK_STATE_COMPLETED")).toBe(true);
    const timeline = await listA2ALog(getStore(), { contextId: "req_yuki01" });
    expect(timeline.map((e) => e.skillId)).toEqual(["platform.match_clinics"]);

    await match(YUKI, { ...yukiRequest, requestId: "req_yuki02" });
    expect(await listA2ALog(getStore(), { skillId: "clinic.offers" })).toHaveLength(5); // cache still fresh
  });

  it("rejects Korean nationals and residents with not_eligible_foreign_patient", async () => {
    const kr = await match(YUKI, { ...yukiRequest, visitorProfile: { ...yukiRequest.visitorProfile, nationality: "KR" } });
    expect(kr.task.status.state).toBe("TASK_STATE_REJECTED");
    expect(kr.task.status.message?.parts[0].text).toMatch(/^not_eligible_foreign_patient/);
    const resident = await match(YUKI, { ...yukiRequest, visitorProfile: { ...yukiRequest.visitorProfile, residency: "resident" } });
    expect(resident.task.status.state).toBe("TASK_STATE_REJECTED");
    expect(await platformStore.matchLogs()).toHaveLength(0);
  });

  it("rejects a request made for another customer agent", async () => {
    const { task } = await match(EMILY);
    expect(task.status.state).toBe("TASK_STATE_REJECTED");
  });

  it("applies rule_001 to a Chinese visitor and counts it", async () => {
    const lin: ProcedureRequestV1 = {
      ...yukiRequest,
      requestId: "req_lin01",
      customerAgentId: "cag_5h8w1",
      areas: [],
      languages: ["zh-CN"],
      visitorProfile: { nationality: "CN", residency: "short_term_visitor", ageBand: "30-34" },
    };
    const { shortlist } = await match(LIN, lin);
    expect(shortlist.appliedRuleIds).toEqual(["rule_001"]);
    expect(shortlist.candidates.map((c) => c.clinicId)).toEqual(["cln_hanbit", "cln_dahye"]);
    const rules = await platformStore.rules();
    expect(rules.find((r) => r.id === "rule_001")!.appliedCount).toBe(1);
    expect(rules.find((r) => r.id === "rule_002")!.appliedCount).toBe(0);
  });
});

describe("judge, booking, outcome", () => {
  const quotes = [
    { quoteId: "qt_glow", clinicId: "cln_seoul_glow", procedureId: "rejuran_healer", amount: { value: 2, unit: "cc" }, priceKrw: 340000, vatIncluded: true, includes: ["numbing_cream"] },
    { quoteId: "qt_mint", clinicId: "cln_mint", procedureId: "rejuran_healer", amount: { value: 1, unit: "cc" }, priceKrw: 99000, vatIncluded: true, includes: [] },
    { quoteId: "qt_ara", clinicId: "cln_ara", procedureId: "rejuran_healer", amount: { value: 2, unit: "cc" }, priceKrw: 300000, vatIncluded: false, includes: [] },
    { quoteId: "qt_hanbit", clinicId: "cln_hanbit", procedureId: "rejuran_healer", amount: { value: 2, unit: "cc" }, priceKrw: 420000, vatIncluded: true, includes: [] },
  ];

  async function judged() {
    const { shortlist } = await match();
    const task = await call(YUKI, "platform.judge_quote", { schema: "pibu/judge-request@1", requestId: "req_yuki01", matchId: shortlist.matchId, quotes });
    return { shortlist, list: taskArtifactData(task) as unknown as FairnessVerdictListV1 };
  }

  const booking = (shortlist: ClinicShortlistV1, overrides: Record<string, unknown> = {}) => ({
    schema: "pibu/booking@1",
    bookingId: "bkg_5521",
    requestId: "req_yuki01",
    quoteId: "qt_glow",
    clinicId: "cln_seoul_glow",
    customerAgentId: "cag_7f3k2",
    slot: "2026-11-09T11:00:00+09:00",
    status: "confirmed",
    confirmedBy: "clinic_staff",
    priceKrw: 340000,
    referralToken: shortlist.candidates.find((c) => c.clinicId === "cln_seoul_glow")!.referralToken,
    ...overrides,
  });

  const outcome = (overrides: Record<string, unknown> = {}) => ({
    schema: "pibu/outcome@1",
    outcomeId: "out_3310",
    bookingId: "bkg_5521",
    clinicId: "cln_seoul_glow",
    procedureId: "rejuran_healer",
    checkpoint: "D0",
    paidKrw: 340000,
    receivedAmount: { value: 2, unit: "cc" },
    productVerified: "vial_shown",
    receiptAttached: true,
    satisfaction: 5,
    painScore: 3,
    downtimeDaysActual: null,
    wouldReturn: true,
    sideEffects: [],
    visitorProfile: { nationality: "JP", ageBand: "25-29" },
    submittedAt: "2026-11-09T13:10:00+09:00",
    ...overrides,
  });

  it("judges the demo quotes like the 07 table and keeps JudgedQuotes", async () => {
    const { shortlist, list } = await judged();
    expect(list.verdicts.map((v) => [v.quoteId, v.label])).toEqual([
      ["qt_glow", "fair"],
      ["qt_mint", "underdosed"],
      ["qt_ara", "fair"],
      ["qt_hanbit", "high"],
    ]);
    expect(list.verdicts[2].clinicFlags).toEqual([{ code: "paid_more_than_quoted", avgGapPct: 15 }, { code: "indicative_price" }]);
    expect(list.verdicts[1].typicalAmount).toEqual({ min: 2, max: 3, unit: "cc" });
    const stored = await platformStore.judgedQuotes();
    expect(stored.map((j) => j.quoteId).sort()).toEqual(["qt_ara", "qt_glow", "qt_hanbit", "qt_mint"]);
    expect(stored.every((j) => j.matchId === shortlist.matchId)).toBe(true);
  });

  it("refuses to judge another customer's match", async () => {
    const { shortlist } = await judged();
    const task = await call(EMILY, "platform.judge_quote", { schema: "pibu/judge-request@1", requestId: "req_yuki01", matchId: shortlist.matchId, quotes });
    expect(task.status.state).toBe("TASK_STATE_REJECTED");
  });

  it("report_booking records attribution from the clinic that holds the referral token", async () => {
    const { shortlist } = await judged();
    const wrongClinic = await call(MINT, "platform.report_booking", booking(shortlist));
    expect(wrongClinic.status.state).toBe("TASK_STATE_REJECTED");
    const mintToken = shortlist.candidates.find((c) => c.clinicId === "cln_mint")!.referralToken;
    const foreignToken = await call(GLOW, "platform.report_booking", booking(shortlist, { referralToken: mintToken }));
    expect(foreignToken.status.state).toBe("TASK_STATE_REJECTED");
    const otherCustomer = await call(GLOW, "platform.report_booking", booking(shortlist, { customerAgentId: "cag_9c4e6" }));
    expect(otherCustomer.status.state).toBe("TASK_STATE_REJECTED");

    const ok = await call(GLOW, "platform.report_booking", booking(shortlist));
    expect(ok.status.state).toBe("TASK_STATE_COMPLETED");
    expect(taskArtifactText(ok)).toMatch(/bkg_5521/);
    const claims = await verifyReferralToken(booking(shortlist).referralToken, "cln_seoul_glow");
    expect(await platformStore.attribution("bkg_5521")).toMatchObject({
      clinicId: "cln_seoul_glow",
      customerAgentId: "cag_7f3k2",
      matchId: shortlist.matchId,
      referralTokenJti: claims!.jti,
      status: "confirmed",
      nationality: "JP",
    });
  });

  it("submit_outcome: caller checks, quoteGapRatio, PriceRecord, overwrite with history, signals", async () => {
    const { shortlist } = await judged();
    // No attribution yet: the platform cannot tie the outcome to a booking.
    expect((await call(YUKI, "platform.submit_outcome", outcome())).status.state).toBe("TASK_STATE_REJECTED");
    await call(GLOW, "platform.report_booking", booking(shortlist));

    expect((await call(EMILY, "platform.submit_outcome", outcome())).status.state).toBe("TASK_STATE_REJECTED");
    expect((await call(YUKI, "platform.submit_outcome", outcome({ clinicId: "cln_mint" }))).status.state).toBe("TASK_STATE_REJECTED");

    const recordsBefore = (await platformStore.priceRecords()).length;
    const first = await call(YUKI, "platform.submit_outcome", outcome());
    expect(first.status.state).toBe("TASK_STATE_COMPLETED");
    let stored = (await platformStore.outcomes()).filter((o) => o.bookingId === "bkg_5521");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: "out_3310", quotedKrw: 340000, quoteGapRatio: 0 });
    const records = await platformStore.priceRecords();
    expect(records).toHaveLength(recordsBefore + 1);
    expect(records.find((r) => r.id === "pr_bkg_5521")).toMatchObject({ source: "outcome", verified: true, normalizedUnitKrw: 170000, area: "sinsa", clinicId: "cln_seoul_glow" });
    expect(await platformStore.signals()).toHaveLength(0);

    const again = await call(YUKI, "platform.submit_outcome", outcome({ outcomeId: "out_3311", paidKrw: 400000, satisfaction: 2, sideEffects: ["swelling"] }));
    expect(again.status.state).toBe("TASK_STATE_COMPLETED");
    stored = (await platformStore.outcomes()).filter((o) => o.bookingId === "bkg_5521");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: "out_3310", paidKrw: 400000, quoteGapRatio: 0.1765 });
    expect(await getStore().list("platform", "outcome_history")).toHaveLength(1);
    expect((await platformStore.priceRecords()).length).toBe(recordsBefore + 1);
    expect((await platformStore.signals()).map((s) => s.kind).sort()).toEqual(["low_satisfaction", "quote_gap", "side_effect_report"]);
  });

  it("the skill itself refuses a clinic caller even past the route's role gate", async () => {
    const { shortlist } = await judged();
    await call(GLOW, "platform.report_booking", booking(shortlist));
    const result = await submitOutcomeSkill(outcome(), { caller: GLOW, self: { role: "platform", agentId: "platform" }, taskId: "tsk_x", contextId: "req_yuki01", metadata: {} });
    expect(result.state).toBe("TASK_STATE_REJECTED");
  });

  it("report_signal stores timeouts and rejections", async () => {
    const task = await call(YUKI, "platform.report_signal", { schema: "pibu/signal-report@1", clinicId: "cln_ara", kind: "response_timeout", taskId: "tsk_k2_0001", requestId: "req_yuki01", at: clock.nowIso() });
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(await platformStore.signals()).toMatchObject([{ clinicId: "cln_ara", kind: "response_timeout", value: 1, context: { taskId: "tsk_k2_0001" } }]);
  });

  it("an expired referral token still attributes a booking reported later", async () => {
    const { shortlist } = await judged();
    const { token } = await issueReferralToken({ clinicId: "cln_seoul_glow", customerAgentId: "cag_7f3k2", requestId: "req_yuki01", matchId: shortlist.matchId });
    const { advanceClockHours } = await import("../../clock");
    advanceClockHours(100);
    const task = await call(GLOW, "platform.report_booking", booking(shortlist, { referralToken: token }));
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
  });
});

describe("Ara burst injection helper", () => {
  it("dates 20 outcomes 1~29 days before now with a mean gap of exactly 0.31", () => {
    const now = new Date("2026-10-24T10:00:00+09:00");
    const burst: Outcome[] = araBurstOutcomes(now);
    expect(burst).toHaveLength(20);
    const mean = burst.reduce((s, o) => s + (o.quoteGapRatio ?? 0), 0) / burst.length;
    expect(mean).toBeCloseTo(0.31, 10);
    expect(Math.min(...burst.map((o) => o.quoteGapRatio!))).toBe(0.25);
    expect(Math.max(...burst.map((o) => o.quoteGapRatio!))).toBe(0.37);
    for (const o of burst) {
      const days = (now.getTime() - Date.parse(o.submittedAt)) / 86_400_000;
      expect(days).toBeGreaterThanOrEqual(1);
      expect(days).toBeLessThanOrEqual(29);
      expect(o).toMatchObject({ clinicId: "cln_ara", schema: "pibu/outcome@1", visitorProfile: { nationality: "JP" } });
    }
  });
});
