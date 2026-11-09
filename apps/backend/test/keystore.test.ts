import { describe, expect, it } from "vitest";
import { KeyPair, type KeyPairString } from "near-api-js";
import { KeyCipher, KeyStore, MemKeyRepo } from "../src/keystore/keystore.js";

const CONTRACT = "market.test.testnet";
const KEY = Buffer.alloc(32, 9);

function chainWith(keys: Record<string, { publicKey: string; fullAccess?: boolean; receiverId?: string }[]>) {
  return {
    contractId: CONTRACT,
    accessKeys: async (id: string) => keys[id]?.map((k) => ({ fullAccess: false, receiverId: CONTRACT, ...k })) ?? null,
  };
}

describe("agent keystore", () => {
  it("returns only the public key, and uses the private key only once it's on the agent's account", async () => {
    const repo = new MemKeyRepo();
    const onChain: Record<string, { publicKey: string }[]> = {};
    const ks = new KeyStore(repo, KEY, chainWith(onChain));
    const id = `alice.${CONTRACT}`;
    const { publicKey } = await ks.issue(id, "BUYER");
    expect(publicKey).toMatch(/^ed25519:/);
    // Stored encrypted, never in the clear.
    expect(repo.rows[0]!.secretCiphertext.toString("utf8")).not.toContain("ed25519:");
    // Not opened yet.
    expect(await ks.keyFor(id)).toBeNull();
    onChain[id] = [{ publicKey }];
    const sk = await ks.keyFor(id);
    expect(KeyPair.fromString(sk as KeyPairString).getPublicKey().toString()).toBe(publicKey);
    expect(repo.rows[0]!.bound).toBe(true);
  });

  it("binds only the key that is on chain and discards the others issued for that name", async () => {
    const repo = new MemKeyRepo();
    const onChain: Record<string, { publicKey: string }[]> = {};
    const ks = new KeyStore(repo, KEY, chainWith(onChain));
    const id = `bob.${CONTRACT}`;
    const first = await ks.issue(id, "SELLER");
    const second = await ks.issue(id, "SELLER");
    onChain[id] = [{ publicKey: second.publicKey }];
    const sk = await ks.keyFor(id);
    expect(KeyPair.fromString(sk as KeyPairString).getPublicKey().toString()).toBe(second.publicKey);
    expect(repo.rows.map((r) => r.publicKey)).toEqual([second.publicKey]);
    expect(first.publicKey).not.toBe(second.publicKey);
  });

  it("never uses a key the agent doesn't hold as a function-call key on this contract", async () => {
    const repo = new MemKeyRepo();
    const id = `carol.${CONTRACT}`;
    const tmp = new KeyStore(repo, KEY, chainWith({}));
    const { publicKey } = await tmp.issue(id, "BUYER");
    expect(await new KeyStore(repo, KEY, chainWith({ [id]: [{ publicKey, fullAccess: true }] })).keyFor(id)).toBeNull();
    expect(await new KeyStore(repo, KEY, chainWith({ [id]: [{ publicKey, receiverId: "other.testnet" }] })).keyFor(id)).toBeNull();
    expect(await new KeyStore(repo, KEY, chainWith({ [id]: [{ publicKey: "ed25519:somebodyelse" }] })).keyFor(id)).toBeNull();
  });

  it("ciphertexts are bound to their agent and key", () => {
    const c = new KeyCipher(KEY);
    const blob = c.seal("a.x.testnet", "ed25519:pk", "secret");
    expect(c.open("a.x.testnet", "ed25519:pk", blob)).toBe("secret");
    expect(() => c.open("b.x.testnet", "ed25519:pk", blob)).toThrow();
    expect(() => new KeyCipher(Buffer.alloc(32, 1)).open("a.x.testnet", "ed25519:pk", blob)).toThrow();
  });
});
