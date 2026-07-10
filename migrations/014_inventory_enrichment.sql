-- ============================================================================
-- Migration 014 — Inventory enrichment (HSN codes)
-- ============================================================================
-- Sub-turn 5c-1 enriches products with images, HSN codes, and categories.
--
-- Reality check against the existing schema (migration 002): products ALREADY
-- has `category text NOT NULL` (indexed via idx_products_category) and
-- `image_url text`. The only genuinely new column is `hsn_code`. So this
-- migration adds just that — adding the others would fail / be redundant.
--
-- No backfill: existing products have NULL hsn_code until an operator sets one.
-- ============================================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS hsn_code text
    CHECK (hsn_code IS NULL OR length(hsn_code) <= 8);
