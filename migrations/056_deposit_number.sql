-- 056_deposit_number.sql — SS-2.4 P2a: human deposit-hold number on payments.
-- ---------------------------------------------------------------------------
-- Option A (approved): a nullable `deposit_number` column on payments, set ONLY
-- on payment_kind='deposit' rows (the anchor of a deposit hold). Format
-- DP-YYYY-{order_number}-{seq}, e.g. DP-2026-0142-1 (per the Deposit Hold 360
-- design). Rejected Option C (use payment.id) — a raw UUID isn't the human-
-- readable reference the operator + customer receipt need.
--
-- Extends the shipped 6d payments-based deposit model (no deposit_holds table).
-- Transaction-safe: plain ADD COLUMN + partial unique index, no ALTER TYPE.
-- ---------------------------------------------------------------------------

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS deposit_number text;

COMMENT ON COLUMN payments.deposit_number IS
  'Human deposit-hold number DP-YYYY-{order_number}-{seq}; set only on payment_kind=''deposit'' rows. NULL for rental / refund / forfeit rows.';

-- Unique per workspace among the rows that carry one (deposit anchors).
CREATE UNIQUE INDEX IF NOT EXISTS payments_deposit_number_uidx
  ON payments (workspace_id, deposit_number)
  WHERE deposit_number IS NOT NULL;
