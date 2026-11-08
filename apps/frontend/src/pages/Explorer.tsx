import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Arrow, Refresh } from "../components/icons";
import { Empty, LoadState, OnChain, PageHead, Simulated, StatePill, StateSteps, TxLink } from "../components/ui";
import { useApi, useMeta } from "../lib/api";
import { ago, near, perHour, when } from "../lib/format";
import { viewContract } from "../lib/rpc";

interface PurchaseRow {
  purchase_id: string;
  coalition_id: string;
  state: string;
  winner_seller_id: string | null;
  winning_price_per_hour_yocto: string | null;
  required_total_yocto: string | null;
  deposited_yocto: string;
  drift_detected: boolean;
  drift_detail: Record<string, { db: string | null; chain: string | null }> | null;
  last_synced_at: string | null;
  updated_at: string;
  gpu_model: string;
  vram_gb: number;
  total_hours: number;
  auction_id?: string;
  delivery_deadline?: string | null;
}

export function Explorer() {
  const { data, error, loading } = useApi<PurchaseRow[]>("/api/purchases", 10_000);
  const nav = useNavigate();
  return (
    <div className="page">
      <PageHead
        title="Blockchain explorer"
        sub="Every coalition purchase is one escrow on the marketplace contract. Pick one to see its state, allocations, refunds and every transaction, and check it against the contract yourself."
      />
      <LoadState error={error} loading={loading && !data} label="purchases" />
      {data && (
        <section className="card table-wrap">
          {data.length === 0 ? (
            <Empty title="No purchases yet" />
          ) : (
            <table className="table">
              <thead>
                <tr><th>Purchase</th><th>Order</th><th>State</th><th>Winner</th><th className="num">Escrowed</th><th>Sync</th></tr>
              </thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.purchase_id} className="clickable" onClick={() => nav(`/explorer/${p.purchase_id}`)}>
                    <td>
                      <div className="name">{p.purchase_id}</div>
                      <div className="subline">{p.coalition_id} · updated {ago(p.updated_at)}</div>
                    </td>
                    <td>{p.gpu_model} · {p.total_hours} h</td>
                    <td><StatePill state={p.state} /></td>
                    <td>{p.winner_seller_id ?? <span className="faint">–</span>}<div className="subline">{perHour(p.winning_price_per_hour_yocto)}</div></td>
                    <td className="num">{p.deposited_yocto === "0" ? <span className="faint">–</span> : near(p.deposited_yocto)}</td>
                    <td>{p.drift_detected ? <span className="pill bad">Drift</span> : <span className="pill ok">Matches chain</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}

interface Detail {
  purchase: PurchaseRow & { funding_deadline: string | null; verification_deadline: string | null };
  allocations: {
    buyer_id: string;
    hours: number;
    max_price_per_hour_yocto: string | null;
    prepaid_yocto: string | null;
    owed_yocto: string;
    excess_yocto: string | null;
    refunded_yocto: string;
    prepay_tx_hash: string | null;
    record_tx_hash: string | null;
    wallet: string | null;
    withdrawals: { amount_yocto: string; tx_hash: string; status: string }[] | null;
  }[];
  delivery: { outcome: string; required_hours: number; allocated_hours: number; job_log_hash_hex: string; report_tx_hash: string | null; started_at: string; finished_at: string } | null;
  verification: { success: boolean; reason: string; verifier_account: string; tx_hash: string | null } | null;
  settlements: { payout_account_id: string; amount_yocto: string; status: string; tx_hash: string | null; created_at: string }[];
  refunds: { total_yocto: string; reason: string | null; status: string; tx_hash: string | null; created_at: string }[];
  refundLines: { buyer_id: string; amount_yocto: string }[];
  transactions: { tx_hash: string; method_name: string; purpose: string; status: string; deposit_yocto: string; signer_account_id: string; finalized_at: string }[];
  events: { event: string; data: Record<string, unknown>[]; tx_hash: string; block_height: string }[];
}

interface ChainPurchase { state: string; deposited: string; held: string; paid_out?: string; refunded?: string; winner_seller_id: string | null }

export function PurchaseDetail() {
  const { purchaseId = "" } = useParams();
  const meta = useMeta();
  const { data, error, loading } = useApi<Detail>(`/api/purchases/${purchaseId}`, 8000);
  const [live, setLive] = useState<{ p?: ChainPurchase; error?: string; at?: Date; busy?: boolean }>({});

  const check = async () => {
    if (!meta) return;
    setLive({ busy: true });
    try {
      const p = await viewContract<ChainPurchase | null>(meta.rpcUrl, meta.contractId, "get_purchase", { purchase_id: purchaseId });
      setLive(p ? { p, at: new Date() } : { error: "the contract has no purchase with this id", at: new Date() });
    } catch (e) {
      setLive({ error: (e as Error).message, at: new Date() });
    }
  };

  const p = data?.purchase;
  return (
    <div className="page">
      <PageHead
        title={purchaseId}
        sub={p ? `${p.gpu_model} · ${p.vram_gb} GB · ${p.total_hours} h for coalition ${p.coalition_id}` : undefined}
        right={<Link className="link-arrow" to="/explorer">All purchases <Arrow width={16} /></Link>}
      />
      <LoadState error={error} loading={loading && !data} label="this purchase" />
      {data && p && (
        <>
          <section className="card pad stack" style={{ gap: 18 }}>
            <div className="spread">
              <h2>Escrow state</h2>
              <StatePill state={p.state} />
            </div>
            <StateSteps
              state={p.state}
              reached={data.verification ? "VERIFYING" : data.delivery ? "DELIVERING" : p.winner_seller_id ? "FUNDED" : p.deposited_yocto !== "0" ? "BIDDING" : "CREATED"}
            />
            <dl className="kv">
              <div><dt>Winner (lowest eligible bid)</dt><dd>{p.winner_seller_id ?? "–"}</dd></div>
              <div><dt>Clearing price, every member</dt><dd>{perHour(p.winning_price_per_hour_yocto)}</dd></div>
              <div><dt>Owed to the seller</dt><dd>{near(p.required_total_yocto)}</dd></div>
              <div><dt>Prepaid by members</dt><dd>{p.deposited_yocto === "0" ? "–" : near(p.deposited_yocto)}</dd></div>
              <div><dt>Last reconciled</dt><dd>{p.last_synced_at ? ago(p.last_synced_at) : "–"} {p.drift_detected ? <span className="pill bad">Drift</span> : <span className="pill ok">No drift</span>}</dd></div>
            </dl>
            {p.drift_detected && p.drift_detail && (
              <div className="notice"><p><b>The cached record differs from the contract.</b> {Object.entries(p.drift_detail).map(([k, v]) => `${k}: db ${v.db} vs chain ${v.chain}`).join("; ")}. The contract is authoritative.</p></div>
            )}
            <div className="spread" style={{ borderTop: "1px solid var(--line)", paddingTop: 16 }}>
              <div className="small muted">
                {live.p ? (
                  <>
                    Contract says <b className="mono">{live.p.state}</b>, deposited {near(live.p.deposited)}, held now {near(live.p.held)}
                    {live.p.state === p.state && live.p.deposited === p.deposited_yocto ? <span className="pill ok" style={{ marginLeft: 8 }}>Matches this page</span> : <span className="pill bad" style={{ marginLeft: 8 }}>Differs from this page</span>}
                    {" "}· read {live.at?.toLocaleTimeString()}
                  </>
                ) : live.error ? (
                  <span className="err">Contract read failed: {live.error}</span>
                ) : (
                  "Read this purchase straight from the contract through the public testnet RPC."
                )}
              </div>
              <button className="btn" onClick={check} disabled={!meta || live.busy}><Refresh width={16} />{live.busy ? "Reading…" : "Check on-chain"}</button>
            </div>
          </section>

          <FairPrice data={data} />

          <div>
            <div className="tri">
              <section className="card pad stack" style={{ gap: 14 }}>
                <div className="spread"><h3>Delivery</h3><Simulated /></div>
                {data.delivery ? (
                  <>
                    <div className="row"><StatePill state={data.delivery.outcome} /><span>{data.delivery.allocated_hours} of {data.delivery.required_hours} h</span></div>
                    <div className="small muted">Job log hash <span className="mono">{data.delivery.job_log_hash_hex.slice(0, 16)}…</span></div>
                    <OnChain tx={data.delivery.report_tx_hash} label="Report hash on-chain" />
                  </>
                ) : <p className="muted">Not delivered.</p>}
              </section>
              <section className="card pad stack" style={{ gap: 14 }}>
                <div className="spread"><h3>Verification</h3><Simulated /></div>
                {data.verification ? (
                  <>
                    <div className="row"><span className={`pill ${data.verification.success ? "ok" : "bad"}`}>{data.verification.success ? "Verified" : "Rejected"}</span></div>
                    <p className="small">{data.verification.reason}</p>
                    <OnChain tx={data.verification.tx_hash} label="verify() on-chain" />
                  </>
                ) : <p className="muted">Not verified.</p>}
              </section>
              <section className="card pad stack" style={{ gap: 12 }}>
                <h3>Money movement</h3>
                {data.settlements.length + data.refunds.length === 0 && <p className="muted">No transfers.</p>}
                {data.settlements.map((s, i) => (
                  <div key={`s${i}`} className="small" style={{ display: "grid", gap: 4 }}>
                    <div className="spread"><b>Payout {near(s.amount_yocto)}</b><span className="row"><StatePill state={s.status} /><TxLink hash={s.tx_hash} head={5} /></span></div>
                    <span className="muted ellipsis" title={s.payout_account_id}>to {s.payout_account_id}</span>
                  </div>
                ))}
                {data.refunds.map((r, i) => (
                  <div key={`r${i}`} className="small" style={{ display: "grid", gap: 4 }}>
                    <div className="spread"><b>Refund {near(r.total_yocto)}</b><span className="row"><StatePill state={r.status} /><TxLink hash={r.tx_hash} head={5} /></span></div>
                    <span className="muted">credited back to each member ({r.reason?.replace(/_/g, " ") ?? "refund"})</span>
                  </div>
                ))}
              </section>
            </div>
          </div>

          <section className="card">
            <div className="spread" style={{ padding: "20px 22px 8px" }}>
              <h2>Transactions</h2>
              <span className="muted small">{data.transactions.length} sent by the backend · {data.events.length} contract events indexed</span>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Method</th><th>Signer</th><th>Result</th><th className="num">Deposit</th><th>Transaction</th><th>Finalized</th></tr></thead>
                <tbody>
                  {data.transactions.map((t) => (
                    <tr key={t.tx_hash}>
                      <td className="mono">{t.method_name}</td>
                      <td className="small muted">{t.signer_account_id}</td>
                      <td><StatePill state={t.status} /></td>
                      <td className="num">{t.deposit_yocto === "0" ? <span className="faint">–</span> : near(t.deposit_yocto)}</td>
                      <td><TxLink hash={t.tx_hash} /></td>
                      <td className="muted small">{when(t.finalized_at)}</td>
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

/**
 * The fairness proof for one purchase, straight from the contract's numbers:
 * every member pays the same clearing rate, never above its own max, and gets
 * back everything it prepaid above that (plus everything, if delivery failed).
 */
function FairPrice({ data }: { data: Detail }) {
  const p = data.purchase;
  const rows = data.allocations;
  if (rows.length === 0) {
    return (
      <section className="card pad">
        <h2>Fair price</h2>
        <p className="muted" style={{ marginTop: 8 }}>This purchase never reached the auction result, so nobody was charged. Any prepayment was credited back to its member.</p>
      </section>
    );
  }
  const clearing = p.winning_price_per_hour_yocto ? BigInt(p.winning_price_per_hour_yocto) : null;
  const rate = (a: Detail["allocations"][number]) => BigInt(a.owed_yocto) / BigInt(a.hours);
  const sameRate = clearing !== null && rows.every((a) => rate(a) === clearing);
  const underMax = rows.every((a) => a.max_price_per_hour_yocto === null || clearing === null || clearing <= BigInt(a.max_price_per_hour_yocto));
  const back = (a: Detail["allocations"][number]) => BigInt(a.excess_yocto ?? "0") + BigInt(a.refunded_yocto ?? "0");
  const totalBack = rows.reduce((s, a) => s + back(a), 0n);
  // Units live in the column headers so every figure fits.
  const n = (y: string | null | undefined) => near(y).replace(' NEAR', '');
  const ph = (y: string | null | undefined) => near(y).replace(' NEAR', '');
  return (
    <section className="card">
      <div className="fair-head">
        <div>
          <div className="muted small">Clearing price, paid by every member</div>
          <div className="rate">{perHour(p.winning_price_per_hour_yocto)}</div>
        </div>
        <span className={`pill ${sameRate ? "ok" : "bad"}`}>{sameRate ? `✓ ${rows.length} of ${rows.length} members at the same rate` : "Rates differ"}</span>
        <span className={`pill ${underMax ? "ok" : "bad"}`}>{underMax ? "✓ nobody above their own max" : "Someone above their max"}</span>
        <span className="pill blue" style={{ marginLeft: "auto" }}>{near(totalBack.toString())} back to buyer wallets</span>
      </div>
      <div className="table-wrap">
        <table className="table compact">
          <thead>
            <tr>
              <th>Buyer</th>
              <th className="num">Hours</th>
              <th className="num">Own max (NEAR/h)</th>
              <th className="num">Prepaid (NEAR)</th>
              <th className="num">Rate paid (NEAR/h)</th>
              <th className="num">Paid (NEAR)</th>
              <th className="num">Back to wallet (NEAR)</th>
              <th>Proof</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const w = a.withdrawals?.filter((x) => x.status === "SUCCEEDED").at(-1);
              const refunded = BigInt(a.refunded_yocto ?? "0") > 0n;
              return (
                <tr key={a.buyer_id}>
                  <td>
                    <div className="name nowrap">{a.buyer_id}</div>
                    <div className="subline nowrap ellipsis" style={{ maxWidth: 170 }} title={a.wallet ?? ""}>{a.wallet ?? "–"}</div>
                  </td>
                  <td className="num">{a.hours}</td>
                  <td className="num">{ph(a.max_price_per_hour_yocto)}</td>
                  <td className="num">{n(a.prepaid_yocto)}</td>
                  <td className="num">{ph(rate(a).toString())}</td>
                  <td className="num">{refunded ? <span className="faint">refunded</span> : n(a.owed_yocto)}</td>
                  <td className="num back">{n(back(a).toString())}</td>
                  <td className="nowrap">
                    <span className="row">
                      <TxLink hash={a.prepay_tx_hash} head={4} />
                      {w && <TxLink hash={w.tx_hash} head={4} />}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ padding: "12px 22px 18px" }}>
        Each member prepaid hours × its own maximum from its own wallet. The lowest eligible bid set one clearing price for everyone; the contract charged
        hours × that price and returned the rest. Proof links: the prepayment, then the latest transfer back to the wallet.
      </p>
    </section>
  );
}