-- ===========================================================================
-- 069_late_fee_slice.sql -- Phase 1 completion Session 1: late-return fee.
-- ---------------------------------------------------------------------------
-- Late fees were structurally shipped already: order_item_type has 'late_fee'
-- (004), the pricing engine folds it into subtotal + tax + total (SUBTOTAL_TYPES
-- / TAXABLE_ITEM_TYPES), Slice 6 renders it on the invoice, and Slice 7
-- reconciles it. What was missing was (a) a CALCULATION POLICY and (b) a
-- CUSTOMER NOTIFICATION event. This migration seeds both -- no schema change.
--
-- Three idempotent, COALESCE-guarded settings merges (never clobber operator
-- edits). Each uses the TOP-LEVEL jsonb_set target so a workspace with no
-- dispatch_return_policy / notification_policy yet is NOT silently skipped
-- (jsonb_set cannot create a missing intermediate parent -- the 065/067 gotcha).
--
--   1. settings.dispatch_return_policy.late_return_fee_per_hour_percent = 10
--      (percentage of the daily rate charged per hour late, beyond the existing
--      late_return_fee_grace_hours free window). grace_hours (seeded by 059) is
--      preserved via COALESCE.
--   2. settings.notification_policy.events['order.late_fee_applied']
--      = { mode:'auto', is_marketing:false }.
--   3. settings.notification_policy.templates['order.late_fee_applied']
--      = { email:{subject,body}, whatsapp:{template_name:null, variable_order:null} }.
--      WhatsApp seeds NULL (the 043 convention) -- the operator supplies their
--      own Meta-approved template name; until then WhatsApp gracefully skips and
--      email carries the notification.
--
-- Additive + idempotent. Runs inside the transactional migration runner.
-- ===========================================================================

-- 1. Calculation policy: per-hour percent of daily rate (grace preserved).
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{dispatch_return_policy}',
  COALESCE(settings->'dispatch_return_policy', '{}'::jsonb) || jsonb_build_object(
    'late_return_fee_per_hour_percent',
      COALESCE(settings->'dispatch_return_policy'->'late_return_fee_per_hour_percent', '10'::jsonb),
    'late_return_fee_grace_hours',
      COALESCE(settings->'dispatch_return_policy'->'late_return_fee_grace_hours', '2'::jsonb)
  ),
  true
)
WHERE deleted_at IS NULL
  AND (settings->'dispatch_return_policy' IS NULL
       OR jsonb_typeof(settings->'dispatch_return_policy') = 'object');

-- 2. Notification event: order.late_fee_applied (auto, transactional).
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{notification_policy}',
  COALESCE(settings->'notification_policy', '{}'::jsonb) || jsonb_build_object(
    'events',
    COALESCE(settings->'notification_policy'->'events', '{}'::jsonb) || jsonb_build_object(
      'order.late_fee_applied',
        COALESCE(settings->'notification_policy'->'events'->'order.late_fee_applied',
                 jsonb_build_object('mode', 'auto', 'is_marketing', false))
    )
  ),
  true
)
WHERE deleted_at IS NULL
  AND (settings->'notification_policy' IS NULL
       OR jsonb_typeof(settings->'notification_policy') = 'object');

-- 3. Notification template: email subject/body + null WhatsApp (043 convention).
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{notification_policy}',
  COALESCE(settings->'notification_policy', '{}'::jsonb) || jsonb_build_object(
    'templates',
    COALESCE(settings->'notification_policy'->'templates', '{}'::jsonb) || jsonb_build_object(
      'order.late_fee_applied',
        COALESCE(settings->'notification_policy'->'templates'->'order.late_fee_applied',
          jsonb_build_object(
            'email', jsonb_build_object(
              'subject', 'Late return fee added to order #{order_number}',
              'body', 'Hi {customer_name},

A late return fee of {amount} has been added to your order #{order_number}. The equipment was returned {hours_late} hour(s) after the scheduled return time.

Reason: {reason}

This charge appears on your next invoice. Please reach out if you have any questions.

Thank you.'
            ),
            'whatsapp', jsonb_build_object('template_name', NULL, 'variable_order', NULL)
          ))
    )
  ),
  true
)
WHERE deleted_at IS NULL
  AND (settings->'notification_policy' IS NULL
       OR jsonb_typeof(settings->'notification_policy') = 'object');
