/**
 * NEP-297 event indexer (spec Section 8 Events, RULES.md R15).
 *
 * For every transaction the backend submitted (blockchain_transactions), fetch
 * its final receipts from the RPC and store each contract event in
 * contract_events, keyed by (receipt_id, log_index) so re-indexing is a no-op.
 * reputation_updated events become reputation_records snapshots: reputation in
 * the DB is only ever copied from the chain.
 *
 * Scope: transactions submitted by this backend. Calls made by third parties
 * (e.g. someone else calling `expire`) are not seen here; the reconciler
 * detects their effect as drift against contract views.
 */
import type pg from "pg";
import { parseEvents, type ChainReader, type ContractEvent, type TxStatusView } from "../chain/types.js";

export interface IndexedEvent {
  receiptId: string;
  logIndex: number;
  blockHash: string;
  event: ContractEvent;
}

/** Events from successful receipts executed by the contract, in log order. */
export function extractEvents(status: TxStatusView, contractId: string): IndexedEvent[] {
  const out: IndexedEvent[] = [];
  for (const r of status.receipts) {
    if (r.failed || r.executorId !== contractId) continue;
    r.logs.forEach((log, logIndex) => {
      const [e] = parseEvents([log]);
      if (e && e.standard === "swarmcompute") out.push({ receiptId: r.receiptId, logIndex, blockHash: r.blockHash, event: e });
    });
  }
  return out;
}

export class PgEventIndexer {
  constructor(
    private readonly pool: pg.Pool,
    private readonly reader: ChainReader,
  ) {}

  async run(limit = 500): Promise<{ txs: number; events: number; reputation: number; notFound: number }> {
    const { rows } = await this.pool.query<{ tx_hash: string; signer_account_id: string }>(
      "SELECT tx_hash, signer_account_id FROM blockchain_transactions WHERE indexed_at IS NULL ORDER BY submitted_at LIMIT $1",
      [limit],
    );
    const blocks = new Map<string, { height: bigint; timestampNs: bigint }>();
    let events = 0;
    let reputation = 0;
    let notFound = 0;
    for (const tx of rows) {
      const status = await this.reader.txStatus(tx.tx_hash, tx.signer_account_id);
      if (!status) {
        notFound++; // retried next run
        continue;
      }
      const evs = extractEvents(status, this.reader.contractId);
      let firstHeight: bigint | null = null;
      for (const e of evs) {
        if (!blocks.has(e.blockHash)) blocks.set(e.blockHash, await this.reader.block(e.blockHash));
        const b = blocks.get(e.blockHash)!;
        firstHeight ??= b.height;
        const data = e.event.data[0] ?? {};
        const purchaseId = typeof data.purchase_id === "string" ? data.purchase_id : null;
        const ins = await this.pool.query(
          `INSERT INTO contract_events (tx_hash, receipt_id, log_index, block_height, block_timestamp_ns, standard, version, event, data, purchase_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (receipt_id, log_index) DO NOTHING`,
          [tx.tx_hash, e.receiptId, e.logIndex, b.height.toString(), b.timestampNs.toString(), e.event.standard, e.event.version, e.event.event, JSON.stringify(e.event.data), purchaseId],
        );
        events += ins.rowCount ?? 0;
        if (e.event.event === "reputation_updated") {
          const rep = data.reputation as Record<string, number> | undefined;
          if (rep && typeof data.seller_id === "string") {
            const r = await this.pool.query(
              `INSERT INTO reputation_records (seller_id, wins, completed_deliveries, failed_deliveries, non_reveals, source_tx_hash, block_height, receipt_id, log_index)
               SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9 WHERE EXISTS (SELECT 1 FROM sellers WHERE seller_id = $1)
               ON CONFLICT (receipt_id, log_index) WHERE receipt_id IS NOT NULL DO NOTHING`,
              [data.seller_id, rep.wins, rep.completed_deliveries, rep.failed_deliveries, rep.non_reveals, tx.tx_hash, b.height.toString(), e.receiptId, e.logIndex],
            );
            reputation += r.rowCount ?? 0;
          }
        }
      }
      await this.pool.query("UPDATE blockchain_transactions SET indexed_at = now(), block_height = COALESCE(block_height, $2) WHERE tx_hash = $1", [
        tx.tx_hash,
        firstHeight?.toString() ?? null,
      ]);
    }
    return { txs: rows.length - notFound, events, reputation, notFound };
  }
}
