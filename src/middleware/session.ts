import { createMiddleware } from 'hono/factory';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { sql, query } from '../db.js';
import { hashToken, generateToken } from '../lib/tokens.js';
import { config } from '../lib/config.js';

export const SESSION_COOKIE = 'ros_session';

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  // Sub-turn 12a: roles collapsed to three. client/investor removed — they get
  // separate portals later, not workspace memberships.
  role: 'owner' | 'manager' | 'staff';
};

export type SessionWorkspace = {
  id: string;
  slug: string;
  name: string;
  location: string | null;
};

type SessionRow = {
  session_id: string;
  user_id: string;
  workspace_id: string;
  user_email: string;
  user_display_name: string;
  role: SessionUser['role'];
  permissions: Record<string, boolean>;
  workspace_slug: string;
  workspace_name: string;
  workspace_location: string | null;
};

/**
 * Look up an active session by its cookie value. Returns null if:
 *   - no cookie
 *   - cookie doesn't match any session
 *   - session is revoked or expired
 * Also bumps last_used_at as a sliding window.
 */
export async function getSession(cookieValue: string | null): Promise<{
  user: SessionUser;
  workspace: SessionWorkspace;
  sessionId: string;
  // Sub-turn 12a: the member's granular permissions, loaded on the SAME query
  // that resolves the session — zero extra round trips. Owners carry {} here;
  // their access is code-enforced in can(), never read from this map.
  permissions: Record<string, boolean>;
} | null> {
  if (!cookieValue) return null;
  const tokenHash = hashToken(cookieValue);

  const rows = await query<SessionRow>(sql`
    SELECT
      s.id            AS session_id,
      s.user_id,
      s.workspace_id,
      u.email         AS user_email,
      u.display_name  AS user_display_name,
      m.role,
      m.permissions,
      w.slug          AS workspace_slug,
      w.name          AS workspace_name,
      w.location      AS workspace_location
    FROM sessions s
    JOIN users u                 ON u.id = s.user_id
    JOIN workspaces w            ON w.id = s.workspace_id
    JOIN workspace_memberships m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
    WHERE s.token_hash = ${tokenHash}
      AND s.revoked_at IS NULL
      AND s.expires_at > now()
      AND m.status = 'active'
      AND u.deleted_at IS NULL
      AND w.deleted_at IS NULL
    LIMIT 1
  `);

  const row = rows[0];
  if (!row) return null;

  // Sliding window: fire-and-forget bump. Don't await — this is optimization,
  // not correctness. If it fails, next request will do it.
  sql`UPDATE sessions SET last_used_at = now() WHERE id = ${row.session_id}`.catch(() => {});

  return {
    sessionId: row.session_id,
    user: {
      id: row.user_id,
      email: row.user_email,
      displayName: row.user_display_name,
      role: row.role,
    },
    workspace: {
      id: row.workspace_id,
      slug: row.workspace_slug,
      name: row.workspace_name,
      location: row.workspace_location,
    },
    permissions: row.permissions ?? {},
  };
}

/**
 * Create a new session row and return the plaintext cookie value.
 */
export async function createSession(params: {
  userId: string;
  workspaceId: string;
  userAgent: string | null;
  ipAddress: string | null;
}): Promise<string> {
  const plaintext = generateToken();
  const tokenHash = hashToken(plaintext);
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000);

  await sql`
    INSERT INTO sessions (user_id, workspace_id, token_hash, user_agent, ip_address, expires_at)
    VALUES (
      ${params.userId}, ${params.workspaceId}, ${tokenHash},
      ${params.userAgent}, ${params.ipAddress}, ${expiresAt.toISOString()}::timestamptz
    )
  `;
  return plaintext;
}

/**
 * Revoke every active session for a user. Called when the password changes so
 * that a compromised device is locked out immediately.
 */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  await sql`
    UPDATE sessions
    SET revoked_at = now()
    WHERE user_id = ${userId} AND revoked_at IS NULL
  `;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await sql`
    UPDATE sessions
    SET revoked_at = now()
    WHERE id = ${sessionId} AND revoked_at IS NULL
  `;
}

/**
 * Hono middleware that reads the session cookie and attaches (user, workspace)
 * to the context. Does NOT reject if unauthenticated — routes that need auth
 * should chain requireAuth() after this.
 */
export const sessionMiddleware = createMiddleware<{
  Variables: {
    session: Awaited<ReturnType<typeof getSession>>;
  };
}>(async (c, next) => {
  const cookie = getCookie(c, SESSION_COOKIE) ?? null;
  c.set('session', await getSession(cookie));
  await next();
});

/**
 * Reject with 401 if there's no active session. Chain AFTER sessionMiddleware.
 */
export const requireAuth = createMiddleware(async (c, next) => {
  const session = (c as unknown as { get: (k: 'session') => Awaited<ReturnType<typeof getSession>> }).get('session');
  if (!session) return c.json({ error: 'not_authenticated' }, 401);
  await next();
});

/**
 * Reject with 403 if the caller's role isn't in the allowed set.
 * Chain AFTER requireAuth. Case-sensitive role check.
 */
export function requireRole(...allowed: SessionUser['role'][]) {
  return createMiddleware(async (c, next) => {
    const session = (c as unknown as { get: (k: 'session') => Awaited<ReturnType<typeof getSession>> }).get('session');
    if (!session) return c.json({ error: 'not_authenticated' }, 401);
    if (!allowed.includes(session.user.role)) {
      return c.json({ error: 'forbidden', required_role: allowed }, 403);
    }
    await next();
  });
}

/**
 * Set the session cookie on a response. Handles Secure flag based on env.
 */
export function setSessionCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: !config.isDev,
    sameSite: 'Lax',
    path: '/',
    maxAge: config.sessionTtlDays * 24 * 60 * 60,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}
