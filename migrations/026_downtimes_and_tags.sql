-- ============================================================================
-- Migration 026 — Product downtimes + workspace tags (Sub-turn 8a)
-- ============================================================================
-- Two independent, additive features bundled:
--   * product_downtimes — maintenance windows that block a product's capacity
--     (per-location when location_id is set, all-locations when NULL).
--   * tags + tag_assignments — flexible cross-cutting labels for products /
--     people / orders. Soft-deletable; assignments survive a soft-delete.
-- No changes to existing tables.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Downtimes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_downtimes (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id         uuid        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id        uuid        REFERENCES locations(id) ON DELETE CASCADE,  -- null = all locations
  start_at           timestamptz NOT NULL,
  end_at             timestamptz NOT NULL,
  reason             text        NOT NULL,
  created_by_user_id uuid        REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);

CREATE INDEX IF NOT EXISTS product_downtimes_product_range_idx
  ON product_downtimes (workspace_id, product_id, start_at, end_at);

CREATE INDEX IF NOT EXISTS product_downtimes_location_idx
  ON product_downtimes (workspace_id, location_id)
  WHERE location_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Tags
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               text        NOT NULL,
  color              text        NOT NULL DEFAULT 'gray'
                       CHECK (color IN ('red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'gray')),
  sort_order         integer     NOT NULL DEFAULT 0,
  is_active          boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid        REFERENCES users(id),
  UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS tags_workspace_active_idx
  ON tags (workspace_id, is_active, sort_order);

CREATE TABLE IF NOT EXISTS tag_assignments (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tag_id              uuid        NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  entity_type         text        NOT NULL CHECK (entity_type IN ('product', 'person', 'order')),
  entity_id           uuid        NOT NULL,
  assigned_by_user_id uuid        REFERENCES users(id),
  assigned_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, tag_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS tag_assignments_entity_idx
  ON tag_assignments (workspace_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS tag_assignments_tag_idx
  ON tag_assignments (workspace_id, tag_id, entity_type);
