-- 067_approval_unification_s1.sql — Approval Engine Unification, Session 1.
-- ---------------------------------------------------------------------------
-- NO schema change. The executor registry (src/lib/approval_executors.ts) drives
-- post-approval execution uniformly; batch resources (asset_bulk_retire) read the
-- frozen request_snapshot, so no new columns are needed.
--
-- This migration only seeds settings (idempotent, COALESCE-guarded so operator
-- edits and prior seeds survive):
--   1. notification_policy.events for the three new internal approval events, so
--      the Slice-10 policy layer knows them (mode 'auto', not marketing).
--   2. approval_routing.approval_requested_notification_enabled (Rule D on/off)
--      and ensures remind_after_hours / auto_expire_hours exist (migration 040
--      seeded them; this backfills any workspace created without them).
-- Additive + idempotent; runs inside the transactional migration runner.
-- ---------------------------------------------------------------------------

-- 1. notification_policy.events — add the three approval events without clobbering
--    existing events (|| merges; COALESCE keeps any operator override per key).
--    Sets the TOP-LEVEL {notification_policy} key (not a nested path) because
--    jsonb_set cannot create a missing intermediate parent — a workspace with no
--    notification_policy yet would otherwise be silently skipped (the exact gotcha
--    migration 065 documented).
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{notification_policy}',
  COALESCE(settings->'notification_policy', '{}'::jsonb) || jsonb_build_object(
    'events',
    COALESCE(settings->'notification_policy'->'events', '{}'::jsonb)
      || jsonb_build_object(
        'approval_requested', COALESCE(settings->'notification_policy'->'events'->'approval_requested', jsonb_build_object('mode','auto','is_marketing',false)),
        'approval_expired',   COALESCE(settings->'notification_policy'->'events'->'approval_expired',   jsonb_build_object('mode','auto','is_marketing',false)),
        'approval_reminder',  COALESCE(settings->'notification_policy'->'events'->'approval_reminder',  jsonb_build_object('mode','auto','is_marketing',false))
      )
  ),
  true
)
WHERE deleted_at IS NULL;

-- 2. approval_routing — feature flag + backfill timing keys (preserve existing).
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{approval_routing}',
  COALESCE(settings->'approval_routing', '{}'::jsonb)
    || jsonb_build_object(
      'approval_requested_notification_enabled',
        COALESCE(settings->'approval_routing'->'approval_requested_notification_enabled', 'true'::jsonb),
      'remind_after_hours',
        COALESCE(settings->'approval_routing'->'remind_after_hours', '24'::jsonb),
      'auto_expire_hours',
        COALESCE(settings->'approval_routing'->'auto_expire_hours', '72'::jsonb)
    ),
  true
)
WHERE deleted_at IS NULL;
