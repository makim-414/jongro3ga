import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../clinic/definition", async () => ({ clinicAgent: (await import("../../a2a/testing/doubles")).testClinicAgent }));
vi.mock("../customer/definition", async () => ({ customerAgent: (await import("../../a2a/testing/doubles")).testCustomerAgent }));
vi.mock("../../zk/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../zk/client")>()),
  anchorVisit: vi.fn(),
  submitReview: vi.fn(),
}));

import { ensureSeeded } from "../../../data/seed/load";
import { clock } from "../../clock";
import { cardUrl, sendMessage } from "../../a2a/client";
import type { AgentRef, SkillContext } from "../../a2a/contract";
import type { RecordAnchorV1, ReviewV1 } from "../../a2a/schemas";
import { BASE, DEMO_NOW, setupA2ATest, teardownA2ATest } from "../../a2a/testing/harness";
import { taskArtifactText } from "../../a2a/wire";
import type { AttributionEntry, Outcome } from "../../domain";
import { getStore } from "../../store";
import { anchorVisit, submitReview } from "../../zk/client";
import { platformStore } from "./store";
import { anchorRecordSkill, detectLocale, submitReviewSkill } from "./zk-skills";

const YUKI: AgentRef = { role: "customer", agentId: "cag_7f3k2" };
const EMILY: AgentRef = { role: "customer", agentId: "cag_2q9wk" };
const NO_WALLET: AgentRef = { role: "customer", agentId: "cag_9c4e6" };
const SEOUL_GLOW: AgentRef = { role: "clinic", agentId: "cln_seoul_glow" };
const PLATFORM_CARD = cardUrl(BASE, { role: "platform", agentId: "platform" });
const BOOKING = "bkg_zk7001";

const ctx = (caller: AgentRef): SkillContext => ({
  caller,
  self: { role: "platform", agentId: "platform" },
  taskId: "tsk_zk",
  contextId: "ctx_zk",
  metadata: {},
});

const anchorInput = (extra: Partial<RecordAnchorV1> = {}): RecordAnchorV1 => ({
  schema: "pibu/record-anchor@1",
  bookingId: BOOKING,
  clinicId: "cln_seoul_glow",
  procedureId: "rejuran_healer",
  subjectId: `0x${"5c".repeat(32)}`,
  record: { day: 29880274, recordNonce: "1234567890", ticketCommitment: "7788990011" },
  oldCommitment: "0x0",
  newCommitment: `0x${"1a".repeat(32)}`,
  recordHash: `0x${"3c".repeat(32)}`,
  proof: "0x2a3b",
  ...extra,
});

const review = (extra: Partial<ReviewV1> = {}): ReviewV1 => ({
  schema: "pibu/review@1",
  clinicId: "cln_seoul_glow",
  procedureId: "rejuran_healer",
  rating: 5,
  text: "日本語で全部説明してくれました。",
  visitProof: { merkleTreeDepth: 10, merkleTreeRoot: "1827", nullifier: "nf_yuki_1", message: "1122", scope: "5566", points: ["1", "2", "3", "4", "5", "6", "7", "8"] },
  ...extra,
});

async function booking(status: AttributionEntry["status"], customerAgentId = YUKI.agentId): Promise<void> {
  await platformStore.putAttribution({
    id: `att_${BOOKING}`,
    bookingId: BOOKING,
    clinicId: "cln_seoul_glow",
    customerAgentId,
    matchId: "mt_zk7001",
    referralTokenJti: "jti_zk7001",
    status,
    priceKrw: 340000,
    nationality: "JP",
    reportedAt: DEMO_NOW,
  });
}

async function d0Outcome(extra: Partial<Outcome> = {}): Promise<void> {
  await platformStore.putOutcome({
    schema: "pibu/outcome@1",
    id: "out_zk7001",
    outcomeId: "out_zk7001",
    bookingId: BOOKING,
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
    submittedAt: "2026-11-14T13:10:00+09:00",
    receivedAt: "2026-11-14T13:10:00+09:00",
    ...extra,
  });
}

const seoulGlowVisits = async () => (await platformStore.verifiedVisits()).find((v) => v.id === "vv_seoul_glow_rejuran_healer")!.count;
const reviewStat = async (id: string) => (await platformStore.reviewStats()).find((r) => r.id === id);

beforeEach(async () => {
  setupA2ATest();
  await ensureSeeded(getStore());
  vi.mocked(anchorVisit).mockReset().mockResolvedValue({ tx: "0xabc123", day: 29880274 });
  vi.mocked(submitReview).mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => teardownA2ATest());

describe("platform.anchor_record", () => {
  it("anchors a D0 booking over A2A as the caller's GlowPass persona, logs it and counts one more verified visit", async () => {
    await booking("confirmed");
    await d0Outcome();
    const before = await seoulGlowVisits();

    const task = await sendMessage({
      from: YUKI,
      toCardUrl: PLATFORM_CARD,
      skillId: "platform.anchor_record",
      data: anchorInput() as unknown as Record<string, unknown>,
      contextId: "req_zk7001",
    });
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(taskArtifactText(task)).toBe("anchored 0xabc123");
    expect(anchorVisit).toHaveBeenCalledWith("cus_yuki", "cln_seoul_glow", "rejuran_healer");
    expect(await platformStore.anchorLogs()).toEqual([
      { id: `anc_${BOOKING}`, bookingId: BOOKING, subjectId: anchorInput().subjectId, tx: "0xabc123", day: 29880274, at: clock.nowIso() },
    ]);
    expect(await seoulGlowVisits()).toBe(before + 1);

    const again = await anchorRecordSkill(anchorInput() as unknown as Record<string, unknown>, ctx(YUKI));
    expect(again).toMatchObject({ state: "TASK_STATE_REJECTED" });
    expect(again.text).toContain("already_anchored");
    expect(anchorVisit).toHaveBeenCalledTimes(1);
    expect(await seoulGlowVisits()).toBe(before + 1);
  });

  it("accepts a booking the clinic reported as completed even without an outcome", async () => {
    await booking("completed");
    expect(await anchorRecordSkill(anchorInput() as unknown as Record<string, unknown>, ctx(YUKI))).toEqual({
      state: "TASK_STATE_COMPLETED",
      text: "anchored 0xabc123",
    });
  });

  it("rejects an unknown booking, another customer's booking and a booking that is not done, without calling the relayer", async () => {
    const unknown = await anchorRecordSkill(anchorInput() as unknown as Record<string, unknown>, ctx(YUKI));
    expect(unknown).toMatchObject({ state: "TASK_STATE_REJECTED" });
    expect(unknown.text).toContain("booking_not_owned");

    await booking("confirmed");
    const foreign = await anchorRecordSkill(anchorInput() as unknown as Record<string, unknown>, ctx(EMILY));
    expect(foreign.text).toContain("booking_not_owned");
    const notDone = await anchorRecordSkill(anchorInput() as unknown as Record<string, unknown>, ctx(YUKI));
    expect(notDone).toMatchObject({ state: "TASK_STATE_REJECTED" });
    expect(notDone.text).toContain("booking_not_completed");

    await booking("canceled");
    await d0Outcome();
    expect((await anchorRecordSkill(anchorInput() as unknown as Record<string, unknown>, ctx(YUKI))).text).toContain("booking_not_completed");
    expect(anchorVisit).not.toHaveBeenCalled();
    expect(await platformStore.anchorLogs()).toEqual([]);
  });

  it("rejects a clinic or procedure that does not match the booking", async () => {
    await booking("confirmed");
    await d0Outcome();
    const clinic = await anchorRecordSkill(anchorInput({ clinicId: "cln_mint" }) as unknown as Record<string, unknown>, ctx(YUKI));
    expect(clinic.text).toContain("clinic_mismatch");
    const procedure = await anchorRecordSkill(anchorInput({ procedureId: "thermage_flx" }) as unknown as Record<string, unknown>, ctx(YUKI));
    expect(procedure.text).toContain("procedure_mismatch");
    expect(anchorVisit).not.toHaveBeenCalled();
  });

  it("rejects a customer agent with no ZK record wallet", async () => {
    await booking("completed", NO_WALLET.agentId);
    const result = await anchorRecordSkill(anchorInput() as unknown as Record<string, unknown>, ctx(NO_WALLET));
    expect(result).toMatchObject({ state: "TASK_STATE_REJECTED" });
    expect(result.text).toContain("no_record_wallet");
    expect(anchorVisit).not.toHaveBeenCalled();
  });

  it("fails with a clear text when the ZK server is down or the relayer errors, and keeps no log", async () => {
    await booking("confirmed");
    await d0Outcome();
    const before = await seoulGlowVisits();

    vi.mocked(anchorVisit).mockRejectedValueOnce(new TypeError("fetch failed"));
    const down = await sendMessage({
      from: YUKI,
      toCardUrl: PLATFORM_CARD,
      skillId: "platform.anchor_record",
      data: anchorInput() as unknown as Record<string, unknown>,
      contextId: "req_zk7001",
    });
    expect(down.status.state).toBe("TASK_STATE_FAILED");
    expect(down.status.message?.parts[0].text).toBe("anchor_failed: ZK server unreachable: fetch failed");

    vi.mocked(anchorVisit).mockRejectedValueOnce(new Error("ZK server POST /api/records/visit failed (500): out of gas"));
    const relayer = await anchorRecordSkill(anchorInput() as unknown as Record<string, unknown>, ctx(YUKI));
    expect(relayer).toEqual({ state: "TASK_STATE_FAILED", text: "anchor_failed: ZK server POST /api/records/visit failed (500): out of gas" });

    expect(await platformStore.anchorLogs()).toEqual([]);
    expect(await seoulGlowVisits()).toBe(before);
  });

  it("is refused to clinic tokens by the A2A core", async () => {
    await expect(
      sendMessage({ from: SEOUL_GLOW, toCardUrl: PLATFORM_CARD, skillId: "platform.anchor_record", data: anchorInput() as unknown as Record<string, unknown>, contextId: "req_zk7001" }),
    ).rejects.toMatchObject({ code: -32011, httpStatus: 403 });
  });
});

describe("platform.submit_review", () => {
  it("adds an accepted review over A2A to the aggregate with its text, nullifier and locale", async () => {
    const task = await sendMessage({
      from: YUKI,
      toCardUrl: PLATFORM_CARD,
      skillId: "platform.submit_review",
      data: review() as unknown as Record<string, unknown>,
      contextId: "req_zk7001",
    });
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(taskArtifactText(task)).toBe("review accepted: n=19, average 4.6");
    expect(submitReview).toHaveBeenCalledWith("cus_yuki", "cln_seoul_glow", "rejuran_healer", { rating: 5, text: review().text });

    const stat = (await reviewStat("rs_seoul_glow_rejuran_healer"))!;
    expect(stat.n).toBe(19);
    expect(stat.nullifiers).toHaveLength(19);
    expect(stat.nullifiers.at(-1)).toBe("nf_yuki_1");
    expect(stat.reviews.at(-1)).toEqual({ rating: 5, text: review().text, locale: "ja" });
    expect(stat.avgRating).toBe(Math.round((stat.reviews.reduce((s, r) => s + r.rating, 0) / 19) * 10) / 10);
  });

  it("recomputes the average to one decimal (Mint: 6 reviews averaging 3.5, plus a 5)", async () => {
    await submitReviewSkill(review({ clinicId: "cln_mint", visitProof: { ...review().visitProof, nullifier: "nf_mint_new" } }) as unknown as Record<string, unknown>, ctx(YUKI));
    expect(await reviewStat("rs_mint_rejuran_healer")).toMatchObject({ n: 7, avgRating: 3.7 });
  });

  it("starts an aggregate for a new clinic and procedure", async () => {
    const result = await submitReviewSkill(
      review({ clinicId: "cln_hanbit", procedureId: "thermage_flx", rating: 4, text: "中文沟通没问题。" }) as unknown as Record<string, unknown>,
      ctx(EMILY),
    );
    expect(result).toEqual({ state: "TASK_STATE_COMPLETED", text: "review accepted: n=1, average 4.0" });
    expect(submitReview).toHaveBeenCalledWith("cus_emily", "cln_hanbit", "thermage_flx", { rating: 4, text: "中文沟通没问题。" });
    expect(await reviewStat("rs_hanbit_thermage_flx")).toMatchObject({
      clinicId: "cln_hanbit",
      procedureId: "thermage_flx",
      n: 1,
      avgRating: 4,
      nullifiers: ["nf_yuki_1"],
      reviews: [{ rating: 4, text: "中文沟通没问题。", locale: "zh-CN" }],
    });
  });

  it("refuses a nullifier that was already spent, without asking GlowPass", async () => {
    await submitReviewSkill(review() as unknown as Record<string, unknown>, ctx(YUKI));
    vi.mocked(submitReview).mockClear();

    const second = await sendMessage({
      from: YUKI,
      toCardUrl: PLATFORM_CARD,
      skillId: "platform.submit_review",
      data: review({ rating: 1 }) as unknown as Record<string, unknown>,
      contextId: "req_zk7001",
    });
    expect(second.status.state).toBe("TASK_STATE_REJECTED");
    expect(second.status.message?.parts[0].text).toContain("nullifier_already_used");
    expect(submitReview).not.toHaveBeenCalled();
    expect((await reviewStat("rs_seoul_glow_rejuran_healer"))!.n).toBe(19);
  });

  it("refuses a seeded spent nullifier too", async () => {
    const result = await submitReviewSkill(
      review({ visitProof: { ...review().visitProof, nullifier: "nf_seed_seoul_glow_rejuran_01" } }) as unknown as Record<string, unknown>,
      ctx(YUKI),
    );
    expect(result.text).toContain("nullifier_already_used");
    expect(submitReview).not.toHaveBeenCalled();
  });

  it("passes on GlowPass's proof refusal as a rejection and leaves the aggregate alone", async () => {
    vi.mocked(submitReview).mockResolvedValueOnce({ ok: false, reason: "not a member of this clinic/procedure group" });
    const refused = await submitReviewSkill(review() as unknown as Record<string, unknown>, ctx(YUKI));
    expect(refused).toEqual({ state: "TASK_STATE_REJECTED", text: "review_rejected: not a member of this clinic/procedure group" });
    expect((await reviewStat("rs_seoul_glow_rejuran_healer"))!.n).toBe(18);
  });

  it("fails with a clear text when the ZK server is down, and keeps the nullifier unspent", async () => {
    vi.mocked(submitReview).mockRejectedValueOnce(new TypeError("fetch failed"));
    const down = await submitReviewSkill(review() as unknown as Record<string, unknown>, ctx(YUKI));
    expect(down).toEqual({ state: "TASK_STATE_FAILED", text: "review_failed: ZK server unreachable: fetch failed" });
    const stat = (await reviewStat("rs_seoul_glow_rejuran_healer"))!;
    expect(stat.n).toBe(18);
    expect(stat.nullifiers).not.toContain("nf_yuki_1");

    // the same visit can be reviewed once the server is back
    expect((await submitReviewSkill(review() as unknown as Record<string, unknown>, ctx(YUKI))).state).toBe("TASK_STATE_COMPLETED");
  });

  it("rejects a customer agent with no ZK record wallet", async () => {
    const result = await submitReviewSkill(review() as unknown as Record<string, unknown>, ctx(NO_WALLET));
    expect(result).toMatchObject({ state: "TASK_STATE_REJECTED" });
    expect(result.text).toContain("no_record_wallet");
    expect(submitReview).not.toHaveBeenCalled();
  });

  it("detects the review language from its script", () => {
    expect(detectLocale("とても良かった")).toBe("ja");
    expect(detectLocale("설명이 친절했어요")).toBe("ko");
    expect(detectLocale("很满意")).toBe("zh-CN");
    expect(detectLocale("Great staff")).toBe("en");
  });
});
