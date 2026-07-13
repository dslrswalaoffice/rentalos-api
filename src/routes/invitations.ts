import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import { generateToken, hashToken } from '../lib/tokens.js';
import { hashPassword, verifyPassword, validatePasswordPolicy } from '../lib/password.js';
import { buildInviteEmail } from '../lib/email.js';
import { decryptJson } from '../lib/crypto.js';
import { findAdapter } from '../lib/adapters/registry.js';
import type { EmailAdapter } from '../lib/adapters/types.js';
import {
  sessionMiddleware,
  requireAuth,
  requireRole,
  createSession,
  setSessionCookie,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';

// ============================================================================
// src/routes/invitations.ts (Sub-turn 10) — mounted at /api/invitations
// ----------------------------------------------------------------------------
// Invite by email → tokenized link → accept page → user joins the workspace.
// Replaces the removed admin bootstrap token. Token pattern mirrors sessions:
// 32 random bytes, SHA-256 hashed at rest (bcrypt is for passwords only).
//
// A "team member" in this schema is a `users` row + a `workspace_memberships`
// row (role lives on the membership) — NEVER a `people` row (that's the
// customer table). The inviter is the logged-in user, so invited_by_user_id
// references users(id).
//
// Existing-user security: users.email is globally unique. An invite grants the
// right to JOIN A WORKSPACE, never to authenticate as a pre-existing account.
// So when the email already belongs to a user, accept requires that user's
// EXISTING password (bcrypt.compare) and only creates a membership — it never
// sets/overwrites a password and never resurrects a soft-deleted account.
// ============================================================================

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = { Variables: { session: SessionVar } };

export const invitations = new Hono<Env>();

// sessionMiddleware only READS the cookie (never rejects), so it's safe on the
// public verify/accept routes too. requireAuth/requireRole gate the rest.
invitations.use('*', sessionMiddleware);

function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

// Public origin of the request, for building the accept URL (works behind the
// Vercel proxy via x-forwarded-*). Falls back to the Host header.
function originFromRequest(c: Context): string {
  const proto = c.req.header('x-forwarded-proto') ?? 'https';
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? '';
  return `${proto}://${host}`;
}

// Roles that can be invited. 'owner' is deliberately absent — owner exists only
// via workspace creation, enforced here AND by the DB CHECK constraint.
const INVITABLE_ROLES = ['manager', 'staff', 'client', 'investor'] as const;
type InvitableRole = (typeof INVITABLE_ROLES)[number];

// Best-effort send via the workspace's active email adapter (same registry as
// reminders — no new email dependency). Returns whether it actually sent. A
// missing/failing adapter must NOT block onboarding, so callers ignore false.
async function trySendInviteEmail(
  workspaceId: string,
  to: string,
  payload: { subject: string; text: string },
  fromName: string,
): Promise<boolean> {
  try {
    const rows = await query<{ provider: string; credentials_b64: string | null; config: Record<string, unknown> }>(sql`
      SELECT provider, encode(credentials_encrypted, 'base64') AS credentials_b64, config
      FROM workspace_integrations
      WHERE workspace_id = ${workspaceId}::uuid AND category = 'email'::text AND is_active = true
      LIMIT 1
    `);
    const row = rows[0];
    if (!row) return false;
    const adapter = findAdapter('email', row.provider) as EmailAdapter | null;
    if (!adapter) return false;
    let credentials: Record<string, string> = {};
    try {
      credentials = row.credentials_b64
        ? ((decryptJson(Buffer.from(row.credentials_b64, 'base64')) as Record<string, string>) ?? {})
        : {};
    } catch { credentials = {}; }
    const config = row.config ?? {};
    const result = await adapter.send({
      to,
      from: String((config as Record<string, unknown>).from_email || ''),
      fromName,
      subject: payload.subject,
      text: payload.text,
      html: `<pre style="font-family:inherit;white-space:pre-wrap">${payload.text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`,
      credentials,
      config,
    });
    return result.status === 'sent';
  } catch (err) {
    console.error('[invitations] email send failed', err);
    return false;
  }
}

// ============================================================================
// POST /api/invitations — create + send (owner/manager)
// ============================================================================
const createSchema = z.object({
  email: z.string().email().max(320),
  role: z.string().min(1).max(20),
});

invitations.post('/', requireAuth, requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const wsId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);

  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const email = parsed.data.email.trim().toLowerCase();
  const role = parsed.data.role.trim();

  // Owner can never be invited — 403 (authorization failure), not 400.
  if (role === 'owner') return c.json({ error: 'cannot_invite_owner' }, 403);
  if (!INVITABLE_ROLES.includes(role as InvitableRole)) {
    return c.json({ error: 'invalid_request', reason: 'unknown_role' }, 400);
  }
  // Escalation guard: a manager can invite staff/client/investor only —
  // never another manager (and never owner, handled above).
  if (session.user.role === 'manager' && role === 'manager') {
    return c.json({ error: 'insufficient_role' }, 403);
  }

  // Existing-user handling (email is globally unique).
  const existingUsers = await query<{ id: string; deleted_at: string | null }>(sql`
    SELECT id, deleted_at FROM users WHERE email = ${email}::citext LIMIT 1
  `);
  const existingUser = existingUsers[0] ?? null;
  if (existingUser) {
    if (existingUser.deleted_at) return c.json({ error: 'account_disabled' }, 409);
    const membership = await query<{ id: string }>(sql`
      SELECT id FROM workspace_memberships
      WHERE workspace_id = ${wsId}::uuid AND user_id = ${existingUser.id}::uuid
      LIMIT 1
    `);
    if (membership.length) return c.json({ error: 'already_member' }, 409);
  }
  const existingUserFlag = !!existingUser; // exists, not deleted, not a member here

  // A live (unaccepted, unrevoked) invite occupies the partial unique slot.
  // If it's still valid → 409 invite_pending. If it's expired, auto-revoke it
  // so re-inviting doesn't hit the DB constraint.
  const live = await query<{ id: string; expired: boolean }>(sql`
    SELECT id, (expires_at <= now()) AS expired
    FROM invitations
    WHERE workspace_id = ${wsId}::uuid AND lower(email) = ${email}::text
      AND accepted_at IS NULL AND revoked_at IS NULL
    LIMIT 1
  `);
  if (live.length && !live[0]!.expired) {
    return c.json({ error: 'invite_pending', invitation_id: live[0]!.id }, 409);
  }
  if (live.length && live[0]!.expired) {
    await sql`UPDATE invitations SET revoked_at = now() WHERE id = ${live[0]!.id}::uuid`;
  }

  // Expiry window (configurable — configurability over hardcoding).
  const wsRows = await query<{ name: string; settings: Record<string, any> | null }>(sql`
    SELECT name, settings FROM workspaces WHERE id = ${wsId}::uuid LIMIT 1
  `);
  const workspaceName = wsRows[0]?.name ?? 'RentalOS';
  const expiryDaysRaw = Number(wsRows[0]?.settings?.invitations?.expiry_days);
  const expiryDays = Number.isFinite(expiryDaysRaw) && expiryDaysRaw > 0 ? Math.floor(expiryDaysRaw) : 7;

  const token = generateToken();
  const tokenHash = hashToken(token);

  let inserted: { id: string; expires_at: string }[];
  try {
    inserted = await query<{ id: string; expires_at: string }>(sql`
      INSERT INTO invitations
        (workspace_id, email, role, token_hash, invited_by_user_id, expires_at)
      VALUES (
        ${wsId}::uuid, ${email}::text, ${role}::text, ${tokenHash}::text,
        ${session.user.id}::uuid, now() + make_interval(days => ${expiryDays}::int)
      )
      RETURNING id, expires_at
    `);
  } catch (err) {
    // Partial-unique-index race → a live invite already exists.
    const existing = await query<{ id: string }>(sql`
      SELECT id FROM invitations
      WHERE workspace_id = ${wsId}::uuid AND lower(email) = ${email}::text
        AND accepted_at IS NULL AND revoked_at IS NULL
      LIMIT 1
    `);
    if (existing.length) return c.json({ error: 'invite_pending', invitation_id: existing[0]!.id }, 409);
    throw err;
  }

  const invitationId = inserted[0]!.id;
  const expiresAt = inserted[0]!.expires_at;
  const acceptUrl = `${originFromRequest(c)}/accept-invite.html?token=${encodeURIComponent(token)}`;

  // Best-effort email — a failed send does NOT roll back the invite.
  const mail = buildInviteEmail({
    workspaceName,
    inviterName: session.user.displayName,
    role,
    acceptUrl,
    expiryDays,
  });
  const emailSent = await trySendInviteEmail(wsId, email, mail, workspaceName);

  await audit({
    workspaceId: wsId,
    actorUserId: session.user.id,
    eventType: 'invitation.created',
    targetType: 'invitation',
    targetId: invitationId,
    payload: { email, role, existing_user: existingUserFlag, email_sent: emailSent },
    ipAddress, userAgent,
  });

  return c.json({
    id: invitationId,
    email,
    role,
    expires_at: expiresAt,
    email_sent: emailSent,
    existing_user: existingUserFlag,
    accept_url: acceptUrl, // returned ONCE — the raw token is never stored
  }, 201);
});

// ============================================================================
// GET /api/invitations — pending list (owner/manager)
// ============================================================================
invitations.get('/', requireAuth, requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const rows = await query<{
    id: string; email: string; role: string; expires_at: string;
    created_at: string; invited_by: string | null;
  }>(sql`
    SELECT i.id, i.email, i.role, i.expires_at, i.created_at,
           u.display_name AS invited_by
    FROM invitations i
    LEFT JOIN users u ON u.id = i.invited_by_user_id
    WHERE i.workspace_id = ${session.workspace.id}::uuid
      AND i.accepted_at IS NULL
      AND i.revoked_at IS NULL
      AND i.expires_at > now()
    ORDER BY i.created_at DESC
  `);
  return c.json({ invitations: rows });
});

// ============================================================================
// DELETE /api/invitations/:id — revoke (owner/manager). Idempotent.
// ============================================================================
invitations.delete('/:id', requireAuth, requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const revoked = await query<{ id: string }>(sql`
    UPDATE invitations SET revoked_at = now()
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
      AND revoked_at IS NULL AND accepted_at IS NULL
    RETURNING id
  `);
  if (revoked.length) {
    await audit({
      workspaceId: session.workspace.id,
      actorUserId: session.user.id,
      eventType: 'invitation.revoked',
      targetType: 'invitation',
      targetId: id,
      payload: {},
      ipAddress, userAgent,
    });
    return c.json({ ok: true });
  }

  // Already revoked / accepted → idempotent 200. Truly absent → 404.
  const exists = await query<{ id: string }>(sql`
    SELECT id FROM invitations
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    LIMIT 1
  `);
  if (exists.length) return c.json({ ok: true });
  return c.json({ error: 'not_found' }, 404);
});

// ============================================================================
// GET /api/invitations/verify?token=… — pre-accept check (NO AUTH)
// ============================================================================
invitations.get('/verify', async (c) => {
  const token = c.req.query('token') ?? '';
  if (!token) return c.json({ error: 'invalid' }, 404);

  const rows = await query<{
    email: string; role: string; workspace_id: string;
    accepted_at: string | null; revoked_at: string | null; expired: boolean;
  }>(sql`
    SELECT email, role, workspace_id, accepted_at, revoked_at,
           (expires_at <= now()) AS expired
    FROM invitations WHERE token_hash = ${hashToken(token)}::text LIMIT 1
  `);
  const row = rows[0];
  // Revoked and not-found are INDISTINGUISHABLE — no information leak.
  if (!row || row.revoked_at) return c.json({ error: 'invalid' }, 404);
  if (row.accepted_at) return c.json({ error: 'already_accepted' }, 410);
  if (row.expired) return c.json({ error: 'expired' }, 410);

  const wsRows = await query<{ name: string }>(sql`
    SELECT name FROM workspaces WHERE id = ${row.workspace_id}::uuid LIMIT 1
  `);
  const existing = await query<{ id: string }>(sql`
    SELECT id FROM users WHERE email = ${row.email}::citext AND deleted_at IS NULL LIMIT 1
  `);

  // Email + role + workspace display name only. No workspace_id, no inviter.
  return c.json({
    email: row.email,
    role: row.role,
    workspace_name: wsRows[0]?.name ?? 'RentalOS',
    existing_user: existing.length > 0,
  });
});

// ============================================================================
// POST /api/invitations/accept — accept + (create user or verify) + log in
// NO AUTH. Role/email/workspace come from the invitation row, never the body.
// ============================================================================
const acceptSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1).max(100).optional(),
  password: z.string().min(1).max(200),
});

invitations.post('/accept', async (c) => {
  const { ipAddress, userAgent } = clientCtx(c);
  const body = await c.req.json().catch(() => null);
  const parsed = acceptSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const { token, name, password } = parsed.data;

  // Re-verify the token server-side (never trust the client's claims).
  const rows = await query<{
    id: string; email: string; role: string; workspace_id: string;
    invited_by_user_id: string;
    accepted_at: string | null; revoked_at: string | null; expired: boolean;
  }>(sql`
    SELECT id, email, role, workspace_id, invited_by_user_id, accepted_at, revoked_at,
           (expires_at <= now()) AS expired
    FROM invitations WHERE token_hash = ${hashToken(token)}::text LIMIT 1
  `);
  const invite = rows[0];
  if (!invite || invite.revoked_at) return c.json({ error: 'invalid' }, 404);
  if (invite.accepted_at) return c.json({ error: 'already_accepted' }, 410);
  if (invite.expired) return c.json({ error: 'expired' }, 410);

  const email = invite.email;
  const wsId = invite.workspace_id;
  const role = invite.role; // authoritative — from the invite, never the body
  const invitedByUserId = invite.invited_by_user_id;

  const existingUsers = await query<{ id: string; password_hash: string; deleted_at: string | null }>(sql`
    SELECT id, password_hash, deleted_at FROM users WHERE email = ${email}::citext LIMIT 1
  `);
  const existingUser = existingUsers[0] ?? null;
  // Never resurrect a soft-deleted account through an invite link.
  if (existingUser?.deleted_at) return c.json({ error: 'account_disabled' }, 409);

  let userId: string;

  if (existingUser) {
    // EXISTING account joining a new workspace: the password field is their
    // EXISTING password — verify it, never change it, and only add a membership.
    const ok = await verifyPassword(password, existingUser.password_hash);
    if (!ok) return c.json({ error: 'invalid_password' }, 401);
    userId = existingUser.id;

    // Race guard: already a member of this workspace?
    const membership = await query<{ id: string }>(sql`
      SELECT id FROM workspace_memberships
      WHERE workspace_id = ${wsId}::uuid AND user_id = ${userId}::uuid LIMIT 1
    `);
    if (membership.length) return c.json({ error: 'already_member' }, 409);

    await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role, status, invited_by)
      VALUES (${wsId}::uuid, ${userId}::uuid, ${role}::workspace_role, 'active', ${invitedByUserId}::uuid)
    `;
  } else {
    // NEW account: name required, password must pass the app-wide policy.
    if (!name || !name.trim()) return c.json({ error: 'name_required' }, 400);
    const policy = validatePasswordPolicy(password);
    if (!policy.ok) return c.json({ error: 'weak_password', reason: policy.reason }, 400);
    const passwordHash = await hashPassword(password);

    // Order writes so a failure leaves no half-created member (Neon HTTP has no
    // cross-statement transactions): user → membership → accepted_at.
    let created: { id: string }[];
    try {
      created = await query<{ id: string }>(sql`
        INSERT INTO users (email, password_hash, display_name)
        VALUES (${email}::citext, ${passwordHash}::text, ${name.trim()}::text)
        RETURNING id
      `);
    } catch {
      // Someone created the account between verify and now (globally unique email).
      return c.json({ error: 'already_member' }, 409);
    }
    userId = created[0]!.id;

    await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role, status, invited_by)
      VALUES (${wsId}::uuid, ${userId}::uuid, ${role}::workspace_role, 'active', ${invitedByUserId}::uuid)
    `;
  }

  // Mark accepted (guarded so a double-submit can't accept twice).
  await sql`
    UPDATE invitations SET accepted_at = now()
    WHERE id = ${invite.id}::uuid AND accepted_at IS NULL
  `;

  // Auto-login: reuse the exact session path login uses.
  const cookieToken = await createSession({ userId, workspaceId: wsId, userAgent, ipAddress });
  setSessionCookie(c, cookieToken);

  await audit({
    workspaceId: wsId,
    actorUserId: userId,
    eventType: 'invitation.accepted',
    targetType: 'invitation',
    targetId: invite.id,
    payload: { email, role, invitation_id: invite.id, existing_user: !!existingUser },
    ipAddress, userAgent,
  });

  return c.json({ ok: true, redirect: '/dashboard.html' });
});
