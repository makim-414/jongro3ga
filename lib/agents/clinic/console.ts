// Clinic console service (05-screens.md 병원 콘솔): reads and edits the clinic's own data for app/api/clinic/**
// and the console's server pages. Edits land in namespace "clinic", so the next clinic.quote and clinic.offers
// answer with them. Also the entry point the ops proxy queue uses to list pending proxy bookings.
import { ZkClauseSchema } from "../../a2a/schemas";
import { getSessionUser } from "../../auth/session";
import { clock } from "../../clock";
import type { Area, Locale } from "../../domain/common";
import type { MenuItem as DomainMenuItem } from "../../domain/clinic";
import procedureMaster from "../../../data/seed/procedures.json";
import {
  INCLUDE_TEXT,
  type AgentView,
  type BookingDecision,
  type ConsoleClinic,
  type DashboardData,
  type InboxTask,
  type MenuData,
  type MenuItem,
  type Offer,
  type TaskState,
} from "../../ui-data/clinic";
import { BookingError, confirmBooking, proposeBookingTime, publicBaseUrl, rejectBooking, requestBookingInfo } from "./booking";
import { buildClinicCard } from "./card";
import { freeSlots, kstDate } from "./quote";
import { ensureClinicData } from "./seed";
import { clinicStore, newId, operationOf, type ClinicStore, type StoredBooking, type StoredOffer, type StoredTask } from "./store";

/** Signed-out demo visitors see this clinic (DEMO_MODE only). */
export const DEMO_CLINIC_ID = "cln_seoul_glow";

export class ConsoleError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 404 | 409,
  ) {
    super(message);
    this.name = "ConsoleError";
  }
}

/** Clinic the current visitor manages: clinic staff session, or the demo clinic when signed out in DEMO_MODE. */
export async function consoleClinicId(headers?: Headers): Promise<string | null> {
  const user = await getSessionUser(headers);
  if (user?.role === "clinic_staff" && user.clinicId) return user.clinicId;
  if (!user && process.env.DEMO_MODE === "true") return DEMO_CLINIC_ID;
  return null;
}

const AREA_KO: Record<Area, string> = {
  gangnam: "강남",
  sinsa: "신사",
  apgujeong: "압구정",
  myeongdong: "명동",
  hongdae: "홍대",
  other: "서울",
};

// Product-level ids from 03/06 that the 27-procedure master (data/seed/procedures.json) does not carry.
const NAME_KO: Record<string, string> = {
  rejuran_healer: "리쥬란 힐러",
  shurink_universe: "슈링크 유니버스",
  thermage_flx: "써마지 FLX",
  botox_forehead: "이마 보톡스",
  skin_booster_juvelook: "쥬베룩",
};

const MASTER_NAME_KO = new Map(
  (procedureMaster as { id: string; name: { ko?: string } }[]).map((procedure) => [procedure.id, procedure.name.ko]),
);

export function procedureNameKo(procedureId: string, product?: string): string {
  return NAME_KO[procedureId] ?? MASTER_NAME_KO.get(procedureId) ?? product ?? procedureId;
}

const INCLUDE_CODE = Object.fromEntries(Object.entries(INCLUDE_TEXT).map(([code, label]) => [label, code]));
const includeLabel = (code: string) => INCLUDE_TEXT[code] ?? code;
const includeCode = (label: string) => INCLUDE_CODE[label] ?? label;

async function loadClinic(clinicId: string, db: ClinicStore = clinicStore()) {
  await ensureClinicData(db.store);
  const profile = await db.profile(clinicId);
  if (!profile) throw new ConsoleError(`unknown clinic ${clinicId}`, 404);
  return profile;
}

export async function getConsoleClinic(clinicId: string): Promise<ConsoleClinic> {
  const db = clinicStore();
  const profile = await loadClinic(clinicId, db);
  const operation = await operationOf(profile, db);
  const policy = await db.slotPolicy(clinicId);
  return {
    id: profile.id,
    name: profile.name.ko ?? profile.name.en ?? profile.id,
    area: AREA_KO[profile.area],
    operationMode: operation.mode,
    autoConfirm: Boolean(policy?.autoConfirm),
  };
}

// ---- inbox ----

const CHANNEL_TEXT: Record<string, string> = { email: "Email", line: "LINE", wechat: "WeChat", whatsapp: "WhatsApp" };

const ASK_FIELDS: Record<string, { key: string; label: Partial<Record<Locale, string>>; sensitive: boolean }> = {
  "직전 시술일": { key: "lastProcedureDate", label: { ko: "직전 시술일", en: "Date of your last procedure", ja: "前回の施術日" }, sensitive: false },
  "복용 중인 약": { key: "currentMedications", label: { ko: "복용 중인 약", en: "Medications you take", ja: "服用中の薬" }, sensitive: true },
  "알레르기 상세": { key: "allergyDetails", label: { ko: "알레르기 상세", en: "Allergy details", ja: "アレルギーの詳細" }, sensitive: true },
  "여권상 이름": { key: "passportName", label: { ko: "여권상 이름", en: "Name as on passport", ja: "パスポート記載の氏名" }, sensitive: true },
};

const CONFIRMED_BY_TEXT = { clinic_staff: "병원 직원이 확정", pibu_operator: "PibooK 운영자가 확정", auto: "자동 확정" } as const;

function safetyFlags(booking: StoredBooking): string[] {
  const info = booking.request.safetyInfo;
  if (!info) return [];
  const flags: string[] = [];
  if (info.pregnantOrBreastfeeding) flags.push("임신 또는 수유 중");
  if (info.allergies.length > 0) flags.push(`알레르기: ${info.allergies.join(", ")}`);
  if (info.anticoagulants) flags.push("항응고제 복용");
  if (info.recentIsotretinoin) flags.push("최근 이소트레티노인 복용");
  if (info.keloidHistory) flags.push("켈로이드 병력");
  return flags;
}

function bookingState(booking: StoredBooking): TaskState {
  if (booking.status === "pending_clinic") return booking.awaitingGuest ? "TASK_STATE_INPUT_REQUIRED" : "TASK_STATE_WORKING";
  if (booking.status === "confirmed" || booking.status === "completed") return "TASK_STATE_COMPLETED";
  return "TASK_STATE_REJECTED";
}

function bookingRow(booking: StoredBooking, proposalSlots: string[]): InboxTask {
  const state = bookingState(booking);
  const row: InboxTask = {
    id: booking.id,
    a2aTaskId: booking.a2aTaskId,
    skillId: "clinic.book",
    kind: "booking",
    state,
    receivedAt: booking.createdAt,
    from: booking.request.guest.displayName,
    language: booking.request.guest.language,
    product: booking.product,
    amount: booking.amount,
    priceKrw: booking.priceKrw,
    slot: booking.request.slot,
    safetyFlags: safetyFlags(booking),
  };
  if (state === "TASK_STATE_COMPLETED") {
    row.contact = { channel: CHANNEL_TEXT[booking.request.guest.contactChannel] ?? booking.request.guest.contactChannel, handle: booking.request.guest.contactHandle };
    row.outcome = CONFIRMED_BY_TEXT[booking.confirmedBy ?? "clinic_staff"];
  }
  if (state === "TASK_STATE_REJECTED") row.outcome = booking.rejectReason ? `거절: ${booking.rejectReason}` : "취소됨";
  if (booking.awaitingGuest?.kind === "ask") row.requestedFields = booking.awaitingGuest.fields.map((field) => field.label.ko ?? field.key);
  if (booking.awaitingGuest?.kind === "propose") row.proposedSlot = booking.awaitingGuest.proposedSlot;
  if (state === "TASK_STATE_WORKING") row.proposalSlots = proposalSlots;
  return row;
}

const QUOTE_REASON_TEXT: [RegExp, string][] = [
  [/^referral_token/, "거절: 추천 토큰 확인 실패"],
  [/^procedure_not_offered/, "거절: 메뉴에 없는 시술"],
];

function quoteRow(task: StoredTask): InboxTask {
  const state: TaskState =
    task.state === "TASK_STATE_COMPLETED" || task.state === "TASK_STATE_WORKING" || task.state === "TASK_STATE_INPUT_REQUIRED"
      ? task.state
      : "TASK_STATE_REJECTED";
  const row: InboxTask = {
    id: task.id,
    a2aTaskId: task.a2aTaskId,
    skillId: "clinic.quote",
    kind: "quote",
    state,
    receivedAt: task.at,
    from: `고객 에이전트 ${task.customerAgentId ?? ""}`.trim(),
    language: task.language ?? "en",
    product: task.product ?? procedureNameKo(task.procedureId ?? ""),
    amount: task.amount ?? { value: 0, unit: "cc" },
    respondedInSec: Math.max(1, Math.ceil((task.latencyMs ?? 0) / 1000)),
  };
  if (task.priceKrw !== undefined && state === "TASK_STATE_COMPLETED") row.priceKrw = task.priceKrw;
  if (state === "TASK_STATE_REJECTED") {
    row.outcome = QUOTE_REASON_TEXT.find(([pattern]) => pattern.test(task.reason ?? ""))?.[1] ?? "거절";
  }
  return row;
}

export async function getInbox(clinicId: string): Promise<InboxTask[]> {
  const db = clinicStore();
  await loadClinic(clinicId, db);
  const [bookings, tasks, slots] = await Promise.all([db.bookings({ clinicId }), db.tasks(clinicId), db.slots(clinicId)]);
  const today = clock.today();
  const rows = bookings.map((booking) => {
    const from = kstDate(booking.request.slot) > today ? kstDate(booking.request.slot) : today;
    const proposals = freeSlots(slots, booking.procedureId, from, "9999-12-31")
      .filter((start) => Date.parse(start) !== Date.parse(booking.request.slot))
      .slice(0, 6);
    return bookingRow(booking, proposals);
  });
  for (const task of tasks) if (task.skillId === "clinic.quote") rows.push(quoteRow(task));
  return rows.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
}

export async function decideBooking(clinicId: string, bookingId: string, decision: BookingDecision): Promise<InboxTask[]> {
  try {
    if (decision.action === "confirm") await confirmBooking(clinicId, bookingId, "clinic_staff");
    else if (decision.action === "reject") {
      const reason = [decision.reason, decision.memo].filter((part) => part && part.trim() !== "").join(" · ");
      await rejectBooking(clinicId, bookingId, reason);
    } else if (decision.action === "propose") await proposeBookingTime(clinicId, bookingId, decision.slot);
    else if (decision.action === "ask") {
      const fields = decision.fields.map(
        (label) => ASK_FIELDS[label] ?? { key: label.replace(/\W+/g, "_"), label: { ko: label }, sensitive: true },
      );
      await requestBookingInfo(clinicId, bookingId, fields);
    } else {
      throw new ConsoleError("unknown action", 400);
    }
  } catch (error) {
    if (error instanceof BookingError) {
      const status = error.code === "not_found" || error.code === "wrong_clinic" ? 404 : error.code === "invalid" ? 400 : 409;
      throw new ConsoleError(error.message, status);
    }
    throw error;
  }
  return getInbox(clinicId);
}

/** For the ops proxy queue: bookings of proxy-operated clinics that still wait for a human check. */
export async function listPendingProxyBookings(): Promise<(InboxTask & { clinicId: string; clinicName: string })[]> {
  const db = clinicStore();
  await ensureClinicData(db.store);
  const rows: (InboxTask & { clinicId: string; clinicName: string })[] = [];
  for (const profile of await db.profiles()) {
    if ((await operationOf(profile, db)).mode !== "proxy") continue;
    for (const booking of await db.bookings({ clinicId: profile.id, status: "pending_clinic" })) {
      rows.push({ ...bookingRow(booking, []), clinicId: profile.id, clinicName: profile.name.ko ?? profile.id });
    }
  }
  return rows.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
}

// ---- dashboard ----

const DAY_MS = 86_400_000;

export async function getDashboard(clinicId: string): Promise<DashboardData> {
  const clinic = await getConsoleClinic(clinicId);
  const db = clinicStore();
  const [inbox, tasks, offers] = await Promise.all([getInbox(clinicId), db.tasks(clinicId), db.offers(clinicId)]);
  const now = clock.now().getTime();
  const today = clock.today();
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

  const quotes = tasks.filter((task) => task.skillId === "clinic.quote");
  const quotesToday = quotes.filter((task) => kstDate(task.at) === today).length;
  const quotesYesterdayByNow = quotes.filter((task) => kstDate(task.at) === yesterday && Date.parse(task.at) <= now - DAY_MS).length;

  const bookings = inbox.filter((task) => task.kind === "booking");
  const confirmedIn = (from: number, to: number) =>
    bookings
      .filter((task) => task.state === "TASK_STATE_COMPLETED" && task.slot && Date.parse(task.slot) >= from && Date.parse(task.slot) < to)
      .sort((a, b) => Date.parse(a.slot ?? "") - Date.parse(b.slot ?? ""));

  const rate = (from: number, to: number) => {
    const window = quotes.filter((task) => Date.parse(task.at) >= from && Date.parse(task.at) < to);
    const answered = window.filter((task) => task.state !== "TASK_STATE_FAILED" && (task.latencyMs ?? 0) <= 20_000).length;
    return { total: window.length, answered, percent: window.length > 0 ? Math.round((answered / window.length) * 100) : null };
  };
  const current = rate(now - 7 * DAY_MS, now + 1);
  const previous = rate(now - 14 * DAY_MS, now - 7 * DAY_MS);

  return {
    clinic,
    now: clock.nowIso(),
    today,
    quotesToday,
    quotesYesterdayByNow,
    waiting: bookings.filter((task) => task.state === "TASK_STATE_WORKING").length,
    waitingGuest: bookings.filter((task) => task.state === "TASK_STATE_INPUT_REQUIRED").length,
    needsAction: bookings.filter((task) => task.state === "TASK_STATE_WORKING" || task.state === "TASK_STATE_INPUT_REQUIRED"),
    thisWeek: confirmedIn(now, now + 7 * DAY_MS),
    bookingsLastWeek: confirmedIn(now - 7 * DAY_MS, now).length,
    response: {
      windowDays: 7,
      quoteRequests: current.total,
      answeredWithin20s: current.answered,
      percent: current.percent,
      previousPercent: previous.percent,
    },
    offersNow: offers.filter((offer) => offer.active !== false && offer.validUntil >= today).map(offerView),
  };
}

// ---- menu and offers ----

function menuView(item: DomainMenuItem): MenuItem {
  return {
    id: item.id,
    procedureId: item.procedureId,
    product: item.product,
    nameKo: procedureNameKo(item.procedureId, item.product),
    amount: item.amount,
    priceKrw: item.priceKrw,
    vatIncluded: item.vatIncluded,
    includes: item.includes.map(includeLabel),
    foreignerSamePrice: item.foreignerSamePrice,
  };
}

function offerView(offer: StoredOffer): Offer {
  return {
    id: offer.id,
    procedureId: offer.procedureId,
    title: offer.title,
    amount: offer.amount,
    priceKrw: offer.priceKrw,
    regularPriceKrw: offer.regularPriceKrw,
    validFrom: offer.validFrom,
    validUntil: offer.validUntil,
    conditions: offer.conditions,
    active: offer.active !== false,
    ...(offer.zkClauses?.length ? { zkClauses: offer.zkClauses } : {}),
  };
}

export async function getMenu(clinicId: string): Promise<MenuData> {
  const db = clinicStore();
  await loadClinic(clinicId, db);
  const [items, offers] = await Promise.all([db.menu(clinicId), db.offers(clinicId)]);
  return { today: clock.today(), items: items.map(menuView), offers: offers.map(offerView) };
}

const isKrw = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;
const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

/** Price, VAT and inclusions of an existing menu item. The next clinic.quote answers with them. */
export async function saveMenuItem(
  clinicId: string,
  itemId: string,
  patch: { priceKrw?: unknown; vatIncluded?: unknown; includes?: unknown },
): Promise<MenuData> {
  const db = clinicStore();
  await loadClinic(clinicId, db);
  const item = await db.menuItem(itemId);
  if (!item || item.clinicId !== clinicId) throw new ConsoleError(`menu item ${itemId} not found`, 404);
  if (!isKrw(patch.priceKrw)) throw new ConsoleError("가격은 0보다 큰 원 단위 정수여야 해요", 400);
  if (typeof patch.vatIncluded !== "boolean") throw new ConsoleError("부가세 포함 여부가 필요해요", 400);
  if (!Array.isArray(patch.includes) || !patch.includes.every((value) => typeof value === "string")) {
    throw new ConsoleError("포함 항목 형식이 맞지 않아요", 400);
  }
  await db.putMenuItem({
    ...item,
    priceKrw: patch.priceKrw,
    vatIncluded: patch.vatIncluded,
    includes: (patch.includes as string[]).map(includeCode),
  });
  return getMenu(clinicId);
}

/**
 * Adds or edits an event. Title, regular price, period and conditions are all required (Medical Act enforcement
 * decree art. 23, 08-compliance.md), and the event price must be below the regular price.
 */
function validClauses(value: unknown): Offer["zkClauses"] {
  const parsed = ZkClauseSchema.array().safeParse(value);
  if (!parsed.success) throw new ConsoleError("증명 조건 형식이 맞지 않아요", 400);
  return parsed.data;
}

export async function saveOffer(clinicId: string, input: Partial<Offer>): Promise<MenuData> {
  const db = clinicStore();
  await loadClinic(clinicId, db);
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const conditions = typeof input.conditions === "string" ? input.conditions.trim() : "";
  const amount = input.amount;
  if (typeof input.procedureId !== "string" || input.procedureId === "") throw new ConsoleError("시술을 골라 주세요", 400);
  if (!amount || typeof amount.value !== "number" || amount.value <= 0 || typeof amount.unit !== "string") throw new ConsoleError("용량이 필요해요", 400);
  if (title === "") throw new ConsoleError("이벤트 이름을 입력해 주세요", 400);
  if (!isKrw(input.regularPriceKrw)) throw new ConsoleError("정상가를 입력해 주세요", 400);
  if (!isKrw(input.priceKrw)) throw new ConsoleError("이벤트가를 입력해 주세요", 400);
  if (input.priceKrw >= input.regularPriceKrw) throw new ConsoleError("이벤트가는 정상가보다 낮아야 해요", 400);
  if (!isDate(input.validFrom) || !isDate(input.validUntil)) throw new ConsoleError("기간을 골라 주세요", 400);
  if (input.validUntil < input.validFrom) throw new ConsoleError("종료일은 시작일 이후여야 해요", 400);
  if (conditions === "") throw new ConsoleError("적용 조건을 입력해 주세요", 400);

  const existing = typeof input.id === "string" ? await db.offer(input.id) : undefined;
  if (existing && existing.clinicId !== clinicId) throw new ConsoleError(`offer ${input.id} not found`, 404);
  // Proof conditions (ZK extension): the event sheet sends zkClauses; an edit without the field keeps the stored ones
  const zkClauses = input.zkClauses === undefined ? existing?.zkClauses : validClauses(input.zkClauses);
  await db.putOffer({
    id: existing?.id ?? newId("of"),
    clinicId,
    procedureId: input.procedureId,
    title,
    amount: { value: amount.value, unit: amount.unit },
    priceKrw: input.priceKrw,
    regularPriceKrw: input.regularPriceKrw,
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    conditions,
    active: input.active !== false,
    ...(zkClauses?.length ? { zkClauses } : {}),
  });
  return getMenu(clinicId);
}

export async function deleteOffer(clinicId: string, offerId: string): Promise<MenuData> {
  const db = clinicStore();
  await loadClinic(clinicId, db);
  const offer = await db.offer(offerId);
  if (!offer || offer.clinicId !== clinicId) throw new ConsoleError(`offer ${offerId} not found`, 404);
  await db.removeOffer(offerId);
  return getMenu(clinicId);
}

// ---- agent card ----

/**
 * The card other agents see. Reads the public A2A route first (what callers really get); when that route is not
 * reachable (A2A core not merged yet, or no server URL), builds the same card in process.
 */
export async function getAgentView(clinicId: string, baseUrl: string = publicBaseUrl()): Promise<AgentView> {
  const db = clinicStore();
  const profile = await loadClinic(clinicId, db);
  const operation = await operationOf(profile, db);
  const base = baseUrl.replace(/\/$/, "");
  const cardUrl = `${base}/a2a/clinics/${profile.slug}/agent-card.json`;

  let card: Record<string, unknown> | null = null;
  try {
    const response = await fetch(cardUrl, { cache: "no-store", signal: AbortSignal.timeout(1500) });
    if (response.ok && (response.headers.get("content-type") ?? "").includes("json")) {
      const json = (await response.json()) as Record<string, unknown>;
      if (typeof json.name === "string" && Array.isArray(json.skills)) card = json;
    }
  } catch {
    card = null;
  }
  const source = card ? "a2a" : "direct";
  card ??= buildClinicCard({ profile, operation, slotPolicy: await db.slotPolicy(clinicId), pathSegment: profile.slug, baseUrl: base });
  const interfaces = (card.supportedInterfaces as { url: string }[] | undefined) ?? [];

  return {
    card: card as AgentView["card"],
    source,
    cardUrl,
    endpoint: interfaces[0]?.url ?? `${base}/a2a/clinics/${profile.slug}/rpc`,
    operation: {
      mode: operation.mode,
      dataSources: operation.dataSources,
      lastVerifiedAt: operation.lastVerifiedAt,
      foreignPatientFacilityRegistered: operation.foreignPatientFacilityRegistered,
    },
    today: clock.today(),
  };
}
