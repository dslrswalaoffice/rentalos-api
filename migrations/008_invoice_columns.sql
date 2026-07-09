-- ============================================================================
-- Migration 008 — Invoice lifecycle + detail columns
-- ============================================================================
-- Sub-turn 2.4a-schema (migration 007) added the GST-split columns to invoices
-- but not the lifecycle/detail columns the generation + status-transition
-- endpoints need. This migration fills that gap: customer snapshot pointer,
-- discount/paid/balance caches (frozen at generation), lifecycle timestamps
-- (sent/due/paid), operator notes, and a pdf_url placeholder.
--
-- Additive and reversible (ADD COLUMN IF NOT EXISTS) — no existing invoice rows,
-- so no backfill needed. Matches the "roll back one migration cleanly" intent
-- of the 2.4a-schema split.
-- ============================================================================

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS customer_id    uuid REFERENCES people(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS discount_paise bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_paise     bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS balance_paise  bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sent_at        timestamptz,
  ADD COLUMN IF NOT EXISTS due_at         timestamptz,
  ADD COLUMN IF NOT EXISTS paid_at        timestamptz,
  ADD COLUMN IF NOT EXISTS notes          text,
  ADD COLUMN IF NOT EXISTS pdf_url        text;
