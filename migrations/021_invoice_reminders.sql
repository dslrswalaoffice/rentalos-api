-- ============================================================================
-- Migration 021 — Multi-channel invoice reminders (WhatsApp + email)
-- ============================================================================
-- Sub-turn 6f. Channel-agnostic reminder scheduler with two first concrete
-- adapters (WATI for WhatsApp, SMTP for email). Every send attempt is logged in
-- invoice_reminders with the channel actually used. Per-workspace channel
-- priority + templates live in settings.reminders.
--
-- NOTE (spec adaptation): the invoices table had no `due_date` column — only
-- `issued_at`. Reminders need a due date, so this migration adds a nullable
-- `due_date` to invoices (additive; invoice generation is untouched). The
-- scheduler computes the effective due date as
-- COALESCE(due_date, issued_at + settings.invoice.default_due_days).
-- ============================================================================

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS due_date date;

CREATE TABLE IF NOT EXISTS invoice_reminders (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invoice_id            uuid        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  order_id              uuid        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  reminder_type         text        NOT NULL CHECK (reminder_type IN ('invoice_upcoming', 'invoice_overdue', 'manual')),

  -- Delivery
  channel               text        NOT NULL CHECK (channel IN ('whatsapp', 'email', 'sms')),
  target_address        text        NOT NULL,   -- phone (E.164) for whatsapp, email otherwise
  subject_snapshot      text,                    -- email only
  body_snapshot         text,                    -- email body OR whatsapp rendered variables summary
  template_name         text,                    -- whatsapp only — WATI/Meta approved template name
  template_variables    jsonb,                   -- whatsapp variables sent to the template

  -- Status
  status                text        NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  provider              text,                    -- 'smtp' | 'wati' | 'noop'
  provider_message_id   text,
  error_message         text,
  skip_reason           text,                    -- when status='skipped': 'no_adapter'/'no_contact'/'cooldown'/…

  -- Trigger
  triggered_by          text        NOT NULL CHECK (triggered_by IN ('cron', 'manual', 'system')),
  triggered_by_user_id  uuid        REFERENCES users(id),

  -- Timing
  scheduled_for         timestamptz,
  sent_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoice_reminders_invoice_idx
  ON invoice_reminders (workspace_id, invoice_id, created_at DESC);

CREATE INDEX IF NOT EXISTS invoice_reminders_type_channel_idx
  ON invoice_reminders (workspace_id, reminder_type, channel, status, sent_at DESC);

-- Seed per-channel reminder settings into every workspace (idempotent).
UPDATE workspaces
SET settings = jsonb_set(
  settings,
  '{reminders}',
  COALESCE(
    settings->'reminders',
    jsonb_build_object(
      'templates', jsonb_build_object(
        'invoice_upcoming', jsonb_build_object(
          'enabled', true,
          'days_before_due', 3,
          'channels', jsonb_build_array('whatsapp', 'email'),
          'whatsapp', jsonb_build_object(
            'template_name', 'invoice_upcoming_reminder',
            'variable_order', jsonb_build_array('customer_name', 'invoice_number', 'total_amount', 'due_date')
          ),
          'email', jsonb_build_object(
            'subject', 'Reminder: Invoice {invoice_number} due on {due_date}',
            'body', 'Dear {customer_name},

This is a friendly reminder that Invoice {invoice_number} for {total_amount} is due on {due_date}.

Order Number: {order_number}
Rental Period: {rental_start} to {rental_end}

Please arrange payment before the due date.

Thank you,
{workspace_name}'
          )
        ),
        'invoice_overdue', jsonb_build_object(
          'enabled', true,
          'days_after_due', 3,
          'repeat_every_days', 7,
          'channels', jsonb_build_array('whatsapp', 'email'),
          'whatsapp', jsonb_build_object(
            'template_name', 'invoice_overdue_reminder',
            'variable_order', jsonb_build_array('customer_name', 'invoice_number', 'total_amount', 'days_overdue')
          ),
          'email', jsonb_build_object(
            'subject', 'OVERDUE: Invoice {invoice_number} — payment required',
            'body', 'Dear {customer_name},

Invoice {invoice_number} for {total_amount} was due on {due_date} and remains unpaid.

Days overdue: {days_overdue}

Please arrange payment immediately.

{workspace_name}'
          )
        )
      ),
      'sender_name', COALESCE(settings->>'business_name', legal_name, 'RentalOS')
    )
  )
);
