-- ============================================================================
-- Migration 006 — Item-level status foundation + feature flag registry
-- ============================================================================
-- Real rentals aren't atomic: a 4-item order can have 3 items returned cleanly
-- and 1 missing/damaged/held. This migration adds per-item lifecycle status so
-- later sub-turns (invoices, damage recovery) can reason about physical state
-- item-by-item. It also seeds a feature-flag registry in workspace.settings so
-- future capabilities (QR scanning, OTP handover, tiers, gateways, …) can be
-- opt-in per tenant instead of hardcoded.
--
-- Conventions:
--   * Item statuses are advisory (mirrors order_status): non-canonical jumps are
--     allowed with { force: true }; every transition is audited.
--   * Feature flags are JSONB booleans under workspace.settings.features —
--     NO separate table. Missing key => false.
--   * Existing order_items rows adopt 'pending_dispatch' via the column default.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Item status enum
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE order_item_status AS ENUM (
    'pending_dispatch',
    'dispatched',
    'returned',
    'returned_with_damage',
    'not_returned_chargeable',
    'not_returned_non_chargeable',
    'missing'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ----------------------------------------------------------------------------
-- 2. Item-level status columns on order_items
-- ----------------------------------------------------------------------------
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS status order_item_status NOT NULL DEFAULT 'pending_dispatch',
  ADD COLUMN IF NOT EXISTS dispatched_at timestamptz,
  ADD COLUMN IF NOT EXISTS returned_at timestamptz,
  ADD COLUMN IF NOT EXISTS condition_notes text;


-- ----------------------------------------------------------------------------
-- 3. Index for status queries (excludes the default state to stay small)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS order_items_workspace_status_idx
  ON order_items (workspace_id, status)
  WHERE status != 'pending_dispatch';


-- ----------------------------------------------------------------------------
-- 4. Seed DSLRSWALA feature-flag registry
-- ----------------------------------------------------------------------------
-- Idempotent: the WHERE guard skips the update once features exist, so a re-run
-- never clobbers manually-toggled flags. gst_split_cgst_sgst_igst defaults true
-- for DSLRSWALA (GST-registered); Sub-turn 2.4 reads it. Everything else off.
UPDATE workspaces
SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
  'features', jsonb_build_object(
    'qr_scanning', false,
    'otp_handover', false,
    'customer_tiers', false,
    'vip_consolidated_billing', false,
    'trust_score', false,
    'investor_module', false,
    'cashfree_gateway', false,
    'wati_notifications', false,
    'gst_split_cgst_sgst_igst', true,
    'damage_module', false,
    'auto_close_when_all_items_terminal', false
  )
)
WHERE slug = 'dslrswala'
  AND (settings->'features' IS NULL);
