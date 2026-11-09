import { NavLink, Outlet } from "react-router-dom";
import { useMarket, useMeta } from "../lib/api";
import { short } from "../lib/format";
import { useWallet } from "../lib/wallet";
import { AccountLink, OnChain, Simulated, TxLink } from "./ui";
import { WalletConnect } from "./WalletConnect";
import { Gavel, Grid, Plus, Pulse, User, Users } from "./icons";

export function Layout() {
  const meta = useMeta();
  const market = useMarket();
  const { accountId, flash, setFlash } = useWallet();
  const mine = accountId && market.data ? market.data.buyers.filter((b) => b.owner === accountId).length + market.data.sellers.filter((s) => s.owner === accountId).length : 0;
  const groups = [
    {
      label: "Market",
      items: [
        { to: "/", label: "Live market", icon: Grid, end: true },
        { to: "/rounds", label: "Rounds", icon: Gavel },
        { to: "/agents", label: "All agents", icon: Users },
        { to: "/activity", label: "Activity", icon: Pulse },
      ],
    },
    {
      label: "You",
      items: [
        { to: "/open", label: "Open an agent", icon: Plus },
        { to: "/mine", label: mine ? `My agents (${mine})` : "My agents", icon: User },
      ],
    },
  ];
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/mark.svg" alt="" />
          <b>swarmcompute</b>
        </div>
        <div className="net" title="Every transaction in this app is on NEAR Testnet. Never mainnet.">
          <span>
            <span className={`dot ${market.error ? "off" : ""}`} />
            Testnet
          </span>
          {meta && <span className="pill" title={meta.contractId}>{short(meta.contractId, 8, 8)}</span>}
        </div>
        {groups.map((g) => (
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
              <span>Recorded on NEAR Testnet: agents, deposits, coalitions, bids, escrow, payouts, refunds.</span>
            </div>
            <div className="legend-row">
              <Simulated />
              <span>GPU delivery and its verification only. No real compute runs.</span>
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
        {market.data?.source === "chain" && (
          <div className="toast warn" role="status">
            <span>
              Read-only: the market host is offline, so this page reads the market straight from the contract. Opening agents and running rounds resume when the host is back.
            </span>
          </div>
        )}
        {flash && (
          <div className={`toast ${flash.kind}`} role="status">
            <span>{flash.text}</span>
            {flash.txHash && <TxLink hash={flash.txHash} />}
            <button className="linkish" onClick={() => setFlash(null)} aria-label="Dismiss">
              Dismiss
            </button>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
