-- ============================================================================
-- Migration 017 — Workspace integrations (adapter architecture)
-- ============================================================================
-- Sub-turn 6a: per-workspace, per-category third-party adapters (payment /
-- whatsapp / email). One active adapter per category (partial unique index).
-- Credentials are AES-256-GCM encrypted at rest (INTEGRATION_ENC_KEY) and never
-- returned to the frontend. config jsonb holds non-secret metadata.
--
-- The old feature flags (wati_notifications, cashfree_gateway, …) stay in
-- workspace.settings for backward compat but are informational only for these
-- categories — is_active on the row is authoritative.
-- ============================================================================

CREATE TABLE IF NOT EXISTS workspace_integrations (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  category              text        NOT NULL CHECK (category IN ('payment', 'whatsapp', 'email')),
  provider              text        NOT NULL,
  credentials_encrypted bytea,      -- encrypted JSON blob; null when not configured
  config                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  is_active             boolean     NOT NULL DEFAULT false,
  test_mode             boolean     NOT NULL DEFAULT false,
  last_tested_at        timestamptz,
  last_test_status      text,       -- 'success' | 'failed' | null
  last_test_message     text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by_user_id    uuid        REFERENCES users(id),

  UNIQUE (workspace_id, category, provider)
);

-- At most one active adapter per (workspace, category).
CREATE UNIQUE INDEX IF NOT EXISTS workspace_integrations_one_active_per_category
  ON workspace_integrations (workspace_id, category)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS workspace_integrations_workspace_idx
  ON workspace_integrations (workspace_id, category);
