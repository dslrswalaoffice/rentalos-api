-- 053_seed_damage_and_substitution_notification_templates.sql — Sub-slice 2.3.
-- ---------------------------------------------------------------------------
-- NUMBERING: pack "061" → real 053 (see 046 header).
--
-- Seeds the 7 Sub-slice 2.3 notification templates into
-- settings.notification_policy.templates via the create-parent merge pattern
-- (migration 044). These are BRAND-NEW keys, so the `||` merge clobbers nothing.
-- Resolver: src/lib/notify.ts reads templates[eventType].email.{subject,body}
-- and does SINGLE-BRACE {var} substitution (unknown {tokens} are left literal so
-- typos are visible). {workspace_name} is auto-filled by emitCustomerNotification
-- from the workspace row — templates reference it but the emit sites do NOT pass it.
--
-- Customer-facing (email + whatsapp shape):
--   damage_incident_reported, damage_incident_customer_acknowledgment_required,
--   damage_incident_financial_resolution_proposed, damage_incident_closed,
--   substitution_executed, substitution_reverted
-- Internal approver (email only; whatsapp null — approvers get in-product + email):
--   substitution_pending_approval
--
-- Merge variables are the REAL emit-site variables (Rule C asserts no {token}
-- survives when all are supplied):
--   damage_incident_reported: customer_name, incident_number, order_number,
--     item_summary, severity, workspace_name
--   ..._acknowledgment_required: customer_name, incident_number, order_number,
--     liability_summary, acknowledgment_url, workspace_name
--   ..._financial_resolution_proposed: customer_name, incident_number,
--     order_number, resolution_summary, amount, workspace_name
--   ..._closed: customer_name, incident_number, order_number, workspace_name
--   substitution_executed: customer_name, order_number, substitution_number,
--     original_item, replacement_item, workspace_name
--   substitution_reverted: customer_name, order_number, substitution_number,
--     original_item, workspace_name
--   substitution_pending_approval: order_number, substitution_number, actor_name,
--     original_item, replacement_item
-- ---------------------------------------------------------------------------

UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{notification_policy}',
  COALESCE(settings->'notification_policy', '{}'::jsonb) || jsonb_build_object(
    'templates',
    COALESCE(settings->'notification_policy'->'templates', '{}'::jsonb) || jsonb_build_object(

      'damage_incident_reported', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'We''ve logged a damage report on your order #{order_number} ({incident_number})',
          'body', 'Hi {customer_name},

We''ve recorded a damage report ({incident_number}) for {item_summary} on your order #{order_number}. Reported severity: {severity}. Our team is reviewing it and will be in touch with next steps.

Thank you,
{workspace_name}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      ),

      'damage_incident_customer_acknowledgment_required', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Action needed: acknowledge damage {incident_number} on order #{order_number}',
          'body', 'Hi {customer_name},

Regarding damage report {incident_number} on order #{order_number}: {liability_summary}

Please review and acknowledge here: {acknowledgment_url}

Thank you,
{workspace_name}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      ),

      'damage_incident_financial_resolution_proposed', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Proposed resolution for damage {incident_number} — order #{order_number}',
          'body', 'Hi {customer_name},

We''ve proposed a resolution for damage report {incident_number} on order #{order_number}: {resolution_summary} Amount: {amount}.

Reply to this email if you have any questions.

Thank you,
{workspace_name}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      ),

      'damage_incident_closed', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Damage report {incident_number} is now closed — order #{order_number}',
          'body', 'Hi {customer_name},

Damage report {incident_number} on order #{order_number} has been resolved and closed. Thank you for your cooperation.

{workspace_name}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      ),

      'substitution_executed', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'An item on your order #{order_number} has been swapped ({substitution_number})',
          'body', 'Hi {customer_name},

We''ve swapped {original_item} for {replacement_item} on your order #{order_number} (reference {substitution_number}). Everything else stays the same — let us know if you have any questions.

Thank you,
{workspace_name}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      ),

      'substitution_reverted', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Update to your order #{order_number}: swap reverted ({substitution_number})',
          'body', 'Hi {customer_name},

The earlier swap {substitution_number} on your order #{order_number} has been reverted — {original_item} is back on your order. Sorry for any confusion.

Thank you,
{workspace_name}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      ),

      'substitution_pending_approval', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Substitution {substitution_number} needs approval — order #{order_number}',
          'body', 'Substitution {substitution_number} on order #{order_number} needs approval: {original_item} → {replacement_item}. Requested by {actor_name}. Review it in RentalOS to approve or reject.'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      )

    )
  ),
  true
)
WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- REVERSE MIGRATION (for reference — do not run automatically):
--   Remove the 7 keys from settings.notification_policy.templates. Left manual
--   since a workspace may have edited them post-seed.
-- ---------------------------------------------------------------------------
