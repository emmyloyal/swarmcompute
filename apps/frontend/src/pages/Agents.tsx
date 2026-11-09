import { useSearchParams } from "react-router-dom";
import { buyerStatus, sellerStatus } from "./Agent";
import { AgentLink, Empty, LoadState, PageHead, StatePill } from "../components/ui";
import { useMarket } from "../lib/api";
import { near, perHour, strategyLabel } from "../lib/format";
import type { Buyer, Seller } from "../lib/types";
import { useWallet } from "../lib/wallet";

export function BuyerTable({ buyers, you }: { buyers: Buyer[]; you: string | null }) {
  if (!buyers.length) return <Empty title="No buying agents" />;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Status</th>
          <th>Request</th>
          <th className="num">Max price</th>
          <th className="num">Available</th>
          <th className="num">Paid to sellers</th>
        </tr>
      </thead>
      <tbody>
        {buyers.map((b) => (
          <tr key={b.buyer_id}>
            <td>
              <AgentLink id={b.buyer_id} you={b.owner === you} />
              <div className="subline mono ellipsis" title={b.owner}>owner {b.owner}</div>
            </td>
            <td><StatePill state={buyerStatus(b)} /></td>
            <td className="nowrap">{b.request ? `${b.request.gpu_model} ≥${b.request.vram_gb} GB · ${b.request.hours} h` : <span className="faint">–</span>}</td>
            <td className="num">{b.request ? perHour(b.request.max_price_per_hour) : "–"}</td>
            <td className="num">{near(b.available)}</td>
            <td className="num">{near(b.spent)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SellerTable({ sellers, you }: { sellers: Seller[]; you: string | null }) {
  if (!sellers.length) return <Empty title="No selling agents" />;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Status</th>
          <th>Offers</th>
          <th className="num">Minimum</th>
          <th>Strategy</th>
          <th className="num">Wins / delivered</th>
        </tr>
      </thead>
      <tbody>
        {sellers.map((s) => (
          <tr key={s.seller_id}>
            <td>
              <AgentLink id={s.seller_id} you={s.owner === you} />
              <div className="subline mono ellipsis" title={s.owner}>owner {s.owner}</div>
            </td>
            <td><StatePill state={sellerStatus(s)} /></td>
            <td className="small">{s.offers.map((o) => `${o.gpu_model} ${o.vram_gb} GB · ${o.capacity_hours} h`).join(", ")}</td>
            <td className="num">{perHour(s.min_price_per_hour)}</td>
            <td className="small">{strategyLabel(s.strategy)}</td>
            <td className="num">
              {s.reputation.wins} / {s.reputation.completed_deliveries}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AgentsPage() {
  const [q, setQ] = useSearchParams();
  const tab = q.get("tab") === "sellers" ? "sellers" : "buyers";
  const { data: m, error, loading } = useMarket();
  const { accountId } = useWallet();
  return (
    <div className="page">
      <PageHead title="All agents" sub="Every agent here was opened by a real wallet and is its own account on NEAR Testnet." />
      <div className="seg" role="tablist">
        <button role="tab" aria-selected={tab === "buyers"} className={tab === "buyers" ? "on" : ""} onClick={() => setQ({ tab: "buyers" })}>
          Buying agents{m ? ` (${m.buyers.length})` : ""}
        </button>
        <button role="tab" aria-selected={tab === "sellers"} className={tab === "sellers" ? "on" : ""} onClick={() => setQ({ tab: "sellers" })}>
          Selling agents{m ? ` (${m.sellers.length})` : ""}
        </button>
      </div>
      {!m ? (
        <LoadState error={error} loading={loading} label="agents" />
      ) : (
        <div className="card table-wrap">{tab === "buyers" ? <BuyerTable buyers={m.buyers} you={accountId} /> : <SellerTable sellers={m.sellers} you={accountId} />}</div>
      )}
    </div>
  );
}
