import { Link } from "react-router-dom";
import { Arrow, Blocks, Gavel, Layers, Users } from "../components/icons";
import { LoadState, OnChain, PageHead, StatePill, TxLink } from "../components/ui";
import { useApi } from "../lib/api";
import { ago, near } from "../lib/format";

interface OverviewData {
  counts: Record<string, string>;
  byState: { state: string; n: string }[];
  recentTx: { tx_hash: string; method_name: string; purpose: string; purchase_id: string | null; status: string; deposit_yocto: string; finalized_at: string }[];
  outcomes: { purchase_id: string; state: string; winner_seller_id: string | null; deposited_yocto: string; updated_at: string; payout_tx: string | null; refund_tx: string | null }[];
}

const MAIN = ["CREATED", "BIDDING", "FUNDED", "DELIVERING", "VERIFYING", "COMPLETED"];
const ENDS = ["REFUNDED", "FAILED", "EXPIRED"];

export function Overview() {
  const { data, error, loading } = useApi<OverviewData>("/api/overview", 10_000);
  const n = (s: string) => Number(data?.byState.find((x) => x.state === s)?.n ?? 0);
  const c = data?.counts;
  return (
    <div className="page">
      <PageHead
        title="Overview"
        sub={
          c ? (
            <>
              {c.buyers} simulated buyers pool demand and buy at one fair price: each coalition pays the lowest bid, every member at the same rate,
              and whatever a buyer prepaid above that goes back to its own wallet. {near(c.saved_vs_own_max_yocto)} saved so far.
            </>
          ) : (
            "Simulated buyers pool demand, simulated sellers bid, and the escrow contract on NEAR Testnet settles the money."
          )
        }
      />
      <LoadState error={error} loading={loading && !data} label="the overview" />
      {data && c && (
        <>
          <div className="grid-2">
            <div className="stack">
              <section className="card">
                <div className="spread" style={{ padding: "20px 22px 4px" }}>
                  <h2>Where purchases are</h2>
                  <Link className="link-arrow" to="/explorer">Open explorer <Arrow width={16} /></Link>
                </div>
                <p className="muted small" style={{ padding: "0 22px 12px" }}>The contract's escrow state machine. Counts come from the reconciled database.</p>
                <div className="pipeline">
                  {MAIN.map((s) => (
                    <div key={s} className={`stage ${n(s) > 0 && s !== "COMPLETED" ? "hot" : ""}`}>
                      <span className="n">{n(s)}</span>
                      <span className="k">{s.toLowerCase()}</span>
                    </div>
                  ))}
                </div>
                <div className="branch">
                  <span className="muted small">Ended without payout:</span>
                  {ENDS.map((s) => <span key={s} className="pill">{s.toLowerCase()} · {n(s)}</span>)}
                  {Number(c.drifted) > 0 ? <span className="pill bad">{c.drifted} drifted from chain</span> : <span className="pill ok">0 drift vs contract</span>}
                </div>
              </section>

              <section className="card">
                <div className="spread" style={{ padding: "20px 22px 8px" }}>
                  <h2>Latest outcomes</h2>
                </div>
                {data.outcomes.length === 0 ? (
                  <p className="muted" style={{ padding: "0 22px 22px" }}>No purchase has settled yet.</p>
                ) : (
                  <table className="table">
                    <tbody>
                      {data.outcomes.map((o) => (
                        <tr key={o.purchase_id}>
                          <td>
                            <Link to={`/explorer/${o.purchase_id}`} className="name">{o.purchase_id}</Link>
                            <div className="subline">{o.state === "COMPLETED" ? `Paid ${o.winner_seller_id}` : "Refunded to each buyer"} · {ago(o.updated_at)}</div>
                          </td>
                          <td><StatePill state={o.state} /></td>
                          <td className="num">{near(o.deposited_yocto)}</td>
                          <td className="num"><OnChain tx={o.payout_tx ?? o.refund_tx} label={o.state === "COMPLETED" ? "Payout" : "Refund"} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </div>

            <div className="stack">
              <section className="card pad">
                <h2 style={{ marginBottom: 16 }}>Money on testnet</h2>
                <dl className="kv" style={{ gridTemplateColumns: "1fr" }}>
                  <div><dt>Held in escrow now</dt><dd className="big-num">{near(c.escrow_held_yocto)}</dd></div>
                  <div><dt>Paid to sellers after verified delivery</dt><dd>{near(c.paid_out_yocto)}</dd></div>
                  <div><dt>Saved by buyers vs their own max price</dt><dd className="back">{near(c.saved_vs_own_max_yocto)}</dd></div>
                  <div><dt>Sent back to buyer wallets (savings + refunds)</dt><dd>{near(c.returned_to_wallets_yocto)}</dd></div>
                  <div><dt>Refunded after failed deliveries</dt><dd>{near(c.refunded_yocto)}</dd></div>
                  <div>
                    <dt>Transactions sent by the backend</dt>
                    <dd>{c.transactions} <span className="muted small">({c.failed_transactions} failed, all recorded)</span></dd>
                  </div>
                  <div><dt>Agent messages confirmed against the chain</dt><dd>{c.confirmed_messages} of {c.messages}</dd></div>
                </dl>
              </section>
              <div className="quick">
                <Link to="/auctions"><span className="tile"><Gavel /></span>Watch live auctions</Link>
                <Link to="/coalitions"><span className="tile"><Layers /></span>See coalitions</Link>
                <Link to="/buyers"><span className="tile"><Users /></span>Browse buyers</Link>
                <Link to="/explorer"><span className="tile"><Blocks /></span>Trace a purchase</Link>
              </div>
            </div>
          </div>

          <section className="card">
            <div className="spread" style={{ padding: "20px 22px 8px" }}>
              <h2>Latest transactions</h2>
              <span className="muted small">Signed by the backend's role keys</span>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Method</th><th>Purchase</th><th>Result</th><th className="num">Deposit</th><th>Transaction</th><th>When</th></tr>
                </thead>
                <tbody>
                  {data.recentTx.map((t) => (
                    <tr key={t.tx_hash}>
                      <td className="mono">{t.method_name}</td>
                      <td>{t.purchase_id ? <Link to={`/explorer/${t.purchase_id}`}>{t.purchase_id}</Link> : <span className="faint">–</span>}</td>
                      <td><StatePill state={t.status} /></td>
                      <td className="num">{t.deposit_yocto === "0" ? <span className="faint">–</span> : near(t.deposit_yocto)}</td>
                      <td><TxLink hash={t.tx_hash} /></td>
                      <td className="muted">{ago(t.finalized_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
