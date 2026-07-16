-- 051_seed_substitution_policy_defaults.sql — Sub-slice 2.3: substitution_policy defaults.
-- ---------------------------------------------------------------------------
-- NUMBERING: pack "059" → real 051 (see 046 header).
--
-- Seeds workspaces.settings.substitution_policy with the DSLRSWALA defaults from
-- the handoff pack. Idempotent via COALESCE(settings->'substitution_policy', …):
-- an existing policy is preserved untouched; only workspaces missing the key get
-- the seed. Same create-parent merge pattern as migration 044.
--
-- CONFIGURABILITY (Rule D): reversion_window_hours (24 by default) is read at
-- substitution-create time and frozen into policy_applied_snapshot; changing the
-- setting changes the window for substitutions created AFTER the change.
-- ---------------------------------------------------------------------------

UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{substitution_policy}',
  COALESCE(
    settings->'substitution_policy',
    jsonb_build_object(
      'auto_classify_substitution_type', true,
      'compatibility_check_strict', false,
      'financial_defaults_by_type', jsonb_build_object(
        'same_unit_swap', 'no_change',
        'same_product_swap', 'no_change',
        'equivalent_product_swap', 'no_change',
        'upgrade_free', 'business_absorb',
        'upgrade_paid', 'additional_charge',
        'downgrade_credit', 'credit_to_customer',
        'kit_component_swap', 'no_change'
      ),
      'customer_notification_defaults_by_type', jsonb_build_object(
        'same_unit_swap', false,
        'same_product_swap', false,
        'equivalent_product_swap', true,
        'upgrade_free', true,
        'upgrade_paid', true,
        'downgrade_credit', true,
        'kit_component_swap', true
      ),
      'approval_required', jsonb_build_object(
        'goodwill_upgrade_over_value_paise', 500000,
        'downgrade_credit_over_paise', 250000,
        'cross_category_substitution', true
      ),
      'reversion_window_hours', 24,
      'inherit_approval_from_source_event', true,
      'mid_rental_pricing_default', 'pro_rated_split',
      'auto_flag_original_for_maintenance_when_failed_precheck', true,
      'log_goodwill_spend_to_ledger', true
    )
  ),
  true
)
WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- REVERSE MIGRATION (for reference — do not run automatically):
--   UPDATE workspaces SET settings = settings - 'substitution_policy' WHERE deleted_at IS NULL;
-- ---------------------------------------------------------------------------
