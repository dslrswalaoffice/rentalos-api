-- ============================================================================
-- Migration 023 — Trackable vs bulk products
-- ============================================================================
-- Sub-turn 6h. Two tracking modes on products (Booqable pattern):
--   'tracked' (default, current behavior) — each unit is a serialized asset row;
--             capacity = COUNT(assets). stock_quantity MUST be NULL.
--   'bulk'    — fungible stock counted by quantity; no asset rows;
--             capacity = stock_quantity. stock_quantity MUST be set.
-- Existing products all backfill to 'tracked' (the DEFAULT), so DSLRSWALA is
-- unchanged. The CHECK constraint enforces the mode/stock coupling at the DB.
-- ============================================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS tracking_mode text NOT NULL DEFAULT 'tracked'
    CHECK (tracking_mode IN ('tracked', 'bulk')),
  ADD COLUMN IF NOT EXISTS stock_quantity integer
    CHECK (stock_quantity IS NULL OR stock_quantity >= 0);

-- Belt-and-suspenders: make sure every pre-existing row is tracked with a null
-- stock_quantity before we add the coupling constraint (the DEFAULT already
-- handles new column values, but this guards against any odd prior data).
UPDATE products
SET tracking_mode = 'tracked', stock_quantity = NULL
WHERE tracking_mode IS NULL
   OR (tracking_mode = 'tracked' AND stock_quantity IS NOT NULL);

-- Bulk products MUST have stock_quantity; tracked products MUST NOT.
ALTER TABLE products
  ADD CONSTRAINT products_bulk_requires_quantity CHECK (
    (tracking_mode = 'tracked' AND stock_quantity IS NULL)
    OR (tracking_mode = 'bulk' AND stock_quantity IS NOT NULL AND stock_quantity >= 0)
  );
