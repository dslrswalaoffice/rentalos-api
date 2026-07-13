import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import { encryptJson, decryptJson } from '../lib/crypto.js';
import { ADAPTER_METADATA, findAdapter, findMetadata } from '../lib/adapters/registry.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';
import { requirePermission } from '../lib/permissions.js';

// ============================================================================
// src/routes/integrations.ts  (Sub-turn 6a)
// ----------------------------------------------------------------------------
//   GET    /api/integrations                        registry + saved state
//   PUT    /api/integrations/:cat/:provider         save credentials + config
//   POST   /api/integrations/:cat/:provider/activate    one active per category
//   POST   /api/integrations/:cat/:provider/deactivate
//   POST   /api/integrations/:cat/:provider/test
//   DELETE /api/integrations/:cat/:provider         remove config entirely
//
// Credentials are AES-256-GCM encrypted at rest and NEVER returned to the
// frontend. Writes are owner/manager only (matches settings write perms).
// ============================================================================

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = { Variables: { session: SessionVar } };

export const integrations = new Hono<Env>();
integrations.use('*', sessionMiddleware, requireAuth);

function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

type IntegrationRow = {
  category: string;
  provider: string;
  credentials_b64: string | null;
  config: Record<string, unknown>;
  is_active: boolean;
  test_mode: boolean;
  last_tested_at: string | null;
  last_test_status: string | null;
  last_test_message: string | null;
};

async function loadRow(workspaceId: string, category: string, provider: string): Promise<IntegrationRow | null> {
  const rows = await query<IntegrationRow>(sql`
    SELECT category, provider,
           encode(credentials_encrypted, 'base64') AS credentials_b64,
           config, is_active, test_mode, last_tested_at, last_test_status, last_test_message
    FROM workspace_integrations
    WHERE workspace_id = ${workspaceId}::uuid AND category = ${category}::text AND provider = ${provider}::text
    LIMIT 1
  `);
  return rows[0] ?? null;
}

function decodeCreds(b64: string | null): Record<string, string> {
  if (!b64) return {};
  try {
    return (decryptJson(Buffer.from(b64, 'base64')) as Record<string, string>) ?? {};
  } catch {
    return {};
  }
}

// ============================================================================
// GET /api/integrations — all registry adapters + this workspace's saved state
// ============================================================================
integrations.get('/', async (c) => {
  const session = c.get('session')!;

  const saved = await query<IntegrationRow>(sql`
    SELECT category, provider,
           encode(credentials_encrypted, 'base64') AS credentials_b64,
           config, is_active, test_mode, last_tested_at, last_test_status, last_test_message
    FROM workspace_integrations
    WHERE workspace_id = ${session.workspace.id}::uuid
  `);
  const byKey = new Map(saved.map((r) => [`${r.category}:${r.provider}`, r]));

  const adapters = ADAPTER_METADATA.map((m) => {
    const row = byKey.get(`${m.category}:${m.provider}`);
    return {
      ...m,
      configuration: row
        ? {
            is_active: row.is_active,
            test_mode: row.test_mode,
            config: row.config ?? {},
            credentials_saved: !!row.credentials_b64,
            last_tested_at: row.last_tested_at,
            last_test_status: row.last_test_status,
            last_test_message: row.last_test_message,
          }
        : null,
    };
  });

  return c.json({ adapters });
});

// ============================================================================
// PUT /api/integrations/:category/:provider — save credentials + config
// ============================================================================
const putSchema = z.object({
  credentials: z.record(z.string(), z.string()).optional(),
  config: z.record(z.string(), z.any()).optional(),
  test_mode: z.boolean().optional(),
});

integrations.put('/:category/:provider', requirePermission('settings.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const category = c.req.param('category');
  const provider = c.req.param('provider');

  const meta = findMetadata(category, provider);
  if (!meta) return c.json({ error: 'unknown_adapter' }, 404);

  const body = await c.req.json().catch(() => null);
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  const existing = await loadRow(session.workspace.id, category, provider);

  // Merge incoming secrets over the existing ones (blank password fields are
  // omitted by the frontend → existing value preserved). Then re-encrypt.
  const mergedCreds = { ...decodeCreds(existing?.credentials_b64 ?? null), ...(input.credentials ?? {}) };
  const hasCreds = Object.keys(mergedCreds).length > 0;
  const encB64 = hasCreds ? encryptJson(mergedCreds).toString('base64') : null;

  const mergedConfig = { ...(existing?.config ?? {}), ...(input.config ?? {}) };
  const testMode = input.test_mode ?? existing?.test_mode ?? false;

  await sql`
    INSERT INTO workspace_integrations
      (workspace_id, category, provider, credentials_encrypted, config, test_mode, created_by_user_id)
    VALUES (
      ${session.workspace.id}::uuid, ${category}::text, ${provider}::text,
      CASE WHEN ${encB64}::text IS NULL THEN NULL ELSE decode(${encB64}::text, 'base64') END,
      ${JSON.stringify(mergedConfig)}::jsonb,
      ${testMode}::boolean,
      ${session.user.id}::uuid
    )
    ON CONFLICT (workspace_id, category, provider) DO UPDATE SET
      credentials_encrypted = EXCLUDED.credentials_encrypted,
      config                = EXCLUDED.config,
      test_mode             = EXCLUDED.test_mode,
      updated_at            = now()
  `;

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'integration.configured',
    targetType: 'integration',
    targetId: `${category}:${provider}`,
    payload: { category, provider, credentials_saved: hasCreds, config_keys: Object.keys(mergedConfig) },
    ipAddress, userAgent,
  });

  const row = await loadRow(session.workspace.id, category, provider);
  return c.json({
    configuration: row && {
      is_active: row.is_active, test_mode: row.test_mode, config: row.config ?? {},
      credentials_saved: !!row.credentials_b64,
      last_tested_at: row.last_tested_at, last_test_status: row.last_test_status, last_test_message: row.last_test_message,
    },
  });
});

// ============================================================================
// POST /api/integrations/:category/:provider/activate
// ============================================================================
integrations.post('/:category/:provider/activate', requirePermission('settings.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const category = c.req.param('category');
  const provider = c.req.param('provider');

  const meta = findMetadata(category, provider);
  if (!meta) return c.json({ error: 'unknown_adapter' }, 404);
  // Only functional (implemented) adapters can be activated — activating a
  // stub would route deliveries into a void.
  if (!meta.implemented) return c.json({ error: 'not_implemented' }, 400);

  const row = await loadRow(session.workspace.id, category, provider);
  if (!row) return c.json({ error: 'not_configured' }, 400);
  // Real adapters need credentials; noop needs none.
  if (provider !== 'noop' && !row.credentials_b64) {
    return c.json({ error: 'not_configured', reason: 'credentials_required' }, 400);
  }

  // Deactivate every adapter in this category first (partial unique index only
  // permits one active), then activate the target.
  await sql`
    UPDATE workspace_integrations SET is_active = false, updated_at = now()
    WHERE workspace_id = ${session.workspace.id}::uuid AND category = ${category}::text AND is_active = true
  `;
  await sql`
    UPDATE workspace_integrations SET is_active = true, updated_at = now()
    WHERE workspace_id = ${session.workspace.id}::uuid AND category = ${category}::text AND provider = ${provider}::text
  `;

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'integration.activated',
    targetType: 'integration',
    targetId: `${category}:${provider}`,
    payload: { category, provider },
    ipAddress, userAgent,
  });

  return c.json({ ok: true, category, provider, is_active: true });
});

// ============================================================================
// POST /api/integrations/:category/:provider/deactivate
// ============================================================================
integrations.post('/:category/:provider/deactivate', requirePermission('settings.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const category = c.req.param('category');
  const provider = c.req.param('provider');

  await sql`
    UPDATE workspace_integrations SET is_active = false, updated_at = now()
    WHERE workspace_id = ${session.workspace.id}::uuid AND category = ${category}::text AND provider = ${provider}::text
  `;

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'integration.deactivated',
    targetType: 'integration',
    targetId: `${category}:${provider}`,
    payload: { category, provider },
    ipAddress, userAgent,
  });

  return c.json({ ok: true, category, provider, is_active: false });
});

// ============================================================================
// POST /api/integrations/:category/:provider/test
// ============================================================================
integrations.post('/:category/:provider/test', requirePermission('settings.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const category = c.req.param('category');
  const provider = c.req.param('provider');

  const meta = findMetadata(category, provider);
  if (!meta) return c.json({ error: 'unknown_adapter' }, 404);

  const adapter = findAdapter(category, provider);
  if (!adapter) return c.json({ error: 'not_implemented' }, 400);

  const row = await loadRow(session.workspace.id, category, provider);
  const credentials = decodeCreds(row?.credentials_b64 ?? null);

  let result: { ok: boolean; message: string };
  if (typeof adapter.testConnection === 'function') {
    try {
      result = await adapter.testConnection({ credentials });
    } catch (err) {
      result = { ok: false, message: (err as Error).message || 'test threw' };
    }
  } else {
    result = { ok: true, message: 'This adapter has no connection test.' };
  }

  await sql`
    UPDATE workspace_integrations SET
      last_tested_at = now(),
      last_test_status = ${result.ok ? 'success' : 'failed'}::text,
      last_test_message = ${result.message}::text,
      updated_at = now()
    WHERE workspace_id = ${session.workspace.id}::uuid AND category = ${category}::text AND provider = ${provider}::text
  `;

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'integration.test_run',
    targetType: 'integration',
    targetId: `${category}:${provider}`,
    payload: { category, provider, ok: result.ok },
    ipAddress, userAgent,
  });

  return c.json({ ok: result.ok, message: result.message });
});

// ============================================================================
// DELETE /api/integrations/:category/:provider — remove configuration entirely
// ============================================================================
integrations.delete('/:category/:provider', requirePermission('settings.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const category = c.req.param('category');
  const provider = c.req.param('provider');

  await sql`
    DELETE FROM workspace_integrations
    WHERE workspace_id = ${session.workspace.id}::uuid AND category = ${category}::text AND provider = ${provider}::text
  `;

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'integration.removed',
    targetType: 'integration',
    targetId: `${category}:${provider}`,
    payload: { category, provider },
    ipAddress, userAgent,
  });

  return c.json({ ok: true });
});
