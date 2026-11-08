import { createContext, useContext, useEffect, useRef, useState } from "react";

export interface Meta {
  network: "testnet";
  contractId: string;
  explorerTxUrl: string;
  rpcUrl: string;
}

export class ApiError extends Error {}

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: { accept: "application/json" } });
  if (!r.ok) throw new ApiError(`${r.status} ${r.statusText} for ${path}`);
  return (await r.json()) as T;
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
