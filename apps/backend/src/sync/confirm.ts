/**
 * Message confirmation (spec Section 11, RULES.md R2/R14).
 *
 * A message that references a transaction is CONFIRMED only when the RPC
 * returns that transaction, it targeted the marketplace contract, and a
 * successful contract receipt emitted the event that the message claims, with
 * matching fields. Otherwise it is REJECTED with a reason. A hash the RPC does
 * not know yet stays ACCEPTED and is retried (it may simply not be final).
 */
import type pg from "pg";
import type { ChainReader, TxStatusView } from "../chain/types.js";
import { parseEvents } from "../chain/types.js";

type Data = Record<string, unknown>;
type Matcher = { event: string; match: (d: Data) => boolean };

const eq = (a: unknown, b: unknown) => a !== undefined && a !== null && String(a) === String(b);

/** The contract event (events.rs) that proves each on-chain message type. */
export function expectedEvent(type: string, p: Data): Matcher | null {
  switch (type) {
    case "BID_COMMITMENT":
      return { event: "bid_committed", match: (d) => eq(d.auction_id, p.auction_id) && eq(d.seller_id, p.seller_id) && eq(d.commitment, p.commitment_hex) };
    case "BID_REVEAL":
      return {
        event: "bid_revealed",
        match: (d) => eq(d.auction_id, p.auction_id) && eq(d.seller_id, p.seller_id) && eq(d.price_per_hour, p.price_per_hour_yocto) && eq(d.nonce, p.nonce_hex),
      };
    case "AUCTION_RESULT":
      return {
        event: "auction_closed",
        match: (d) =>
          eq(d.purchase_id, p.purchase_id) &&
          eq(d.outcome, p.outcome) &&
          (p.outcome !== "AWARDED" || (eq(d.winner_seller_id, p.winner_seller_id) && eq(d.winning_price_per_hour, p.winning_price_per_hour_yocto))),
      };
    case "PREPAYMENT":
      return { event: "prepaid", match: (d) => eq(d.purchase_id, p.purchase_id) && eq(d.buyer_id, p.buyer_id) && eq(d.amount, p.amount_yocto) };
    case "FUNDING_CONFIRMATION":
      // The on-chain member line must show the same clearing price, owed and excess.
      return {
        event: "purchase_funded",
        match: (d) =>
          eq(d.purchase_id, p.purchase_id) &&
          eq(d.clearing_price_per_hour, p.clearing_price_per_hour_yocto) &&
          Array.isArray(d.members) &&
          (d.members as Data[]).some(
            (m) => eq(m.buyer_id, p.buyer_id) && eq(m.prepaid, p.prepaid_yocto) && eq(m.owed, p.owed_yocto) && eq(m.excess, p.excess_yocto),
          ),
      };
    case "BALANCE_RETURNED":
      return { event: "withdrawal_succeeded", match: (d) => eq(d.buyer_id, p.buyer_id) && eq(d.amount, p.amount_yocto) && eq(d.wallet, p.wallet) };
    case "DELIVERY_REPORT":
      return { event: "delivery_reported", match: (d) => eq(d.purchase_id, p.purchase_id) && eq(d.report_hash, p.job_log_hash_hex) };
    case "VERIFICATION_RESULT":
      return { event: "delivery_verified", match: (d) => eq(d.purchase_id, p.purchase_id) && d.success === p.success };
    case "SETTLEMENT_CONFIRMATION":
      return {
        event: "payout_succeeded",
        match: (d) => eq(d.purchase_id, p.purchase_id) && eq(d.amount, p.amount_yocto) && eq(d.payout_account_id, p.payout_account),
      };
    case "REFUND_CONFIRMATION":
      return { event: "refund_succeeded", match: (d) => eq(d.purchase_id, p.purchase_id) && eq(d.amount, p.total_refund_yocto) };
    default:
      return null;
  }
}

export type Verdict = { ok: true } | { ok: false; retry: true; reason: string } | { ok: false; retry: false; code: string; reason: string };

export function verifyMessageTx(type: string, payload: Data, status: TxStatusView | null, contractId: string): Verdict {
  const m = expectedEvent(type, payload);
  if (!m) return { ok: false, retry: false, code: "NOT_ON_CHAIN_TYPE", reason: `${type} does not reference a transaction` };
  if (!status) return { ok: false, retry: true, reason: "transaction not known to the RPC yet" };
  if (status.receiverId !== contractId) return { ok: false, retry: false, code: "TX_WRONG_CONTRACT", reason: `tx targets ${status.receiverId}` };
  // Only successful receipts executed by the contract count (a failed payout
  // transfer receipt doesn't invalidate the delivery_verified event before it).
  const events = status.receipts.filter((r) => !r.failed && r.executorId === contractId).flatMap((r) => parseEvents(r.logs));
  const found = events.some((e) => e.standard === "swarmcompute" && e.event === m.event && e.data.some((d) => m.match(d)));
  if (!found) return { ok: false, retry: false, code: "TX_EVENT_MISMATCH", reason: `no matching ${m.event} event in tx ${status.txHash}` };
  return { ok: true };
}

/** Default signer per message type, if the tx isn't in blockchain_transactions. */
const SIGNER_ROLE: Record<string, "operator" | "funder" | "verifier"> = {
  VERIFICATION_RESULT: "verifier",
};

export class PgMessageConfirmer {
  constructor(
    private readonly pool: pg.Pool,
    private readonly reader: ChainReader,
    private readonly signers: Record<"operator" | "funder" | "verifier", string>,
  ) {}

  async run(limit = 500): Promise<{ confirmed: number; rejected: number; pending: number }> {
    const { rows } = await this.pool.query<{ id: string; type: string; payload: Data; tx_hash: string; signer: string | null }>(
      `SELECT m.id, m.type, m.payload, m.tx_hash, t.signer_account_id AS signer
       FROM agent_messages m LEFT JOIN blockchain_transactions t ON t.tx_hash = m.tx_hash
       WHERE m.status = 'ACCEPTED' AND m.tx_hash IS NOT NULL
       ORDER BY m.id LIMIT $1`,
      [limit],
    );
    const cache = new Map<string, TxStatusView | null>();
    let confirmed = 0;
    let rejected = 0;
    let pending = 0;
    for (const r of rows) {
      // A prepayment is signed by the buyer's own wallet.
      const signer = r.signer ?? (r.type === "PREPAYMENT" && typeof r.payload.wallet === "string" ? r.payload.wallet : this.signers[SIGNER_ROLE[r.type] ?? "operator"]);
      const key = `${r.tx_hash}/${signer}`;
      if (!cache.has(key)) cache.set(key, await this.reader.txStatus(r.tx_hash, signer));
      const v = verifyMessageTx(r.type, r.payload, cache.get(key)!, this.reader.contractId);
      if (v.ok) {
        await this.pool.query("UPDATE agent_messages SET status = 'CONFIRMED', confirmed_at = now() WHERE id = $1", [r.id]);
        confirmed++;
      } else if (v.retry) {
        pending++;
      } else {
        await this.pool.query(
          "UPDATE agent_messages SET status = 'REJECTED', rejection_code = $2, rejection_detail = $3 WHERE id = $1",
          [r.id, v.code, v.reason],
        );
        rejected++;
      }
    }
    return { confirmed, rejected, pending };
  }
}
