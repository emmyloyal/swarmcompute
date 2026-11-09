import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { MarketContext, MetaContext, useHostOrChain, type Meta } from "./lib/api";
import { loadMarketFromChain, metaFromChain } from "./lib/chain";
import type { Market } from "./lib/types";
import { WalletProvider } from "./lib/wallet";
import { ActivityPage } from "./pages/Activity";
import { AgentPage } from "./pages/Agent";
import { AgentsPage } from "./pages/Agents";
import { MarketPage } from "./pages/Market";
import { MyAgentsPage } from "./pages/MyAgents";
import { OpenAgentPage } from "./pages/OpenAgent";
import { RoundPage, RoundsPage } from "./pages/Rounds";
import "./styles.css";

function App() {
  const meta = useHostOrChain<Meta>("/api/meta", 30_000, metaFromChain);
  // One shared poll of the market; the host re-reads the chain every few seconds.
  // Without a reachable host, the same data is read from the contract directly.
  const market = useHostOrChain<Market>("/api/market", 6000, loadMarketFromChain);
  return (
    <MetaContext.Provider value={meta.data}>
      <MarketContext.Provider value={market}>
        <WalletProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<MarketPage />} />
                <Route path="rounds" element={<RoundsPage />} />
                <Route path="rounds/:purchaseId" element={<RoundPage />} />
                <Route path="agents" element={<AgentsPage />} />
                <Route path="agents/:agentId" element={<AgentPage />} />
                <Route path="open" element={<OpenAgentPage />} />
                <Route path="mine" element={<MyAgentsPage />} />
                <Route path="activity" element={<ActivityPage />} />
                <Route path="*" element={<div className="empty"><b>Page not found</b></div>} />
              </Route>
            </Routes>
          </BrowserRouter>
        </WalletProvider>
      </MarketContext.Provider>
    </MetaContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
