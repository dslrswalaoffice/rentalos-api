-- 048_create_damage_incidents.sql — Sub-slice 2.3: first-class damage incidents (Item 4).
-- ---------------------------------------------------------------------------
-- NUMBERING: pack "056" → real 048 (see 046 header for the renumber rationale).
--
-- A damage incident is a first-class, PARALLEL workflow: it captures damage
-- during any phase of a rental with structured evidence (photos), operational
-- continuity ("Save The Shoot"), and financial resolution — all decoupled from
-- the order's own lifecycle. An order CAN close while an incident stays open.
--
-- This table references substitutions(id) (migration 046) via
-- linked_substitution_id, so it MUST come after 046.
--
-- Discipline: gen_random_uuid(), workspace_id 2nd column NOT NULL,
-- policy_applied_snapshot frozen at creation, photos as JSONB array.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS damage_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES orders(id),
  incident_number TEXT NOT NULL,                           -- DI-2026-0142

  -- Reporting details
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reported_by_type TEXT NOT NULL CHECK (reported_by_type IN (
    'customer_whatsapp',
    'staff_observation',
    'on_rent_check_in',
    'inspection_at_return',
    'third_party'
  )),
  occurred_at TIMESTAMPTZ NOT NULL,                        -- when the damage actually happened

  -- 12-tag incident type taxonomy
  incident_type TEXT NOT NULL CHECK (incident_type IN (
    'accidental_drop',
    'impact_damage',
    'liquid_damage',
    'electrical_damage',
    'operational_failure',
    'theft',
    'loss',
    'third_party_damage',
    'weather',
    'misuse',
    'wear_and_tear_dispute',
    'other'
  )),

  -- 5-level severity
  severity TEXT NOT NULL CHECK (severity IN (
    'cosmetic',
    'minor',
    'major',
    'total_loss',
    'catastrophic'
  )),

  description TEXT NOT NULL,
  photos JSONB NOT NULL DEFAULT '[]'::jsonb,                -- [{url, gps, timestamp}]

  -- Operational continuity (Save The Shoot choice)
  operational_decision TEXT CHECK (operational_decision IN (
    'substitute_with_another_unit',
    'dispatch_replacement_keep_damaged',
    'early_return_damaged_only',
    'continue_with_damaged',
    'full_early_return',
    'pending'
  )),
  operational_decided_at TIMESTAMPTZ,
  operational_decided_by UUID REFERENCES users(id),

  -- Linked substitution (if operational_decision routes to substitute)
  linked_substitution_id UUID REFERENCES substitutions(id),

  -- Financial resolution (separate from operational)
  customer_liability TEXT CHECK (customer_liability IN (
    'yes',
    'no',
    'partial',
    'pending_investigation'
  )),
  liability_percent INTEGER CHECK (liability_percent BETWEEN 0 AND 100),
  estimated_cost_paise BIGINT,
  final_cost_paise BIGINT,

  financial_resolution TEXT CHECK (financial_resolution IN (
    'customer_pays',
    'insurance_claim',
    'warranty_coverage',
    'business_absorbs',
    'partial_split',
    'deposit_only',
    'deposit_plus_additional',
    'pending'
  )),
  financial_resolved_at TIMESTAMPTZ,
  financial_resolved_by UUID REFERENCES users(id),

  -- Deposit implication
  deposit_action TEXT CHECK (deposit_action IN (
    'hold',
    'adjust',
    'forfeit_partial',
    'forfeit_full',
    'no_change'
  )),
  deposit_forfeit_amount_paise BIGINT DEFAULT 0,

  -- Insurance (structure now, automation Phase 2)
  insurance_claim_id UUID,
  insurance_eligible BOOLEAN,

  -- Status lifecycle (parallel to the order)
  status TEXT NOT NULL DEFAULT 'reported' CHECK (status IN (
    'reported',
    'investigating',
    'resolution_proposed',
    'customer_acknowledged',
    'in_repair',
    'financial_settled',
    'closed'
  )),

  -- Approval routing
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  approval_request_id UUID REFERENCES approval_requests(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,

  -- Customer notification / dispute
  customer_notified BOOLEAN NOT NULL DEFAULT FALSE,
  customer_disputed BOOLEAN NOT NULL DEFAULT FALSE,
  customer_dispute_notes TEXT,

  -- Audit
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Policy snapshot (frozen at creation for audit — auto-liability map + thresholds)
  policy_applied_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_damage_workspace_status_severity ON damage_incidents (workspace_id, status, severity);
CREATE INDEX IF NOT EXISTS idx_damage_order ON damage_incidents (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_damage_number_per_ws ON damage_incidents (workspace_id, incident_number);

-- ---------------------------------------------------------------------------
-- REVERSE MIGRATION (for reference — do not run automatically):
--   DROP TABLE IF EXISTS damage_incidents;
-- ---------------------------------------------------------------------------
