-- =====================================================================
-- SwarmCompute — initial schema (Section 13)
--
-- * The database is a CACHE and an INDEX. For every financial fact the
--   marketplace contract on NEAR Testnet is authoritative; the reconciler
--   compares rows here against contract views and flags drift.
-- * Money: NUMERIC(40,0) yoctoNEAR, never floating point (RULES.md R3).
--   u128 max has 39 digits, so 40 digits always fits.
-- * Probabilities are integer basis points (0..10000), also never floats.
-- * Unrevealed bid prices and nonces are AES-256-GCM ciphertext and are
--   excluded from every public_* view. The API reads public_* views only.
-- =====================================================================

-- ---------- reusable domains ----------
CREATE DOMAIN yocto AS NUMERIC(40,0) CHECK (VALUE >= 0 AND VALUE <= 340282366920938463463374607431768211455);
CREATE DOMAIN gpu_model AS TEXT CHECK (VALUE IN ('A100', 'H100'));
CREATE DOMAIN near_account AS TEXT CHECK (char_length(VALUE) BETWEEN 2 AND 64 AND VALUE ~ '^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$');
CREATE DOMAIN tx_hash AS TEXT CHECK (VALUE ~ '^[1-9A-HJ-NP-Za-km-z]{43,44}$');
CREATE DOMAIN hex32 AS TEXT CHECK (VALUE ~ '^[0-9a-f]{64}$');
CREATE DOMAIN entity_id AS TEXT CHECK (VALUE ~ '^[a-z][a-z0-9-]{2,63}$');

-- =====================================================================
-- Participants
-- =====================================================================

CREATE TABLE agents (
  agent_id      TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('BUYER','SELLER','COALITION','AUCTION_COORDINATOR','VERIFICATION','REPUTATION','TREASURY')),
  display_name  TEXT NOT NULL,
  -- Every agent in the MVP is backend-controlled; kept explicit for the UI badge.
  is_simulated  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind NOT IN ('BUYER') OR agent_id ~ '^buyer-[0-9]{3}$'),
  CHECK (kind NOT IN ('SELLER') OR agent_id ~ '^seller-[0-9]{2}$')
);

CREATE TABLE buyers (
  buyer_id                TEXT PRIMARY KEY CHECK (buyer_id ~ '^buyer-[0-9]{3}$'),
  agent_id                TEXT NOT NULL UNIQUE REFERENCES agents(agent_id),
  max_budget_yocto        yocto NOT NULL CHECK (max_budget_yocto > 0),
  -- Always NULL in the MVP (simulated identity, no wallet). Mirrors the contract's Option<AccountId>.
  wallet_account_id       near_account NULL,
  registration_tx_hash    tx_hash NULL,           -- NULL until registered on-chain
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE buyer_requirements (
  requirement_id            BIGSERIAL PRIMARY KEY,
  buyer_id                  TEXT NOT NULL REFERENCES buyers(buyer_id),
  gpu_model                 gpu_model NOT NULL,
  min_vram_gb               INTEGER NOT NULL CHECK (min_vram_gb > 0),
  required_hours            INTEGER NOT NULL CHECK (required_hours > 0),
  max_price_per_hour_yocto  yocto NOT NULL CHECK (max_price_per_hour_yocto > 0),
  latest_delivery_at        TIMESTAMPTZ NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_COALITION','FULFILLED','UNSERVED','CANCELLED')),
  source_message_id         UUID NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one live requirement per buyer.
CREATE UNIQUE INDEX buyer_requirements_one_open ON buyer_requirements(buyer_id) WHERE status IN ('OPEN','IN_COALITION');

CREATE TABLE sellers (
  seller_id                 TEXT PRIMARY KEY CHECK (seller_id ~ '^seller-[0-9]{2}$'),
  agent_id                  TEXT NOT NULL UNIQUE REFERENCES agents(agent_id),
  payout_account_id         near_account NOT NULL UNIQUE,   -- REAL testnet account
  pricing_strategy          TEXT NOT NULL CHECK (pricing_strategy IN ('AGGRESSIVE_LOW','PREMIUM_RELIABLE','LIMITED_CAPACITY','FLEXIBLE','RANDOMIZED_COMPETITIVE')),
  -- PRIVATE simulation parameters: never exposed by public views.
  min_price_per_hour_yocto  yocto NOT NULL CHECK (min_price_per_hour_yocto > 0),
  failure_probability_bps   INTEGER NOT NULL CHECK (failure_probability_bps BETWEEN 0 AND 10000),
  registration_tx_hash      tx_hash NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE gpu_resources (
  resource_id            BIGSERIAL PRIMARY KEY,
  seller_id              TEXT NOT NULL REFERENCES sellers(seller_id),
  gpu_model              gpu_model NOT NULL,
  vram_gb                INTEGER NOT NULL CHECK (vram_gb > 0),
  capacity_hours         INTEGER NOT NULL CHECK (capacity_hours > 0),
  delivery_time_minutes  INTEGER NOT NULL CHECK (delivery_time_minutes > 0),
  -- No real compute exists in the MVP (Section 9). This can never be FALSE.
  is_simulated           BOOLEAN NOT NULL DEFAULT TRUE CHECK (is_simulated),
  UNIQUE (seller_id, gpu_model, vram_gb)
);

-- =====================================================================
-- Coalitions
-- =====================================================================

CREATE TABLE coalitions (
  coalition_id                  entity_id PRIMARY KEY,
  gpu_model                     gpu_model NOT NULL,
  vram_gb                       INTEGER NOT NULL CHECK (vram_gb > 0),
  total_hours                   INTEGER NOT NULL CHECK (total_hours > 0),
  price_ceiling_per_hour_yocto  yocto NOT NULL CHECK (price_ceiling_per_hour_yocto > 0),
  total_budget_yocto            yocto NOT NULL CHECK (total_budget_yocto > 0),
  delivery_deadline             TIMESTAMPTZ NOT NULL,
  min_members                   INTEGER NOT NULL CHECK (min_members >= 1),
  formation_seed                TEXT NOT NULL,
  status                        TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','ACTIVE','AUCTIONING','FUNDED','CLOSED','FAILED')),
  failure_reason                TEXT NULL,
  registration_tx_hash          tx_hash NULL,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE coalition_members (
  coalition_id    TEXT NOT NULL REFERENCES coalitions(coalition_id),
  buyer_id        TEXT NOT NULL REFERENCES buyers(buyer_id),
  requirement_id  BIGINT NOT NULL REFERENCES buyer_requirements(requirement_id),
  hours           INTEGER NOT NULL CHECK (hours > 0),
  status          TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','ACCEPTED','REJECTED','LEFT')),
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at         TIMESTAMPTZ NULL,
  PRIMARY KEY (coalition_id, buyer_id),
  CHECK ((status = 'LEFT') = (left_at IS NOT NULL))
);
CREATE INDEX coalition_members_buyer ON coalition_members(buyer_id);

-- =====================================================================
-- Purchases (one escrow state machine per coalition purchase, Section 8)
-- =====================================================================

CREATE TABLE purchases (
  purchase_id               entity_id PRIMARY KEY,   -- same ID as on-chain
  coalition_id              TEXT NOT NULL REFERENCES coalitions(coalition_id),
  state                     TEXT NOT NULL CHECK (state IN ('CREATED','BIDDING','AWARDED','FAILED','FUNDED','DELIVERING','VERIFYING','COMPLETED','EXPIRED','REFUNDED')),
  winner_seller_id          TEXT NULL REFERENCES sellers(seller_id),
  winning_price_per_hour_yocto yocto NULL,
  required_total_yocto      yocto NULL,              -- winning_price × total_hours
  deposited_yocto           yocto NOT NULL DEFAULT 0,
  funding_deadline          TIMESTAMPTZ NULL,
  delivery_deadline         TIMESTAMPTZ NULL,
  verification_deadline     TIMESTAMPTZ NULL,
  payout_in_flight          BOOLEAN NOT NULL DEFAULT FALSE,
  refund_in_flight          BOOLEAN NOT NULL DEFAULT FALSE,
  -- Reconciliation against contract views.
  last_synced_block_height  BIGINT NULL,
  last_synced_at            TIMESTAMPTZ NULL,
  drift_detected            BOOLEAN NOT NULL DEFAULT FALSE,
  drift_detail              JSONB NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT (payout_in_flight AND refund_in_flight)),
  CHECK (required_total_yocto IS NULL OR deposited_yocto <= required_total_yocto),
  CHECK ((winner_seller_id IS NULL) = (winning_price_per_hour_yocto IS NULL))
);
CREATE UNIQUE INDEX purchases_one_live_per_coalition ON purchases(coalition_id)
  WHERE state NOT IN ('FAILED','EXPIRED','REFUNDED','COMPLETED');

-- =====================================================================
-- Auctions and bids
-- =====================================================================

CREATE TABLE auctions (
  auction_id        entity_id PRIMARY KEY,
  purchase_id       TEXT NOT NULL UNIQUE REFERENCES purchases(purchase_id),
  coalition_id      TEXT NOT NULL REFERENCES coalitions(coalition_id),
  commit_deadline   TIMESTAMPTZ NOT NULL,
  reveal_deadline   TIMESTAMPTZ NOT NULL,
  closed_at         TIMESTAMPTZ NULL,
  outcome           TEXT NULL CHECK (outcome IN ('AWARDED','FAILED')),
  create_tx_hash    tx_hash NULL,
  close_tx_hash     tx_hash NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (commit_deadline < reveal_deadline)
);

CREATE TABLE bid_commitments (
  auction_id            TEXT NOT NULL REFERENCES auctions(auction_id),
  seller_id             TEXT NOT NULL REFERENCES sellers(seller_id),
  commitment_hex        hex32 NOT NULL,
  commit_tx_hash        tx_hash NULL,
  commit_block_height   BIGINT NULL,             -- tie-break input (Section 7)
  -- SECRET until reveal: AES-256-GCM, layout iv(12) || ciphertext || tag(16).
  -- Wiped (set NULL) once the reveal is confirmed on-chain.
  price_ciphertext      BYTEA NULL,
  nonce_ciphertext      BYTEA NULL,
  enc_key_version       SMALLINT NULL,
  revealed              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (auction_id, seller_id),            -- exactly one commitment per seller
  CHECK ((price_ciphertext IS NULL) = (nonce_ciphertext IS NULL)),
  CHECK (price_ciphertext IS NULL OR enc_key_version IS NOT NULL)
);

CREATE TABLE bid_reveals (
  auction_id              TEXT NOT NULL,
  seller_id               TEXT NOT NULL,
  price_per_hour_yocto    yocto NOT NULL,
  nonce_hex               hex32 NOT NULL,
  reveal_tx_hash          tx_hash NOT NULL,       -- reveals are only recorded once on-chain
  reveal_block_height     BIGINT NULL,
  hash_verified           BOOLEAN NOT NULL,       -- as reported by the contract
  eligible                BOOLEAN NULL,           -- set at close_auction
  ineligibility_reason    TEXT NULL CHECK (ineligibility_reason IN ('HASH_MISMATCH','GPU_MISMATCH','VRAM_TOO_LOW','INSUFFICIENT_CAPACITY','ABOVE_PRICE_CEILING','ABOVE_BUDGET')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (auction_id, seller_id),
  FOREIGN KEY (auction_id, seller_id) REFERENCES bid_commitments(auction_id, seller_id)
);

-- =====================================================================
-- Allocations, settlements, refunds
-- =====================================================================

CREATE TABLE allocations (
  purchase_id          TEXT NOT NULL REFERENCES purchases(purchase_id),
  buyer_id             TEXT NOT NULL REFERENCES buyers(buyer_id),
  hours                INTEGER NOT NULL CHECK (hours > 0),
  amount_yocto         yocto NOT NULL CHECK (amount_yocto > 0),   -- hours × winning price
  -- Simulated buyer decision, never a wallet signature (Section 2).
  approval             TEXT NOT NULL CHECK (approval IN ('SIMULATED_APPROVED','SIMULATED_REJECTED')),
  approval_message_id  UUID NULL,
  record_tx_hash       tx_hash NULL,              -- set when recorded on-chain
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (purchase_id, buyer_id)
);

-- One row per payout ATTEMPT; at most one may succeed per purchase.
CREATE TABLE settlements (
  settlement_id      BIGSERIAL PRIMARY KEY,
  purchase_id        TEXT NOT NULL REFERENCES purchases(purchase_id),
  seller_id          TEXT NOT NULL REFERENCES sellers(seller_id),
  payout_account_id  near_account NOT NULL,
  amount_yocto       yocto NOT NULL CHECK (amount_yocto > 0),
  status             TEXT NOT NULL CHECK (status IN ('IN_FLIGHT','SUCCEEDED','FAILED')),
  tx_hash            tx_hash NULL,
  error              JSONB NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX settlements_one_success ON settlements(purchase_id) WHERE status = 'SUCCEEDED';
CREATE UNIQUE INDEX settlements_one_in_flight ON settlements(purchase_id) WHERE status = 'IN_FLIGHT';

-- One row per refund ATTEMPT; at most one may succeed per purchase. Refunds go to the funder.
CREATE TABLE refunds (
  refund_id          BIGSERIAL PRIMARY KEY,
  purchase_id        TEXT NOT NULL REFERENCES purchases(purchase_id),
  funder_account_id  near_account NOT NULL,
  total_yocto        yocto NOT NULL CHECK (total_yocto > 0),
  status             TEXT NOT NULL CHECK (status IN ('IN_FLIGHT','SUCCEEDED','FAILED')),
  tx_hash            tx_hash NULL,
  error              JSONB NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX refunds_one_success ON refunds(purchase_id) WHERE status = 'SUCCEEDED';
CREATE UNIQUE INDEX refunds_one_in_flight ON refunds(purchase_id) WHERE status = 'IN_FLIGHT';

-- Per-simulated-buyer breakdown of a refund (internal accounting, emitted as contract events).
CREATE TABLE refund_lines (
  refund_id     BIGINT NOT NULL REFERENCES refunds(refund_id),
  buyer_id      TEXT NOT NULL REFERENCES buyers(buyer_id),
  amount_yocto  yocto NOT NULL,
  PRIMARY KEY (refund_id, buyer_id)
);

-- =====================================================================
-- Delivery, verification, reputation (delivery + verification are SIMULATED)
-- =====================================================================

CREATE TABLE deliveries (
  delivery_id        BIGSERIAL PRIMARY KEY,
  purchase_id        TEXT NOT NULL REFERENCES purchases(purchase_id),
  seller_id          TEXT NOT NULL REFERENCES sellers(seller_id),
  resource_id        BIGINT NULL REFERENCES gpu_resources(resource_id),
  outcome            TEXT NOT NULL CHECK (outcome IN ('SUCCESS','FAILURE','PARTIAL')),
  required_hours     INTEGER NOT NULL CHECK (required_hours > 0),
  allocated_hours    INTEGER NOT NULL CHECK (allocated_hours >= 0),
  started_at         TIMESTAMPTZ NOT NULL,
  finished_at        TIMESTAMPTZ NOT NULL,
  job_log_hash_hex   hex32 NOT NULL,
  report_tx_hash     tx_hash NULL,
  is_simulated       BOOLEAN NOT NULL DEFAULT TRUE CHECK (is_simulated),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (started_at <= finished_at),
  CHECK (allocated_hours <= required_hours),
  CHECK (outcome <> 'SUCCESS' OR allocated_hours = required_hours)
);
CREATE UNIQUE INDEX deliveries_one_per_purchase ON deliveries(purchase_id);

CREATE TABLE verification_records (
  verification_id    BIGSERIAL PRIMARY KEY,
  purchase_id        TEXT NOT NULL REFERENCES purchases(purchase_id),
  delivery_id        BIGINT NOT NULL REFERENCES deliveries(delivery_id),
  success            BOOLEAN NOT NULL,
  reason             TEXT NOT NULL,
  verifier_account   near_account NOT NULL,
  is_simulated       BOOLEAN NOT NULL DEFAULT TRUE CHECK (is_simulated),
  tx_hash            tx_hash NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX verification_one_per_purchase ON verification_records(purchase_id);

-- Snapshots of the ON-CHAIN reputation record, taken from contract events/views.
-- Never written from backend logic alone (Section 8: updated only by contract transitions).
CREATE TABLE reputation_records (
  record_id              BIGSERIAL PRIMARY KEY,
  seller_id              TEXT NOT NULL REFERENCES sellers(seller_id),
  wins                   INTEGER NOT NULL CHECK (wins >= 0),
  completed_deliveries   INTEGER NOT NULL CHECK (completed_deliveries >= 0),
  failed_deliveries      INTEGER NOT NULL CHECK (failed_deliveries >= 0),
  non_reveals            INTEGER NOT NULL CHECK (non_reveals >= 0),
  source_tx_hash         tx_hash NOT NULL,
  block_height           BIGINT NOT NULL,
  recorded_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reputation_records_latest ON reputation_records(seller_id, block_height DESC);

-- =====================================================================
-- Messaging, chain index, activity
-- =====================================================================

-- Every message is logged, including rejected ones (Section 11).
-- Rejected messages may be malformed in any field, so columns are loose for
-- REJECTED rows and strict for everything else; logging must never fail.
-- Replay protection: a message_id may be ACCEPTED at most once.
CREATE TABLE agent_messages (
  id                 BIGSERIAL PRIMARY KEY,
  message_id         TEXT NULL,
  sender_id          TEXT NULL,
  receiver_id        TEXT NULL,
  type               TEXT NULL,                 -- free text so unknown types can be logged as rejected
  sent_at            TIMESTAMPTZ NULL,          -- envelope timestamp
  coalition_id       TEXT NULL,
  auction_id         TEXT NULL,
  purchase_id        TEXT NULL,
  payload            JSONB NOT NULL,            -- money inside is decimal strings, never numbers; {"raw": "..."} if unparseable
  signature          TEXT NULL,
  status             TEXT NOT NULL CHECK (status IN ('ACCEPTED','CONFIRMED','REJECTED')),
  rejection_code     TEXT NULL,
  rejection_detail   TEXT NULL,
  tx_hash            TEXT NULL,                 -- for on-chain types; CONFIRMED only after RPC verification
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at       TIMESTAMPTZ NULL,
  CHECK ((status = 'REJECTED') = (rejection_code IS NOT NULL)),
  CHECK (status <> 'CONFIRMED' OR confirmed_at IS NOT NULL),
  CHECK (status = 'REJECTED' OR (
    message_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND sender_id IS NOT NULL AND receiver_id IS NOT NULL AND type IS NOT NULL
    AND sent_at IS NOT NULL AND signature IS NOT NULL
    AND (tx_hash IS NULL OR tx_hash ~ '^[1-9A-HJ-NP-Za-km-z]{43,44}$')))
);
CREATE UNIQUE INDEX agent_messages_accept_once ON agent_messages(message_id) WHERE status <> 'REJECTED';
CREATE INDEX agent_messages_ctx ON agent_messages(coalition_id, auction_id, purchase_id);
CREATE INDEX agent_messages_received ON agent_messages(received_at DESC);

-- Every transaction the backend submits, and its real RPC outcome. Never invented.
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
  finalized_at       TIMESTAMPTZ NULL
);
CREATE INDEX blockchain_transactions_purchase ON blockchain_transactions(purchase_id);

-- Indexed NEP-297 events emitted by the contract (the source of financial history).
CREATE TABLE contract_events (
  id             BIGSERIAL PRIMARY KEY,
  tx_hash        tx_hash NOT NULL,
  receipt_id     TEXT NOT NULL,
  log_index      INTEGER NOT NULL,
  block_height   BIGINT NOT NULL,
  block_timestamp_ns NUMERIC(20,0) NOT NULL,
  standard       TEXT NOT NULL,
  version        TEXT NOT NULL,
  event          TEXT NOT NULL,
  data           JSONB NOT NULL,
  purchase_id    TEXT NULL,
  indexed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (receipt_id, log_index)
);
CREATE INDEX contract_events_purchase ON contract_events(purchase_id, block_height);
CREATE INDEX contract_events_event ON contract_events(event, block_height);

CREATE TABLE activity_logs (
  id             BIGSERIAL PRIMARY KEY,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  level          TEXT NOT NULL CHECK (level IN ('DEBUG','INFO','WARN','ERROR')),
  actor_id       TEXT NULL,
  category       TEXT NOT NULL,
  message        TEXT NOT NULL,
  -- Drives the On-chain / Simulated badge in the UI.
  provenance     TEXT NOT NULL CHECK (provenance IN ('ON_CHAIN','SIMULATED','SYSTEM')),
  tx_hash        tx_hash NULL,
  coalition_id   TEXT NULL,
  auction_id     TEXT NULL,
  purchase_id    TEXT NULL,
  details        JSONB NULL,
  CHECK (provenance <> 'ON_CHAIN' OR tx_hash IS NOT NULL)
);
CREATE INDEX activity_logs_at ON activity_logs(at DESC);

-- =====================================================================
-- Public views — the ONLY relations the public API may read.
-- They omit encrypted bid material, seller private pricing parameters and
-- message signatures.
-- =====================================================================

CREATE VIEW public_sellers AS
  SELECT seller_id, agent_id, payout_account_id, pricing_strategy, registration_tx_hash, created_at
  FROM sellers;

-- Before reveal: existence and count only. Never price or nonce.
CREATE VIEW public_bid_commitments AS
  SELECT auction_id, seller_id, commitment_hex, commit_tx_hash, commit_block_height, revealed, created_at
  FROM bid_commitments;

CREATE VIEW public_auction_commitment_counts AS
  SELECT a.auction_id, count(c.seller_id) AS commitment_count, count(c.seller_id) FILTER (WHERE c.revealed) AS reveal_count
  FROM auctions a LEFT JOIN bid_commitments c USING (auction_id)
  GROUP BY a.auction_id;

-- Reveals are public on-chain facts once recorded (reveal_tx_hash NOT NULL by constraint).
CREATE VIEW public_bid_reveals AS
  SELECT auction_id, seller_id, price_per_hour_yocto, reveal_tx_hash, reveal_block_height,
         hash_verified, eligible, ineligibility_reason, created_at
  FROM bid_reveals;

-- BID_REVEAL payloads are redacted unless the reveal is CONFIRMED on-chain.
CREATE VIEW public_agent_messages AS
  SELECT id, message_id, sender_id, receiver_id, type, sent_at, coalition_id, auction_id, purchase_id,
         CASE WHEN type = 'BID_REVEAL' AND status <> 'CONFIRMED'
              THEN jsonb_build_object('redacted', true)
              ELSE payload END AS payload,
         status, rejection_code, tx_hash, received_at, confirmed_at
  FROM agent_messages;
