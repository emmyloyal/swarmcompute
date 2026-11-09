/** The visitor's wallet: connect to open and manage agents; every action is approved in the wallet. */
import { useEffect, useState } from "react";
import { useMeta } from "../lib/api";
import { near } from "../lib/format";
import { useWallet } from "../lib/wallet";
import { Wallet } from "./icons";

export async function viewBalance(rpcUrl: string, accountId: string): Promise<string | null> {
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
  const { accountId, connect, disconnect } = useWallet();
  const [balance, setBalance] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId || !meta) return setBalance(null);
    let live = true;
    const load = () => viewBalance(meta.rpcUrl, accountId).then((b) => live && setBalance(b), () => live && setBalance(null));
    void load();
    const t = window.setInterval(load, 15_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [accountId, meta]);

  if (accountId) {
    return (
      <div className="wallet">
        <div className="spread small">
          <span className="muted">Your wallet</span>
          <button className="linkish" onClick={() => void disconnect()}>
            Disconnect
          </button>
        </div>
        <div className="mono ellipsis" title={accountId}>
          {accountId}
        </div>
        <div className="small muted">{balance ? near(balance) : "balance unavailable"}</div>
      </div>
    );
  }
  return (
    <div>
      <button
        className="btn wallet-btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await connect();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Wallet width={16} />
        {busy ? "Loading…" : "Connect wallet"}
      </button>
      <div className="small faint" style={{ textAlign: "center", marginTop: 6 }}>
        NEAR Testnet. You approve every transaction.
      </div>
      {error && <div className="small err" style={{ marginTop: 6 }}>{error}</div>}
    </div>
  );
}
