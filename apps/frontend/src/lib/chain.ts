/**
 * Market data straight from the marketplace contract over the public NEAR
 * Testnet RPC. Used when the market host isn't reachable, so the site still
 * shows the real market: the contract is authoritative (RULES.md R15).
 *
 * What only the host knows (why a request is waiting, which agents it runs,
 * its activity log) is left empty here, and the UI says so.
 */
import type { Meta } from "./api";
import type { Buyer, Coalition, Config, Market, Purchase, Seller } from "./types";

const env = import.meta.env;
/** Public, non-secret defaults so a deployed build works with no env vars set. */
export const CHAIN = {
  contractId: (env.VITE_MARKETPLACE_CONTRACT_ID as string | undefined) || "market.swarm-1794221974623.testnet",
  rpcUrl: (env.VITE_NEAR_RPC_URL as string | undefined) || "https://test.rpc.fastnear.com",
  explorerTxUrl: (env.VITE_NEAR_EXPLORER_TX_URL as string | undefined) || "https://testnet.nearblocks.io/txns/",
};

/**
 * Free public testnet RPCs (docs.near.org/api/rpc/providers), all of which allow
 * browser requests. Free tiers rate-limit, so on a network error, an HTTP error
 * or a rate-limit reply we move to the next one and stay there while it works.
 */
const ENDPOINTS = [...new Set([CHAIN.rpcUrl, "https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://testnet-rpc.intea.rs", "https://archival-rpc.testnet.near.org"])];
let current = 0;

class RpcCallError extends Error {}

let rpcId = 0;
async function rpcAt<T>(url: string, method: string, params: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: `swarm-${++rpcId}`, method, params }),
  });
  if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
  const j = (await r.json()) as { result?: T & { error?: string }; error?: { code?: number; message?: string; cause?: { name?: string } } };
  if (j.error) {
    // Rate limits and server trouble: try another provider. Anything else is a real answer.
    if (j.error.code === -429 || /rate limit|deprecated|internal/i.test(j.error.message ?? "")) throw new Error(j.error.message ?? "RPC busy");
    throw new RpcCallError(j.error.cause?.name ?? j.error.message ?? "RPC error");
  }
  if (j.result && typeof j.result === "object" && "error" in j.result && j.result.error) throw new RpcCallError(String(j.result.error));
  return j.result as T;
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  let last: unknown;
  for (let i = 0; i < ENDPOINTS.length; i++) {
    const idx = (current + i) % ENDPOINTS.length;
    try {
      const out = await rpcAt<T>(ENDPOINTS[idx]!, method, params);
      current = idx;
      return out;
    } catch (e) {
      if (e instanceof RpcCallError) throw e;
      last = e;
    }
  }
  throw new Error(`every public testnet RPC failed: ${(last as Error)?.message ?? last}`);
}

/** The RPC currently answering (shown in the UI, used for wallet balance reads). */
export const currentRpc = () => ENDPOINTS[current]!;

/** Finished rounds and closed coalitions never change on chain: fetch each once. */
const finishedPurchases = new Map<string, Purchase>();
const closedCoalitions = new Map<string, Coalition>();
const FINISHED_STATES = ["COMPLETED", "FAILED", "EXPIRED", "REFUNDED"];

export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: CHAIN.contractId,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result))) as T;
}

async function all<T>(method: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 100) {
    const page = await view<T[]>(method, { from_index: from, limit: 100 });
    out.push(...page);
    if (page.length < 100) return out;
  }
}

/** Purchases to show: the most recent ones. */
const RECENT = 40;

export async function loadMarketFromChain(): Promise<Market> {
  const [config, buyers, sellers, block] = await Promise.all([
    view<Config>("get_config"),
    all<Buyer>("list_buyers"),
    all<Seller>("list_sellers"),
    rpc<{ header: { timestamp_nanosec: string } }>("block", { finality: "final" }),
  ]);
  const count = config.purchase_count;
  const from = Math.max(0, count - RECENT);
  const ids = count ? await view<string[]>("list_purchase_ids", { from_index: from, limit: RECENT }) : [];
  const purchases = (
    await Promise.all(
      ids.map(async (id) => {
        const cached = finishedPurchases.get(id);
        if (cached) return cached;
        const p = await view<Purchase | null>("get_purchase", { purchase_id: id });
        if (p && FINISHED_STATES.includes(p.state)) finishedPurchases.set(id, p);
        return p;
      }),
    )
  )
    .filter((p): p is Purchase => !!p)
    .reverse();
  const coalitionIds = new Set([...purchases.map((p) => p.coalition_id), ...buyers.map((b) => b.coalition_id).filter((c): c is string => !!c)]);
  const coalitions: Record<string, Coalition> = {};
  await Promise.all(
    [...coalitionIds].map(async (id) => {
      const c = closedCoalitions.get(id) ?? (await view<Coalition | null>("get_coalition", { coalition_id: id }));
      if (c) {
        coalitions[id] = c;
        if (c.closed) closedCoalitions.set(id, c);
      }
    }),
  );
  const live = purchases.filter((p) => !["COMPLETED", "FAILED", "EXPIRED", "REFUNDED"].includes(p.state));
  const done = purchases.filter((p) => !live.includes(p));
  return {
    updatedAt: new Date().toISOString(),
    chainTimeNs: block.header.timestamp_nanosec,
    tick: 0,
    config,
    buyers,
    sellers,
    purchases: [...live, ...done],
    coalitions,
    waiting: {},
    hosted: [],
    lastError: null,
    source: "chain",
  };
}

/** Meta built from the contract when the host's /api/meta isn't reachable. */
export async function metaFromChain(): Promise<Meta> {
  const config = await view<Config>("get_config");
  return {
    network: "testnet",
    contractId: CHAIN.contractId,
    explorerTxUrl: CHAIN.explorerTxUrl,
    rpcUrl: currentRpc(),
    windows: { prepay_secs: 180, commit_secs: 60, reveal_secs: 60, delivery_secs: 600, verification_secs: 600 },
    openFee: config.open_fee,
    agentGasFund: config.agent_gas_fund,
    maxAgentsPerOwner: config.max_agents_per_owner,
    sponsorPool: config.sponsor_pool,
    agentNameMaxLength: Math.min(32, 64 - CHAIN.contractId.length - 1),
    host: null,
  };
}
