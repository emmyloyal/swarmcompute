import { Link } from "react-router-dom";
import { Eye, Lock } from "../components/icons";
import { Empty, LoadState, OnChain, PageHead, Simulated, StatePill, TxLink } from "../components/ui";
import { useApi, useNow } from "../lib/api";
import { dur, perHour, short, titleCase } from "../lib/format";

interface Auction {
  auction_id: string;
  purchase_id: string;
  coalition_id: string;
  commit_deadline: string;
  reveal_deadline: string;
  closed_at: string | null;
  outcome: "AWARDED" | "FAILED" | null;
  create_tx_hash: string | null;
  close_tx_hash: string | null;
  state: string;
  winner_seller_id: string | null;
  winning_price_per_hour_yocto: string | null;
  gpu_model: string;
  vram_gb: number;
  total_hours: number;
  price_ceiling_per_hour_yocto: string;
  commitment_count: string;
  reveal_count: string;
  commitments: { seller_id: string; commitment_hex: string; commit_tx_hash: string | null; revealed: boolean }[];
  reveals: { seller_id: string; price_per_hour_yocto: string; reveal_tx_hash: string; eligible: boolean | null; ineligibility_reason: string | null }[];
}

function phase(a: Auction, now: number): { label: string; tone: string; until?: number } {
  if (a.closed_at) return a.outcome === "AWARDED" ? { label: "Closed · awarded", tone: "ok" } : { label: "Closed · no eligible bid", tone: "bad" };
  const c = Date.parse(a.commit_deadline);
  const r = Date.parse(a.reveal_deadline);
  if (now < c) return { label: "Commit phase", tone: "blue", until: c };
  if (now < r) return { label: "Reveal phase", tone: "warn", until: r };
  return { label: "Waiting for close", tone: "" };
}

export function Auctions() {
  const { data, error, loading } = useApi<Auction[]>("/api/auctions", 4000);
  const now = useNow();
  const open = data?.filter((a) => !a.closed_at).length ?? 0;
  return (
    <div className="page">
      <PageHead
        title="Live auctions"
        sub={
          data
            ? `${open} open, ${(data.length ?? 0) - open} closed. Sealed-bid reverse auctions: lowest eligible revealed bid wins. Updates every few seconds.`
            : "Sealed-bid reverse auctions: lowest eligible revealed bid wins."
        }
      />
      <div className="notice">
        <span className="tile sm"><Lock /></span>
        <p>
          <b>What commit-reveal hides, and from whom.</b> Before reveal, this page and the public API show only that a seller committed, and the commitment hash. Never a price.
          Bids stay hidden from other sellers and the public until reveal. The backend operator generates every simulated seller's bid and nonce, so commit-reveal does <b>not</b> hide bids from the operator.
        </p>
      </div>
      <LoadState error={error} loading={loading && !data} label="auctions" />
      {data && data.length === 0 && (
        <div className="card"><Empty title="No auctions yet">Run <code>pnpm --filter @swarmcompute/backend demo:run</code> to start some on testnet.</Empty></div>
      )}
      {data?.map((a) => {
        const ph = phase(a, now);
        const revealed = new Map(a.reveals.map((r) => [r.seller_id, r]));
        return (
          <section key={a.auction_id} className="card">
            <div className="spread" style={{ padding: "18px 24px", borderBottom: "1px solid var(--line)" }}>
              <div className="row">
                <h3>{a.gpu_model} · {a.vram_gb} GB · {a.total_hours} h</h3>
                <span className={`pill ${ph.tone}`}>{ph.label}{ph.until ? ` · ${dur(Math.max(0, Math.round((ph.until - now) / 1000)))} left` : ""}</span>
              </div>
              <div className="row small muted">
                <span>{a.auction_id}</span>
                <OnChain tx={a.create_tx_hash} label="Opened" />
              </div>
            </div>
            <div className="auction">
              <div>
                <div className="spread" style={{ marginBottom: 6 }}>
                  <b>Bids</b>
                  <span className="muted small">{a.commitment_count} committed · {a.reveal_count} revealed</span>
                </div>
                {a.commitments.length === 0 && <p className="muted">No commitments yet.</p>}
                {a.commitments.map((c) => {
                  const r = revealed.get(c.seller_id);
                  return (
                    <div className="bid-row" key={c.seller_id}>
                      <b>{c.seller_id}</b>
                      {r ? (
                        <span className="row">
                          <Eye width={15} className="muted" />
                          <span>{perHour(r.price_per_hour_yocto)}</span>
                          {r.eligible === false && <span className="pill bad">{titleCase(r.ineligibility_reason ?? "ineligible")}</span>}
                          {a.winner_seller_id === c.seller_id && <span className="pill ok">Winner</span>}
                        </span>
                      ) : (
                        <span className="row">
                          <Lock width={15} className="muted" />
                          <span className="sealed" title={c.commitment_hex}>sealed · {short(c.commitment_hex, 10, 6)}</span>
                        </span>
                      )}
                      <span className="row">
                        <TxLink hash={r?.reveal_tx_hash ?? c.commit_tx_hash} head={5} />
                      </span>
                    </div>
                  );
                })}
              </div>
              <div>
                <dl className="kv" style={{ gridTemplateColumns: "1fr 1fr" }}>
                  <div><dt>Price ceiling</dt><dd>{perHour(a.price_ceiling_per_hour_yocto)}</dd></div>
                  <div><dt>Purchase</dt><dd><Link to={`/explorer/${a.purchase_id}`}>{short(a.purchase_id, 14, 6)}</Link></dd></div>
                  <div><dt>Commit by</dt><dd>{new Date(a.commit_deadline).toLocaleTimeString()}</dd></div>
                  <div><dt>Reveal by</dt><dd>{new Date(a.reveal_deadline).toLocaleTimeString()}</dd></div>
                  <div><dt>Winner</dt><dd>{a.winner_seller_id ?? <span className="faint">–</span>}</dd></div>
                  <div><dt>Winning price</dt><dd>{perHour(a.winning_price_per_hour_yocto)}</dd></div>
                </dl>
                <div className="row" style={{ marginTop: 18 }}>
                  <StatePill state={a.state} />
                  {a.close_tx_hash && <OnChain tx={a.close_tx_hash} label="Closed" />}
                  <Simulated label="Simulated sellers" />
                </div>
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
