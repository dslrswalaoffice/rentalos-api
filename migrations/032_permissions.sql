-- 032_permissions.sql — Sub-turn 12a: roles + granular per-member permissions
-- ---------------------------------------------------------------------------
-- SECURITY: closes the ungated order mutations found in MODULE_AUDIT.md. Also
-- collapses the role set to owner|manager|staff (client/investor removed — they
-- get separate portals later, never workspace memberships) and adds a per-member
-- permissions JSONB (Booqable's model: role is a preset, permission is the
-- truth). Owners are code-enforced (can()), so they get {} here.

-- ---------------------------------------------------------------------------
-- 0. Fail-loud guard. Aamir confirmed no client/investor memberships exist; this
--    is the backstop. If any are found the whole migration aborts (deploy fails
--    loudly) rather than silently corrupting — remove them and re-run.
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM workspace_memberships WHERE role::text IN ('client', 'investor');
  IF n > 0 THEN
    RAISE EXCEPTION 'Cannot collapse workspace_role: % client/investor membership(s) exist. Remove them first — these roles get separate portals, not workspace memberships.', n;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Membership status gains 'deactivated' (enum already exists as
--    active|invited|suspended). Deactivated members are already rejected at the
--    session layer (getSession filters m.status = 'active'), so no per-request
--    status check is needed — deactivation kills the next request.
-- ---------------------------------------------------------------------------
ALTER TYPE membership_status ADD VALUE IF NOT EXISTS 'deactivated';

-- ---------------------------------------------------------------------------
-- 2. Collapse the role enum. Postgres can't drop enum values, so recreate.
--    invitations.role is TEXT (not this enum), so only workspace_memberships.role
--    depends on it. Guard above guarantees every value casts cleanly.
-- ---------------------------------------------------------------------------
ALTER TYPE workspace_role RENAME TO workspace_role_old;
CREATE TYPE workspace_role AS ENUM ('owner', 'manager', 'staff');
ALTER TABLE workspace_memberships
  ALTER COLUMN role TYPE workspace_role USING role::text::workspace_role;
DROP TYPE workspace_role_old;

-- ---------------------------------------------------------------------------
-- 3. Per-member permissions. Deny by default: absent key = denied. Loaded on the
--    session query (zero extra round trips).
-- ---------------------------------------------------------------------------
ALTER TABLE workspace_memberships
  ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- 4. Backfill existing members from their role preset. Owners keep {} (their
--    access is code-enforced, never stored). Keep these literals in sync with
--    PRESETS in src/lib/permissions.ts.
-- ---------------------------------------------------------------------------
UPDATE workspace_memberships SET permissions = '{
  "orders.view":true,"orders.create":true,"orders.edit":true,"orders.cancel":true,
  "orders.revert_status":true,"orders.override_period":true,"orders.override_price":true,
  "orders.apply_discount":true,"dispatch.execute":true,"returns.execute":true,
  "damage.record":true,"payments.record":true,"payments.refund":true,"deposits.retain":true,
  "invoices.manage":true,"inventory.view":true,"inventory.manage":true,"inventory.pricing":true,
  "people.view":true,"people.manage":true,"people.view_sensitive":true,"reports.view":true,
  "reports.export":true
}'::jsonb
WHERE role = 'manager';

UPDATE workspace_memberships SET permissions = '{
  "orders.view":true,"orders.create":true,"orders.edit":true,"dispatch.execute":true,
  "returns.execute":true,"damage.record":true,"inventory.view":true,"people.view":true
}'::jsonb
WHERE role = 'staff';

UPDATE workspace_memberships SET permissions = '{}'::jsonb WHERE role = 'owner';

-- ---------------------------------------------------------------------------
-- 5. Invitations may now only be for manager|staff. Defense in depth: app code
--    can be bypassed, a CHECK cannot. (owner was already excluded in 029.)
-- ---------------------------------------------------------------------------
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_role_valid;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_valid
  CHECK (role IN ('manager', 'staff'));

COMMENT ON COLUMN workspace_memberships.permissions IS
  'Per-member granular permissions (Sub-turn 12a). JSONB { "<key>": true }. Deny by default. Owners store {} — their access is code-enforced in can(). Key registry lives in src/lib/permissions.ts.';
