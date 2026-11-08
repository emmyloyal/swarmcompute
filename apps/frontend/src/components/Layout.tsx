import { NavLink, Outlet } from "react-router-dom";
import { useMeta } from "../lib/api";
import { short } from "../lib/format";
import { AccountLink, OnChain, Simulated } from "./ui";
import { WalletConnect } from "./WalletConnect";
import { Blocks, Chip, Gavel, Grid, Layers, Pulse, Users } from "./icons";

const GROUPS = [
  { label: "Marketplace", items: [
    { to: "/", label: "Overview", icon: Grid, end: true },
    { to: "/auctions", label: "Live auctions", icon: Gavel },
    { to: "/coalitions", label: "Coalitions", icon: Layers },
  ] },
  { label: "Agents", items: [
    { to: "/buyers", label: "Buyer swarm", icon: Users },
    { to: "/sellers", label: "Seller swarm", icon: Chip },
    { to: "/activity", label: "Agent activity", icon: Pulse },
  ] },
  { label: "Settlement", items: [{ to: "/explorer", label: "Blockchain explorer", icon: Blocks }] },
];

export function Layout() {
  const meta = useMeta();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/mark.svg" alt="" />
          <b>swarmcompute</b>
        </div>
        <div className="net" title="Every transaction in this app is on NEAR Testnet. Never mainnet.">
          <span><span className="dot" />Testnet</span>
          {meta && <span className="pill" title={meta.contractId}>{short(meta.contractId, 8, 8)}</span>}
        </div>
        {GROUPS.map((g) => (
          <nav className="nav" key={g.label}>
            <div className="group-label">{g.label}</div>
            {g.items.map(({ to, label, icon: I, end }) => (
              <NavLink key={to} to={to} end={end}>
                <I />
                {label}
              </NavLink>
            ))}
          </nav>
        ))}
        <div style={{ marginTop: "auto", display: "grid", gap: 12 }}>
        <WalletConnect />
        <div className="legend" aria-label="Legend">
          <div className="legend-row">
            <OnChain />
            <span>Recorded on NEAR Testnet. Opens the transaction on the explorer.</span>
          </div>
          <div className="legend-row">
            <Simulated />
            <span>Done by the backend: agents, approvals, GPU delivery and its verification.</span>
          </div>
          {meta && (
            <div className="legend-row small">
              <span>Contract</span>
              <AccountLink account={meta.contractId} />
            </div>
          )}
        </div>
        </div>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
