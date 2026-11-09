/** host_activity: what the market host did and why (RULES.md R2: only real outcomes). */
import type pg from "pg";
import type { ActivityEntry, ActivitySink } from "./market.js";

export class PgActivity implements ActivitySink {
  constructor(private readonly pool: pg.Pool) {}
  async add(e: ActivityEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO host_activity (level, kind, message, purchase_id, agent_id, tx_hash, simulated) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [e.level, e.kind, e.message, e.purchaseId ?? null, e.agentId ?? null, e.txHash ?? null, e.simulated ?? false],
    );
  }
}

export class MemActivity implements ActivitySink {
  readonly entries: ActivityEntry[] = [];
  async add(e: ActivityEntry) {
    this.entries.push(e);
  }
}
