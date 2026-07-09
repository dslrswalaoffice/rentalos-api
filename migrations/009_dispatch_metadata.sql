-- ============================================================================
-- Migration 009 — Dispatch metadata on order_items
-- ============================================================================
-- Sub-turn 3a adds a dispatch (hand-over) workflow. These columns capture who
-- the gear was handed to, which staff member handed it over, and any notes
-- taken at the counter. Populated by POST /api/orders/:id/dispatch.
--
-- (Numbered 009, not 008 as the task draft suggested — 008 is already taken by
-- 008_invoice_columns.sql. The ledger matches on filename, so numbering stays
-- sequential.)
--
-- All nullable, no backfill: items already in 'dispatched' from the per-item
-- status endpoint simply show blank dispatch metadata — acceptable.
-- ============================================================================

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS handed_to           text,
  ADD COLUMN IF NOT EXISTS received_by_user_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS dispatch_notes      text;
