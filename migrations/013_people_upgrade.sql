-- ============================================================================
-- Migration 013 — People module upgrade
-- ============================================================================
-- Sub-turn 5b: customer tiers, trust score, first-class billing/shipping
-- addresses, and a manual per-person communication log.
--
-- No backfill: existing people keep tier = NULL (unclassified) and
-- trust_score = NULL (not scored). Explicit null = "operator hasn't classified
-- this customer" — better than forcing everyone into 'normal'/50.
--
-- Tier + trust UI are gated by feature flags (customer_tiers, trust_score);
-- the columns exist regardless of flag state.
-- ============================================================================

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS tier text
    CHECK (tier IS NULL OR tier IN ('normal', 'premium', 'vip')),
  ADD COLUMN IF NOT EXISTS trust_score integer
    CHECK (trust_score IS NULL OR (trust_score >= 0 AND trust_score <= 100)),
  ADD COLUMN IF NOT EXISTS trust_score_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS billing_address text,
  ADD COLUMN IF NOT EXISTS shipping_address text;

CREATE TABLE IF NOT EXISTS person_communications (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id         uuid        NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  channel           text        NOT NULL CHECK (channel IN ('call', 'whatsapp', 'email', 'other')),
  direction         text        NOT NULL CHECK (direction IN ('in', 'out')),
  notes             text,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  logged_by_user_id uuid        REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS person_communications_person_idx
  ON person_communications (workspace_id, person_id, occurred_at DESC);
