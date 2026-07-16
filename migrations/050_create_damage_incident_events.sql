-- 050_create_damage_incident_events.sql — Sub-slice 2.3: damage incident timeline.
-- ---------------------------------------------------------------------------
-- NUMBERING: pack "058" → real 050 (see 046 header).
--
-- Append-only timeline for a damage incident (reported / investigating /
-- photos_added / save_the_shoot / financial_resolution_proposed / closed / …).
-- actor_name is denormalized for display so the timeline renders without joins.
-- References damage_incidents (048); MUST come after 048.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS damage_incident_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  damage_incident_id UUID NOT NULL REFERENCES damage_incidents(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL,                                -- reported / investigating / photos_added / etc
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system', 'customer')),
  actor_id UUID,                                           -- references users(id) or NULL for system/customer
  actor_name TEXT NOT NULL,                                -- denormalized for timeline display

  title TEXT NOT NULL,
  body TEXT,
  data JSONB DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_damage_events_incident_created ON damage_incident_events (damage_incident_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- REVERSE MIGRATION (for reference — do not run automatically):
--   DROP TABLE IF EXISTS damage_incident_events;
-- ---------------------------------------------------------------------------
