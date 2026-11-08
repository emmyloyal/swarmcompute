import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { MetaContext, useApi, type Meta } from "./lib/api";
import { Activity } from "./pages/Activity";
import { Auctions } from "./pages/Auctions";
import { Buyers } from "./pages/Buyers";
import { Coalitions } from "./pages/Coalitions";
import { Explorer, PurchaseDetail } from "./pages/Explorer";
import { Overview } from "./pages/Overview";
import { Sellers } from "./pages/Sellers";
import "./styles.css";

function App() {
  const meta = useApi<Meta>("/api/meta");
  return (
    <MetaContext.Provider value={meta.data}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Overview />} />
            <Route path="auctions" element={<Auctions />} />
            <Route path="coalitions" element={<Coalitions />} />
            <Route path="buyers" element={<Buyers />} />
            <Route path="sellers" element={<Sellers />} />
            <Route path="activity" element={<Activity />} />
            <Route path="explorer" element={<Explorer />} />
            <Route path="explorer/:purchaseId" element={<PurchaseDetail />} />
            <Route path="*" element={<div className="empty"><b>Page not found</b></div>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </MetaContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
