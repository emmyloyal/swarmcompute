/**
 * Read-only public HTTP API for the frontend (spec Section 12).
 *
 * - Reads ONLY public_* views (RULES.md R13): no seller private pricing, no
 *   unrevealed bids, no ciphertexts, no message signatures.
 * - Holds no private keys and signs nothing.
 * - Money is returned as yocto decimal strings (RULES.md R3).
 *
 *   pnpm --filter @swarmcompute/backend api:start
 */
import { config as loadEnv } from "dotenv";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.env") });

const Env = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//),
  BACKEND_PORT: z.coerce.number().int().default(4000),
  MARKETPLACE_CONTRACT_ID: z.string().endsWith(".testnet"),
  NEAR_EXPLORER_TX_URL: z.string().url().refine((u) => /testnet/i.test(u)),
  NEAR_RPC_URL: z.string().url(),
});

// pg returns NUMERIC as strings already; keep BIGINT/timestamps JSON-safe too.
pg.types.setTypeParser(20, (v) => v); // int8 -> string

type Handler = (q: URLSearchParams, params: string[]) => Promise<unknown>;

export function buildRoutes(pool: pg.Pool, meta: Record<string, string>): [RegExp, Handler][] {
  const rows = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows as T[];

  return [
    [/^\/api\/meta$/, async () => ({ network: "testnet", ...meta })],

    [
      /^\/api\/overview$/,
      async () => {
        const [counts] = await rows(`
          SELECT (SELECT count(*) FROM public_buyers) AS buyers,
                 (SELECT count(*) FROM public_sellers) AS sellers,
                 (SELECT count(*) FROM public_coalitions) AS coalitions,
                 (SELECT count(*) FROM public_purchases) AS purchases,
                 (SELECT count(*) FROM public_transactions) AS transactions,
                 (SELECT count(*) FROM public_transactions WHERE status = 'FAILURE') AS failed_transactions,
                 (SELECT count(*) FROM public_agent_messages) AS messages,
                 (SELECT count(*) FROM public_agent_messages WHERE status = 'CONFIRMED') AS confirmed_messages,
                 (SELECT coalesce(sum(deposited_yocto), 0)::text FROM public_purchases
                    WHERE state IN ('FUNDED','DELIVERING','VERIFYING')
                       OR (state IN ('FAILED','EXPIRED') AND refund_in_flight)) AS escrow_held_yocto,
                 (SELECT coalesce(sum(amount_yocto), 0)::text FROM public_settlements WHERE status = 'SUCCEEDED') AS paid_out_yocto,
                 (SELECT coalesce(sum(total_yocto), 0)::text FROM public_refunds WHERE status = 'SUCCEEDED') AS refunded_yocto,
                 (SELECT coalesce(sum(amount_yocto), 0)::text FROM public_withdrawals WHERE status = 'SUCCEEDED') AS returned_to_wallets_yocto,
                 (SELECT coalesce(sum(excess_yocto), 0)::text FROM public_allocations) AS saved_vs_own_max_yocto,
                 (SELECT count(*) FROM public_allocations) AS member_settlements,
                 (SELECT count(*) FROM public_purchases WHERE drift_detected) AS drifted`);
        const byState = await rows(`SELECT state, count(*) AS n FROM public_purchases GROUP BY state`);
        const recentTx = await rows(`SELECT tx_hash, method_name, purpose, purchase_id, status, deposit_yocto::text, finalized_at
                                     FROM public_transactions ORDER BY submitted_at DESC LIMIT 8`);
        const outcomes = await rows(`
          SELECT p.purchase_id, p.state, p.winner_seller_id, p.deposited_yocto::text, p.updated_at,
                 s.tx_hash AS payout_tx, r.tx_hash AS refund_tx
          FROM public_purchases p
          LEFT JOIN public_settlements s ON s.purchase_id = p.purchase_id AND s.status = 'SUCCEEDED'
          LEFT JOIN public_refunds r ON r.purchase_id = p.purchase_id AND r.status = 'SUCCEEDED'
          WHERE p.state IN ('COMPLETED','REFUNDED') ORDER BY p.updated_at DESC LIMIT 6`);
        return { counts, byState, recentTx, outcomes };
      },
    ],

    [
      /^\/api\/buyers$/,
      async () =>
        rows(`
          SELECT b.*, b.max_budget_yocto::text, b.max_price_per_hour_yocto::text,
                 m.coalition_id, m.status AS membership_status, m.hours AS coalition_hours,
                 (SELECT coalesce(sum(a.owed_yocto), 0)::text FROM public_allocations a WHERE a.buyer_id = b.buyer_id) AS owed_yocto,
                 (SELECT coalesce(sum(a.excess_yocto), 0)::text FROM public_allocations a WHERE a.buyer_id = b.buyer_id) AS saved_yocto,
                 (SELECT coalesce(sum(w.amount_yocto), 0)::text FROM public_withdrawals w WHERE w.buyer_id = b.buyer_id AND w.status = 'SUCCEEDED') AS returned_yocto,
                 (SELECT count(*) FROM public_allocations a WHERE a.buyer_id = b.buyer_id) AS purchases
          FROM public_buyers b
          LEFT JOIN LATERAL (SELECT * FROM public_coalition_members x WHERE x.buyer_id = b.buyer_id ORDER BY x.joined_at DESC LIMIT 1) m ON TRUE
          ORDER BY b.buyer_id`),
    ],

    [
      /^\/api\/sellers$/,
      async () =>
        rows(`
          SELECT s.seller_id, s.payout_account_id, s.pricing_strategy, s.registration_tx_hash,
                 coalesce((SELECT json_agg(g ORDER BY g.gpu_model, g.vram_gb) FROM public_gpu_resources g WHERE g.seller_id = s.seller_id), '[]') AS offers,
                 to_json(r) AS reputation,
                 (SELECT count(*) FROM public_purchases p WHERE p.winner_seller_id = s.seller_id) AS awards,
                 (SELECT coalesce(sum(amount_yocto), 0)::text FROM public_settlements x WHERE x.seller_id = s.seller_id AND x.status = 'SUCCEEDED') AS paid_yocto
          FROM public_sellers s LEFT JOIN public_reputation r USING (seller_id)
          ORDER BY s.seller_id`),
    ],

    [
      /^\/api\/coalitions$/,
      async () =>
        rows(`
          SELECT c.*, c.price_ceiling_per_hour_yocto::text, c.total_budget_yocto::text,
                 coalesce((SELECT json_agg(m ORDER BY m.buyer_id) FROM public_coalition_members m WHERE m.coalition_id = c.coalition_id), '[]') AS members,
                 (SELECT json_agg(json_build_object('purchase_id', p.purchase_id, 'state', p.state) ORDER BY p.created_at)
                    FROM public_purchases p WHERE p.coalition_id = c.coalition_id) AS purchases
          FROM public_coalitions c ORDER BY c.created_at DESC`),
    ],

    [
      /^\/api\/auctions$/,
      async () =>
        rows(`
          SELECT a.*, p.state, p.winner_seller_id, p.winning_price_per_hour_yocto::text, p.required_total_yocto::text,
                 c.gpu_model, c.vram_gb, c.total_hours, c.price_ceiling_per_hour_yocto::text,
                 coalesce(k.commitment_count, 0) AS commitment_count, coalesce(k.reveal_count, 0) AS reveal_count,
                 coalesce((SELECT json_agg(json_build_object('seller_id', b.seller_id, 'commitment_hex', b.commitment_hex,
                            'commit_tx_hash', b.commit_tx_hash, 'revealed', b.revealed) ORDER BY b.created_at)
                           FROM public_bid_commitments b WHERE b.auction_id = a.auction_id), '[]') AS commitments,
                 coalesce((SELECT json_agg(json_build_object('seller_id', r.seller_id, 'price_per_hour_yocto', r.price_per_hour_yocto::text,
                            'reveal_tx_hash', r.reveal_tx_hash, 'eligible', r.eligible, 'ineligibility_reason', r.ineligibility_reason)
                            ORDER BY r.price_per_hour_yocto)
                           FROM public_bid_reveals r WHERE r.auction_id = a.auction_id), '[]') AS reveals
          FROM public_auctions a
          JOIN public_purchases p USING (purchase_id)
          JOIN public_coalitions c ON c.coalition_id = a.coalition_id
          LEFT JOIN public_auction_commitment_counts k USING (auction_id)
          ORDER BY a.created_at DESC`),
    ],

    [
      /^\/api\/purchases$/,
      async () =>
        rows(`SELECT p.*, p.deposited_yocto::text, p.required_total_yocto::text, p.winning_price_per_hour_yocto::text,
                     c.gpu_model, c.vram_gb, c.total_hours
              FROM public_purchases p JOIN public_coalitions c USING (coalition_id) ORDER BY p.created_at DESC`),
    ],

    [
      /^\/api\/purchases\/([a-z][a-z0-9-]{2,63})$/,
      async (_q, [id]) => {
        const [purchase] = await rows(
          `SELECT p.*, p.deposited_yocto::text, p.required_total_yocto::text, p.winning_price_per_hour_yocto::text,
                  c.gpu_model, c.vram_gb, c.total_hours, a.auction_id
           FROM public_purchases p JOIN public_coalitions c USING (coalition_id)
           LEFT JOIN public_auctions a USING (purchase_id) WHERE p.purchase_id = $1`,
          [id],
        );
        if (!purchase) return null;
        const q = (sql: string) => rows(sql, [id]);
        return {
          purchase,
          allocations: await q(
            `SELECT a.*, a.owed_yocto::text, a.prepaid_yocto::text, a.excess_yocto::text, a.refunded_yocto::text, a.max_price_per_hour_yocto::text,
                    b.wallet_account_id AS wallet,
                    (SELECT json_agg(json_build_object('amount_yocto', w.amount_yocto::text, 'tx_hash', w.tx_hash, 'status', w.status) ORDER BY w.created_at)
                       FROM public_withdrawals w WHERE w.buyer_id = a.buyer_id) AS withdrawals
             FROM public_allocations a JOIN public_buyers b USING (buyer_id) WHERE a.purchase_id = $1 ORDER BY a.max_price_per_hour_yocto DESC, a.buyer_id`,
          ),
          delivery: (await q(`SELECT * FROM public_deliveries WHERE purchase_id = $1`))[0] ?? null,
          verification: (await q(`SELECT * FROM public_verifications WHERE purchase_id = $1`))[0] ?? null,
          settlements: await q(`SELECT *, amount_yocto::text FROM public_settlements WHERE purchase_id = $1 ORDER BY settlement_id`),
          refunds: await q(`SELECT *, total_yocto::text FROM public_refunds WHERE purchase_id = $1 ORDER BY refund_id`),
          refundLines: await q(`SELECT *, amount_yocto::text FROM public_refund_lines WHERE purchase_id = $1 ORDER BY buyer_id`),
          transactions: await q(`SELECT *, deposit_yocto::text FROM public_transactions WHERE purchase_id = $1 ORDER BY submitted_at`),
          events: await q(`SELECT event, data, tx_hash, block_height FROM public_contract_events WHERE purchase_id = $1 ORDER BY block_height, log_index`),
        };
      },
    ],

    [
      /^\/api\/messages$/,
      async (q) => {
        const limit = Math.min(Number(q.get("limit") ?? 100) || 100, 500);
        const type = q.get("type");
        const status = q.get("status");
        return rows(
          `SELECT id, message_id, sender_id, receiver_id, type, sent_at, coalition_id, auction_id, purchase_id,
                  payload, status, rejection_code, tx_hash, received_at, confirmed_at
           FROM public_agent_messages
           WHERE ($1::text IS NULL OR type = $1) AND ($2::text IS NULL OR status = $2)
           ORDER BY id DESC LIMIT $3`,
          [type || null, status || null, limit],
        );
      },
    ],

    [/^\/api\/messages\/types$/, async () => rows(`SELECT type, count(*) AS n FROM public_agent_messages GROUP BY type ORDER BY type`)],
  ];
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(json);
}

async function main(): Promise<void> {
  const env = Env.parse(process.env);
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });
  const routes = buildRoutes(pool, {
    contractId: env.MARKETPLACE_CONTRACT_ID,
    explorerTxUrl: env.NEAR_EXPLORER_TX_URL,
    rpcUrl: env.NEAR_RPC_URL,
  });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET") return send(res, 405, { error: "read-only API" });
    const url = new URL(req.url ?? "/", "http://localhost");
    for (const [re, h] of routes) {
      const m = re.exec(url.pathname);
      if (!m) continue;
      try {
        const out = await h(url.searchParams, m.slice(1));
        return out === null ? send(res, 404, { error: "not found" }) : send(res, 200, out);
      } catch (err) {
        console.error(err);
        return send(res, 500, { error: "internal error" });
      }
    }
    send(res, 404, { error: "not found" });
  });
  server.listen(env.BACKEND_PORT, () => console.log(`SwarmCompute API (read-only) on http://localhost:${env.BACKEND_PORT}`));
}

if (process.argv[1]?.endsWith("server.ts")) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
