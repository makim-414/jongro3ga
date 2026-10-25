// Loads data/seed/*.json into a store (boot, demo reset). OWNER: track A2A core.
//
// Seed dates follow the clock the app actually runs on (lib/clock.ts DEFAULT_DEMO_NOW 2026-10-24) and are
// chosen so the windows in 06/07 also hold for the 06 reference date 2026-11-12 (docs/spec/BUILD-LOG.md,
// track A2A). Collection names are exported in SEED_COLLECTIONS so every track reads the same ones.
import type {
  ClinicProfile,
  ClinicRegistryEntry,
  ConsentEntry,
  CustomerAccount,
  CustomerProfile,
  MenuItem,
  Offer,
  Outcome,
  PriceRecord,
  RoutingRule,
  Slot,
  SlotPolicy,
  ReviewStat,
  TreatmentRecord,
  VerifiedVisitStat,
} from "../../lib/domain";
import type { Store } from "../../lib/store/types";
import clinicsJson from "./clinics.json";
import customersJson from "./customers.json";
import araBurstJson from "./outcomes-ara-burst.json";
import outcomesJson from "./outcomes.json";
import priceRecordsJson from "./price-records.json";
import rulesJson from "./rules.json";
import slotsJson from "./slots.json";
import verifiedVisitsJson from "./verified-visits.json";

/** Store collections per namespace. Agent modules use only their own namespace. */
export const SEED_COLLECTIONS = {
  platform: {
    clinicRegistry: "clinic_registry",
    priceRecords: "price_records",
    outcomes: "outcomes",
    outcomeHistory: "outcome_history",
    rules: "rules",
    signals: "signals",
    matchLogs: "match_logs",
    attributions: "attributions",
    judgedQuotes: "judged_quotes",
    offerCache: "offer_cache",
    /** ZK extension: verified visit counts, review aggregates with their texts, record anchor log. */
    verifiedVisits: "verified_visits",
    reviewStats: "review_stats",
    anchorLogs: "anchor_logs",
  },
  clinic: {
    profiles: "profiles",
    menuItems: "menu_items",
    offers: "offers",
    /** SlotPolicy has no id in 06; stored with id = clinicId. */
    slotPolicies: "slot_policies",
    slots: "slots",
  },
  customer: {
    accounts: "accounts",
    profiles: "profiles",
    consents: "consents",
    records: "records",
  },
  shared: {
    a2aLog: "a2a_log",
    a2aTasks: "a2a_tasks",
    meta: "meta",
  },
} as const;

export interface SeedClinic {
  id: string;
  slug: string;
  name: ClinicRegistryEntry["name"];
  area: ClinicRegistryEntry["area"];
  registry: ClinicRegistryEntry;
  profile: ClinicProfile;
  menu: MenuItem[];
  offers: Offer[];
  slotPolicy: SlotPolicy;
}

export interface SeedCustomer {
  account: CustomerAccount;
  profile?: CustomerProfile;
  consents?: ConsentEntry[];
  records?: TreatmentRecord[];
}

/** Demo injection template for platform outcomes (outcomes-ara-burst.json). */
export interface AraBurstTemplate extends Omit<Outcome, "id" | "schema" | "submittedAt" | "receivedAt"> {
  daysAgo: number;
}

export const seedClinics = clinicsJson as unknown as SeedClinic[];
export const seedCustomers = customersJson as unknown as SeedCustomer[];
const seedOutcomes = outcomesJson as unknown as Outcome[];
const seedPriceRecords = priceRecordsJson as unknown as PriceRecord[];
const seedRules = rulesJson as unknown as RoutingRule[];
const araBurst = araBurstJson as unknown as AraBurstTemplate[];

/** ReviewStat with the anonymous review texts it aggregates (owner decision 2026-10-24: reviews are public). */
export type SeedReview = { rating: number; text: string; locale: string };
export type SeedReviewStat = ReviewStat & { reviews: SeedReview[] };
const seedVerifiedVisits = verifiedVisitsJson.verifiedVisits as VerifiedVisitStat[];
const seedReviewStats = verifiedVisitsJson.reviewStats as SeedReviewStat[];

const SEED_MARKER_ID = "seed";
export const SEED_VERSION = "2026-10-24.a2a.1";

/** Every clinic, every day in the window, four fixed KST times (06 seed table). */
export function expandSlots(): Slot[] {
  const { from, to, times, clinicIds } = slotsJson as { from: string; to: string; times: string[]; clinicIds: string[] };
  const slots: Slot[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (const clinicId of clinicIds) {
    const clinic = seedClinics.find((c) => c.id === clinicId);
    const procedureIds = clinic
      ? [...new Set([...clinic.menu.map((m) => m.procedureId), ...clinic.offers.map((o) => o.procedureId)])].sort()
      : [];
    for (let day = Date.parse(`${from}T00:00:00Z`); day <= end; day += 86_400_000) {
      const date = new Date(day).toISOString().slice(0, 10);
      for (const time of times) {
        slots.push({
          id: `slot_${clinicId.slice(4)}_${date.replace(/-/g, "")}_${time.replace(":", "")}`,
          clinicId,
          start: `${date}T${time}:00+09:00`,
          procedureIds,
          held: false,
        });
      }
    }
  }
  return slots;
}

async function putAll<T extends { id: string }>(store: Store, ns: Parameters<Store["put"]>[0], collection: string, items: T[]) {
  for (const item of items) await store.put(ns, collection, item);
  return items.length;
}

export async function loadSeed(store: Store): Promise<{ loaded: Record<string, number> }> {
  const P = SEED_COLLECTIONS.platform;
  const C = SEED_COLLECTIONS.clinic;
  const U = SEED_COLLECTIONS.customer;
  const loaded: Record<string, number> = {};

  loaded[`platform.${P.clinicRegistry}`] = await putAll(store, "platform", P.clinicRegistry, seedClinics.map((c) => c.registry));
  loaded[`platform.${P.priceRecords}`] = await putAll(store, "platform", P.priceRecords, seedPriceRecords);
  loaded[`platform.${P.outcomes}`] = await putAll(store, "platform", P.outcomes, seedOutcomes);
  loaded[`platform.${P.rules}`] = await putAll(store, "platform", P.rules, seedRules);
  loaded[`platform.${P.verifiedVisits}`] = await putAll(store, "platform", P.verifiedVisits, seedVerifiedVisits);
  loaded[`platform.${P.reviewStats}`] = await putAll(store, "platform", P.reviewStats, seedReviewStats);

  loaded[`clinic.${C.profiles}`] = await putAll(store, "clinic", C.profiles, seedClinics.map((c) => c.profile));
  loaded[`clinic.${C.menuItems}`] = await putAll(store, "clinic", C.menuItems, seedClinics.flatMap((c) => c.menu));
  loaded[`clinic.${C.offers}`] = await putAll(store, "clinic", C.offers, seedClinics.flatMap((c) => c.offers));
  loaded[`clinic.${C.slotPolicies}`] = await putAll(
    store,
    "clinic",
    C.slotPolicies,
    seedClinics.map((c) => ({ id: c.id, ...c.slotPolicy })),
  );
  loaded[`clinic.${C.slots}`] = await putAll(store, "clinic", C.slots, expandSlots());

  loaded[`customer.${U.accounts}`] = await putAll(store, "customer", U.accounts, seedCustomers.map((c) => c.account));
  loaded[`customer.${U.profiles}`] = await putAll(
    store,
    "customer",
    U.profiles,
    seedCustomers.flatMap((c) => (c.profile ? [c.profile] : [])),
  );
  loaded[`customer.${U.consents}`] = await putAll(store, "customer", U.consents, seedCustomers.flatMap((c) => c.consents ?? []));
  loaded[`customer.${U.records}`] = await putAll(store, "customer", U.records, seedCustomers.flatMap((c) => c.records ?? []));

  await store.put("shared", SEED_COLLECTIONS.shared.meta, { id: SEED_MARKER_ID, version: SEED_VERSION, loaded });
  return { loaded };
}

interface SeedGlobals {
  inflight?: Promise<void>;
}

declare global {
  var __pibuSeed: SeedGlobals | undefined;
}

/**
 * Loads the seed once when the store has never been seeded (first boot). Cheap to call on every request:
 * one marker read. A demo reset that empties the store makes the next call seed again.
 */
export async function ensureSeeded(store: Store): Promise<void> {
  const g = (globalThis.__pibuSeed ??= {});
  if (g.inflight) return g.inflight;
  const marker = await store.get("shared", SEED_COLLECTIONS.shared.meta, SEED_MARKER_ID);
  if (marker) return;
  g.inflight = loadSeed(store)
    .then(() => undefined)
    .finally(() => {
      delete g.inflight;
    });
  return g.inflight;
}

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * The 20 Ara x JP demo outcomes (07 proposer demo, 10 demo row 7) dated 1~29 days before `now`.
 * Callers (the demo inject API) pass clock.now() and store them in the platform outcomes collection.
 * They never create PriceRecords (07 "결과 수집": the verdict sample stays n = 42).
 */
export function araBurstOutcomes(now: Date): Outcome[] {
  return araBurst.map(({ daysAgo, ...template }) => {
    const at = new Date(now.getTime() - daysAgo * DAY_MS + KST_OFFSET_MS).toISOString().slice(0, 19);
    return {
      ...template,
      id: template.outcomeId,
      schema: "pibu/outcome@1",
      submittedAt: `${at}+09:00`,
      receivedAt: `${at}+09:00`,
    } as Outcome;
  });
}
