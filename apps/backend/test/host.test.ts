import { describe, expect, it } from "vitest";
import { nearToYocto } from "@swarmcompute/shared";
import { BidVault } from "../src/crypto/bid-vault.js";
import { MemActivity } from "../src/host/activity.js";
import { MemBidStore, planBid } from "../src/host/bids.js";
import { MarketHost } from "../src/host/market.js";
import { FakeContract } from "./fake-contract.js";

const n = nearToYocto;
const WINDOWS = { prepay_secs: 60, commit_secs: 30, reveal_secs: 30, delivery_secs: 120, verification_secs: 120 };
const A100_80 = [{ gpu_model: "A100" as const, vram_gb: 80, capacity_hours: 100 }];

function setup() {
  const c = new FakeContract();
  // The host holds a key for an agent only if it's the one on the agent's account.
  const forgotten = new Set<string>();
  const keys = { keyFor: async (id: string) => (forgotten.has(id) ? null : (c.agentKeys.get(id) ?? null)) };
  const bids = new MemBidStore();
  const activity = new MemActivity();
  const host = new MarketHost({ contract: c, keys, bids, vault: new BidVault(Buffer.alloc(32, 7)), windows: WINDOWS, retryCooldownSecs: 600, activity });
  /** Tick, then move chain time on. */
  const step = async (secs = 10) => {
    const s = await host.tick();
    c.advance(secs);
    return s;
  };
  return { c, host, bids, activity, step, forget: (id: string) => forgotten.add(id) };
}

async function runUntil(step: (s?: number) => Promise<unknown>, done: () => boolean, max = 60) {
  for (let i = 0; i < max && !done(); i++) await step(10);
  expect(done()).toBe(true);
}

describe("market host", () => {
  it("runs a whole round: coalition, own-key prepay, sealed bids, lowest wins, simulated delivery, payout to the seller's owner", async () => {
    const { c, step, activity, bids } = setup();
    const alice = c.openBuyer("alice", "alice.testnet", "k-alice", n("1"), c.request("A100", 80, 10, n("0.003")));
    const bob = c.openBuyer("bob", "bob.testnet", "k-bob", n("1"), c.request("A100", 40, 20, n("0.002")));
    const dave = c.openSeller("dave", "dave.testnet", "k-dave", A100_80, n("0.0015"));
    const erin = c.openSeller("erin", "erin.testnet", "k-erin", A100_80, n("0.001"));

    await runUntil(step, () => [...c.purchases.values()].some((p) => p.state === "COMPLETED"));
    const p = [...c.purchases.values()][0]!;
    const coal = c.coalitions.get(p.coalition_id)!;
    // Both buyers were grouped: same GPU, VRAM = the strictest member's.
    expect(coal.members.map((m) => m.buyer_id).sort()).toEqual([alice, bob].sort());
    expect(coal.vram_gb).toBe(80);
    // Every agent signed its own actions.
    const signers = (m: string) => c.calls.filter((x) => x.method === m).map((x) => x.signer).sort();
    expect(signers("prepay")).toEqual([alice, bob].sort());
    expect(signers("commit_bid")).toEqual([dave, erin].sort());
    expect(signers("reveal_bid")).toEqual([dave, erin].sort());
    // Lowest bid wins; one price for everyone; seller's owner paid hours × price.
    expect(p.winner_seller_id).toBe(erin);
    expect(p.clearing_price_per_hour).toBe(n("0.001").toString());
    expect(c.paidTo).toEqual([{ account: "erin.testnet", amount: n("0.001") * 30n }]);
    // Requests fulfilled; each buyer paid hours × clearing price, the rest stays available.
    expect(c.buyers.get(alice)!.request).toBeNull();
    expect(c.buyers.get(alice)!.available).toBe((n("1") - n("0.001") * 10n).toString());
    expect(c.buyers.get(bob)!.spent).toBe((n("0.001") * 20n).toString());
    // Simulated steps are labelled, and bid secrets are wiped after reveal.
    expect(activity.entries.filter((e) => e.simulated).map((e) => e.kind)).toEqual(["start_delivery", "submit_delivery_report", "verify"]);
    expect([...bids.bids.values()].every((b) => b.wiped)).toBe(true);
    // Nothing more happens afterwards.
    const before = c.calls.length;
    await step();
    await step();
    expect(c.calls.length).toBe(before);
  });

  it("waits when no seller can serve a request (no invented activity)", async () => {
    const { c, step } = setup();
    const alice = c.openBuyer("alice", "alice.testnet", "k-alice", n("1"), c.request("H100", 80, 10, n("0.003")));
    c.openSeller("dave", "dave.testnet", "k-dave", A100_80, n("0.001"));
    const s = await step();
    expect(s.waiting[alice]).toBe("NO_SELLER_FOR_SPEC");
    expect(c.calls).toHaveLength(0);
    // A matching seller appears: the round starts.
    c.openSeller("erin", "erin.testnet", "k-erin", [{ gpu_model: "H100", vram_gb: 80, capacity_hours: 50 }], n("0.002"));
    await step();
    expect(c.calls.map((x) => x.method)).toContain("register_coalition");
  });

  it("doesn't start a round no seller would bid on", async () => {
    const { c, step } = setup();
    const alice = c.openBuyer("alice", "alice.testnet", "k-alice", n("1"), c.request("A100", 80, 10, n("0.001")));
    c.openSeller("dave", "dave.testnet", "k-dave", A100_80, n("0.002"));
    const s = await step();
    expect(s.waiting[alice]).toBe("PRICE_BELOW_MARKET");
    expect(c.calls).toHaveLength(0);
  });

  it("only groups agents it runs and that can afford their prepayment", async () => {
    const { c, step } = setup();
    const own = c.openBuyer("selfrun", "x.testnet", null, n("1"), c.request("A100", 80, 10, n("0.003")));
    const poor = c.openBuyer("poor", "y.testnet", "k-poor", n("0.01"), c.request("A100", 80, 10, n("0.003")));
    const late = c.openBuyer("late", "z.testnet", "k-late", n("1"), c.request("A100", 80, 10, n("0.003"), 100));
    c.openSeller("dave", "dave.testnet", "k-dave", A100_80, n("0.001"));
    const s = await step();
    expect(s.waiting).toEqual({ [own]: "NOT_HOSTED", [poor]: "INSUFFICIENT_BALANCE", [late]: "DEADLINE_TOO_SOON" });
    expect(c.calls).toHaveLength(0);
  });

  it("an auction with no eligible bid refunds everyone and the buyers wait out the cooldown", async () => {
    const { c, step } = setup();
    const alice = c.openBuyer("alice", "alice.testnet", "k-alice", n("1"), c.request("A100", 80, 10, n("0.003")));
    // The seller's key isn't held by the host and its owner never bids.
    c.openSeller("dave", "dave.testnet", null, A100_80, n("0.001"));
    await runUntil(step, () => [...c.purchases.values()].some((p) => p.state === "REFUNDED"));
    expect(c.buyers.get(alice)!.available).toBe(n("1").toString());
    expect(c.buyers.get(alice)!.request).not.toBeNull();
    const s = await step();
    expect(s.waiting[alice]).toBe("RETRY_COOLDOWN");
    // A change in the seller market lifts the cooldown.
    c.openSeller("erin", "erin.testnet", "k-erin", A100_80, n("0.002"));
    await step();
    expect(c.purchases.size).toBe(2);
  });

  it("retries a failed payout until it succeeds, exactly once", async () => {
    const { c, step } = setup();
    c.openBuyer("alice", "alice.testnet", "k-alice", n("1"), c.request("A100", 80, 10, n("0.003")));
    c.openSeller("dave", "dave.testnet", "k-dave", A100_80, n("0.001"));
    c.failNextPayout = true;
    await runUntil(step, () => [...c.purchases.values()].some((p) => p.state === "COMPLETED"));
    expect(c.calls.filter((x) => x.method === "payout")).toHaveLength(1);
    expect(c.paidTo).toHaveLength(1);
  });

  it("expires a round whose members don't all prepay, returning the money", async () => {
    const { c, step, forget } = setup();
    const alice = c.openBuyer("alice", "alice.testnet", "k-alice", n("1"), c.request("A100", 80, 10, n("0.003")));
    c.openSeller("dave", "dave.testnet", "k-dave", A100_80, n("0.001"));
    await step(); // coalition + purchase
    // The host no longer holds the agent's key before it prepays; its owner never prepays either.
    forget(alice);
    await runUntil(step, () => [...c.purchases.values()].some((p) => p.state === "EXPIRED" || p.state === "REFUNDED"));
    expect(c.buyers.get(alice)!.coalition_id).toBeNull();
    expect(c.buyers.get(alice)!.available).toBe(n("1").toString());
    expect(c.calls.map((x) => x.method)).not.toContain("prepay");
  });
});

describe("seller pricing (on-chain terms only)", () => {
  const c = {
    coalition_id: "coalition-x",
    gpu_model: "A100" as const,
    vram_gb: 80,
    min_members: 1,
    members: [
      { buyer_id: "a", hours: 10, max_price_per_hour: n("0.004").toString() },
      { buyer_id: "b", hours: 10, max_price_per_hour: n("0.002").toString() },
    ],
    closed: false,
    live_purchase_id: null,
  };
  const seller = (over: object = {}) => ({
    seller_id: "s",
    owner: "o.testnet",
    opened: true,
    created_at: "0",
    active: true,
    offers: A100_80,
    min_price_per_hour: n("0.001").toString(),
    strategy: { kind: "AT_MINIMUM" as const },
    reputation: { wins: 0, completed_deliveries: 0, failed_deliveries: 0, non_reveals: 0 },
    ...over,
  });

  it("bids its minimum, or a discount below the ceiling, never outside [min, ceiling]", () => {
    expect(planBid(seller(), c)).toEqual({ bid: true, pricePerHour: n("0.001") });
    expect(planBid(seller({ strategy: { kind: "BELOW_CEILING", discount_bps: 2500 } }), c)).toEqual({ bid: true, pricePerHour: n("0.0015") });
    expect(planBid(seller({ strategy: { kind: "BELOW_CEILING", discount_bps: 9000 } }), c)).toEqual({ bid: true, pricePerHour: n("0.001") });
  });

  it("declines what it can't serve", () => {
    expect(planBid(seller({ active: false }), c)).toEqual({ bid: false, reason: "INACTIVE" });
    expect(planBid(seller({ offers: [{ gpu_model: "H100", vram_gb: 80, capacity_hours: 100 }] }), c)).toEqual({ bid: false, reason: "GPU_MISMATCH" });
    expect(planBid(seller({ offers: [{ gpu_model: "A100", vram_gb: 40, capacity_hours: 100 }] }), c)).toEqual({ bid: false, reason: "VRAM_TOO_LOW" });
    expect(planBid(seller({ offers: [{ gpu_model: "A100", vram_gb: 80, capacity_hours: 19 }] }), c)).toEqual({ bid: false, reason: "INSUFFICIENT_CAPACITY" });
    expect(planBid(seller({ min_price_per_hour: n("0.0021").toString() }), c)).toEqual({ bid: false, reason: "MIN_PRICE_ABOVE_CEILING" });
  });
});
