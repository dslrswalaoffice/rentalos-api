import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';
import {
  requirePermission,
  can,
  presetPermissions,
  PERMISSIONS,
  PERMISSION_GROUPS,
  type PermissionKey,
  type WorkspaceRole,
} from '../lib/permissions.js';

// ============================================================================
// src/routes/members.ts (Sub-turn 10 + 12a) — mounted at /api/members
// ----------------------------------------------------------------------------
// GET  /                       team roster (any member; permissions only shown
//                              to a caller who can team.manage)
// PATCH /:userId/permissions   toggle granular permissions       (team.manage)
// PATCH /:userId/status        activate / deactivate a member     (team.manage)
// PATCH /:userId/role          switch role preset (overwrites perms)(team.manage)
// POST  /:userId/make-owner    promote to owner (owner actor only) (team.manage)
//
// A member is a users row + a workspace_memberships row (role + permissions live
// on the membership). password_hash is NEVER selected.
// ============================================================================

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
  permissions?: Record<string, boolean>;
} | null;

type Env = { Variables: { session: SessionVar } };

export const members = new Hono<Env>();
members.use('*', sessionMiddleware, requireAuth);

function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

type MemberRow = {
  user_id: string; name: string; email: string;
  role: string; status: string; permissions: Record<string, boolean>; created_at: string;
};

async function loadMember(workspaceId: string, userId: string): Promise<MemberRow | null> {
  const rows = await query<MemberRow>(sql`
    SELECT u.id AS user_id, u.display_name AS name, u.email::text AS email,
           m.role::text AS role, m.status::text AS status, m.permissions,
           m.joined_at AS created_at
    FROM workspace_memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ${workspaceId}::uuid AND m.user_id = ${userId}::uuid
      AND u.deleted_at IS NULL
    LIMIT 1
  `);
  return rows[0] ?? null;
}

// Count of ACTIVE owners in a workspace — the last-owner protection.
async function activeOwnerCount(workspaceId: string): Promise<number> {
  const rows = await query<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM workspace_memberships
    WHERE workspace_id = ${workspaceId}::uuid AND role = 'owner' AND status = 'active'
  `);
  return Number(rows[0]?.n ?? 0);
}

// ----------------------------------------------------------------------------
// GET / — team roster. Any member may see who's on the team. Permissions +
// status detail are only exposed to a caller who can manage the team (avoids
// leaking who-can-do-what to ordinary staff).
// ----------------------------------------------------------------------------
members.get('/', async (c) => {
  const session = c.get('session')!;
  const canManage = can(session, 'team.manage');
  const rows = await query<MemberRow>(sql`
    SELECT u.id AS user_id, u.display_name AS name, u.email::text AS email,
           m.role::text AS role, m.status::text AS status, m.permissions,
           m.joined_at AS created_at
    FROM workspace_memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ${session.workspace.id}::uuid
      AND u.deleted_at IS NULL
    ORDER BY m.role ASC, u.display_name ASC
  `);
  const membersOut = rows.map((r) => ({
    user_id: r.user_id,
    name: r.name,
    email: r.email,
    role: r.role,
    status: r.status,
    is_self: r.user_id === session.user.id,
    // Only a team manager sees the granular permission map.
    permissions: canManage ? (r.permissions ?? {}) : undefined,
    created_at: r.created_at,
  }));
  return c.json({
    members: membersOut,
    can_manage: canManage,
    is_owner: session.user.role === 'owner',
    // The registry + groups so the Team editor renders labels/sections without
    // hardcoding them client-side.
    registry: PERMISSIONS,
    groups: PERMISSION_GROUPS,
  });
});

// ----------------------------------------------------------------------------
// PATCH /:userId/permissions — merge a partial permission map onto a member.
// Guards: team.manage; owner is immutable; can't edit yourself; can't GRANT a
// permission you don't hold yourself (no escalation); unknown keys rejected.
// ----------------------------------------------------------------------------
const permsSchema = z.object({
  permissions: z.record(z.string(), z.boolean()),
});

members.patch('/:userId/permissions', requirePermission('team.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const targetUserId = c.req.param('userId');

  const body = await c.req.json().catch(() => null);
  const parsed = permsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);

  if (targetUserId === session.user.id) {
    return c.json({ error: 'cannot_edit_own_permissions' }, 403);
  }

  const target = await loadMember(session.workspace.id, targetUserId);
  if (!target) return c.json({ error: 'not_found' }, 404);
  if (target.role === 'owner') {
    return c.json({ error: 'owner_permissions_immutable' }, 403);
  }

  const registryKeys = new Set(Object.keys(PERMISSIONS));
  const incoming = parsed.data.permissions;
  const changes: { key: string; value: boolean }[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (!registryKeys.has(key)) {
      return c.json({ error: 'unknown_permission', key }, 400); // deny by default
    }
    // No escalation: you may only GRANT a permission you hold yourself. Revoking
    // is always allowed. (Owner actor holds everything, so owners grant freely.)
    if (value === true && !can(session, key as PermissionKey)) {
      return c.json({ error: 'cannot_grant_unheld_permission', key }, 403);
    }
    changes.push({ key, value });
  }

  const nextPerms: Record<string, boolean> = { ...(target.permissions ?? {}) };
  for (const ch of changes) {
    if (ch.value) nextPerms[ch.key] = true;
    else delete nextPerms[ch.key]; // absent = denied; keep the map lean
  }

  await sql`
    UPDATE workspace_memberships
       SET permissions = ${JSON.stringify(nextPerms)}::jsonb
     WHERE workspace_id = ${session.workspace.id}::uuid AND user_id = ${targetUserId}::uuid
  `;

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'team.member.permission_changed',
    targetType: 'membership',
    targetId: targetUserId,
    payload: { target_user_id: targetUserId, changes },
    ipAddress, userAgent,
  });

  return c.json({ ok: true, permissions: nextPerms });
});

// ----------------------------------------------------------------------------
// PATCH /:userId/status — activate / deactivate. Deactivated members are
// rejected at the session layer on their next request (getSession requires
// status='active'). Guards: team.manage; can't deactivate yourself; can't
// deactivate the last active owner.
// ----------------------------------------------------------------------------
const statusSchema = z.object({ status: z.enum(['active', 'deactivated']) });

members.patch('/:userId/status', requirePermission('team.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const targetUserId = c.req.param('userId');

  const body = await c.req.json().catch(() => null);
  const parsed = statusSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const nextStatus = parsed.data.status;

  const target = await loadMember(session.workspace.id, targetUserId);
  if (!target) return c.json({ error: 'not_found' }, 404);

  if (nextStatus === 'deactivated') {
    if (targetUserId === session.user.id) {
      return c.json({ error: 'cannot_deactivate_self' }, 403);
    }
    if (target.role === 'owner' && (await activeOwnerCount(session.workspace.id)) <= 1) {
      return c.json({ error: 'cannot_deactivate_last_owner' }, 409);
    }
  }
  if (nextStatus === target.status) return c.json({ ok: true, status: nextStatus, unchanged: true });

  await sql`
    UPDATE workspace_memberships
       SET status = ${nextStatus}::membership_status
     WHERE workspace_id = ${session.workspace.id}::uuid AND user_id = ${targetUserId}::uuid
  `;
  // Deactivation → kill their live sessions so the change bites immediately, not
  // just on natural expiry.
  if (nextStatus === 'deactivated') {
    await sql`
      UPDATE sessions SET revoked_at = now()
      WHERE user_id = ${targetUserId}::uuid AND workspace_id = ${session.workspace.id}::uuid
        AND revoked_at IS NULL
    `.catch(() => {});
  }

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'team.member.status_changed',
    targetType: 'membership',
    targetId: targetUserId,
    payload: { target_user_id: targetUserId, from: target.status, to: nextStatus },
    ipAddress, userAgent,
  });

  return c.json({ ok: true, status: nextStatus });
});

// ----------------------------------------------------------------------------
// PATCH /:userId/role — switch a member's role preset. OVERWRITES their custom
// permissions with the preset (the UI confirms this first). manager|staff only;
// owner is set/removed via make-owner, never here. Guards: team.manage; can't
// change your own role; can't demote an owner through this route.
// ----------------------------------------------------------------------------
const roleSchema = z.object({ role: z.enum(['manager', 'staff']) });

members.patch('/:userId/role', requirePermission('team.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const targetUserId = c.req.param('userId');

  const body = await c.req.json().catch(() => null);
  const parsed = roleSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const nextRole = parsed.data.role as WorkspaceRole;

  if (targetUserId === session.user.id) return c.json({ error: 'cannot_change_own_role' }, 403);

  const target = await loadMember(session.workspace.id, targetUserId);
  if (!target) return c.json({ error: 'not_found' }, 404);
  if (target.role === 'owner') return c.json({ error: 'cannot_demote_owner' }, 403);

  const nextPerms = presetPermissions(nextRole);
  await sql`
    UPDATE workspace_memberships
       SET role = ${nextRole}::workspace_role,
           permissions = ${JSON.stringify(nextPerms)}::jsonb
     WHERE workspace_id = ${session.workspace.id}::uuid AND user_id = ${targetUserId}::uuid
  `;

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'team.member.role_changed',
    targetType: 'membership',
    targetId: targetUserId,
    payload: { target_user_id: targetUserId, from: target.role, to: nextRole, permissions_reset: true },
    ipAddress, userAgent,
  });

  return c.json({ ok: true, role: nextRole, permissions: nextPerms });
});

// ----------------------------------------------------------------------------
// POST /:userId/make-owner — promote to owner. Sensitive: ONLY an owner may do
// it (team.manage alone isn't enough). Multiple owners are allowed; the actor
// keeps their own owner status (they lose exclusivity, per spec). Owner perms
// are code-enforced, so we store {}.
// ----------------------------------------------------------------------------
members.post('/:userId/make-owner', requirePermission('team.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const targetUserId = c.req.param('userId');

  if (session.user.role !== 'owner') return c.json({ error: 'only_owner_can_make_owner' }, 403);

  const target = await loadMember(session.workspace.id, targetUserId);
  if (!target) return c.json({ error: 'not_found' }, 404);
  if (target.role === 'owner') return c.json({ ok: true, role: 'owner', unchanged: true });
  if (target.status !== 'active') return c.json({ error: 'member_not_active' }, 409);

  await sql`
    UPDATE workspace_memberships
       SET role = 'owner'::workspace_role, permissions = '{}'::jsonb
     WHERE workspace_id = ${session.workspace.id}::uuid AND user_id = ${targetUserId}::uuid
  `;

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'team.member.made_owner',
    targetType: 'membership',
    targetId: targetUserId,
    payload: { target_user_id: targetUserId, from: target.role },
    ipAddress, userAgent,
  });

  return c.json({ ok: true, role: 'owner' });
});
