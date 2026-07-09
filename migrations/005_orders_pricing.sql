-- ============================================================================
-- Migration 005 — Orders pricing: manual price override flag
-- ============================================================================
-- Sub-turn 2.1a adds an auto-computing pricing engine (src/lib/pricing.ts).
-- Line items normally derive their totals from the workspace billing settings
-- (daily_rate_paise × quantity × billable_days). When an operator manually
-- edits a rental line's unit_amount_paise, we must stop the engine from
-- overwriting that value on the next recompute.
--
-- This column is the flag. Set true automatically when unit_amount_paise is
-- PATCHed on a rental line; reset to false to hand the line back to the engine.
--
-- Idempotent: safe to re-run. No indexes, triggers, or seed changes here.
-- ============================================================================

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS manual_price boolean NOT NULL DEFAULT false;
