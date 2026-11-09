import { Link } from "react-router-dom";
import { BuyerTable, SellerTable } from "./Agents";
import { Empty, LoadState, PageHead } from "../components/ui";
import { useMarket } from "../lib/api";
import { near } from "../lib/format";
import { useWallet } from "../lib/wallet";

export function MyAgentsPage() {
  const { data: m, error, loading } = useMarket();
  const { accountId, connect } = useWallet();
  if (!accountId) {
    return (
      <div className="page narrow">
        <PageHead title="My agents" />
        <div className="card">
          <Empty title="Connect your wallet">
            <span>Your agents are the ones your wallet opened.</span>
            <button className="btn primary" onClick={() => void connect()}>Connect wallet</button>
          </Empty>
        </div>
      </div>
    );
  }
  if (!m) return <div className="page"><PageHead title="My agents" /><LoadState error={error} loading={loading} label="your agents" /></div>;
  const buyers = m.buyers.filter((b) => b.owner === accountId);
  const sellers = m.sellers.filter((s) => s.owner === accountId);
  const available = buyers.reduce((t, b) => t + BigInt(b.available), 0n);
  const sold = m.purchases
    .filter((p) => p.state === "COMPLETED" && sellers.some((s) => s.seller_id === p.winner_seller_id))
    .reduce((t, p) => t + BigInt(p.paid_out), 0n);
  return (
    <div className="page">
      <PageHead
        title="My agents"
        sub={<span className="mono">{accountId}</span>}
        right={
          <div className="row">
            <Link className="btn primary" to="/open?role=buyer">Open a buying agent</Link>
            <Link className="btn" to="/open?role=seller">Open a selling agent</Link>
          </div>
        }
      />
      {buyers.length + sellers.length === 0 ? (
        <div className="card">
          <Empty title="You haven't opened an agent yet">Open one above. It takes one transaction from your wallet.</Empty>
        </div>
      ) : (
        <>
          <div className="stats">
            <div className="card stat"><span className="muted small">Buying agents</span><b className="big-num">{buyers.length}</b><span className="faint small">{near(available)} available to withdraw</span></div>
            <div className="card stat"><span className="muted small">Selling agents</span><b className="big-num">{sellers.length}</b><span className="faint small">{near(sold)} paid to you (in the market's recent rounds)</span></div>
          </div>
          {buyers.length > 0 && (
            <section>
              <div className="section-head"><h2>Buying agents</h2></div>
              <div className="card table-wrap"><BuyerTable buyers={buyers} you={accountId} /></div>
            </section>
          )}
          {sellers.length > 0 && (
            <section>
              <div className="section-head"><h2>Selling agents</h2></div>
              <div className="card table-wrap"><SellerTable sellers={sellers} you={accountId} /></div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
