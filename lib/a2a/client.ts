// A2A JSON-RPC client (09-architecture.md "A2A 클라이언트"). OWNER: track A2A core.
//
// A thin fetch client instead of the SDK ClientFactory: it speaks the wire JSON directly and owns logging,
// masking and timeouts in one place.
//  - fetches the callee's Agent Card (60 s cache) and picks the JSONRPC / 1.0 interface URL
//  - headers: A2A-Version: 1.0, Authorization: Bearer <agent token of `from`>, A2A-Extensions when used
//  - SendMessage returns result.task (the `{ task }` wrapper is unwrapped), GetTask returns the task itself
//  - every call (success, JSON-RPC error, timeout) becomes one masked A2ALogEntry in the shared store
import type { A2ALogEntry, I18nText } from "../domain";
import { clock } from "../clock";
import { getStore } from "../store";
import { agentTokenExpiry, issueAgentToken } from "./auth";
import { agentFromUrl, EXT_CONSENT, EXT_REFERRAL, EXT_ZK_OFFER_PROOF, jsonRpcUrlFromCard } from "./cards";
import type { AgentRef } from "./contract";
import { recordA2ALog } from "./log";
import type { SkillId } from "./schemas";
import { newId } from "./tasks";
import { buildSendMessageRequest, taskFromSendMessageResult, WireTaskSchema, type WireTask } from "./wire";

export interface SendOptions {
  from: AgentRef;
  /** Agent Card URL of the callee. */
  toCardUrl: string;
  skillId: SkillId;
  data: Record<string, unknown>;
  text?: string;
  contextId: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  timeoutMs?: number;
  /** Defaults to true for clinic.book and customer.checkin (RETURN_IMMEDIATELY_SKILLS). */
  returnImmediately?: boolean;
}

export const DEFAULT_TIMEOUT_MS = 20_000;
const CARD_TTL_MS = 60_000;
/** Header that lets the callee write the same log entry id, so one call is one entry even in one process. */
export const LOG_ID_HEADER = "Pibu-Log-Id";

/** JSON-RPC error answered by the callee (or a transport failure mapped to one). */
export class A2AError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "A2AError";
  }
}

/** The callee did not answer within timeoutMs (03 "에러 처리": mark "no response", report_signal). */
export class A2ATimeoutError extends Error {
  constructor(
    message: string,
    readonly timeoutMs: number,
  ) {
    super(message);
    this.name = "A2ATimeoutError";
  }
}

// ---- injectable fetch (tests route URLs to the real route handlers) ----

export type A2AFetch = (url: string, init: RequestInit) => Promise<Response>;

interface ClientGlobals {
  fetch?: A2AFetch;
  cards: Map<string, { card: unknown; at: number }>;
  tokens: Map<string, { token: string; exp: number }>;
}

declare global {
  var __pibuA2AClient: ClientGlobals | undefined;
}

const globals = (): ClientGlobals => (globalThis.__pibuA2AClient ??= { cards: new Map(), tokens: new Map() });

/** Replaces fetch for every A2A call (tests). Pass undefined to restore the global fetch. */
export function setA2AFetch(fetchImpl: A2AFetch | undefined): void {
  globals().fetch = fetchImpl;
}

/** Drops cached cards and tokens (tests, demo reset). */
export function clearA2AClientCache(): void {
  globals().cards.clear();
  globals().tokens.clear();
}

const doFetch = (url: string, init: RequestInit): Promise<Response> => (globals().fetch ?? fetch)(url, init);

// ---- tokens and cards ----

async function tokenFor(ref: AgentRef): Promise<string> {
  const key = `${ref.role}:${ref.agentId}`;
  const cached = globals().tokens.get(key);
  const nowS = clock.now().getTime() / 1000;
  if (cached && cached.exp - nowS > 60) return cached.token;
  const token = await issueAgentToken(ref);
  globals().tokens.set(key, { token, exp: agentTokenExpiry(token) ?? nowS + 3600 });
  return token;
}

async function fetchCard(cardUrl: string, token: string, signal: AbortSignal): Promise<unknown> {
  const cached = globals().cards.get(cardUrl);
  if (cached && performance.now() - cached.at < CARD_TTL_MS) return cached.card;
  const response = await doFetch(cardUrl, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "A2A-Version": "1.0" },
    signal,
  });
  if (!response.ok) throw new A2AError(`agent card ${cardUrl} answered HTTP ${response.status}`, -32001, undefined, response.status);
  const card: unknown = await response.json();
  globals().cards.set(cardUrl, { card, at: performance.now() });
  return card;
}

// ---- human summaries (progress screen and ops log) ----

const SKILL_SUMMARY: Record<SkillId, I18nText> = {
  "platform.recipe": {
    ko: "플랫폼에 한국 여성 시술 데이터를 물어봤어요",
    ja: "韓国人女性の施術データをプラットフォームに確認しました",
    en: "Asked the platform what Korean women choose",
  },
  "platform.match_clinics": {
    ko: "플랫폼에 맞는 병원을 물어봤어요",
    ja: "条件に合うクリニックをプラットフォームに確認しました",
    en: "Asked the platform for matching clinics",
  },
  "platform.judge_quote": {
    ko: "플랫폼이 가격을 검토했어요",
    ja: "プラットフォームが価格を確認しました",
    en: "The platform reviewed the prices",
  },
  "platform.report_booking": {
    ko: "병원이 예약을 플랫폼에 알렸어요",
    ja: "クリニックが予約をプラットフォームに報告しました",
    en: "The clinic reported the booking to the platform",
  },
  "platform.submit_outcome": {
    ko: "시술 결과를 플랫폼에 보냈어요",
    ja: "施術結果をプラットフォームに送りました",
    en: "Sent the treatment outcome to the platform",
  },
  "platform.report_signal": {
    ko: "병원 응답 상태를 플랫폼에 알렸어요",
    ja: "クリニックの応答状況をプラットフォームに伝えました",
    en: "Reported a clinic response issue to the platform",
  },  "platform.anchor_record": {
    ko: "시술 기록을 체인에 남겼어요",
    ja: "施術記録をチェーンに残しました",
    en: "Anchored the treatment record on chain",
  },
  "platform.submit_review": {
    ko: "방문 증명과 함께 후기를 보냈어요",
    ja: "来院の証明と一緒にレビューを送りました",
    en: "Sent a review with a proof of visit",
  },

  "clinic.offers": {
    ko: "병원의 이달 가격을 받아왔어요",
    ja: "クリニックの今月の価格を受け取りました",
    en: "Fetched the clinic's prices for this month",
  },
  "clinic.quote": { ko: "병원에 견적을 요청했어요", ja: "クリニックに見積もりを依頼しました", en: "Requested a quote from the clinic" },
  "clinic.availability": {
    ko: "병원의 예약 가능 시간을 확인했어요",
    ja: "クリニックの空き時間を確認しました",
    en: "Checked the clinic's open times",
  },
  "clinic.book": { ko: "병원에 예약을 요청했어요", ja: "クリニックに予約を依頼しました", en: "Requested a booking from the clinic" },
  "clinic.cancel": {
    ko: "병원에 예약 취소를 요청했어요",
    ja: "クリニックに予約のキャンセルを依頼しました",
    en: "Asked the clinic to cancel the booking",
  },
  "customer.notify": { ko: "고객에게 알림을 보냈어요", ja: "お客様に通知しました", en: "Notified the customer" },
  "customer.checkin": {
    ko: "고객에게 시술 후 상태를 물어봤어요",
    ja: "施術後の様子をお客様に確認しました",
    en: "Asked the customer how the treatment went",
  },
};

const METHOD_SUMMARY: Record<"GetTask" | "CancelTask", I18nText> = {
  GetTask: { ko: "진행 상태를 확인했어요", ja: "進捗を確認しました", en: "Checked the task status" },
  CancelTask: { ko: "요청을 취소했어요", ja: "依頼をキャンセルしました", en: "Canceled the request" },
};

/** One readable line per call for A2ALogEntry.humanSummary. */
export function humanSummaryFor(method: A2ALogEntry["method"], skillId?: string): I18nText {
  if (method !== "SendMessage") return METHOD_SUMMARY[method];
  return (skillId && SKILL_SUMMARY[skillId as SkillId]) || { ko: "에이전트에 메시지를 보냈어요", en: "Sent a message to an agent" };
}

// ---- transport ----

interface CallResult {
  body: unknown;
  httpStatus: number;
}

async function postRpc(
  rpcUrl: string,
  request: unknown,
  token: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<CallResult> {
  const response = await doFetch(rpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "A2A-Version": "1.0",
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify(request),
    signal,
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new A2AError(`agent answered HTTP ${response.status} without JSON`, -32006, undefined, response.status);
  }
  return { body, httpStatus: response.status };
}

function rpcErrorOf(body: unknown): { code: number; message: string; data?: unknown } | undefined {
  const error = (body as { error?: unknown })?.error;
  if (typeof error !== "object" || error === null) return undefined;
  const { code, message, data } = error as { code?: unknown; message?: unknown; data?: unknown };
  return { code: typeof code === "number" ? code : -32603, message: typeof message === "string" ? message : "error", data };
}

interface Exchange {
  from: AgentRef;
  toCardUrl: string;
  method: A2ALogEntry["method"];
  skillId?: SkillId;
  contextId?: string;
  taskId?: string;
  timeoutMs: number;
  extensions?: string[];
  buildRequest: () => Record<string, unknown>;
  /** Pulls the task out of a JSON-RPC result. */
  unwrap: (result: unknown) => WireTask | undefined;
}

async function exchange(x: Exchange): Promise<WireTask> {
  const started = performance.now();
  const logId = newId("log");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), x.timeoutMs);
  const to = await agentFromUrl(x.toCardUrl);
  const request = x.buildRequest();
  let rpcUrl = x.toCardUrl;
  let body: unknown;
  let failure: Error | undefined;
  let task: WireTask | undefined;

  try {
    const token = await tokenFor(x.from);
    const card = await fetchCard(x.toCardUrl, token, controller.signal);
    const resolved = jsonRpcUrlFromCard(card);
    if (!resolved) throw new A2AError(`agent card ${x.toCardUrl} has no JSONRPC 1.0 interface`, -32006);
    rpcUrl = resolved;
    const headers: Record<string, string> = { [LOG_ID_HEADER]: logId };
    if (x.extensions?.length) headers["A2A-Extensions"] = x.extensions.join(",");
    const call = await postRpc(rpcUrl, request, token, headers, controller.signal);
    body = call.body;
    const rpcError = rpcErrorOf(body);
    if (rpcError) {
      failure = new A2AError(rpcError.message, rpcError.code, rpcError.data, call.httpStatus);
    } else {
      task = x.unwrap((body as { result?: unknown })?.result);
      if (!task) failure = new A2AError("agent response has no task", -32006, body, call.httpStatus);
    }
  } catch (error) {
    failure = controller.signal.aborted
      ? new A2ATimeoutError(`no answer from ${x.toCardUrl} within ${x.timeoutMs} ms`, x.timeoutMs)
      : error instanceof Error
        ? error
        : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }

  const entry: A2ALogEntry = {
    id: logId,
    at: clock.nowIso(),
    ...(x.contextId ?? task?.contextId ? { contextId: x.contextId ?? task?.contextId } : {}),
    ...(task?.id ?? x.taskId ? { taskId: task?.id ?? x.taskId } : {}),
    from: { agentId: x.from.agentId, role: x.from.role },
    to: { agentId: to.agentId, role: to.role, url: rpcUrl },
    method: x.method,
    ...(x.skillId ? { skillId: x.skillId } : {}),
    request,
    response: body ?? (failure ? { error: { message: failure.message, ...(failure instanceof A2ATimeoutError ? { timeout: true } : {}) } } : undefined),
    ...(task ? { state: task.status.state } : {}),
    latencyMs: Math.round(performance.now() - started),
    humanSummary: humanSummaryFor(x.method, x.skillId),
  };
  try {
    await recordA2ALog(getStore(), entry);
  } catch (error) {
    console.error("[a2a] failed to write log entry", error);
  }

  if (failure) throw failure;
  return task!;
}

// ---- public API ----

function extensionsFor(metadata: Record<string, unknown> | undefined): string[] | undefined {
  const list: string[] = [];
  if (metadata?.referralToken !== undefined) list.push(EXT_REFERRAL);
  if (metadata?.consentRef !== undefined) list.push(EXT_CONSENT);
  // 03 "오퍼 증명 전달": the message lists the extension when metadata carries an offer proof
  if (metadata?.offerProof !== undefined) list.push(EXT_ZK_OFFER_PROOF);
  return list.length ? list : undefined;
}

export async function sendMessage(options: SendOptions): Promise<WireTask> {
  const extensions = extensionsFor(options.metadata);
  return exchange({
    from: options.from,
    toCardUrl: options.toCardUrl,
    method: "SendMessage",
    skillId: options.skillId,
    contextId: options.contextId,
    taskId: options.taskId,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    extensions,
    buildRequest: () =>
      buildSendMessageRequest({
        rpcId: newId("rpc"),
        messageId: newId("msg"),
        contextId: options.contextId,
        taskId: options.taskId,
        skillId: options.skillId,
        data: options.data,
        text: options.text,
        metadata: options.metadata,
        extensions,
        returnImmediately: options.returnImmediately,
      }) as Record<string, unknown>,
    unwrap: taskFromSendMessageResult,
  });
}

function unwrapTask(result: unknown): WireTask | undefined {
  const parsed = WireTaskSchema.safeParse(result);
  return parsed.success ? parsed.data : undefined;
}

export async function getTask(options: { from: AgentRef; toCardUrl: string; taskId: string; timeoutMs?: number }): Promise<WireTask> {
  return exchange({
    from: options.from,
    toCardUrl: options.toCardUrl,
    method: "GetTask",
    taskId: options.taskId,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    buildRequest: () => ({ jsonrpc: "2.0", id: newId("rpc"), method: "GetTask", params: { id: options.taskId } }),
    unwrap: unwrapTask,
  });
}

export async function cancelTask(options: { from: AgentRef; toCardUrl: string; taskId: string; timeoutMs?: number }): Promise<WireTask> {
  return exchange({
    from: options.from,
    toCardUrl: options.toCardUrl,
    method: "CancelTask",
    taskId: options.taskId,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    buildRequest: () => ({ jsonrpc: "2.0", id: newId("rpc"), method: "CancelTask", params: { id: options.taskId } }),
    unwrap: unwrapTask,
  });
}

/** Card URL helpers so callers never hand-build paths (03-a2a-protocol.md endpoint table). */
export function cardUrl(baseUrl: string, ref: AgentRef): string {
  if (ref.role === "platform") return `${baseUrl}/a2a/platform/agent-card.json`;
  if (ref.role === "clinic") return `${baseUrl}/a2a/clinics/${ref.agentId}/agent-card.json`;
  return `${baseUrl}/a2a/customers/${ref.agentId}/agent-card.json`;
}
