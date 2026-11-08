/**
 * Deterministic coalition formation (spec Section 5). Pure function: the same
 * inputs and seed always produce the same coalitions (RULES.md R16).
 *
 * Hard constraints (never violated):
 *   - same GPU model;
 *   - coalition VRAM spec = max of members' minimum VRAM (so every member is satisfied);
 *   - deadlines compatible: every member's deadline ≥ now + minimum lead time;
 *     the coalition deadline is the earliest member deadline;
 *   - total hours ≤ the capacity of at least one seller offer with that model
 *     and VRAM ≥ the spec (public SELLER_AVAILABILITY data only).
 *
 * Optimisation: maximise the number of buyers who can be served at or below
 * their own max price, not the size of coalitions. A coalition's ceiling is
 * its lowest member max price, so one low-ceiling buyer could make every bid
 * ineligible. Buyers whose max price is below the public market reference for
 * their GPU are therefore excluded (PRICE_BELOW_MARKET) instead of joining and
 * sinking a coalition. Remaining buyers are placed in descending max-price
 * order (seeded tie-break), first-fit into open coalitions, which keeps
 * similarly priced buyers together and keeps ceilings high. Coalitions are
 * packed only up to a size at least two sellers can serve (when two exist),
 * so the sealed-bid auction has competition.
 *
 * The coalition engine never sees sellers' private minimum prices.
 */
import { createHash } from "node:crypto";
import type { GpuModel } from "@swarmcompute/shared";

export interface Requirement {
  buyerId: string;
  gpuModel: GpuModel;
  minVramGb: number;
  requiredHours: number;
  maxBudgetYocto: bigint;
  maxPricePerHourYocto: bigint;
  latestDeliveryAt: Date;
}

/** Public seller availability (SELLER_AVAILABILITY). */
export interface Offer {
  sellerId: string;
  gpuModel: GpuModel;
  vramGb: number;
  capacityHours: number;
}

export type UnservedReason = "PRICE_BELOW_MARKET" | "DEADLINE_TOO_SOON" | "NO_SELLER_FOR_SPEC" | "EXCEEDS_CAPACITY";

export interface PlannedMember {
  buyerId: string;
  hours: number;
  maxPricePerHourYocto: bigint;
  maxBudgetYocto: bigint;
}

export interface PlannedCoalition {
  coalitionId: string;
  gpuModel: GpuModel;
  vramGb: number;
  members: PlannedMember[];
  minMembers: number;
  totalHours: number;
  priceCeilingPerHourYocto: bigint;
  totalBudgetYocto: bigint;
  deliveryDeadline: Date;
  formationSeed: string;
  /** Offers that can serve this coalition (for logs / UI). */
  feasibleSellerIds: string[];
}

export interface FormationInput {
  seed: string;
  /** Formation round; part of the coalition ID so later rounds never collide. */
  round: number;
  now: Date;
  requirements: readonly Requirement[];
  offers: readonly Offer[];
  /** Public market reference price per GPU-hour, per model. */
  referencePricePerHour: Readonly<Record<GpuModel, bigint>>;
  /** Minimum time between formation and delivery deadline. */
  minLeadMs: number;
  /** Proposal schema allows at most 20 members. */
  maxMembers?: number;
}

export interface FormationResult {
  coalitions: PlannedCoalition[];
  unserved: { buyerId: string; reason: UnservedReason }[];
}

const tieKey = (seed: string, id: string) => createHash("sha256").update(`${seed}\0${id}`).digest("hex");

function bestCapacity(offers: readonly Offer[], model: GpuModel, vram: number): number {
  let best = 0;
  for (const o of offers) if (o.gpuModel === model && o.vramGb >= vram && o.capacityHours > best) best = o.capacityHours;
  return best;
}

/**
 * Packing limit that keeps the auction competitive: the second-largest
 * capacity among distinct sellers able to serve (model, VRAM), so at least two
 * sellers can bid. Falls back to the largest when only one seller qualifies.
 */
export function competitiveCapacity(offers: readonly Offer[], model: GpuModel, vram: number): number {
  const best = new Map<string, number>();
  for (const o of offers) {
    if (o.gpuModel !== model || o.vramGb < vram) continue;
    best.set(o.sellerId, Math.max(best.get(o.sellerId) ?? 0, o.capacityHours));
  }
  const caps = [...best.values()].sort((a, b) => b - a);
  return caps[1] ?? caps[0] ?? 0;
}

interface Open {
  gpuModel: GpuModel;
  vramGb: number;
  hours: number;
  members: Requirement[];
}

export function formCoalitions(input: FormationInput): FormationResult {
  const maxMembers = Math.min(input.maxMembers ?? 20, 20);
  const unserved: FormationResult["unserved"] = [];
  const earliest = input.now.getTime() + input.minLeadMs;

  // Sort by ID first so input order never matters.
  const reqs = [...input.requirements].sort((a, b) => (a.buyerId < b.buyerId ? -1 : a.buyerId > b.buyerId ? 1 : 0));
  const candidates: Requirement[] = [];
  for (const r of reqs) {
    if (r.maxPricePerHourYocto < input.referencePricePerHour[r.gpuModel]) unserved.push({ buyerId: r.buyerId, reason: "PRICE_BELOW_MARKET" });
    else if (r.latestDeliveryAt.getTime() < earliest) unserved.push({ buyerId: r.buyerId, reason: "DEADLINE_TOO_SOON" });
    else if (bestCapacity(input.offers, r.gpuModel, r.minVramGb) === 0) unserved.push({ buyerId: r.buyerId, reason: "NO_SELLER_FOR_SPEC" });
    else if (bestCapacity(input.offers, r.gpuModel, r.minVramGb) < r.requiredHours) unserved.push({ buyerId: r.buyerId, reason: "EXCEEDS_CAPACITY" });
    else candidates.push(r);
  }

  // Highest max price first; seeded tie-break so equal prices don't favour low IDs.
  candidates.sort((a, b) => {
    if (a.maxPricePerHourYocto !== b.maxPricePerHourYocto) return a.maxPricePerHourYocto > b.maxPricePerHourYocto ? -1 : 1;
    const ka = tieKey(input.seed, a.buyerId);
    const kb = tieKey(input.seed, b.buyerId);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const open: Open[] = [];
  for (const r of candidates) {
    let placed = false;
    for (const c of open) {
      if (c.gpuModel !== r.gpuModel || c.members.length >= maxMembers) continue;
      const vram = Math.max(c.vramGb, r.minVramGb);
      // Keep coalitions within reach of ≥2 sellers so bids actually compete.
      if (competitiveCapacity(input.offers, r.gpuModel, vram) < c.hours + r.requiredHours) continue;
      c.vramGb = vram;
      c.hours += r.requiredHours;
      c.members.push(r);
      placed = true;
      break;
    }
    if (!placed) open.push({ gpuModel: r.gpuModel, vramGb: r.minVramGb, hours: r.requiredHours, members: [r] });
  }

  const coalitions = open.map((c): PlannedCoalition => {
    const ids = c.members.map((m) => m.buyerId).sort();
    const coalitionId = `coalition-${createHash("sha256").update(`${input.seed}\0${input.round}\0${ids.join(",")}`).digest("hex").slice(0, 12)}`;
    const members = c.members.map((m) => ({
      buyerId: m.buyerId,
      hours: m.requiredHours,
      maxPricePerHourYocto: m.maxPricePerHourYocto,
      maxBudgetYocto: m.maxBudgetYocto,
    }));
    return {
      coalitionId,
      gpuModel: c.gpuModel,
      vramGb: c.vramGb,
      members,
      // A coalition survives losing up to half its members (rounded down).
      minMembers: Math.max(1, Math.ceil(members.length / 2)),
      totalHours: c.hours,
      priceCeilingPerHourYocto: members.reduce((min, m) => (m.maxPricePerHourYocto < min ? m.maxPricePerHourYocto : min), members[0]!.maxPricePerHourYocto),
      totalBudgetYocto: members.reduce((s, m) => s + m.maxBudgetYocto, 0n),
      deliveryDeadline: new Date(Math.min(...c.members.map((m) => m.latestDeliveryAt.getTime()))),
      formationSeed: input.seed,
      feasibleSellerIds: [
        ...new Set(
          input.offers
            .filter((o) => o.gpuModel === c.gpuModel && o.vramGb >= c.vramGb && o.capacityHours >= c.hours)
            .map((o) => o.sellerId),
        ),
      ].sort(),
    };
  });

  return { coalitions, unserved };
}

/** Re-validate after a member leaves or rejects (spec Section 5). */
export function revalidate(
  c: PlannedCoalition,
  remaining: readonly PlannedMember[],
  offers: readonly Offer[],
): { ok: true; coalition: PlannedCoalition } | { ok: false; reason: string } {
  if (remaining.length < c.minMembers) return { ok: false, reason: `below min_members (${remaining.length} < ${c.minMembers})` };
  const totalHours = remaining.reduce((s, m) => s + m.hours, 0);
  if (bestCapacity(offers, c.gpuModel, c.vramGb) < totalHours) return { ok: false, reason: "no seller capacity" };
  return {
    ok: true,
    coalition: {
      ...c,
      members: [...remaining],
      totalHours,
      priceCeilingPerHourYocto: remaining.reduce((min, m) => (m.maxPricePerHourYocto < min ? m.maxPricePerHourYocto : min), remaining[0]!.maxPricePerHourYocto),
      totalBudgetYocto: remaining.reduce((s, m) => s + m.maxBudgetYocto, 0n),
    },
  };
}
