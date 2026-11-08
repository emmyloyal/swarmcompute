/**
 * Postgres AuctionStore: purchases, auctions, bid_commitments, bid_reveals,
 * allocations (per-member fairness record) and withdrawals. The DB is a cache of
 * contract state (RULES.md R15); every row is written right after the tx that
 * made it true on-chain, with its hash.
 *
 * Unrevealed prices and nonces exist only as AES-256-GCM ciphertext and are
 * wiped once the reveal is final on-chain (RULES.md R13).
 */
import type pg from "pg";
import type { AuctionStore, PurchaseRun } from "../auction/engine.js";
import type { ContractPurchase } from "../chain/marketplace.js";
import type { TxResult } from "../chain/types.js";
import type { SealedBid } from "../crypto/bid-vault.js";

const ts = (ns: string | null | undefined) => (ns ? new Date(Number(BigInt(ns) / 1_000_000n)).toISOString() : null);

export async function recordWithdrawal(pool: pg.Pool, buyerId: string, wallet: string, amount: bigint, ok: boolean, tx: TxResult): Promise<void> {
  await pool.query(
    "INSERT INTO withdrawals (buyer_id, wallet, amount_yocto, status, tx_hash) VALUES ($1, $2, $3, $4, $5)",
    [buyerId, wallet, amount.toString(), ok ? "SUCCEEDED" : "FAILED", tx.txHash],
  );
}

export class PgAuctionStore implements AuctionStore {
  private readonly prepayTx = new Map<string, string>();

  constructor(private readonly pool: pg.Pool) {}

  async purchaseCreated(r: PurchaseRun, p: ContractPurchase, tx: TxResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO purchases (purchase_id, coalition_id, state, last_synced_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (purchase_id) DO UPDATE SET state = EXCLUDED.state, last_synced_at = now(), updated_at = now()`,
      [r.purchaseId, r.coalitionId, p.state],
    );
    await this.pool.query("UPDATE coalitions SET status = 'AUCTIONING', updated_at = now() WHERE coalition_id = $1", [r.coalitionId]);
    this.lastCreateTx.set(r.purchaseId, tx.txHash);
  }
  private readonly lastCreateTx = new Map<string, string>();

  async prepaid(purchaseId: string, buyerId: string, amount: bigint, tx: TxResult): Promise<void> {
    this.prepayTx.set(`${purchaseId}/${buyerId}`, tx.txHash);
    await this.pool.query(
      "UPDATE purchases SET deposited_yocto = deposited_yocto + $2, updated_at = now() WHERE purchase_id = $1",
      [purchaseId, amount.toString()],
    );
  }

  async bidCommitted(purchaseId: string, auctionId: string, sellerId: string, commitmentHex: string, sealed: SealedBid, tx: TxResult): Promise<void> {
    await this.ensureAuction(purchaseId, auctionId);
    await this.pool.query(
      `INSERT INTO bid_commitments (auction_id, seller_id, commitment_hex, commit_tx_hash, price_ciphertext, nonce_ciphertext, enc_key_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [auctionId, sellerId, commitmentHex, tx.txHash, sealed.priceCiphertext, sealed.nonceCiphertext, sealed.keyVersion],
    );
  }

  /** The auctions row needs the on-chain deadlines, known once bidding opened. */
  private async ensureAuction(purchaseId: string, auctionId: string): Promise<void> {
    const exists = await this.pool.query("SELECT 1 FROM auctions WHERE auction_id = $1", [auctionId]);
    if (exists.rowCount) return;
    throw new Error(`auction ${auctionId} not recorded; call auctionOpened first`);
  }

  async auctionOpened(r: PurchaseRun, p: ContractPurchase): Promise<void> {
    await this.pool.query(
      `INSERT INTO auctions (auction_id, purchase_id, coalition_id, commit_deadline, reveal_deadline, create_tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (auction_id) DO NOTHING`,
      [r.auctionId, r.purchaseId, r.coalitionId, ts(p.commit_deadline), ts(p.reveal_deadline), this.lastCreateTx.get(r.purchaseId) ?? null],
    );
    await this.pool.query("UPDATE purchases SET state = $2, updated_at = now() WHERE purchase_id = $1", [r.purchaseId, p.state]);
  }

  async bidRevealed(auctionId: string, sellerId: string, price: bigint, nonceHex: string, tx: TxResult): Promise<void> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(
        `INSERT INTO bid_reveals (auction_id, seller_id, price_per_hour_yocto, nonce_hex, reveal_tx_hash, hash_verified)
         VALUES ($1, $2, $3, $4, $5, TRUE)`,
        [auctionId, sellerId, price.toString(), nonceHex, tx.txHash],
      );
      await db.query(
        `UPDATE bid_commitments SET revealed = TRUE, price_ciphertext = NULL, nonce_ciphertext = NULL, enc_key_version = NULL
         WHERE auction_id = $1 AND seller_id = $2`,
        [auctionId, sellerId],
      );
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    } finally {
      db.release();
    }
  }

  async auctionClosed(r: PurchaseRun, p: ContractPurchase, tx: TxResult): Promise<void> {
    const funded = p.state === "FUNDED";
    await this.pool.query("UPDATE auctions SET closed_at = now(), outcome = $2, close_tx_hash = $3 WHERE auction_id = $1", [
      r.auctionId,
      funded ? "AWARDED" : "FAILED",
      tx.txHash,
    ]);
    await this.pool.query(
      `UPDATE purchases SET state = $2, winner_seller_id = $3, winning_price_per_hour_yocto = $4, required_total_yocto = $5,
              deposited_yocto = $6, delivery_deadline = $7, last_synced_at = now(), updated_at = now()
       WHERE purchase_id = $1`,
      [r.purchaseId, p.state, p.winner_seller_id, p.clearing_price_per_hour, p.required_total, p.deposited, ts(p.delivery_deadline)],
    );
    for (const b of p.bids) {
      if (b.revealed_price_per_hour !== null) {
        await this.pool.query("UPDATE bid_reveals SET eligible = $3, ineligibility_reason = $4 WHERE auction_id = $1 AND seller_id = $2", [
          r.auctionId,
          b.seller_id,
          b.eligible,
          b.ineligibility_reason,
        ]);
      }
      await this.pool.query("UPDATE bid_commitments SET commit_block_height = $3 WHERE auction_id = $1 AND seller_id = $2", [
        r.auctionId,
        b.seller_id,
        b.commit_block_height,
      ]);
    }
    if (funded) {
      // One row per member: the same clearing rate for everyone, prepaid = owed + excess.
      for (const a of p.allocations) {
        await this.pool.query(
          `INSERT INTO allocations (purchase_id, buyer_id, hours, amount_yocto, approval, record_tx_hash,
                                   max_price_per_hour_yocto, prepaid_yocto, excess_yocto, prepay_tx_hash)
           VALUES ($1, $2, $3, $4, 'PREPAID_ON_CHAIN', $5, $6, $7, $8, $9)
           ON CONFLICT (purchase_id, buyer_id) DO NOTHING`,
          [r.purchaseId, a.buyer_id, a.hours, a.owed, tx.txHash, a.max_price_per_hour, a.prepaid, a.excess, this.prepayTx.get(`${r.purchaseId}/${a.buyer_id}`) ?? null],
        );
      }
      await this.pool.query("UPDATE coalitions SET status = 'FUNDED', updated_at = now() WHERE coalition_id = $1", [r.coalitionId]);
    }
  }

  async withdrawal(buyerId: string, wallet: string, amount: bigint, ok: boolean, tx: TxResult): Promise<void> {
    await recordWithdrawal(this.pool, buyerId, wallet, amount, ok, tx);
  }
}
