import { useState } from "react";
import { Link } from "react-router-dom";
import { Empty, LoadState, OnChain, PageHead, Simulated, StatePill } from "../components/ui";
import { useApi } from "../lib/api";
import { ago, titleCase } from "../lib/format";

interface Message {
  id: string;
  sender_id: string;
  receiver_id: string;
  type: string;
  sent_at: string;
  coalition_id: string | null;
  auction_id: string | null;
  purchase_id: string | null;
  payload: Record<string, unknown>;
  status: "ACCEPTED" | "CONFIRMED" | "REJECTED";
  rejection_code: string | null;
  tx_hash: string | null;
}

function summary(m: Message): string {
  const p = m.payload;
  switch (m.type) {
    case "BUYER_REQUIREMENT": return `needs ${p.gpu_model} ≥${p.min_vram_gb} GB for ${p.required_hours} h`;
    case "COALITION_PROPOSAL": return `proposed ${(p.members as unknown[])?.length ?? "?"}-member ${p.gpu_model} coalition`;
    case "COALITION_ACCEPTANCE": return "accepted the proposal";
    case "COALITION_REJECTION": return `rejected: ${p.reason}`;
    case "COALITION_LEAVE": return `left: ${p.reason}`;
    case "SELLER_AVAILABILITY": return `offers ${p.gpu_model} ${p.vram_gb} GB, ${p.capacity_hours} h`;
    case "BID_COMMITMENT": return "committed a sealed bid";
    case "BID_REVEAL": return "revealed its bid";
    case "AUCTION_RESULT": return p.outcome === "AWARDED" ? `awarded to ${p.winner_seller_id}` : "no eligible bid";
    case "CONTRIBUTION_APPROVAL": return p.approved ? `approved ${p.hours} h contribution (simulated)` : `declined: ${p.reason}`;
    case "DELIVERY_REPORT": return `${String(p.outcome).toLowerCase()} delivery, ${p.allocated_hours}/${p.required_hours} h`;
    case "VERIFICATION_RESULT": return p.success ? "verified delivery" : `rejected delivery: ${p.reason}`;
    case "PREPAYMENT": return `prepaid ${p.hours} h at its own max from its wallet`;
    case "FUNDING_CONFIRMATION": return `pays the clearing price; ${p.excess_yocto === "0" ? "nothing" : "excess"} returned`;
    case "BALANCE_RETURNED": return `balance sent to ${p.wallet}`;
    case "SETTLEMENT_CONFIRMATION": return `seller paid`;
    case "REFUND_CONFIRMATION": return `refunded to each member`;
    default: return "";
  }
}

export function Activity() {
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const qs = new URLSearchParams({ limit: "150", ...(type ? { type } : {}), ...(status ? { status } : {}) });
  const { data, error, loading } = useApi<Message[]>(`/api/messages?${qs}`, 5000);
  const types = useApi<{ type: string; n: string }[]>("/api/messages/types", 30_000);
  return (
    <div className="page">
      <PageHead
        title="Agent activity"
        sub="Every structured message between agents, as logged. Each one is HMAC-signed and validated; rejected ones are logged too. Messages that reference a transaction are confirmed only after the backend finds the matching contract event."
        right={<Simulated label="Agents are simulated" />}
      />
      <div className="toolbar">
        <span className="label">Filter by</span>
        <select className="select" value={type} onChange={(e) => setType(e.target.value)} aria-label="Message type">
          <option value="">All message types</option>
          {types.data?.map((t) => <option key={t.type} value={t.type}>{titleCase(t.type)} ({t.n})</option>)}
        </select>
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          <option value="CONFIRMED">Confirmed on-chain</option>
          <option value="ACCEPTED">Accepted</option>
          <option value="REJECTED">Rejected</option>
        </select>
      </div>
      <LoadState error={error} loading={loading && !data} label="messages" />
      {data && (
        <section className="card">
          {data.length === 0 ? (
            <Empty title="No messages match" />
          ) : (
            data.map((m) => (
              <div key={m.id} className="feed-item">
                <span className="muted small" title={m.sent_at}>{ago(m.sent_at)}</span>
                <span className="pill">{titleCase(m.type)}</span>
                <span>
                  <b>{m.sender_id}</b><span className="arrow">→</span>{m.receiver_id}
                  <span className="muted"> · {summary(m)}</span>
                  {m.purchase_id && <> · <Link to={`/explorer/${m.purchase_id}`} className="small">{m.purchase_id}</Link></>}
                </span>
                <span className="row">
                  {m.status === "CONFIRMED" ? <OnChain tx={m.tx_hash} label="Confirmed" /> : m.status === "REJECTED" ? <span className="pill bad" title={m.rejection_code ?? ""}>Rejected · {m.rejection_code}</span> : <StatePill state={m.status} />}
                </span>
              </div>
            ))
          )}
        </section>
      )}
    </div>
  );
}
