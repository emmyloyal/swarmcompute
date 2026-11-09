import { Link, useParams } from "react-router-dom";
import { AgentLink, Countdown, Empty, LoadState, OnChain, PageHead, phaseOf, Simulated, StatePill, StateSteps, TxLink } from "../components/ui";
import { useApi, useMarket } from "../lib/api";
import { agentName, near, perHour, short, when } from "../lib/format";
import { FINISHED, type Activity, type Coalition, type Market, type Purchase } from "../lib/types";
import { useWallet } from "../lib/wallet";

const hoursOf = (c: Coalition | undefined) => c?.members.reduce((s, m) => s + m.hours, 0) ?? 0;
const ceilingOf = (c: Coalition | undefined) =>
  c?.members.length ? c.members.map((m) => BigInt(m.max_price_per_hour)).reduce((a, b) => (a < b ? a : b)).toString() : null;

/** Where a finished round got to, for the step display. */
function reached(p: Purchase): string {
  if (p.verified_success !== null) return "VERIFYING";
  if (p.clearing_price_per_hour) return "FUNDED";
  if (p.commit_deadline) return "BIDDING";
  return "CREATED";
}

export function RoundCard({ p, m, you }: { p: Purchase; m: Market; you: string | null }) {
  const c = m.coalitions[p.coalition_id];
  const phase = phaseOf(p);
  const owners = new Map([...m.buyers.map((b) => [b.buyer_id, b.owner] as const), ...m.sellers.map((s) => [s.seller_id, s.owner] as const)]);
  const revealed = p.bids.some((b) => b.revealed_price_per_hour);
  return (
    <div className="card round">
      <div className="round-head">
        <div>
          <Link to={`/rounds/${p.purchase_id}`} className="name">
            {c ? `${c.gpu_model} ≥${c.vram_gb} GB · ${hoursOf(c)} GPU-hours` : p.purchase_id}
          </Link>
          <div className="subline">
            {phase.text}
            {phase.until && (
              <>
                {" · ends "}
                <Countdown ns={phase.until} />
              </>
            )}
          </div>
        </div>
        <StateSteps state={p.state} reached={reached(p)} />
      </div>
      <div className="round-body">
        <div>
          <div className="label">Members · one price for all</div>
          <ul className="list tight">
            {(c?.members ?? []).map((mem) => {
              const a = p.allocations.find((x) => x.buyer_id === mem.buyer_id);
              return (
                <li key={mem.buyer_id} className="spread">
                  <span>
                    <AgentLink id={mem.buyer_id} you={owners.get(mem.buyer_id) === you} /> <span className="faint small">{mem.hours} h, max {perHour(mem.max_price_per_hour)}</span>
                  </span>
                  <span className="small">{a ? (p.clearing_price_per_hour ? <span className="back">pays {near(a.owed)}</span> : <span className="muted">prepaid</span>) : <span className="faint">not yet</span>}</span>
                </li>
              );
            })}
          </ul>
          <div className="small muted" style={{ marginTop: 10 }}>
            Price ceiling {perHour(ceilingOf(c))}: no member pays more than its own max.
          </div>
        </div>
        <div>
          <div className="label">Sealed bids</div>
          {p.bids.length ? (
            <ul className="list tight">
              {[...p.bids]
                .sort((a, b) => (a.revealed_price_per_hour && b.revealed_price_per_hour ? (BigInt(a.revealed_price_per_hour) < BigInt(b.revealed_price_per_hour) ? -1 : 1) : 0))
                .map((b) => (
                  <li key={b.seller_id} className="spread">
                    <span>
                      <AgentLink id={b.seller_id} you={owners.get(b.seller_id) === you} />
                      {p.winner_seller_id === b.seller_id && <span className="pill ok" style={{ marginLeft: 8 }}>Winner</span>}
                    </span>
                    <span className="small">
                      {b.revealed_price_per_hour ? (
                        <b>{perHour(b.revealed_price_per_hour)}</b>
                      ) : (
                        <span className="sealed" title={`commitment ${b.commitment_hex}`}>
                          sealed {short(b.commitment_hex, 6, 0)}
                        </span>
                      )}
                      {b.eligible === false && <span className="err"> · {b.ineligibility_reason?.toLowerCase().replace(/_/g, " ")}</span>}
                    </span>
                  </li>
                ))}
            </ul>
          ) : (
            <div className="small faint">{p.state === "CREATED" ? "Bidding opens once every member has prepaid." : "No bids yet."}</div>
          )}
          {p.clearing_price_per_hour ? (
            <div className="clearing">
              Clearing price <b>{perHour(p.clearing_price_per_hour)}</b> for every member
            </div>
          ) : (
            revealed && <div className="small muted" style={{ marginTop: 10 }}>The lowest eligible bid wins when reveals close.</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function RoundsPage() {
  const { data: m, error, loading } = useMarket();
  const { accountId } = useWallet();
  if (!m) return <div className="page"><PageHead title="Rounds" /><LoadState error={error} loading={loading} label="rounds" /></div>;
  const live = m.purchases.filter((p) => !FINISHED.includes(p.state));
  const done = m.purchases.filter((p) => FINISHED.includes(p.state));
  return (
    <div className="page">
      <PageHead title="Rounds" sub="Each round is one coalition's purchase: members prepay their own max, sellers commit then reveal sealed bids, and the lowest eligible bid sets one price for all." />
      <section className="stack">
        <h2>Live</h2>
        {live.length ? live.map((p) => <RoundCard key={p.purchase_id} p={p} m={m} you={accountId} />) : <div className="card"><Empty title="No round is running" /></div>}
      </section>
      <section>
        <div className="section-head">
          <h2>Finished</h2>
        </div>
        <div className="card table-wrap">
          {done.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Round</th>
                  <th>GPU</th>
                  <th>Outcome</th>
                  <th>Winner</th>
                  <th className="num">Clearing price</th>
                  <th className="num">Paid to seller</th>
                </tr>
              </thead>
              <tbody>
                {done.map((p) => {
                  const c = m.coalitions[p.coalition_id];
                  return (
                    <tr key={p.purchase_id}>
                      <td>
                        <Link to={`/rounds/${p.purchase_id}`} className="mono">{p.purchase_id}</Link>
                        <div className="subline">{when(Number(BigInt(p.created_at) / 1_000_000n))}</div>
                      </td>
                      <td className="nowrap">{c ? `${c.gpu_model} ≥${c.vram_gb} GB · ${hoursOf(c)} h` : "–"}</td>
                      <td><StatePill state={p.state} /></td>
                      <td>{p.winner_seller_id ? agentName(p.winner_seller_id) : <span className="faint">–</span>}</td>
                      <td className="num">{perHour(p.clearing_price_per_hour)}</td>
                      <td className="num">{p.paid_out !== "0" ? near(p.paid_out) : "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <Empty title="No finished rounds yet" />
          )}
        </div>
      </section>
    </div>
  );
}

interface RoundDetail {
  purchase: Purchase;
  coalition: Coalition | null;
  activity: Activity[];
}

export function RoundPage() {
  const { purchaseId } = useParams();
  const { data: m } = useMarket();
  const { accountId } = useWallet();
  const live = m?.purchases.find((p) => p.purchase_id === purchaseId);
  const offline = m?.source === "chain";
  const fetched = useApi<RoundDetail>(offline ? null : `/api/purchases/${purchaseId}`, live && !FINISHED.includes(live.state) ? 4000 : 0);
  // Without the market host, the round comes from the contract data (no timeline).
  const d = offline
    ? { data: live ? { purchase: live, coalition: m!.coalitions[live.coalition_id] ?? null, activity: [] } : undefined, error: live ? undefined : "not found among recent rounds", loading: false }
    : fetched;
  if (!d.data || !m) return <div className="page"><PageHead title="Round" /><LoadState error={d.error} loading={d.loading} label="this round" /></div>;
  const p = live ?? d.data.purchase;
  const c = m.coalitions[p.coalition_id] ?? d.data.coalition ?? undefined;
  return (
    <div className="page">
      <PageHead
        title={c ? `${c.gpu_model} ≥${c.vram_gb} GB · ${hoursOf(c)} GPU-hours` : p.purchase_id}
        sub={<span className="mono">{p.purchase_id}</span>}
        right={<StatePill state={p.state} />}
      />
      <RoundCard p={p} m={m} you={accountId} />

      {p.allocations.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Fairness, member by member</h2>
            <p>Checked by the contract: everyone pays hours × the same clearing price, never above its own max</p>
          </div>
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th className="num">Hours</th>
                  <th className="num">Own max</th>
                  <th className="num">Prepaid</th>
                  <th className="num">Pays</th>
                  <th className="num">Back to its balance</th>
                </tr>
              </thead>
              <tbody>
                {p.allocations.map((a) => (
                  <tr key={a.buyer_id}>
                    <td><AgentLink id={a.buyer_id} /></td>
                    <td className="num">{a.hours}</td>
                    <td className="num">{perHour(a.max_price_per_hour)}</td>
                    <td className="num">{near(a.prepaid)}</td>
                    {/* Refunded rounds pay nothing; otherwise each member owes hours × the clearing price. */}
                    <td className="num">{a.refunded !== "0" ? near("0") : p.clearing_price_per_hour ? near(a.owed) : "–"}</td>
                    <td className="num back">{near(BigInt(a.excess) + BigInt(a.refunded))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <div className="section-head">
          <h2>Timeline</h2>
          <p>Every step the market host took, with its transaction</p>
        </div>
        <div className="card">
          {d.data.activity.length ? (
            <Feed items={d.data.activity} />
          ) : (
            <Empty title={offline ? "The timeline is kept by the market host" : "Nothing recorded yet"}>{offline ? "The host is offline right now. Every step is still on the contract and the explorer." : undefined}</Empty>
          )}
        </div>
      </section>
    </div>
  );
}

export function Feed({ items, showRound = false }: { items: Activity[]; showRound?: boolean }) {
  return (
    <div>
      {items.map((a) => (
        <div className="feed-item" key={a.id}>
          <span className="small muted nowrap">{when(a.at)}</span>
          <span className="small">
            <b>{a.kind.replace(/_/g, " ")}</b>
            {a.agent_id && <> · <AgentLink id={a.agent_id} /></>}
            {showRound && a.purchase_id && (
              <>
                {" · "}
                <Link to={`/rounds/${a.purchase_id}`} className="mono">{a.purchase_id.replace(/^purchase-/, "round ")}</Link>
              </>
            )}
          </span>
          <span className={`small ${a.level === "ERROR" ? "err" : ""}`}>{a.message}</span>
          <span className="row">
            {a.simulated && <Simulated />}
            {a.tx_hash ? <OnChain tx={a.tx_hash} /> : null}
          </span>
        </div>
      ))}
    </div>
  );
}
