-- =====================================================================
-- Phase 8: public views for the read-only HTTP API (RULES.md R13).
-- The API reads ONLY public_* relations. None of these expose seller
-- private pricing, failure probabilities, bid ciphertexts or signatures.
-- =====================================================================

CREATE VIEW public_buyers AS
  SELECT b.buyer_id, b.max_budget_yocto, b.wallet_account_id, b.registration_tx_hash, b.created_at,
         r.requirement_id, r.gpu_model, r.min_vram_gb, r.required_hours, r.max_price_per_hour_yocto,
         r.latest_delivery_at, r.status AS requirement_status
  FROM buyers b
  LEFT JOIN LATERAL (
    SELECT * FROM buyer_requirements x WHERE x.buyer_id = b.buyer_id ORDER BY x.requirement_id DESC LIMIT 1
  ) r ON TRUE;

CREATE VIEW public_gpu_resources AS
  SELECT seller_id, gpu_model, vram_gb, capacity_hours, delivery_time_minutes, is_simulated FROM gpu_resources;

CREATE VIEW public_coalitions AS
  SELECT coalition_id, gpu_model, vram_gb, total_hours, price_ceiling_per_hour_yocto, total_budget_yocto,
         delivery_deadline, min_members, status, failure_reason, registration_tx_hash, created_at, updated_at
  FROM coalitions;

CREATE VIEW public_coalition_members AS
  SELECT coalition_id, buyer_id, hours, status, joined_at, left_at FROM coalition_members;

CREATE VIEW public_purchases AS
  SELECT purchase_id, coalition_id, state, winner_seller_id, winning_price_per_hour_yocto, required_total_yocto,
         deposited_yocto, funding_deadline, delivery_deadline, verification_deadline, payout_in_flight,
         refund_in_flight, last_synced_at, drift_detected, drift_detail, created_at, updated_at
  FROM purchases;

CREATE VIEW public_auctions AS
  SELECT auction_id, purchase_id, coalition_id, commit_deadline, reveal_deadline, closed_at, outcome,
         create_tx_hash, close_tx_hash, created_at
  FROM auctions;

CREATE VIEW public_allocations AS
  SELECT purchase_id, buyer_id, hours, amount_yocto, approval, record_tx_hash, created_at FROM allocations;

CREATE VIEW public_deliveries AS
  SELECT purchase_id, seller_id, outcome, required_hours, allocated_hours, started_at, finished_at,
         job_log_hash_hex, report_tx_hash, is_simulated, created_at
  FROM deliveries;

CREATE VIEW public_verifications AS
  SELECT purchase_id, success, reason, verifier_account, is_simulated, tx_hash, created_at FROM verification_records;

CREATE VIEW public_settlements AS
  SELECT settlement_id, purchase_id, seller_id, payout_account_id, amount_yocto, status, tx_hash, created_at FROM settlements;

CREATE VIEW public_refunds AS
  SELECT refund_id, purchase_id, funder_account_id, total_yocto, status, tx_hash, created_at FROM refunds;

CREATE VIEW public_refund_lines AS
  SELECT l.refund_id, r.purchase_id, l.buyer_id, l.amount_yocto
  FROM refund_lines l JOIN refunds r USING (refund_id);

CREATE VIEW public_transactions AS
  SELECT tx_hash, signer_account_id, receiver_id, method_name, purpose, purchase_id, deposit_yocto, status,
         block_height, gas_burnt, submitted_at, finalized_at
  FROM blockchain_transactions;

CREATE VIEW public_contract_events AS
  SELECT tx_hash, receipt_id, log_index, block_height, block_timestamp_ns, event, data, purchase_id
  FROM contract_events;

-- Latest on-chain reputation snapshot per seller (copied from contract events only).
CREATE VIEW public_reputation AS
  SELECT DISTINCT ON (seller_id) seller_id, wins, completed_deliveries, failed_deliveries, non_reveals,
         source_tx_hash, block_height
  FROM reputation_records
  ORDER BY seller_id, block_height DESC, record_id DESC;
