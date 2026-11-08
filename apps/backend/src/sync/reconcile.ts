/**
 * Reconciler (spec Section 13, RULES.md R15): the contract is authoritative.
 *
 * Compares every cached purchase with `get_purchase`. Differences are recorded
 * in purchases.drift_detected / drift_detail; chain facts are never overwritten
 * by this job. Also checks that the contract's total_escrowed is fully
 * explained by purchases the backend knows about.
 */
import type pg from "pg";
import type { ContractPurchase } from "../chain/marketplace.js";
import type { ChainReader } from "../chain/types.js";

export interface PurchaseRow {
  purchase_id: string;
  state: string;
  winner_seller_id: string | null;
  winning_price_per_hour_yocto: string | null;
  required_total_yocto: string | null;
  deposited_yocto: string;
}

export type Drift = Record<string, { db: string | null; chain: string | null }>;

const norm = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function diffPurchase(db: PurchaseRow, chain: ContractPurchase | null): Drift {
  if (!chain) return { purchase: { db: db.purchase_id, chain: null } };
  const pairs: [string, unknown, unknown][] = [
    ["state", db.state, chain.state],
    ["winner_seller_id", db.winner_seller_id, chain.winner_seller_id],
    ["clearing_price_per_hour", db.winning_price_per_hour_yocto, chain.clearing_price_per_hour],
    ["required_total", db.required_total_yocto, chain.required_total],
    ["deposited", db.deposited_yocto, chain.deposited],
  ];
  const d: Drift = {};
  for (const [k, a, b] of pairs) if (norm(a) !== norm(b)) d[k] = { db: norm(a), chain: norm(b) };
  return d;
}

export class PgReconciler {
  constructor(
    private readonly pool: pg.Pool,
    private readonly reader: ChainReader,
  ) {}

  async run(): Promise<{ checked: number; drifted: string[]; escrow: { chainTotal: bigint; explained: bigint; unexplained: bigint } }> {
    const { rows } = await this.pool.query<PurchaseRow>(
      `SELECT purchase_id, state, winner_seller_id, winning_price_per_hour_yocto::text, required_total_yocto::text, deposited_yocto::text
       FROM purchases ORDER BY purchase_id`,
    );
    const drifted: string[] = [];
    let explained = 0n;
    for (const r of rows) {
      const chain = await this.reader.view<ContractPurchase | null>("get_purchase", { purchase_id: r.purchase_id });
      if (chain) explained += BigInt(chain.held);
      const d = diffPurchase(r, chain);
      const has = Object.keys(d).length > 0;
      if (has) drifted.push(r.purchase_id);
      await this.pool.query(
        "UPDATE purchases SET drift_detected = $2, drift_detail = $3, last_synced_at = now() WHERE purchase_id = $1",
        [r.purchase_id, has, has ? JSON.stringify(d) : null],
      );
    }
    const cfg = await this.reader.view<{ total_escrowed: string }>("get_config");
    const chainTotal = BigInt(cfg.total_escrowed);
    return { checked: rows.length, drifted, escrow: { chainTotal, explained, unexplained: chainTotal - explained } };
  }
}
