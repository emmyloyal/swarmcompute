/**
 * blockchain_transactions: every transaction the backend submits, with its real
 * RPC outcome (RULES.md R2). Rows are written only from a returned outcome.
 */
import type pg from "pg";
import type { TxRecorder } from "../chain/near-client.js";
import type { CallOptions, TxResult } from "../chain/types.js";

export class PgTxRecorder implements TxRecorder {
  constructor(private readonly pool: pg.Pool) {}

  async record(tx: TxResult, opts: CallOptions & { deposit: bigint }): Promise<void> {
    await this.pool.query(
      `INSERT INTO blockchain_transactions
         (tx_hash, signer_account_id, receiver_id, method_name, purpose, purchase_id, deposit_yocto,
          status, block_hash, gas_burnt, error, finalized_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       ON CONFLICT (tx_hash) DO NOTHING`,
      [
        tx.txHash,
        tx.signerId,
        tx.receiverId,
        tx.method,
        opts.purpose,
        opts.purchaseId ?? null,
        opts.deposit.toString(),
        tx.ok ? "SUCCESS" : "FAILURE",
        tx.blockHash ?? null,
        tx.gasBurnt.toString(),
        tx.error === undefined ? null : JSON.stringify(tx.error),
      ],
    );
  }
}
