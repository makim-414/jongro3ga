// Platform namespace adapter. The platform module reads and writes only "platform" (06 소유 경계).
import { SEED_COLLECTIONS, type SeedReviewStat } from "../../../data/seed/load";
import type {
  AnchorLog,
  AttributionEntry,
  ClinicOfferCache,
  ClinicRegistryEntry,
  JudgedQuote,
  MatchLog,
  Outcome,
  PriceRecord,
  RoutingRule,
  Signal,
  VerifiedVisitStat,
} from "../../domain";
import { getStore } from "../../store";

const NS = "platform" as const;
export const COLLECTIONS = SEED_COLLECTIONS.platform;

const list = <T>(collection: string) => getStore().list<T>(NS, collection);
const get = <T>(collection: string, id: string) => getStore().get<T>(NS, collection, id);
const put = <T extends { id: string }>(collection: string, value: T) => getStore().put(NS, collection, value);

export const platformStore = {
  registry: () => list<ClinicRegistryEntry>(COLLECTIONS.clinicRegistry),
  registryEntry: (clinicId: string) => get<ClinicRegistryEntry>(COLLECTIONS.clinicRegistry, clinicId),
  priceRecords: () => list<PriceRecord>(COLLECTIONS.priceRecords),
  putPriceRecord: (r: PriceRecord) => put(COLLECTIONS.priceRecords, r),
  outcomes: () => list<Outcome>(COLLECTIONS.outcomes),
  putOutcome: (o: Outcome) => put(COLLECTIONS.outcomes, o),
  putOutcomeHistory: (h: { id: string; outcome: Outcome; replacedAt: string }) => put(COLLECTIONS.outcomeHistory, h),
  rules: () => list<RoutingRule>(COLLECTIONS.rules),
  putRule: (r: RoutingRule) => put(COLLECTIONS.rules, r),
  signals: () => list<Signal>(COLLECTIONS.signals),
  putSignal: (s: Signal) => put(COLLECTIONS.signals, s),
  matchLogs: () => list<MatchLog>(COLLECTIONS.matchLogs),
  matchLog: (id: string) => get<MatchLog>(COLLECTIONS.matchLogs, id),
  putMatchLog: (m: MatchLog) => put(COLLECTIONS.matchLogs, m),
  attribution: (bookingId: string) => get<AttributionEntry>(COLLECTIONS.attributions, `att_${bookingId}`),
  putAttribution: (a: AttributionEntry) => put(COLLECTIONS.attributions, a),
  judgedQuotes: () => list<JudgedQuote>(COLLECTIONS.judgedQuotes),
  putJudgedQuote: (j: JudgedQuote) => put(COLLECTIONS.judgedQuotes, j),
  offerCache: () => list<ClinicOfferCache>(COLLECTIONS.offerCache),
  putOfferCache: (c: ClinicOfferCache) => put(COLLECTIONS.offerCache, c),
  verifiedVisits: () => list<VerifiedVisitStat>(COLLECTIONS.verifiedVisits),
  putVerifiedVisits: (v: VerifiedVisitStat) => put(COLLECTIONS.verifiedVisits, v),
  reviewStats: () => list<StoredReviewStat>(COLLECTIONS.reviewStats),
  putReviewStats: (r: StoredReviewStat) => put(COLLECTIONS.reviewStats, r),
  anchorLogs: () => list<AnchorLog>(COLLECTIONS.anchorLogs),
  putAnchorLog: (a: AnchorLog) => put(COLLECTIONS.anchorLogs, a),
};

/** ReviewStat plus the anonymous review texts it aggregates. */
export type StoredReviewStat = SeedReviewStat;

/** "cln_seoul_glow" + "rejuran_healer" -> "seoul_glow_rejuran_healer", the id stem the seed uses for ZK stats. */
export const statKey = (clinicId: string, procedureId: string): string => `${clinicId.replace(/^cln_/, "")}_${procedureId}`;
