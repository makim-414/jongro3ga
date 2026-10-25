import { RecordAnchorV1Schema, type RecordAnchorV1 } from "../../a2a/schemas";
import { taskArtifactText, type WireTask } from "../../a2a/wire";
import type { TreatmentRecord } from "../../domain/customer";
import type { Store } from "../../store/types";
import { D0_ANCHOR, ZK_WALLETS, walletFor } from "../../ui-data/customer";
import { toGlowpassPersona } from "../../zk/identity";
import { C, listOf } from "./store";

/**
 * The chart append a D0 outcome triggers for a customer with a ZK wallet (platform.anchor_record, demo scene 6;
 * docs/INTEGRATION.md section 2). These are the demo values of D0_ANCHOR: what the record shows when the relay is
 * not reached (ZK server off, as on Vercel) or refuses. The version continues the seed wallet and the records
 * already anchored. A tx the platform relayed replaces D0_ANCHOR.tx (orchestrator submitOutcome).
 */
export async function d0AnchorFor(store: Store, customerId: string): Promise<TreatmentRecord["anchor"] | undefined> {
  const wallet = ZK_WALLETS[customerId];
  if (!wallet) return undefined;
  const records = await listOf<TreatmentRecord>(store, C.records, { customerId });
  const version = Math.max(wallet.version, ...records.map((r) => (r.anchor?.subjectId === wallet.subjectId ? r.anchor.version : 0)));
  return { subjectId: wallet.subjectId, version: version + 1, tx: D0_ANCHOR.tx, recordHash: D0_ANCHOR.recordHash };
}

/** True for an anchor the platform relayed, false for the D0_ANCHOR demo values. */
export const isRelayedAnchor = (anchor: TreatmentRecord["anchor"] | undefined): anchor is NonNullable<TreatmentRecord["anchor"]> =>
  anchor !== undefined && anchor.tx !== D0_ANCHOR.tx;

/** Platform relay of one append (GlowPass proves it and writes to Base Sepolia, about 10 s) plus the A2A round trip. */
export const ANCHOR_TIMEOUT_MS = 45_000;

/**
 * pibu/record-anchor@1 for a clinic-confirmed D0 visit, or undefined when the customer has no record wallet (no seed
 * wallet, or no GlowPass persona for the platform to act for). P0 is the server wallet transition: GlowPass builds
 * the append proof and its nonce itself, so `record`, the commitments, the hash and the proof are the D0_ANCHOR demo
 * values and the platform reads only the booking, clinic, procedure and subject (lib/agents/platform/zk-skills.ts).
 */
export async function d0AnchorRequest(
  store: Store,
  customer: { id: string; agentId: string },
  visit: { bookingId: string; clinicId: string; procedureId: string },
): Promise<RecordAnchorV1 | undefined> {
  const wallet = ZK_WALLETS[customer.id];
  if (!wallet || !(toGlowpassPersona(customer.agentId) ?? toGlowpassPersona(customer.id))) return undefined;
  const records = await listOf<TreatmentRecord>(store, C.records, { customerId: customer.id });
  const parsed = RecordAnchorV1Schema.safeParse({
    schema: "pibu/record-anchor@1",
    ...visit,
    subjectId: wallet.subjectId,
    record: { day: D0_ANCHOR.day, recordNonce: D0_ANCHOR.recordNonce, ticketCommitment: D0_ANCHOR.ticketCommitment },
    oldCommitment: walletFor(customer.id, records)?.commitment ?? "0x0",
    newCommitment: D0_ANCHOR.newCommitment,
    recordHash: D0_ANCHOR.recordHash,
    proof: "0x0",
  });
  return parsed.success ? parsed.data : undefined;
}

/** The tx of a COMPLETED platform.anchor_record (artifact text "anchored <tx>"), otherwise undefined. */
export function anchoredTx(task: WireTask): string | undefined {
  if (task.status.state !== "TASK_STATE_COMPLETED") return undefined;
  return /^anchored\s+(0x[0-9a-fA-F]+)\b/.exec(taskArtifactText(task)?.trim() ?? "")?.[1];
}
