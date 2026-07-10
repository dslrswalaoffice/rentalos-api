-- ============================================================================
-- Migration 012 — Availability buffer hours
-- ============================================================================
-- Sub-turn 4d-1 adds a reusable availability engine. Rental houses want a
-- configurable prep/cleaning buffer between bookings; it lives in
-- workspace.settings.availability.buffer_hours (default 0, engine clamps 0-24).
--
-- (Numbered 012 — 011 is the workspace-settings migration. Ledger matches on
-- filename.)
--
-- Idempotent: COALESCE preserves an existing `availability` sub-object and only
-- seeds { buffer_hours: 0 } when it's absent. Additive — no other settings keys
-- are touched.
-- ============================================================================

UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{availability}',
  COALESCE(settings->'availability', jsonb_build_object('buffer_hours', 0)),
  true
);
