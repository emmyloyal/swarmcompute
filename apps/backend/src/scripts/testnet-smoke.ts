/**
 * End-to-end check on NEAR Testnet, acting as real users (RULES.md R1, R20).
 *
 * With the market host running (`pnpm start`), this script:
 *   1. creates four user wallets (full-access testnet accounts the users own);
 *   2. each user asks the host for an agent key (POST /api/agent-keys) and opens
 *      their agent FROM THEIR OWN WALLET: two buyers with requests and budgets,
 *      two sellers with offers, minimum prices and strategies;
 *   3. then only watches: the host groups the buyers, their agents prepay,
 *      seller agents bid, the lowest bid wins, delivery is simulated, the
 *      winning seller's owner is paid;
 *   4. a buyer's owner withdraws the leftover budget to their own wallet.
 *
 *   pnpm --filter @swarmcompute/backend testnet:smoke [--api http://localhost:4000] [--fund-from-operator]
 *
 * `--fund-from-operator` creates the user wallets under the operator account
 * (0.3 NEAR each) instead of asking the testnet helper, which rate-limits.
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, actions, JsonRpcProvider, KeyPair, KeyPairSigner, nearToYocto, type KeyPairString } from "near-api-js";
import { toTxResult } from "../chain/near-client.js";
import type { ContractPurchase } from "../chain/marketplace.js";
import type { MarketSnapshot } from "../host/market.js";

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.env") });

const RPC = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const CONTRACT = process.env.MARKETPLACE_CONTRACT_ID!;
const API = process.argv.includes("--api") ? process.argv[process.argv.indexOf("--api") + 1]! : `http://localhost:${process.env.BACKEND_PORT ?? 4000}`;
const HELPER = "https://helper.testnet.near.org/account";
const MILLI = 10n ** 21n;
const tag = (Date.now() % 100_000).toString();

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.url} -> HTTP ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined>, timeoutMs: number, everyMs = 4000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

async function main(): Promise<void> {
  if (!CONTRACT) throw new Error("MARKETPLACE_CONTRACT_ID is not set");
  const provider = new JsonRpcProvider({ url: RPC });
  const status = (await provider.viewNodeStatus()) as { chain_id?: string };
  if (status.chain_id !== "testnet") throw new Error(`RPC chain_id is ${status.chain_id}, expected testnet`);
  const meta = await json<{ openFee: string; host: { tick: number } }>(await fetch(`${API}/api/meta`));
  if (!meta.openFee) throw new Error("the host hasn't read the contract yet; is it running against this contract?");
  const openFee = BigInt(meta.openFee);
  console.log(`host at ${API} (tick ${meta.host.tick}), contract ${CONTRACT}, open fee ${openFee} yocto`);

  // 1. A funding account (testnet helper, or the operator), and four user wallets under it.
  const fromOperator = process.argv.includes("--fund-from-operator");
  let funder: Account;
  if (fromOperator) {
    const op = process.env.OPERATOR_ACCOUNT_ID;
    const sk = process.env.OPERATOR_PRIVATE_KEY;
    if (!op || !sk) throw new Error("OPERATOR_ACCOUNT_ID / OPERATOR_PRIVATE_KEY are not set");
    funder = new Account(op, provider, KeyPairSigner.fromSecretKey(sk as KeyPairString));
  } else {
    const fk = KeyPair.fromRandom("ed25519");
    const funderId = `users-${Date.now()}.testnet`;
    const res = await fetch(HELPER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: funderId, newAccountPublicKey: fk.getPublicKey().toString() }) });
    if (!res.ok) throw new Error(`testnet helper refused ${funderId}: HTTP ${res.status} (try --fund-from-operator)`);
    await waitFor("funder account", async () => provider.viewAccount({ accountId: funderId }).then(() => true).catch(() => null), 60_000, 2000);
    funder = new Account(funderId, provider, new KeyPairSigner(fk));
  }
  const funderId = funder.accountId;
  const users: Record<string, Account> = {};
  for (const name of ["alice", "bob", "dave", "erin"]) {
    const id = fromOperator ? `${name}${tag}.${funderId}` : `${name}.${funderId}`;
    const k = KeyPair.fromRandom("ed25519");
    const out = await funder.signAndSendTransaction({
      receiverId: id,
      actions: [actions.createAccount(), actions.transfer(nearToYocto(fromOperator ? "0.3" : "1.5")), actions.addFullAccessKey(k.getPublicKey())],
      throwOnFailure: false,
      waitUntil: "FINAL",
    });
    const r = toTxResult(out, funderId, id, "create_account");
    if (!r.ok) throw new Error(`creating ${id} failed in ${r.txHash}`);
    users[name] = new Account(id, provider, new KeyPairSigner(KeyPair.fromString(k.toString() as KeyPairString)));
    console.log(`user wallet ${id}  tx ${r.txHash}`);
  }

  // 2. Each user opens their own agent from their own wallet with a key from the host.
  const block = await provider.viewBlock({ finality: "final" });
  const deadline = (BigInt(block.header.timestamp_nanosec) + 2n * 3600n * 10n ** 9n).toString();
  const open = async (owner: Account, role: "BUYER" | "SELLER", name: string, method: string, args: Record<string, unknown>, deposit: bigint) => {
    const { agentId, publicKey } = await json<{ agentId: string; publicKey: string }>(
      await fetch(`${API}/api/agent-keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role, name }) }),
    );
    const out = await owner.signAndSendTransaction({
      receiverId: CONTRACT,
      actions: [actions.functionCall(method, { name, public_key: publicKey, ...args }, 150n * 10n ** 12n, deposit)],
      throwOnFailure: false,
      waitUntil: "FINAL",
    });
    const r = toTxResult(out, owner.accountId, CONTRACT, method);
    if (!r.ok) throw new Error(`${method} ${name} failed in ${r.txHash}: ${JSON.stringify(r.error)}`);
    console.log(`${owner.accountId} opened ${role.toLowerCase()} agent ${agentId}  tx ${r.txHash}`);
    return agentId;
  };
  const budget = 100n * MILLI;
  const req = (hours: number, maxMilli: bigint) => ({ gpu_model: "A100", vram_gb: 80, hours, max_price_per_hour: (maxMilli * MILLI).toString(), deadline });
  const alice = await open(users.alice!, "BUYER", `alice${tag}`, "open_buyer_agent", { request: req(10, 3n) }, openFee + budget);
  const bob = await open(users.bob!, "BUYER", `bob${tag}`, "open_buyer_agent", { request: req(20, 2n) }, openFee + budget);
  const offers = [{ gpu_model: "A100", vram_gb: 80, capacity_hours: 100 }];
  const dave = await open(users.dave!, "SELLER", `dave${tag}`, "open_seller_agent", { offers, min_price_per_hour: (15n * MILLI / 10n).toString(), strategy: { kind: "BELOW_CEILING", discount_bps: 1000 } }, openFee);
  const erin = await open(users.erin!, "SELLER", `erin${tag}`, "open_seller_agent", { offers, min_price_per_hour: MILLI.toString(), strategy: { kind: "AT_MINIMUM" } }, openFee);

  // 3. Watch only.
  console.log("\nwatching the market host (no further user action)...");
  let seen = "";
  const done = await waitFor(
    "a completed round for these agents",
    async () => {
      const s = await json<MarketSnapshot>(await fetch(`${API}/api/market`));
      const mine = s.purchases.find((p) => p.allocations.some((a) => a.buyer_id === alice) || s.coalitions[p.coalition_id]?.members.some((m) => m.buyer_id === alice));
      const line = mine ? `${mine.purchase_id} ${mine.state} bids=${mine.bids.length}` : `waiting: ${s.waiting[alice] ?? "-"} / ${s.waiting[bob] ?? "-"}`;
      if (line !== seen) console.log(`  ${new Date().toISOString().slice(11, 19)} ${line}`);
      seen = line;
      return mine && ["COMPLETED", "FAILED", "EXPIRED", "REFUNDED"].includes(mine.state) ? mine : null;
    },
    20 * 60_000,
  );
  report(done, { alice, bob, dave, erin });
  if (done.state !== "COMPLETED") throw new Error(`round ended ${done.state}`);

  // 4. Alice withdraws her leftover budget to her own wallet.
  const before = BigInt((await provider.viewAccount({ accountId: users.alice!.accountId })).amount);
  const out = await users.alice!.signAndSendTransaction({
    receiverId: CONTRACT,
    actions: [actions.functionCall("withdraw", { buyer_id: alice }, 100n * 10n ** 12n, 0n)],
    throwOnFailure: false,
    waitUntil: "FINAL",
  });
  const w = toTxResult(out, users.alice!.accountId, CONTRACT, "withdraw");
  const after = BigInt((await provider.viewAccount({ accountId: users.alice!.accountId })).amount);
  console.log(`\nalice withdrew her leftover budget to her own wallet: +${after - before} yocto net of gas  tx ${w.txHash} ${w.ok ? "ok" : "FAILED"}`);
  console.log("PASS");
}

function report(p: ContractPurchase, ids: Record<string, string>) {
  const name = (id: string | null) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;
  console.log(`\n${p.purchase_id}: ${p.state}`);
  for (const b of p.bids) console.log(`  bid  ${name(b.seller_id)}: ${b.revealed_price_per_hour ?? "unrevealed"} yocto/h  eligible=${b.eligible}`);
  console.log(`  winner ${name(p.winner_seller_id)} at ${p.clearing_price_per_hour} yocto/h; paid out ${p.paid_out} yocto to its owner`);
  for (const a of p.allocations) console.log(`  member ${name(a.buyer_id)}: ${a.hours} h, own max ${a.max_price_per_hour}, prepaid ${a.prepaid}, paid ${a.owed}, back ${a.excess}`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
