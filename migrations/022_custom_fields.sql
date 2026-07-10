-- ============================================================================
-- Migration 022 — Custom fields (orders, people, products)
-- ============================================================================
-- Sub-turn 6g. Workspace-defined custom fields on three entity types. Two
-- tables: definitions (the per-workspace schema) + values (per record, stored
-- as text; type-specific parsing happens on read via the definition's
-- field_type). Deleting a definition is a soft-delete (is_active = false) — the
-- ON DELETE RESTRICT on values protects historical data.
-- ============================================================================

CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type        text        NOT NULL CHECK (entity_type IN ('order', 'person', 'product')),
  field_key          text        NOT NULL,   -- machine name, e.g. 'shoot_location'
  label              text        NOT NULL,   -- human name, e.g. 'Shoot Location'
  field_type         text        NOT NULL CHECK (field_type IN ('text', 'number', 'date', 'checkbox', 'dropdown')),
  options            jsonb,                   -- for dropdown: ["Option 1", "Option 2"]
  is_required        boolean     NOT NULL DEFAULT false,
  help_text          text,
  sort_order         integer     NOT NULL DEFAULT 0,
  is_active          boolean     NOT NULL DEFAULT true,   -- soft-deleted definitions
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid        REFERENCES users(id),

  UNIQUE (workspace_id, entity_type, field_key)
);

CREATE INDEX IF NOT EXISTS custom_field_definitions_entity_idx
  ON custom_field_definitions (workspace_id, entity_type, sort_order)
  WHERE is_active = true;

CREATE TABLE IF NOT EXISTS custom_field_values (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  definition_id      uuid        NOT NULL REFERENCES custom_field_definitions(id) ON DELETE RESTRICT,
  entity_type        text        NOT NULL CHECK (entity_type IN ('order', 'person', 'product')),
  entity_id          uuid        NOT NULL,
  value              text,                    -- serialized value (all types stored as string)
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid        REFERENCES users(id),

  UNIQUE (workspace_id, definition_id, entity_id)
);

CREATE INDEX IF NOT EXISTS custom_field_values_entity_idx
  ON custom_field_values (workspace_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS custom_field_values_definition_idx
  ON custom_field_values (workspace_id, definition_id);
