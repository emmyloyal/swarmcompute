/**
 * Read-only wallet connection for visitors (spec Section 12): NEAR Wallet
 * Selector on testnet, signed in WITHOUT a contract access key, so this page
 * can never sign or send anything. It shows the visitor's account and balance.
 * All demo money moves only through backend role keys and the contract.
 *
 * The selector code is loaded on first click to keep the main bundle small.
 */
import { useEffect, useRef, useState } from "react";
import { useMeta } from "../lib/api";
import { near } from "../lib/format";
import { Wallet } from "./icons";

type Selector = Awaited<ReturnType<typeof import("@near-wallet-selector/core")["setupWalletSelector"]>>;
type Modal = ReturnType<typeof import("@near-wallet-selector/modal-ui")["setupModal"]>;

async function viewBalance(rpcUrl: string, accountId: string): Promise<string | null> {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "ui", method: "query", params: { request_type: "view_account", finality: "final", account_id: accountId } }),
  });
  const j = (await r.json()) as { result?: { amount: string } };
  return j.result?.amount ?? null;
}

export function WalletConnect() {
  const meta = useMeta();
  const sel = useRef<{ selector: Selector; modal: Modal } | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const init = async () => {
    if (sel.current) return sel.current;
    const [{ setupWalletSelector }, { setupModal }, { setupMyNearWallet }] = await Promise.all([
      import("@near-wallet-selector/core"),
      import("@near-wallet-selector/modal-ui"),
      import("@near-wallet-selector/my-near-wallet"),
    ]);
    await import("@near-wallet-selector/modal-ui/styles.css");
    // Testnet only (RULES.md R1). No contractId: sign-in grants no key to any contract.
    const selector = await setupWalletSelector({ network: "testnet", modules: [setupMyNearWallet()] });
    const modal = setupModal(selector, { description: "Read-only: SwarmCompute shows your account and never asks you to sign." });
    selector.store.observable.subscribe((s) => setAccount(s.accounts.find((a) => a.active)?.accountId ?? null));
    sel.current = { selector, modal };
    return sel.current;
  };

  // Restore a previous session without loading anything if none exists.
  useEffect(() => {
    try {
      if (localStorage.getItem("near-wallet-selector:selectedWalletId")) void init().catch(() => {});
    } catch {
      /* storage unavailable */
    }
  }, []);

  useEffect(() => {
    if (!account || !meta) return setBalance(null);
    viewBalance(meta.rpcUrl, account).then(setBalance, () => setBalance(null));
  }, [account, meta]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      (await init()).modal.show();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    const s = sel.current;
    if (!s) return;
    const w = await s.selector.wallet();
    await w.signOut();
  };

  if (account) {
    return (
      <div className="wallet">
        <div className="spread small">
          <span className="muted">Connected · read-only</span>
          <button className="linkish" onClick={disconnect}>Disconnect</button>
        </div>
        <div className="mono ellipsis" title={account}>{account}</div>
        <div className="small muted">{balance ? near(balance) : "balance unavailable"}</div>
      </div>
    );
  }
  return (
    <div>
      <button className="btn wallet-btn" onClick={connect} disabled={busy}>
        <Wallet width={16} />
        {busy ? "Loading…" : "Connect wallet"}
      </button>
      <div className="small faint" style={{ textAlign: "center", marginTop: 6 }}>Read-only: never asks you to sign</div>
      {error && <div className="small err" style={{ marginTop: 6 }}>{error}</div>}
    </div>
  );
}
