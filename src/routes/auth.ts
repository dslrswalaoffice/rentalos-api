import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { config } from '../lib/config.js';
import { audit } from '../lib/audit.js';
import { hashToken, generateToken } from '../lib/tokens.js';
import { hashPassword, verifyPassword, fakePasswordCheck, validatePasswordPolicy } from '../lib/password.js';
import {
  checkLoginRateLimit,
  recordLoginAttempt,
  checkPasswordResetRateLimit,
} from '../lib/rate-limit.js';
import {
  createSession,
  revokeAllUserSessions,
  revokeSession,
  setSessionCookie,
  clearSessionCookie,
  sessionMiddleware,
  SESSION_COOKIE,
} from '../middleware/session.js';
import { sendEmail, buildResetEmail } from '../lib/email.js';
import { getCookie } from 'hono/cookie';

export const auth = new Hono();

// Read a couple of things off the request that we log with every event.
function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

// ============================================================================
// POST /api/auth/login
// ============================================================================
const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

auth.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const { email, password } = parsed.data;
  const { ipAddress, userAgent } = clientCtx(c);

  // 1. Rate limit BEFORE we touch the users table (so this can't be used to enumerate).
  const rate = await checkLoginRateLimit(email, ipAddress);
  if (!rate.ok) {
    await audit({
      eventType: 'auth.login.rate_limited',
      payload: { email }, ipAddress, userAgent,
    });
    c.header('Retry-After', String(rate.retryAfterSeconds));
    return c.json({ error: 'rate_limited', retryAfterSeconds: rate.retryAfterSeconds }, 429);
  }

  // 2. Look up user.
  const userRows = await query<{
    id: string; email: string; display_name: string; password_hash: string;
  }>(sql`
    SELECT id, email, display_name, password_hash
    FROM users
    WHERE email = ${email} AND deleted_at IS NULL
    LIMIT 1
  `);
  const user = userRows[0];

  // If user doesn't exist, do a fake bcrypt check so response time is constant.
  if (!user) {
    await fakePasswordCheck(password);
    await recordLoginAttempt(email, ipAddress, false);
    await audit({
      eventType: 'auth.login.failure',
      payload: { email, reason: 'no_such_user' }, ipAddress, userAgent,
    });
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  // 3. Verify password.
  const passwordOk = await verifyPassword(password, user.password_hash);
  if (!passwordOk) {
    await recordLoginAttempt(email, ipAddress, false);
    await audit({
      actorUserId: user.id,
      eventType: 'auth.login.failure',
      payload: { email, reason: 'wrong_password' }, ipAddress, userAgent,
    });
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  // 4. Find their active workspace membership. For MVP: pick the first one.
  //    When a user belongs to multiple workspaces, we'll return a picker here.
  const memberships = await query<{
    workspace_id: string; role: 'owner' | 'manager' | 'staff';
    workspace_slug: string; workspace_name: string; workspace_location: string | null;
  }>(sql`
    SELECT
      m.workspace_id,
      m.role,
      w.slug     AS workspace_slug,
      w.name     AS workspace_name,
      w.location AS workspace_location
    FROM workspace_memberships m
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.user_id = ${user.id}
      AND m.status = 'active'
      AND w.deleted_at IS NULL
    ORDER BY m.joined_at ASC
    LIMIT 1
  `);
  const membership = memberships[0];
  if (!membership) {
    // User exists but has no active workspace. Treat as "no access" so we
    // don't leak internal state.
    await audit({
      actorUserId: user.id,
      eventType: 'auth.login.failure',
      payload: { email, reason: 'no_active_workspace' }, ipAddress, userAgent,
    });
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  // 5. Create session, set cookie.
  const token = await createSession({
    userId: user.id,
    workspaceId: membership.workspace_id,
    userAgent, ipAddress,
  });
  setSessionCookie(c, token);

  // 6. Bump last_login and record success.
  await Promise.all([
    sql`UPDATE users SET last_login_at = now() WHERE id = ${user.id}`,
    recordLoginAttempt(email, ipAddress, true),
    audit({
      workspaceId: membership.workspace_id,
      actorUserId: user.id,
      eventType: 'auth.login.success',
      payload: { email }, ipAddress, userAgent,
    }),
  ]);

  return c.json({
    redirect: '/dashboard.html',
    user: {
      id: user.id, email: user.email, displayName: user.display_name, role: membership.role,
    },
    workspace: {
      id: membership.workspace_id, slug: membership.workspace_slug,
      name: membership.workspace_name, location: membership.workspace_location,
    },
  });
});

// ============================================================================
// POST /api/auth/logout
// ============================================================================
auth.post('/logout', sessionMiddleware, async (c) => {
  const session = c.get('session');
  const { ipAddress, userAgent } = clientCtx(c);
  if (session) {
    await revokeSession(session.sessionId);
    await audit({
      workspaceId: session.workspace.id,
      actorUserId: session.user.id,
      eventType: 'auth.logout',
      ipAddress, userAgent,
    });
  }
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// ============================================================================
// GET /api/auth/me
// ============================================================================
auth.get('/me', sessionMiddleware, async (c) => {
  const session = c.get('session');
  if (!session) return c.json({ error: 'not_authenticated' }, 401);
  return c.json({
    user: session.user,
    workspace: session.workspace,
  });
});

// ============================================================================
// POST /api/auth/forgot-password
// ============================================================================
const forgotSchema = z.object({
  email: z.string().email().max(320),
});

auth.post('/forgot-password', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = forgotSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const { email } = parsed.data;
  const { ipAddress, userAgent } = clientCtx(c);

  // 1. Rate limit — same 200 response regardless, but we skip issuing tokens.
  const rate = await checkPasswordResetRateLimit(email);

  // 2. Look up user. If they don't exist, we still return 200 — no enumeration.
  const userRows = await query<{ id: string; display_name: string }>(sql`
    SELECT id, display_name FROM users
    WHERE email = ${email} AND deleted_at IS NULL
    LIMIT 1
  `);
  const user = userRows[0];

  if (rate.ok && user) {
    // 3. Issue token.
    const plaintext = generateToken();
    const tokenHash = hashToken(plaintext);
    const expiresAt = new Date(Date.now() + config.passwordResetTtlMinutes * 60 * 1000);

    await sql`
      INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, ip_address)
      VALUES (${user.id}, ${tokenHash}, ${expiresAt.toISOString()}::timestamptz, ${ipAddress})
    `;

    // 4. Email the link.
    const resetUrl = `${config.appOrigin}/reset-password.html?token=${plaintext}`;
    const emailPayload = buildResetEmail(user.display_name, resetUrl);
    await sendEmail({ ...emailPayload, to: email });

    await audit({
      actorUserId: user.id,
      eventType: 'auth.password.reset_requested',
      payload: { email }, ipAddress, userAgent,
    });
  } else if (!rate.ok && user) {
    await audit({
      actorUserId: user.id,
      eventType: 'auth.password.reset_rate_limited',
      payload: { email }, ipAddress, userAgent,
    });
  } else {
    // No user or rate-limited-no-user. Still 200. Log a lightweight event so we
    // can spot enumeration attempts in the audit stream.
    await audit({
      eventType: 'auth.password.reset_requested',
      payload: { email, user_exists: false }, ipAddress, userAgent,
    });
  }

  return c.json({ ok: true });
});

// ============================================================================
// GET /api/auth/reset-password/verify
// ============================================================================
auth.get('/reset-password/verify', async (c) => {
  const token = c.req.query('token');
  if (!token) return c.json({ error: 'invalid_or_expired' }, 404);

  const tokenHash = hashToken(token);
  const rows = await query<{ email: string }>(sql`
    SELECT u.email
    FROM password_reset_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ${tokenHash}
      AND t.used_at IS NULL
      AND t.expires_at > now()
      AND u.deleted_at IS NULL
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return c.json({ error: 'invalid_or_expired' }, 404);
  return c.json({ email: row.email });
});

// ============================================================================
// POST /api/auth/reset-password
// ============================================================================
const resetSchema = z.object({
  token: z.string().min(1).max(500),
  password: z.string().min(1).max(200),
});

auth.post('/reset-password', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = resetSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const { token, password } = parsed.data;
  const { ipAddress, userAgent } = clientCtx(c);

  // 1. Validate password against server-side policy. Never trust client checks.
  const policy = validatePasswordPolicy(password);
  if (!policy.ok) {
    return c.json({ error: 'password_too_weak', reason: policy.reason }, 400);
  }

  // 2. Consume the token atomically. UPDATE...RETURNING guarantees only one
  //    caller wins the race if two requests arrive at the same instant.
  const tokenHash = hashToken(token);
  const claimed = await query<{ user_id: string; email: string; display_name: string }>(sql`
    WITH claimed AS (
      UPDATE password_reset_tokens
      SET used_at = now()
      WHERE token_hash = ${tokenHash}
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING user_id
    )
    SELECT u.id AS user_id, u.email, u.display_name
    FROM claimed c
    JOIN users u ON u.id = c.user_id AND u.deleted_at IS NULL
  `);

  const owner = claimed[0];
  if (!owner) {
    await audit({
      eventType: 'auth.password.reset_failed',
      payload: { reason: 'invalid_or_expired_token' }, ipAddress, userAgent,
    });
    return c.json({ error: 'token_used_or_expired' }, 410);
  }

  // 3. Update password, revoke all sessions, create fresh one.
  const newHash = await hashPassword(password);

  await sql`
    UPDATE users
    SET password_hash = ${newHash}, password_updated_at = now()
    WHERE id = ${owner.user_id}
  `;
  await revokeAllUserSessions(owner.user_id);

  // Find their workspace to create the new session against.
  const memberships = await query<{ workspace_id: string; role: string }>(sql`
    SELECT m.workspace_id, m.role
    FROM workspace_memberships m
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.user_id = ${owner.user_id}
      AND m.status = 'active'
      AND w.deleted_at IS NULL
    ORDER BY m.joined_at ASC
    LIMIT 1
  `);
  const membership = memberships[0];

  if (membership) {
    const cookieToken = await createSession({
      userId: owner.user_id,
      workspaceId: membership.workspace_id,
      userAgent, ipAddress,
    });
    setSessionCookie(c, cookieToken);
  }

  await audit({
    workspaceId: membership?.workspace_id,
    actorUserId: owner.user_id,
    eventType: 'auth.password.reset_completed',
    payload: { email: owner.email }, ipAddress, userAgent,
  });

  return c.json({ redirect: '/dashboard.html' });
});

// A dev-only diagnostic to quickly see whether cookies are landing correctly.
// Guarded by env so we never expose it in prod.
if (config.isDev) {
  auth.get('/_debug/cookie', (c) => {
    return c.json({
      hasCookie: !!getCookie(c, SESSION_COOKIE),
      env: config.nodeEnv,
    });
  });
}
