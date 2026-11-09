/**
 * Seller agents' bids: pricing (RULES.md R24, R16) and sealed secrets at rest (R13).
 *
 * The secret is saved BEFORE the commit transaction is sent, so a host that
 * crashes between commit and reveal can still reveal. It is wiped once the
 * reveal is on chain.
 */
import type pg from "pg";
import type { ContractCoalition, ContractSeller } from "../chain/marketplace.js";
import type { SealedBid } from "../crypto/bid-vault.js";

export type BidPlan = { bid: true; pricePerHour: bigint } | { bid: false; reason: "INACTIVE" | "GPU_MISMATCH" | "VRAM_TOO_LOW" | "INSUFFICIENT_CAPACITY" | "MIN_PRICE_ABOVE_CEILING" };

/** Whether and what a seller agent bids on a coalition, from its owner's on-chain terms only. */
export function planBid(seller: ContractSeller, c: ContractCoalition): BidPlan {
  if (!seller.opened || !seller.active) return { bid: false, reason: "INACTIVE" };
  const hours = c.members.reduce((s, m) => s + m.hours, 0);
  const model = seller.offers.filter((o) => o.gpu_model === c.gpu_model);
  if (model.length === 0) return { bid: false, reason: "GPU_MISMATCH" };
  const vram = model.filter((o) => o.vram_gb >= c.vram_gb);
  if (vram.length === 0) return { bid: false, reason: "VRAM_TOO_LOW" };
  if (!vram.some((o) => o.capacity_hours >= hours)) return { bid: false, reason: "INSUFFICIENT_CAPACITY" };
  // The contract only accepts bids at or below the lowest member max price.
  const ceiling = c.members.reduce((min, m) => (BigInt(m.max_price_per_hour) < min ? BigInt(m.max_price_per_hour) : min), BigInt(c.members[0]!.max_price_per_hour));
  const min = BigInt(seller.min_price_per_hour);
  if (min > ceiling) return { bid: false, reason: "MIN_PRICE_ABOVE_CEILING" };
  let price: bigint;
  switch (seller.strategy.kind) {
    case "AT_MINIMUM":
      price = min;
      break;
    case "BELOW_CEILING":
      price = (ceiling * BigInt(10_000 - seller.strategy.discount_bps)) / 10_000n;
      break;
  }
  if (price < min) price = min;
  if (price > ceiling) price = ceiling;
  return { bid: true, pricePerHour: price };
}

export interface StoredBid {
  auctionId: string;
  commitmentHex: string;
  sealed: SealedBid;
}

export interface BidStore {
  save(purchaseId: string, sellerId: string, bid: StoredBid): Promise<void>;
  get(purchaseId: string, sellerId: string): Promise<StoredBid | null>;
  /** Record the commit tx (the secret stays sealed). */
  committed(purchaseId: string, sellerId: string, txHash: string): Promise<void>;
  /** The reveal is on chain: wipe the secret. */
  revealed(purchaseId: string, sellerId: string, txHash: string): Promise<void>;
}

export class PgBidStore implements BidStore {
  constructor(private readonly pool: pg.Pool) {}
  async save(purchaseId: string, sellerId: string, b: StoredBid) {
    await this.pool.query(
      `INSERT INTO bid_secrets (purchase_id, seller_id, auction_id, commitment_hex, price_ciphertext, nonce_ciphertext, key_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (purchase_id, seller_id) DO NOTHING`,
      [purchaseId, sellerId, b.auctionId, b.commitmentHex, b.sealed.priceCiphertext, b.sealed.nonceCiphertext, b.sealed.keyVersion],
    );
  }
  async get(purchaseId: string, sellerId: string): Promise<StoredBid | null> {
    const { rows } = await this.pool.query<{ auction_id: string; commitment_hex: string; price_ciphertext: Buffer | null; nonce_ciphertext: Buffer | null; key_version: number }>(
      `SELECT auction_id, commitment_hex, price_ciphertext, nonce_ciphertext, key_version FROM bid_secrets WHERE purchase_id = $1 AND seller_id = $2`,
      [purchaseId, sellerId],
    );
    const r = rows[0];
    if (!r || !r.price_ciphertext || !r.nonce_ciphertext) return null;
    return { auctionId: r.auction_id, commitmentHex: r.commitment_hex, sealed: { priceCiphertext: r.price_ciphertext, nonceCiphertext: r.nonce_ciphertext, keyVersion: r.key_version } };
  }
  async committed(purchaseId: string, sellerId: string, txHash: string) {
    await this.pool.query(`UPDATE bid_secrets SET commit_tx_hash = $3 WHERE purchase_id = $1 AND seller_id = $2`, [purchaseId, sellerId, txHash]);
  }
  async revealed(purchaseId: string, sellerId: string, txHash: string) {
    await this.pool.query(
      `UPDATE bid_secrets SET reveal_tx_hash = $3, price_ciphertext = NULL, nonce_ciphertext = NULL WHERE purchase_id = $1 AND seller_id = $2`,
      [purchaseId, sellerId, txHash],
    );
  }
}

export class MemBidStore implements BidStore {
  readonly bids = new Map<string, StoredBid & { commitTx?: string; revealTx?: string; wiped?: boolean }>();
  private k(p: string, s: string) {
    return `${p}/${s}`;
  }
  async save(p: string, s: string, b: StoredBid) {
    if (!this.bids.has(this.k(p, s))) this.bids.set(this.k(p, s), { ...b });
  }
  async get(p: string, s: string) {
    const b = this.bids.get(this.k(p, s));
    return b && !b.wiped ? { auctionId: b.auctionId, commitmentHex: b.commitmentHex, sealed: b.sealed } : null;
  }
  async committed(p: string, s: string, tx: string) {
    const b = this.bids.get(this.k(p, s));
    if (b) b.commitTx = tx;
  }
  async revealed(p: string, s: string, tx: string) {
    const b = this.bids.get(this.k(p, s));
    if (b) Object.assign(b, { revealTx: tx, wiped: true });
  }
}
