import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The UI talks to the market host API (proxied in dev), the public NEAR Testnet
// RPC, and the user's own wallet, which signs. No keys, no VITE_ secrets (RULES.md R6).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.VITE_BACKEND_URL ?? "http://localhost:4000", changeOrigin: true } },
  },
});
