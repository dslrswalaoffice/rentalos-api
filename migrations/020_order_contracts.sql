-- ============================================================================
-- Migration 020 — Contract signatures at dispatch
-- ============================================================================
-- Sub-turn 6e. On-screen rental-agreement capture at dispatch. One immutable
-- contract record per dispatch batch (when the `contract_signatures` feature
-- flag is on). Contract text is rendered from the workspace template and frozen
-- at signing time — later template edits never alter old contracts (same
-- snapshot discipline as invoices). Signature is a base64 PNG in the row (no
-- blob storage yet). Signature is optional: an unsigned record is still written
-- for the audit trail when the operator dispatches without a signature.
-- ============================================================================

CREATE TABLE IF NOT EXISTS order_contracts (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id              uuid        NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  dispatch_event_id     uuid,       -- soft link to the order_events batch row; null for legacy imports

  contract_text_snapshot text      NOT NULL,   -- rendered from the template at signing time
  template_version      text,                   -- optional label, e.g. 'v1'

  signature_png         text,                   -- base64-encoded PNG; null when unsigned
  signer_name           text,
  signer_role           text        CHECK (signer_role IS NULL OR signer_role IN ('customer', 'representative', 'unsigned')),
  signed_at             timestamptz,
  ip_address            inet,
  user_agent            text,
  witness_user_id       uuid        REFERENCES users(id),

  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_contracts_order_idx
  ON order_contracts (workspace_id, order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS order_contracts_dispatch_idx
  ON order_contracts (workspace_id, dispatch_event_id)
  WHERE dispatch_event_id IS NOT NULL;

-- Seed a default contract template into every existing workspace that doesn't
-- already have one. Idempotent (COALESCE keeps any existing settings->'contract').
UPDATE workspaces
SET settings = jsonb_set(
  settings,
  '{contract}',
  COALESCE(
    settings->'contract',
    jsonb_build_object(
      'template_text', 'RENTAL AGREEMENT

This agreement is between {workspace_name} and {customer_name} (Phone: {customer_phone}) for the rental of equipment described below.

Order Number: {order_number}
Rental Period: {rental_start} to {rental_end}

Items:
{items_list}

Total Amount: {total_amount}
Refundable Deposit: {deposit_required}

TERMS AND CONDITIONS:
1. The customer accepts responsibility for the equipment listed above from the time of pickup until returned.
2. The customer agrees to return all equipment in the same condition it was received, subject to normal wear.
3. Any damage, loss, or theft during the rental period is the customer''s responsibility and may result in forfeiture of the deposit or additional charges.
4. Late returns are subject to additional daily rental charges.
5. The customer confirms they have inspected the equipment and found it in good working condition.

By signing below, the customer acknowledges receipt of the equipment and agrees to these terms.',
      'template_version', 'v1'
    )
  )
);
