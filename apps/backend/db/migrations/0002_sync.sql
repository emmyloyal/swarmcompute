-- =====================================================================
-- Phase 6: event indexing and reconciliation bookkeeping.
-- =====================================================================

-- When the indexer has fetched this tx's receipts and stored its events.
ALTER TABLE blockchain_transactions ADD COLUMN indexed_at TIMESTAMPTZ NULL;
CREATE INDEX blockchain_transactions_unindexed ON blockchain_transactions(submitted_at) WHERE indexed_at IS NULL;

-- Confirmation work queue: accepted on-chain messages awaiting RPC verification.
CREATE INDEX agent_messages_unconfirmed ON agent_messages(received_at)
  WHERE status = 'ACCEPTED' AND tx_hash IS NOT NULL;

-- One snapshot per reputation event, so re-indexing is idempotent.
ALTER TABLE reputation_records ADD COLUMN receipt_id TEXT NULL;
ALTER TABLE reputation_records ADD COLUMN log_index INTEGER NULL;
CREATE UNIQUE INDEX reputation_records_event ON reputation_records(receipt_id, log_index) WHERE receipt_id IS NOT NULL;
