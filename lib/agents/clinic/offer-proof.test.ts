import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real verifier needs the owner's wallet and the GlowPass server: mock the HTTP wrapper.
vi.mock("../../zk/client", () => ({ verifyOffer: vi.fn() }));

import { verifyOffer } from "../../zk/client";
import { checkOfferProof } from "./offer-proof";
import type { StoredOffer } from "./store";

const verifyMock = vi.mocked(verifyOffer);
const ENV = { ...process.env };

const mintFirstVisit: StoredOffer = {
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
  active: true,
};

const mintSecondVisit: StoredOffer = {
  ...mintFirstVisit,
  id: "ofr_mint_rejuran_second",
  zkClauses: [{ type: "rejuran_healer", minCount: 1, maxCount: 1 }],
};

const SUBJECT = `0x${"ab".repeat(32)}`;

const bundle = (extra: Record<string, unknown> = {}) => ({
  subjectId: SUBJECT,
  offerId: "ofr_mint_rejuran_first_visit",
  today: 29880272,
  proofs: [{ proof: "0x1f2e", publicInputs: ["0x0b", "29880272", "0", "2", "0", "100000", "0", "0"] }],
  ...extra,
});

const wireProof = (extra: Record<string, unknown> = {}) => ({
  schema: "pibu/offer-proof@1",
  clinicId: "cln_mint",
  chainId: 84532,
  registry: "0xcf47152e720508bf8c757a55aa30956ca8b58857",
  ...bundle(),
  ...extra,
});

const check = (metadata: Record<string, unknown>, overrides: Partial<Parameters<typeof checkOfferProof>[0]> = {}) =>
  checkOfferProof({
    clinicId: "cln_mint",
    procedureId: "rejuran_healer",
    offers: [mintFirstVisit, mintSecondVisit],
    today: "2026-11-12",
    metadata,
    ...overrides,
  });

beforeEach(() => {
  process.env.ZK_SERVER_URL = "http://localhost:4000";
  delete process.env.ZK_TIMEOUT_MS;
  verifyMock.mockReset().mockResolvedValue({ ok: true, reason: "verified" });
});

afterEach(() => {
  process.env = { ...ENV };
});

describe("checkOfferProof: reading the proof", () => {
  it("verifies a pibu/offer-proof@1 in metadata.offerProof and sends only the bundle to the verifier", async () => {
    expect(await check({ offerProof: wireProof() })).toEqual({ verified: true, offerId: "ofr_mint_rejuran_first_visit", unanchored: false });
    expect(verifyMock).toHaveBeenCalledWith("cln_mint", bundle());
  });

  it("verifies the bare bundle the customer agent sends in metadata.zkOfferProof", async () => {
    expect(await check({ zkOfferProof: bundle({ provingMs: 458 }) })).toMatchObject({ verified: true, offerId: "ofr_mint_rejuran_first_visit" });
    expect(verifyMock).toHaveBeenCalledWith("cln_mint", bundle());
  });

  it("accepts a { schema, bundle } wrapper and checks its clinicId", async () => {
    expect(await check({ zkOfferProof: { schema: "pibu/offer-proof@1", bundle: bundle() } })).toMatchObject({ verified: true });
    expect(await check({ zkOfferProof: { schema: "pibu/offer-proof@1", clinicId: "cln_ara", bundle: bundle() } })).toMatchObject({
      verified: false,
      reason: "other_clinic",
    });
  });

  it("reads metadata.offerProof before metadata.zkOfferProof", async () => {
    const result = await check({ offerProof: wireProof({ clinicId: "cln_seoul_glow" }), zkOfferProof: bundle() });
    expect(result).toMatchObject({ verified: false, reason: "other_clinic" });
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("reports no_proof without a proof and malformed for anything that is not a proof", async () => {
    expect(await check({})).toEqual({ verified: false, reason: "no_proof" });
    expect(await check({ offerProof: null, zkOfferProof: undefined })).toEqual({ verified: false, reason: "no_proof" });
    for (const raw of [
      "proof",
      [bundle()],
      wireProof({ chainId: "x" }),
      wireProof({ registry: "" }),
      wireProof({ extra: true }),
      bundle({ proofs: [] }),
      bundle({ offerId: "offer_mint_1" }),
      bundle({ subjectId: "0xabc" }),
      { schema: "pibu/offer-proof@1", bundle: { offerId: "ofr_mint_rejuran_first_visit" } },
    ]) {
      expect(await check({ zkOfferProof: raw }), JSON.stringify(raw)).toMatchObject({ verified: false, reason: "malformed" });
    }
    expect(verifyMock).not.toHaveBeenCalled();
  });
});

describe("checkOfferProof: which offers a proof can unlock", () => {
  it("does not ask the verifier about another clinic's proof or offer", async () => {
    expect(await check({ offerProof: wireProof({ clinicId: "cln_seoul_glow" }) })).toMatchObject({ verified: false, reason: "other_clinic" });
    expect(await check({ zkOfferProof: bundle({ offerId: "ofr_hanbit_first_visit" }) })).toMatchObject({ verified: false, reason: "other_clinic" });
    const glowOffer = { ...mintFirstVisit, id: "ofr_seoul_glow_rejuran_second", clinicId: "cln_seoul_glow" };
    expect(await check({ zkOfferProof: bundle({ offerId: glowOffer.id }) }, { offers: [glowOffer] })).toMatchObject({
      verified: false,
      reason: "other_clinic",
    });
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("needs a running, switched on, proof-only event for the requested procedure", async () => {
    const plain: StoredOffer = { ...mintFirstVisit, zkClauses: undefined };
    const cases: [string, Partial<Parameters<typeof checkOfferProof>[0]>][] = [
      ["another procedure", { procedureId: "botox_forehead" }],
      ["after the event", { today: "2026-12-01" }],
      ["switched off", { offers: [{ ...mintFirstVisit, active: false }] }],
      ["no zkClauses", { offers: [plain] }],
    ];
    for (const [label, overrides] of cases) {
      expect(await check({ offerProof: wireProof() }, overrides), label).toMatchObject({ verified: false, reason: "no_such_offer" });
    }
    expect(verifyMock).not.toHaveBeenCalled();
  });
});

describe("checkOfferProof: the verifier", () => {
  it("is not called while ZK is off (no ZK_SERVER_URL)", async () => {
    delete process.env.ZK_SERVER_URL;
    expect(await check({ zkOfferProof: bundle() })).toMatchObject({ verified: false, reason: "zk_disabled" });
    process.env.ZK_SERVER_URL = "";
    expect(await check({ zkOfferProof: bundle() })).toMatchObject({ verified: false, reason: "zk_disabled" });
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("maps a refusal, a throw and a missing answer to a failed check", async () => {
    verifyMock.mockResolvedValueOnce({ ok: false, reason: "증명 검증 실패" });
    expect(await check({ zkOfferProof: bundle() })).toEqual({
      verified: false,
      reason: "rejected",
      offerId: "ofr_mint_rejuran_first_visit",
      detail: "증명 검증 실패",
    });
    verifyMock.mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"));
    expect(await check({ zkOfferProof: bundle() })).toMatchObject({ verified: false, reason: "verifier_unreachable", detail: "fetch failed: ECONNREFUSED" });
    verifyMock.mockResolvedValueOnce(undefined as never);
    expect(await check({ zkOfferProof: bundle() })).toMatchObject({ verified: false, reason: "rejected" });
  });

  it("gives up after ZK_TIMEOUT_MS", async () => {
    process.env.ZK_TIMEOUT_MS = "20";
    verifyMock.mockReturnValueOnce(new Promise(() => {}));
    expect(await check({ zkOfferProof: bundle() })).toMatchObject({ verified: false, reason: "verifier_timeout" });
  });
});

describe("checkOfferProof: unanchored pseudonyms (docs/INTEGRATION.md 3절)", () => {
  it("passes a first visit offer when the verifier treats the pseudonym as an empty chart", async () => {
    verifyMock.mockResolvedValueOnce({ ok: true, reason: "빈 차트로 간주", unanchored: true });
    expect(await check({ offerProof: wireProof({ unanchored: true }) })).toEqual({
      verified: true,
      offerId: "ofr_mint_rejuran_first_visit",
      unanchored: true,
    });
    expect(verifyMock.mock.calls[0]![1]).toMatchObject({ unanchored: true });
  });

  it("refuses a clause that needs a record, whether the verifier or the bundle says unanchored", async () => {
    verifyMock.mockResolvedValueOnce({ ok: true, reason: "빈 차트로 간주", unanchored: true });
    expect(await check({ zkOfferProof: bundle({ offerId: "ofr_mint_rejuran_second" }) })).toMatchObject({ verified: false, reason: "needs_records" });
    verifyMock.mockResolvedValueOnce({ ok: true, reason: "verified" });
    expect(await check({ zkOfferProof: bundle({ offerId: "ofr_mint_rejuran_second", unanchored: true }) })).toMatchObject({
      verified: false,
      reason: "needs_records",
    });
    verifyMock.mockResolvedValueOnce({ ok: true, reason: "verified" });
    expect(await check({ zkOfferProof: bundle({ offerId: "ofr_mint_rejuran_second" }) })).toEqual({
      verified: true,
      offerId: "ofr_mint_rejuran_second",
      unanchored: false,
    });
  });
});
