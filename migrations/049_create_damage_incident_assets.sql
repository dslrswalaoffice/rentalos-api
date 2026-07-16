-- 049_create_damage_incident_assets.sql — Sub-slice 2.3: per-asset damage detail.
-- ---------------------------------------------------------------------------
-- NUMBERING: pack "057" → real 049 (see 046 header).
--
-- One row per affected physical unit (or per affected line for bulk products).
-- Holds the before/after photo comparison, repair costing, and the post-damage
-- disposition (return to service / maintenance / retire / etc). References
-- damage_incidents (048) and order_items (NOT order_line_items — see 046 header).
-- MUST come after 048.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS damage_incident_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  damage_incident_id UUID NOT NULL REFERENCES damage_incidents(id) ON DELETE CASCADE,
  order_item_id UUID NOT NULL REFERENCES order_items(id),
  asset_id UUID REFERENCES assets(id),                     -- physical unit if trackable

  severity TEXT NOT NULL CHECK (severity IN (
    'cosmetic', 'minor', 'major', 'total_loss', 'catastrophic'
  )),

  -- No photo columns (Aamir Q1) — evidence lives in the Order Notes card.

  -- Repair costing
  estimated_repair_cost_paise BIGINT,
  actual_repair_cost_paise BIGINT,
  repair_notes TEXT,

  -- Disposition after damage assessed
  disposition TEXT CHECK (disposition IN (
    'return_to_service',
    'maintenance_required',
    'retire',
    'sell_as_used',
    'scrap',
    'pending_assessment'
  )),
  linked_downtime_id UUID,                                  -- soft link when a repair downtime is scheduled
  linked_asset_replacement_id UUID REFERENCES assets(id),  -- if the unit was replaced

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_damage_assets_incident ON damage_incident_assets (damage_incident_id);

-- ---------------------------------------------------------------------------
-- REVERSE MIGRATION (for reference — do not run automatically):
--   DROP TABLE IF EXISTS damage_incident_assets;
-- ---------------------------------------------------------------------------
