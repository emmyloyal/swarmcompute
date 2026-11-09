-- =====================================================================
-- SwarmCompute market host — schema (RULES.md revision 2: real user agents)
--
-- The marketplace contract on NEAR Testnet is authoritative for agents,
-- requests, coalitions, purchases and money (RULES.md R15). This database
-- holds only what can't live on chain:
--   * agent_keys        agents' private keys, AES-256-GCM encrypted (R6, R19)
--   * bid_secrets       unrevealed bid prices and nonces, encrypted (R13)
--   * blockchain_transactions / contract_events   the host's own txs and the
--                       events they emitted (never invented, R2)
--   * host_activity     what the host did and why, for the activity feed
-- Money: NUMERIC(40,0) yoctoNEAR, never floating point (R3).
-- =====================================================================

CREATE DOMAIN yocto AS NUMERIC(40,0) CHECK (VALUE >= 0 AND VALUE <= 340282366920938463463374607431768211455);
CREATE DOMAIN near_account AS TEXT CHECK (char_length(VALUE) BETWEEN 2 AND 64 AND VALUE ~ '^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$');
CREATE DOMAIN tx_hash AS TEXT CHECK (VALUE ~ '^[1-9A-HJ-NP-Za-km-z]{43,44}$');
CREATE DOMAIN hex32 AS TEXT CHECK (VALUE ~ '^[0-9a-f]{64}$');
CREATE DOMAIN entity_id AS TEXT CHECK (VALUE ~ '^[a-z][a-z0-9-]{2,63}$');

-- One row per issued key. Only the key that ends up on the agent's account is
-- ever used (bound); other keys issued for the same name are deleted at binding.
CREATE TABLE agent_keys (
  public_key         TEXT PRIMARY KEY CHECK (public_key ~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$'),
  agent_id           near_account NOT NULL,
  role               TEXT NOT NULL CHECK (role IN ('BUYER','SELLER')),
  -- iv(12) || ciphertext || tag(16); agent_id and public_key bound as associated data.
  secret_ciphertext  BYTEA NOT NULL,
  bound              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  bound_at           TIMESTAMPTZ NULL
);
CREATE INDEX agent_keys_agent ON agent_keys(agent_id);
CREATE UNIQUE INDEX agent_keys_one_bound ON agent_keys(agent_id) WHERE bound;

-- A seller agent's sealed bid. Saved before the commit tx is sent; the secret
-- is wiped (NULL) once the reveal is on chain.
CREATE TABLE bid_secrets (
  purchase_id        entity_id NOT NULL,
  seller_id          near_account NOT NULL,
  auction_id         entity_id NOT NULL,
  commitment_hex     hex32 NOT NULL,
  price_ciphertext   BYTEA NULL,
  nonce_ciphertext   BYTEA NULL,
  key_version        SMALLINT NOT NULL,
  commit_tx_hash     tx_hash NULL,
  reveal_tx_hash     tx_hash NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (purchase_id, seller_id),
  CHECK ((price_ciphertext IS NULL) = (nonce_ciphertext IS NULL)),
  CHECK (reveal_tx_hash IS NULL OR price_ciphertext IS NULL)
);

-- Every transaction the host submits, and its real RPC outcome.
CREATE TABLE blockchain_transactions (
  tx_hash            tx_hash PRIMARY KEY,
  signer_account_id  near_account NOT NULL,
  receiver_id        near_account NOT NULL,
  method_name        TEXT NULL,
  purpose            TEXT NOT NULL,
  purchase_id        TEXT NULL,
  deposit_yocto      yocto NOT NULL DEFAULT 0,
  status             TEXT NOT NULL CHECK (status IN ('SUBMITTED','SUCCESS','FAILURE','UNKNOWN')),
  block_hash         TEXT NULL,
  block_height       BIGINT NULL,
  gas_burnt          NUMERIC(30,0) NULL,
  error              JSONB NULL,
  submitted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at       TIMESTAMPTZ NULL,
  indexed_at         TIMESTAMPTZ NULL
);
CREATE INDEX blockchain_transactions_purchase ON blockchain_transactions(purchase_id);
CREATE INDEX blockchain_transactions_signer ON blockchain_transactions(signer_account_id, submitted_at DESC);
CREATE INDEX blockchain_transactions_unindexed ON blockchain_transactions(submitted_at) WHERE indexed_at IS NULL;

-- NEP-297 events emitted by the contract in those transactions.
CREATE TABLE contract_events (
  id                  BIGSERIAL PRIMARY KEY,
  tx_hash             tx_hash NOT NULL,
  receipt_id          TEXT NOT NULL,
  log_index           INTEGER NOT NULL,
  block_height        BIGINT NOT NULL,
  block_timestamp_ns  NUMERIC(20,0) NOT NULL,
  standard            TEXT NOT NULL,
  version             TEXT NOT NULL,
  event               TEXT NOT NULL,
  data                JSONB NOT NULL,
  purchase_id         TEXT NULL,
  indexed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (receipt_id, log_index)
);
CREATE INDEX contract_events_purchase ON contract_events(purchase_id, block_height);
CREATE INDEX contract_events_event ON contract_events(event, block_height);

-- What the host did and why. Simulated steps (delivery, verification) are flagged (R12).
CREATE TABLE host_activity (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  level        TEXT NOT NULL CHECK (level IN ('INFO','WARN','ERROR')),
  kind         TEXT NOT NULL,
  message      TEXT NOT NULL,
  purchase_id  TEXT NULL,
  agent_id     TEXT NULL,
  tx_hash      tx_hash NULL,
  simulated    BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX host_activity_at ON host_activity(at DESC);
CREATE INDEX host_activity_purchase ON host_activity(purchase_id, at);
CREATE INDEX host_activity_agent ON host_activity(agent_id, at DESC);
