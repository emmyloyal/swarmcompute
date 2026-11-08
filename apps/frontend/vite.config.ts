import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The UI talks only to the read-only public API (proxied in dev) and to the
// public NEAR Testnet RPC for contract views. No keys, no VITE_ secrets (RULES.md R6).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.VITE_BACKEND_URL ?? "http://localhost:4000", changeOrigin: true } },
  },
});
