/**
 * Postgres SettlementStore: deliveries, verification_records, settlements (one
 * row per payout attempt), refunds + refund_lines (each member's money credited
 * back to that member), withdrawals, and the purchase/coalition cache.
 */
import type pg from "pg";
import type { VerificationDecision } from "../agents/verification-agent.js";
import type { ContractPurchase } from "../chain/marketplace.js";
import type { TxResult } from "../chain/types.js";
import type { SettlementStore } from "../settlement/engine.js";
import type { SimulatedDelivery } from "../sim/gpu.js";
import { recordWithdrawal } from "./auction-repo.js";

const ts = (ns: string | null | undefined) => (ns ? new Date(Number(BigInt(ns) / 1_000_000n)).toISOString() : null);

export class PgSettlementStore implements SettlementStore {
  constructor(private readonly pool: pg.Pool) {}

  async delivered(d: SimulatedDelivery, reportTx: TxResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO deliveries (purchase_id, seller_id, outcome, required_hours, allocated_hours, started_at, finished_at, job_log_hash_hex, report_tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (purchase_id) DO NOTHING`,
      [d.purchaseId, d.sellerId, d.outcome, d.requiredHours, d.allocatedHours, d.startedAt.toISOString(), d.finishedAt.toISOString(), d.jobLogHashHex, reportTx.txHash],
    );
  }

  async verified(purchaseId: string, d: VerificationDecision, verifierAccount: string, tx: TxResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO verification_records (purchase_id, delivery_id, success, reason, verifier_account, tx_hash)
       SELECT $1, delivery_id, $2, $3, $4, $5 FROM deliveries WHERE purchase_id = $1
       ON CONFLICT (purchase_id) DO NOTHING`,
      [purchaseId, d.success, d.reason, verifierAccount, tx.txHash],
    );
  }

  async payoutAttempt(purchaseId: string, sellerId: string, payoutAccount: string, amount: bigint, ok: boolean, tx: TxResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO settlements (purchase_id, seller_id, payout_account_id, amount_yocto, status, tx_hash, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [purchaseId, sellerId, payoutAccount, amount.toString(), ok ? "SUCCEEDED" : "FAILED", tx.txHash, ok ? null : JSON.stringify(tx.error ?? "transfer receipt failed")],
    );
  }

  async refunded(purchaseId: string, amount: bigint, reason: string, lines: { buyer_id: string; amount: string }[], tx: TxResult): Promise<void> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const r = await db.query<{ refund_id: string }>(
        `INSERT INTO refunds (purchase_id, total_yocto, status, tx_hash, reason) VALUES ($1, $2, 'SUCCEEDED', $3, $4) RETURNING refund_id`,
        [purchaseId, amount.toString(), tx.txHash, reason],
      );
      for (const l of lines) {
        await db.query("INSERT INTO refund_lines (refund_id, buyer_id, amount_yocto) VALUES ($1, $2, $3)", [r.rows[0]!.refund_id, l.buyer_id, l.amount]);
        await db.query("UPDATE allocations SET refunded_yocto = $3 WHERE purchase_id = $1 AND buyer_id = $2", [purchaseId, l.buyer_id, l.amount]);
      }
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    } finally {
      db.release();
    }
  }

  async withdrawal(buyerId: string, wallet: string, amount: bigint, ok: boolean, tx: TxResult): Promise<void> {
    await recordWithdrawal(this.pool, buyerId, wallet, amount, ok, tx);
  }

  async synced(p: ContractPurchase): Promise<void> {
    await this.pool.query(
      `UPDATE purchases SET state = $2, verification_deadline = $3, payout_in_flight = $4, last_synced_at = now(), updated_at = now()
       WHERE purchase_id = $1`,
      [p.purchase_id, p.state, ts(p.verification_deadline), !!p.payout_in_flight],
    );
    if (p.state === "COMPLETED" || p.state === "REFUNDED") {
      await this.pool.query("UPDATE coalitions SET status = 'CLOSED', updated_at = now() WHERE coalition_id = $1", [p.coalition_id]);
      await this.pool.query(
        `UPDATE buyer_requirements r SET status = $2 FROM allocations a
         WHERE a.purchase_id = $1 AND a.buyer_id = r.buyer_id AND r.status = 'IN_COALITION'`,
        [p.purchase_id, p.state === "COMPLETED" ? "FULFILLED" : "UNSERVED"],
      );
    }
  }
}
