-- ============================================================================
-- Migration 024 — Multi-location stock (Phase 1)
-- ============================================================================
-- Sub-turn 6i, Phase 1. Locations are workspace-scoped; every tracked asset and
-- every order pickup/return points at a location. Existing data backfills to a
-- single seeded default location, so single-location workspaces (DSLRSWALA) see
-- no behavior change. Phase 1 enforces pickup = return (CHECK); cross-location
-- returns, transfers, and per-location bulk stock are Phase 2.
-- ============================================================================

CREATE TABLE IF NOT EXISTS locations (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               text        NOT NULL,
  address_line1      text,
  address_line2      text,
  city               text,
  state              text,
  postal_code        text,
  phone              text,
  email              text,
  is_default         boolean     NOT NULL DEFAULT false,
  is_active          boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid        REFERENCES users(id)
);

-- Exactly one default per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS locations_one_default_per_workspace
  ON locations (workspace_id) WHERE is_default = true;

CREATE INDEX IF NOT EXISTS locations_workspace_active_idx
  ON locations (workspace_id, is_active);

-- Seed one default location per existing workspace (name from city, else fallback).
INSERT INTO locations (workspace_id, name, city, is_default, is_active)
SELECT
  w.id,
  CASE WHEN w.city IS NOT NULL AND w.city != '' THEN w.city || ' Main' ELSE 'Main warehouse' END,
  w.city,
  true,
  true
FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.workspace_id = w.id);

-- Assets belong to a location.
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES locations(id);

UPDATE assets a
SET location_id = (
  SELECT id FROM locations l WHERE l.workspace_id = a.workspace_id AND l.is_default = true LIMIT 1
)
WHERE location_id IS NULL;

ALTER TABLE assets ALTER COLUMN location_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS assets_location_idx
  ON assets (workspace_id, location_id, product_id);

-- Orders carry pickup + return location.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS pickup_location_id uuid REFERENCES locations(id),
  ADD COLUMN IF NOT EXISTS return_location_id uuid REFERENCES locations(id);

UPDATE orders o
SET pickup_location_id = (SELECT id FROM locations l WHERE l.workspace_id = o.workspace_id AND l.is_default = true LIMIT 1),
    return_location_id = (SELECT id FROM locations l WHERE l.workspace_id = o.workspace_id AND l.is_default = true LIMIT 1)
WHERE pickup_location_id IS NULL OR return_location_id IS NULL;

ALTER TABLE orders ALTER COLUMN pickup_location_id SET NOT NULL;
ALTER TABLE orders ALTER COLUMN return_location_id SET NOT NULL;

-- v1: same pickup and return (dropped in Phase 2 when transfers exist).
ALTER TABLE orders
  ADD CONSTRAINT orders_pickup_equals_return CHECK (pickup_location_id = return_location_id);

CREATE INDEX IF NOT EXISTS orders_pickup_location_idx
  ON orders (workspace_id, pickup_location_id);
