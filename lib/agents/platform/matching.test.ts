import { describe, expect, it } from "vitest";
import clinicsSeed from "../../../data/seed/clinics.json";
import outcomesSeed from "../../../data/seed/outcomes.json";
import recordsSeed from "../../../data/seed/price-records.json";
import rulesSeed from "../../../data/seed/rules.json";
import verifiedVisitsSeed from "../../../data/seed/verified-visits.json";
import type { OffersV1, ProcedureRequestV1 } from "../../a2a/schemas";
import type { ClinicRegistryEntry, Outcome, PriceRecord, RoutingRule, VerifiedVisitStat } from "../../domain";
import { checkEligibility } from "./eligibility";
import { displayStats, hardFilter, MAX_CANDIDATES, matchClinics, nearestItem, scoreClinic, type MatchClinicInput } from "./matching";
import { applicableRules, ruleMatches } from "./rules";

const records = recordsSeed as unknown as PriceRecord[];
const outcomes = outcomesSeed as unknown as Outcome[];
const seedRules = rulesSeed as unknown as RoutingRule[];
const NOW = "2026-10-24T10:00:00+09:00";
const TODAY = "2026-10-24";

/** What a clinic.offers answer looks like for a seed clinic (menu + events valid today). */
function seedInputs(): MatchClinicInput[] {
  return (clinicsSeed as unknown as Array<{ registry: ClinicRegistryEntry; menu: Array<Record<string, unknown>>; offers: Array<Record<string, unknown>> }>).map(
    (c) => ({
      registry: c.registry,
      offers: {
        schema: "pibu/offers@1",
        clinicId: c.registry.id,
        month: "2026-10",
        items: [
          ...c.menu.map((m) => ({ procedureId: m.procedureId, product: m.product, amount: m.amount, priceKrw: m.priceKrw, vatIncluded: m.vatIncluded })),
          ...c.offers.map((o) => ({
            procedureId: o.procedureId,
            product: o.title,
            amount: o.amount,
            priceKrw: o.priceKrw,
            vatIncluded: true,
            event: { title: o.title, regularPriceKrw: o.regularPriceKrw, validFrom: o.validFrom, validUntil: o.validUntil, conditions: o.conditions },
          })),
        ],
      } as OffersV1,
      outcomes: outcomes.filter((o) => o.clinicId === c.registry.id),
      timeouts: 0,
      quoteRequests: 0,
    }),
  );
}

const yuki: ProcedureRequestV1 = {
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

const run = (request: ProcedureRequestV1, clinics = seedInputs(), rules: RoutingRule[] = seedRules) =>
  matchClinics({ request, clinics, records, rules, today: TODAY, nowIso: NOW });

const rule = (id: string, then: RoutingRule["then"], when: RoutingRule["when"] = {}): RoutingRule => ({
  id,
  version: 1,
  status: "active",
  when,
  then,
  reason: "test",
  evidence: { outcomeIds: [], signalIds: [], summary: "test" },
  source: "operator",
  createdAt: NOW,
  appliedCount: 0,
});

describe("Yuki's rejuran request (seed)", () => {
  it("returns Seoul Glow, Mint and Ara with no applied rules", () => {
    const result = run(yuki);
    expect(result.candidates.map((c) => c.clinicId)).toEqual(["cln_seoul_glow", "cln_mint", "cln_ara"]);
    expect(result.appliedRuleIds).toEqual([]);
    // Region is location information: Hanbit (Chinese) and Dahye (Japanese by app translation only) drop on language.
    expect(result.filtered).toEqual([
      { clinicId: "cln_dahye", reason: "language" },
      { clinicId: "cln_hanbit", reason: "language" },
    ]);
    expect(result.priceReference).toMatchObject({ region: "gangnam_sinsa", p25UnitKrw: 140000, p50UnitKrw: 160000, p75UnitKrw: 185000, sampleSize: 42, windowDays: 120, unit: "cc" });
    for (const c of result.candidates) {
      expect(c.score).toBeGreaterThan(0);
      expect(c.score).toBeLessThanOrEqual(1);
      expect(c.reasons.length).toBeGreaterThanOrEqual(2);
    }
    expect(result.candidates[0].reasons).toContain("Japanese-speaking staff on site");
    expect(result.candidates[1].reasons).toContain("Japanese interpreter available");
    expect(result.candidates.map((c) => c.reasons.at(-1))).toEqual([
      "Near where you stay (Sinsa)",
      "Near where you stay (Gangnam)",
      "Near where you stay (Apgujeong)",
    ]);
  });

  it("is deterministic: same input, same output", () => {
    expect(run(yuki)).toEqual(run(yuki));
    expect(run(yuki, seedInputs().reverse())).toEqual(run(yuki));
  });

  it("caps Mint's price factor at 0.3 because it only sells 1cc (below the typical 2cc)", () => {
    const mint = seedInputs().find((c) => c.registry.id === "cln_mint")!;
    const s = scoreClinic(yuki, mint, { n: 42, p25: 140000, p75: 185000, typicalAmount: { min: 2, max: 3, unit: "cc" } });
    expect(s.factors.price).toBe(0.3);
  });
});

describe("hard filters", () => {
  const glow = () => seedInputs().find((c) => c.registry.id === "cln_seoul_glow")!;

  it("drops unverified, unregistered, procedure-less and language-less clinics", () => {
    expect(hardFilter(yuki, glow())).toEqual({ ok: true });
    expect(hardFilter(yuki, { ...glow(), registry: { ...glow().registry, verificationStatus: "suspended" } })).toEqual({ ok: false, reason: "not_verified" });
    expect(hardFilter(yuki, { ...glow(), registry: { ...glow().registry, foreignPatientFacilityRegistered: false } })).toEqual({ ok: false, reason: "not_verified" });
    expect(hardFilter({ ...yuki, procedureId: "ulthera" }, glow())).toEqual({ ok: false, reason: "procedure_not_offered" });
    expect(hardFilter(yuki, { ...glow(), offers: undefined })).toEqual({ ok: false, reason: "procedure_not_offered" });
    expect(hardFilter({ ...yuki, languages: ["zh-CN"] }, glow())).toEqual({ ok: false, reason: "language" });
  });

  it("app_translation alone fails the language filter unless the request is Korean", () => {
    const dahye = seedInputs().find((c) => c.registry.id === "cln_dahye")!;
    expect(hardFilter({ ...yuki, areas: [] }, dahye)).toEqual({ ok: false, reason: "language" });
    expect(hardFilter({ ...yuki, areas: [], languages: ["ko"] }, dahye)).toEqual({ ok: true });
  });

  it("never excludes on area: requested areas are location information, not a condition", () => {
    expect(hardFilter({ ...yuki, areas: ["hongdae"] }, glow())).toEqual({ ok: true });
    expect(hardFilter({ ...yuki, areas: ["myeongdong"] }, glow())).toEqual({ ok: true });
    const hongdae = run({ ...yuki, areas: ["hongdae"] }, seedInputs(), []);
    expect(hongdae.candidates.map((c) => c.clinicId)).toEqual(["cln_seoul_glow", "cln_mint", "cln_ara"]);
    expect(hongdae.filtered.map((f) => f.reason)).toEqual(["language", "language"]);
    for (const c of hongdae.candidates) expect(c.reasons.join(" ")).not.toMatch(/Near where you stay/);
  });
});

describe("scores", () => {
  const clinic = (id: string) => seedInputs().find((c) => c.registry.id === id)!;
  const sample = { n: 42, p25: 140000, p75: 185000, typicalAmount: { min: 2, max: 3, unit: "cc" as const } };

  it("fit is the language score only: staff 1.0, interpreter 0.6, whatever the requested areas", () => {
    expect(scoreClinic(yuki, clinic("cln_seoul_glow"), sample).factors.fit).toBe(1);
    expect(scoreClinic(yuki, clinic("cln_mint"), sample).factors.fit).toBe(0.6);
    expect(scoreClinic(yuki, clinic("cln_ara"), sample).factors.fit).toBe(0.6);
    for (const id of ["cln_seoul_glow", "cln_mint", "cln_ara"]) {
      const near = scoreClinic(yuki, clinic(id), sample);
      for (const areas of [[], ["hongdae"], ["myeongdong", "other"]] as ProcedureRequestV1["areas"][]) {
        const far = scoreClinic({ ...yuki, areas }, clinic(id), sample);
        expect(far.score).toBe(near.score);
        expect(far.factors).toEqual(near.factors);
        expect(far.nearStayArea).toBeUndefined();
      }
    }
  });

  it("keeps at most three candidates", () => {
    expect(MAX_CANDIDATES).toBe(3);
    const korean = run({ ...yuki, languages: ["ko"] }, seedInputs(), []);
    expect(korean.filtered).toEqual([]);
    expect(korean.candidatesBeforeRules).toHaveLength(5);
    expect(korean.candidates.map((c) => c.clinicId)).toEqual(["cln_seoul_glow", "cln_mint", "cln_ara"]);
  });
});

describe("ordering, rules, budget", () => {
  function twins(): MatchClinicInput[] {
    const base = seedInputs().find((c) => c.registry.id === "cln_seoul_glow")!;
    const clone = (id: string): MatchClinicInput => ({
      ...base,
      registry: { ...base.registry, id, slug: id },
      offers: { ...base.offers!, clinicId: id },
    });
    return [clone("cln_zeta"), clone("cln_alpha"), clone("cln_mid")];
  }

  it("breaks score ties by clinicId", () => {
    const result = run(yuki, twins(), []);
    expect(new Set(result.candidates.map((c) => c.score)).size).toBe(1);
    expect(result.candidates.map((c) => c.clinicId)).toEqual(["cln_alpha", "cln_mid", "cln_zeta"]);
  });

  it("applies require_language, then exclude_clinic, then adjustments, whatever the rule ids", () => {
    const rules = [
      rule("rule_a", { kind: "boost_clinic", clinicIds: ["cln_ara", "cln_mint"], delta: 0.3 }),
      rule("rule_b", { kind: "exclude_clinic", clinicIds: ["cln_mint"] }),
      rule("rule_c", { kind: "require_language", languages: ["ja"] }),
      rule("rule_d", { kind: "demote_clinic", clinicIds: ["cln_seoul_glow"], delta: 0.3 }),
    ];
    expect(applicableRules(rules, yuki, NOW).map((r) => r.id)).toEqual(["rule_c", "rule_b", "rule_a", "rule_d"]);
    const result = run(yuki, seedInputs(), rules);
    expect(result.appliedRuleIds).toEqual(["rule_c", "rule_b", "rule_a", "rule_d"]);
    expect(result.candidates.map((c) => c.clinicId)).toEqual(["cln_ara", "cln_seoul_glow"]);
    expect(result.candidates[0].reasons).toContain("Visitors with similar requests were satisfied here");
    expect(result.candidatesBeforeRules.map((c) => c.clinicId)).toEqual(["cln_seoul_glow", "cln_mint", "cln_ara"]);
    for (const c of result.candidates) expect(c.reasons.join(" ")).not.toMatch(/rule|exclude|demote/i);
  });

  it("require_language narrows to clinics with staff or interpreter for that language", () => {
    const ja = run({ ...yuki, languages: ["ja", "zh-CN"] }, seedInputs(), [rule("rule_x", { kind: "require_language", languages: ["ja"] })]);
    expect(ja.candidatesBeforeRules.map((c) => c.clinicId)).toContain("cln_hanbit");
    expect(ja.candidates.map((c) => c.clinicId)).toEqual(["cln_seoul_glow", "cln_mint", "cln_ara"]);
    // Hanbit (staff) and Dahye (interpreter) serve Chinese; Ara's app translation does not count. Neither is in
    // Yuki's areas, and that no longer matters.
    const zh = run({ ...yuki, languages: ["ja", "zh-CN"] }, seedInputs(), [rule("rule_y", { kind: "require_language", languages: ["zh-CN"] })]);
    expect(zh.candidates.map((c) => c.clinicId).sort()).toEqual(["cln_dahye", "cln_hanbit"]);
  });

  it("prefer_area lifts clinics in the area as a rule effect, never as an exclusion", () => {
    const base = run(yuki, seedInputs(), []);
    const result = run(yuki, seedInputs(), [rule("rule_area", { kind: "prefer_area", areas: ["apgujeong"], delta: 0.3 })]);
    expect(result.appliedRuleIds).toEqual(["rule_area"]);
    expect(result.candidates.map((c) => c.clinicId)).toEqual(["cln_ara", "cln_seoul_glow", "cln_mint"]);
    const score = (r: typeof base, id: string) => r.candidates.find((c) => c.clinicId === id)!.score;
    expect(score(result, "cln_ara")).toBeCloseTo(score(base, "cln_ara") + 0.3, 2);
    expect(score(result, "cln_mint")).toBe(score(base, "cln_mint"));
    expect(result.candidates[0].reasons).toContain("In an area visitors like you preferred");
    // A preferred area nobody is in changes no score and removes no clinic.
    const elsewhere = run(yuki, seedInputs(), [rule("rule_far", { kind: "prefer_area", areas: ["hongdae"], delta: 0.3 })]);
    expect(elsewhere.candidates.map((c) => [c.clinicId, c.score])).toEqual(base.candidates.map((c) => [c.clinicId, c.score]));
  });

  it("an excluded or demoted clinic stays clamped to 0..1, boosts clamp at 1", () => {
    const result = run(yuki, seedInputs(), [rule("rule_up", { kind: "boost_clinic", clinicIds: ["cln_seoul_glow"], delta: 0.3 })]);
    expect(result.candidates[0]).toMatchObject({ clinicId: "cln_seoul_glow", score: 1 });
  });

  it("subtracts 0.1 and says so when the menu total exceeds budget x 1.1", () => {
    const tight = run({ ...yuki, budgetKrw: { max: 300000 } }, seedInputs(), []);
    const normal = run(yuki, seedInputs(), []);
    const glow = (r: typeof tight) => r.candidates.find((c) => c.clinicId === "cln_seoul_glow")!;
    expect(glow(normal).score - glow(tight).score).toBeCloseTo(0.1, 2);
    expect(glow(tight).reasons).toContain("May exceed your budget");
    expect(glow(normal).reasons).not.toContain("May exceed your budget");
  });

  it("seed rules match CN and ulthera requests only", () => {
    expect(seedRules.map((r) => ruleMatches(r.when, yuki))).toEqual([false, false]);
    expect(ruleMatches(seedRules[0].when, { ...yuki, visitorProfile: { ...yuki.visitorProfile, nationality: "CN" } })).toBe(true);
    expect(ruleMatches(seedRules[1].when, { ...yuki, procedureId: "ulthera" })).toBe(true);
  });

  it("ignores inactive and expired rules", () => {
    const expired = { ...rule("rule_old", { kind: "exclude_clinic", clinicIds: ["cln_ara"] }), expiresAt: "2026-10-01T00:00:00+09:00" };
    const proposed = { ...rule("rule_new", { kind: "exclude_clinic", clinicIds: ["cln_ara"] }), status: "proposed" as const };
    expect(run(yuki, seedInputs(), [expired, proposed]).appliedRuleIds).toEqual([]);
  });

  it("picks the menu item nearest the requested amount, larger on ties", () => {
    const item = (value: number) => ({ procedureId: "rejuran_healer", product: "x", amount: { value, unit: "cc" as const }, priceKrw: 1, vatIncluded: true });
    expect(nearestItem([item(1), item(3)], 2)?.amount.value).toBe(3);
    expect(nearestItem([item(1), item(2), item(4)], 2)?.amount.value).toBe(2);
  });
});

describe("display stats (verifiedVisits, reviewStats)", () => {
  const visits = verifiedVisitsSeed.verifiedVisits as VerifiedVisitStat[];
  const reviews = verifiedVisitsSeed.reviewStats;
  const review = (clinicId: string, n: number, avgRating = 4.2) => ({ clinicId, procedureId: "rejuran_healer", n, avgRating });

  it("counts verified visits for the same clinic and procedure, and passes reviewStats at n >= 3", () => {
    expect(displayStats("cln_seoul_glow", "rejuran_healer", visits, reviews)).toEqual({ verifiedVisits: 1240, reviewStats: { n: 18, avgRating: 4.6 } });
    expect(displayStats("cln_mint", "rejuran_healer", visits, reviews)).toEqual({ verifiedVisits: 980, reviewStats: { n: 6, avgRating: 3.5 } });
    expect(displayStats("cln_ara", "rejuran_healer", visits, reviews)).toEqual({ verifiedVisits: 640, reviewStats: { n: 5, avgRating: 3 } });
    expect(displayStats("cln_seoul_glow", "botox_forehead", visits, reviews)).toEqual({ verifiedVisits: 310 });
    expect(displayStats("cln_ara", "botox_forehead", visits, reviews)).toEqual({});
  });

  it("omits reviewStats below the anonymity set of 3", () => {
    expect(displayStats("cln_x", "rejuran_healer", [], [review("cln_x", 2)])).toEqual({});
    expect(displayStats("cln_x", "rejuran_healer", [], [review("cln_x", 3)])).toEqual({ reviewStats: { n: 3, avgRating: 4.2 } });
    expect(displayStats("cln_x", "rejuran_healer", [], [review("cln_y", 9)])).toEqual({});
  });

  it("are not a matching input, so they cannot move a score", () => {
    // matchClinics takes no visit or review data at all (07: display context only).
    expect(Object.keys(run(yuki).candidates[0]).sort()).toEqual(["clinicId", "reasons", "score"]);
  });
});

describe("eligibility", () => {
  it("rejects Korean nationals and residents, accepts short-term visitors", () => {
    expect(checkEligibility({ nationality: "KR" })).toMatchObject({ eligible: false, reason: "not_eligible_foreign_patient" });
    expect(checkEligibility({ nationality: "JP", residency: "resident" })).toMatchObject({ eligible: false, reason: "not_eligible_foreign_patient" });
    expect(checkEligibility({ nationality: "JP", residency: "short_term_visitor" })).toEqual({ eligible: true });
  });
});
