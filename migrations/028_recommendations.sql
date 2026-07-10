-- ============================================================================
-- Migration 028 — Related product recommendations (Sub-turn 8c)
-- ============================================================================
-- One table for MANUAL curation. Co-rental recommendations are computed
-- on-demand from order history (24h in-process cache), so nothing is stored
-- for them here. Additive; no changes to existing tables.
-- ============================================================================

CREATE TABLE IF NOT EXISTS product_recommendations (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_product_id      uuid        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  recommended_product_id uuid        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sort_order             integer     NOT NULL DEFAULT 0,
  note                   text,       -- optional internal note ("essential accessory")
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  created_by_user_id     uuid        REFERENCES users(id),

  UNIQUE (workspace_id, source_product_id, recommended_product_id),
  CHECK (source_product_id != recommended_product_id)  -- can't recommend self
);

CREATE INDEX IF NOT EXISTS product_recommendations_source_idx
  ON product_recommendations (workspace_id, source_product_id, sort_order);
