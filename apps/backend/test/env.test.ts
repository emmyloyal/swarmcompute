import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config/env.js";

// Obviously fake key material — format-valid only.
const FAKE_KEY = `ed25519:${"5".repeat(88)}`;

const VALID: Record<string, string> = {
  DATABASE_URL: "postgres://swarm:x@localhost:5432/swarmcompute",
  NEAR_NETWORK: "testnet",
  NEAR_RPC_URL: "https://test.rpc.fastnear.com",
  NEAR_EXPLORER_TX_URL: "https://testnet.nearblocks.io/txns",
  MARKETPLACE_CONTRACT_ID: "market.op.testnet",
  OPERATOR_ACCOUNT_ID: "op.testnet",
  VERIFIER_ACCOUNT_ID: "verifier.testnet",
  OPERATOR_PRIVATE_KEY: FAKE_KEY,
  VERIFIER_PRIVATE_KEY: FAKE_KEY,
  KEYSTORE_ENCRYPTION_KEY: "ab".repeat(32),
  BID_ENCRYPTION_KEY: "cd".repeat(32),
};

describe("loadConfig", () => {
  it("accepts a valid testnet configuration and applies defaults", () => {
    const c = loadConfig(VALID);
    expect(c.port).toBe(4000);
    expect(c.corsOrigins).toBe("*");
    expect(c.PREPAY_SECS).toBe(180);
    expect(c.keystoreKey).toHaveLength(32);
    expect(c.explorerTxUrl("ABC")).toBe("https://testnet.nearblocks.io/txns/ABC");
  });

  it("uses the platform PORT unless BACKEND_PORT is set, and parses CORS origins", () => {
    expect(loadConfig({ ...VALID, PORT: "8080" }).port).toBe(8080);
    expect(loadConfig({ ...VALID, PORT: "8080", BACKEND_PORT: "5000" }).port).toBe(5000);
    expect(loadConfig({ ...VALID, CORS_ORIGINS: "https://a.app, https://b.app" }).corsOrigins).toEqual(["https://a.app", "https://b.app"]);
  });

  it.each([
    ["NEAR_NETWORK", "mainnet"],
    ["NEAR_RPC_URL", "https://rpc.mainnet.near.org"],
    ["NEAR_RPC_URL", "http://example.com"],
    ["NEAR_EXPLORER_TX_URL", "https://nearblocks.io/txns"],
    ["MARKETPLACE_CONTRACT_ID", "market.near"],
    ["OPERATOR_PRIVATE_KEY", "not-a-key"],
    ["KEYSTORE_ENCRYPTION_KEY", "ab".repeat(16)],
    ["BID_ENCRYPTION_KEY", "zz".repeat(32)],
  ])("rejects %s=%s", (key, value) => {
    expect(() => loadConfig({ ...VALID, [key]: value })).toThrow(ConfigError);
  });

  it("requires distinct encryption keys and never echoes values", () => {
    expect(() => loadConfig({ ...VALID, BID_ENCRYPTION_KEY: VALID.KEYSTORE_ENCRYPTION_KEY! })).toThrow(/must differ/);
    try {
      loadConfig({ ...VALID, OPERATOR_PRIVATE_KEY: "ed25519:leaky" });
    } catch (e) {
      expect((e as Error).message).not.toContain("leaky");
    }
  });
});
