import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { Empty, LoadState, PageHead, Simulated, StatePill } from "../components/ui";
import { useApi } from "../lib/api";
import { ago, near, perHour } from "../lib/format";

interface Coalition {
  coalition_id: string;
  gpu_model: string;
  vram_gb: number;
  total_hours: number;
  price_ceiling_per_hour_yocto: string;
  total_budget_yocto: string;
  delivery_deadline: string;
  min_members: number;
  status: string;
  failure_reason: string | null;
  created_at: string;
  members: { buyer_id: string; hours: number; status: string }[];
  purchases: { purchase_id: string; state: string }[] | null;
}

export function Coalitions() {
  const { data, error, loading } = useApi<Coalition[]>("/api/coalitions", 10_000);
  const [status, setStatus] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  const rows = data?.filter((c) => status === "all" || c.status === status) ?? [];
  const statuses = [...new Set(data?.map((c) => c.status) ?? [])].sort();
  return (
    <div className="page">
      <PageHead
        title="Coalitions"
        sub="Buyers with compatible needs grouped into one order. Formation is deterministic from the simulation seed; a coalition's price ceiling is its lowest member's max price."
      />
      <div className="toolbar">
        <span className="label">Filter by</span>
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="all">All statuses</option>
          {statuses.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
        </select>
        <span className="muted small" style={{ marginLeft: "auto" }}>{rows.length} coalitions</span>
      </div>
      <LoadState error={error} loading={loading && !data} label="coalitions" />
      {data && (
        <section className="card table-wrap">
          {rows.length === 0 ? (
            <Empty title="No coalitions match">Coalitions appear after a formation round.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Coalition</th><th>Order</th><th className="num">Ceiling</th><th className="num">Budget</th><th>Members</th><th>Status</th><th>Purchase</th></tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const active = c.members.filter((m) => m.status === "ACCEPTED").length;
                  const last = c.purchases?.at(-1);
                  return (
                    <Fragment key={c.coalition_id}>
                      <tr className="clickable" onClick={() => setOpen(open === c.coalition_id ? null : c.coalition_id)}>
                        <td>
                          <div className="name">{c.coalition_id}</div>
                          <div className="subline">Formed {ago(c.created_at)} · deliver by {new Date(c.delivery_deadline).toLocaleDateString()}</div>
                        </td>
                        <td>{c.gpu_model} · {c.vram_gb} GB · {c.total_hours} h</td>
                        <td className="num">{perHour(c.price_ceiling_per_hour_yocto)}</td>
                        <td className="num">{near(c.total_budget_yocto)}</td>
                        <td>{active} active <span className="muted">/ min {c.min_members}</span></td>
                        <td><StatePill state={c.status} /></td>
                        <td>{last ? <Link to={`/explorer/${last.purchase_id}`} onClick={(e) => e.stopPropagation()}><StatePill state={last.state} /></Link> : <span className="faint">–</span>}</td>
                      </tr>
                      {open === c.coalition_id && (
                        <tr>
                          <td colSpan={7} style={{ background: "var(--surface-2)" }}>
                            <div className="row" style={{ marginBottom: 10 }}>
                              <b>Members</b>
                              <Simulated label="Simulated buyers" />
                              {c.failure_reason && <span className="pill bad">{c.failure_reason}</span>}
                            </div>
                            <div className="row">
                              {c.members.map((m) => (
                                <span key={m.buyer_id} className={`pill ${m.status === "ACCEPTED" ? "blue" : m.status === "LEFT" || m.status === "REJECTED" ? "warn" : ""}`}>
                                  {m.buyer_id} · {m.hours} h{m.status !== "ACCEPTED" ? ` · ${m.status.toLowerCase()}` : ""}
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
