// Clinic matching for platform.match_clinics (07 2절). Deterministic, no LLM, no payment input of any kind.
// Region is location information, not a condition (owner decision 2026-10-24, BUILD-LOG 12): requested areas
// never filter or score a clinic, they only pick the price reference region and the "near where you stay" reason.
// Pure: the skill adapter (./skills.ts) supplies the registry, the offer cache and the platform data.
import type { ClinicShortlistV1, OffersV1, ProcedureRequestV1 } from "../../a2a/schemas";
import type { Area, ClinicRegistryEntry, IsoDate, Locale, Outcome, PriceRecord, RoutingRule, VerifiedVisitStat } from "../../domain";
import { buildSample, normalizeQuote, procedureUnit, type PriceSample } from "./fairness";
import { regionGroupOf } from "./regions";
import { applicableRules } from "./rules";
import { clamp, mean, roundTo } from "./stats";

export const WEIGHTS = { fit: 0.35, price: 0.25, outcome: 0.25, reliability: 0.15 } as const;
export const MAX_CANDIDATES = 3;
export const BUDGET_PENALTY = 0.1;
/** Review aggregates below this anonymity set are left out of the shortlist (07 "검증 방문과 후기 집계", 08). */
export const MIN_ANON_SET = 3;
const PRIOR_N = 5;
const PRIOR_MEAN = 4.0;

export interface MatchClinicInput {
  registry: ClinicRegistryEntry;
  /** Cached clinic.offers response (menu and this month's events). Missing means the clinic fails filter 2. */
  offers?: OffersV1;
  /** All platform outcomes of this clinic. */
  outcomes: readonly Outcome[];
  /** response_timeout signals for this clinic. */
  timeouts: number;
  /** How often the clinic was asked for a quote (appearances in past shortlists), the timeout ratio's base. */
  quoteRequests: number;
}

export type HardFilterResult = { ok: true } | { ok: false; reason: "not_verified" | "procedure_not_offered" | "language" };

type OfferItem = OffersV1["items"][number];

export function procedureItems(offers: OffersV1 | undefined, procedureId: string): OfferItem[] {
  return (offers?.items ?? []).filter((i) => i.procedureId === procedureId);
}

/** Best language support for the request: staff 1.0, interpreter 0.6, none 0. Korean requests are always served. */
export function languageSupport(registry: ClinicRegistryEntry, languages: readonly Locale[]): { score: number; locale?: Locale; mode?: "staff" | "interpreter" } {
  let best: { score: number; locale?: Locale; mode?: "staff" | "interpreter" } = { score: 0 };
  for (const locale of languages) {
    if (locale === "ko") {
      if (best.score < 1) best = { score: 1, locale, mode: "staff" };
      continue;
    }
    const support = registry.languages.find((l) => l.locale === locale);
    if (support?.mode === "staff" && best.score < 1) best = { score: 1, locale, mode: "staff" };
    if (support?.mode === "interpreter" && best.score < 0.6) best = { score: 0.6, locale, mode: "interpreter" };
  }
  return best;
}

/** 07 hard filters 1 to 3, in order. One failure removes the clinic. Requested areas are not a filter. */
export function hardFilter(request: ProcedureRequestV1, clinic: MatchClinicInput): HardFilterResult {
  const r = clinic.registry;
  if (r.verificationStatus !== "verified" || !r.foreignPatientFacilityRegistered) return { ok: false, reason: "not_verified" };
  if (procedureItems(clinic.offers, request.procedureId).length === 0) return { ok: false, reason: "procedure_not_offered" };
  if (languageSupport(r, request.languages).score === 0) return { ok: false, reason: "language" };
  return { ok: true };
}

type NamedArea = Exclude<Area, "other">;

/** The clinic's area when it is one of the requested areas: location information for the reasons, never scored. */
export function nearStayArea(request: ProcedureRequestV1, registry: ClinicRegistryEntry): NamedArea | undefined {
  const area = registry.area;
  return area !== "other" && (request.areas ?? []).includes(area) ? area : undefined;
}

/** Menu item closest to the requested amount; a tie goes to the larger amount (07, same rule as clinic.quote). */
export function nearestItem(items: readonly OfferItem[], amount: number): OfferItem | undefined {
  return [...items].sort((a, b) => Math.abs(a.amount.value - amount) - Math.abs(b.amount.value - amount) || b.amount.value - a.amount.value)[0];
}

export interface ScoredClinic {
  clinicId: string;
  /** Rounded to 4 decimals, clamped to 0..1. */
  score: number;
  factors: { fit: number; price: number; outcome: number; reliability: number };
  overBudget: boolean;
  language: { locale?: Locale; mode?: "staff" | "interpreter" };
  nearStayArea?: NamedArea;
  outcomeCount: number;
  gapCount: number;
  avgSatisfaction?: number;
}

export function scoreClinic(request: ProcedureRequestV1, clinic: MatchClinicInput, sample: Pick<PriceSample, "n" | "p25" | "p75" | "typicalAmount">): ScoredClinic {
  // Fit is the language score alone (07 점수표): staff 1.0, interpreter 0.6.
  const lang = languageSupport(clinic.registry, request.languages);
  const fit = lang.score;
  const near = nearStayArea(request, clinic.registry);

  const items = procedureItems(clinic.offers, request.procedureId);
  const item = nearestItem(items, request.amount.value);
  let price = 0.5;
  let overBudget = false;
  if (item) {
    const { unitKrw, totalKrw } = normalizeQuote(item);
    if (sample.n >= 5 && sample.p75 > sample.p25) price = clamp((sample.p75 - unitKrw) / (sample.p75 - sample.p25), 0, 1);
    if (Number.isFinite(sample.typicalAmount.min) && items.every((i) => i.amount.value < sample.typicalAmount.min)) {
      price = Math.min(price, 0.3);
    }
    if (request.budgetKrw && totalKrw > request.budgetKrw.max * 1.1) overBudget = true;
  }

  const satisfactions = clinic.outcomes.map((o) => o.satisfaction);
  const bayes = (PRIOR_N * PRIOR_MEAN + satisfactions.reduce((s, x) => s + x, 0)) / (PRIOR_N + satisfactions.length);
  const outcome = (bayes - 1) / 4;

  const gaps = clinic.outcomes.filter((o) => typeof o.quoteGapRatio === "number").map((o) => o.quoteGapRatio as number);
  const avgGap = gaps.length ? Math.max(0, mean(gaps)) : 0;
  const timeoutRatio = clinic.quoteRequests > 0 ? Math.min(1, clinic.timeouts / clinic.quoteRequests) : 0;
  const reliability = (1 - Math.min(1, avgGap * 2)) * (1 - timeoutRatio);

  const raw =
    WEIGHTS.fit * fit + WEIGHTS.price * price + WEIGHTS.outcome * outcome + WEIGHTS.reliability * reliability - (overBudget ? BUDGET_PENALTY : 0);
  return {
    clinicId: clinic.registry.id,
    score: roundTo(clamp(raw, 0, 1), 4),
    factors: { fit, price, outcome, reliability },
    overBudget,
    language: { locale: lang.locale, mode: lang.mode },
    ...(near ? { nearStayArea: near } : {}),
    outcomeCount: satisfactions.length,
    gapCount: gaps.length,
    ...(satisfactions.length ? { avgSatisfaction: mean(satisfactions) } : {}),
  };
}

// ---- reasons (templates, rule contents are never exposed) ----

const LANGUAGE_NAME: Record<Locale, string> = { ja: "Japanese", "zh-CN": "Chinese", en: "English", ko: "Korean" };
const AREA_NAME: Record<NamedArea, string> = { gangnam: "Gangnam", sinsa: "Sinsa", apgujeong: "Apgujeong", myeongdong: "Myeongdong", hongdae: "Hongdae" };

function factorReason(factor: keyof ScoredClinic["factors"], s: ScoredClinic): string | undefined {
  switch (factor) {
    case "fit":
      if (!s.language.locale) return undefined;
      if (s.language.mode === "interpreter") return `${LANGUAGE_NAME[s.language.locale]} interpreter available`;
      return `${LANGUAGE_NAME[s.language.locale]}-speaking staff on site`;
    case "price":
      return "Menu price within the range of recent paid records";
    case "outcome":
      return s.outcomeCount > 0 ? `Satisfaction ${roundTo(s.avgSatisfaction ?? 0, 1)} of 5 in ${s.outcomeCount} past outcomes` : "No past outcomes yet";
    case "reliability":
      return s.gapCount > 0 ? `Paid prices close to quotes in ${s.gapCount} past outcomes` : "No price or response issues reported";
  }
}

/** Top two contributing factors, then rule, budget and location sentences (07 2절 4). */
export function reasonsFor(s: ScoredClinic, ruleReasons: readonly string[]): string[] {
  const top = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[])
    .map((f) => ({ f, contribution: WEIGHTS[f] * s.factors[f] }))
    .sort((a, b) => b.contribution - a.contribution || a.f.localeCompare(b.f))
    .map(({ f }) => factorReason(f, s))
    .filter((r): r is string => r !== undefined)
    .slice(0, 2);
  const out = [...top, ...ruleReasons];
  if (s.overBudget) out.push("May exceed your budget");
  if (s.nearStayArea) out.push(`Near where you stay (${AREA_NAME[s.nearStayArea]})`);
  return out;
}

// ---- display stats (ZK extension, never scored) ----

type ShortlistCandidate = ClinicShortlistV1["candidates"][number];

/**
 * verifiedVisits and reviewStats for one shortlist candidate (07 "검증 방문과 후기 집계"). Display context only:
 * neither enters the score. reviewStats is left out below the anonymity set.
 */
export function displayStats(
  clinicId: string,
  procedureId: string,
  visits: readonly VerifiedVisitStat[],
  reviews: readonly { clinicId: string; procedureId: string; n: number; avgRating: number }[],
): Pick<ShortlistCandidate, "verifiedVisits" | "reviewStats"> {
  const visit = visits.find((v) => v.clinicId === clinicId && v.procedureId === procedureId);
  const review = reviews.find((r) => r.clinicId === clinicId && r.procedureId === procedureId);
  return {
    ...(visit ? { verifiedVisits: visit.count } : {}),
    ...(review && review.n >= MIN_ANON_SET ? { reviewStats: { n: review.n, avgRating: review.avgRating } } : {}),
  };
}

// ---- the whole match ----

export interface RankedCandidate {
  clinicId: string;
  score: number;
  reasons: string[];
}

export interface MatchResult {
  candidatesBeforeRules: { clinicId: string; score: number }[];
  candidates: RankedCandidate[];
  appliedRuleIds: string[];
  /** For pibu/clinic-shortlist@1 priceReference. */
  priceReference: { procedureId: string; unit: string; region: string; p25UnitKrw: number; p50UnitKrw: number; p75UnitKrw: number; sampleSize: number; windowDays: number };
  filtered: { clinicId: string; reason: string }[];
}

const byScore = (a: { clinicId: string; score: number }, b: { clinicId: string; score: number }) =>
  b.score - a.score || a.clinicId.localeCompare(b.clinicId);

export function matchClinics(input: {
  request: ProcedureRequestV1;
  clinics: readonly MatchClinicInput[];
  records: readonly PriceRecord[];
  rules: readonly RoutingRule[];
  today: IsoDate;
  nowIso: string;
}): MatchResult {
  const { request } = input;
  const unit = procedureUnit(request.procedureId, request.amount.unit);
  const filtered: MatchResult["filtered"] = [];
  const passed: MatchClinicInput[] = [];
  for (const clinic of input.clinics) {
    const result = hardFilter(request, clinic);
    if (result.ok) passed.push(clinic);
    else filtered.push({ clinicId: clinic.registry.id, reason: result.reason });
  }

  const sampleCache = new Map<string, PriceSample>();
  const sampleFor = (area: ClinicRegistryEntry["area"] | undefined) => {
    const key = area ? regionGroupOf(area) : "seoul";
    if (!sampleCache.has(key)) sampleCache.set(key, buildSample(input.records, { procedureId: request.procedureId, area, today: input.today }, unit));
    return sampleCache.get(key)!;
  };

  const scored = passed.map((clinic) => scoreClinic(request, clinic, sampleFor(clinic.registry.area)));
  const candidatesBeforeRules = scored.map((s) => ({ clinicId: s.clinicId, score: s.score })).sort(byScore);

  // Rules: require_language -> exclude_clinic -> boost / demote / prefer_area, clamped to 0..1.
  const rules = applicableRules(input.rules, request, input.nowIso);
  let pool = scored.map((s) => ({ ...s, ruleReasons: [] as string[] }));
  const registryById = new Map(input.clinics.map((c) => [c.registry.id, c.registry]));
  for (const rule of rules) {
    const action = rule.then;
    switch (action.kind) {
      case "require_language":
        pool = pool.filter((c) => languageSupport(registryById.get(c.clinicId)!, action.languages).score > 0);
        break;
      case "exclude_clinic":
        pool = pool.filter((c) => !action.clinicIds.includes(c.clinicId));
        break;
      case "boost_clinic":
        for (const c of pool) {
          if (!action.clinicIds.includes(c.clinicId)) continue;
          c.score = roundTo(clamp(c.score + action.delta, 0, 1), 4);
          c.ruleReasons.push("Visitors with similar requests were satisfied here");
        }
        break;
      case "demote_clinic":
        for (const c of pool) if (action.clinicIds.includes(c.clinicId)) c.score = roundTo(clamp(c.score - action.delta, 0, 1), 4);
        break;
      case "prefer_area":
        for (const c of pool) {
          if (!action.areas.includes(registryById.get(c.clinicId)!.area)) continue;
          c.score = roundTo(clamp(c.score + action.delta, 0, 1), 4);
          c.ruleReasons.push("In an area visitors like you preferred");
        }
        break;
    }
  }

  const candidates = pool
    .sort(byScore)
    .slice(0, MAX_CANDIDATES)
    .map((c) => ({ clinicId: c.clinicId, score: roundTo(c.score, 2), reasons: reasonsFor(c, c.ruleReasons) }));

  const firstArea = request.areas?.[0];
  const ref = sampleFor(firstArea);
  const safe = (x: number) => (Number.isFinite(x) ? Math.round(x) : 0);
  return {
    candidatesBeforeRules,
    candidates,
    appliedRuleIds: rules.map((r) => r.id),
    priceReference: {
      procedureId: request.procedureId,
      unit,
      region: ref.region,
      p25UnitKrw: safe(ref.p25),
      p50UnitKrw: safe(ref.p50),
      p75UnitKrw: safe(ref.p75),
      sampleSize: ref.n,
      windowDays: 120,
    },
    filtered: filtered.sort((a, b) => a.clinicId.localeCompare(b.clinicId)),
  };
}
