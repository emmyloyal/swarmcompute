/**
 * Persists the agent swarm (agents, buyers, sellers, gpu_resources,
 * buyer_requirements). Idempotent: rerunning with the same profiles is a no-op.
 * Private seller parameters go only into `sellers`, which the public API never
 * reads directly (it uses `public_sellers`).
 */
import type pg from "pg";
import { SYSTEM_AGENTS } from "@swarmcompute/shared";
import type { BuyerProfile, SellerProfile } from "../sim/profiles.js";

const SYSTEM_KINDS: Record<string, string> = {
  [SYSTEM_AGENTS.COALITION]: "COALITION",
  [SYSTEM_AGENTS.AUCTION_COORDINATOR]: "AUCTION_COORDINATOR",
  [SYSTEM_AGENTS.VERIFICATION]: "VERIFICATION",
  [SYSTEM_AGENTS.REPUTATION]: "REPUTATION",
  [SYSTEM_AGENTS.TREASURY]: "TREASURY",
};

export async function persistSwarm(pool: pg.Pool, buyers: BuyerProfile[], sellers: SellerProfile[]): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const agent = (id: string, kind: string, name: string) =>
      db.query(
        "INSERT INTO agents (agent_id, kind, display_name, is_simulated) VALUES ($1, $2, $3, TRUE) ON CONFLICT (agent_id) DO NOTHING",
        [id, kind, name],
      );

    for (const [id, kind] of Object.entries(SYSTEM_KINDS)) await agent(id, kind, id);

    for (const b of buyers) {
      await agent(b.agentId, "BUYER", `Buyer ${b.buyerId.slice(-3)} (simulated)`);
      await db.query(
        `INSERT INTO buyers (buyer_id, agent_id, max_budget_yocto, wallet_account_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (buyer_id) DO UPDATE SET max_budget_yocto = EXCLUDED.max_budget_yocto,
           wallet_account_id = EXCLUDED.wallet_account_id, updated_at = now()`,
        [b.buyerId, b.agentId, b.maxBudgetYocto.toString(), b.wallet.endsWith(".testnet") ? b.wallet : null],
      );
      await db.query(
        `INSERT INTO buyer_requirements
           (buyer_id, gpu_model, min_vram_gb, required_hours, max_price_per_hour_yocto, latest_delivery_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (buyer_id) WHERE status IN ('OPEN','IN_COALITION') DO NOTHING`,
        [b.buyerId, b.gpuModel, b.minVramGb, b.requiredHours, b.maxPricePerHourYocto.toString(), b.latestDeliveryAt.toISOString()],
      );
    }

    for (const s of sellers) {
      await agent(s.agentId, "SELLER", `Seller ${s.sellerId.slice(-2)} · ${s.strategy} (simulated)`);
      await db.query(
        `INSERT INTO sellers (seller_id, agent_id, payout_account_id, pricing_strategy, min_price_per_hour_yocto, failure_probability_bps)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (seller_id) DO UPDATE SET
           pricing_strategy = EXCLUDED.pricing_strategy,
           min_price_per_hour_yocto = EXCLUDED.min_price_per_hour_yocto,
           failure_probability_bps = EXCLUDED.failure_probability_bps`,
        [s.sellerId, s.agentId, s.payoutAccount, s.strategy, s.minPricePerHourYocto.toString(), s.failureProbabilityBps],
      );
      for (const o of s.offers) {
        await db.query(
          `INSERT INTO gpu_resources (seller_id, gpu_model, vram_gb, capacity_hours, delivery_time_minutes)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (seller_id, gpu_model, vram_gb) DO UPDATE SET
             capacity_hours = EXCLUDED.capacity_hours, delivery_time_minutes = EXCLUDED.delivery_time_minutes`,
          [s.sellerId, o.gpuModel, o.vramGb, o.capacityHours, o.deliveryTimeMinutes],
        );
      }
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}
