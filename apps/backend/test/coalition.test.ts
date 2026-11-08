import { describe, expect, it } from "vitest";
import {
  CoalitionProposalPayload,
  createMessage,
  nearToYocto,
  SYSTEM_AGENTS,
  type AgentMessage,
  type GpuModel,
} from "@swarmcompute/shared";
import { CoalitionAgent, proposalPayload } from "../src/agents/coalition-agent.js";
import { Swarm } from "../src/agents/swarm.js";
import { formCoalitions, type FormationInput, type Offer, type Requirement } from "../src/coalition/form.js";
import { BidVault } from "../src/crypto/bid-vault.js";
import { MessageBus } from "../src/messaging/bus.js";
import { InMemoryMessageLog } from "../src/messaging/log.js";

const n = nearToYocto;
const NOW = new Date("2026-11-08T00:00:00.000Z");
const H = 3_600_000;
const REF: Record<GpuModel, bigint> = { A100: n("0.0005"), H100: n("0.0008") };

const OFFERS: Offer[] = [
  { sellerId: "seller-01", gpuModel: "A100", vramGb: 80, capacityHours: 100 },
  { sellerId: "seller-02", gpuModel: "A100", vramGb: 40, capacityHours: 60 },
  { sellerId: "seller-03", gpuModel: "H100", vramGb: 80, capacityHours: 50 },
];

let seq = 0;
function req(over: Partial<Requirement> = {}): Requirement {
  seq++;
  return {
    buyerId: `buyer-${String(seq).padStart(3, "0")}`,
    gpuModel: "A100",
    minVramGb: 80,
    requiredHours: 10,
    maxBudgetYocto: n("0.02"),
    maxPricePerHourYocto: n("0.001"),
    latestDeliveryAt: new Date(NOW.getTime() + 24 * H),
    ...over,
  };
}

function input(requirements: Requirement[], over: Partial<FormationInput> = {}): FormationInput {
  return { seed: "seed-a", round: 0, now: NOW, requirements, offers: OFFERS, referencePricePerHour: REF, minLeadMs: 2 * H, ...over };
}

describe("formCoalitions: determinism", () => {
  it("same inputs and seed give the same coalitions, regardless of input order", () => {
    seq = 0;
    const rs = Array.from({ length: 12 }, (_, i) => req({ requiredHours: 5 + (i % 7), maxPricePerHourYocto: n("0.0006") + BigInt(i % 4) * n("0.0001") }));
    const a = formCoalitions(input(rs));
    expect(formCoalitions(input(rs))).toEqual(a);
    expect(formCoalitions(input([...rs].reverse()))).toEqual(a);
    expect(formCoalitions(input(rs, { round: 1 })).coalitions[0]!.coalitionId).not.toBe(a.coalitions[0]!.coalitionId);
    expect(formCoalitions(input(rs, { seed: "seed-b" })).coalitions[0]!.coalitionId).not.toBe(a.coalitions[0]!.coalitionId);
  });
});

describe("formCoalitions: hard constraints", () => {
  it("never mixes models, satisfies every member's VRAM, deadline and seller capacity", () => {
    seq = 0;
    const rs = [
      ...Array.from({ length: 8 }, (_, i) => req({ minVramGb: i % 2 ? 40 : 80, requiredHours: 15, latestDeliveryAt: new Date(NOW.getTime() + (10 + i) * H) })),
      ...Array.from({ length: 4 }, () => req({ gpuModel: "H100", requiredHours: 12 })),
    ];
    const { coalitions, unserved } = formCoalitions(input(rs));
    expect(unserved).toEqual([]);
    const byId = new Map(rs.map((r) => [r.buyerId, r]));
    for (const c of coalitions) {
      const members = c.members.map((m) => byId.get(m.buyerId)!);
      expect(new Set(members.map((m) => m.gpuModel))).toEqual(new Set([c.gpuModel]));
      expect(members.every((m) => m.minVramGb <= c.vramGb)).toBe(true);
      expect(c.deliveryDeadline.getTime()).toBe(Math.min(...members.map((m) => m.latestDeliveryAt.getTime())));
      expect(c.deliveryDeadline.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 2 * H);
      expect(OFFERS.some((o) => o.gpuModel === c.gpuModel && o.vramGb >= c.vramGb && o.capacityHours >= c.totalHours)).toBe(true);
      expect(c.totalHours).toBe(c.members.reduce((s, m) => s + m.hours, 0));
      // Proposal is schema-valid (ceiling = lowest max price, budget = sum).
      expect(CoalitionProposalPayload.safeParse(proposalPayload(c)).success).toBe(true);
    }
    // 8 × 15 h A100 = 120 h > 100 h capacity: must split.
    expect(coalitions.filter((c) => c.gpuModel === "A100").length).toBeGreaterThanOrEqual(2);
  });

  it("reports buyers it cannot serve, with reasons", () => {
    seq = 0;
    const tooSoon = req({ latestDeliveryAt: new Date(NOW.getTime() + H) });
    const tooBig = req({ requiredHours: 101 });
    const noSeller = req({ gpuModel: "H100", minVramGb: 120 });
    const ok = req();
    const { coalitions, unserved } = formCoalitions(input([tooSoon, tooBig, noSeller, ok]));
    expect(unserved).toEqual([
      { buyerId: tooSoon.buyerId, reason: "DEADLINE_TOO_SOON" },
      { buyerId: tooBig.buyerId, reason: "EXCEEDS_CAPACITY" },
      { buyerId: noSeller.buyerId, reason: "NO_SELLER_FOR_SPEC" },
    ]);
    expect(coalitions.flatMap((c) => c.members.map((m) => m.buyerId))).toEqual([ok.buyerId]);
  });
});

describe("formCoalitions: optimisation (spec Section 5)", () => {
  it("excludes a low-ceiling buyer instead of letting it sink the coalition", () => {
    seq = 0;
    const good = Array.from({ length: 4 }, () => req({ maxPricePerHourYocto: n("0.0009") }));
    const low = req({ maxPricePerHourYocto: n("0.0001") }); // below the A100 market reference
    const { coalitions, unserved } = formCoalitions(input([...good, low]));
    expect(unserved).toEqual([{ buyerId: low.buyerId, reason: "PRICE_BELOW_MARKET" }]);
    expect(coalitions).toHaveLength(1);
    expect(coalitions[0]!.priceCeilingPerHourYocto).toBe(n("0.0009"));
  });

  it("serves every buyer that can be served and groups similar prices together", () => {
    seq = 0;
    // 10 × 20 h = 200 h; capacity 100 h => two coalitions; high payers together.
    const rs = Array.from({ length: 10 }, (_, i) => req({ requiredHours: 20, maxPricePerHourYocto: n("0.0005") + BigInt(i) * n("0.0001") }));
    const { coalitions, unserved } = formCoalitions(input(rs));
    expect(unserved).toEqual([]);
    expect(coalitions.reduce((k, c) => k + c.members.length, 0)).toBe(10);
    const [hi, lo] = coalitions;
    expect(hi!.priceCeilingPerHourYocto).toBe(n("0.001")); // top five: 0.0010..0.0014
    expect(lo!.priceCeilingPerHourYocto).toBe(n("0.0005"));
  });

  it("min_members tolerates losing up to half the members", () => {
    seq = 0;
    const { coalitions } = formCoalitions(input(Array.from({ length: 5 }, () => req())));
    expect(coalitions[0]!.minMembers).toBe(3);
  });
});

// ---------------------------------------------------------------- agent

function agentSetup() {
  const log = new InMemoryMessageLog();
  const bus = new MessageBus({ masterSecret: Buffer.alloc(32, 5), log, maxAgeMs: 300_000, now: () => NOW.getTime() });
  const events: string[] = [];
  const agent: CoalitionAgent = new CoalitionAgent(bus.register(SYSTEM_AGENTS.COALITION, (m, b) => agent.handle(m, b)), {
    seed: "seed-a",
    clock: () => NOW,
    referencePricePerHour: REF,
    hooks: {
      onActive: (c) => void events.push(`active:${c.plan.coalitionId}`),
      onFailed: (c) => void events.push(`failed:${c.plan.coalitionId}:${c.failureReason}`),
      onChanged: (c, b) => void events.push(`changed:${c.plan.coalitionId}:${b}`),
    },
  });
  const inbox = new Map<string, AgentMessage[]>();
  const keys = new Map<string, Buffer>();
  inbox.set(SYSTEM_AGENTS.AUCTION_COORDINATOR, []);
  bus.register(SYSTEM_AGENTS.AUCTION_COORDINATOR, (m) => void inbox.get(SYSTEM_AGENTS.AUCTION_COORDINATOR)!.push(m));
  const buyer = (id: string) => {
    inbox.set(id, []);
    keys.set(id, bus.register(id, (m) => void inbox.get(id)!.push(m)));
  };
  const send = async (type: "COALITION_ACCEPTANCE" | "COALITION_REJECTION" | "COALITION_LEAVE", buyerId: string, coalitionId: string) => {
    const payload =
      type === "COALITION_ACCEPTANCE"
        ? { coalition_id: coalitionId, buyer_id: buyerId }
        : type === "COALITION_REJECTION"
          ? { coalition_id: coalitionId, buyer_id: buyerId, reason_code: "OTHER" as const, reason: "no" }
          : { coalition_id: coalitionId, buyer_id: buyerId, reason: "leaving" };
    const r = await bus.send(createMessage({ type, sender_id: buyerId, receiver_id: SYSTEM_AGENTS.COALITION, payload: payload as never, timestamp: NOW.toISOString() }, keys.get(buyerId)!));
    expect(r.ok).toBe(true);
    await bus.drain();
  };
  const feed = async (rs: Requirement[]) => {
    const offerKey = bus.register("seller-01");
    for (const o of OFFERS) {
      const k = o.sellerId === "seller-01" ? offerKey : bus.register(o.sellerId);
      await bus.send(createMessage({ type: "SELLER_AVAILABILITY", sender_id: o.sellerId, receiver_id: SYSTEM_AGENTS.COALITION, timestamp: NOW.toISOString(), payload: { seller_id: o.sellerId, payout_account: `${o.sellerId.replace("-", "")}.op.testnet`, gpu_model: o.gpuModel, vram_gb: o.vramGb, capacity_hours: o.capacityHours, delivery_time_minutes: 30, simulated: true } }, k));
    }
    for (const r of rs) {
      buyer(r.buyerId);
      await bus.send(createMessage({ type: "BUYER_REQUIREMENT", sender_id: r.buyerId, receiver_id: SYSTEM_AGENTS.COALITION, timestamp: NOW.toISOString(), payload: { buyer_id: r.buyerId, gpu_model: r.gpuModel, min_vram_gb: r.minVramGb, required_hours: r.requiredHours, max_budget_yocto: r.maxBudgetYocto.toString(), max_price_per_hour_yocto: r.maxPricePerHourYocto.toString(), latest_delivery_at: r.latestDeliveryAt.toISOString() } }, keys.get(r.buyerId)!));
    }
    await bus.drain();
  };
  return { bus, agent, events, inbox, send, feed };
}

describe("CoalitionAgent", () => {
  it("sends discovery + proposal, activates when all accept", async () => {
    seq = 0;
    const t = agentSetup();
    const rs = Array.from({ length: 3 }, () => req());
    await t.feed(rs);
    const r = await t.agent.formRound(t.bus);
    await t.bus.drain();
    const cid = r.coalitions[0]!.coalitionId;
    for (const x of rs) expect(t.inbox.get(x.buyerId)!.map((m) => m.type)).toEqual(["BUYER_DISCOVERY", "COALITION_PROPOSAL"]);
    const disc = t.inbox.get(rs[0]!.buyerId)![0] as AgentMessage<"BUYER_DISCOVERY">;
    expect(disc.payload.compatible_buyer_ids.sort()).toEqual([rs[1]!.buyerId, rs[2]!.buyerId]);
    for (const x of rs) await t.send("COALITION_ACCEPTANCE", x.buyerId, cid);
    expect(t.agent.coalitions.get(cid)!.status).toBe("ACTIVE");
    expect(t.events).toEqual([`active:${cid}`]);
    expect(t.bus.deliveryErrors).toEqual([]);
  });

  it("re-validates on rejection; below min it fails and members return to the pool", async () => {
    seq = 0;
    const t = agentSetup();
    const rs = Array.from({ length: 3 }, () => req()); // min_members = 2
    await t.feed(rs);
    const cid = (await t.agent.formRound(t.bus)).coalitions[0]!.coalitionId;
    await t.bus.drain();
    await t.send("COALITION_REJECTION", rs[0]!.buyerId, cid);
    const c = t.agent.coalitions.get(cid)!;
    expect(c.status).toBe("PROPOSED");
    expect(c.plan.totalHours).toBe(20);
    await t.send("COALITION_ACCEPTANCE", rs[1]!.buyerId, cid);
    await t.send("COALITION_REJECTION", rs[2]!.buyerId, cid);
    expect(c.status).toBe("FAILED");
    expect(t.events.at(-1)).toMatch(/^failed:.*below min_members/);
    // Next round: only buyer 2 (accepted in the failed coalition) is regrouped; rejecters wait for a new requirement.
    const next = await t.agent.formRound(t.bus);
    expect(next.coalitions.flatMap((x) => x.members.map((m) => m.buyerId))).toEqual([rs[1]!.buyerId]);
  });

  it("allows leaving before FUNDED, refuses after", async () => {
    seq = 0;
    const t = agentSetup();
    const rs = Array.from({ length: 4 }, () => req()); // min 2
    await t.feed(rs);
    const cid = (await t.agent.formRound(t.bus)).coalitions[0]!.coalitionId;
    await t.bus.drain();
    for (const x of rs) await t.send("COALITION_ACCEPTANCE", x.buyerId, cid);
    await t.send("COALITION_LEAVE", rs[3]!.buyerId, cid);
    const c = t.agent.coalitions.get(cid)!;
    expect(c.status).toBe("ACTIVE");
    expect(c.plan.totalHours).toBe(30);
    expect(t.events).toContain(`changed:${cid}:${rs[3]!.buyerId}`);
    await t.agent.markFunded(cid);
    await t.send("COALITION_LEAVE", rs[2]!.buyerId, cid);
    expect(t.bus.deliveryErrors.map((d) => d.error)).toEqual([`cannot leave ${cid} in status FUNDED (only before FUNDED)`]);
    expect(c.members.get(rs[2]!.buyerId)).toBe("ACCEPTED");
  });

  it("requestAuction goes to the coordinator and the given sellers, only for ACTIVE coalitions", async () => {
    seq = 0;
    const t = agentSetup();
    const rs = [req(), req()];
    await t.feed(rs);
    const cid = (await t.agent.formRound(t.bus)).coalitions[0]!.coalitionId;
    await t.bus.drain();
    const a = { auctionId: "auction-1", purchaseId: "purchase-1", commitDeadline: new Date(NOW.getTime() + 60_000), revealDeadline: new Date(NOW.getTime() + 120_000) };
    await expect(t.agent.requestAuction(t.bus, cid, a, ["seller-01"])).rejects.toThrow(/not ACTIVE/);
    for (const x of rs) await t.send("COALITION_ACCEPTANCE", x.buyerId, cid);
    await t.agent.requestAuction(t.bus, cid, a, ["seller-01"]);
    await t.bus.drain();
    expect(t.bus.deliveryErrors).toEqual([]);
    const got = t.inbox.get(SYSTEM_AGENTS.AUCTION_COORDINATOR)! as AgentMessage<"AUCTION_REQUEST">[];
    expect(got.map((m) => [m.type, m.payload.total_hours, m.payload.coalition_id])).toEqual([["AUCTION_REQUEST", 20, cid]]);
  });
});

describe("Swarm with coalition engine", () => {
  const mk = () =>
    new Swarm({
      seed: "swarm-seed",
      masterSecret: Buffer.alloc(32, 6),
      payoutAccounts: [1, 2, 3, 4, 5].map((i) => `seller${i}.op.testnet`),
      baseTime: NOW,
      log: new InMemoryMessageLog(),
      vault: new BidVault(Buffer.alloc(32, 1)),
      maxAgeMs: 300_000,
      clock: () => NOW,
    });

  it("forms multiple coalitions automatically and deterministically; every buyer accounted for", async () => {
    const run = async () => {
      const s = mk();
      await s.announce();
      const r = await s.formCoalitions();
      expect(s.bus.deliveryErrors).toEqual([]);
      return { s, r };
    };
    const a = await run();
    const b = await run();
    expect(a.r.coalitions.map((c) => c.coalitionId)).toEqual(b.r.coalitions.map((c) => c.coalitionId));
    expect(a.r.coalitions.length).toBeGreaterThanOrEqual(2);
    const grouped = a.r.coalitions.flatMap((c) => c.members.map((m) => m.buyerId));
    const all = [...grouped, ...a.r.unserved.map((u) => u.buyerId)].sort();
    expect(all).toEqual(a.s.buyers.map((x) => x.id).sort());
    // Buyers accepted their own proposals (their checks agree with the engine's constraints).
    for (const c of a.r.coalitions) expect(a.s.coalitionAgent.coalitions.get(c.coalitionId)!.status).toBe("ACTIVE");
    for (const id of grouped) expect(a.s.buyer(id).activeCoalition()).toBeDefined();
  });
});
