-- 062_deposit_slice7_s2.sql: Slice 7 Session 2 - deposit auto-release +
-- release/forfeit lifecycle + 2 notification templates.
-- ---------------------------------------------------------------------------
-- POLICY-ONLY + template seeds (no schema/enum change - all deposit columns
-- shipped in 019/055/056). Two guarded UPDATEs, ASCII header, jsonb_typeof
-- guard, additive create-parent merge (existing/customized values always win).
--
-- Q1 (policy home): deposit config now lives under settings.deposit_policy.
-- The consumed auto-release flag MOVES from dispatch_return_policy.
-- auto_release_deposit_on_inspection_pass -> deposit_policy.
-- auto_release_on_inspection_pass. This migration COPIES the legacy value to the
-- new key for existing workspaces; the legacy key is LEFT IN PLACE for one
-- release cycle (deprecation window) and inspections.ts falls back to it when the
-- new key is absent. No behaviour change on deploy - the copy preserves the
-- workspace's existing choice.
-- ---------------------------------------------------------------------------

-- 1. deposit_policy: add the new keys. auto_release_on_inspection_pass is
--    seeded from (existing new key) -> (legacy dispatch_return_policy key) ->
--    false, so a workspace that had auto-release ON keeps it ON. Existing
--    deposit_policy wins (right side of ||) so nothing already set is clobbered.
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{deposit_policy}',
  jsonb_build_object(
    'auto_release_on_inspection_pass', COALESCE(
      settings->'deposit_policy'->'auto_release_on_inspection_pass',
      settings->'dispatch_return_policy'->'auto_release_deposit_on_inspection_pass',
      'false'::jsonb),
    'auto_release_method',    'bank_transfer',
    'settlement_eta_days',    7,
    'forfeit_reason_taxonomy', jsonb_build_array(
      'damage_customer_liable', 'missing_accessories', 'late_return', 'other')
  ) || COALESCE(settings->'deposit_policy', '{}'::jsonb),
  true)
WHERE jsonb_typeof(COALESCE(settings, '{}'::jsonb)) = 'object';

-- 2. Seed the two customer-facing notification templates (053 pattern). Brand-new
--    keys, so the || merge clobbers nothing. Resolver: notify.ts reads
--    templates[eventType].email.{subject,body} with single-brace {var}
--    substitution; {workspace_name} is auto-filled by emitCustomerNotification.
--
--    deposit_released  vars: customer_name, order_number, deposit_amount,
--                            refund_method, settlement_eta_days, workspace_name
--    deposit_forfeited vars: customer_name, order_number, forfeit_amount,
--                            forfeit_reason_display, refund_amount, workspace_name
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{notification_policy}',
  COALESCE(settings->'notification_policy', '{}'::jsonb) || jsonb_build_object(
    'templates',
    COALESCE(settings->'notification_policy'->'templates', '{}'::jsonb) || jsonb_build_object(

      'deposit_released', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Your deposit refund for order #{order_number} has been initiated',
          'body', 'Hi {customer_name},

Good news - your security deposit of Rs. {deposit_amount} for order #{order_number} has been released. The refund has been initiated via {refund_method} and should settle within {settlement_eta_days} days.

Thank you,
{workspace_name}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      ),

      'deposit_forfeited', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Deposit adjustment on your order #{order_number}',
          'body', 'Hi {customer_name},

Regarding the security deposit on order #{order_number}: Rs. {forfeit_amount} has been retained ({forfeit_reason_display}). The remaining Rs. {refund_amount} has been initiated as a refund.

If you have any questions about this adjustment, please reply to this message.

Thank you,
{workspace_name}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      )
    )
  )
)
WHERE jsonb_typeof(COALESCE(settings, '{}'::jsonb)) = 'object';
