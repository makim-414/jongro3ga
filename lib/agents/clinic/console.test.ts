import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillContext } from "../../a2a/contract";
import { QuoteV1Schema } from "../../a2a/schemas";
import { getStore, resetStore } from "../../store";
import { resetClock, setClock } from "../../clock";

vi.mock("../../a2a/auth", () => ({
  issueAgentToken: vi.fn(),
  verifyReferralToken: vi.fn(async (raw: string, clinicId: string) =>
    raw === `ok:${clinicId}`
      ? { jti: "jti_1", clinicId, customerAgentId: "cag_7f3k2", requestId: "req_01J9Z8", matchId: "mt_1", scope: ["quote", "book"], exp: 0 }
      : null,
  ),
}));
vi.mock("../../a2a/tasks", () => ({ taskCompleter: { complete: vi.fn() } }));
vi.mock("../../a2a/client", async (importActual) => {
  const actual = await importActual<typeof import("../../a2a/client")>();
  return { ...actual, sendMessage: vi.fn(), getTask: vi.fn() };
});
vi.mock("../../auth/session", () => ({ getSessionUser: vi.fn(async () => null) }));

import { taskCompleter } from "../../a2a/tasks";
import { sendMessage } from "../../a2a/client";
import { getSessionUser } from "../../auth/session";
import { clinicAgent } from "./definition";
import {
  ConsoleError,
  consoleClinicId,
  decideBooking,
  deleteOffer,
  getAgentView,
  getDashboard,
  getInbox,
  getMenu,
  listPendingProxyBookings,
  saveMenuItem,
  saveOffer,
} from "./console";
import { writeClinicSeed } from "./seed";

const ENV = { ...process.env };
const SEOUL_GLOW = "cln_seoul_glow";

let seq = 0;
const ctx = (self: string, metadata: Record<string, unknown> = {}): SkillContext => ({
  caller: { role: "customer", agentId: "cag_7f3k2" },
  self: { role: "clinic", agentId: self },
  taskId: `tsk_c${++seq}`,
  contextId: "req_01J9Z8",
  metadata,
});

const request = {
  schema: "pibu/procedure-request@1",
  requestId: "req_01J9Z8",
  customerAgentId: "cag_7f3k2",
  procedureId: "rejuran_healer",
  amount: { value: 2, unit: "cc" },
  languages: ["ja"],
  dateWindow: { from: "2026-11-13", to: "2026-11-15" },
  visitorProfile: { nationality: "JP" },
};

async function quote(clinicId = SEOUL_GLOW) {
  const result = await clinicAgent.skills["clinic.quote"]!(request, ctx(clinicId, { referralToken: `ok:${clinicId}` }));
  return QuoteV1Schema.parse(result.data);
}

async function book(clinicId = SEOUL_GLOW) {
  const issued = await quote(clinicId);
  const result = await clinicAgent.skills["clinic.book"]!(
    {
      schema: "pibu/booking-request@1",
      requestId: "req_01J9Z8",
      quoteId: issued.quoteId,
      clinicId,
      slot: "2026-11-14T11:00:00+09:00",
      guest: { displayName: "Yuki T.", contactChannel: "line", contactHandle: "yuki_demo", language: "ja" },
      safetyInfo: { pregnantOrBreastfeeding: false, allergies: ["lidocaine"] },
      consentRef: "cns_0091",
    },
    ctx(clinicId, { referralToken: `ok:${clinicId}` }),
  );
  return (result.data as { bookingId: string }).bookingId;
}

beforeEach(async () => {
  process.env.DEMO_MODE = "true";
  process.env.PUBLIC_BASE_URL = "https://pibu.example";
  setClock("2026-11-12T10:00:00+09:00");
  resetStore();
  await writeClinicSeed(getStore());
  vi.mocked(taskCompleter.complete).mockReset().mockResolvedValue(undefined);
  vi.mocked(sendMessage).mockReset().mockResolvedValue({ id: "t", contextId: "c", status: { state: "TASK_STATE_COMPLETED" } });
  vi.mocked(getSessionUser).mockReset().mockResolvedValue(null);
});

afterEach(() => {
  process.env = { ...ENV };
  resetClock();
  vi.unstubAllGlobals();
});

describe("menu and offers edits reach the next clinic.quote", () => {
  it("a price edit changes the next quote", async () => {
    expect((await quote()).priceKrw).toBe(340000);
    const menu = await saveMenuItem(SEOUL_GLOW, "mi_seoul_glow_rejuran_2cc", { priceKrw: 320000, vatIncluded: false, includes: ["마취크림"] });
    expect(menu.items.find((item) => item.id === "mi_seoul_glow_rejuran_2cc")).toMatchObject({ priceKrw: 320000, includes: ["마취크림"], nameKo: "리쥬란 힐러" });
    const next = await quote();
    expect([next.priceKrw, next.vatIncluded, next.includes]).toEqual([320000, false, ["numbing_cream"]]);
  });

  it("a new event becomes the quote, switching it off or deleting it goes back to the menu", async () => {
    const event = {
      procedureId: "rejuran_healer",
      title: "11월 리쥬란 2cc 이벤트",
      amount: { value: 2, unit: "cc" as const },
      priceKrw: 290000,
      regularPriceKrw: 340000,
      validFrom: "2026-11-01",
      validUntil: "2026-11-30",
      conditions: "첫 방문 고객만",
      active: true,
    };
    const created = await saveOffer(SEOUL_GLOW, event);
    const offer = created.offers.find((candidate) => candidate.title === event.title)!;
    const withEvent = await quote();
    expect([withEvent.priceKrw, withEvent.event?.regularPriceKrw, withEvent.event?.conditions]).toEqual([290000, 340000, "첫 방문 고객만"]);

    await saveOffer(SEOUL_GLOW, { ...offer, active: false });
    expect((await quote()).event).toBeUndefined();

    await saveOffer(SEOUL_GLOW, { ...offer, active: true });
    await deleteOffer(SEOUL_GLOW, offer.id);
    expect((await quote()).priceKrw).toBe(340000);
  });

  it("keeps proof conditions: saved from the event sheet, kept on an edit without the field, offered as zkClauses", async () => {
    const event = {
      procedureId: "rejuran_healer",
      title: "첫 방문 리쥬란 2cc",
      amount: { value: 2, unit: "cc" as const },
      priceKrw: 290000,
      regularPriceKrw: 340000,
      validFrom: "2026-11-01",
      validUntil: "2026-11-30",
      conditions: "첫 방문 고객만",
      zkClauses: [{ clinicId: SEOUL_GLOW, maxCount: 0 }],
    };
    const created = await saveOffer(SEOUL_GLOW, event);
    const offer = created.offers.find((candidate) => candidate.title === event.title)!;
    expect(offer.zkClauses).toEqual(event.zkClauses);

    const { zkClauses: _dropped, ...withoutClauses } = offer;
    const edited = await saveOffer(SEOUL_GLOW, { ...withoutClauses, priceKrw: 280000 });
    expect(edited.offers.find((candidate) => candidate.id === offer.id)).toMatchObject({ priceKrw: 280000, zkClauses: event.zkClauses });

    const offers = await clinicAgent.skills["clinic.offers"]!({ schema: "pibu/offers-query@1", month: "2026-11" }, ctx(SEOUL_GLOW));
    const items = (offers.data as { items: { event?: { title: string; zkClauses?: unknown } }[] }).items;
    expect(items.find((item) => item.event?.title === event.title)?.event?.zkClauses).toEqual(event.zkClauses);

    await expect(saveOffer(SEOUL_GLOW, { ...offer, zkClauses: [{ clinicId: SEOUL_GLOW }] as never })).rejects.toThrow(/증명 조건/);
  });

  it("refuses an event without the required promotion fields", async () => {
    const base = {
      procedureId: "rejuran_healer",
      title: "x",
      amount: { value: 2, unit: "cc" as const },
      priceKrw: 290000,
      regularPriceKrw: 340000,
      validFrom: "2026-11-01",
      validUntil: "2026-11-30",
      conditions: "첫 방문",
    };
    await expect(saveOffer(SEOUL_GLOW, { ...base, conditions: " " })).rejects.toThrow(ConsoleError);
    await expect(saveOffer(SEOUL_GLOW, { ...base, priceKrw: 340000 })).rejects.toThrow(/정상가보다 낮아야/);
    await expect(saveOffer(SEOUL_GLOW, { ...base, validUntil: "2026-10-01" })).rejects.toThrow(/종료일/);
    await expect(saveMenuItem(SEOUL_GLOW, "mi_mint_rejuran_1cc", { priceKrw: 1, vatIncluded: true, includes: [] })).rejects.toThrow(/not found/);
    expect((await getMenu(SEOUL_GLOW)).offers).toHaveLength(1);
  });
});

describe("inbox and booking decisions", () => {
  it("lists real quote tasks and bookings, hides contact until confirmed, and confirms through confirmBooking", async () => {
    const bookingId = await book();
    let inbox = await getInbox(SEOUL_GLOW);
    const quoteRow = inbox.find((task) => task.kind === "quote")!;
    expect(quoteRow).toMatchObject({ skillId: "clinic.quote", state: "TASK_STATE_COMPLETED", priceKrw: 340000, from: "고객 에이전트 cag_7f3k2" });
    const bookingRow = inbox.find((task) => task.kind === "booking")!;
    expect(bookingRow).toMatchObject({ id: bookingId, state: "TASK_STATE_WORKING", from: "Yuki T.", priceKrw: 340000, safetyFlags: ["알레르기: lidocaine"] });
    expect(bookingRow.contact).toBeUndefined();
    expect(bookingRow.proposalSlots?.length).toBe(6);
    expect(bookingRow.proposalSlots).not.toContain("2026-11-14T11:00:00+09:00");

    inbox = await decideBooking(SEOUL_GLOW, bookingId, { action: "confirm" });
    const confirmed = inbox.find((task) => task.id === bookingId)!;
    expect(confirmed).toMatchObject({ state: "TASK_STATE_COMPLETED", outcome: "병원 직원이 확정", contact: { channel: "LINE", handle: "yuki_demo" } });
    expect(taskCompleter.complete).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendMessage).mock.calls.map(([options]) => options.skillId)).toEqual(["platform.report_booking", "customer.notify"]);
  });

  it("propose, ask and reject move the A2A task and show in the inbox", async () => {
    const bookingId = await book();
    let row = (await decideBooking(SEOUL_GLOW, bookingId, { action: "propose", slot: "2026-11-15T14:00:00+09:00" })).find((task) => task.id === bookingId)!;
    expect(row).toMatchObject({ state: "TASK_STATE_INPUT_REQUIRED", proposedSlot: "2026-11-15T14:00:00+09:00" });

    row = (await decideBooking(SEOUL_GLOW, bookingId, { action: "ask", fields: ["여권상 이름"] })).find((task) => task.id === bookingId)!;
    expect(row.requestedFields).toEqual(["여권상 이름"]);
    const askCall = vi.mocked(taskCompleter.complete).mock.calls[1][2];
    expect(askCall.inputRequest).toMatchObject({ fields: [{ key: "passportName", sensitive: true }] });

    row = (await decideBooking(SEOUL_GLOW, bookingId, { action: "reject", reason: "희망 시간이 마감됐어요", memo: "다음 주 가능" })).find((task) => task.id === bookingId)!;
    expect(row).toMatchObject({ state: "TASK_STATE_REJECTED", outcome: "거절: 희망 시간이 마감됐어요 · 다음 주 가능" });
    await expect(decideBooking(SEOUL_GLOW, bookingId, { action: "confirm" })).rejects.toMatchObject({ status: 409 });
    await expect(decideBooking("cln_mint", bookingId, { action: "confirm" })).rejects.toMatchObject({ status: 404 });
  });

  it("dashboard counts come from the store", async () => {
    const empty = await getDashboard(SEOUL_GLOW);
    expect([empty.quotesToday, empty.waiting, empty.thisWeek.length, empty.response.percent]).toEqual([0, 0, 0, null]);

    const bookingId = await book();
    let dashboard = await getDashboard(SEOUL_GLOW);
    expect([dashboard.quotesToday, dashboard.waiting, dashboard.needsAction.length]).toEqual([1, 1, 1]);
    expect(dashboard.response).toMatchObject({ quoteRequests: 1, answeredWithin20s: 1, percent: 100 });
    expect(dashboard.offersNow.map((offer) => offer.id)).toEqual(["of_seoul_glow_shurink_nov"]);

    await decideBooking(SEOUL_GLOW, bookingId, { action: "confirm" });
    dashboard = await getDashboard(SEOUL_GLOW);
    expect([dashboard.waiting, dashboard.thisWeek.length]).toEqual([0, 1]);
  });

  it("lists pending proxy bookings for the ops queue", async () => {
    await book("cln_mint");
    await book(SEOUL_GLOW);
    const queue = await listPendingProxyBookings();
    expect(queue.map((row) => row.clinicId)).toEqual(["cln_mint"]);
  });
});

describe("console session and agent view", () => {
  it("uses the clinic_staff session, falls back to Seoul Glow in DEMO_MODE, and nothing otherwise", async () => {
    expect(await consoleClinicId()).toBe(SEOUL_GLOW);
    vi.mocked(getSessionUser).mockResolvedValueOnce({ id: "u1", email: "m@x", name: null, customerAgentId: "cag_x", role: "clinic_staff", clinicId: "cln_mint" });
    expect(await consoleClinicId()).toBe("cln_mint");
    vi.mocked(getSessionUser).mockResolvedValueOnce({ id: "u2", email: "c@x", name: null, customerAgentId: "cag_y", role: "customer" });
    expect(await consoleClinicId()).toBeNull();
    process.env.DEMO_MODE = "false";
    expect(await consoleClinicId()).toBeNull();
  });

  it("shows the card served by the A2A route, or builds the same card when the route is not up", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection refused"); }));
    const direct = await getAgentView(SEOUL_GLOW, "https://pibu.example");
    expect(direct.source).toBe("direct");
    expect(direct.endpoint).toBe("https://pibu.example/a2a/clinics/seoul-glow/rpc");
    expect(direct.card.name).toBe("Seoul Glow Clinic Agent");

    const served = { ...direct.card, version: "9.9.9" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(served), { headers: { "content-type": "application/json" } })));
    const viaRoute = await getAgentView(SEOUL_GLOW, "https://pibu.example");
    expect(viaRoute.source).toBe("a2a");
    expect(viaRoute.card.version).toBe("9.9.9");
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://pibu.example/a2a/clinics/seoul-glow/agent-card.json");
  });
});
