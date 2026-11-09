import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { Feed } from "./Rounds";
import { AccountLink, AgentLink, Countdown, Empty, LoadState, PageHead, StatePill } from "../components/ui";
import { useApi, useMarket, useMeta } from "../lib/api";
import { agentName, near, nsToMs, parseNear, perHour, strategyLabel, WAIT_TEXT, when } from "../lib/format";
import { FINISHED, GPU_MODELS, type Activity, type Buyer, type GpuModel, type Purchase, type Seller, type WaitReason } from "../lib/types";
import { useWallet } from "../lib/wallet";

interface AgentDetail {
  buyer: Buyer | null;
  seller: Seller | null;
  hosted: boolean;
  waiting: WaitReason | null;
  purchases: Purchase[];
  activity: Activity[];
}

export function buyerStatus(b: Buyer): string {
  if (!b.opened) return "OPENING";
  if (b.coalition_id) return "IN_ROUND";
  return b.request ? "WAITING" : "NO_REQUEST";
}

export function sellerStatus(s: Seller): string {
  if (!s.opened) return "OPENING";
  return s.active ? "LIVE" : "INACTIVE";
}

export function AgentPage() {
  const { agentId } = useParams();
  const { accountId } = useWallet();
  const d = useApi<AgentDetail>(`/api/agents/${agentId}`, 5000);
  const { data: m } = useMarket();

  if (!d.data) {
    if (d.error?.includes("not found")) {
      return (
        <div className="page narrow">
          <PageHead title={agentName(agentId)} sub={<span className="mono">{agentId}</span>} />
          <div className="card">
            <Empty title="Not on the market yet">
              If you just opened this agent, its account is being created on NEAR Testnet. This page updates by itself within a few seconds.
            </Empty>
          </div>
        </div>
      );
    }
    return <div className="page"><PageHead title={agentName(agentId)} /><LoadState error={d.error} loading={d.loading} label="this agent" /></div>;
  }
  const { buyer, seller, hosted, waiting, purchases, activity } = d.data;
  const owner = (buyer ?? seller)!.owner;
  const isOwner = owner === accountId;
  const live = purchases.filter((p) => !FINISHED.includes(p.state));

  return (
    <div className="page">
      <PageHead
        title={agentName(agentId)}
        sub={
          <span className="row small">
            <span className="mono">{agentId}</span>
            <span className="faint">·</span>
            {buyer ? "Buying agent" : "Selling agent"}, owned by <AccountLink account={owner} />
            {isOwner && <span className="you">you</span>}
          </span>
        }
        right={<StatePill state={buyer ? buyerStatus(buyer) : sellerStatus(seller!)} />}
      />
      {!hosted && (buyer?.opened || seller?.opened) && (
        <div className="notice small">This host doesn't hold this agent's key, so it doesn't act for it. Its owner runs it with their own key.</div>
      )}

      <div className="grid-2">
        <div className="stack">
          {buyer ? <BuyerSummary b={buyer} waiting={waiting} /> : <SellerSummary s={seller!} purchases={purchases} />}
          <section>
            <div className="section-head">
              <h2>Rounds</h2>
              <p>{live.length ? `${live.length} live` : "None live"}</p>
            </div>
            <div className="card table-wrap">
              {purchases.length ? (
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Round</th>
                      <th>State</th>
                      <th className="num">Clearing price</th>
                      <th>{buyer ? "Paid" : "Bid"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {purchases.map((p) => {
                      const a = p.allocations.find((x) => x.buyer_id === agentId);
                      const bid = p.bids.find((x) => x.seller_id === agentId);
                      return (
                        <tr key={p.purchase_id}>
                          <td><Link to={`/rounds/${p.purchase_id}`} className="mono">{p.purchase_id}</Link></td>
                          <td><StatePill state={p.state} /></td>
                          <td className="num">{perHour(p.clearing_price_per_hour)}</td>
                          <td className="small">
                            {buyer
                              ? a
                                ? a.refunded !== "0"
                                  ? "refunded"
                                  : p.clearing_price_per_hour
                                    ? near(a.owed)
                                    : `prepaid ${near(a.prepaid)}`
                                : "–"
                              : bid
                                ? `${bid.revealed_price_per_hour ? perHour(bid.revealed_price_per_hour) : "sealed"}${p.winner_seller_id === agentId ? " · won" : ""}`
                                : "–"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <Empty title="No rounds yet" />
              )}
            </div>
          </section>
          <section>
            <div className="section-head">
              <h2>What this agent did</h2>
            </div>
            <div className="card">{activity.length ? <Feed items={activity} showRound /> : <Empty title="Nothing yet" />}</div>
          </section>
        </div>
        <div className="stack">
          {isOwner && buyer?.opened && <BuyerControls b={buyer} purchases={purchases} />}
          {isOwner && seller?.opened && <SellerControls s={seller} />}
          {!isOwner && (
            <div className="card pad small muted">
              {accountId ? "Only this agent's owner can change it." : "Connect the owner's wallet to manage this agent."} Every change is a transaction the owner signs.
            </div>
          )}
          {m && buyer && buyer.request && !buyer.coalition_id && (
            <div className="card pad small">
              <b>Sellers that could serve this request</b>
              <ul className="list tight" style={{ marginTop: 8 }}>
                {m.sellers
                  .filter((s) => s.opened && s.active && s.offers.some((o) => o.gpu_model === buyer.request!.gpu_model && o.vram_gb >= buyer.request!.vram_gb))
                  .map((s) => (
                    <li key={s.seller_id} className="spread">
                      <AgentLink id={s.seller_id} />
                      <span className={BigInt(s.min_price_per_hour) <= BigInt(buyer.request!.max_price_per_hour) ? "" : "err"}>from {perHour(s.min_price_per_hour)}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Kv({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function BuyerSummary({ b, waiting }: { b: Buyer; waiting: WaitReason | null }) {
  const r = b.request;
  return (
    <>
      <div className="card pad stack">
        <h3>Request</h3>
        {r ? (
          <Kv
            items={[
              ["GPU", `${r.gpu_model}, at least ${r.vram_gb} GB`],
              ["GPU-hours", r.hours],
              ["Max price", perHour(r.max_price_per_hour)],
              ["Prepays when grouped", near(BigInt(r.max_price_per_hour) * BigInt(r.hours))],
              ["Deadline", <span key="d">{when(nsToMs(r.deadline))} (<Countdown ns={r.deadline} done="passed" />)</span>],
              ["Status", b.coalition_id ? "In a round" : waiting ? WAIT_TEXT[waiting] : "Being grouped"],
            ]}
          />
        ) : (
          <p className="muted">No open request. {b.spent !== "0" ? "Its last request was fulfilled." : ""}</p>
        )}
      </div>
      <div className="card pad stack">
        <h3>Balance (held by the contract)</h3>
        <Kv
          items={[
            ["Available", near(b.available)],
            ["Reserved in a round", near(b.reserved)],
            ["Paid to sellers", near(b.spent)],
            ["Withdrawal in flight", b.withdrawing !== "0" ? near(b.withdrawing) : "–"],
          ]}
        />
        <p className="small faint">Leftovers, refunds and withdrawals can only go to the owner's wallet.</p>
      </div>
    </>
  );
}

function SellerSummary({ s, purchases }: { s: Seller; purchases: Purchase[] }) {
  const paid = purchases.filter((p) => p.state === "COMPLETED" && p.winner_seller_id === s.seller_id).reduce((t, p) => t + BigInt(p.paid_out), 0n);
  return (
    <div className="card pad stack">
      <h3>Terms</h3>
      <Kv
        items={[
          ["Offers", s.offers.map((o) => `${o.gpu_model} ${o.vram_gb} GB · ${o.capacity_hours} h`).join(", ")],
          ["Minimum price", perHour(s.min_price_per_hour)],
          ["Strategy", strategyLabel(s.strategy)],
          ["Taking auctions", s.active ? "Yes" : "Paused by owner"],
          ["Paid to owner", near(paid)],
        ]}
      />
      <div className="rep">
        <div><b>{s.reputation.wins}</b><span>wins</span></div>
        <div><b>{s.reputation.completed_deliveries}</b><span>delivered</span></div>
        <div><b>{s.reputation.failed_deliveries}</b><span>failed</span></div>
        <div><b>{s.reputation.non_reveals}</b><span>not revealed</span></div>
      </div>
      <p className="small faint">Reputation is kept by the contract and breaks ties between equal bids.</p>
    </div>
  );
}

/** Runs one owner transaction and reports the result. */
function useOwnerTx() {
  const { call, setFlash } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (label: string, method: string, args: Record<string, unknown>, deposit = 0n) => {
    setBusy(label);
    setError(null);
    try {
      const out = await call(method, args, deposit, { label });
      if (out.ok === false) throw new Error(out.error ?? "the transaction failed");
      if (out.txHash) setFlash({ kind: "ok", text: `${label}: done. The page updates within a few seconds.`, txHash: out.txHash });
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run };
}

function BuyerControls({ b, purchases }: { b: Buyer; purchases: Purchase[] }) {
  const meta = useMeta();
  const tx = useOwnerTx();
  const [dep, setDep] = useState("");
  const [wd, setWd] = useState("");
  const [edit, setEdit] = useState(false);
  const r = b.request;
  const [gpu, setGpu] = useState<GpuModel>(r?.gpu_model ?? "A100");
  const [vram, setVram] = useState(String(r?.vram_gb ?? 80));
  const [hours, setHours] = useState(String(r?.hours ?? 10));
  const [max, setMax] = useState(r ? near(r.max_price_per_hour).replace(" NEAR", "") : "0.003");
  const [days, setDays] = useState(1);
  const live = purchases.find((p) => p.coalition_id === b.coalition_id && !FINISHED.includes(p.state));
  const canLeave = b.coalition_id && (!live || live.state === "CREATED" || live.state === "BIDDING");

  const saveRequest = async () => {
    const mx = parseNear(max);
    const h = Number(hours);
    const vr = Number(vram);
    if (!mx || !Number.isInteger(h) || h < 1 || !Number.isInteger(vr) || vr < 1) return;
    const now = BigInt(meta?.host.chainTimeNs || "0") || BigInt(Date.now()) * 1_000_000n;
    const ok = await tx.run("Updating the request", "set_request", {
      buyer_id: b.buyer_id,
      request: { gpu_model: gpu, vram_gb: vr, hours: h, max_price_per_hour: mx.toString(), deadline: (now + BigInt(days * 24 * 3600) * 1_000_000_000n).toString() },
    });
    if (ok) setEdit(false);
  };

  return (
    <div className="card pad stack owner">
      <h3>Manage your agent</h3>
      <div className="field">
        <span>Deposit more budget</span>
        <div className="row">
          <input inputMode="decimal" value={dep} onChange={(e) => setDep(e.target.value)} placeholder="NEAR" />
          <button className="btn" disabled={!!tx.busy || !parseNear(dep)} onClick={() => void tx.run("Deposit", "deposit", { buyer_id: b.buyer_id }, parseNear(dep) ?? 0n)}>
            Deposit
          </button>
        </div>
      </div>
      <div className="field">
        <span>Withdraw to your wallet (available {near(b.available)})</span>
        <div className="row">
          <input inputMode="decimal" value={wd} onChange={(e) => setWd(e.target.value)} placeholder="all" />
          <button
            className="btn"
            disabled={!!tx.busy || b.available === "0" || b.withdrawing !== "0" || (wd.trim() !== "" && !parseNear(wd))}
            onClick={() => void tx.run("Withdrawal", "withdraw", wd.trim() ? { buyer_id: b.buyer_id, amount: parseNear(wd)!.toString() } : { buyer_id: b.buyer_id })}
          >
            Withdraw
          </button>
        </div>
      </div>
      {b.coalition_id ? (
        <div className="field">
          <span>In a round</span>
          <p className="small muted">The request can't change while the agent is in a round.{canLeave ? " You can leave before it's funded; your prepayment comes back." : ""}</p>
          {canLeave && (
            <button className="btn" disabled={!!tx.busy} onClick={() => void tx.run("Leaving the round", "leave_coalition", { coalition_id: b.coalition_id, buyer_id: b.buyer_id })}>
              Leave the round
            </button>
          )}
        </div>
      ) : edit ? (
        <div className="field">
          <span>New request</span>
          <div className="fields-3">
            <select className="select" value={gpu} onChange={(e) => setGpu(e.target.value as GpuModel)} aria-label="GPU">
              {GPU_MODELS.map((g) => <option key={g}>{g}</option>)}
            </select>
            <input inputMode="numeric" value={vram} onChange={(e) => setVram(e.target.value)} aria-label="Min VRAM GB" placeholder="VRAM GB" />
            <input inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} aria-label="GPU-hours" placeholder="hours" />
          </div>
          <div className="fields-3">
            <input inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} aria-label="Max price per hour" placeholder="max NEAR/h" />
            <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Deadline">
              {[1, 3, 7].map((dd) => <option key={dd} value={dd}>{dd} day{dd > 1 ? "s" : ""}</option>)}
            </select>
          </div>
          <div className="row">
            <button className="btn primary" disabled={!!tx.busy} onClick={() => void saveRequest()}>Save request</button>
            <button className="linkish" onClick={() => setEdit(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button className="btn" onClick={() => setEdit(true)}>{r ? "Change request" : "New request"}</button>
          {r && (
            <button className="btn" disabled={!!tx.busy} onClick={() => void tx.run("Closing the request", "set_request", { buyer_id: b.buyer_id, request: null })}>
              Close request
            </button>
          )}
        </div>
      )}
      {tx.busy && <div className="small muted">{tx.busy}: approve it in your wallet…</div>}
      {tx.error && <div className="small err">{tx.error}</div>}
    </div>
  );
}

function SellerControls({ s }: { s: Seller }) {
  const tx = useOwnerTx();
  const [min, setMin] = useState(near(s.min_price_per_hour).replace(" NEAR", ""));
  const [kind, setKind] = useState(s.strategy.kind);
  const [disc, setDisc] = useState(s.strategy.kind === "BELOW_CEILING" ? String(s.strategy.discount_bps / 100) : "10");
  const [cap, setCap] = useState(s.offers.map((o) => String(o.capacity_hours)));
  const save = () => {
    const mn = parseNear(min);
    const d = Number(disc);
    if (!mn || (kind === "BELOW_CEILING" && !(d > 0 && d < 100))) return;
    const offers = s.offers.map((o, i) => ({ ...o, capacity_hours: Math.max(1, Math.floor(Number(cap[i]) || o.capacity_hours)) }));
    void tx.run("Updating your terms", "update_seller", {
      seller_id: s.seller_id,
      offers,
      min_price_per_hour: mn.toString(),
      strategy: kind === "AT_MINIMUM" ? { kind } : { kind, discount_bps: Math.round(d * 100) },
      active: null,
    });
  };
  return (
    <div className="card pad stack owner">
      <h3>Manage your agent</h3>
      <div className="row">
        <button className="btn" disabled={!!tx.busy} onClick={() => void tx.run(s.active ? "Pausing" : "Resuming", "update_seller", { seller_id: s.seller_id, offers: null, min_price_per_hour: null, strategy: null, active: !s.active })}>
          {s.active ? "Pause bidding" : "Resume bidding"}
        </button>
      </div>
      <label className="field">
        <span>Minimum price per GPU-hour (NEAR)</span>
        <input inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} />
      </label>
      <div className="field">
        <span>Strategy</span>
        <label className="radio"><input type="radio" checked={kind === "AT_MINIMUM"} onChange={() => setKind("AT_MINIMUM")} /> Bid my minimum</label>
        <label className="radio">
          <input type="radio" checked={kind === "BELOW_CEILING"} onChange={() => setKind("BELOW_CEILING")} /> Bid
          <input className="inline-num" value={disc} onChange={(e) => setDisc(e.target.value)} disabled={kind !== "BELOW_CEILING"} />% below the ceiling
        </label>
      </div>
      <div className="field">
        <span>Capacity per offer (GPU-hours)</span>
        {s.offers.map((o, i) => (
          <div className="row" key={i}>
            <span className="small" style={{ minWidth: 110 }}>{o.gpu_model} {o.vram_gb} GB</span>
            <input inputMode="numeric" value={cap[i]} onChange={(e) => setCap((c) => c.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`${o.gpu_model} capacity`} />
          </div>
        ))}
      </div>
      <button className="btn primary" disabled={!!tx.busy} onClick={save}>Save terms</button>
      <p className="small faint">Payouts always go to your wallet; that can't be changed.</p>
      {tx.busy && <div className="small muted">{tx.busy}: approve it in your wallet…</div>}
      {tx.error && <div className="small err">{tx.error}</div>}
    </div>
  );
}
