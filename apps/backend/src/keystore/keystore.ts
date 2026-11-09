/**
 * Agent keystore (RULES.md R6, R19).
 *
 * When a user starts opening an agent, the host generates an ed25519 key pair
 * and hands back only the public key; the browser passes it to
 * `open_*_agent`, which adds it to the new account as a function-call key.
 * The private key is stored AES-256-GCM encrypted (the agent id and public key
 * are bound as associated data) and never leaves the host.
 *
 * A stored key is used for an agent only once the chain confirms it: the
 * agent account exists and that exact public key is one of its function-call
 * keys for this contract. Several keys may be issued for the same name (two
 * people racing for it); only the one on chain is ever used, the rest are
 * discarded at binding.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { KeyPair, type KeyPairString } from "near-api-js";
import type pg from "pg";

export type AgentRole = "BUYER" | "SELLER";

export interface KeyRow {
  publicKey: string;
  agentId: string;
  role: AgentRole;
  secretCiphertext: Buffer;
  bound: boolean;
}

/** Persistence port: Postgres in production, in-memory in tests. */
export interface KeyRepo {
  insert(row: KeyRow): Promise<void>;
  rowsFor(agentId: string): Promise<KeyRow[]>;
  /** Mark `publicKey` as the agent's key and drop every other key issued for that agent. */
  bind(agentId: string, publicKey: string): Promise<void>;
}

/** What the keystore needs from the chain to confirm a key. */
export interface KeyChecker {
  readonly contractId: string;
  accessKeys(accountId: string): Promise<{ publicKey: string; fullAccess: boolean; receiverId?: string }[] | null>;
}

const aad = (agentId: string, publicKey: string) => Buffer.from(`swarmcompute/agent-key/v1/${agentId}/${publicKey}`, "utf8");

export class KeyCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("keystore encryption key must be 32 bytes");
  }
  seal(agentId: string, publicKey: string, secret: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(aad(agentId, publicKey));
    const ct = Buffer.concat([c.update(secret, "utf8"), c.final()]);
    return Buffer.concat([iv, ct, c.getAuthTag()]);
  }
  open(agentId: string, publicKey: string, blob: Buffer): string {
    if (blob.length < 12 + 16) throw new Error("ciphertext too short");
    const d = createDecipheriv("aes-256-gcm", this.key, blob.subarray(0, 12));
    d.setAAD(aad(agentId, publicKey));
    d.setAuthTag(blob.subarray(blob.length - 16));
    return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]).toString("utf8");
  }
}

export class KeyStore {
  private readonly confirmed = new Map<string, string>();
  private readonly cipher: KeyCipher;

  constructor(
    private readonly repo: KeyRepo,
    encryptionKey: Buffer,
    private readonly chain: KeyChecker,
  ) {
    this.cipher = new KeyCipher(encryptionKey);
  }

  /** Issue a fresh key pair for `agentId`; only the public key is returned. */
  async issue(agentId: string, role: AgentRole): Promise<{ publicKey: string }> {
    const kp = KeyPair.fromRandom("ed25519");
    const publicKey = kp.getPublicKey().toString();
    const secret = kp.toString();
    await this.repo.insert({ publicKey, agentId, role, secretCiphertext: this.cipher.seal(agentId, publicKey, secret), bound: false });
    return { publicKey };
  }

  /**
   * The private key for `agentId`, if we hold the one on its account; else null
   * (not opened yet, or opened with a key we don't hold — then the owner runs it).
   */
  async keyFor(agentId: string): Promise<string | null> {
    const hit = this.confirmed.get(agentId);
    if (hit) return hit;
    const rows = await this.repo.rowsFor(agentId);
    if (rows.length === 0) return null;
    const onChain = await this.chain.accessKeys(agentId);
    if (!onChain) return null;
    const usable = new Set(onChain.filter((k) => !k.fullAccess && k.receiverId === this.chain.contractId).map((k) => k.publicKey));
    const row = rows.find((r) => usable.has(r.publicKey));
    if (!row) return null;
    if (!row.bound || rows.length > 1) await this.repo.bind(agentId, row.publicKey);
    const secret = this.cipher.open(agentId, row.publicKey, row.secretCiphertext);
    const kp = KeyPair.fromString(secret as KeyPairString);
    if (kp.getPublicKey().toString() !== row.publicKey) throw new Error(`keystore row for ${agentId} doesn't match its public key`);
    this.confirmed.set(agentId, secret);
    return secret;
  }
}

export class PgKeyRepo implements KeyRepo {
  constructor(private readonly pool: pg.Pool) {}
  async insert(r: KeyRow): Promise<void> {
    await this.pool.query(`INSERT INTO agent_keys (public_key, agent_id, role, secret_ciphertext, bound) VALUES ($1, $2, $3, $4, $5)`, [
      r.publicKey,
      r.agentId,
      r.role,
      r.secretCiphertext,
      r.bound,
    ]);
  }
  async rowsFor(agentId: string): Promise<KeyRow[]> {
    const { rows } = await this.pool.query<{ public_key: string; agent_id: string; role: AgentRole; secret_ciphertext: Buffer; bound: boolean }>(
      `SELECT public_key, agent_id, role, secret_ciphertext, bound FROM agent_keys WHERE agent_id = $1 ORDER BY bound DESC, created_at`,
      [agentId],
    );
    return rows.map((r) => ({ publicKey: r.public_key, agentId: r.agent_id, role: r.role, secretCiphertext: r.secret_ciphertext, bound: r.bound }));
  }
  async bind(agentId: string, publicKey: string): Promise<void> {
    await this.pool.query(`DELETE FROM agent_keys WHERE agent_id = $1 AND public_key <> $2`, [agentId, publicKey]);
    await this.pool.query(`UPDATE agent_keys SET bound = TRUE, bound_at = COALESCE(bound_at, now()) WHERE agent_id = $1 AND public_key = $2`, [agentId, publicKey]);
  }
}

export class MemKeyRepo implements KeyRepo {
  readonly rows: KeyRow[] = [];
  async insert(r: KeyRow) {
    this.rows.push({ ...r });
  }
  async rowsFor(agentId: string) {
    return this.rows.filter((r) => r.agentId === agentId).map((r) => ({ ...r }));
  }
  async bind(agentId: string, publicKey: string) {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i]!;
      if (r.agentId !== agentId) continue;
      if (r.publicKey === publicKey) r.bound = true;
      else this.rows.splice(i, 1);
    }
  }
}
