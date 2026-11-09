/**
 * The visitor's own NEAR Testnet wallet (RULES.md R1, R20).
 *
 * Owners sign their own transactions here: opening an agent, deposits,
 * withdrawals, changing a request or a seller's terms. The page never holds a
 * key: it asks the wallet to sign. Agents' own keys live only in the market
 * host (R19).
 *
 * Wallets: Meteor (extension or web popup) and MyNearWallet. Selector code
 * loads on first use to keep the main bundle small. A browser wallet may leave the page to approve and comes back with
 * `?transactionHashes=…` or `?errorCode=…`; that result is shown on return.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useMeta } from "./api";

type Selector = Awaited<ReturnType<(typeof import("@near-wallet-selector/core"))["setupWalletSelector"]>>;
type Modal = ReturnType<(typeof import("@near-wallet-selector/modal-ui"))["setupModal"]>;

export interface TxOutcome {
  /** Set when the wallet returned in-page (extension / popup wallets). */
  txHash?: string;
  ok?: boolean;
  error?: string;
}

export interface Flash {
  kind: "ok" | "err";
  text: string;
  txHash?: string;
}

interface WalletCtx {
  accountId: string | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Sign and send one function call to the marketplace contract from the connected wallet. */
  call(method: string, args: Record<string, unknown>, depositYocto: bigint, opts?: { gasTera?: number; returnTo?: string; label?: string }): Promise<TxOutcome>;
  flash: Flash | null;
  setFlash(f: Flash | null): void;
}

const Ctx = createContext<WalletCtx | null>(null);
export const useWallet = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useWallet outside WalletProvider");
  return c;
};

const PENDING = "swarmcompute:pending-tx";

function failureText(status: unknown): string | null {
  if (typeof status !== "object" || status === null || !("Failure" in status)) return null;
  const f = (status as { Failure: unknown }).Failure;
  const s = JSON.stringify(f);
  return /"ExecutionError":"([^"]+)"/.exec(s)?.[1] ?? s.slice(0, 300);
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const meta = useMeta();
  const sel = useRef<{ selector: Selector; modal: Modal } | null>(null);
  const [accountId, setAccount] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);

  const init = useCallback(async () => {
    if (sel.current) return sel.current;
    // The selector's NEAR libraries expect Node's global Buffer.
    const { Buffer } = await import("buffer");
    (globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
    // …and Meteor's SDK reads process.env.
    (globalThis as { process?: { env: Record<string, string> } }).process ??= { env: {} };
    const [{ setupWalletSelector }, { setupModal }, { setupMeteorWallet }, { setupMyNearWallet }] = await Promise.all([
      import("@near-wallet-selector/core"),
      import("@near-wallet-selector/modal-ui"),
      import("@near-wallet-selector/meteor-wallet"),
      import("@near-wallet-selector/my-near-wallet"),
    ]);
    await import("@near-wallet-selector/modal-ui/styles.css");
    // Testnet only (R1). No contractId: sign-in adds no key; every call is approved in the wallet.
    const selector = await setupWalletSelector({ network: "testnet", modules: [setupMeteorWallet(), setupMyNearWallet()] });
    const modal = setupModal(selector, { description: "Connect a NEAR Testnet wallet to open and manage your agents. You approve every transaction in your wallet." });
    selector.store.observable.subscribe((s) => setAccount(s.accounts.find((a) => a.active)?.accountId ?? null));
    setAccount(selector.store.getState().accounts.find((a) => a.active)?.accountId ?? null);
    sel.current = { selector, modal };
    return sel.current;
  }, []);

  // Restore a previous session, and pick up a result from a wallet redirect.
  useEffect(() => {
    try {
      if (localStorage.getItem("near-wallet-selector:selectedWalletId")) void init().catch(() => {});
    } catch {
      /* storage unavailable */
    }
    const q = new URLSearchParams(window.location.search);
    const hashes = q.get("transactionHashes");
    const err = q.get("errorCode");
    if (!hashes && !err) return;
    let label = "Transaction";
    try {
      label = sessionStorage.getItem(PENDING) ?? label;
      sessionStorage.removeItem(PENDING);
    } catch {
      /* storage unavailable */
    }
    if (hashes) setFlash({ kind: "ok", text: `${label} sent. The market updates within a few seconds.`, txHash: hashes.split(",").at(-1) });
    else setFlash({ kind: "err", text: `${label} was not sent: ${q.get("errorMessage") ?? err}` });
    for (const k of ["transactionHashes", "errorCode", "errorMessage"]) q.delete(k);
    const rest = q.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
  }, [init]);

  const connect = useCallback(async () => {
    (await init()).modal.show();
  }, [init]);

  const disconnect = useCallback(async () => {
    const s = sel.current;
    if (!s) return;
    await (await s.selector.wallet()).signOut();
  }, []);

  const call = useCallback<WalletCtx["call"]>(
    async (method, args, depositYocto, opts = {}) => {
      if (!meta) throw new Error("the market host hasn't loaded yet");
      const s = await init();
      if (!s.selector.isSignedIn()) {
        s.modal.show();
        throw new Error("connect a wallet first");
      }
      const { actionCreators } = await import("@near-wallet-selector/core");
      const wallet = await s.selector.wallet();
      const returnTo = new URL(opts.returnTo ?? window.location.pathname, window.location.origin).toString();
      try {
        sessionStorage.setItem(PENDING, opts.label ?? method);
      } catch {
        /* storage unavailable */
      }
      const out = await wallet.signAndSendTransaction({
        receiverId: meta.contractId,
        actions: [actionCreators.functionCall(method, args, BigInt(opts.gasTera ?? 150) * 10n ** 12n, depositYocto)],
        callbackUrl: returnTo,
      } as Parameters<typeof wallet.signAndSendTransaction>[0]);
      try {
        sessionStorage.removeItem(PENDING);
      } catch {
        /* storage unavailable */
      }
      if (!out) return {};
      const o = out as unknown as { status: unknown; transaction_outcome: { id: string }; receipts_outcome: { outcome: { status: unknown } }[] };
      const failure = failureText(o.status) ?? o.receipts_outcome.map((r) => failureText(r.outcome.status)).find(Boolean) ?? null;
      return { txHash: o.transaction_outcome.id, ok: !failure, error: failure ?? undefined };
    },
    [init, meta],
  );

  return <Ctx.Provider value={{ accountId, connect, disconnect, call, flash, setFlash }}>{children}</Ctx.Provider>;
}
