import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config/env.js";

// Obviously fake key material — format-valid only.
const FAKE_KEY = `ed25519:${"5".repeat(88)}`;

const VALID: Record<string, string> = {
  DATABASE_URL: "postgres://swarm:x@localhost:5432/swarmcompute",
  NEAR_NETWORK: "testnet",
  NEAR_RPC_URL: "https://rpc.testnet.near.org",
  NEAR_EXPLORER_TX_URL: "https://testnet.nearblocks.io/txns",
  MARKETPLACE_CONTRACT_ID: "marketplace.op.testnet",
  OWNER_ACCOUNT_ID: "op.testnet",
  OPERATOR_ACCOUNT_ID: "op.testnet",
  FUNDER_ACCOUNT_ID: "funder.testnet",
  VERIFIER_ACCOUNT_ID: "verifier.testnet",
  OPERATOR_PRIVATE_KEY: FAKE_KEY,
  FUNDER_PRIVATE_KEY: FAKE_KEY,
  VERIFIER_PRIVATE_KEY: FAKE_KEY,
  BUYER_WALLET_PARENT: "op.testnet",
  BUYER_PRIVATE_KEY: FAKE_KEY,
  SELLER_PAYOUT_ACCOUNTS: "seller1.op.testnet, seller2.op.testnet,seller3.op.testnet,seller4.op.testnet,seller5.op.testnet",
  AGENT_HMAC_MASTER_SECRET: "ab".repeat(32),
  BID_ENCRYPTION_KEY: "cd".repeat(32),
  SIMULATION_SEED: "seed-1",
};

describe("loadConfig", () => {
  it("accepts a valid testnet configuration and applies defaults", () => {
    const c = loadConfig(VALID);
    expect(c.BACKEND_PORT).toBe(4000);
    expect(c.MESSAGE_MAX_AGE_SECONDS).toBe(300);
    expect(c.SELLER_PAYOUT_ACCOUNTS).toHaveLength(5);
    expect(c.bidEncryptionKey).toHaveLength(32);
    expect(c.explorerTxUrl("ABC")).toBe("https://testnet.nearblocks.io/txns/ABC");
  });

  it.each([
    ["NEAR_NETWORK", "mainnet"],
    ["NEAR_RPC_URL", "https://rpc.mainnet.near.org"],
    ["NEAR_RPC_URL", "https://rpc.near.org"],
    ["NEAR_RPC_URL", "http://rpc.testnet.near.org"],
    ["NEAR_EXPLORER_TX_URL", "https://nearblocks.io/txns/"],
    ["FUNDER_ACCOUNT_ID", "funder.near"],
    ["MARKETPLACE_CONTRACT_ID", "Marketplace.testnet"],
    ["OPERATOR_PRIVATE_KEY", "not-a-key"],
    ["BID_ENCRYPTION_KEY", "cd".repeat(31)],
    ["AGENT_HMAC_MASTER_SECRET", "ab".repeat(16)],
    ["SELLER_PAYOUT_ACCOUNTS", "a.testnet,b.testnet"],
    ["SELLER_PAYOUT_ACCOUNTS", "a.testnet,a.testnet,b.testnet,c.testnet,d.testnet"],
  ])("rejects %s=%s", (key, value) => {
    expect(() => loadConfig({ ...VALID, [key]: value })).toThrow(ConfigError);
  });

  it("treats empty values as missing", () => {
    expect(() => loadConfig({ ...VALID, FUNDER_PRIVATE_KEY: "" })).toThrow(/FUNDER_PRIVATE_KEY/);
  });

  it("never echoes secret values in errors", () => {
    const secret = `ed25519:${"9".repeat(10)}`;
    try {
      loadConfig({ ...VALID, FUNDER_PRIVATE_KEY: secret });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });
});
