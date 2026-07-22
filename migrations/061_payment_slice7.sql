-- 061_payment_slice7.sql: Slice 7 Session 1 payment recording + invoice
-- auto-reconciliation. POLICY-ONLY (no schema/enum change): the payments table
-- already carries kind + method + cheque/custody metadata (055/056), and
-- invoices already has the sent/paid status machine. This seeds two settings
-- blocks: invoice_policy gains auto_mark_paid_on_zero_balance (the reconcile
-- toggle), and a new payment_policy block (correction window + method rules).
-- Transaction-safe (guarded UPDATE only), ASCII-only, no CHECK/enum churn.

-- 1. invoice_policy.auto_mark_paid_on_zero_balance (default true). Merge full
--    invoice defaults so the key lands even on a workspace that predates 060,
--    with existing values winning (right side of ||). Guarded to object settings.
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{invoice_policy}',
  jsonb_build_object(
    'auto_mark_paid_on_zero_balance', true
  ) || COALESCE(settings->'invoice_policy', '{}'::jsonb),
  true)
WHERE jsonb_typeof(COALESCE(settings, '{}'::jsonb)) = 'object';

-- 2. payment_policy defaults. Full-defaults || existing so existing/customized
--    values win and absent keys are filled. methods_enabled mirrors the route's
--    METHODS enum. Reference rules are advisory hints the preview surfaces.
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{payment_policy}',
  jsonb_build_object(
    'correction_window_minutes',        5,
    'methods_enabled',                  jsonb_build_array('upi', 'bank_transfer', 'cash', 'card', 'cheque', 'wallet', 'other'),
    'require_reference_for_upi',         true,
    'require_reference_for_bank_transfer', true,
    'require_cheque_number',             true,
    'require_custody_holder_for_cash',   false
  ) || COALESCE(settings->'payment_policy', '{}'::jsonb),
  true)
WHERE jsonb_typeof(COALESCE(settings, '{}'::jsonb)) = 'object';
