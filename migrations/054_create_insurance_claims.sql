-- 054_create_insurance_claims.sql — Sub-slice 2.3: insurance claim stub (Item 4, Q6).
-- ---------------------------------------------------------------------------
-- Aamir Q6, Option B: create the FULL stub table structure NOW with an FK from
-- damage_incidents.insurance_claim_id. Populated ad-hoc; full automation is
-- Phase 2 (no submission/webhook/reconciliation logic here).
--
-- ADDITIVE: migration 048 already created damage_incidents.insurance_claim_id as a
-- plain nullable UUID (soft link). This migration creates insurance_claims and
-- promotes that column to a real FK. The column is 100% NULL in every existing
-- row (brand-new), so the ADD CONSTRAINT validates trivially — no data fix needed
-- (satisfies the "ADD CONSTRAINT must be satisfiable" discipline: NULLs are always
-- FK-valid). insurance_claims MUST be created before the ALTER, in this file.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS insurance_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders(id),
  -- Back-reference to the incident that opened the claim (nullable — a claim can
  -- exist before the incident links it, and damage_incidents.insurance_claim_id is
  -- the forward link the pack specified).
  damage_incident_id UUID REFERENCES damage_incidents(id),

  claim_number TEXT,
  provider TEXT,
  policy_number TEXT,

  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'submitted', 'under_review', 'approved', 'rejected', 'paid', 'closed'
  )),

  claim_amount_paise BIGINT DEFAULT 0,
  approved_amount_paise BIGINT,

  submitted_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  notes TEXT,

  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insurance_claims_workspace_status ON insurance_claims (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_insurance_claims_incident ON insurance_claims (damage_incident_id);

-- Promote damage_incidents.insurance_claim_id (created in 048) to a real FK.
-- Guarded so a re-run is a no-op (idempotent). The column is all-NULL, so this
-- validates instantly against existing rows.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'damage_incidents_insurance_claim_id_fkey'
  ) THEN
    ALTER TABLE damage_incidents
      ADD CONSTRAINT damage_incidents_insurance_claim_id_fkey
      FOREIGN KEY (insurance_claim_id) REFERENCES insurance_claims(id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- REVERSE MIGRATION (for reference — do not run automatically):
--   ALTER TABLE damage_incidents DROP CONSTRAINT IF EXISTS damage_incidents_insurance_claim_id_fkey;
--   DROP TABLE IF EXISTS insurance_claims;
-- ---------------------------------------------------------------------------
