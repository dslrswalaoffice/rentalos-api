import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import {
  loadRecommendations,
  loadManualRecommendations,
  invalidateRecommendationsCache,
} from '../lib/recommendations.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';
import { requirePermission } from '../lib/permissions.js';

// ============================================================================
// src/routes/recommendations.ts  (Sub-turn 8c) — mounted at /api/recommendations
// ----------------------------------------------------------------------------
//   GET    /products/:productId          combined manual+auto list (any member)
//   GET    /products/:productId/manual    manual only (owner/manager)
//   POST   /products/:productId/manual    add manual (owner/manager)
//   POST   /products/:productId/manual/reorder   reorder (owner/manager)
//   DELETE /products/:productId/manual/:recommendedId   remove (owner/manager)
//
// Manual mutations invalidate the 24h co-rental cache for that product.
// ============================================================================

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = { Variables: { session: SessionVar } };

export const recommendations = new Hono<Env>();
recommendations.use('*', sessionMiddleware, requireAuth);

function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

// ============================================================================
// GET /products/:productId — combined recommendations (any member)
// ============================================================================
recommendations.get('/products/:productId', async (c) => {
  const session = c.get('session')!;
  const productId = c.req.param('productId');
  const requested = Number(c.req.query('limit') ?? 6);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(1, requested), 6) : 6;
  const list = await loadRecommendations(session.workspace.id, productId, limit);
  return c.json({ recommendations: list });
});

// ============================================================================
// GET /products/:productId/manual — manual only (owner/manager, for editing UI)
// ============================================================================
recommendations.get('/products/:productId/manual', requirePermission('inventory.manage'), async (c) => {
  const session = c.get('session')!;
  const productId = c.req.param('productId');
  const manual = await loadManualRecommendations(session.workspace.id, productId);
  return c.json({ recommendations: manual });
});

// ============================================================================
// POST /products/:productId/manual — add a manual recommendation (owner/manager)
// ============================================================================
const addSchema = z.object({
  recommended_product_id: z.string().uuid(),
  sort_order: z.number().int().default(0),
  note: z.string().max(200).nullable().optional(),
});

recommendations.post('/products/:productId/manual', requirePermission('inventory.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const productId = c.req.param('productId');

  const body = await c.req.json().catch(() => null);
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  if (productId === input.recommended_product_id) {
    return c.json({ error: 'cannot_recommend_self' }, 400);
  }

  // Both products must belong to the workspace (source + recommended).
  const found = await query<{ id: string }>(sql`
    SELECT id FROM products
    WHERE id IN (${productId}::uuid, ${input.recommended_product_id}::uuid)
      AND workspace_id = ${session.workspace.id}::uuid
      AND deleted_at IS NULL
  `);
  if (found.length < 2) return c.json({ error: 'product_not_found' }, 404);

  // Guard the UNIQUE constraint with a friendly error (idempotent-ish).
  const existing = await query<{ id: string }>(sql`
    SELECT id FROM product_recommendations
    WHERE workspace_id = ${session.workspace.id}::uuid
      AND source_product_id = ${productId}::uuid
      AND recommended_product_id = ${input.recommended_product_id}::uuid
    LIMIT 1
  `);
  if (existing.length) return c.json({ error: 'already_recommended' }, 409);

  const inserted = await query<{ id: string }>(sql`
    INSERT INTO product_recommendations
      (workspace_id, source_product_id, recommended_product_id, sort_order, note, created_by_user_id)
    VALUES (
      ${session.workspace.id}::uuid, ${productId}::uuid, ${input.recommended_product_id}::uuid,
      ${input.sort_order}::int, ${input.note ?? null}::text, ${session.user.id}::uuid
    )
    RETURNING id
  `);

  invalidateRecommendationsCache(session.workspace.id, productId);

  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id,
    eventType: 'recommendations.created', targetType: 'product', targetId: productId,
    payload: { recommendation_id: inserted[0]!.id, recommended_product_id: input.recommended_product_id, note: input.note ?? null },
    ipAddress, userAgent,
  });

  return c.json({ recommendation: { id: inserted[0]!.id, recommended_product_id: input.recommended_product_id, sort_order: input.sort_order, note: input.note ?? null } }, 201);
});

// ============================================================================
// POST /products/:productId/manual/reorder — batch sort_order (owner/manager)
// Neon HTTP has no transactions: sequential, workspace + source scoped.
// (Registered before the :recommendedId DELETE; different methods anyway.)
// ============================================================================
const reorderSchema = z.object({ recommended_product_ids: z.array(z.string().uuid()).max(100) });

recommendations.post('/products/:productId/manual/reorder', requirePermission('inventory.manage'), async (c) => {
  const session = c.get('session')!;
  const productId = c.req.param('productId');

  const body = await c.req.json().catch(() => null);
  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);

  const ids = parsed.data.recommended_product_ids;
  for (let i = 0; i < ids.length; i++) {
    await sql`
      UPDATE product_recommendations SET sort_order = ${i}::int, updated_at = now()
      WHERE workspace_id = ${session.workspace.id}::uuid
        AND source_product_id = ${productId}::uuid
        AND recommended_product_id = ${ids[i]}::uuid
    `;
  }
  invalidateRecommendationsCache(session.workspace.id, productId);
  return c.json({ ok: true });
});

// ============================================================================
// DELETE /products/:productId/manual/:recommendedId — remove (owner/manager)
// ============================================================================
recommendations.delete('/products/:productId/manual/:recommendedId', requirePermission('inventory.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const productId = c.req.param('productId');
  const recommendedId = c.req.param('recommendedId');

  const deleted = await query<{ id: string }>(sql`
    DELETE FROM product_recommendations
    WHERE workspace_id = ${session.workspace.id}::uuid
      AND source_product_id = ${productId}::uuid
      AND recommended_product_id = ${recommendedId}::uuid
    RETURNING id
  `);
  if (!deleted.length) return c.json({ error: 'not_found' }, 404);

  invalidateRecommendationsCache(session.workspace.id, productId);

  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id,
    eventType: 'recommendations.removed', targetType: 'product', targetId: productId,
    payload: { recommended_product_id: recommendedId },
    ipAddress, userAgent,
  });

  return c.json({ ok: true });
});
