import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ user: null as { id: string; email: string; name: null; customerAgentId: string; role: "customer" } | null }));
// The customer BFF imports through the "@/" alias, which vitest does not resolve here: map it to the same modules.
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => session.user }));
vi.mock("@/lib/agents/customer/account", () => import("./account"));
vi.mock("@/lib/agents/customer/bff", () => import("./bff"));
vi.mock("@/lib/agents/customer/consent", () => import("./consent"));
vi.mock("@/lib/agents/customer/orchestrator", () => import("./orchestrator"));
vi.mock("@/lib/agents/customer/review", () => import("./review"));
vi.mock("@/lib/store", () => import("../../store"));
vi.mock("../../zk/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../zk/client")>()),
  submitReview: vi.fn(),
  walletView: vi.fn(),
}));

import { POST as reviewRoute } from "../../../app/api/customer/records/[id]/review/route";
import { sendMessage } from "../../a2a/client";
import { ReviewV1Schema } from "../../a2a/schemas";
import { BASE, setupA2ATest, teardownA2ATest } from "../../a2a/testing/harness";
import type { TreatmentRecord } from "../../domain/customer";
import { getStore } from "../../store";
import { submitReview, walletView } from "../../zk/client";
import type { WalletView } from "../../zk/types";
import { ReviewError, submitVisitReview, visitProofFor, type ReviewZk } from "./review";
import { ensureDemoCustomer } from "./seed";
import { C, getOf, putOf } from "./store";

// 후기 제출 through the real platform agent (app/a2a/platform routes, platform.submit_review). GlowPass is mocked
// on both sides: the wallet the customer agent reads and the review relay the platform calls.

const LIN = "cus_lin";
const LIN_RECORD = "rec_lin_01"; // seeded: Hanbit, rejuran_healer, clinic confirmed and anchored

const wallet = (pending: { clinicId: string; procedureId: string }[]): WalletView => ({
  today: 29880311,
  verifiedRecords: [],
  selfReported: [],
  onchain: { subjectId: `0x${"fd".repeat(32)}`, commitment: "0x0", version: 1 },
  pendingReviews: pending.map((p) => ({ ...p, clinic: "한빛의원", procedure: "리쥬란 힐러" })),
});
const HANBIT_TICKET = [{ clinicId: "cln_hanbit", procedureId: "rejuran_healer" }];

const deps = () => ({ store: getStore(), baseUrl: BASE, send: sendMessage });
const zkWith = (view: () => Promise<WalletView>, enabled = true): ReviewZk => ({ enabled: () => enabled, wallet: vi.fn(view) });
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error as ReviewError);

beforeEach(async () => {
  setupA2ATest();
  await ensureDemoCustomer(getStore(), LIN);
  vi.mocked(submitReview).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(walletView).mockReset().mockResolvedValue(wallet(HANBIT_TICKET));
});
afterEach(() => {
  teardownA2ATest();
  session.user = null;
  vi.unstubAllEnvs();
});

describe("submitVisitReview", () => {
  it("sends pibu/review@1 for an anchored visit and the platform accepts it through GlowPass", async () => {
    const zk = zkWith(async () => wallet(HANBIT_TICKET));
    const result = await submitVisitReview(deps(), LIN, LIN_RECORD, { rating: 4, text: " 中文沟通没问题。 " }, zk);

    expect(result).toMatchObject({ accepted: true, recordId: LIN_RECORD, clinicId: "cln_hanbit", procedureId: "rejuran_healer", rating: 4 });
    expect(result.platformText).toMatch(/^review accepted: n=\d+/);
    expect(zk.wallet).toHaveBeenCalledWith("cus_lin");
    // the platform relayed it as Lin's GlowPass persona, with the trimmed text
    expect(submitReview).toHaveBeenCalledWith("cus_lin", "cln_hanbit", "rejuran_healer", { rating: 4, text: "中文沟通没问题。" });
  });

  it("builds a visit proof that passes the schema, with a nullifier stable per visit", async () => {
    const record = (await getOf<TreatmentRecord>(getStore(), C.records, LIN_RECORD))!;
    const proof = visitProofFor(record, { rating: 5 });
    expect(ReviewV1Schema.safeParse({ schema: "pibu/review@1", clinicId: "cln_hanbit", procedureId: "rejuran_healer", rating: 5, visitProof: proof }).success).toBe(true);
    expect(proof.points).toHaveLength(8);
    // same visit, other wording: same nullifier and scope, other message
    const again = visitProofFor(record, { rating: 3, text: "changed my mind" });
    expect(again.nullifier).toBe(proof.nullifier);
    expect(again.scope).toBe(proof.scope);
    expect(again.message).not.toBe(proof.message);
    expect(visitProofFor({ ...record, id: "rec_lin_02" }, { rating: 5 }).nullifier).not.toBe(proof.nullifier);
  });

  it("surfaces the platform's spent nullifier as already_reviewed and does not reach GlowPass twice", async () => {
    // a second Hanbit visit keeps a ticket open in the wallet, so the platform's nullifier check decides
    const zk = zkWith(async () => wallet(HANBIT_TICKET));
    await submitVisitReview(deps(), LIN, LIN_RECORD, { rating: 4 }, zk);
    const error = await failure(submitVisitReview(deps(), LIN, LIN_RECORD, { rating: 5, text: "again" }, zk));
    expect(error).toBeInstanceOf(ReviewError);
    expect(error?.code).toBe("already_reviewed");
    expect(error?.message).toContain("nullifier_already_used");
    expect(submitReview).toHaveBeenCalledTimes(1);
  });

  it("answers zk_unavailable when GlowPass is off, unreachable, or down behind the platform", async () => {
    const off = await failure(submitVisitReview(deps(), LIN, LIN_RECORD, { rating: 4 }, zkWith(async () => wallet(HANBIT_TICKET), false)));
    expect(off?.code).toBe("zk_unavailable");

    const unreachable = await failure(submitVisitReview(deps(), LIN, LIN_RECORD, { rating: 4 }, zkWith(async () => Promise.reject(new TypeError("fetch failed")))));
    expect(unreachable?.code).toBe("zk_unavailable");
    expect(unreachable?.message).toContain("fetch failed");
    expect(submitReview).not.toHaveBeenCalled();

    vi.mocked(submitReview).mockRejectedValueOnce(new TypeError("fetch failed"));
    const behindPlatform = await failure(submitVisitReview(deps(), LIN, LIN_RECORD, { rating: 4 }, zkWith(async () => wallet(HANBIT_TICKET))));
    expect(behindPlatform?.code).toBe("zk_unavailable");
    expect(behindPlatform?.message).toContain("review_failed: ZK server unreachable");
  });

  it("refuses without a visit ticket, for a record that is not an anchored visit, and for invalid input", async () => {
    const noTicket = await failure(submitVisitReview(deps(), LIN, LIN_RECORD, { rating: 4 }, zkWith(async () => wallet([]))));
    expect(noTicket?.code).toBe("no_visit_ticket");

    const manual = (await getOf<TreatmentRecord>(getStore(), C.records, LIN_RECORD))!;
    await putOf(getStore(), C.records, { ...manual, id: "rec_lin_manual", source: "manual", anchor: undefined });
    expect((await failure(submitVisitReview(deps(), LIN, "rec_lin_manual", { rating: 4 }, zkWith(async () => wallet(HANBIT_TICKET)))))?.code).toBe("not_reviewable");
    expect((await failure(submitVisitReview(deps(), LIN, "rec_nobody", { rating: 4 }, zkWith(async () => wallet(HANBIT_TICKET)))))?.code).toBe("not_found");

    expect((await failure(submitVisitReview(deps(), LIN, LIN_RECORD, { rating: 6 }, zkWith(async () => wallet(HANBIT_TICKET)))))?.code).toBe("invalid_request");
    expect((await failure(submitVisitReview(deps(), LIN, LIN_RECORD, { rating: 4, text: "x".repeat(301) }, zkWith(async () => wallet(HANBIT_TICKET)))))?.code).toBe("invalid_request");
    expect(submitReview).not.toHaveBeenCalled();
  });
});

describe("POST /api/customer/records/[id]/review", () => {
  const post = (id: string, body: unknown) =>
    reviewRoute(new Request(`${BASE}/api/customer/records/${id}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), {
      params: Promise.resolve({ id }),
    });

  beforeEach(() => {
    session.user = { id: "u_lin", email: "lin@example.com", name: null, customerAgentId: "cag_4n8vd", role: "customer" };
  });

  it("returns the accepted review", async () => {
    vi.stubEnv("ZK_SERVER_URL", "http://zk.test");
    const res = await post(LIN_RECORD, { rating: 5, text: "Good" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ review: { accepted: true, recordId: LIN_RECORD, clinicId: "cln_hanbit", rating: 5 } });
    expect(walletView).toHaveBeenCalledWith("cus_lin");
  });

  it("answers 503 when the ZK server is down, 409 for a spent visit and 400 for a bad body", async () => {
    vi.stubEnv("ZK_SERVER_URL", "http://zk.test");
    vi.mocked(walletView).mockRejectedValueOnce(new TypeError("fetch failed"));
    const down = await post(LIN_RECORD, { rating: 5 });
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ error: "zk_unavailable" });

    expect((await post(LIN_RECORD, { rating: 5 })).status).toBe(200);
    const again = await post(LIN_RECORD, { rating: 4 });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "already_reviewed" });

    expect((await post(LIN_RECORD, { rating: 0 })).status).toBe(400);
  });

  it("answers 503 without calling GlowPass when ZK is not configured", async () => {
    vi.stubEnv("ZK_SERVER_URL", "");
    const res = await post(LIN_RECORD, { rating: 5 });
    expect(res.status).toBe(503);
    expect(walletView).not.toHaveBeenCalled();
  });
});
