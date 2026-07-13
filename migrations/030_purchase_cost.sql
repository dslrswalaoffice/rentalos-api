-- 030_purchase_cost.sql — Sub-turn 11: purchase cost + real ROI
-- ---------------------------------------------------------------------------
-- Two-level cost: assets.purchase_cost_paise overrides
-- products.default_purchase_cost_paise, resolved COALESCE(asset, product) at
-- read time (never denormalized).
--
-- Schema-reality note (STEP 0): `assets` already had a dormant, unused
-- `purchase_price integer` (+ `purchase_date date`, `purchase_source text`).
-- The spec's `ADD COLUMN purchase_date` would have FAILED (duplicate column),
-- and `integer` paise overflows at ~₹21.5L. So we reuse `purchase_date`
-- as-is, and replace `purchase_price` with a BIGINT `purchase_cost_paise`
-- (copying any existing values across first). `purchase_source` is untouched.

ALTER TABLE products
  ADD COLUMN default_purchase_cost_paise BIGINT
    CHECK (default_purchase_cost_paise IS NULL OR default_purchase_cost_paise >= 0);

ALTER TABLE assets
  ADD COLUMN purchase_cost_paise BIGINT
    CHECK (purchase_cost_paise IS NULL OR purchase_cost_paise >= 0);

-- Preserve any existing per-asset cost from the legacy integer column.
UPDATE assets SET purchase_cost_paise = purchase_price WHERE purchase_price IS NOT NULL;

-- Drop the legacy column (dormant — no code read or wrote it).
ALTER TABLE assets DROP COLUMN purchase_price;

COMMENT ON COLUMN products.default_purchase_cost_paise IS
  'Fallback cost per unit. Used for any asset without its own purchase_cost_paise. NULL = not recorded (never treat as zero).';
COMMENT ON COLUMN assets.purchase_cost_paise IS
  'Per-unit override of the product default. NULL = fall back to product default.';
COMMENT ON COLUMN assets.purchase_date IS
  'Acquisition date. Drives holding period. NULL = unknown.';
