-- ============================================================================
-- Migration 018 — Per-product buffer time + shortage config
-- ============================================================================
-- Sub-turn 6b: Booqable-informed availability. Buffer/padding time moves from a
-- single workspace-wide value to per-product (a camera battery needs 2h to
-- charge; a light stand needs 30min to reset), and overbook tolerance becomes
-- per-product too (rare gear = strict, easily sub-rented = lenient).
--
--   buffer_before_hours — prep time before this product's rentals start
--   buffer_after_hours  — turnaround time after this product's rentals end
--   shortage_limit      — allowed overbook units above capacity
--
-- The old workspace-level settings.availability.buffer_hours stays for backward
-- compat but is DEPRECATED for check-time logic — the availability engine now
-- reads per-product buffers only. Existing products are backfilled from it so
-- behavior is preserved after migrate.
-- ============================================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS buffer_before_hours integer NOT NULL DEFAULT 0
    CHECK (buffer_before_hours >= 0 AND buffer_before_hours <= 72),
  ADD COLUMN IF NOT EXISTS buffer_after_hours integer NOT NULL DEFAULT 0
    CHECK (buffer_after_hours >= 0 AND buffer_after_hours <= 72),
  ADD COLUMN IF NOT EXISTS shortage_limit integer NOT NULL DEFAULT 0
    CHECK (shortage_limit >= 0 AND shortage_limit <= 100);

-- Backfill existing products with the workspace's current buffer_hours setting
-- so behavior is preserved after migrate. Only touches products still at the
-- default zero, so re-running is idempotent.
UPDATE products p
SET
  buffer_before_hours = COALESCE(
    (SELECT (w.settings->'availability'->>'buffer_hours')::int
     FROM workspaces w WHERE w.id = p.workspace_id),
    0
  ),
  buffer_after_hours = COALESCE(
    (SELECT (w.settings->'availability'->>'buffer_hours')::int
     FROM workspaces w WHERE w.id = p.workspace_id),
    0
  )
WHERE buffer_before_hours = 0 AND buffer_after_hours = 0;
