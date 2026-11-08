-- =====================================================================
-- Fair-price collective buying (prepay → one clearing price → balance back).
--
-- Each member prepays hours × its own max price from its own wallet. At award
-- everyone owes hours × the clearing price (one rate); prepaid − owed is
-- credited back and withdrawn to the buyer's wallet. Failures credit each
-- member's money back to that member, not to a central funder.
-- =====================================================================

-- Escrow now holds members' prepayments (their max), which exceed what they owe.
ALTER TABLE purchases DROP CONSTRAINT purchases_check1;

-- Per-member fairness record. amount_yocto = owed = hours × clearing price.
ALTER TABLE allocations ADD COLUMN max_price_per_hour_yocto yocto NULL;
ALTER TABLE allocations ADD COLUMN prepaid_yocto yocto NULL;
ALTER TABLE allocations ADD COLUMN excess_yocto yocto NULL;
ALTER TABLE allocations ADD COLUMN refunded_yocto yocto NOT NULL DEFAULT 0;
ALTER TABLE allocations ADD COLUMN prepay_tx_hash tx_hash NULL;
ALTER TABLE allocations DROP CONSTRAINT allocations_approval_check;
ALTER TABLE allocations ADD CONSTRAINT allocations_approval_check
  CHECK (approval IN ('SIMULATED_APPROVED', 'SIMULATED_REJECTED', 'PREPAID_ON_CHAIN'));
ALTER TABLE allocations ADD CONSTRAINT allocations_fair_split
  CHECK (prepaid_yocto IS NULL OR excess_yocto IS NULL OR prepaid_yocto = amount_yocto + excess_yocto);

-- Refunds are credited to each member (refund_lines); there is no central funder.
ALTER TABLE refunds ALTER COLUMN funder_account_id DROP NOT NULL;
ALTER TABLE refunds ADD COLUMN reason TEXT NULL;

-- Money actually sent to a buyer's own wallet (one row per attempt, real tx outcome).
CREATE TABLE withdrawals (
  withdrawal_id  BIGSERIAL PRIMARY KEY,
  buyer_id       TEXT NOT NULL REFERENCES buyers(buyer_id),
  wallet         near_account NOT NULL,
  amount_yocto   yocto NOT NULL CHECK (amount_yocto > 0),
  status         TEXT NOT NULL CHECK (status IN ('SUCCEEDED', 'FAILED')),
  tx_hash        tx_hash NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX withdrawals_buyer ON withdrawals(buyer_id, created_at DESC);

-- Public views (RULES.md R13).
DROP VIEW public_allocations;
CREATE VIEW public_allocations AS
  SELECT purchase_id, buyer_id, hours, max_price_per_hour_yocto, prepaid_yocto, amount_yocto AS owed_yocto,
         excess_yocto, refunded_yocto, approval, prepay_tx_hash, record_tx_hash, created_at
  FROM allocations;

CREATE VIEW public_withdrawals AS
  SELECT withdrawal_id, buyer_id, wallet, amount_yocto, status, tx_hash, created_at FROM withdrawals;

DROP VIEW public_refund_lines;
DROP VIEW public_refunds;
CREATE VIEW public_refunds AS
  SELECT refund_id, purchase_id, total_yocto, reason, status, tx_hash, created_at FROM refunds;
CREATE VIEW public_refund_lines AS
  SELECT l.refund_id, r.purchase_id, l.buyer_id, l.amount_yocto
  FROM refund_lines l JOIN refunds r USING (refund_id);
