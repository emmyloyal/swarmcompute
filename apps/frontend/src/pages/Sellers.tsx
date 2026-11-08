import { AccountLink, LoadState, OnChain, PageHead, Simulated } from "../components/ui";
import { useApi } from "../lib/api";
import { near, STRATEGY } from "../lib/format";

interface Seller {
  seller_id: string;
  payout_account_id: string;
  pricing_strategy: string;
  offers: { gpu_model: string; vram_gb: number; capacity_hours: number; delivery_time_minutes: number }[];
  reputation: { wins: number; completed_deliveries: number; failed_deliveries: number; non_reveals: number; source_tx_hash: string } | null;
  awards: string;
  paid_yocto: string;
}

export function Sellers() {
  const { data, error, loading } = useApi<Seller[]>("/api/sellers", 15_000);
  return (
    <div className="page">
      <PageHead
        title="Seller swarm"
        sub="Five simulated sellers, one pricing strategy each. Their behaviour is simulated; their payout accounts are real testnet accounts, and reputation is read from the contract. Private minimum prices never leave the backend."
      />
      <LoadState error={error} loading={loading && !data} label="sellers" />
      <div className="sellers">
        {data?.map((s) => (
          <section key={s.seller_id} className="card pad stack" style={{ gap: 18 }}>
            <div className="seller-head">
              <span className="tile">{s.seller_id.slice(-2)}</span>
              <div style={{ minWidth: 0 }}>
                <h3>{s.seller_id}</h3>
                <div className="muted small">{STRATEGY[s.pricing_strategy] ?? s.pricing_strategy}</div>
              </div>
              <Simulated />
            </div>
            <div>
              <div className="muted small" style={{ marginBottom: 6 }}>GPU offers</div>
              <div className="row">
                {s.offers.map((o) => (
                  <span key={`${o.gpu_model}${o.vram_gb}`} className="pill">{o.gpu_model} · {o.vram_gb} GB · {o.capacity_hours} h · {o.delivery_time_minutes} min</span>
                ))}
              </div>
            </div>
            <div>
              <div className="spread" style={{ marginBottom: 8 }}>
                <span className="muted small">Reputation (from contract events)</span>
                {s.reputation && <OnChain tx={s.reputation.source_tx_hash} />}
              </div>
              <div className="rep">
                <div><b>{s.reputation?.wins ?? 0}</b><span>wins</span></div>
                <div><b>{s.reputation?.completed_deliveries ?? 0}</b><span>delivered</span></div>
                <div><b>{s.reputation?.failed_deliveries ?? 0}</b><span>failed</span></div>
                <div><b>{s.reputation?.non_reveals ?? 0}</b><span title="Committed but never revealed">missed</span></div>
              </div>
            </div>
            <dl className="kv" style={{ gridTemplateColumns: "1fr" }}>
              <div><dt>Paid after verified delivery</dt><dd>{near(s.paid_yocto)}</dd></div>
              <div><dt>Payout account (real testnet account)</dt><dd className="small ellipsis"><AccountLink account={s.payout_account_id} /></dd></div>
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}
