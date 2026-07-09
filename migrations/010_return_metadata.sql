-- ============================================================================
-- Migration 010 — Return metadata on order_items
-- ============================================================================
-- Sub-turn 3b adds the return (check-in) workflow — the mirror of dispatch.
-- These columns capture who received the returned gear and who it came back
-- from. Populated by POST /api/orders/:id/return.
--
-- (Numbered 010, not 009 as the task draft suggested — 009 is already taken by
-- 009_dispatch_metadata.sql. The ledger matches on filename.)
--
-- condition_notes and returned_at already exist from migration 006. Both new
-- columns are nullable; no backfill needed.
-- ============================================================================

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS returned_by_user_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS returned_from       text;
