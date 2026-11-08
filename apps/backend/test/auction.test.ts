import { describe, expect, it } from "vitest";
import { mulPriceHours, SYSTEM_AGENTS, type AgentMessage } from "@swarmcompute/shared";
import { Swarm } from "../src/agents/swarm.js";
import { AuctionEngine } from "../src/auction/engine.js";
import { toTxResult } from "../src/chain/near-client.js";
import { BidVault } from "../src/crypto/bid-vault.js";
import { InMemoryMessageLog } from "../src/messaging/log.js";
import { FakeMarketplace } from "./fake-marketplace.js";

const WINDOWS = { prepay_secs: 300, commit_secs: 30, reveal_secs: 30, delivery_secs: 600, verification_secs: 600 };

export async function setup(seed = "auction-seed") {
  const fake = new FakeMarketplace();
  const clock = () => new Date(Number(fake.nowNs / 1_000_000n));
  const log = new InMemoryMessageLog();
  const swarm = new Swarm({
    seed,
    masterSecret: Buffer.alloc(32, 8),
    payoutAccounts: [1, 2, 3, 4, 5].map((i) => `seller${i}.op.testnet`),
    baseTime: clock(),
    log,
    vault: new BidVault(Buffer.alloc(32, 2)),
    maxAgeMs: 300_000,
    clock,
    buyerWalletParent: "dev.testnet",
  });
  await swarm.announce();
  const formed = await swarm.formCoalitions();
  const engine = new AuctionEngine({ swarm, contract: fake, windows: WINDOWS, sleep: async (ms) => fake.advance(Math.ceil(ms / 1000)) });
  return { fake, swarm, engine, formed, log };
}

describe("AuctionEngine: collective buying at one fair price", () => {
  it("every member prepays its own max, pays one clearing rate, and gets the excess back in its own wallet", async () => {
    const { fake, swarm, engine, formed, log } = await setup();
    expect(await engine.registerParticipants()).toEqual({ registered: 25, skipped: 0 });
    expect(await engine.registerParticipants()).toEqual({ registered: 0, skipped: 25 });
    const runs = await engine.runAll(formed.coalitions.map((c) => c.coalitionId));
    expect(swarm.bus.deliveryErrors).toEqual([]);
    expect(log.rows.filter((r) => r.status === "REJECTED")).toEqual([]);
    expect(fake.calls.lastIndexOf("prepay")).toBeLessThan(fake.calls.indexOf("commit_bid"));
    expect(fake.calls.lastIndexOf("commit_bid")).toBeLessThan(fake.calls.indexOf("reveal_bid"));

    const funded = runs.filter((r) => r.state === "FUNDED");
    expect(funded.length).toBeGreaterThanOrEqual(2);
    for (const r of funded) {
      const p = (await fake.getPurchase(r.purchaseId))!;
      const price = BigInt(p.clearing_price_per_hour!);
      // Clearing price = lowest eligible revealed bid.
      const eligible = p.bids.filter((b) => b.eligible).map((b) => BigInt(b.revealed_price_per_hour!));
      expect(price).toBe(eligible.reduce((a, b) => (a < b ? a : b)));
      for (const a of p.allocations) {
        const buyer = swarm.buyer(a.buyer_id);
        // Prepaid exactly hours × its own max; pays exactly hours × the shared clearing price.
        expect(BigInt(a.prepaid)).toBe(mulPriceHours(buyer.profile.maxPricePerHourYocto, a.hours));
        expect(BigInt(a.owed)).toBe(mulPriceHours(price, a.hours));
        expect(price <= buyer.profile.maxPricePerHourYocto).toBe(true);
        expect(BigInt(a.excess)).toBe(BigInt(a.prepaid) - BigInt(a.owed));
        // Excess reached the buyer's own wallet; nothing left credited.
        expect(fake.received.get(buyer.profile.wallet) ?? 0n).toBe(BigInt(a.excess));
        expect(BigInt((await fake.getBuyer(a.buyer_id))!.balance)).toBe(0n);
        // The buyer agent knows its own fairness record.
        expect(buyer.fairness.find((f) => f.purchaseId === r.purchaseId)).toMatchObject({ clearingPricePerHour: price, owed: BigInt(a.owed), excess: BigInt(a.excess) });
        expect(buyer.membership(r.coalitionId)?.state).toBe("FUNDED");
      }
      expect(BigInt(p.held)).toBe(p.allocations.reduce((s, a) => s + BigInt(a.owed), 0n));
    }
    expect(fake.totalEscrowed).toBe(funded.reduce((s, r) => s + r.requiredTotal!, 0n));
    expect(fake.totalBalances).toBe(0n);

    // Messages: prepayments from buyers, per-member funding with the arithmetic, balances returned.
    const treasury = swarm.inboxes.get(SYSTEM_AGENTS.TREASURY)!;
    expect(treasury.filter((m) => m.type === "PREPAYMENT").length).toBe(runs.reduce((s, r) => s + r.txs.filter((t) => t.label.startsWith("prepay")).length, 0));
    const fundingMsgs = log.rows.filter((r) => r.type === "FUNDING_CONFIRMATION");
    expect(fundingMsgs.length).toBe(funded.reduce((s, r) => s, 0) + (await Promise.all(funded.map((r) => fake.getPurchase(r.purchaseId)))).reduce((s, p) => s + p!.allocations.length, 0));
    expect(log.rows.filter((r) => r.type === "BALANCE_RETURNED").length).toBeGreaterThan(0);
  });

  it("a buyer that can't afford its prepayment leaves first; the rest still settle fairly", async () => {
    const { fake, swarm, engine, formed } = await setup();
    await engine.registerParticipants();
    const plan = formed.coalitions.find((c) => c.members.length >= 4)!;
    const leaver = swarm.buyer(plan.members[0]!.buyerId);
    leaver.syncFromChain(0n, leaver.profile.maxBudgetYocto); // budget already spent elsewhere
    const [run] = await engine.runAll([plan.coalitionId]);
    expect(run!.leftBuyers).toEqual([leaver.id]);
    const p = (await fake.getPurchase(run!.purchaseId))!;
    expect(p.state).toBe("FUNDED");
    expect(p.allocations.map((a) => a.buyer_id)).not.toContain(leaver.id);
    expect(fake.calls.indexOf("leave_coalition")).toBeLessThan(fake.calls.indexOf("prepay"));
  });

  it("no eligible bid returns every member's full prepayment to its wallet", async () => {
    const { fake, swarm, engine, formed } = await setup();
    await engine.registerParticipants();
    const plan = formed.coalitions[0]!;
    // Make every bid ineligible: sellers bid above an on-chain ceiling of 1 yocto.
    const real = fake.registerCoalition.bind(fake);
    fake.registerCoalition = (c) => real({ ...c, members: c.members.map((m) => ({ ...m, max_price_per_hour: 1n })) });
    for (const m of plan.members) {
      // Their own max on-chain is now 1 yocto/h, so they prepay exactly hours × 1.
      (swarm.buyer(m.buyerId).profile as { maxPricePerHourYocto: bigint }).maxPricePerHourYocto = 1n;
    }
    const [run] = await engine.runAll([plan.coalitionId]);
    expect(run!.state).toBe("REFUNDED");
    for (const m of plan.members) {
      expect(fake.received.get(swarm.buyer(m.buyerId).profile.wallet)).toBe(BigInt(m.hours));
    }
    expect(fake.totalEscrowed + fake.totalBalances).toBe(0n);
    expect(swarm.coalitionAgent.coalitions.get(plan.coalitionId)!.status).toBe("FAILED");
  });

  it("a failed transaction stops the run; an RPC outage records nothing", async () => {
    const a = await setup();
    await a.engine.registerParticipants();
    a.fake.failNext = "close_auction";
    await expect(a.engine.runAll([a.formed.coalitions[0]!.coalitionId])).rejects.toThrow(/close_auction failed/);
    const b = await setup();
    await b.engine.registerParticipants();
    b.fake.rpcDownFor = "close_auction";
    await expect(b.engine.runAll([b.formed.coalitions[0]!.coalitionId])).rejects.toThrow(/RPC unavailable/);
    expect(b.fake.calls).not.toContain("close_auction");
  });
});

describe("toTxResult", () => {
  const base = {
    final_execution_status: "FINAL",
    transaction: {},
    transaction_outcome: { id: "TxHash111", outcome: { logs: ['EVENT_JSON:{"standard":"swarmcompute","version":"1.0.0","event":"x","data":[{}]}'], receipt_ids: [], gas_burnt: 5, tokens_burnt: "0", executor_id: "a", status: { SuccessReceiptId: "r" } } },
  };
  it("parses success, events and receipt failures from a real outcome shape", () => {
    const ok = toTxResult({ ...base, status: { SuccessValue: "" }, receipts_outcome: [{ id: "r", outcome: { logs: ["hi"], receipt_ids: [], gas_burnt: 7, tokens_burnt: "0", executor_id: "c", status: { SuccessValue: "" } } }] } as never, "a", "c", "m");
    expect(ok).toMatchObject({ txHash: "TxHash111", ok: true, callSucceeded: true, failedReceipts: 0, gasBurnt: 12n });
    expect(ok.events.map((e) => e.event)).toEqual(["x"]);
    const bad = toTxResult({ ...base, status: { SuccessValue: "" }, receipts_outcome: [{ id: "r", outcome: { logs: [], receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: "c", status: { Failure: { ActionError: "x" } } } }] } as never, "a", "c", "m");
    expect(bad).toMatchObject({ ok: false, callSucceeded: true, failedReceipts: 1, error: { ActionError: "x" } });
  });
});

export type { AgentMessage };
