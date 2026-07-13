-- 038_contract_drop_legacy_columns.sql — Sub-turn 13, chunk 10: CONTRACT phase.
-- ---------------------------------------------------------------------------
-- The expand-migrate-contract finale. Every read/write of these four legacy
-- product columns has been repointed to the new model FIRST (this commit):
--   * tracking_mode   → tracking_method (serialized | bulk | none)
--   * stock_quantity  → stock_levels (per-location; Σ = the old global value)
--   * weekly_rate     → dropped (the pricing engine + structures supersede it)
--   * monthly_rate    → dropped (same)
--
-- Runs LAST so no running code reads a column it drops. The coupling constraint
-- products_bulk_requires_quantity references BOTH tracking_mode and stock_quantity,
-- so it is dropped explicitly before the columns; the single-column CHECKs
-- (weekly_rate > 0, stock_quantity >= 0, tracking_mode IN (...)) drop with their
-- columns automatically. IF EXISTS keeps the migration idempotent + safe against
-- a partially-migrated branch DB.

-- 1. Drop the multi-column coupling constraint (Sub-turn 6h, migration 023).
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_bulk_requires_quantity;

-- 2. Drop the four legacy columns. No index or view depends on them (verified),
--    so no CASCADE is needed — a surprising dependency SHOULD abort the deploy.
ALTER TABLE products
  DROP COLUMN IF EXISTS tracking_mode,
  DROP COLUMN IF EXISTS stock_quantity,
  DROP COLUMN IF EXISTS weekly_rate,
  DROP COLUMN IF EXISTS monthly_rate;
