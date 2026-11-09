import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer, isAgentName, maxAgentNameLength } from "../src/api/server.js";
import { BidVault } from "../src/crypto/bid-vault.js";
import { MemBidStore } from "../src/host/bids.js";
import { MarketHost } from "../src/host/market.js";
import { FakeContract } from "./fake-contract.js";

const c = new FakeContract();
const issued: { agentId: string; role: string }[] = [];
const host = new MarketHost({
  contract: c,
  keys: { keyFor: async () => null },
  bids: new MemBidStore(),
  vault: new BidVault(Buffer.alloc(32, 1)),
  windows: { prepay_secs: 60, commit_secs: 30, reveal_secs: 30, delivery_secs: 60, verification_secs: 60 },
  retryCooldownSecs: 60,
});
const server = createApiServer({
  host,
  keys: { issue: async (agentId, role) => (issued.push({ agentId, role }), { publicKey: "ed25519:PUBLIC" }) },
  meta: { contractId: c.contractId, explorerTxUrl: "https://testnet.nearblocks.io/txns/", rpcUrl: "https://test.rpc.fastnear.com", windows: host["o"].windows },
  corsOrigins: ["https://app.example"],
  keyRateLimit: 3,
});
let base = "";

beforeAll(async () => {
  c.openSeller("taken", "o.testnet", null, [{ gpu_model: "A100", vram_gb: 80, capacity_hours: 1 }], 1n);
  await host.tick();
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/agent-keys`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("API", () => {
  it("issues a key for a new agent name and returns only the public key", async () => {
    const r = await post({ role: "BUYER", name: "alice-gpu" }, { "x-forwarded-for": "1.1.1.1" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ agentId: `alice-gpu.${c.contractId}`, publicKey: "ed25519:PUBLIC", role: "BUYER" });
    expect(issued).toEqual([{ agentId: `alice-gpu.${c.contractId}`, role: "BUYER" }]);
  });

  it("rejects bad roles, bad names and taken names", async () => {
    expect((await post({ role: "ADMIN", name: "x1" })).status).toBe(400);
    expect((await post({ role: "SELLER", name: "Bad.Name" })).status).toBe(400);
    expect((await post({ role: "SELLER", name: "taken" })).status).toBe(409);
  });

  it("rate-limits key issuing per client", async () => {
    const ip = { "x-forwarded-for": "9.9.9.9" };
    for (let i = 0; i < 3; i++) expect((await post({ role: "SELLER", name: `s${i}x` }, ip)).status).toBe(200);
    expect((await post({ role: "SELLER", name: "s9x" }, ip)).status).toBe(429);
  });

  it("serves market state and meta; CORS only for allowed origins", async () => {
    const m = await fetch(`${base}/api/market`, { headers: { origin: "https://app.example" } });
    expect(m.headers.get("access-control-allow-origin")).toBe("https://app.example");
    const s = (await m.json()) as { sellers: unknown[] };
    expect(s.sellers).toHaveLength(1);
    const other = await fetch(`${base}/api/meta`, { headers: { origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    expect(((await other.json()) as { agentNameMaxLength: number }).agentNameMaxLength).toBe(maxAgentNameLength(c.contractId));
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });

  it("validates names like the contract", () => {
    for (const ok of ["ab", "buyer-1", "gpu_farm-02"]) expect(isAgentName(ok)).toBe(true);
    for (const bad of ["a", "-a", "a-", "a--b", "A1", "a.b", "a".repeat(33)]) expect(isAgentName(bad)).toBe(false);
    expect(maxAgentNameLength("market.swarm-1731234567890.testnet")).toBe(29);
  });
});
