import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AmountSchema, AreaSchema, EventSchema, IsoDateSchema, IsoDateTimeSchema, LocaleSchema, OutcomeV1Schema } from "../../lib/a2a/schemas";
import type { Outcome, PriceRecord, RoutingRule } from "../../lib/domain";
import { getProcedure } from "../../lib/domain/procedure-master";
import { createMemoryStore } from "../../lib/store";
import { buildSample, clinicFlagsFor } from "../../lib/agents/platform/fairness";
import { araBurstOutcomes, ensureSeeded, expandSlots, loadSeed, SEED_COLLECTIONS, seedClinics, seedCustomers } from "./load";

const dir = fileURLToPath(new URL(".", import.meta.url));

describe("loadSeed", () => {
  it("loads every collection with the expected counts", async () => {
    const store = createMemoryStore();
    const { loaded } = await loadSeed(store);
    expect(loaded).toEqual({
      "platform.clinic_registry": 5,
      "platform.price_records": 124,
      "platform.outcomes": 30,
      "platform.rules": 2,
      "platform.verified_visits": 10,
      "platform.review_stats": 5,
      "clinic.profiles": 5,
      "clinic.menu_items": 18,
      "clinic.offers": 1,
      "clinic.slot_policies": 5,
      "clinic.slots": 5 * 36 * 4,
      "customer.accounts": 6,
      "customer.profiles": 5,
      "customer.consents": 24,
      "customer.records": 13,
    });
    expect(await store.list("platform", SEED_COLLECTIONS.platform.rules, { status: "active" })).toHaveLength(2);
    expect(await store.get("clinic", "slot_policies", "cln_seoul_glow")).toMatchObject({ autoConfirm: false, foreignSlotsPerDay: 4 });
  });

  it("ensureSeeded seeds an empty store once and leaves later changes alone", async () => {
    const store = createMemoryStore();
    await Promise.all([ensureSeeded(store), ensureSeeded(store)]);
    expect(await store.list("platform", "clinic_registry")).toHaveLength(5);
    await store.remove("platform", "rules", "rule_002");
    await ensureSeeded(store);
    expect(await store.list("platform", "rules")).toHaveLength(1);
  });
});

describe("clinics.json (06 seed table)", () => {
  const byId = Object.fromEntries(seedClinics.map((c) => [c.id, c]));
  const rejuran = (id: string) => byId[id].menu.filter((m) => m.procedureId === "rejuran_healer");

  it("has the five 01 clinics with ids, slugs and areas", () => {
    expect(seedClinics.map((c) => [c.id, c.slug, c.area])).toEqual([
      ["cln_seoul_glow", "seoul-glow", "sinsa"],
      ["cln_mint", "mint", "gangnam"],
      ["cln_ara", "ara", "apgujeong"],
      ["cln_hanbit", "hanbit", "myeongdong"],
      ["cln_dahye", "dahye", "hongdae"],
    ]);
    for (const c of seedClinics) {
      expect(c.registry.id).toBe(c.id);
      expect(c.profile.id).toBe(c.id);
      expect(c.registry.languages).toEqual(c.profile.languages);
      expect(c.registry.agentCardUrl).toBe(`/a2a/clinics/${c.slug}/agent-card.json`);
      for (const l of c.registry.languages) expect(LocaleSchema.safeParse(l.locale).success).toBe(true);
      expect(AreaSchema.safeParse(c.area).success).toBe(true);
    }
  });

  it("rejuran menus match 06 exactly", () => {
    expect(rejuran("cln_seoul_glow").map((m) => [m.amount.value, m.priceKrw, m.vatIncluded])).toEqual([[2, 340000, true]]);
    expect(rejuran("cln_mint")).toEqual([]);
    expect(byId.cln_mint.offers).toEqual([
      {
        id: "ofr_mint_rejuran_first_visit",
        clinicId: "cln_mint",
        procedureId: "rejuran_healer",
        title: "First visit 1cc event",
        amount: { value: 1, unit: "cc" },
        priceKrw: 99000,
        regularPriceKrw: 150000,
        validFrom: "2026-10-01",
        validUntil: "2026-11-30",
        conditions: "First visit only",
        zkClauses: [{ clinicId: "cln_mint", maxCount: 0 }],
      },
    ]);
    expect(rejuran("cln_ara").map((m) => [m.amount.value, m.priceKrw, m.vatIncluded])).toEqual([[2, 300000, false]]);
    expect(rejuran("cln_hanbit").map((m) => [m.amount.value, m.priceKrw, m.vatIncluded])).toEqual([[2, 420000, true]]);
    expect(rejuran("cln_dahye").map((m) => [m.amount.value, m.priceKrw, m.vatIncluded])).toEqual([[2, 360000, true]]);
  });

  it("Mint's event is valid on the demo clock and through both Yuki trip variants", () => {
    const offer = byId.cln_mint.offers[0];
    for (const day of ["2026-10-24", "2026-11-08", "2026-11-12", "2026-11-15"]) expect(offer.validFrom <= day && day <= offer.validUntil).toBe(true);
    expect(EventSchema.safeParse({ title: offer.title, regularPriceKrw: offer.regularPriceKrw, validFrom: offer.validFrom, validUntil: offer.validUntil, conditions: offer.conditions }).success).toBe(true);
  });

  it("Seoul Glow (staff), Mint and Ara (interpreter) pass the Japanese filter; modes and autoConfirm per 01/06", () => {
    const ja = (id: string) => byId[id].registry.languages.find((l) => l.locale === "ja")?.mode;
    expect([ja("cln_seoul_glow"), ja("cln_mint"), ja("cln_ara")]).toEqual(["staff", "interpreter", "interpreter"]);
    expect(seedClinics.map((c) => c.registry.operationMode)).toEqual(["clinic", "proxy", "proxy", "proxy", "clinic"]);
    expect(byId.cln_seoul_glow.slotPolicy.autoConfirm).toBe(false);
    expect(seedClinics.every((c) => c.registry.verificationStatus === "verified" && c.registry.foreignPatientFacilityRegistered)).toBe(true);
  });

  it("every menu item uses a master procedure id, its unit, and valid amounts", () => {
    for (const c of seedClinics) {
      for (const m of [...c.menu, ...c.offers]) {
        const procedure = getProcedure(m.procedureId);
        expect(procedure, m.procedureId).toBeDefined();
        expect(m.amount.unit).toBe(procedure!.unit);
        expect(AmountSchema.safeParse(m.amount).success).toBe(true);
      }
    }
  });
});

describe("slots", () => {
  it("every clinic, every day 2026-10-26..11-30, at 10, 11, 14, 15 KST", () => {
    const slots = expandSlots();
    expect(slots).toHaveLength(720);
    expect(new Set(slots.map((s) => s.id)).size).toBe(720);
    const glow = slots.filter((s) => s.clinicId === "cln_seoul_glow" && s.start.startsWith("2026-11-09"));
    expect(glow.map((s) => s.start.slice(11, 16))).toEqual(["10:00", "11:00", "14:00", "15:00"]);
    expect(slots.every((s) => IsoDateTimeSchema.safeParse(s.start).success && s.start > "2026-10-24")).toBe(true);
    expect(glow[0].procedureIds).toContain("rejuran_healer");
  });
});

describe("price-records.json (07 reference sample)", () => {
  const records = JSON.parse(readFileSync(`${dir}price-records.json`, "utf8")) as PriceRecord[];
  const RecordSchema = z.strictObject({
    id: z.string().regex(/^pr_\d{4}$/),
    procedureId: z.string(),
    product: z.string().optional(),
    area: AreaSchema,
    amount: AmountSchema,
    paidKrw: z.number().int().positive(),
    normalizedUnitKrw: z.number().int().positive(),
    source: z.enum(["outcome", "shared_record", "public_offer"]),
    verified: z.boolean(),
    ageBand: z.string().optional(),
    nationalityGroup: z.enum(["KR", "foreign"]).optional(),
    clinicId: z.string().optional(),
    date: IsoDateSchema,
  });

  it("every record is well formed and unit price = paid / amount", () => {
    for (const r of records) {
      expect(RecordSchema.safeParse(r).success, r.id).toBe(true);
      expect(r.normalizedUnitKrw * r.amount.value).toBe(r.paidKrw);
      expect(getProcedure(r.procedureId)?.unit).toBe(r.amount.unit);
    }
  });

  for (const today of ["2026-10-24", "2026-11-12"]) {
    it(`gives n = 42 and the 07 quantiles at ${today}`, () => {
      const s = buildSample(records, { procedureId: "rejuran_healer", area: "gangnam", today });
      expect([s.n, s.p25, s.p50, s.p75, s.p90]).toEqual([42, 140000, 160000, 185000, 210000]);
      expect(s.typicalAmount).toMatchObject({ min: 2, max: 3 });
    });
  }

  it("verified rejuran gangnam_sinsa records in the window are exactly 42, dated 07-16..10-22", () => {
    const gs = records.filter((r) => r.procedureId === "rejuran_healer" && r.verified && r.source !== "public_offer" && ["gangnam", "sinsa", "apgujeong"].includes(r.area) && r.date >= "2026-07-16");
    expect(gs).toHaveLength(42);
    expect(gs.every((r) => r.date <= "2026-10-22")).toBe(true);
  });

  it("is what scripts/gen-price-records.mjs produces", async () => {
    const { execFileSync } = await import("node:child_process");
    expect(() => execFileSync("node", [fileURLToPath(new URL("../../scripts/gen-price-records.mjs", import.meta.url)), "--check"], { stdio: "pipe" })).not.toThrow();
    expect(() => execFileSync("node", [fileURLToPath(new URL("../../scripts/gen-outcomes.mjs", import.meta.url)), "--check"], { stdio: "pipe" })).not.toThrow();
  });
});

describe("outcomes", () => {
  const outcomes = JSON.parse(readFileSync(`${dir}outcomes.json`, "utf8")) as Outcome[];

  it("30 outcomes, each a valid pibu/outcome@1 plus the platform fields", () => {
    expect(outcomes).toHaveLength(30);
    for (const o of outcomes) {
      const { id, receivedAt, quotedKrw, quoteGapRatio, ...wire } = o;
      expect(OutcomeV1Schema.safeParse(wire).success, id).toBe(true);
      expect(id).toBe(o.outcomeId);
      expect(IsoDateTimeSchema.safeParse(receivedAt).success).toBe(true);
      expect(quoteGapRatio).toBeCloseTo((o.paidKrw - quotedKrw!) / quotedKrw!, 4);
    }
  });

  it("Ara's 4 JP outcomes average +0.15 and sit in the 90 day window but outside 30 days, for both clocks", () => {
    const ara = outcomes.filter((o) => o.clinicId === "cln_ara" && o.visitorProfile.nationality === "JP");
    expect(ara).toHaveLength(4);
    expect(ara.reduce((s, o) => s + o.quoteGapRatio!, 0) / 4).toBeCloseTo(0.15, 10);
    for (const now of ["2026-10-24T10:00:00+09:00", "2026-11-12T10:00:00+09:00"]) {
      for (const o of ara) {
        const days = (Date.parse(now) - Date.parse(o.submittedAt)) / 86_400_000;
        expect(days).toBeGreaterThan(30);
        expect(days).toBeLessThanOrEqual(90);
      }
    }
    expect(clinicFlagsFor({ outcomes: ara, today: "2026-10-24" })).toEqual([{ code: "paid_more_than_quoted", avgGapPct: 15 }]);
  });

  it("no 30 day proposer trigger fires on the base data (07 4절)", () => {
    for (const now of ["2026-10-24T10:00:00+09:00", "2026-11-12T10:00:00+09:00"]) {
      const recent = outcomes.filter((o) => {
        const days = (Date.parse(now) - Date.parse(o.submittedAt)) / 86_400_000;
        return days >= 0 && days <= 30;
      });
      const segments = new Map<string, Outcome[]>();
      for (const o of recent) {
        const key = `${o.clinicId}:${o.visitorProfile.nationality}`;
        segments.set(key, [...(segments.get(key) ?? []), o]);
      }
      for (const [, list] of segments) {
        const gap = list.reduce((s, o) => s + o.quoteGapRatio!, 0) / list.length;
        expect(list.length < 5 || gap <= 0.2).toBe(true);
        expect(list.length < 5 || list.filter((o) => o.satisfaction <= 2).length / list.length <= 0.4).toBe(true);
      }
      expect(outcomes.filter((o) => o.sideEffects.length > 0)).toHaveLength(0);
    }
  });

  it("the Ara burst is 20 evenly spaced gaps 0.25..0.37 (mean 0.31), dated relative to the injection time", () => {
    const burst = araBurstOutcomes(new Date("2026-11-14T13:00:00+09:00"));
    const gaps = burst.map((o) => o.quoteGapRatio!);
    expect(gaps[0]).toBe(0.25);
    expect(gaps[19]).toBe(0.37);
    for (let i = 1; i < 20; i++) expect(gaps[i] - gaps[i - 1]).toBeCloseTo(0.12 / 19, 3);
    for (const o of burst) {
      const { id, receivedAt, quotedKrw, quoteGapRatio, ...wire } = o;
      expect(OutcomeV1Schema.safeParse(wire).success, id).toBe(true);
    }
  });
});

describe("rules.json and customers.json", () => {
  const rules = JSON.parse(readFileSync(`${dir}rules.json`, "utf8")) as RoutingRule[];

  it("two active rules, none proposed, as in 06", () => {
    expect(rules.map((r) => [r.id, r.status, r.then.kind])).toEqual([
      ["rule_001", "active", "require_language"],
      ["rule_002", "active", "demote_clinic"],
    ]);
    expect(rules[0].when).toEqual({ nationalities: ["CN"] });
    expect(rules[1]).toMatchObject({ when: { procedureIds: ["ulthera"] }, then: { clinicIds: ["cln_dahye"], delta: 0.1 } });
  });

  it("six personas; Yuki done matches the test profile; Koreans carry no residency", () => {
    expect(seedCustomers.map((c) => c.account.id)).toEqual(["cus_yuki", "cus_yuki_done", "cus_lin", "cus_emily", "cus_jisoo", "cus_sua"]);
    expect(seedCustomers[0].profile).toBeUndefined();
    const done = seedCustomers[1].profile!;
    expect(done).toMatchObject({
      agentId: "cag_7f3k2",
      nationality: "JP",
      residency: "short_term_visitor",
      trip: { stayArea: "sinsa", flightTimeHome: "19:00" },
      prefs: { budgetKrw: { max: 450000 }, languagesNeeded: ["ja"] },
    });
    for (const c of seedCustomers) {
      expect(c.account.agentId).toMatch(/^cag_[a-z0-9]+$/);
      if (c.profile?.nationality === "KR") expect(c.profile.residency).toBeUndefined();
    }
    expect(new Set(seedCustomers.map((c) => c.account.agentId)).size).toBe(6);
  });
});

describe("no real personal data in seeds", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "procedures.json" && f !== "kr-patterns.json");
  const text = files.map((f) => readFileSync(`${dir}${f}`, "utf8")).join("\n");

  it("no phone numbers, only example.com emails, demo doctor names", () => {
    expect(text).not.toMatch(/\b0\d{1,2}-\d{3,4}-\d{4}\b/);
    expect(text).not.toMatch(/\+\d{1,3}[ -]?\d{2,4}[ -]?\d{3,4}[ -]?\d{4}/);
    for (const email of text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []) expect(email).toMatch(/@example\.com$/);
    for (const c of seedClinics) for (const d of c.profile.doctors) expect(d.name).toMatch(/\(demo\)$/);
    for (const c of seedClinics) expect(c.profile.address).toMatch(/fictional/);
  });
});
