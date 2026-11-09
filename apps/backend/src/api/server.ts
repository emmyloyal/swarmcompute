/**
 * HTTP API for the frontend.
 *
 * - Market state comes from the host's latest read of the contract (R15).
 * - The only write is POST /api/agent-keys: it issues a key pair for an agent
 *   a user is about to open and returns ONLY the public key (R19). Private
 *   keys, bid secrets and ciphertexts are never returned (R6, R13).
 * - Money is yocto decimal strings (R3).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type pg from "pg";
import type { ContractWindows } from "../chain/marketplace.js";
import type { AgentRole, KeyStore } from "../keystore/keystore.js";
import type { MarketHost } from "../host/market.js";

export interface ApiDeps {
  host: MarketHost;
  keys: Pick<KeyStore, "issue">;
  pool?: pg.Pool;
  meta: { contractId: string; explorerTxUrl: string; rpcUrl: string; windows: ContractWindows };
  corsOrigins: "*" | string[];
  /** Max key issues per client IP per hour. */
  keyRateLimit?: number;
}

/** Mirrors the contract's `is_agent_name`. */
export function isAgentName(s: string): boolean {
  return /^[a-z0-9]+([-_][a-z0-9]+)*$/.test(s) && s.length >= 2 && s.length <= 32;
}

/** Longest agent name that still fits a 64-char account id under this contract. */
export function maxAgentNameLength(contractId: string): number {
  return Math.min(32, 64 - contractId.length - 1);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (req: { query: URLSearchParams; params: string[]; body: unknown; ip: string }) => Promise<unknown>;

export function buildRoutes(d: ApiDeps): { method: "GET" | "POST"; re: RegExp; h: Handler }[] {
  const rows = async (sql: string, args: unknown[]) => (d.pool ? (await d.pool.query(sql, args)).rows : []);
  const issued = new Map<string, number[]>();
  const limit = d.keyRateLimit ?? 30;

  const activity = (where: string, args: unknown[], n: number) =>
    rows(
      `SELECT id, at, level, kind, message, purchase_id, agent_id, tx_hash, simulated FROM host_activity ${where} ORDER BY id DESC LIMIT ${Math.min(Math.max(n, 1), 500)}`,
      args,
    );

  return [
    {
      method: "GET",
      re: /^\/api\/meta$/,
      h: async () => {
        const s = d.host.snapshot();
        return {
          network: "testnet",
          contractId: d.meta.contractId,
          explorerTxUrl: d.meta.explorerTxUrl,
          rpcUrl: d.meta.rpcUrl,
          windows: d.meta.windows,
          openFee: s.config?.open_fee ?? null,
          agentGasFund: s.config?.agent_gas_fund ?? null,
          agentNameMaxLength: maxAgentNameLength(d.meta.contractId),
          host: { tick: s.tick, updatedAt: s.updatedAt, chainTimeNs: s.chainTimeNs, lastError: s.lastError },
        };
      },
    },
    { method: "GET", re: /^\/api\/market$/, h: async () => d.host.snapshot() },
    {
      method: "GET",
      re: /^\/api\/agents\/([a-z0-9._-]{2,64})$/,
      h: async ({ params: [id] }) => {
        const s = d.host.snapshot();
        const buyer = s.buyers.find((b) => b.buyer_id === id) ?? null;
        const seller = s.sellers.find((x) => x.seller_id === id) ?? null;
        if (!buyer && !seller) return null;
        const purchases = s.purchases.filter(
          (p) => p.winner_seller_id === id || p.allocations.some((a) => a.buyer_id === id) || p.bids.some((b) => b.seller_id === id) || s.coalitions[p.coalition_id]?.members.some((m) => m.buyer_id === id),
        );
        return { buyer, seller, hosted: s.hosted.includes(id!), waiting: s.waiting[id!] ?? null, purchases, activity: await activity("WHERE agent_id = $1", [id], 100) };
      },
    },
    {
      method: "GET",
      re: /^\/api\/purchases\/([a-z][a-z0-9-]{2,63})$/,
      h: async ({ params: [id] }) => {
        const s = d.host.snapshot();
        const purchase = s.purchases.find((p) => p.purchase_id === id);
        if (!purchase) return null;
        return {
          purchase,
          coalition: s.coalitions[purchase.coalition_id] ?? null,
          activity: (await activity("WHERE purchase_id = $1", [id], 200)).reverse(),
          events: await rows(`SELECT event, data, tx_hash, block_height FROM contract_events WHERE purchase_id = $1 ORDER BY block_height, log_index`, [id]),
        };
      },
    },
    {
      method: "GET",
      re: /^\/api\/activity$/,
      h: async ({ query }) => activity("", [], Number(query.get("limit") ?? 100) || 100),
    },
    {
      method: "POST",
      re: /^\/api\/agent-keys$/,
      h: async ({ body, ip }) => {
        const b = (body ?? {}) as { role?: unknown; name?: unknown };
        const role = b.role === "BUYER" || b.role === "SELLER" ? (b.role as AgentRole) : null;
        if (!role) throw new HttpError(400, "role must be BUYER or SELLER");
        const name = typeof b.name === "string" ? b.name : "";
        if (!isAgentName(name)) throw new HttpError(400, "name: 2-32 chars of a-z and 0-9, with single - or _ between them");
        if (name.length > maxAgentNameLength(d.meta.contractId)) throw new HttpError(400, `name: at most ${maxAgentNameLength(d.meta.contractId)} chars under this contract`);
        const agentId = `${name}.${d.meta.contractId}`;
        const s = d.host.snapshot();
        if (s.buyers.some((x) => x.buyer_id === agentId) || s.sellers.some((x) => x.seller_id === agentId)) throw new HttpError(409, "that agent name is taken");
        const now = Date.now();
        const recent = (issued.get(ip) ?? []).filter((t) => now - t < 3_600_000);
        if (recent.length >= limit) throw new HttpError(429, "too many keys requested; try again later");
        recent.push(now);
        issued.set(ip, recent);
        const { publicKey } = await d.keys.issue(agentId, role);
        return { agentId, publicKey, role };
      },
    },
  ];
}

const MAX_BODY = 4096;

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

export function createApiServer(d: ApiDeps): Server {
  const routes = buildRoutes(d);
  const corsFor = (origin: string | undefined): Record<string, string> => {
    if (d.corsOrigins === "*") return { "access-control-allow-origin": "*" };
    if (origin && d.corsOrigins.includes(origin)) return { "access-control-allow-origin": origin, vary: "origin" };
    return {};
  };
  const send = (req: IncomingMessage, res: ServerResponse, status: number, body: unknown) => {
    const json = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...corsFor(req.headers.origin),
    });
    res.end(json);
  };
  return createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...corsFor(req.headers.origin), "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" });
      return res.end();
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") return send(req, res, 200, { ok: true, tick: d.host.snapshot().tick });
    const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!route) return send(req, res, routes.some((r) => r.re.test(url.pathname)) ? 405 : 404, { error: "not found" });
    try {
      const body = req.method === "POST" ? await readJson(req) : undefined;
      const fwd = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
      const out = await route.h({ query: url.searchParams, params: route.re.exec(url.pathname)!.slice(1), body, ip: fwd || req.socket.remoteAddress || "?" });
      return out === null ? send(req, res, 404, { error: "not found" }) : send(req, res, 200, out);
    } catch (err) {
      if (err instanceof HttpError) return send(req, res, err.status, { error: err.message });
      console.error(err);
      return send(req, res, 500, { error: "internal error" });
    }
  });
}
