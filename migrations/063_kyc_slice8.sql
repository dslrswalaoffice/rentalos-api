-- 063_kyc_slice8.sql: Slice 8 Session 1 - KYC review workflow.
-- ---------------------------------------------------------------------------
-- Greenfield KYC on mature rails. Adds a kyc_documents table (multi-doc, multi-
-- file lifecycle) + denormalised rollup columns on people (kyc_status derived
-- from the documents, same pattern as orders.deposit_status). Plus a
-- settings.kyc_policy block + 2 customer notification templates.
--
-- Transaction-safe: text/jsonb/uuid/timestamptz columns with CHECK constraints
-- (NOT native enums), CREATE TABLE/INDEX, guarded UPDATEs. No ALTER TYPE, nothing
-- transaction-hostile. New columns carry defaults that satisfy their CHECK, so
-- no existing row can violate them (no pre-ADD data fix needed). ASCII-only.
-- ---------------------------------------------------------------------------

-- 1. people - denormalised KYC rollup (recomputed from kyc_documents).
ALTER TABLE people
  ADD COLUMN IF NOT EXISTS kyc_status text NOT NULL DEFAULT 'not_started'
    CHECK (kyc_status IN ('not_started','pending','verified','rejected','expired')),
  ADD COLUMN IF NOT EXISTS kyc_verified_by_user_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS kyc_verified_at    timestamptz,
  ADD COLUMN IF NOT EXISTS kyc_rejection_reason text,
  ADD COLUMN IF NOT EXISTS kyc_rejection_notes  text,
  ADD COLUMN IF NOT EXISTS kyc_last_reviewed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_people_workspace_kyc_status
  ON people (workspace_id, kyc_status) WHERE deleted_at IS NULL;

-- 2. kyc_documents - one row per submitted document (multi-file via files jsonb).
CREATE TABLE IF NOT EXISTS kyc_documents (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id           uuid        NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  document_type       text        NOT NULL CHECK (document_type IN
    ('aadhaar','pan','driving_license','passport','gst_certificate','other')),
  document_number     text,
  files               jsonb       NOT NULL DEFAULT '[]'::jsonb,   -- [{url,mime_type,filename,size_bytes,uploaded_at}]
  status              text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  verified_by_user_id uuid        REFERENCES users(id),
  verified_at         timestamptz,
  rejection_reason    text        CHECK (rejection_reason IS NULL OR rejection_reason IN
    ('unclear_image','document_expired','name_mismatch','suspected_fraud','wrong_document_type','other')),
  rejection_notes     text,
  submitted_by_user_id uuid       REFERENCES users(id),
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kyc_documents_queue  ON kyc_documents (workspace_id, status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_kyc_documents_person ON kyc_documents (person_id);

CREATE TRIGGER kyc_documents_bump_updated_at BEFORE UPDATE ON kyc_documents
  FOR EACH ROW EXECUTE FUNCTION bump_updated_at();

-- 3. Seed settings.kyc_policy (create-parent merge, ONLY when absent - a redeploy
--    never clobbers an operator's Settings edits). Guarded to object settings.
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{kyc_policy}',
  COALESCE(
    settings->'kyc_policy',
    jsonb_build_object(
      'gate_on_dispatch',   true,
      'required_documents', jsonb_build_object(
        'individual', jsonb_build_array('aadhaar', 'pan'),
        'b2b',        jsonb_build_array('gst_certificate')
      ),
      'auto_expire_after_days', 365,
      'rejection_reasons_enabled', jsonb_build_array(
        'unclear_image', 'document_expired', 'name_mismatch',
        'suspected_fraud', 'wrong_document_type', 'other'),
      'notify_customer_on_status_change', true
    )
  ),
  true)
WHERE jsonb_typeof(COALESCE(settings, '{}'::jsonb)) = 'object';

-- 4. Seed the two customer-facing notification templates (053/062 pattern).
--    Brand-new keys, so the || merge clobbers nothing. Resolver reads
--    templates[eventType].email.{subject,body}; {workspace_name} auto-filled.
--    kyc_approved  vars: customer_name, workspace_name, support_phone
--    kyc_rejected  vars: customer_name, workspace_name, rejection_reason_display, support_phone
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{notification_policy}',
  COALESCE(settings->'notification_policy', '{}'::jsonb) || jsonb_build_object(
    'templates',
    COALESCE(settings->'notification_policy'->'templates', '{}'::jsonb) || jsonb_build_object(

      'kyc_approved', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Your KYC verification for {workspace_name} is complete',
          'body', 'Hi {customer_name},

Good news - your KYC verification for {workspace_name} is complete. You are all set to rent with us.

Thank you,
{workspace_name}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      ),

      'kyc_rejected', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Action needed on your KYC verification for {workspace_name}',
          'body', 'Hi {customer_name},

Your KYC verification for {workspace_name} needs attention: {rejection_reason_display}.

Please re-submit the document or contact us at {support_phone}.

Thank you,
{workspace_name}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      )
    )
  )
)
WHERE jsonb_typeof(COALESCE(settings, '{}'::jsonb)) = 'object';
