-- ============================================================================
-- Migration 019 — Deposit workflow + late-order support
-- ============================================================================
-- Sub-turn 6d. Two Booqable-informed gaps around order-state visibility and
-- cash management:
--
--  1. Deposit as a first-class lifecycle. RentalOS held a `deposit` object in
--     workspace.settings but no per-order deposit lifecycle. A deposit is a
--     payment with a distinct KIND (not a new table), so it reuses the payments
--     correction-window / audit / refund infrastructure. Existing payments
--     backfill to 'rental'.
--       - orders.deposit_required_paise — how much deposit is expected.
--       - orders.deposit_status         — denormalised lifecycle state, recomputed
--                                          from deposit-kind payments.
--     NOTE: this is distinct from the pre-existing orders.deposit_paise (the
--     deposit portion of the order's own line totals) — different concept.
--
--  2. Late detection is computed (is_late = rental_end < now() AND an item is
--     still 'dispatched'); nothing stored here. The partial index just speeds up
--     the `deposit_status != 'none'` slice.
-- ============================================================================

-- payment_kind on payments. Existing rows default to 'rental' via DEFAULT, so
-- no separate backfill statement is needed.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS payment_kind text NOT NULL DEFAULT 'rental'
    CHECK (payment_kind IN ('rental', 'deposit', 'deposit_refund', 'deposit_forfeit'));

-- Deposit fields on orders.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS deposit_required_paise bigint NOT NULL DEFAULT 0
    CHECK (deposit_required_paise >= 0),
  ADD COLUMN IF NOT EXISTS deposit_status text NOT NULL DEFAULT 'none'
    CHECK (deposit_status IN ('none', 'pending', 'held', 'partial_forfeited', 'fully_forfeited', 'released'));

CREATE INDEX IF NOT EXISTS orders_deposit_status_idx
  ON orders (workspace_id, deposit_status)
  WHERE deposit_status != 'none';
