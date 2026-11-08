/**
 * Postgres integration (agent_messages replay index, logging of malformed
 * rejects, idempotent swarm persistence). Runs in a throwaway schema; skipped
 * when DATABASE_URL is unset or the database is unreachable.
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_AGENTS } from "@swarmcompute/shared";
import { Swarm } from "../src/agents/swarm.js";
import { BidVault } from "../src/crypto/bid-vault.js";
import { persistSwarm } from "../src/db/agents-repo.js";
import { migrate } from "../src/db/migrate.js";
import { PgMessageLog } from "../src/messaging/pg-log.js";

loadEnv({ path: resolve(__dirname, "../../../.env") });
const url = process.env.DATABASE_URL;
const schema = `test_${process.pid}_${Date.now()}`;

async function reachable(): Promise<boolean> {
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

function scopedUrl(): string {
  const u = new URL(url!);
  u.searchParams.set("options", `-c search_path=${schema}`);
  return u.toString();
}

describe.skipIf(!enabled)("Postgres integration", () => {
  let admin: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(scopedUrl(), () => {});
    pool = new pg.Pool({ connectionString: scopedUrl() });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const NOW = new Date();
  const mkSwarm = () =>
    new Swarm({
      seed: "pg-test-seed",
      masterSecret: Buffer.alloc(32, 3),
      payoutAccounts: [1, 2, 3, 4, 5].map((i) => `seller${i}.op.testnet`),
      baseTime: NOW,
      log: new PgMessageLog(pool),
      vault: new BidVault(Buffer.alloc(32, 4)),
      maxAgeMs: 300_000,
      clock: () => NOW,
    });

  it("persists the swarm idempotently", async () => {
    const s = mkSwarm();
    const profiles = [s.buyers.map((b) => b.profile), s.sellers.map((x) => x.profile)] as const;
    await persistSwarm(pool, ...profiles);
    await persistSwarm(pool, ...profiles);
    const count = async (t: string) => Number((await pool.query(`SELECT count(*) FROM ${t}`)).rows[0].count);
    expect(await count("buyers")).toBe(20);
    expect(await count("sellers")).toBe(5);
    expect(await count("agents")).toBe(20 + 5 + 5);
    expect(await count("buyer_requirements")).toBe(20);
    expect(await count("gpu_resources")).toBe(s.sellers.reduce((k, x) => k + x.profile.offers.length, 0));
    // Private seller fields exist only in `sellers`, not in the public view.
    const cols = (await pool.query("SELECT * FROM public_sellers LIMIT 1")).fields.map((f) => f.name);
    expect(cols).not.toContain("min_price_per_hour_yocto");
    expect(cols).not.toContain("failure_probability_bps");
  });

  it("logs every message; the unique index blocks replays", async () => {
    const s = mkSwarm();
    const r = await s.announce();
    expect(r.rejected).toBe(0);
    const m = s.buyer("buyer-001").requirementMessage();
    expect((await s.bus.send(m)).ok).toBe(true);
    expect(await s.bus.send(m)).toMatchObject({ ok: false, code: "REPLAY" });
    // Malformed garbage is still logged as REJECTED.
    expect(await s.bus.send({ type: "BUYER_REQUIREMENT", message_id: 42, payload: "x".repeat(10), timestamp: "not a date" })).toMatchObject({ ok: false });
    expect(await s.bus.send(17)).toMatchObject({ ok: false, code: "MALFORMED_ENVELOPE" });

    const rows = (await pool.query("SELECT status, rejection_code, message_id FROM agent_messages")).rows;
    expect(rows.filter((x) => x.status === "ACCEPTED")).toHaveLength(r.sent + 1);
    expect(rows.filter((x) => x.rejection_code === "REPLAY")).toHaveLength(1);
    expect(rows.filter((x) => x.status === "REJECTED")).toHaveLength(3);
    const accepted = rows.filter((x) => x.message_id === m.message_id && x.status === "ACCEPTED");
    expect(accepted).toHaveLength(1);
    // public view is readable
    const pub = await pool.query("SELECT count(*) FROM public_agent_messages WHERE receiver_id = $1", [SYSTEM_AGENTS.COALITION]);
    expect(Number(pub.rows[0].count)).toBeGreaterThan(0);
  });
});
