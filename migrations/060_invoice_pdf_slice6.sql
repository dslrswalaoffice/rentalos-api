-- 060_invoice_pdf_slice6.sql: Slice 6 Session 1 GST invoice PDF + delivery.
-- No enum changes (Q10 reuses the existing 'sent' status as "issued"), no new
-- invoice columns (invoices already carries the GST split + snapshot + dormant
-- pdf_url). Adds an invoice_deliveries log + invoice_policy defaults. Transaction-
-- safe (CREATE TABLE/INDEX + guarded UPDATE), ASCII-only, CHECK not enums.

-- 1. invoice_deliveries - one row per channel send attempt for an invoice.
CREATE TABLE IF NOT EXISTS invoice_deliveries (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invoice_id     uuid        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  channel        text        NOT NULL CHECK (channel IN ('whatsapp', 'email', 'sms', 'download')),
  recipient      text        NOT NULL,
  status         text        NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'failed')),
  provider_ref   text,
  failure_reason text,
  sent_at        timestamptz,
  delivered_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_deliveries_invoice ON invoice_deliveries (invoice_id, channel);
CREATE INDEX IF NOT EXISTS idx_invoice_deliveries_ws      ON invoice_deliveries (workspace_id, status);

-- 2. Seed workspaces.settings.invoice_policy defaults. Idempotent create-parent
--    merge: (full defaults || existing) so existing/customized values win; absent
--    keys are filled. Guarded to JSON-object settings only.
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{invoice_policy}',
  jsonb_build_object(
    'auto_close_on_final_inspection_pass', true,
    'auto_generate_on_close',              true,
    'auto_generate_pdf',                   true,
    'auto_send_on_issue',                  true,
    'send_channels_default',               jsonb_build_array('whatsapp', 'email'),
    'due_days_default',                    7,
    'terms_and_conditions',                null,
    'bank_details',                        null,
    'footer_note',                         null
  ) || COALESCE(settings->'invoice_policy', '{}'::jsonb),
  true)
WHERE jsonb_typeof(COALESCE(settings, '{}'::jsonb)) = 'object';
