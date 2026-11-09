import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Market, Windows } from "./types";

export interface Meta {
  network: "testnet";
  contractId: string;
  explorerTxUrl: string;
  rpcUrl: string;
  windows: Windows;
  openFee: string | null;
  agentGasFund: string | null;
  maxAgentsPerOwner: number | null;
  sponsorPool: string | null;
  agentNameMaxLength: number;
  /** null when the market host is offline and this was read from the contract. */
  host: { tick: number; updatedAt: string; chainTimeNs: string; lastError: string | null } | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/**
 * The market host API. In dev, `/api` is proxied by Vite; a deployed frontend
 * points at the hosted backend with VITE_BACKEND_URL (public, non-secret).
 */
const env = import.meta.env;
export const API_BASE = ((env.PROD ? env.VITE_BACKEND_URL : "") ?? "").replace(/\/$/, "");

async function parse<T>(r: Response, label: string): Promise<T> {
  const ct = r.headers.get("content-type") ?? "";
  const body = ct.includes("json") ? ((await r.json()) as unknown) : null;
  if (!r.ok) throw new ApiError((body as { error?: string } | null)?.error ?? `${r.status} ${r.statusText} for ${label}`, r.status);
  if (body === null) throw new ApiError(`no JSON from ${label}: is the market host running?`);
  return body as T;
}

export async function getJson<T>(path: string): Promise<T> {
  return parse<T>(await fetch(`${API_BASE}${path}`, { headers: { accept: "application/json" } }), path);
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  return parse<T>(await fetch(`${API_BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), path);
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
      if (pollMs && alive.current) timer = window.setTimeout(run, pollMs);
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

/**
 * Poll the market host; if it can't be reached, read the same data straight
 * from the contract (`fallback`), so a deployed site without a host still
 * shows the real market.
 */
export function useHostOrChain<T>(path: string, pollMs: number, fallback: () => Promise<T>): Loaded<T> {
  const [state, set] = useState<Loaded<T>>({ data: undefined, error: undefined, loading: true, at: undefined });
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const run = async () => {
      let next = pollMs;
      try {
        const data = await getJson<T>(path);
        if (alive) set({ data, error: undefined, loading: false, at: Date.now() });
      } catch (hostErr) {
        // Reading the chain directly costs public-RPC quota: refresh less often.
        next = Math.max(pollMs, 15_000);
        try {
          const data = await fallback();
          if (alive) set({ data, error: undefined, loading: false, at: Date.now() });
        } catch (chainErr) {
          if (alive) set((s) => ({ ...s, loading: false, error: `the market host isn't reachable, and reading the contract directly failed too (${(chainErr as Error).message}). Retrying shortly.` }));
        }
      }
      if (alive) timer = window.setTimeout(run, next);
    };
    void run();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, pollMs]);
  return state;
}

/** One shared poll of the market snapshot for every page. */
export const MarketContext = createContext<Loaded<Market>>({ data: undefined, error: undefined, loading: true, at: undefined });
export const useMarket = () => useContext(MarketContext);

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
