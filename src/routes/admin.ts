// ============================================================================
// admin.ts · Token-protected bootstrap endpoints
// ============================================================================
// Browser-hittable setup endpoints for the Vercel-native workflow:
//   GET|POST /api/admin/migrate  → runMigrations()
//   GET|POST /api/admin/seed     → runSeed()
//
// GET is accepted (not just POST) so you can trigger them straight from the
// Chrome address bar. Both are gated by ADMIN_SETUP_TOKEN using a timing-safe
// comparison. DELETE the env var in Vercel once setup is done — with it unset,
// these endpoints return 503 and can't be used.
// ============================================================================

import { Hono } from 'hono';
import type { Context } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from '../db.js';
import { config } from '../lib/config.js';
import { audit } from '../lib/audit.js';
import { runMigrations } from '../lib/migrate.js';
import { runSeed } from '../lib/seed.js';

export const admin = new Hono();

// Read client IP + UA once for audit rows.
function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

// Pull the presented token from `?token=` or the Authorization header
// (`Bearer <token>` or a bare value).
function presentedToken(c: Context): string {
  const fromQuery = c.req.query('token');
  if (fromQuery) return fromQuery;
  const authz = c.req.header('authorization');
  if (!authz) return '';
  return authz.replace(/^Bearer\s+/i, '').trim();
}

// Timing-safe compare. SHA-256 both sides first so the buffers are always the
// same length (timingSafeEqual throws on length mismatch) and the comparison
// itself leaks nothing about the expected token.
function tokenMatches(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

type Gate = { ok: true } | { ok: false; status: 503 | 403; body: { error: string } };

// Enforce the admin token. On a 403, emit an audit event (best-effort — the
// audit_events table may not exist yet on a brand-new database, in which case
// audit() swallows the error).
async function gate(c: Context, endpoint: string): Promise<Gate> {
  if (!config.adminSetupToken) {
    return { ok: false, status: 503, body: { error: 'admin_disabled' } };
  }
  if (!tokenMatches(presentedToken(c), config.adminSetupToken)) {
    const { ipAddress, userAgent } = clientCtx(c);
    await audit({
      eventType: 'admin.access.invalid_token',
      payload: { endpoint },
      ipAddress,
      userAgent,
    });
    return { ok: false, status: 403, body: { error: 'invalid_token' } };
  }
  return { ok: true };
}

// ============================================================================
// migrate
// ============================================================================
async function handleMigrate(c: Context) {
  const g = await gate(c, 'migrate');
  if (!g.ok) return c.json(g.body, g.status);

  const { ipAddress, userAgent } = clientCtx(c);
  try {
    const result = await runMigrations(sql);
    await audit({
      eventType: 'admin.migrate.success',
      payload: {
        applied: result.applied,
        skipped: result.skipped,
        table_count: result.tables.length,
      },
      ipAddress,
      userAgent,
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit({
      eventType: 'admin.migrate.failure',
      payload: { message },
      ipAddress,
      userAgent,
    });
    return c.json({ ok: false, error: 'migrate_failed', message }, 500);
  }
}

// ============================================================================
// seed
// ============================================================================
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
      ipAddress,
      userAgent,
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit({
      eventType: 'admin.seed.failure',
      payload: { message },
      ipAddress,
      userAgent,
    });
    return c.json({ ok: false, error: 'seed_failed', message }, 500);
  }
}

admin.get('/migrate', handleMigrate);
admin.post('/migrate', handleMigrate);
admin.get('/seed', handleSeed);
admin.post('/seed', handleSeed);
