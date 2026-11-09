/**
 * One-time NEAR Testnet setup for the demo (RULES.md R1: testnet only).
 *
 *   pnpm --filter @swarmcompute/backend testnet:setup
 *
 * 1. Creates a dev account through the testnet helper (testnet faucet funds it).
 *    It holds the owner, operator and verifier roles (separate fields so they
 *    can be split later). It is never an agent and never owns one.
 * 2. Creates `market.<dev>` and, in one transaction, funds it, deploys
 *    contracts/marketplace/target/near/marketplace.wasm and calls `new`.
 * 3. Writes the account IDs, the private key and fresh keystore / bid
 *    encryption keys into the repo-root `.env` (git-ignored, RULES.md R6).
 *    Never prints a key.
 *
 * No buyer or seller agents are created: real users open their own (R20, R25).
 *
 * Refuses to run if .env already points at a deployed contract (pass --force).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, actions, JsonRpcProvider, KeyPair, KeyPairSigner, nearToYocto } from "near-api-js";
import { toTxResult } from "../chain/near-client.js";
import { randomBytes } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ENV = resolve(ROOT, ".env");
const WASM = resolve(ROOT, "contracts/marketplace/target/near/marketplace.wasm");
const RPC = process.env.NEAR_TESTNET_RPC_URL ?? "https://test.rpc.fastnear.com";
const HELPER = "https://helper.testnet.near.org/account";

function setEnv(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  return re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
}

async function waitForAccount(provider: JsonRpcProvider, id: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      await provider.viewAccount({ accountId: id });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`account ${id} did not appear on testnet`);
}

async function main(): Promise<void> {
  const env = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
  const current = /^MARKETPLACE_CONTRACT_ID=(.*)$/m.exec(env)?.[1]?.trim() ?? "";
  if (current && !current.includes("your-operator") && !process.argv.includes("--force")) {
    throw new Error(`.env already points at ${current}; pass --force to deploy a new one`);
  }
  if (!existsSync(WASM)) throw new Error(`${WASM} missing: run \`cargo near build non-reproducible-wasm --no-abi\` in contracts/marketplace`);
  const wasm = readFileSync(WASM);

  const provider = new JsonRpcProvider({ url: RPC });
  const status = (await provider.viewNodeStatus()) as { chain_id?: string };
  if (status.chain_id !== "testnet") throw new Error(`RPC chain_id is ${status.chain_id}, expected testnet`);

  // 1. Dev account via the testnet helper.
  const key = KeyPair.fromRandom("ed25519");
  const devId = `swarm-${Date.now()}.testnet`;
  const res = await fetch(HELPER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: devId, newAccountPublicKey: key.getPublicKey().toString() }),
  });
  if (!res.ok) throw new Error(`testnet helper refused to create ${devId}: HTTP ${res.status} ${await res.text()}`);
  await waitForAccount(provider, devId);
  const dev = new Account(devId, provider, new KeyPairSigner(key));
  const bal = await provider.viewAccount({ accountId: devId });
  console.log(`dev account ${devId} (balance ${BigInt(bal.amount) / 10n ** 21n} mNEAR)`);

  // 2. Contract account: create + fund + key + deploy + init, atomically.
  const contractId = `market.${devId}`;
  const init = { owner: devId, operator: devId, verifier: devId };
  const out = await dev.signAndSendTransaction({
    receiverId: contractId,
    actions: [
      actions.createAccount(),
      // Funds escrow storage and the sponsor pool: each new agent gets a 0.1 NEAR gas fund from it.
      actions.transfer(nearToYocto("8")),
      actions.addFullAccessKey(key.getPublicKey()),
      actions.deployContract(wasm),
      actions.functionCall("new", init, 100n * 10n ** 12n, 0n),
    ],
    throwOnFailure: false,
    waitUntil: "FINAL",
  });
  const deploy = toTxResult(out, devId, contractId, "create+deploy+new");
  if (!deploy.ok) throw new Error(`deploy failed in tx ${deploy.txHash}: ${JSON.stringify(deploy.error)}`);
  console.log(`contract ${contractId} deployed + initialised  tx ${deploy.txHash}`);

  // 3. .env (git-ignored).
  let text = env;
  const sk = key.toString();
  const keyIfMissing = (k: string) => /^[0-9a-fA-F]{64}$/.test(/^${k}=(.*)$/m.exec(text)?.[1]?.trim() ?? "") ? null : randomBytes(32).toString("hex");
  const fresh: Record<string, string> = {};
  for (const k of ["KEYSTORE_ENCRYPTION_KEY", "BID_ENCRYPTION_KEY"]) {
    const v = keyIfMissing(k);
    if (v) fresh[k] = v;
  }
  for (const [k, v] of Object.entries({
    ...fresh,
    NEAR_RPC_URL: RPC,
    MARKETPLACE_CONTRACT_ID: contractId,
    VITE_MARKETPLACE_CONTRACT_ID: contractId,
    OWNER_ACCOUNT_ID: devId,
    OPERATOR_ACCOUNT_ID: devId,
    VERIFIER_ACCOUNT_ID: devId,
    OPERATOR_PRIVATE_KEY: sk,
    VERIFIER_PRIVATE_KEY: sk,
  })) {
    text = setEnv(text, k, v);
  }
  writeFileSync(ENV, text, "utf8");
  console.log(`\n.env updated (contract, roles, keys). Keys were written to .env only.`);
  console.log(`explorer: https://testnet.nearblocks.io/address/${contractId}`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
