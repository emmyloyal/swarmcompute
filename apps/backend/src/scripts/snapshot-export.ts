/**
 * Export a static snapshot of the public API for a frontend hosted without a
 * backend (e.g. Vercel). Uses the same read-only route handlers as the API, so
 * it contains only public_* view data: no secrets, no seller private pricing,
 * no unrevealed bids, no signatures (RULES.md R13).
 *
 *   pnpm --filter @swarmcompute/backend snapshot:export
 *
 * Writes apps/frontend/public/snapshot/*.json. Re-run after new demo runs, then commit and redeploy.
 */
import { config as loadEnv } from "dotenv";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildRoutes } from "../api/server.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
loadEnv({ path: resolve(ROOT, ".env") });
const OUT = resolve(ROOT, "apps/frontend/public/snapshot");

async function main(): Promise<void> {
  const env = process.env;
  for (const k of ["DATABASE_URL", "MARKETPLACE_CONTRACT_ID", "NEAR_EXPLORER_TX_URL", "NEAR_RPC_URL"]) {
    if (!env[k]) throw new Error(`${k} is not set`);
  }
  if (!env.MARKETPLACE_CONTRACT_ID!.endsWith(".testnet")) throw new Error("testnet only");
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const routes = buildRoutes(pool, { contractId: env.MARKETPLACE_CONTRACT_ID!, explorerTxUrl: env.NEAR_EXPLORER_TX_URL!, rpcUrl: env.NEAR_RPC_URL! });
  const call = async (path: string) => {
    const url = new URL(path, "http://snapshot");
    for (const [re, h] of routes) {
      const m = re.exec(url.pathname);
      if (m) return h(url.searchParams, m.slice(1));
    }
    throw new Error(`no route for ${path}`);
  };
  const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  try {
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(resolve(OUT, "purchases"), { recursive: true });
    const write = (file: string, data: unknown) => writeFileSync(resolve(OUT, file), json(data), "utf8");

    for (const [file, path] of [
      ["meta.json", "/api/meta"],
      ["overview.json", "/api/overview"],
      ["buyers.json", "/api/buyers"],
      ["sellers.json", "/api/sellers"],
      ["coalitions.json", "/api/coalitions"],
      ["auctions.json", "/api/auctions"],
      ["messages.json", "/api/messages?limit=500"],
      ["message-types.json", "/api/messages/types"],
    ] as const) {
      write(file, await call(path));
    }
    const purchases = (await call("/api/purchases")) as { purchase_id: string }[];
    write("purchases.json", purchases);
    for (const p of purchases) write(`purchases/${p.purchase_id}.json`, await call(`/api/purchases/${p.purchase_id}`));
    write("info.json", { taken_at: new Date().toISOString(), contract_id: env.MARKETPLACE_CONTRACT_ID, purchases: purchases.length });
    console.log(`snapshot: ${purchases.length} purchases + overview, buyers, sellers, coalitions, auctions, messages → ${OUT}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
