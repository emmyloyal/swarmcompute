import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BuyerRequirementPayload,
  createMessage,
  mulPriceHours,
  nearToYocto,
  SellerAvailabilityPayload,
  SYSTEM_AGENTS,
  verifyCommitment,
  type AgentMessage,
  type PayloadOf,
} from "@swarmcompute/shared";
import { BuyerAgent } from "../src/agents/buyer.js";
import { SellerAgent, strategyPrice } from "../src/agents/seller.js";
import { Swarm } from "../src/agents/swarm.js";
import { BidVault } from "../src/crypto/bid-vault.js";
import { MessageBus } from "../src/messaging/bus.js";
import { InMemoryMessageLog } from "../src/messaging/log.js";
import { Prng } from "../src/sim/prng.js";
import { generateBuyers, generateSellers, type BuyerProfile } from "../src/sim/profiles.js";

const SEED = "test-seed-1";
const BASE = new Date("2026-11-08T00:00:00.000Z");
const NOW = new Date("2026-11-08T00:00:10.000Z");
const clock = () => NOW;
const MASTER = Buffer.alloc(32, 7);
const PAYOUTS = [1, 2, 3, 4, 5].map((i) => `seller${i}.op.testnet`);
const n = nearToYocto;

function swarm(log = new InMemoryMessageLog()) {
  return {
    log,
    s: new Swarm({
      seed: SEED,
      masterSecret: MASTER,
      payoutAccounts: PAYOUTS,
      baseTime: BASE,
      log,
      vault: new BidVault(Buffer.alloc(32, 9)),
      maxAgeMs: 300_000,
      clock,
    }),
  };
}

// ---------------------------------------------------------------- PRNG

describe("Prng", () => {
  it("is deterministic per seed and label, independent across labels", () => {
    const a = new Prng("s", "x");
    const b = new Prng("s", "x");
    const seqA = Array.from({ length: 50 }, () => a.int(0, 1000));
    expect(Array.from({ length: 50 }, () => b.int(0, 1000))).toEqual(seqA);
    const c = new Prng("s", "y");
    expect(Array.from({ length: 50 }, () => c.int(0, 1000))).not.toEqual(seqA);
    // Drawing from one fork does not shift another.
    const r1 = new Prng("s", "root");
    const r2 = new Prng("s", "root");
    r1.fork("a").int(0, 9);
    expect(r1.fork("b").int(0, 1e6)).toBe(r2.fork("b").int(0, 1e6));
  });

  it("stays in range for ints, bigints and bps", () => {
    const r = new Prng("s", "range");
    for (let i = 0; i < 2000; i++) {
      const v = r.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
      const big = r.bigint(10n ** 20n, 10n ** 20n + 5n);
      expect(big >= 10n ** 20n && big <= 10n ** 20n + 5n).toBe(true);
    }
    expect(Array.from({ length: 100 }, () => r.chanceBps(0)).some(Boolean)).toBe(false);
    expect(Array.from({ length: 100 }, () => r.chanceBps(10_000)).every(Boolean)).toBe(true);
    expect(() => r.int(5, 4)).toThrow();
  });

  it("simulation code never calls Math.random (RULES.md R16)", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(__dirname, "../src"));
    const offenders = files.filter((f) => /Math\.random\s*\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------- profiles

describe("profiles", () => {
  it("creates 20 buyers deterministically with valid requirements", () => {
    const a = generateBuyers(SEED, BASE);
    expect(a).toHaveLength(20);
    expect(generateBuyers(SEED, BASE)).toEqual(a);
    expect(generateBuyers("other-seed", BASE)).not.toEqual(a);
    expect(a.map((b) => b.buyerId)).toEqual(Array.from({ length: 20 }, (_, i) => `buyer-${String(i + 1).padStart(3, "0")}`));
    for (const b of a) {
      // Budget always covers own hours at own max price.
      expect(b.maxBudgetYocto >= mulPriceHours(b.maxPricePerHourYocto, b.requiredHours)).toBe(true);
      expect(b.gpuModel === "H100" ? b.minVramGb === 80 : [40, 80].includes(b.minVramGb)).toBe(true);
    }
    const models = new Set(a.map((b) => b.gpuModel));
    expect(models).toEqual(new Set(["A100", "H100"]));
  });

  it("creates 5 sellers, one per strategy, with real payout accounts", () => {
    const s = generateSellers(PAYOUTS);
    expect(s.map((x) => x.sellerId)).toEqual(["seller-01", "seller-02", "seller-03", "seller-04", "seller-05"]);
    expect(new Set(s.map((x) => x.strategy)).size).toBe(5);
    expect(s.map((x) => x.payoutAccount)).toEqual(PAYOUTS);
    expect(() => generateSellers(PAYOUTS.slice(0, 4))).toThrow();
  });
});

// ---------------------------------------------------------------- buyers

function buyer(over: Partial<BuyerProfile> = {}) {
  const profile: BuyerProfile = {
    agentId: "buyer-001",
    buyerId: "buyer-001",
    gpuModel: "A100",
    minVramGb: 80,
    requiredHours: 10,
    maxBudgetYocto: n("0.02"),
    maxPricePerHourYocto: n("0.001"),
    latestDeliveryAt: new Date("2026-11-09T00:00:00.000Z"),
    wallet: "buyer001.dev.testnet",
    ...over,
  };
  return new BuyerAgent(profile, Buffer.alloc(32, 1), clock);
}

function proposal(b: BuyerAgent, over: Partial<PayloadOf<"COALITION_PROPOSAL">> = {}): PayloadOf<"COALITION_PROPOSAL"> {
  const p = b.profile;
  const other = { buyer_id: "buyer-002", hours: 5, max_price_per_hour_yocto: n("0.002").toString(), max_budget_yocto: n("0.02").toString() };
  const me = {
    buyer_id: p.buyerId,
    hours: p.requiredHours,
    max_price_per_hour_yocto: p.maxPricePerHourYocto.toString(),
    max_budget_yocto: p.maxBudgetYocto.toString(),
  };
  return {
    coalition_id: "coalition-1",
    gpu_model: "A100",
    vram_gb: 80,
    members: [me, other],
    min_members: 2,
    total_hours: p.requiredHours + 5,
    price_ceiling_per_hour_yocto: p.maxPricePerHourYocto.toString(),
    total_budget_yocto: (p.maxBudgetYocto + n("0.02")).toString(),
    delivery_deadline: "2026-11-08T12:00:00.000Z",
    formation_seed: SEED,
    ...over,
  };
}

describe("BuyerAgent", () => {
  it("emits a schema-valid requirement", () => {
    const m = buyer().requirementMessage();
    expect(m.receiver_id).toBe(SYSTEM_AGENTS.COALITION);
    expect(BuyerRequirementPayload.safeParse(m.payload).success).toBe(true);
    expect(m.payload.max_price_per_hour_yocto).toBe(n("0.001").toString());
  });

  it("checks proposals against its own requirement", () => {
    const b = buyer();
    expect(b.evaluateProposal(proposal(b))).toEqual({ accept: true });
    expect(b.evaluateProposal(proposal(b, { vram_gb: 40 }))).toMatchObject({ accept: false, code: "VRAM" });
    expect(b.evaluateProposal(proposal(b, { gpu_model: "H100" }))).toMatchObject({ accept: false, code: "OTHER" });
    expect(b.evaluateProposal(proposal(b, { delivery_deadline: "2026-11-10T00:00:00.000Z" }))).toMatchObject({ code: "DEADLINE" });
    expect(b.evaluateProposal(proposal(b, { price_ceiling_per_hour_yocto: n("0.0011").toString() }))).toMatchObject({ code: "PRICE_CEILING" });
    const wrongHours = proposal(b);
    wrongHours.members[0]!.hours = 9;
    expect(b.evaluateProposal(wrongHours)).toMatchObject({ accept: false, code: "OTHER" });
    expect(b.evaluateProposal(proposal(b, { members: proposal(b).members.slice(1) }))).toMatchObject({ accept: false });
  });

  it("rejects a proposal whose prepayment (hours × own max) exceeds its budget", () => {
    // 10 h × 0.001 = 0.01 > budget 0.009
    const b = buyer({ maxBudgetYocto: n("0.009") });
    expect(b.evaluateProposal(proposal(b))).toMatchObject({ accept: false, code: "BUDGET" });
  });

  it("prepays exactly hours × its own max price, only within budget", () => {
    const b = buyer({ maxBudgetYocto: n("0.01") });
    expect(b.decidePrepay(10)).toEqual({ prepay: true, amount: n("0.01") }); // exactly the budget
    expect(b.decidePrepay(11)).toMatchObject({ prepay: false });
    expect(buyer().prepayAmount(7)).toBe(n("0.007"));
  });

  it("joins, prepays, records its fair-price funding, and can leave only before FUNDED", async () => {
    const { s, log } = swarm();
    const b = s.buyer("buyer-001");
    const key = s.systemKey(SYSTEM_AGENTS.COALITION);
    const prop = proposal(b, { gpu_model: b.profile.gpuModel, vram_gb: 80, delivery_deadline: BASE.toISOString() });
    await s.bus.send(createMessage({ type: "COALITION_PROPOSAL", sender_id: SYSTEM_AGENTS.COALITION, receiver_id: b.id, payload: prop, timestamp: NOW.toISOString() }, key));
    await s.bus.drain();
    expect(b.membership("coalition-1")?.state).toBe("ACCEPTED");
    expect(s.inboxes.get(SYSTEM_AGENTS.COALITION)!.map((m) => m.type)).toEqual(["COALITION_ACCEPTANCE"]);

    // Prepayment (real tx in production) -> PREPAYMENT to treasury.
    const hours = b.profile.requiredHours;
    const prepaid = b.prepayAmount(hours);
    expect((await s.bus.send(b.prepaid("coalition-1", "purchase-1", hours, "3".repeat(44)))).ok).toBe(true);
    expect(b.remainingBudget()).toBe(b.profile.maxBudgetYocto - prepaid);

    // Award at a clearing price below this buyer's max.
    const price = b.profile.maxPricePerHourYocto / 2n;
    await s.bus.send(
      createMessage(
        {
          type: "AUCTION_RESULT",
          sender_id: SYSTEM_AGENTS.AUCTION_COORDINATOR,
          receiver_id: b.id,
          timestamp: NOW.toISOString(),
          payload: {
            outcome: "AWARDED",
            auction_id: "auction-1",
            purchase_id: "purchase-1",
            coalition_id: "coalition-1",
            winner_seller_id: "seller-01",
            winning_price_per_hour_yocto: price.toString(),
            total_price_yocto: mulPriceHours(price, prop.total_hours).toString(),
            excluded: [],
            tx_hash: "1".repeat(44),
          },
        },
        s.systemKey(SYSTEM_AGENTS.AUCTION_COORDINATOR),
      ),
    );
    await s.bus.drain();
    const pre = s.inboxes.get(SYSTEM_AGENTS.TREASURY)![0] as AgentMessage<"PREPAYMENT">;
    expect(pre.payload).toMatchObject({ buyer_id: b.id, wallet: b.profile.wallet, hours, amount_yocto: prepaid.toString() });

    // Funding at the clearing price: owed = hours × price, excess = prepaid − owed.
    const owed = mulPriceHours(price, hours);
    await s.bus.send(
      createMessage(
        {
          type: "FUNDING_CONFIRMATION",
          sender_id: SYSTEM_AGENTS.TREASURY,
          receiver_id: b.id,
          timestamp: NOW.toISOString(),
          payload: {
            purchase_id: "purchase-1", buyer_id: b.id, clearing_price_per_hour_yocto: price.toString(), hours,
            prepaid_yocto: prepaid.toString(), owed_yocto: owed.toString(), excess_yocto: (prepaid - owed).toString(), tx_hash: "2".repeat(44),
          },
        },
        s.systemKey(SYSTEM_AGENTS.TREASURY),
      ),
    );
    await s.bus.drain();
    expect(b.membership("coalition-1")?.state).toBe("FUNDED");
    expect(b.fairness[0]).toMatchObject({ owed, excess: prepaid - owed });
    // Only what it owes stays committed; the excess is on its way back.
    expect(b.remainingBudget()).toBe(b.profile.maxBudgetYocto - owed);
    expect(() => b.leaveMessage("coalition-1", "changed my mind")).toThrow(/cannot leave/);
    // The swarm's real coalition agent never proposed this hand-made coalition, so it refuses the acceptance.
    expect(s.bus.deliveryErrors.map((d) => d.error)).toEqual(["unknown coalition coalition-1"]);
    expect(log.rows.every((r) => r.status === "ACCEPTED")).toBe(true);
  });

  it("leaving before funding releases the pending contribution", () => {
    const b = buyer();
    // simulate accepted membership via the public flow helpers
    const prop = proposal(b);
    expect(b.evaluateProposal(prop).accept).toBe(true);
    (b as unknown as { memberships: Map<string, unknown> }).memberships.set("coalition-1", { coalitionId: "coalition-1", hours: 10, state: "ACCEPTED" });
    const m = b.leaveMessage("coalition-1", "found a better deal");
    expect(m.type).toBe("COALITION_LEAVE");
    expect(b.membership("coalition-1")?.state).toBe("LEFT");
    expect(() => b.leaveMessage("coalition-1", "again")).toThrow();
    expect(() => b.leaveMessage("coalition-9", "never joined")).toThrow();
  });
});

// ---------------------------------------------------------------- sellers

function auctionReq(over: Partial<PayloadOf<"AUCTION_REQUEST">> = {}): PayloadOf<"AUCTION_REQUEST"> {
  return {
    auction_id: "auction-1",
    purchase_id: "purchase-1",
    coalition_id: "coalition-1",
    gpu_model: "A100",
    min_vram_gb: 80,
    total_hours: 30,
    price_ceiling_per_hour_yocto: n("0.001").toString(),
    total_budget_yocto: n("0.05").toString(),
    commit_deadline: "2026-11-08T01:00:00.000Z",
    reveal_deadline: "2026-11-08T02:00:00.000Z",
    ...over,
  };
}

describe("SellerAgent", () => {
  const vault = new BidVault(randomBytes(32));
  const sellers = generateSellers(PAYOUTS).map((p) => new SellerAgent(p, Buffer.alloc(32, 2), SEED, vault, clock));
  const [s1, s2, s3, s4, s5] = sellers as [SellerAgent, SellerAgent, SellerAgent, SellerAgent, SellerAgent];

  it("announces availability without its private minimum price", () => {
    for (const s of sellers) {
      for (const m of s.availabilityMessages()) {
        expect(SellerAvailabilityPayload.safeParse(m.payload).success).toBe(true);
        expect(JSON.stringify(m.payload)).not.toContain(s.profile.minPricePerHourYocto.toString());
      }
    }
  });

  it("bids within [min price, min(ceiling, budget/hours)] for every strategy", () => {
    for (let i = 0; i < 40; i++) {
      const req = auctionReq({ auction_id: `auction-${i}`, total_budget_yocto: n(i % 2 ? "0.05" : "0.024").toString() });
      const max = [n("0.001"), BigInt(req.total_budget_yocto) / 30n].reduce((a, b) => (a < b ? a : b));
      for (const s of [s1, s2, s4]) {
        const plan = s.planBid(req);
        if (!plan.bid) {
          expect(plan.reason).toBe("MIN_PRICE_ABOVE_LIMIT");
          expect(s.profile.minPricePerHourYocto > max).toBe(true);
          continue;
        }
        expect(plan.pricePerHourYocto >= s.profile.minPricePerHourYocto).toBe(true);
        expect(plan.pricePerHourYocto <= max).toBe(true);
        expect(mulPriceHours(plan.pricePerHourYocto, 30) <= BigInt(req.total_budget_yocto)).toBe(true);
      }
    }
  });

  it("is deterministic per (seed, seller, auction)", () => {
    const again = new SellerAgent(s1.profile, Buffer.alloc(32, 2), SEED, vault, clock);
    expect(again.planBid(auctionReq())).toEqual(s1.planBid(auctionReq()));
    const prices = new Set(Array.from({ length: 10 }, (_, i) => {
      const p = s5.planBid(auctionReq({ auction_id: `auction-x${i}`, gpu_model: "H100" }));
      return p.bid ? p.pricePerHourYocto : 0n;
    }));
    expect(prices.size).toBeGreaterThan(1);
  });

  it("declines when it cannot serve", () => {
    expect(s1.planBid(auctionReq({ gpu_model: "H100" }))).toEqual({ bid: false, reason: "GPU_MISMATCH" });
    expect(s5.planBid(auctionReq({ gpu_model: "A100", min_vram_gb: 80 }))).toEqual({ bid: false, reason: "VRAM_TOO_LOW" });
    expect(s3.planBid(auctionReq({ total_hours: 41 }))).toEqual({ bid: false, reason: "INSUFFICIENT_CAPACITY" });
    expect(s2.planBid(auctionReq({ price_ceiling_per_hour_yocto: n("0.0005").toString() }))).toEqual({ bid: false, reason: "MIN_PRICE_ABOVE_LIMIT" });
  });

  it("strategies order as designed on the same span", () => {
    const min = n("0.0004");
    const max = n("0.0014");
    const r = () => new Prng("s", "p");
    expect(strategyPrice("AGGRESSIVE_LOW", min, max, r()) < strategyPrice("LIMITED_CAPACITY", min, max, r())).toBe(true);
    expect(strategyPrice("FLEXIBLE", min, max, r()) < strategyPrice("PREMIUM_RELIABLE", min, max, r())).toBe(true);
  });

  it("seals bids: commitment verifies, secrets only in ciphertext, one bid per auction", () => {
    const req = auctionReq({ auction_id: "auction-seal" });
    const bid = s1.prepareBid(req);
    if (typeof bid === "string") throw new Error(bid);
    expect(s1.prepareBid(req)).toBe(bid); // idempotent
    const { pricePerHourYocto, nonceHex } = s1.revealSecret("auction-seal");
    expect(verifyCommitment(bid.commitmentHex, { auctionId: "auction-seal", sellerId: s1.id, pricePerHourYocto, nonce: Buffer.from(nonceHex, "hex") })).toBe(true);
    const c = s1.commitmentMessage("auction-seal", "3".repeat(44));
    expect(Object.keys(c.payload).sort()).toEqual(["auction_id", "commitment_hex", "seller_id", "tx_hash"]);
    expect(JSON.stringify(c)).not.toContain(nonceHex);
    expect(s1.revealMessage("auction-seal", "4".repeat(44)).payload.price_per_hour_yocto).toBe(pricePerHourYocto.toString());
    expect(s1.prepareBid(auctionReq({ auction_id: "auction-h", gpu_model: "H100" }))).toBe("GPU_MISMATCH");
  });
});

// ---------------------------------------------------------------- vault

describe("BidVault", () => {
  const v = new BidVault(randomBytes(32));
  it("round-trips and binds ciphertext to auction and seller", () => {
    const nonce = randomBytes(32);
    const sealed = v.seal("auction-1", "seller-01", 123456789n, nonce);
    expect(v.open("auction-1", "seller-01", sealed)).toEqual({ pricePerHourYocto: 123456789n, nonce });
    expect(() => v.open("auction-2", "seller-01", sealed)).toThrow();
    expect(() => v.open("auction-1", "seller-02", sealed)).toThrow();
    const tampered = { ...sealed, priceCiphertext: Buffer.from(sealed.priceCiphertext) };
    tampered.priceCiphertext[14]! ^= 1;
    expect(() => v.open("auction-1", "seller-01", tampered)).toThrow();
    expect(() => new BidVault(Buffer.alloc(16)).seal("a", "b", 1n, nonce)).toThrow();
  });
});

// ---------------------------------------------------------------- bus

describe("MessageBus", () => {
  function setup() {
    const log = new InMemoryMessageLog();
    let t = NOW.getTime();
    const bus = new MessageBus({ masterSecret: MASTER, log, maxAgeMs: 300_000, now: () => t });
    const got: string[] = [];
    const k1 = bus.register("buyer-001");
    bus.register(SYSTEM_AGENTS.COALITION, (m) => {
      got.push(m.message_id);
    });
    const req = (b: BuyerAgent) => b.requirementMessage();
    const b = new BuyerAgent({ ...generateBuyers(SEED, BASE)[0]! }, k1, clock);
    return { log, bus, got, b, req, setT: (v: number) => (t = v) };
  }

  it("delivers valid messages in order and logs them", async () => {
    const { bus, log, got, b } = setup();
    const m1 = b.requirementMessage();
    const m2 = b.requirementMessage();
    expect((await bus.send(m1)).ok).toBe(true);
    expect((await bus.send(m2)).ok).toBe(true);
    await bus.drain();
    expect(got).toEqual([m1.message_id, m2.message_id]);
    expect(log.rows.map((r) => r.status)).toEqual(["ACCEPTED", "ACCEPTED"]);
  });

  it("rejects and logs tampered, replayed, stale, unknown and unauthorized messages", async () => {
    const { bus, log, got, b, setT } = setup();
    const m = b.requirementMessage();

    const tampered = { ...m, payload: { ...m.payload, required_hours: m.payload.required_hours + 1 } };
    expect(await bus.send(tampered)).toMatchObject({ ok: false, code: "BAD_SIGNATURE" });

    expect((await bus.send(m)).ok).toBe(true);
    expect(await bus.send(m)).toMatchObject({ ok: false, code: "REPLAY" });

    expect(await bus.send({ ...m, type: "GIVE_ME_MONEY" })).toMatchObject({ ok: false, code: "UNKNOWN_TYPE" });
    expect(await bus.send("not an object")).toMatchObject({ ok: false, code: "MALFORMED_ENVELOPE" });

    // A seller key can't send a buyer message type.
    const sellerKey = bus.register("seller-01");
    const forged = createMessage({ type: "BUYER_REQUIREMENT", sender_id: "seller-01", receiver_id: SYSTEM_AGENTS.COALITION, payload: m.payload, timestamp: NOW.toISOString() }, sellerKey);
    expect(await bus.send(forged)).toMatchObject({ ok: false, code: "UNAUTHORIZED_SENDER" });

    const old = b.requirementMessage();
    setT(NOW.getTime() + 301_000);
    expect(await bus.send(old)).toMatchObject({ ok: false, code: "STALE" });

    await bus.drain();
    expect(got).toEqual([m.message_id]);
    const codes = log.rows.map((r) => r.rejection_code);
    expect(codes).toEqual(["BAD_SIGNATURE", null, "REPLAY", "UNKNOWN_TYPE", "MALFORMED_ENVELOPE", "UNAUTHORIZED_SENDER", "STALE"]);
    // A rejected message never consumes its ID: the tampered copy shared m's ID, yet m was accepted.
    expect(log.rows.filter((r) => r.status === "ACCEPTED").map((r) => r.message_id)).toEqual([m.message_id]);
  });

  it("records handler failures instead of swallowing them", async () => {
    const log = new InMemoryMessageLog();
    const bus = new MessageBus({ masterSecret: MASTER, log, maxAgeMs: 300_000, now: () => NOW.getTime() });
    const k = bus.register("buyer-001");
    bus.register(SYSTEM_AGENTS.COALITION, () => {
      throw new Error("boom");
    });
    await bus.send(new BuyerAgent(generateBuyers(SEED, BASE)[0]!, k, clock).requirementMessage());
    await bus.drain();
    expect(bus.deliveryErrors.map((d) => d.error)).toEqual(["boom"]);
  });
});

// ---------------------------------------------------------------- swarm

describe("Swarm", () => {
  it("runs 20 buyers and 5 sellers; every announcement is accepted and logged", async () => {
    const { s, log } = swarm();
    expect(s.buyers).toHaveLength(20);
    expect(s.sellers).toHaveLength(5);
    const r = await s.announce();
    const offers = s.sellers.reduce((k, x) => k + x.profile.offers.length, 0);
    expect(r).toEqual({ sent: 20 + offers * 2, rejected: 0 });
    expect(s.inboxes.get(SYSTEM_AGENTS.COALITION)).toHaveLength(20 + offers);
    expect(s.inboxes.get(SYSTEM_AGENTS.AUCTION_COORDINATOR)).toHaveLength(offers);
    expect(log.rows).toHaveLength(r.sent);
    expect(s.bus.deliveryErrors).toEqual([]);
  });

  it("delivers AUCTION_REQUEST to sellers, which prepare sealed bids", async () => {
    const { s } = swarm();
    // Only the coalition agent may send AUCTION_REQUEST (shared MESSAGE_SPECS).
    const key = s.systemKey(SYSTEM_AGENTS.COALITION);
    for (const seller of s.sellers) {
      const r = await s.bus.send(createMessage({ type: "AUCTION_REQUEST", sender_id: SYSTEM_AGENTS.COALITION, receiver_id: seller.id, payload: auctionReq(), timestamp: NOW.toISOString() }, key));
      expect(r.ok).toBe(true);
    }
    await s.bus.drain();
    expect(s.bus.deliveryErrors).toEqual([]);
    const bidders = s.sellers.filter((x) => x.pendingBid("auction-1")).map((x) => x.id);
    const decliners = s.sellers.filter((x) => x.declined.has("auction-1")).map((x) => x.id);
    expect([...bidders, ...decliners].sort()).toEqual(s.sellers.map((x) => x.id));
    expect(bidders).toContain("seller-01");
    expect(decliners).toContain("seller-05"); // only A100/40GB
  });
});
