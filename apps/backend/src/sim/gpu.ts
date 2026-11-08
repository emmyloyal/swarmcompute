/**
 * Simulated GPU provisioning and delivery (spec Section 9). No real compute
 * runs; every report is labelled `simulated: true`.
 *
 * Outcome is drawn from the winning seller's private failure probability with
 * a PRNG seeded by (seed, purchase), so a run is reproducible (RULES.md R16).
 * A failure is either total (FAILURE, 0 h) or PARTIAL (some hours delivered);
 * PARTIAL is treated as failed delivery and refunded in full (Section 8).
 * The job log is a deterministic transcript; its SHA-256 is what goes on-chain.
 */
import { createHash } from "node:crypto";
import { Prng } from "./prng.js";

export type DeliveryOutcome = "SUCCESS" | "FAILURE" | "PARTIAL";

export interface SimulatedDelivery {
  purchaseId: string;
  sellerId: string;
  outcome: DeliveryOutcome;
  requiredHours: number;
  allocatedHours: number;
  startedAt: Date;
  finishedAt: Date;
  jobLog: string;
  jobLogHashHex: string;
  simulated: true;
}

export interface SimulateArgs {
  seed: string;
  purchaseId: string;
  sellerId: string;
  gpuModel: string;
  vramGb: number;
  requiredHours: number;
  failureProbabilityBps: number;
  startedAt: Date;
  /** Demo only: force an outcome (e.g. to exercise the refund path). */
  force?: DeliveryOutcome;
  /** Simulated wall time per GPU-hour (default 1 s). */
  msPerHour?: number;
}

export function hashJobLog(log: string): string {
  return createHash("sha256").update(log, "utf8").digest("hex");
}

export function simulateDelivery(a: SimulateArgs): SimulatedDelivery {
  const rng = new Prng(a.seed, `delivery/${a.purchaseId}`);
  let outcome: DeliveryOutcome = a.force ?? (rng.chanceBps(a.failureProbabilityBps) ? (rng.chanceBps(5000) ? "PARTIAL" : "FAILURE") : "SUCCESS");
  let allocatedHours = a.requiredHours;
  if (outcome === "FAILURE") allocatedHours = 0;
  if (outcome === "PARTIAL") {
    if (a.requiredHours < 2) {
      outcome = "FAILURE";
      allocatedHours = 0;
    } else allocatedHours = rng.int(1, a.requiredHours - 1);
  }
  const ms = a.msPerHour ?? 1000;
  const finishedAt = new Date(a.startedAt.getTime() + Math.max(allocatedHours, 1) * ms);
  const lines = [
    `# SIMULATED delivery — no real compute ran`,
    `purchase=${a.purchaseId} seller=${a.sellerId} gpu=${a.gpuModel}/${a.vramGb}GB required_hours=${a.requiredHours}`,
    `started_at=${a.startedAt.toISOString()}`,
  ];
  for (let h = 1; h <= allocatedHours; h++) lines.push(`hour ${h}/${a.requiredHours} ok`);
  if (allocatedHours < a.requiredHours) lines.push(`stopped after ${allocatedHours}/${a.requiredHours} hours (${outcome})`);
  lines.push(`finished_at=${finishedAt.toISOString()} outcome=${outcome}`);
  const jobLog = lines.join("\n") + "\n";
  return {
    purchaseId: a.purchaseId,
    sellerId: a.sellerId,
    outcome,
    requiredHours: a.requiredHours,
    allocatedHours,
    startedAt: a.startedAt,
    finishedAt,
    jobLog,
    jobLogHashHex: hashJobLog(jobLog),
    simulated: true,
  };
}
