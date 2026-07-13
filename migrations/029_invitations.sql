-- 029_invitations.sql — Sub-turn 10: team invitations (kills ADMIN_SETUP_TOKEN)
-- ---------------------------------------------------------------------------
-- Invite by email → tokenized link → accept page → user joins the workspace.
-- Token pattern mirrors sessions: 32 random bytes, SHA-256 hashed at rest.
--
-- Schema-reality notes (see PR body):
--   * The inviter is a logged-in USER, so invited_by_user_id references
--     users(id) — NOT people(id). people is the customer table; a team member
--     is a user + a workspace_memberships row, never a person.
--   * role is TEXT here with a CHECK that deliberately EXCLUDES 'owner'
--     (defense in depth — the DB refuses an owner invite even if app code is
--     bypassed). On accept, the role is cast to the workspace_role enum for
--     the membership row.

CREATE TABLE invitations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email                TEXT NOT NULL,
  role                 TEXT NOT NULL,
  token_hash           TEXT NOT NULL,
  invited_by_user_id   UUID NOT NULL REFERENCES users(id),
  expires_at           TIMESTAMPTZ NOT NULL,
  accepted_at          TIMESTAMPTZ,
  revoked_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invitations_role_valid
    CHECK (role IN ('manager', 'staff', 'client', 'investor'))
);

-- Token lookup on accept/verify — the hot path.
CREATE UNIQUE INDEX invitations_token_hash_idx ON invitations (token_hash);

-- Pending-invite list per workspace.
CREATE INDEX invitations_workspace_pending_idx
  ON invitations (workspace_id, created_at DESC)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- One LIVE invite per email per workspace (case-insensitive). Re-inviting a
-- pending email violates this — the route surfaces it as a clean 409, not 500.
CREATE UNIQUE INDEX invitations_one_live_per_email_idx
  ON invitations (workspace_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
