/**
 * Wires 20 buyer agents, 5 seller agents and the system agents onto one bus.
 *
 * System agents (coalition, auction coordinator, verification, reputation,
 * treasury) start with a recording inbox. Phases 4–7 attach their real
 * handlers with `setHandler`; until then their messages are still validated,
 * logged and kept for inspection.
 */
import { SYSTEM_AGENTS, type AgentMessage } from "@swarmcompute/shared";
import type { BidVault } from "../crypto/bid-vault.js";
import { MessageBus, type Handler } from "../messaging/bus.js";
import type { MessageLog } from "../messaging/log.js";
import { generateBuyers, generateSellers } from "../sim/profiles.js";
import { BuyerAgent } from "./buyer.js";
import { CoalitionAgent, type CoalitionAgentOptions } from "./coalition-agent.js";
import { SellerAgent } from "./seller.js";

export interface SwarmOptions {
  seed: string;
  masterSecret: Buffer;
  payoutAccounts: readonly string[];
  baseTime: Date;
  log: MessageLog;
  vault: BidVault;
  maxAgeMs: number;
  clock?: () => Date;
  coalition?: Omit<CoalitionAgentOptions, "seed" | "clock">;
  /** Parent account of the buyer agents' wallets (`buyer001.<parent>`). */
  buyerWalletParent?: string;
}

export class Swarm {
  readonly bus: MessageBus;
  readonly buyers: BuyerAgent[];
  readonly sellers: SellerAgent[];
  readonly inboxes = new Map<string, AgentMessage[]>();
  readonly coalitionAgent: CoalitionAgent;
  /** The one clock every agent (and the engines) timestamps messages with. */
  readonly clock: () => Date;
  private readonly handlers = new Map<string, Handler>();

  constructor(opts: SwarmOptions) {
    const clock = opts.clock ?? (() => new Date());
    this.clock = clock;
    this.bus = new MessageBus({ masterSecret: opts.masterSecret, log: opts.log, maxAgeMs: opts.maxAgeMs, now: () => clock().getTime() });

    this.buyers = generateBuyers(opts.seed, opts.baseTime, opts.buyerWalletParent).map((p) => {
      let agent!: BuyerAgent;
      const key = this.bus.register(p.agentId, (m, b) => agent.handle(m, b));
      agent = new BuyerAgent(p, key, clock);
      return agent;
    });
    this.sellers = generateSellers(opts.payoutAccounts).map((p) => {
      let agent!: SellerAgent;
      const key = this.bus.register(p.agentId, (m, b) => agent.handle(m, b));
      agent = new SellerAgent(p, key, opts.seed, opts.vault, clock);
      return agent;
    });
    for (const id of Object.values(SYSTEM_AGENTS)) {
      this.inboxes.set(id, []);
      this.bus.register(id, async (m, b) => {
        this.inboxes.get(id)!.push(m);
        await this.handlers.get(id)?.(m, b);
      });
    }
    this.coalitionAgent = new CoalitionAgent(this.systemKey(SYSTEM_AGENTS.COALITION), { ...opts.coalition, seed: opts.seed, clock });
    this.setHandler(SYSTEM_AGENTS.COALITION, this.coalitionAgent.handle);
  }

  /** Run one formation round and deliver proposals and buyer responses. */
  async formCoalitions() {
    const r = await this.coalitionAgent.formRound(this.bus);
    await this.bus.drain();
    return r;
  }

  /** Attach a system agent's behaviour (Phases 4–7). */
  setHandler(agentId: string, handler: Handler): void {
    if (!this.inboxes.has(agentId)) throw new Error(`${agentId} is not a system agent`);
    this.handlers.set(agentId, handler);
  }

  systemKey(agentId: string): Buffer {
    const k = this.bus.keyFor(agentId);
    if (!k || !this.inboxes.has(agentId)) throw new Error(`${agentId} is not a system agent`);
    return k;
  }

  buyer(id: string): BuyerAgent {
    const b = this.buyers.find((x) => x.id === id);
    if (!b) throw new Error(`unknown buyer ${id}`);
    return b;
  }

  seller(id: string): SellerAgent {
    const s = this.sellers.find((x) => x.id === id);
    if (!s) throw new Error(`unknown seller ${id}`);
    return s;
  }

  /** Buyers publish requirements to the coalition agent; sellers announce availability. */
  async announce(): Promise<{ sent: number; rejected: number }> {
    let sent = 0;
    let rejected = 0;
    const msgs: AgentMessage[] = [
      ...this.buyers.map((b) => b.requirementMessage()),
      ...this.sellers.flatMap((s) => [
        ...s.availabilityMessages(SYSTEM_AGENTS.COALITION),
        ...s.availabilityMessages(SYSTEM_AGENTS.AUCTION_COORDINATOR),
      ]),
    ];
    for (const m of msgs) {
      const r = await this.bus.send(m);
      if (r.ok) sent++;
      else rejected++;
    }
    await this.bus.drain();
    return { sent, rejected };
  }
}
