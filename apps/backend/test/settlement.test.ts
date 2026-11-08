import { describe, expect, it } from "vitest";
import type { PayloadOf } from "@swarmcompute/shared";
import { decideVerification } from "../src/agents/verification-agent.js";
import { SettlementEngine } from "../src/settlement/engine.js";
import { hashJobLog, simulateDelivery } from "../src/sim/gpu.js";
import { setup } from "./auction.test.js";

const base = { seed: "s", purchaseId: "purchase-1", sellerId: "seller-01", gpuModel: "A100", vramGb: 80, requiredHours: 20, startedAt: new Date("2026-11-08T00:00:00Z") };

describe("simulateDelivery", () => {
  it("is deterministic per (seed, purchase) and labelled simulated", () => {
    const a = simulateDelivery({ ...base, failureProbabilityBps: 5000 });
    expect(simulateDelivery({ ...base, failureProbabilityBps: 5000 })).toEqual(a);
    expect(a.jobLog).toContain("SIMULATED");
    expect(hashJobLog(a.jobLog)).toBe(a.jobLogHashHex);
  });
  it("follows the failure probability and keeps hours consistent with the outcome", () => {
    const outcomes = (bps: number) => Array.from({ length: 50 }, (_, i) => simulateDelivery({ ...base, purchaseId: `purchase-${i}`, failureProbabilityBps: bps }));
    expect(outcomes(0).every((d) => d.outcome === "SUCCESS" && d.allocatedHours === 20)).toBe(true);
    const bad = outcomes(10_000);
    expect(bad.some((d) => d.outcome === "SUCCESS")).toBe(false);
    for (const d of bad) {
      if (d.outcome === "FAILURE") expect(d.allocatedHours).toBe(0);
      else expect(d.allocatedHours > 0 && d.allocatedHours < 20).toBe(true);
    }
    expect(simulateDelivery({ ...base, failureProbabilityBps: 0, force: "FAILURE" }).outcome).toBe("FAILURE");
  });
});

describe("decideVerification", () => {
  const report = (d: ReturnType<typeof simulateDelivery>): PayloadOf<"DELIVERY_REPORT"> => ({
    purchase_id: d.purchaseId, seller_id: d.sellerId, outcome: d.outcome, required_hours: d.requiredHours, allocated_hours: d.allocatedHours,
    started_at: d.startedAt.toISOString(), finished_at: d.finishedAt.toISOString(), job_log_hash_hex: d.jobLogHashHex, simulated: true, tx_hash: "1".repeat(44),
  });
  it("passes only full, hash-verified deliveries; partial is a failure (full refund policy)", () => {
    const ok = simulateDelivery({ ...base, failureProbabilityBps: 0 });
    expect(decideVerification(report(ok), ok.jobLog, ok.jobLogHashHex).success).toBe(true);
    expect(decideVerification(report(ok), ok.jobLog + "tampered", ok.jobLogHashHex).success).toBe(false);
    expect(decideVerification(report(ok), ok.jobLog, "0".repeat(64)).success).toBe(false);
    const partial = simulateDelivery({ ...base, failureProbabilityBps: 0, force: "PARTIAL" });
    expect(decideVerification(report(partial), partial.jobLog, partial.jobLogHashHex)).toMatchObject({ success: false, reason: expect.stringMatching(/partial/) });
  });
});

async function funded() {
  const t = await setup("settle-seed");
  await t.engine.registerParticipants();
  const runs = (await t.engine.runAll(t.formed.coalitions.map((c) => c.coalitionId))).filter((r) => r.state === "FUNDED");
  expect(runs.length).toBeGreaterThanOrEqual(2);
  const sleep = async (ms: number) => t.fake.advance(Math.ceil(ms / 1000));
  const mk = (force: Record<string, "SUCCESS" | "FAILURE" | "PARTIAL"> = {}) =>
    new SettlementEngine({ swarm: t.swarm, contract: t.fake, seed: "settle-seed", verifierAccountId: "verifier.testnet", force, sleep });
  return { ...t, runs, mk };
}

describe("SettlementEngine", () => {
  it("pays the seller after verified delivery; a failed delivery returns each buyer's owed amount to its own wallet", async () => {
    const { fake, swarm, runs, mk } = await funded();
    const [good, bad] = runs as [(typeof runs)[0], (typeof runs)[0]];
    const before = new Map([...fake.received]);
    const out = await mk({ [good.purchaseId]: "SUCCESS", [bad.purchaseId]: "PARTIAL" }).settleAll([good.purchaseId, bad.purchaseId]);
    expect(swarm.bus.deliveryErrors).toEqual([]);

    const pg = (await fake.getPurchase(good.purchaseId))!;
    expect(out[0]).toMatchObject({ path: "DELIVERED", finalState: "COMPLETED" });
    expect(fake.received.get(swarm.seller(pg.winner_seller_id!).profile.payoutAccount)).toBe(BigInt(pg.paid_out!));
    expect(BigInt(pg.paid_out!)).toBe(pg.allocations.reduce((s, a) => s + BigInt(a.owed), 0n));

    const pb = (await fake.getPurchase(bad.purchaseId))!;
    expect(out[1]).toMatchObject({ path: "DELIVERED", finalState: "REFUNDED", decision: { success: false } });
    for (const a of pb.allocations) {
      const w = swarm.buyer(a.buyer_id).profile.wallet;
      // Excess came back at award; owed comes back now: in total, everything it prepaid.
      expect((fake.received.get(w) ?? 0n) - (before.get(w) ?? 0n)).toBe(BigInt(a.owed));
      expect(BigInt(a.refunded)).toBe(BigInt(a.owed));
    }
    expect(fake.calls.filter((c) => c === "payout")).toEqual([]);
    expect(fake.totalBalances).toBe(0n);
    expect(swarm.coalitionAgent.coalitions.get(good.coalitionId)!.status).toBe("CLOSED");
    const gb = swarm.buyer(pg.allocations[0]!.buyer_id);
    expect(gb.remainingBudget()).toBe(gb.profile.maxBudgetYocto - BigInt(pg.allocations[0]!.owed));
  });

  it("retries a failed payout; never pays twice; a later run completes it", async () => {
    const { fake, swarm, runs, mk } = await funded();
    const r = runs[0]!;
    const p = (await fake.getPurchase(r.purchaseId))!;
    const acct = swarm.seller(p.winner_seller_id!).profile.payoutAccount;
    fake.missingAccounts.add(acct);
    const first = await mk({ [r.purchaseId]: "SUCCESS" }).settle(r.purchaseId);
    expect(first).toMatchObject({ finalState: "VERIFYING", retries: 2 });
    expect(fake.received.get(acct)).toBeUndefined();
    fake.missingAccounts.delete(acct);
    expect(await mk().settle(r.purchaseId)).toMatchObject({ path: "RETRY_ONLY", finalState: "COMPLETED" });
    const paid = fake.received.get(acct);
    expect((await mk().settle(r.purchaseId)).txs).toEqual([]);
    expect(fake.received.get(acct)).toBe(paid);
  });

  it("retries a failed withdrawal to a buyer wallet and never sends it twice", async () => {
    const { fake, swarm, runs, mk } = await funded();
    const r = runs[0]!;
    const p = (await fake.getPurchase(r.purchaseId))!;
    const victim = p.allocations[0]!.buyer_id;
    const wallet = swarm.buyer(victim).profile.wallet;
    const before = fake.received.get(wallet) ?? 0n;
    fake.missingAccounts.add(wallet);
    await mk({ [r.purchaseId]: "FAILURE" }).settle(r.purchaseId);
    const credited = BigInt((await fake.getBuyer(victim))!.balance);
    expect(credited).toBe(BigInt(p.allocations[0]!.owed));
    fake.missingAccounts.delete(wallet);
    await mk().settle(r.purchaseId);
    expect((fake.received.get(wallet) ?? 0n) - before).toBe(credited);
    await mk().settle(r.purchaseId);
    expect((fake.received.get(wallet) ?? 0n) - before).toBe(credited);
  });

  it("expires a purchase past its delivery deadline and refunds each buyer", async () => {
    const { fake, swarm, runs, mk } = await funded();
    const r = runs[0]!;
    const p = (await fake.getPurchase(r.purchaseId))!;
    const before = new Map([...fake.received]);
    fake.advance(601);
    expect(await mk().settle(r.purchaseId)).toMatchObject({ path: "EXPIRED", finalState: "REFUNDED" });
    expect(fake.calls).not.toContain("start_delivery");
    for (const a of p.allocations) {
      const w = swarm.buyer(a.buyer_id).profile.wallet;
      expect((fake.received.get(w) ?? 0n) - (before.get(w) ?? 0n)).toBe(BigInt(a.owed));
    }
  });
});
