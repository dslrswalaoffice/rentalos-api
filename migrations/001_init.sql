-- ============================================================================
-- RentalOS · 001_init.sql
-- ============================================================================
-- Auth spine schema: workspaces, users, memberships, sessions, password reset,
-- audit events (append-only via trigger), and login-attempt rate-limit tracking.
--
-- Multi-tenant at the schema level from day one. Every operational entity
-- downstream (orders, assets, invoices, ...) will FK to workspaces(id).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";    -- case-insensitive email

-- ----------------------------------------------------------------------------
-- workspaces  — the tenant root
-- ----------------------------------------------------------------------------
CREATE TABLE workspaces (
  id             uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text         NOT NULL UNIQUE,
  name           text         NOT NULL,
  location       text,
  country_code   text         NOT NULL DEFAULT 'IN',
  currency_code  text         NOT NULL DEFAULT 'INR',
  timezone       text         NOT NULL DEFAULT 'Asia/Kolkata',
  created_at     timestamptz  NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

COMMENT ON TABLE workspaces IS 'Tenant root. Every operational row FKs to this.';
COMMENT ON COLUMN workspaces.slug IS 'URL-safe identifier, used for subdomains and routing.';

-- ----------------------------------------------------------------------------
-- users — global identity, one row per human across all workspaces
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  id                    uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 citext       NOT NULL UNIQUE,
  email_verified_at     timestamptz,
  password_hash         text         NOT NULL,
  password_updated_at   timestamptz  NOT NULL DEFAULT now(),
  display_name          text         NOT NULL,
  phone                 text,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  last_login_at         timestamptz,
  deleted_at            timestamptz
);

COMMENT ON TABLE users IS 'Global user identity. Membership in a workspace is a separate concept.';

-- ----------------------------------------------------------------------------
-- workspace_memberships — user × workspace × role
-- ----------------------------------------------------------------------------
CREATE TYPE workspace_role AS ENUM ('owner', 'manager', 'staff', 'client', 'investor');
CREATE TYPE membership_status AS ENUM ('active', 'invited', 'suspended');

CREATE TABLE workspace_memberships (
  id            uuid                 PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid                 NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid                 NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          workspace_role       NOT NULL,
  status        membership_status    NOT NULL DEFAULT 'active',
  invited_by    uuid                 REFERENCES users(id),
  joined_at     timestamptz          NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);

CREATE INDEX idx_memberships_user_active
  ON workspace_memberships(user_id) WHERE status = 'active';
CREATE INDEX idx_memberships_workspace_active
  ON workspace_memberships(workspace_id) WHERE status = 'active';

-- ----------------------------------------------------------------------------
-- sessions — active browser sessions. Tokens hashed at rest.
-- ----------------------------------------------------------------------------
CREATE TABLE sessions (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  uuid         NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash    text         NOT NULL UNIQUE,
  user_agent    text,
  ip_address    inet,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  expires_at    timestamptz  NOT NULL,
  last_used_at  timestamptz  NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);

CREATE INDEX idx_sessions_user_active
  ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_expiry
  ON sessions(expires_at) WHERE revoked_at IS NULL;

COMMENT ON COLUMN sessions.token_hash IS
  'SHA-256 of the plaintext session token. Plaintext lives only in the cookie — if the DB leaks, tokens cannot be replayed.';

-- ----------------------------------------------------------------------------
-- password_reset_tokens — one-time-use, short-lived
-- ----------------------------------------------------------------------------
CREATE TABLE password_reset_tokens (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text         NOT NULL UNIQUE,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  expires_at   timestamptz  NOT NULL,
  used_at      timestamptz,
  ip_address   inet
);

CREATE INDEX idx_reset_tokens_user_active
  ON password_reset_tokens(user_id) WHERE used_at IS NULL;

-- ----------------------------------------------------------------------------
-- audit_events — immutable, append-only log
-- ----------------------------------------------------------------------------
CREATE TABLE audit_events (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid         REFERENCES workspaces(id),
  actor_user_id   uuid         REFERENCES users(id),
  event_type      text         NOT NULL,
  target_type     text,
  target_id       uuid,
  payload         jsonb        NOT NULL DEFAULT '{}'::jsonb,
  ip_address      inet,
  user_agent      text,
  created_at      timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_workspace_time ON audit_events(workspace_id, created_at DESC);
CREATE INDEX idx_audit_actor_time     ON audit_events(actor_user_id, created_at DESC);
CREATE INDEX idx_audit_event_type     ON audit_events(event_type, created_at DESC);

-- Immutability via trigger. GDPR right-to-erasure is a separate concern:
-- if we ever need to redact, we mint a specific SECURITY DEFINER function
-- rather than opening the door to arbitrary edits.
CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only; % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

-- ----------------------------------------------------------------------------
-- login_attempts — rate-limit signal, retained 30 days by cron
-- ----------------------------------------------------------------------------
CREATE TABLE login_attempts (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext       NOT NULL,
  ip_address    inet,
  success       boolean      NOT NULL,
  attempted_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX idx_attempts_email_time ON login_attempts(email, attempted_at DESC);
CREATE INDEX idx_attempts_ip_time    ON login_attempts(ip_address, attempted_at DESC);

-- ----------------------------------------------------------------------------
-- Schema-version marker (so scripts/migrate.ts can be idempotent)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text         PRIMARY KEY,
  applied_at  timestamptz  NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES ('001_init')
  ON CONFLICT (version) DO NOTHING;
