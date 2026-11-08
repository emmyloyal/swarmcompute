/**
 * Verification Agent (spec Sections 6, 8, 9). Simulated verification: the
 * operator controls this agent, which is why the system is not trustless
 * (SECURITY.md). It is the only component that calls the contract's `verify`,
 * with the verifier key (RULES.md R8).
 *
 * Decision is deterministic code, never an LLM (RULES.md R5):
 *   success ⇔ outcome SUCCESS, allocated hours = required hours, and the
 *             delivered job log hashes to the reported hash.
 * PARTIAL counts as failure (MVP policy: full refund).
 */
import type { PayloadOf } from "@swarmcompute/shared";
import { hashJobLog } from "../sim/gpu.js";

export interface VerificationDecision {
  success: boolean;
  reason: string;
}

export function decideVerification(report: PayloadOf<"DELIVERY_REPORT">, jobLog: string, onChainReportHash: string | null): VerificationDecision {
  if (hashJobLog(jobLog) !== report.job_log_hash_hex) return { success: false, reason: "job log does not match reported hash" };
  if (onChainReportHash !== null && onChainReportHash !== report.job_log_hash_hex) {
    return { success: false, reason: "reported hash differs from the hash submitted on-chain" };
  }
  if (report.outcome === "PARTIAL") {
    return { success: false, reason: `partial delivery: ${report.allocated_hours}/${report.required_hours} h (MVP policy: full refund)` };
  }
  if (report.outcome === "FAILURE") return { success: false, reason: "delivery failed: 0 hours delivered" };
  if (report.allocated_hours !== report.required_hours) return { success: false, reason: "allocated hours below required" };
  return { success: true, reason: `delivered ${report.allocated_hours}/${report.required_hours} h, job log hash verified (simulated verification)` };
}
