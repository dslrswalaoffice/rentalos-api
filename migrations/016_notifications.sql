-- ============================================================================
-- Migration 016 — Notifications infrastructure
-- ============================================================================
-- Sub-turn 5d: in-product notifications + delivery scaffold. Events fire for
-- OTHER users (the actor never notifies themselves). Delivery adapters
-- (WhatsApp/email/SMS) land later — their channels stay 'skipped' for now, and
-- notification_deliveries records the in_product channel so the table is wired.
-- Templates are hardcoded in src/lib/notify.ts; notification_templates exists
-- for future per-workspace overrides but is unseeded here.
-- ============================================================================

CREATE TABLE IF NOT EXISTS notifications (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient_user_id uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id     uuid        REFERENCES users(id) ON DELETE SET NULL,
  event_type        text        NOT NULL,
  target_type       text,
  target_id         uuid,
  title             text        NOT NULL,
  body              text,
  link_url          text,
  metadata          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  read_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_recipient_idx
  ON notifications (workspace_id, recipient_user_id, read_at NULLS FIRST, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_recent_unread_idx
  ON notifications (workspace_id, recipient_user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  notification_id  uuid        REFERENCES notifications(id) ON DELETE CASCADE,
  channel          text        NOT NULL CHECK (channel IN ('in_product', 'whatsapp', 'email', 'sms')),
  status           text        NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  target_user_id   uuid        REFERENCES users(id),
  target_person_id uuid        REFERENCES people(id),
  target_address   text,
  payload_snapshot jsonb       NOT NULL,
  error_message    text,
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_deliveries_status_idx
  ON notification_deliveries (workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_templates (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type     text        NOT NULL,
  channel        text        NOT NULL CHECK (channel IN ('in_product', 'whatsapp', 'email', 'sms')),
  title_template text        NOT NULL,
  body_template  text,
  is_enabled     boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, event_type, channel)
);
