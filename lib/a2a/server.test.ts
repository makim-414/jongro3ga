import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Clinic and customer agents belong to other tracks; their stubs answer exists() = false. Swap in test doubles.
vi.mock("../agents/clinic/definition", async () => ({ clinicAgent: (await import("./testing/doubles")).testClinicAgent }));
vi.mock("../agents/customer/definition", async () => ({ customerAgent: (await import("./testing/doubles")).testCustomerAgent }));

import { getStore } from "../store";
import { issueAgentToken, issueReferralToken } from "./auth";
import { A2AError, A2ATimeoutError, cancelTask, cardUrl, getTask, sendMessage, setA2AFetch } from "./client";
import type { AgentRef } from "./contract";
import { listA2ALog } from "./log";
import { MASK } from "./mask";
import { listTaskRecords, taskCompleter, type TaskRecord } from "./tasks";
import { BASE, dispatch, rpcRequest, setupA2ATest, teardownA2ATest } from "./testing/harness";
import { taskArtifactData, taskArtifactText } from "./wire";

const YUKI: AgentRef = { role: "customer", agentId: "cag_7f3k2" };
const OTHER_CUSTOMER: AgentRef = { role: "customer", agentId: "cag_9c4e6" };
const PLATFORM: AgentRef = { role: "platform", agentId: "platform" };
const SEOUL_GLOW: AgentRef = { role: "clinic", agentId: "cln_seoul_glow" };
const PLATFORM_CARD = cardUrl(BASE, PLATFORM);

const judgeData = {
  schema: "pibu/judge-request@1",
  requestId: "req_01J9Z8",
  matchId: "mt_4401",
  quotes: [
    { quoteId: "qt_1203", clinicId: "cln_seoul_glow", procedureId: "rejuran_healer", amount: { value: 2, unit: "cc" }, priceKrw: 340000, vatIncluded: true, includes: [] },
  ],
};

const auth = async (ref: AgentRef) => ({ Authorization: `Bearer ${await issueAgentToken(ref)}` });

const sendBody = (skillId: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: "rpc_0001",
  method: "SendMessage",
  params: {
    message: { messageId: "msg_0001", contextId: "req_01J9Z8", role: "ROLE_USER", parts: [{ text: "hello" }, { data, mediaType: "application/json" }], metadata: { skillId } },
    configuration: { acceptedOutputModes: ["application/json"] },
    ...extra,
  },
});

beforeEach(() => setupA2ATest());
afterEach(() => teardownA2ATest());

describe("agent cards", () => {
  it("serves the platform card with the A2A 1.0 required fields, also at /.well-known", async () => {
    for (const path of ["/a2a/platform/agent-card.json", "/.well-known/agent-card.json"]) {
      const res = await dispatch(new Request(`${BASE}${path}`));
      expect(res.status).toBe(200);
      const card = await res.json();
      for (const field of ["name", "description", "supportedInterfaces", "provider", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"]) {
        expect(card).toHaveProperty(field);
      }
      expect(card.supportedInterfaces[0]).toEqual({ url: `${BASE}/a2a/platform/rpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" });
      expect(card.skills.map((s: { id: string }) => s.id).sort()).toEqual(
        [
          "platform.anchor_record",
          "platform.judge_quote",
          "platform.match_clinics",
          "platform.recipe",
          "platform.report_booking",
          "platform.report_signal",
          "platform.submit_outcome",
          "platform.submit_review",
        ],
      );
    }
  });

  it("serves clinic cards by slug or id and 404s unknown clinics", async () => {
    expect((await dispatch(new Request(`${BASE}/a2a/clinics/mint/agent-card.json`))).status).toBe(200);
    expect((await dispatch(new Request(`${BASE}/a2a/clinics/cln_mint/agent-card.json`))).status).toBe(200);
    expect((await dispatch(new Request(`${BASE}/a2a/clinics/nope/agent-card.json`))).status).toBe(404);
  });

  it("requires a bearer token for customer cards", async () => {
    const url = `${BASE}/a2a/customers/cag_7f3k2/agent-card.json`;
    expect((await dispatch(new Request(url))).status).toBe(401);
    expect((await dispatch(new Request(url, { headers: await auth(PLATFORM) }))).status).toBe(200);
  });

  it("publishes the referral public key without private parts", async () => {
    const jwks = await (await dispatch(new Request(`${BASE}/a2a/platform/jwks.json`))).json();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });
});

describe("client and server round trip", () => {
  it("lists the extensions the metadata uses in A2A-Extensions, zk-offer-proof included (03)", async () => {
    const sent: (string | null)[] = [];
    setA2AFetch((url, init) => {
      const req = new Request(url, init);
      if (req.method === "POST") sent.push(req.headers.get("A2A-Extensions"));
      return dispatch(req);
    });
    const metadata = { referralToken: "t", offerProof: { schema: "pibu/offer-proof@1" } };
    await sendMessage({ from: YUKI, toCardUrl: PLATFORM_CARD, skillId: "platform.judge_quote", data: judgeData, contextId: "req_01J9Z8", metadata });
    await sendMessage({ from: YUKI, toCardUrl: PLATFORM_CARD, skillId: "platform.judge_quote", data: judgeData, contextId: "req_01J9Z8" });
    expect(sent).toEqual(["https://pibu.app/ext/referral/v1,https://pibu.app/ext/zk-offer-proof/v1", null]);
  });

  it("SendMessage platform.judge_quote through the real route returns result.task, one masked log entry", async () => {
    const task = await sendMessage({ from: YUKI, toCardUrl: PLATFORM_CARD, skillId: "platform.judge_quote", data: judgeData, contextId: "req_01J9Z8" });
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    const data = taskArtifactData(task) as { schema: string; verdicts: { label: string; normalizedUnitKrw: number }[] };
    expect(data.schema).toBe("pibu/fairness-verdict-list@1");
    expect(data.verdicts[0]).toMatchObject({ label: "fair", normalizedUnitKrw: 170000 });

    const log = await listA2ALog(getStore(), { contextId: "req_01J9Z8" });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ method: "SendMessage", skillId: "platform.judge_quote", state: "TASK_STATE_COMPLETED", from: { agentId: "cag_7f3k2", role: "customer" }, to: { agentId: "platform", role: "platform" } });
    expect(log[0].taskId).toBe(task.id);
    expect(log[0].humanSummary.ko).toBeTruthy();

    const again = await getTask({ from: YUKI, toCardUrl: PLATFORM_CARD, taskId: task.id });
    expect(again).toEqual(task);
  });

  it("a SendMessage posted straight to the rpc route answers JSON-RPC and logs exactly one entry", async () => {
    const res = await dispatch(rpcRequest("/a2a/platform/rpc", sendBody("platform.judge_quote", judgeData), await auth(YUKI)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ jsonrpc: "2.0", id: "rpc_0001" });
    expect(body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(body.result.task.artifacts[0].artifactId).toMatch(/^art_/);
    expect(await listA2ALog(getStore())).toHaveLength(1);
  });

  it("masks sensitive fields in the stored log", async () => {
    const { token } = await issueReferralToken({ clinicId: "cln_seoul_glow", customerAgentId: YUKI.agentId, requestId: "req_01J9Z8", matchId: "mt_4401" });
    await sendMessage({
      from: YUKI,
      toCardUrl: cardUrl(BASE, { role: "clinic", agentId: "seoul-glow" }),
      skillId: "clinic.book",
      contextId: "req_01J9Z8",
      metadata: { referralToken: token },
      data: {
        schema: "pibu/booking-request@1",
        requestId: "req_01J9Z8",
        quoteId: "qt_1203",
        clinicId: "cln_seoul_glow",
        slot: "2026-11-09T11:00:00+09:00",
        guest: { displayName: "Yuki T.", contactChannel: "line", contactHandle: "yuki_demo", language: "ja" },
        safetyInfo: { pregnantOrBreastfeeding: false, allergies: ["latex"] },
        consentRef: "cns_0091",
      },
    });
    const [entry] = await listA2ALog(getStore(), { skillId: "clinic.book" });
    const json = JSON.stringify(entry);
    expect(json).not.toContain("yuki_demo");
    expect(json).not.toContain("latex");
    expect(json).toContain(MASK);
  });
});

describe("authentication and authorization", () => {
  it("answers 401 without a token or with a forged one", async () => {
    const none = await dispatch(rpcRequest("/a2a/platform/rpc", sendBody("platform.judge_quote", judgeData)));
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/Bearer/);
    const forged = await dispatch(rpcRequest("/a2a/platform/rpc", sendBody("platform.judge_quote", judgeData), { Authorization: "Bearer abc.def.ghi" }));
    expect(forged.status).toBe(401);
    expect(await listA2ALog(getStore())).toHaveLength(0);
  });

  it("refuses a clinic token calling customer.checkin on a customer agent", async () => {
    const res = await dispatch(
      rpcRequest(
        "/a2a/customers/cag_7f3k2/rpc",
        sendBody("customer.checkin", { schema: "pibu/checkin-request@1", bookingId: "bkg_5521", checkpoint: "D7", questions: ["How is it?"] }),
        await auth(SEOUL_GLOW),
      ),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe(-32011);
  });

  it("refuses a clinic token submitting an outcome to the platform", async () => {
    await expect(
      sendMessage({
        from: SEOUL_GLOW,
        toCardUrl: PLATFORM_CARD,
        skillId: "platform.submit_outcome",
        contextId: "req_01J9Z8",
        data: { schema: "pibu/outcome@1" },
      }),
    ).rejects.toMatchObject({ code: -32011, httpStatus: 403 });
  });

  it("hides another caller's task", async () => {
    const task = await sendMessage({ from: YUKI, toCardUrl: PLATFORM_CARD, skillId: "platform.judge_quote", data: judgeData, contextId: "req_01J9Z8" });
    await expect(getTask({ from: OTHER_CUSTOMER, toCardUrl: PLATFORM_CARD, taskId: task.id })).rejects.toMatchObject({ code: -32001 });
  });
});

describe("JSON-RPC and routing errors", () => {
  const tasks = () => getStore().list<TaskRecord>("shared", "a2a_tasks");

  it("rejects a skillId / schema mismatch with -32602 and creates no task", async () => {
    const res = await dispatch(rpcRequest("/a2a/platform/rpc", sendBody("platform.judge_quote", { schema: "pibu/outcome@1" }), await auth(YUKI)));
    const body = await res.json();
    expect(body.error.code).toBe(-32602);
    expect(await tasks()).toHaveLength(0);
  });

  it("rejects unknown skills, skills the agent does not offer, and invalid data with -32602", async () => {
    const headers = await auth(YUKI);
    const unknown = await (await dispatch(rpcRequest("/a2a/platform/rpc", sendBody("platform.nope", judgeData), headers))).json();
    expect(unknown.error.code).toBe(-32602);
    const notOffered = await (await dispatch(rpcRequest("/a2a/platform/rpc", sendBody("clinic.quote", judgeData), headers))).json();
    expect(notOffered.error.code).toBe(-32602);
    const invalid = await (await dispatch(rpcRequest("/a2a/platform/rpc", sendBody("platform.judge_quote", { ...judgeData, quotes: [] }), headers))).json();
    expect(invalid.error.code).toBe(-32602);
    expect(invalid.error.data.issues[0].path).toBe("quotes");
  });

  it("requires A2A-Version 1.0, knows only the P0 methods, and parses JSON", async () => {
    const headers = await auth(YUKI);
    const noVersion = new Request(`${BASE}/a2a/platform/rpc`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(sendBody("platform.judge_quote", judgeData)) });
    expect((await (await dispatch(noVersion)).json()).error.code).toBe(-32009);
    const streaming = { ...sendBody("platform.judge_quote", judgeData), method: "SendStreamingMessage" };
    expect((await (await dispatch(rpcRequest("/a2a/platform/rpc", streaming, headers))).json()).error.code).toBe(-32004);
    const unknown = { ...sendBody("platform.judge_quote", judgeData), method: "DoThings" };
    expect((await (await dispatch(rpcRequest("/a2a/platform/rpc", unknown, headers))).json()).error.code).toBe(-32601);
    const broken = new Request(`${BASE}/a2a/platform/rpc`, { method: "POST", headers: { ...headers, "A2A-Version": "1.0" }, body: "{" });
    expect((await (await dispatch(broken)).json()).error.code).toBe(-32700);
  });
});

describe("long running tasks", () => {
  const bookData = {
    schema: "pibu/booking-request@1",
    requestId: "req_01J9Z8",
    quoteId: "qt_1203",
    clinicId: "cln_seoul_glow",
    slot: "2026-11-09T11:00:00+09:00",
    guest: { displayName: "Yuki T.", contactChannel: "line", contactHandle: "yuki_demo", language: "ja" },
    consentRef: "cns_0091",
  };

  it("clinic.book returns WORKING immediately, taskCompleter finishes it, GetTask sees COMPLETED", async () => {
    const { token } = await issueReferralToken({ clinicId: "cln_seoul_glow", customerAgentId: YUKI.agentId, requestId: "req_01J9Z8", matchId: "mt_4401" });
    const clinicCard = cardUrl(BASE, SEOUL_GLOW);
    process.env.A2A_BLOCKING_WAIT_MS = "5000";
    const started = performance.now();
    const working = await sendMessage({ from: YUKI, toCardUrl: clinicCard, skillId: "clinic.book", data: bookData, contextId: "req_01J9Z8", metadata: { referralToken: token } });
    expect(working.status.state).toBe("TASK_STATE_WORKING");
    expect(performance.now() - started).toBeLessThan(2000);
    const [entry] = await listA2ALog(getStore(), { skillId: "clinic.book" });
    expect((entry.request as { params: { configuration: { returnImmediately?: boolean } } }).params.configuration.returnImmediately).toBe(true);

    await expect(taskCompleter.complete(PLATFORM, working.id, { state: "TASK_STATE_COMPLETED" })).rejects.toThrow(/belongs to/);
    const booking = { ...(taskArtifactData(working) as Record<string, unknown>), status: "confirmed", confirmedBy: "clinic_staff" };
    await taskCompleter.complete(SEOUL_GLOW, working.id, { state: "TASK_STATE_COMPLETED", data: booking });

    const done = await getTask({ from: YUKI, toCardUrl: clinicCard, taskId: working.id });
    expect(done.status.state).toBe("TASK_STATE_COMPLETED");
    expect(taskArtifactData(done)).toMatchObject({ schema: "pibu/booking@1", status: "confirmed" });
    await expect(taskCompleter.complete(SEOUL_GLOW, working.id, { state: "TASK_STATE_FAILED" })).rejects.toThrow(/already/);
  });

  it("without returnImmediately the server holds the response until the task settles (A2A 1.0 blocking)", async () => {
    process.env.A2A_BLOCKING_WAIT_MS = "5000";
    const { token } = await issueReferralToken({ clinicId: "cln_seoul_glow", customerAgentId: YUKI.agentId, requestId: "req_01J9Z8", matchId: "mt_4401" });
    const body = sendBody("clinic.book", bookData);
    (body.params.message.metadata as Record<string, unknown>).referralToken = token;
    const pending = dispatch(rpcRequest("/a2a/clinics/seoul-glow/rpc", body, await auth(YUKI)));
    let records: TaskRecord[] = [];
    for (let i = 0; i < 50 && records.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      records = await listTaskRecords(SEOUL_GLOW);
    }
    expect(records).toHaveLength(1);
    await taskCompleter.complete(SEOUL_GLOW, records[0].id, { state: "TASK_STATE_COMPLETED", text: "confirmed" });
    const res = await (await pending).json();
    expect(res.result.task.status.state).toBe("TASK_STATE_COMPLETED");

    process.env.A2A_BLOCKING_WAIT_MS = "300";
    const started = performance.now();
    const timedOut = await (await dispatch(rpcRequest("/a2a/clinics/seoul-glow/rpc", body, await auth(YUKI)))).json();
    expect(timedOut.result.task.status.state).toBe("TASK_STATE_WORKING");
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("a clinic rejects a booking without a valid referral token", async () => {
    const task = await sendMessage({ from: YUKI, toCardUrl: cardUrl(BASE, SEOUL_GLOW), skillId: "clinic.book", data: bookData, contextId: "req_01J9Z8" });
    expect(task.status.state).toBe("TASK_STATE_REJECTED");
    expect(task.status.message?.parts[0].text).toMatch(/referral/);
  });

  it("CancelTask cancels a WORKING task once", async () => {
    const { token } = await issueReferralToken({ clinicId: "cln_seoul_glow", customerAgentId: YUKI.agentId, requestId: "req_01J9Z8", matchId: "mt_4401" });
    const clinicCard = cardUrl(BASE, SEOUL_GLOW);
    const working = await sendMessage({ from: YUKI, toCardUrl: clinicCard, skillId: "clinic.book", data: bookData, contextId: "req_01J9Z8", metadata: { referralToken: token } });
    const canceled = await cancelTask({ from: YUKI, toCardUrl: clinicCard, taskId: working.id });
    expect(canceled.status.state).toBe("TASK_STATE_CANCELED");
    await expect(cancelTask({ from: YUKI, toCardUrl: clinicCard, taskId: working.id })).rejects.toMatchObject({ code: -32002 });
  });

  it("INPUT_REQUIRED accepts pibu/input-response@1 on the same task, nowhere else", async () => {
    const customerCard = cardUrl(BASE, YUKI);
    const checkin = { schema: "pibu/checkin-request@1", bookingId: "bkg_5521", checkpoint: "D7", questions: ["How is your skin?"] };
    const asked = await sendMessage({ from: PLATFORM, toCardUrl: customerCard, skillId: "customer.checkin", data: checkin, contextId: "req_01J9Z8" });
    expect(asked.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(asked.status.message?.parts.find((p) => p.data)?.data).toMatchObject({ schema: "pibu/input-request@1" });

    const answer = { schema: "pibu/input-response@1", values: { satisfaction: "5" } };
    await expect(sendMessage({ from: PLATFORM, toCardUrl: customerCard, skillId: "customer.checkin", data: answer, contextId: "req_01J9Z8" })).rejects.toMatchObject({ code: -32602 });
    const done = await sendMessage({ from: PLATFORM, toCardUrl: customerCard, skillId: "customer.checkin", data: answer, contextId: "req_01J9Z8", taskId: asked.id });
    expect(done.status.state).toBe("TASK_STATE_COMPLETED");
    expect(done.id).toBe(asked.id);
    expect(taskArtifactText(done)).toBe("check-in answered");
    await expect(sendMessage({ from: PLATFORM, toCardUrl: customerCard, skillId: "customer.checkin", data: answer, contextId: "req_01J9Z8", taskId: asked.id })).rejects.toBeInstanceOf(A2AError);
  });
});

describe("client failures", () => {
  it("times out, logs the attempt, and throws A2ATimeoutError", async () => {
    setA2AFetch((url, init) =>
      url.endsWith("/rpc")
        ? new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
        : dispatch(new Request(url, init)),
    );
    await expect(
      sendMessage({ from: YUKI, toCardUrl: PLATFORM_CARD, skillId: "platform.judge_quote", data: judgeData, contextId: "req_timeout", timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(A2ATimeoutError);
    const [entry] = await listA2ALog(getStore(), { contextId: "req_timeout" });
    expect(entry.state).toBeUndefined();
    expect(entry.response).toMatchObject({ error: { timeout: true } });
  });
});
