import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContractPurchase } from "../src/chain/marketplace.js";
import type { ChainReader, TxStatusView } from "../src/chain/types.js";
import { migrate } from "../src/db/migrate.js";
import { PgMessageConfirmer, verifyMessageTx } from "../src/sync/confirm.js";
import { extractEvents, PgEventIndexer } from "../src/sync/indexer.js";
import { diffPurchase, PgReconciler } from "../src/sync/reconcile.js";

const MKT = "market.dev.testnet";
const ev = (event: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard: "swarmcompute", version: "1.0.0", event, data: [data] })}`;

function status(logs: string[], over: Partial<TxStatusView> = {}, receiptOver: Partial<TxStatusView["receipts"][number]> = {}): TxStatusView {
  return {
    txHash: "H".repeat(44),
    signerId: "dev.testnet",
    receiverId: MKT,
    ok: true,
    receipts: [{ receiptId: "r1", executorId: MKT, blockHash: "B1", logs, failed: false, ...receiptOver }],
    ...over,
  };
}

const COMMIT = { auction_id: "auction-1", seller_id: "seller-01", commitment_hex: "ab".repeat(32), tx_hash: "H".repeat(44) };

describe("verifyMessageTx", () => {
  const good = status([ev("bid_committed", { auction_id: "auction-1", seller_id: "seller-01", commitment: "ab".repeat(32) })]);

  it("confirms only when the tx emitted the matching event on the contract", () => {
    expect(verifyMessageTx("BID_COMMITMENT", COMMIT, good, MKT)).toEqual({ ok: true });
    expect(verifyMessageTx("BID_COMMITMENT", { ...COMMIT, seller_id: "seller-02" }, good, MKT)).toMatchObject({ ok: false, code: "TX_EVENT_MISMATCH" });
    expect(verifyMessageTx("BID_COMMITMENT", { ...COMMIT, commitment_hex: "cd".repeat(32) }, good, MKT)).toMatchObject({ code: "TX_EVENT_MISMATCH" });
  });

  it("rejects wrong contract, failed receipts and events from other executors; retries unknown txs", () => {
    expect(verifyMessageTx("BID_COMMITMENT", COMMIT, null, MKT)).toMatchObject({ ok: false, retry: true });
    expect(verifyMessageTx("BID_COMMITMENT", COMMIT, { ...good, receiverId: "evil.testnet" }, MKT)).toMatchObject({ code: "TX_WRONG_CONTRACT" });
    const failedReceipt = status(good.receipts[0]!.logs, {}, { failed: true });
    expect(verifyMessageTx("BID_COMMITMENT", COMMIT, failedReceipt, MKT)).toMatchObject({ code: "TX_EVENT_MISMATCH" });
    const otherExecutor = status(good.receipts[0]!.logs, {}, { executorId: "impostor.testnet" });
    expect(verifyMessageTx("BID_COMMITMENT", COMMIT, otherExecutor, MKT)).toMatchObject({ code: "TX_EVENT_MISMATCH" });
  });

  it("checks amounts and outcomes field by field", () => {
    const funded = status([ev("purchase_funded", { purchase_id: "purchase-1", clearing_price_per_hour: "4", amount: "40", members: [{ buyer_id: "buyer-001", hours: 10, prepaid: "70", owed: "40", excess: "30" }] })]);
    const f = { purchase_id: "purchase-1", buyer_id: "buyer-001", clearing_price_per_hour_yocto: "4", hours: 10, prepaid_yocto: "70", owed_yocto: "40", excess_yocto: "30", tx_hash: "H".repeat(44) };
    expect(verifyMessageTx("FUNDING_CONFIRMATION", f, funded, MKT)).toEqual({ ok: true });
    expect(verifyMessageTx("FUNDING_CONFIRMATION", { ...f, excess_yocto: "29", owed_yocto: "41" }, funded, MKT)).toMatchObject({ ok: false });
    expect(verifyMessageTx("FUNDING_CONFIRMATION", { ...f, buyer_id: "buyer-002" }, funded, MKT)).toMatchObject({ ok: false });
    const closed = status([ev("auction_closed", { purchase_id: "purchase-1", outcome: "AWARDED", winner_seller_id: "seller-01", winning_price_per_hour: "5" })]);
    const a = { outcome: "AWARDED", purchase_id: "purchase-1", winner_seller_id: "seller-01", winning_price_per_hour_yocto: "5" };
    expect(verifyMessageTx("AUCTION_RESULT", a, closed, MKT)).toEqual({ ok: true });
    expect(verifyMessageTx("AUCTION_RESULT", { ...a, winner_seller_id: "seller-02" }, closed, MKT)).toMatchObject({ ok: false });
    expect(verifyMessageTx("AUCTION_RESULT", { ...a, outcome: "FAILED" }, closed, MKT)).toMatchObject({ ok: false });
    // verify(success) whose payout transfer receipt failed: delivery_verified is still real.
    const verified: TxStatusView = {
      ...status([ev("delivery_verified", { purchase_id: "purchase-1", success: true })]),
      ok: false,
      receipts: [
        { receiptId: "r1", executorId: MKT, blockHash: "B1", logs: [ev("delivery_verified", { purchase_id: "purchase-1", success: true })], failed: false },
        { receiptId: "r2", executorId: "seller2.dev.testnet", blockHash: "B2", logs: [], failed: true },
      ],
    };
    expect(verifyMessageTx("VERIFICATION_RESULT", { purchase_id: "purchase-1", success: true }, verified, MKT)).toEqual({ ok: true });
    expect(verifyMessageTx("BUYER_REQUIREMENT", {}, good, MKT)).toMatchObject({ code: "NOT_ON_CHAIN_TYPE" });
  });
});

describe("extractEvents / diffPurchase", () => {
  it("keeps log order, skips failed receipts, other executors and foreign standards", () => {
    const s: TxStatusView = {
      ...status([]),
      receipts: [
        { receiptId: "r1", executorId: MKT, blockHash: "B1", logs: ["plain log", ev("a", {}), `EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1", event: "ft", data: [] })}`, ev("b", {})], failed: false },
        { receiptId: "r2", executorId: MKT, blockHash: "B2", logs: [ev("c", {})], failed: true },
        { receiptId: "r3", executorId: "x.testnet", blockHash: "B3", logs: [ev("d", {})], failed: false },
      ],
    };
    expect(extractEvents(s, MKT).map((e) => [e.receiptId, e.logIndex, e.event.event])).toEqual([
      ["r1", 1, "a"],
      ["r1", 3, "b"],
    ]);
  });

  it("reports every differing field and a purchase missing on-chain", () => {
    const db = { purchase_id: "purchase-1", state: "FUNDED", winner_seller_id: "seller-01", winning_price_per_hour_yocto: "5", required_total_yocto: "50", deposited_yocto: "50" };
    const chain = { state: "FUNDED", winner_seller_id: "seller-01", clearing_price_per_hour: "5", required_total: "50", deposited: "50" } as unknown as ContractPurchase;
    expect(diffPurchase(db, chain)).toEqual({});
    expect(diffPurchase(db, { ...chain, state: "REFUNDED", deposited: "50" })).toEqual({ state: { db: "FUNDED", chain: "REFUNDED" } });
    expect(diffPurchase(db, null)).toEqual({ purchase: { db: "purchase-1", chain: null } });
  });
});

// ---------------------------------------------------------------- Postgres

loadEnv({ path: resolve(__dirname, "../../../.env") });
const url = process.env.DATABASE_URL;
const schema = `test_sync_${process.pid}_${Date.now()}`;
async function reachable() {
  if (!url) return false;
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}
const enabled = await reachable();

class FakeReader implements ChainReader {
  contractId = MKT;
  txs = new Map<string, TxStatusView>();
  purchases = new Map<string, ContractPurchase>();
  totalEscrowed = 0n;
  async txStatus(h: string) {
    return this.txs.get(h) ?? null;
  }
  async block(hash: string) {
    return { height: BigInt(hash.length * 100), timestampNs: 1n };
  }
  async view<T>(method: string, args: Record<string, unknown> = {}) {
    if (method === "get_purchase") return (this.purchases.get(args.purchase_id as string) ?? null) as T;
    if (method === "get_config") return { total_escrowed: this.totalEscrowed.toString() } as T;
    throw new Error(method);
  }
}

describe.skipIf(!enabled)("sync jobs on Postgres", () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  const H1 = "1".repeat(44);
  const H2 = "2".repeat(44);
  const H3 = "3".repeat(44);

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    const u = new URL(url!);
    u.searchParams.set("options", `-c search_path=${schema}`);
    await migrate(u.toString(), () => {});
    pool = new pg.Pool({ connectionString: u.toString() });
    await pool.query("INSERT INTO agents (agent_id, kind, display_name) VALUES ('seller-01','SELLER','s'), ('auction-coordinator','AUCTION_COORDINATOR','c')");
    await pool.query("INSERT INTO sellers (seller_id, agent_id, payout_account_id, pricing_strategy, min_price_per_hour_yocto, failure_probability_bps) VALUES ('seller-01','seller-01','p.testnet','FLEXIBLE',1,0)");
    for (const h of [H1, H2, H3]) {
      await pool.query("INSERT INTO blockchain_transactions (tx_hash, signer_account_id, receiver_id, method_name, purpose, status) VALUES ($1,'dev.testnet',$2,'commit_bid','commit_bid','SUCCESS')", [h, MKT]);
    }
    const msg = (id: string, h: string, commitment: string) =>
      pool.query(
        `INSERT INTO agent_messages (message_id, sender_id, receiver_id, type, sent_at, auction_id, payload, signature, status, tx_hash)
         VALUES ($1, 'seller-01', 'auction-coordinator', 'BID_COMMITMENT', now(), 'auction-1', $2, $3, 'ACCEPTED', $4)`,
        [id, JSON.stringify({ ...COMMIT, commitment_hex: commitment, tx_hash: h }), "f".repeat(64), h],
      );
    await msg("00000000-0000-4000-8000-000000000001", H1, "ab".repeat(32)); // genuine
    await msg("00000000-0000-4000-8000-000000000002", H2, "ab".repeat(32)); // tx exists but emitted something else
    await msg("00000000-0000-4000-8000-000000000003", H3, "ab".repeat(32)); // tx not visible yet
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("indexes events idempotently, snapshots reputation, and confirms or rejects messages", async () => {
    const r = new FakeReader();
    r.txs.set(H1, {
      ...status([ev("bid_committed", { purchase_id: "purchase-1", auction_id: "auction-1", seller_id: "seller-01", commitment: "ab".repeat(32) }), ev("reputation_updated", { seller_id: "seller-01", purchase_id: "purchase-1", reputation: { wins: 1, completed_deliveries: 0, failed_deliveries: 0, non_reveals: 0 } })]),
      txHash: H1,
    });
    r.txs.set(H2, { ...status([ev("bid_revealed", { auction_id: "auction-1", seller_id: "seller-01" })], {}, { receiptId: "r2" }), txHash: H2 });

    const idx = new PgEventIndexer(pool, r);
    expect(await idx.run()).toEqual({ txs: 2, events: 3, reputation: 1, notFound: 1 });
    expect((await idx.run()).events).toBe(0); // H1/H2 are marked indexed; H3 still not visible
    const evs = await pool.query("SELECT event, purchase_id FROM contract_events ORDER BY id");
    expect(evs.rows.map((x) => x.event)).toEqual(["bid_committed", "reputation_updated", "bid_revealed"]);
    expect(evs.rows[0].purchase_id).toBe("purchase-1");

    const conf = await new PgMessageConfirmer(pool, r, { operator: "dev.testnet", funder: "dev.testnet", verifier: "dev.testnet" }).run();
    expect(conf).toEqual({ confirmed: 1, rejected: 1, pending: 1 });
    const rows = (await pool.query("SELECT message_id, status, rejection_code FROM agent_messages ORDER BY message_id")).rows;
    expect(rows.map((x) => [x.status, x.rejection_code])).toEqual([
      ["CONFIRMED", null],
      ["REJECTED", "TX_EVENT_MISMATCH"],
      ["ACCEPTED", null],
    ]);
  });

  it("flags drift without overwriting cached facts; checks escrow is fully explained", async () => {
    await pool.query("INSERT INTO agents (agent_id, kind, display_name) VALUES ('coalition-agent','COALITION','c') ON CONFLICT DO NOTHING");
    await pool.query(
      `INSERT INTO coalitions (coalition_id, gpu_model, vram_gb, total_hours, price_ceiling_per_hour_yocto, total_budget_yocto, delivery_deadline, min_members, formation_seed)
       VALUES ('coalition-1','A100',80,10,10,1000, now() + interval '1 day', 1, 's')`,
    );
    await pool.query(
      `INSERT INTO purchases (purchase_id, coalition_id, state, winner_seller_id, winning_price_per_hour_yocto, required_total_yocto, deposited_yocto)
       VALUES ('purchase-1','coalition-1','FUNDED','seller-01',5,50,50)`,
    );
    const r = new FakeReader();
    const chainP = { state: "FUNDED", winner_seller_id: "seller-01", clearing_price_per_hour: "5", required_total: "50", deposited: "50", held: "50" } as unknown as ContractPurchase;
    r.purchases.set("purchase-1", chainP);
    r.totalEscrowed = 50n;
    const rec = new PgReconciler(pool, r);
    expect(await rec.run()).toMatchObject({ checked: 1, drifted: [], escrow: { unexplained: 0n } });

    // Someone else expired + refunded it on-chain.
    r.purchases.set("purchase-1", { ...chainP, state: "REFUNDED", held: "0" });
    r.totalEscrowed = 7n; // and there is escrow the backend does not know about
    const out = await rec.run();
    expect(out.drifted).toEqual(["purchase-1"]);
    expect(out.escrow.unexplained).toBe(7n);
    const row = (await pool.query("SELECT state, drift_detected, drift_detail FROM purchases")).rows[0];
    expect(row.state).toBe("FUNDED"); // not overwritten
    expect(row.drift_detected).toBe(true);
    expect(row.drift_detail).toEqual({ state: { db: "FUNDED", chain: "REFUNDED" } });
  });
});
