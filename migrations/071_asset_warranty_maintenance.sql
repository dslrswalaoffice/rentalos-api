-- ===========================================================================
-- 071_asset_warranty_maintenance.sql -- Phase 2 (Assets) completion S1.
-- ---------------------------------------------------------------------------
-- Per-asset warranty + maintenance-due lifecycle signals. asset-360 already
-- reserves stub rows for both (rendered as "—" with no schema); this adds the
-- backing columns + configurable attention thresholds so those stubs become real
-- and the Assets list can flag "warranty expiring" / "maintenance due" alongside
-- the existing utilization + damage flags.
--
-- Per-asset granularity (Q2): each physical unit carries its own warranty +
-- service dates (an AMC or purchase warranty is per-unit, not per-model). All
-- four columns are NULLABLE -- existing units have no data and must NOT trigger
-- any attention flag until an operator fills them in.
--
--   1. assets.warranty_expiry     DATE   -- unit warranty end date
--      assets.warranty_notes      TEXT   -- provider / terms / claim ref
--      assets.next_service_due    DATE   -- next scheduled service
--      assets.last_service_date   DATE   -- most recent service done
--   2. settings.asset_attention_policy = { warranty_expiring_days: 30,
--        maintenance_due_days: 14 } -- thresholds, checked at query time (Q5).
--      Top-level jsonb merge, COALESCE-guarded (never clobbers operator edits;
--      not silently skipped on a workspace with no settings -- the 065/069 gotcha).
--   3. Two partial indexes so the "expiring / due soon" filters + sorts stay cheap
--      (only non-null, non-deleted rows are indexed).
--
-- Additive + idempotent. Runs inside the transactional migration runner.
-- ===========================================================================

-- 1. Nullable lifecycle-date columns on assets.
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS warranty_expiry    date,
  ADD COLUMN IF NOT EXISTS warranty_notes     text,
  ADD COLUMN IF NOT EXISTS next_service_due   date,
  ADD COLUMN IF NOT EXISTS last_service_date  date;

-- 2. Attention thresholds (defaults; COALESCE preserves any operator override).
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{asset_attention_policy}',
  COALESCE(settings->'asset_attention_policy', '{}'::jsonb) || jsonb_build_object(
    'warranty_expiring_days',
      COALESCE(settings->'asset_attention_policy'->'warranty_expiring_days', '30'::jsonb),
    'maintenance_due_days',
      COALESCE(settings->'asset_attention_policy'->'maintenance_due_days', '14'::jsonb)
  ),
  true
)
WHERE deleted_at IS NULL
  AND (settings->'asset_attention_policy' IS NULL
       OR jsonb_typeof(settings->'asset_attention_policy') = 'object');

-- 3. Partial indexes for the expiring/due filters + sorts.
CREATE INDEX IF NOT EXISTS idx_assets_warranty_expiry
  ON assets (workspace_id, warranty_expiry)
  WHERE warranty_expiry IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_assets_next_service_due
  ON assets (workspace_id, next_service_due)
  WHERE next_service_due IS NOT NULL AND deleted_at IS NULL;
