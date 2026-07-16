-- 052_seed_damage_policy_defaults.sql — Sub-slice 2.3: damage_policy defaults.
-- ---------------------------------------------------------------------------
-- NUMBERING: pack "060" → real 052 (see 046 header).
--
-- Seeds workspaces.settings.damage_policy with the DSLRSWALA defaults from the
-- handoff pack. Idempotent (COALESCE preserves an existing policy). Create-parent
-- merge pattern as migration 044.
--
-- KEY POLICY DRIVERS (read by the M2 backend):
--   * auto_customer_liability_by_type — the incident_type → liability map applied
--     at report time (frozen into policy_applied_snapshot).
--   * approval_required.* — the thresholds that flip requires_approval TRUE:
--     severity ≥ major, cost > ₹15k (1500000 paise), insurance claim > ₹50k
--     (5000000 paise), customer disputed, deposit forfeit > 50%.
--   (No min_photos policy — photos are out of scope for 2.3, Aamir Q1.)
-- ---------------------------------------------------------------------------

UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{damage_policy}',
  COALESCE(
    settings->'damage_policy',
    jsonb_build_object(
      'auto_customer_liability_by_type', jsonb_build_object(
        'accidental_drop', 'yes',
        'impact_damage', 'yes',
        'liquid_damage', 'yes',
        'electrical_damage', 'pending_investigation',
        'operational_failure', 'no',
        'theft', 'yes',
        'loss', 'yes',
        'third_party_damage', 'partial',
        'weather', 'partial',
        'misuse', 'yes',
        'wear_and_tear_dispute', 'no',
        'other', 'pending_investigation'
      ),
      'approval_required', jsonb_build_object(
        'severity_major_or_higher', true,
        'cost_over_paise', 1500000,
        'insurance_claim_over_paise', 5000000,
        'customer_disputed', true,
        'deposit_forfeit_over_percent', 50
      ),
      'auto_offer_substitution_when_available', true,
      'auto_prorate_on_early_return_of_damaged_item', true,
      'notify_owner_severity_threshold', 'major',
      'customer_notification_default', true,
      'insurance_provider_config', jsonb_build_object(
        'enabled', false,
        'provider', null,
        'policy_number', null
      ),
      'grace_period_for_financial_settlement_days', 7,
      'require_customer_signature_on_liability_acceptance', true,
      'allow_customer_incident_reporting_via_portal', false
    )
  ),
  true
)
WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- REVERSE MIGRATION (for reference — do not run automatically):
--   UPDATE workspaces SET settings = settings - 'damage_policy' WHERE deleted_at IS NULL;
-- ---------------------------------------------------------------------------
