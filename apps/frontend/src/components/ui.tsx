import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { accountUrl, txUrl, useMeta, useNow } from "../lib/api";
import { agentName, dur, nsToMs, short } from "../lib/format";
import type { Purchase } from "../lib/types";
import { External, Flask, Lock } from "./icons";

/** Real, verifiable on NEAR Testnet. Always carries an explorer link when a tx exists. */
export function OnChain({ tx, label = "On-chain" }: { tx?: string | null; label?: string }) {
  const meta = useMeta();
  if (!tx) return <span className="pill chain"><Lock />{label}</span>;
  return (
    <a className="pill chain" href={txUrl(meta, tx)} target="_blank" rel="noreferrer" title={`Open ${tx} on the testnet explorer`}>
      <Lock />
      {label}
      <External />
    </a>
  );
}

/** Simulated by the host: GPU delivery and its verification only (RULES.md R12). */
export function Simulated({ label = "Simulated" }: { label?: string }) {
  return <span className="pill sim" title="GPU delivery and its verification are simulated: no real compute runs."><Flask />{label}</span>;
}

/** An agent, linked to its page, shown by its short name. */
export function AgentLink({ id, you }: { id: string | null | undefined; you?: boolean }) {
  if (!id) return <span className="faint">–</span>;
  return (
    <Link to={`/agents/${id}`} className="agent-link" title={id}>
      {agentName(id)}
      {you && <span className="you">you</span>}
    </Link>
  );
}

/** Live countdown to a chain-time deadline (ns). */
export function Countdown({ ns, done = "now" }: { ns: string | null | undefined; done?: string }) {
  const now = useNow();
  const ms = nsToMs(ns);
  if (ms === null) return <span className="faint">–</span>;
  const s = Math.round((ms - now) / 1000);
  return <span className="nowrap">{s > 0 ? `in ${dur(s)}` : done}</span>;
}

/** What a round is doing right now, in plain words, and when the current phase ends. */
export function phaseOf(p: Purchase): { text: string; until: string | null } {
  switch (p.state) {
    case "CREATED":
      return { text: "Members are prepaying their own max", until: p.prepay_deadline };
    case "BIDDING": {
      const t = Date.now();
      const commit = nsToMs(p.commit_deadline)!;
      return t < commit
        ? { text: `Sellers are committing sealed bids (${p.bids.length} so far)`, until: p.commit_deadline }
        : { text: `Sellers are revealing (${p.bids.filter((b) => b.revealed_price_per_hour).length}/${p.bids.length})`, until: p.reveal_deadline };
    }
    case "FUNDED":
      return { text: "Awarded. Delivery starting (simulated)", until: p.delivery_deadline };
    case "DELIVERING":
      return { text: "GPU delivery in progress (simulated)", until: p.delivery_deadline };
    case "VERIFYING":
      return { text: "Verifying delivery (simulated)", until: p.verification_deadline };
    case "COMPLETED":
      return { text: "Completed. The winning seller's owner was paid", until: null };
    default:
      return { text: "Ended without a sale. Every member's money is back in its available balance", until: null };
  }
}

export function TxLink({ hash, head = 6 }: { hash: string | null | undefined; head?: number }) {
  const meta = useMeta();
  if (!hash) return <span className="faint">–</span>;
  return (
    <a className="hash" href={txUrl(meta, hash)} target="_blank" rel="noreferrer" title={hash}>
      {short(hash, head)}
    </a>
  );
}

export function AccountLink({ account }: { account: string }) {
  const meta = useMeta();
  return (
    <a href={accountUrl(meta, account)} target="_blank" rel="noreferrer" className="mono">
      {account}
    </a>
  );
}

const TONE: Record<string, string> = {
  COMPLETED: "ok", REFUNDED: "warn", FAILED: "bad", EXPIRED: "bad",
  FUNDED: "blue", DELIVERING: "blue", VERIFYING: "blue", AWARDED: "blue", BIDDING: "blue",
  ACTIVE: "blue", CLOSED: "ok", PROPOSED: "", AUCTIONING: "blue",
  SUCCESS: "ok", FAILURE: "bad", INFO: "", WARN: "warn", ERROR: "bad",
  WAITING: "warn", IN_ROUND: "blue", OPENING: "warn", INACTIVE: "", LIVE: "ok", NO_REQUEST: "",
};

export function StatePill({ state }: { state: string | null | undefined }) {
  if (!state) return <span className="faint">–</span>;
  return <span className={`pill ${TONE[state] ?? ""}`}>{state.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</span>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children && <span>{children}</span>}
    </div>
  );
}

export function LoadState({ error, loading, label }: { error?: string; loading: boolean; label: string }) {
  if (error) {
    return (
      <div className="skeleton err">
        Couldn't load {label}: {error}. This page needs the SwarmCompute market host: run <code>pnpm --filter @swarmcompute/backend start</code> locally,
        or, for a deployed site, build the frontend with <code>VITE_BACKEND_URL</code> set to where the host runs.
      </div>
    );
  }
  if (loading) return <div className="skeleton">Loading {label}…</div>;
  return null;
}

export function PageHead({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {right}
    </header>
  );
}

const FLOW = ["CREATED", "BIDDING", "FUNDED", "DELIVERING", "VERIFYING", "COMPLETED"] as const;

/**
 * Escrow state machine position (spec Section 8). For a purchase that left
 * the happy path, `reached` is the last happy-path state it passed through.
 */
export function StateSteps({ state, reached }: { state: string; reached?: string }) {
  const off = state === "FAILED" || state === "EXPIRED" || state === "REFUNDED";
  const idx = FLOW.indexOf(state as (typeof FLOW)[number]);
  const lastDone = off ? FLOW.indexOf((reached ?? "") as (typeof FLOW)[number]) : idx - 1;
  return (
    <div className="steps">
      {FLOW.map((s, i) => {
        if (off && i > lastDone) return null;
        let cls = "step";
        if (i <= lastDone) cls += " done";
        if (!off && i === idx) cls += state === "COMPLETED" ? " end-ok" : " now";
        return <span key={s} className={cls}>{s.toLowerCase()}</span>;
      })}
      {off && <span className="step end-bad">{state.toLowerCase()}</span>}
    </div>
  );
}
