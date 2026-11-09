import { Link } from "react-router-dom";
import { RoundCard } from "./Rounds";
import { Store, User } from "../components/icons";
import { AgentLink, Empty, LoadState, PageHead } from "../components/ui";
import { useMarket } from "../lib/api";
import { agentName, ago, near, perHour, WAIT_TEXT } from "../lib/format";
import { FINISHED, type Buyer, type Market } from "../lib/types";
import { useWallet } from "../lib/wallet";

export function waitingBuyers(m: Market): Buyer[] {
  return m.buyers.filter((b) => b.opened && b.request && !b.coalition_id);
}

export function MarketPage() {
  const { data: m, error, loading } = useMarket();
  const { accountId } = useWallet();
  if (!m) return <div className="page"><PageHead title="Live market" /><LoadState error={error} loading={loading} label="the market" /></div>;

  const live = m.purchases.filter((p) => !FINISHED.includes(p.state));
  const finished = m.purchases.filter((p) => FINISHED.includes(p.state)).slice(0, 6);
  const waiting = waitingBuyers(m);
  const activeSellers = m.sellers.filter((s) => s.opened && s.active);
  const completed = m.purchases.filter((p) => p.state === "COMPLETED");
  const saved = completed.reduce((s, p) => s + p.allocations.reduce((a, x) => a + BigInt(x.excess), 0n), 0n);

  return (
    <div className="page">
      <PageHead
        title="Live market"
        sub="Buyer agents with the same GPU needs team up into one order. Seller agents bid sealed prices. The lowest eligible bid sets one price for every member, held in escrow on NEAR Testnet until delivery."
        right={
          <div className="row">
            <Link className="btn primary" to="/open?role=buyer">
              <User width={16} />
              Open a buying agent
            </Link>
            <Link className="btn" to="/open?role=seller">
              <Store width={16} />
              Open a selling agent
            </Link>
          </div>
        }
      />

      <div className="stats">
        <Stat k="Buyer agents" v={m.buyers.filter((b) => b.opened).length} sub={`${waiting.length} waiting for a round`} />
        <Stat k="Seller agents" v={m.sellers.filter((s) => s.opened).length} sub={`${activeSellers.length} taking auctions`} />
        <Stat k="Live rounds" v={live.length} sub={`${completed.length} completed`} />
        <Stat k="In escrow" v={near(m.config?.total_escrowed ?? "0")} sub={`buyers kept ${near(saved)} below their own max`} />
      </div>

      <section>
        <div className="section-head">
          <h2>Live rounds</h2>
          <p>{m.source === "chain" ? "Read directly from the contract" : `Updated ${ago(m.updatedAt)} by the market host`}</p>
        </div>
        {live.length ? (
          <div className="stack">
            {live.map((p) => (
              <RoundCard key={p.purchase_id} p={p} m={m} you={accountId} />
            ))}
          </div>
        ) : (
          <div className="card">
            <Empty title="No round is running">
              {waiting.length
                ? "Buyer agents are waiting below. A round starts as soon as a seller's terms let it bid."
                : activeSellers.length
                  ? "Sellers are ready. A round starts when a buyer agent opens a request."
                  : "The market is empty. Open a buying or selling agent to start it."}
            </Empty>
          </div>
        )}
      </section>

      <div className="grid-2">
        <section>
          <div className="section-head">
            <h2>Waiting requests</h2>
            <p>Buyer agents not in a round yet, and why</p>
          </div>
          <div className="card table-wrap">
            {waiting.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Wants</th>
                    <th className="num">Max price</th>
                    <th>Why it's waiting</th>
                  </tr>
                </thead>
                <tbody>
                  {waiting.map((b) => (
                    <tr key={b.buyer_id}>
                      <td>
                        <AgentLink id={b.buyer_id} you={b.owner === accountId} />
                      </td>
                      <td className="nowrap">
                        {b.request!.gpu_model} ≥{b.request!.vram_gb} GB · {b.request!.hours} h
                      </td>
                      <td className="num">{perHour(b.request!.max_price_per_hour)}</td>
                      <td className="small muted">{m.source === "chain" ? "Waiting for the market host, which is offline." : m.waiting[b.buyer_id] ? WAIT_TEXT[m.waiting[b.buyer_id]!] : "Being grouped on the next tick."}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty title="No request is waiting" />
            )}
          </div>
        </section>

        <section>
          <div className="section-head">
            <h2>Sellers</h2>
            <Link to="/agents?tab=sellers" className="small">All agents</Link>
          </div>
          <div className="card">
            {activeSellers.length ? (
              <ul className="list">
                {activeSellers.slice(0, 8).map((s) => (
                  <li key={s.seller_id} className="spread">
                    <span>
                      <AgentLink id={s.seller_id} you={s.owner === accountId} />
                      <span className="subline">{s.offers.map((o) => `${o.gpu_model} ${o.vram_gb} GB · ${o.capacity_hours} h`).join(", ")}</span>
                    </span>
                    <span className="num small">from {perHour(s.min_price_per_hour)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="No seller is taking auctions yet">Requests wait until one does.</Empty>
            )}
          </div>
        </section>
      </div>

      {finished.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Recent results</h2>
            <Link to="/rounds" className="small">All rounds</Link>
          </div>
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Round</th>
                  <th>Outcome</th>
                  <th>Winner</th>
                  <th className="num">Price for everyone</th>
                  <th className="num">Members</th>
                </tr>
              </thead>
              <tbody>
                {finished.map((p) => (
                  <tr key={p.purchase_id}>
                    <td>
                      <Link to={`/rounds/${p.purchase_id}`} className="mono">{p.purchase_id}</Link>
                    </td>
                    <td>{p.state === "COMPLETED" ? <span className="pill ok">Completed</span> : <span className="pill warn">{p.state.toLowerCase()}, refunded</span>}</td>
                    <td>{p.winner_seller_id ? agentName(p.winner_seller_id) : <span className="faint">–</span>}</td>
                    <td className="num">{perHour(p.clearing_price_per_hour)}</td>
                    <td className="num">{m.coalitions[p.coalition_id]?.members.length ?? p.allocations.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {m.lastError && <div className="notice small">Host note: {m.lastError}</div>}
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: string | number; sub: string }) {
  return (
    <div className="card stat">
      <span className="muted small">{k}</span>
      <b className="big-num">{v}</b>
      <span className="faint small">{sub}</span>
    </div>
  );
}
