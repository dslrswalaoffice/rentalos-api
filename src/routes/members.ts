import { Hono } from 'hono';
import { sql, query } from '../db.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';

// ============================================================================
// src/routes/members.ts (Sub-turn 10) — mounted at /api/members
// ----------------------------------------------------------------------------
// GET /api/members — who's on the team. Any authenticated member may read it.
// A member is a users row + a workspace_memberships row (role lives on the
// membership). password_hash is NEVER selected.
// ============================================================================

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = { Variables: { session: SessionVar } };

export const members = new Hono<Env>();
members.use('*', sessionMiddleware, requireAuth);

members.get('/', async (c) => {
  const session = c.get('session')!;
  // workspace_role enum is defined owner→manager→staff→client→investor, so
  // ordering by the enum gives owner-first exactly; then by name.
  const rows = await query<{
    id: string; name: string; email: string; role: string; created_at: string;
  }>(sql`
    SELECT u.id, u.display_name AS name, u.email::text AS email,
           m.role::text AS role, m.joined_at AS created_at
    FROM workspace_memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ${session.workspace.id}::uuid
      AND u.deleted_at IS NULL
    ORDER BY m.role ASC, u.display_name ASC
  `);
  return c.json({ members: rows });
});
