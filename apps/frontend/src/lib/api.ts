import { createContext, useContext, useEffect, useRef, useState } from "react";

export interface Meta {
  network: "testnet";
  contractId: string;
  explorerTxUrl: string;
  rpcUrl: string;
}

export class ApiError extends Error {}

/**
 * Where data comes from:
 * - "api": the read-only backend. In dev, `/api` is proxied by Vite; a deployed
 *   frontend points at it with VITE_BACKEND_URL (public, non-secret).
 * - "snapshot": static JSON in /snapshot, written by `pnpm --filter @swarmcompute/backend snapshot:export`.
 *   Used by a production build with no VITE_BACKEND_URL, or forced with VITE_DATA_SOURCE=snapshot.
 */
const env = import.meta.env;
const API_BASE = ((env.PROD ? env.VITE_BACKEND_URL : "") ?? "").replace(/\/$/, "");
export const DATA_SOURCE: "api" | "snapshot" =
  env.VITE_DATA_SOURCE === "snapshot" || (env.PROD && !API_BASE && env.VITE_DATA_SOURCE !== "api") ? "snapshot" : "api";

async function fetchJson<T>(url: string, label: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new ApiError(`${r.status} ${r.statusText} for ${label}`);
  // A host with SPA rewrites answers a missing file with index.html and 200.
  if (!(r.headers.get("content-type") ?? "").includes("json")) throw new ApiError(`404 not in snapshot: ${label}`);
  return (await r.json()) as T;
}

const SNAPSHOT_FILES: Record<string, string> = {
  "/api/meta": "meta.json",
  "/api/overview": "overview.json",
  "/api/buyers": "buyers.json",
  "/api/sellers": "sellers.json",
  "/api/coalitions": "coalitions.json",
  "/api/auctions": "auctions.json",
  "/api/purchases": "purchases.json",
  "/api/messages": "messages.json",
  "/api/messages/types": "message-types.json",
};

/** Serve an API path from the static snapshot, applying the same query filters the API would. */
async function getSnapshot<T>(path: string): Promise<T> {
  const url = new URL(path, "http://x");
  const detail = /^\/api\/purchases\/([^/]+)$/.exec(url.pathname);
  const file = detail ? `purchases/${encodeURIComponent(decodeURIComponent(detail[1]!))}.json` : SNAPSHOT_FILES[url.pathname];
  if (!file) throw new ApiError(`404 not in snapshot: ${path}`);
  const data = await fetchJson<unknown>(`/snapshot/${file}`, path);
  if (url.pathname === "/api/messages") {
    const q = url.searchParams;
    const limit = Math.min(Number(q.get("limit") ?? 100) || 100, 500);
    const type = q.get("type");
    const status = q.get("status");
    return (data as { type: string; status: string }[])
      .filter((m) => (!type || m.type === type) && (!status || m.status === status))
      .slice(0, limit) as T;
  }
  return data as T;
}

export async function getJson<T>(path: string): Promise<T> {
  return DATA_SOURCE === "snapshot" ? getSnapshot<T>(path) : fetchJson<T>(`${API_BASE}${path}`, path);
}

export interface SnapshotInfo {
  taken_at: string;
  contract_id: string;
  purchases: number;
}

export interface Loaded<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  /** Time of the last successful refresh. */
  at: number | undefined;
}

/** Fetch + poll. Keeps showing the last good data if a refresh fails, and says so. */
export function useApi<T>(path: string | null, pollMs = 0): Loaded<T> {
  const [state, set] = useState<Loaded<T>>({ data: undefined, error: undefined, loading: true, at: undefined });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (!path) return;
    let timer: number | undefined;
    const run = async () => {
      try {
        const data = await getJson<T>(path);
        if (alive.current) set({ data, error: undefined, loading: false, at: Date.now() });
      } catch (e) {
        if (alive.current) set((s) => ({ ...s, error: (e as Error).message, loading: false }));
      }
      // A snapshot never changes, so there is nothing to poll.
      if (pollMs && DATA_SOURCE === "api" && alive.current) timer = window.setTimeout(run, pollMs);
    };
    set((s) => ({ ...s, loading: true }));
    void run();
    return () => {
      alive.current = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [path, pollMs]);
  return state;
}

export const MetaContext = createContext<Meta | undefined>(undefined);
export const useMeta = () => useContext(MetaContext);

export function txUrl(meta: Meta | undefined, hash: string): string {
  const base = meta?.explorerTxUrl ?? "https://testnet.nearblocks.io/txns/";
  return `${base.endsWith("/") ? base : `${base}/`}${hash}`;
}

export function accountUrl(meta: Meta | undefined, account: string): string {
  const base = (meta?.explorerTxUrl ?? "https://testnet.nearblocks.io/txns/").replace(/txns\/?$/, "address/");
  return `${base}${account}`;
}

/** Ticks every second, for countdowns. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
