import { useState } from "react";
import { AccountLink, LoadState, PageHead, Simulated, StatePill } from "../components/ui";
import { useApi } from "../lib/api";
import { near, perHour } from "../lib/format";

interface Buyer {
  buyer_id: string;
  max_budget_yocto: string;
  wallet_account_id: string | null;
  gpu_model: string | null;
  min_vram_gb: number | null;
  required_hours: number | null;
  max_price_per_hour_yocto: string | null;
  latest_delivery_at: string | null;
  requirement_status: string | null;
  coalition_id: string | null;
  membership_status: string | null;
  owed_yocto: string;
  saved_yocto: string;
  returned_yocto: string;
  purchases: string;
}

export function Buyers() {
  const { data, error, loading } = useApi<Buyer[]>("/api/buyers", 15_000);
  const [gpu, setGpu] = useState("all");
  const rows = data?.filter((b) => gpu === "all" || b.gpu_model === gpu) ?? [];
  const grouped = data?.filter((b) => b.membership_status === "ACCEPTED").length ?? 0;
  return (
    <div className="page">
      <PageHead
        title="Buyer swarm"
        sub={`${data?.length ?? 20} simulated buyer agents, each with its own testnet wallet. ${grouped} are in a coalition. A buyer prepays its own max price, pays the coalition's clearing price like every other member, and gets the difference back in its wallet.`}
        right={<Simulated label="Agents are simulated · wallets are real" />}
      />
      <div className="toolbar">
        <span className="label">Filter by</span>
        <select className="select" value={gpu} onChange={(e) => setGpu(e.target.value)} aria-label="GPU model">
          <option value="all">All GPUs</option>
          <option value="A100">A100</option>
          <option value="H100">H100</option>
        </select>
      </div>
      <LoadState error={error} loading={loading && !data} label="buyers" />
      {data && (
        <section className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Buyer</th>
                <th>Needs</th>
                <th className="num">Own max</th>
                <th className="num">Budget</th>
                <th className="num">Paid at clearing price</th>
                <th className="num">Saved vs own max</th>
                <th className="num">Back to wallet</th>
                <th>Requirement</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.buyer_id}>
                  <td>
                    <div className="name nowrap">{b.buyer_id}</div>
                    <div className="subline ellipsis" style={{ maxWidth: 210 }}>{b.wallet_account_id ? <AccountLink account={b.wallet_account_id} /> : "no wallet"}</div>
                  </td>
                  <td>
                    <span className="nowrap">{b.gpu_model ?? "–"} · ≥{b.min_vram_gb} GB · {b.required_hours} h</span>
                    <div className="subline nowrap">{b.coalition_id ? `${b.coalition_id} · ${b.membership_status?.toLowerCase()}` : "not grouped"}</div>
                  </td>
                  <td className="num">{perHour(b.max_price_per_hour_yocto)}</td>
                  <td className="num">{near(b.max_budget_yocto)}</td>
                  <td className="num">{Number(b.purchases) > 0 ? near(b.owed_yocto) : <span className="faint">–</span>}</td>
                  <td className="num back">{Number(b.purchases) > 0 ? near(b.saved_yocto) : <span className="faint">–</span>}</td>
                  <td className="num">{b.returned_yocto !== "0" ? near(b.returned_yocto) : <span className="faint">–</span>}</td>
                  <td><StatePill state={b.requirement_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
