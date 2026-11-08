/**
 * Postgres CoalitionStore: coalitions, coalition_members and the matching
 * buyer_requirements status (OPEN <-> IN_COALITION).
 */
import type pg from "pg";
import type { CoalitionStatus, CoalitionStore, MemberStatus } from "../agents/coalition-agent.js";
import type { PlannedCoalition } from "../coalition/form.js";

export class PgCoalitionStore implements CoalitionStore {
  constructor(private readonly pool: pg.Pool) {}

  async saveProposed(plan: PlannedCoalition): Promise<void> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(
        `INSERT INTO coalitions (coalition_id, gpu_model, vram_gb, total_hours, price_ceiling_per_hour_yocto,
                                 total_budget_yocto, delivery_deadline, min_members, formation_seed, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PROPOSED')`,
        [
          plan.coalitionId,
          plan.gpuModel,
          plan.vramGb,
          plan.totalHours,
          plan.priceCeilingPerHourYocto.toString(),
          plan.totalBudgetYocto.toString(),
          plan.deliveryDeadline.toISOString(),
          plan.minMembers,
          plan.formationSeed,
        ],
      );
      for (const m of plan.members) {
        const req = await db.query<{ requirement_id: string }>(
          "SELECT requirement_id FROM buyer_requirements WHERE buyer_id = $1 AND status IN ('OPEN','IN_COALITION')",
          [m.buyerId],
        );
        if (!req.rows[0]) throw new Error(`no open requirement for ${m.buyerId}`);
        await db.query(
          "INSERT INTO coalition_members (coalition_id, buyer_id, requirement_id, hours, status) VALUES ($1, $2, $3, $4, 'PROPOSED')",
          [plan.coalitionId, m.buyerId, req.rows[0].requirement_id, m.hours],
        );
      }
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    } finally {
      db.release();
    }
  }

  async setMember(coalitionId: string, buyerId: string, status: MemberStatus): Promise<void> {
    await this.pool.query(
      `UPDATE coalition_members SET status = $3, left_at = CASE WHEN $3 = 'LEFT' THEN now() ELSE NULL END
       WHERE coalition_id = $1 AND buyer_id = $2`,
      [coalitionId, buyerId, status],
    );
    if (status === "ACCEPTED") {
      await this.pool.query("UPDATE buyer_requirements SET status = 'IN_COALITION' WHERE buyer_id = $1 AND status = 'OPEN'", [buyerId]);
    } else if (status === "REJECTED" || status === "LEFT") {
      await this.pool.query("UPDATE buyer_requirements SET status = 'OPEN' WHERE buyer_id = $1 AND status = 'IN_COALITION'", [buyerId]);
    }
  }

  async setStatus(coalitionId: string, status: CoalitionStatus, plan: PlannedCoalition, failureReason?: string): Promise<void> {
    await this.pool.query(
      `UPDATE coalitions SET status = $2, failure_reason = $3, total_hours = $4,
              price_ceiling_per_hour_yocto = $5, total_budget_yocto = $6, updated_at = now()
       WHERE coalition_id = $1`,
      [coalitionId, status, failureReason ?? null, plan.totalHours, plan.priceCeilingPerHourYocto.toString(), plan.totalBudgetYocto.toString()],
    );
    if (status === "FAILED") {
      // Members of a failed coalition are free to be regrouped.
      await this.pool.query(
        `UPDATE buyer_requirements r SET status = 'OPEN'
         FROM coalition_members m
         WHERE m.coalition_id = $1 AND m.buyer_id = r.buyer_id AND r.status = 'IN_COALITION'`,
        [coalitionId],
      );
    }
  }
}
