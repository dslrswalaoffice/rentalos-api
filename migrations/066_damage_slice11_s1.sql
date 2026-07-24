-- 066_damage_slice11_s1.sql -- Slice 11 Session 1: damage integration seams.
-- ---------------------------------------------------------------------------
-- Wires the dormant seams of the Sub-slice 2.3 damage module. No new tables --
-- damage_incidents / _assets / _events are fully built. Three additive changes:
--
--   1. damage_policy gains two toggles (Q1, Q3): auto_create_from_inspection and
--      auto_execute_deposit_forfeit, both default true. COALESCE-guarded so an
--      operator's existing damage_policy is preserved (only the two new keys are
--      merged in when the policy object already exists).
--
--   2. Fixes the Slice-10 notification event-key mismatch (Q6). Migration 065
--      seeded `damage_reported` (auto_with_review) but no code emits that key --
--      the damage module emits `damage_incident_*`. Rename the orphan to
--      damage_incident_reported and add the three sibling events so the intended
--      auto_with_review actually applies. Existing (correct) keys are preserved.
--
--   3. damage_incidents gains deposit_forfeit_payment_id (FK -> payments) so an
--      auto-executed forfeit links back to the payment it created. The column is
--      100% NULL on every existing row, so the FK validates trivially.
--
-- Additive + idempotent. Runs inside the transactional migration runner.
-- ---------------------------------------------------------------------------

-- 1. damage_policy toggles (merge the two new keys onto an existing policy;
--    seed the whole object if a workspace somehow has none).
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{damage_policy}',
  COALESCE(settings->'damage_policy', '{}'::jsonb) || jsonb_build_object(
    'auto_create_from_inspection',
      COALESCE(settings->'damage_policy'->'auto_create_from_inspection', 'true'::jsonb),
    'auto_execute_deposit_forfeit',
      COALESCE(settings->'damage_policy'->'auto_execute_deposit_forfeit', 'true'::jsonb)
  ),
  true
)
WHERE deleted_at IS NULL
  AND (settings IS NULL OR jsonb_typeof(settings) = 'object');

-- 2a. Drop the orphaned Slice-10 `damage_reported` event key (no emitter uses it).
UPDATE workspaces
SET settings = settings #- '{notification_policy,events,damage_reported}'
WHERE deleted_at IS NULL
  AND jsonb_typeof(settings) = 'object'
  AND settings #> '{notification_policy,events,damage_reported}' IS NOT NULL;

-- 2b. Add the four real damage-incident event modes (aligned with the emit keys).
--     Only sets a key when ABSENT so operator edits survive a redeploy. Requires
--     notification_policy.events to exist (seeded for every workspace by 065).
UPDATE workspaces
SET settings = jsonb_set(
  settings,
  '{notification_policy,events}',
  COALESCE(settings #> '{notification_policy,events}', '{}'::jsonb) || jsonb_build_object(
    'damage_incident_reported',
      COALESCE(settings #> '{notification_policy,events,damage_incident_reported}',
               jsonb_build_object('mode', 'auto_with_review', 'is_marketing', false)),
    'damage_incident_financial_resolution_proposed',
      COALESCE(settings #> '{notification_policy,events,damage_incident_financial_resolution_proposed}',
               jsonb_build_object('mode', 'auto_with_review', 'is_marketing', false)),
    'damage_incident_customer_acknowledgment_required',
      COALESCE(settings #> '{notification_policy,events,damage_incident_customer_acknowledgment_required}',
               jsonb_build_object('mode', 'auto_with_review', 'is_marketing', false)),
    'damage_incident_closed',
      COALESCE(settings #> '{notification_policy,events,damage_incident_closed}',
               jsonb_build_object('mode', 'auto', 'is_marketing', false))
  ),
  true
)
WHERE deleted_at IS NULL
  AND jsonb_typeof(settings) = 'object'
  AND settings #> '{notification_policy,events}' IS NOT NULL;

-- 3. Link an auto-executed deposit forfeit back to its payment.
ALTER TABLE damage_incidents
  ADD COLUMN IF NOT EXISTS deposit_forfeit_payment_id uuid REFERENCES payments(id);
