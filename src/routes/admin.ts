// admin.ts — Token-protected bootstrap endpoints
//
// Endpoints:
//   GET|POST /api/admin/migrate       — run pending migrations, idempotent
//   GET|POST /api/admin/seed          — create/update owner user + workspace, idempotent
//   GET|POST /api/admin/user-create   — TEMPORARY: create an additional user
//
// All three require ADMIN_SETUP_TOKEN via ?token=<value> query param or an
// Authorization: Bearer <value> header. Timing-safe comparison via SHA-256.
//
// This entire file is bootstrap surface. When the People module ships (proper
// invite flow), delete the user-create endpoint. When production is stable and
// aamir has verified access, unset ADMIN_SETUP_TOKEN to disable all three.
import { Hono } from 'hono';
import type { Context } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { sql, query } from '../db.js';
import { config } from '../lib/config.js';
import { audit } from '../lib/audit.js';
import { hashPassword, validatePasswordPolicy } from '../lib/password.js';
import { runMigrations } from '../lib/migrate.js';
import { runSeed } from '../lib/seed.js';

export const admin = new Hono();

// ---------- helpers ---------------------------------------------------------

function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

function presentedToken(c: Context): string {
  const fromQuery = c.req.query('token');
  if (fromQuery) return fromQuery;
  const authz = c.req.header('authorization');
  if (!authz) return '';
  return authz.replace(/^Bearer\s+/i, '').trim();
}

/**
 * Compare presented vs expected token in constant time.
 * Both are SHA-256 hashed first so timingSafeEqual sees equal-length buffers,
 * regardless of caller-controlled input length.
 */
function tokenMatches(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

type Gate = { ok: true } | { ok: false; status: 503 | 403; body: { error: string } };

async function gate(c: Context, endpoint: string): Promise<Gate> {
  if (!config.adminSetupToken) return { ok: false, status: 503, body: { error: 'admin_disabled' } };
  if (!tokenMatches(presentedToken(c), config.adminSetupToken)) {
    const { ipAddress, userAgent } = clientCtx(c);
    await audit({ eventType: 'admin.access.invalid_token', payload: { endpoint }, ipAddress, userAgent });
    return { ok: false, status: 403, body: { error: 'invalid_token' } };
  }
  return { ok: true };
}

// ---------- migrate ---------------------------------------------------------

async function handleMigrate(c: Context) {
  const g = await gate(c, 'migrate');
  if (!g.ok) return c.json(g.body, g.status);
  const { ipAddress, userAgent } = clientCtx(c);
  try {
    const result = await runMigrations(sql);
    await audit({
      eventType: 'admin.migrate.success',
      payload: { applied: result.applied, skipped: result.skipped, table_count: result.tables.length },
      ipAddress, userAgent,
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit({ eventType: 'admin.migrate.failure', payload: { message }, ipAddress, userAgent });
    return c.json({ ok: false, error: 'migrate_failed', message }, 500);
  }
}

// ---------- seed ------------------------------------------------------------

async function handleSeed(c: Context) {
  const g = await gate(c, 'seed');
  if (!g.ok) return c.json(g.body, g.status);
  const { ipAddress, userAgent } = clientCtx(c);
  try {
    const result = await runSeed(sql, config);
    await audit({
      workspaceId: result.workspace_id,
      actorUserId: result.user_id,
      eventType: 'admin.seed.success',
      payload: { email: result.email },
      ipAddress, userAgent,
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit({ eventType: 'admin.seed.failure', payload: { message }, ipAddress, userAgent });
    return c.json({ ok: false, error: 'seed_failed', message }, 500);
  }
}

// ---------- user-create (TEMPORARY) -----------------------------------------
// Delete this entire handler when the People module ships proper invite flow.
// Password travels in URL → Vercel access logs + browser history. Caller must
// rotate via forgot-password flow immediately after first successful login.

const VALID_ROLES = ['owner', 'manager', 'staff', 'client', 'investor'] as const;
type Role = typeof VALID_ROLES[number];

async function handleUserCreate(c: Context) {
  const g = await gate(c, 'user-create');
  if (!g.ok) return c.json(g.body, g.status);
  const { ipAddress, userAgent } = clientCtx(c);

  const email = (c.req.query('email') ?? '').trim().toLowerCase();
  const name = (c.req.query('name') ?? '').trim();
  const password = c.req.query('password') ?? '';
  const role = c.req.query('role') ?? '';
  const workspaceSlug = (c.req.query('workspace_slug') ?? 'dslrswala').trim();

  // Validate params
  if (!email || !name || !password || !role) {
    return c.json({ error: 'missing_param', required: ['email', 'name', 'password', 'role'] }, 400);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 320) {
    return c.json({ error: 'invalid_email' }, 400);
  }
  if (name.length > 200) {
    return c.json({ error: 'invalid_name' }, 400);
  }
  if (!VALID_ROLES.includes(role as Role)) {
    return c.json({ error: 'invalid_role', valid: VALID_ROLES }, 400);
  }
  const policy = validatePasswordPolicy(password);
  if (!policy.ok) {
    return c.json({ error: 'password_too_weak', reason: policy.reason }, 400);
  }

  try {
    // Find workspace
    const workspaces = await query<{ id: string }>(sql`
      SELECT id FROM workspaces
      WHERE slug = ${workspaceSlug} AND deleted_at IS NULL
      LIMIT 1
    `);
    const workspace = workspaces[0];
    if (!workspace) {
      return c.json({ error: 'workspace_not_found', slug: workspaceSlug }, 404);
    }

    // Upsert user
    const passwordHash = await hashPassword(password);
    const users = await query<{ id: string }>(sql`
      INSERT INTO users (email, display_name, password_hash, email_verified_at)
      VALUES (${email}, ${name}, ${passwordHash}, now())
      ON CONFLICT (email) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        password_hash = EXCLUDED.password_hash,
        password_updated_at = now()
      RETURNING id
    `);
    const user = users[0]!;

    // Upsert membership
    await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
      VALUES (${workspace.id}, ${user.id}, ${role}::workspace_role, 'active')
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET
        role = EXCLUDED.role,
        status = 'active'
    `;

    await audit({
      workspaceId: workspace.id,
      actorUserId: user.id,
      eventType: 'admin.user.created',
      targetType: 'user',
      targetId: user.id,
      payload: { email, name, role, workspace_slug: workspaceSlug },
      ipAddress, userAgent,
    });

    return c.json({
      ok: true,
      workspace_id: workspace.id,
      user_id: user.id,
      email,
      name,
      role,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit({
      eventType: 'admin.user.create_failed',
      payload: { email, reason: message },
      ipAddress, userAgent,
    });
    return c.json({ ok: false, error: 'create_failed', message }, 500);
  }
}

// ---------- routes ----------------------------------------------------------

admin.get('/migrate', handleMigrate);
admin.post('/migrate', handleMigrate);
admin.get('/seed', handleSeed);
admin.post('/seed', handleSeed);
admin.get('/user-create', handleUserCreate);
admin.post('/user-create', handleUserCreate);
