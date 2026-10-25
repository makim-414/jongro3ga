// clinic.quote item selection (07-platform-intelligence.md "병원 에이전트의 견적 항목 선택"), with the ZK rule of
// 03 "ZK 확장 필드": an event with zkClauses applies only when its offer proof was verified (offer-proof.ts).
// Pure functions: the skill handler loads the clinic data, the clock and the proof result, these decide.
import type { ZkClause } from "../../a2a/schemas";
import type { Amount, IsoDate, Krw } from "../../domain/common";
import type { MenuItem, Offer, Slot } from "../../domain/clinic";
import { getProcedure } from "../../domain/procedure-master";
import type { StoredOffer } from "./store";

/** Inclusion codes used on the wire (03 quote example: numbing_cream, soothing_mask). */
export const INCLUSION_CODES = ["numbing_cream", "soothing_mask", "recovery_cream"] as const;

export interface QuoteEvent {
  title: string;
  regularPriceKrw: Krw;
  validFrom: IsoDate;
  validUntil: IsoDate;
  conditions: string;
  /** Only on an event that applies by proof alone (03 `event.zkClauses`). */
  zkClauses?: ZkClause[];
}

export interface QuoteSelection {
  source: "event" | "menu" | "event_regular_price";
  product: string;
  amount: Amount;
  priceKrw: Krw;
  vatIncluded: boolean;
  includes: string[];
  excludes: string[];
  event?: QuoteEvent;
  /** Only when the clinic verified an offer proof and applied the event price (03 `quote.offerApplied`). */
  offerApplied?: { offerId: string; verified: true };
  offerId?: string;
  menuItemId?: string;
}

export interface SelectInput {
  procedureId: string;
  amount: Amount;
  today: IsoDate;
  menu: MenuItem[];
  offers: StoredOffer[];
  /** Offer whose proof the clinic verified for this request (checkOfferProof in offer-proof.ts). */
  verifiedOfferId?: string;
  /**
   * False when no ZK server is configured (ZK_SERVER_URL unset, as on the Vercel demo): nobody can prove anything
   * there, so proof-only events apply like plain events and the quote looks as it did before the ZK port
   * (owner decision 2026-10-24 evening, BUILD-LOG P12). Default true.
   */
  proofsRequired?: boolean;
}

/** An event with zkClauses applies only with a verified offer proof (03 "ZK 확장 필드"). */
export function isProofOnly(offer: Pick<Offer, "zkClauses">): boolean {
  return (offer.zkClauses?.length ?? 0) > 0;
}

/** Offers that run today and are switched on, for one procedure. */
export function currentOffers(offers: StoredOffer[], procedureId: string, today: IsoDate): StoredOffer[] {
  return offers.filter(
    (offer) =>
      offer.procedureId === procedureId && offer.active !== false && offer.validFrom <= today && today <= offer.validUntil,
  );
}

/** Closest amount to the request; ties go to the larger amount. Different units rank last. */
export function closest<T extends { amount: Amount }>(items: T[], wanted: Amount): T | undefined {
  const distance = (item: T) => (item.amount.unit === wanted.unit ? Math.abs(item.amount.value - wanted.value) : Number.POSITIVE_INFINITY);
  return [...items].sort((a, b) => distance(a) - distance(b) || b.amount.value - a.amount.value)[0];
}

function excludesOf(includes: string[]): string[] {
  return INCLUSION_CODES.filter((code) => !includes.includes(code));
}

function sameAmount(a: Amount, b: Amount): boolean {
  return a.unit === b.unit && a.value === b.value;
}

/** Menu facts (product name, VAT, inclusions) for an offer: same procedure and amount first, then any. */
function menuFor(offer: StoredOffer, menu: MenuItem[]): MenuItem | undefined {
  const forProcedure = menu.filter((item) => item.procedureId === offer.procedureId);
  return forProcedure.find((item) => sameAmount(item.amount, offer.amount)) ?? forProcedure[0];
}

/** An event has no product of its own: the clinic's menu item for it, then the procedure master name, then the title. */
function eventProduct(offer: StoredOffer, facts: MenuItem | undefined): string {
  return facts?.product ?? getProcedure(offer.procedureId)?.name.en ?? offer.title;
}

function eventSelection(offer: StoredOffer, menu: MenuItem[], gated = true): QuoteSelection {
  const facts = menuFor(offer, menu);
  const includes = facts?.includes ?? [];
  return {
    source: "event",
    product: eventProduct(offer, facts),
    amount: offer.amount,
    priceKrw: offer.priceKrw,
    vatIncluded: facts?.vatIncluded ?? true,
    includes,
    excludes: excludesOf(includes),
    event: {
      title: offer.title,
      regularPriceKrw: offer.regularPriceKrw,
      validFrom: offer.validFrom,
      validUntil: offer.validUntil,
      conditions: offer.conditions,
      ...(gated && isProofOnly(offer) ? { zkClauses: offer.zkClauses } : {}),
    },
    offerId: offer.id,
    menuItemId: facts?.id,
  };
}

/**
 * 0. A running proof-only event whose proof verified: that event plus offerApplied.
 * 1. Otherwise a running event without zkClauses wins, at the event's own amount (a 2cc request gets a 1cc event).
 * 2. Otherwise the menu item closest to the requested amount (ties: larger amount).
 * 3. Only an unproven proof-only event for the procedure: that item at its regular price, no event (Mint 1cc 150,000).
 * 4. Nothing for the procedure: null, the handler answers TASK_STATE_REJECTED.
 * With `proofsRequired: false` (no ZK server) proof-only events count as plain ones in step 1, without zkClauses.
 */
export function selectQuoteItem(input: SelectInput): QuoteSelection | null {
  const running = currentOffers(input.offers, input.procedureId, input.today);
  const gated = input.proofsRequired !== false;
  const proofOnly = gated ? running.filter(isProofOnly) : [];
  const plain = gated ? running.filter((offer) => !isProofOnly(offer)) : running;
  const menu = input.menu.filter((item) => item.procedureId === input.procedureId);

  const proven = input.verifiedOfferId ? proofOnly.find((offer) => offer.id === input.verifiedOfferId) : undefined;
  if (proven) return { ...eventSelection(proven, input.menu), offerApplied: { offerId: proven.id, verified: true } };

  const event = closest(plain, input.amount);
  if (event) return eventSelection(event, input.menu, gated);

  const item = closest(menu, input.amount);
  if (item) {
    return {
      source: "menu",
      product: item.product,
      amount: item.amount,
      priceKrw: item.priceKrw,
      vatIncluded: item.vatIncluded,
      includes: item.includes,
      excludes: excludesOf(item.includes),
      menuItemId: item.id,
    };
  }

  // Proof-only event without a verified proof and no menu item: the regular price of that event's amount.
  const offer = closest(proofOnly, input.amount);
  if (offer) {
    return {
      source: "event_regular_price",
      product: eventProduct(offer, undefined),
      amount: offer.amount,
      priceKrw: offer.regularPriceKrw,
      vatIncluded: true,
      includes: [],
      excludes: excludesOf([]),
      offerId: offer.id,
    };
  }
  return null;
}

/** Calendar date in Seoul for an ISO date-time with any offset. */
export function kstDate(iso: string): IsoDate {
  return new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** Free slots inside the date window (KST calendar dates) that accept the procedure. */
export function freeSlots(slots: Slot[], procedureId: string, from: IsoDate, to: IsoDate): string[] {
  return slots
    .filter((slot) => !slot.held)
    .filter((slot) => slot.procedureIds.length === 0 || slot.procedureIds.includes(procedureId))
    .filter((slot) => {
      const date = kstDate(slot.start);
      return from <= date && date <= to;
    })
    .map((slot) => slot.start)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
}

/** Quote validity: one week, never past the event's last day. */
export function quoteValidUntil(today: IsoDate, event?: QuoteEvent): IsoDate {
  const week = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  return event && event.validUntil < week ? event.validUntil : week;
}
