// Platform skill handlers: store adapters around the pure modules (07). The A2A core has already
// validated `data` with parsePibuData and verified the caller from the bearer token.
import { clock } from "../../clock";
import { issueReferralToken, verifyReferralTokenForAttribution } from "../../a2a/auth";
import { absoluteUrl } from "../../a2a/cards";
import type { SkillHandler, SkillResult } from "../../a2a/contract";
import {
  ClinicShortlistV1Schema,
  FairnessVerdictListV1Schema,
  type BookingV1,
  type ClinicShortlistV1,
  type JudgeRequestV1,
  type OutcomeV1,
  type ProcedureRequestV1,
  type SignalReportV1,
} from "../../a2a/schemas";
import { newId } from "../../a2a/tasks";
import type { AttributionEntry, JudgedQuote, MatchLog, Outcome, Signal } from "../../domain";
import { checkEligibility } from "./eligibility";
import { judgeQuote, normalizeQuote } from "./fairness";
import { displayStats, matchClinics, type MatchClinicInput } from "./matching";
import { refreshOfferCache } from "./offers";
import { checkOutcomeCaller, priceRecordFromOutcome, quoteGapRatio, signalsForOutcome } from "./outcomes";
import { platformStore } from "./store";

const rejected = (text: string): SkillResult => ({ state: "TASK_STATE_REJECTED", text });

// ---- platform.match_clinics ----

export const matchClinicsSkill: SkillHandler = async (data, ctx) => {
  const request = data as unknown as ProcedureRequestV1;
  const eligibility = checkEligibility(request.visitorProfile);
  if (!eligibility.eligible) return rejected(`${eligibility.reason}: ${eligibility.detail}`);
  if (request.customerAgentId !== ctx.caller.agentId) return rejected("customerAgentId does not match the calling agent");

  const registry = await platformStore.registry();
  const verified = registry.filter((r) => r.verificationStatus === "verified" && r.foreignPatientFacilityRegistered);
  const { cache } = await refreshOfferCache({ entries: verified });
  const [outcomes, signals, matchLogs, records, rules, visits, reviews] = await Promise.all([
    platformStore.outcomes(),
    platformStore.signals(),
    platformStore.matchLogs(),
    platformStore.priceRecords(),
    platformStore.rules(),
    platformStore.verifiedVisits(),
    platformStore.reviewStats(),
  ]);

  const clinics: MatchClinicInput[] = registry.map((entry) => ({
    registry: entry,
    offers: cache.get(entry.id)?.offers,
    outcomes: outcomes.filter((o) => o.clinicId === entry.id),
    timeouts: signals.filter((s) => s.clinicId === entry.id && s.kind === "response_timeout").length,
    quoteRequests: matchLogs.filter((m) => m.result.candidates.some((c) => c.clinicId === entry.id)).length,
  }));

  const nowIso = clock.nowIso();
  const result = matchClinics({ request, clinics, records, rules, today: clock.today(), nowIso });
  const matchId = newId("mt");
  const byId = new Map(registry.map((r) => [r.id, r]));

  const candidates: ClinicShortlistV1["candidates"] = [];
  for (const c of result.candidates) {
    const { token } = await issueReferralToken({
      clinicId: c.clinicId,
      customerAgentId: request.customerAgentId,
      requestId: request.requestId,
      matchId,
    });
    candidates.push({
      clinicId: c.clinicId,
      agentCardUrl: absoluteUrl(byId.get(c.clinicId)!.agentCardUrl),
      score: c.score,
      reasons: c.reasons,
      referralToken: token,
      // Display only, never scored (07 "검증 방문과 후기 집계").
      ...displayStats(c.clinicId, request.procedureId, visits, reviews),
    });
  }

  const shortlist = ClinicShortlistV1Schema.parse({
    schema: "pibu/clinic-shortlist@1",
    requestId: request.requestId,
    matchId,
    appliedRuleIds: result.appliedRuleIds,
    priceReference: result.priceReference,
    candidates,
  });

  const log: MatchLog = {
    id: matchId,
    requestId: request.requestId,
    customerAgentId: request.customerAgentId,
    request,
    candidatesBeforeRules: result.candidatesBeforeRules,
    appliedRuleIds: result.appliedRuleIds,
    result: shortlist,
    at: nowIso,
  };
  await platformStore.putMatchLog(log);
  for (const rule of rules.filter((r) => result.appliedRuleIds.includes(r.id))) {
    await platformStore.putRule({ ...rule, appliedCount: rule.appliedCount + 1 });
  }
  return { state: "TASK_STATE_COMPLETED", data: shortlist };
};

// ---- platform.judge_quote ----

export const judgeQuoteSkill: SkillHandler = async (data, ctx) => {
  const request = data as unknown as JudgeRequestV1;
  const match = await platformStore.matchLog(request.matchId);
  if (match && match.customerAgentId !== ctx.caller.agentId) return rejected("this match belongs to another customer");

  const [registry, records, outcomes] = await Promise.all([platformStore.registry(), platformStore.priceRecords(), platformStore.outcomes()]);
  const today = clock.today();
  const at = clock.nowIso();
  const verdicts = [];
  for (const quote of request.quotes) {
    const entry = registry.find((r) => r.id === quote.clinicId);
    const { verdict } = judgeQuote({
      quote,
      records,
      clinic: { area: entry?.area, operationMode: entry?.operationMode, outcomes: outcomes.filter((o) => o.clinicId === quote.clinicId) },
      today,
    });
    verdicts.push(verdict);
    const judged: JudgedQuote = {
      id: `jq_${request.matchId}_${quote.quoteId}`,
      quoteId: quote.quoteId,
      matchId: request.matchId,
      clinicId: quote.clinicId,
      quote,
      verdict,
      at,
    };
    await platformStore.putJudgedQuote(judged);
  }
  const list = FairnessVerdictListV1Schema.parse({ schema: "pibu/fairness-verdict-list@1", requestId: request.requestId, verdicts });
  return { state: "TASK_STATE_COMPLETED", data: list };
};

// ---- platform.report_booking ----

export const reportBookingSkill: SkillHandler = async (data, ctx) => {
  const booking = data as unknown as BookingV1;
  if (ctx.caller.role !== "clinic" || ctx.caller.agentId !== booking.clinicId) {
    return rejected("bookings are reported only by the clinic that holds them");
  }
  const claims = await verifyReferralTokenForAttribution(booking.referralToken, booking.clinicId);
  if (!claims) return rejected("referral token is invalid or was issued for another clinic");
  if (claims.customerAgentId !== booking.customerAgentId) return rejected("referral token was issued for another customer");

  const match = await platformStore.matchLog(claims.matchId);
  const entry: AttributionEntry = {
    id: `att_${booking.bookingId}`,
    bookingId: booking.bookingId,
    clinicId: booking.clinicId,
    customerAgentId: booking.customerAgentId,
    matchId: claims.matchId,
    referralTokenJti: claims.jti,
    status: booking.status,
    priceKrw: booking.priceKrw,
    ...(match ? { nationality: match.request.visitorProfile.nationality } : {}),
    reportedAt: clock.nowIso(),
  };
  await platformStore.putAttribution(entry);
  return { state: "TASK_STATE_COMPLETED", text: `Booking ${booking.bookingId} recorded (${booking.status}).` };
};

// ---- platform.submit_outcome ----

export const submitOutcomeSkill: SkillHandler = async (data, ctx) => {
  const submitted = data as unknown as OutcomeV1;
  const attribution = await platformStore.attribution(submitted.bookingId);
  const check = checkOutcomeCaller(ctx.caller, attribution, submitted);
  if (!check.ok) return rejected(check.reason);

  const now = clock.nowIso();
  const all = await platformStore.outcomes();
  const previous = all.find((o) => o.bookingId === submitted.bookingId && o.checkpoint === submitted.checkpoint);
  if (previous) {
    await platformStore.putOutcomeHistory({ id: newId(`oh_${previous.id}`), outcome: previous, replacedAt: now });
  }

  const judged = (await platformStore.judgedQuotes())
    .filter((j) => j.matchId === attribution!.matchId && j.clinicId === attribution!.clinicId)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const quotedKrw = judged ? normalizeQuote(judged.quote).totalKrw : attribution!.priceKrw;
  const outcome: Outcome = {
    ...submitted,
    id: previous?.id ?? submitted.outcomeId,
    receivedAt: now,
    ...(quotedKrw > 0 ? { quotedKrw, quoteGapRatio: quoteGapRatio(submitted.paidKrw, quotedKrw) } : {}),
  };
  await platformStore.putOutcome(outcome);

  const entry = await platformStore.registryEntry(submitted.clinicId);
  await platformStore.putPriceRecord(priceRecordFromOutcome(submitted, entry?.area ?? "other"));

  for (const draft of signalsForOutcome(outcome, now)) {
    const signal: Signal = { id: `sig_${outcome.id}_${draft.kind}`, ...draft };
    await platformStore.putSignal(signal);
  }
  return { state: "TASK_STATE_COMPLETED", text: `Outcome ${outcome.id} recorded${previous ? " (replaced the previous submission)" : ""}.` };
};

// ---- platform.report_signal ----

export const reportSignalSkill: SkillHandler = async (data, ctx) => {
  const report = data as unknown as SignalReportV1;
  if (ctx.caller.role !== "customer") return rejected("signals are reported by customer agents");
  const signal: Signal = {
    id: newId("sig"),
    clinicId: report.clinicId,
    kind: report.kind,
    value: 1,
    context: { ...(report.taskId ? { taskId: report.taskId } : {}) },
    at: report.at,
  };
  await platformStore.putSignal(signal);
  return { state: "TASK_STATE_COMPLETED", text: `Signal ${report.kind} for ${report.clinicId} recorded.` };
};
