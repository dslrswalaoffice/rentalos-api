import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import {
  sessionMiddleware, requireAuth,
  type SessionUser, type SessionWorkspace,
} from '../middleware/session.js';
import { requirePermission, can } from '../lib/permissions.js';
import { idempotencyMiddleware } from '../lib/idempotency.js';
import {
  createSubstitution, executeSubstitution, revertSubstitution, approveSubstitution, rejectSubstitution,
  isFinancialSubstitution, SUBSTITUTION_TYPES, SUBSTITUTION_REASON_TAGS, FINANCIAL_HANDLINGS,
  SUBSTITUTION_TIMINGS, SUBSTITUTION_SOURCE_TYPES, type SubstitutionType, type FinancialHandling,
} from '../lib/substitutions.js';

// ============================================================================
// src/routes/substitutions.ts (Sub-slice 2.3)
// ----------------------------------------------------------------------------
// TWO routers, split by prefix (avoids the PR #80 double-mount trap):
//   * orderSubstitutions — order-scoped (/api/orders/:id/substitutions). FOLDED
//     INTO the orders router (orders.route('/', orderSubstitutions)); it declares
//     NO global middleware — the parent orders router provides session + auth +
//     idempotency exactly once.
//   * substitutions — id-scoped (/api/substitutions/:id/...). A SEPARATE prefix,
//     so it safely carries its OWN session + auth + idempotency middleware.
// ============================================================================
type SessionVar = { sessionId: string; user: SessionUser; workspace: SessionWorkspace } | null;
type Env = { Variables: { session: SessionVar } };

function clientCtx(c: Context) {
  const ipAddress = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null;
  return { ipAddress, userAgent: c.req.header('user-agent') ?? null };
}

// Rule A — the exact shape new-order/order-360 POSTs. UUIDs validated; taxonomies
// pinned to the DB CHECK vocabularies (imported constants, single source).
export const substitutionCreateSchema = z.object({
  original_order_item_id: z.string().uuid(),
  original_asset_id: z.string().uuid().nullish(),
  replacement_product_id: z.string().uuid().nullish(),
  replacement_asset_id: z.string().uuid().nullish(),
  substitution_type: z.enum(SUBSTITUTION_TYPES),
  reason_tag: z.enum(SUBSTITUTION_REASON_TAGS),
  reason_notes: z.string().max(2000).nullish(),
  financial_handling: z.enum(FINANCIAL_HANDLINGS).nullish(),
  financial_amount_paise: z.number().int().min(0).nullish(),
  pro_rated_days: z.number().int().min(0).max(365).nullish(),
  timing: z.enum(SUBSTITUTION_TIMINGS),
  scheduled_at: z.string().datetime().nullish(),
  source_type: z.enum(SUBSTITUTION_SOURCE_TYPES).nullish(),
  source_id: z.string().uuid().nullish(),
});
export const substitutionRevertSchema = z.object({ reason: z.string().max(2000).nullish() });
export const substitutionRejectSchema = z.object({ reason: z.string().max(2000).nullish() });

// ---------------------------------------------------------------------------
// Order-scoped (folded into orders router — NO global middleware here).
// ---------------------------------------------------------------------------
export const orderSubstitutions = new Hono<Env>();

async function orderExists(orderId: string, workspaceId: string): Promise<boolean> {
  const r = await query<{ id: string }>(sql`SELECT id FROM orders WHERE id = ${orderId}::uuid AND workspace_id = ${workspaceId}::uuid AND deleted_at IS NULL LIMIT 1`);
  return r.length > 0;
}

orderSubstitutions.get('/:id/substitutions', async (c) => {
  const session = c.get('session')!;
  const rows = await query<any>(sql`
    SELECT s.*, oi.description AS original_item_description, ri.description AS replacement_item_description
    FROM substitutions s
    LEFT JOIN order_items oi ON oi.id = s.original_order_item_id
    LEFT JOIN order_items ri ON ri.id = s.replacement_order_item_id
    WHERE s.order_id = ${c.req.param('id')}::uuid AND s.workspace_id = ${session.workspace.id}::uuid
    ORDER BY s.created_at DESC
  `);
  return c.json({ substitutions: rows });
});

orderSubstitutions.post('/:id/substitutions', requirePermission('substitutions.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  if (!(await orderExists(id, session.workspace.id))) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = substitutionCreateSchema.safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  // Money-touching swaps require the financial permission (staff/warehouse blocked).
  const financial = isFinancialSubstitution(p.substitution_type as SubstitutionType, (p.financial_handling ?? 'no_change') as FinancialHandling);
  if (financial && !can(session, 'substitutions.financial')) {
    return c.json({ error: 'forbidden', required_permission: ['substitutions.financial'] }, 403);
  }

  const r = await createSubstitution({
    workspaceId: session.workspace.id, orderId: id, actorUserId: session.user.id,
    originalOrderItemId: p.original_order_item_id, originalAssetId: p.original_asset_id ?? null,
    replacementProductId: p.replacement_product_id ?? null, replacementAssetId: p.replacement_asset_id ?? null,
    substitutionType: p.substitution_type as SubstitutionType, reasonTag: p.reason_tag, reasonNotes: p.reason_notes ?? null,
    financialHandling: (p.financial_handling ?? null) as FinancialHandling | null, financialAmountPaise: p.financial_amount_paise ?? null,
    proRatedDays: p.pro_rated_days ?? null, timing: p.timing, scheduledAt: p.scheduled_at ?? null,
    sourceType: p.source_type ?? 'direct', sourceId: p.source_id ?? null, ip: ipAddress, userAgent,
  });
  if (!r.ok) {
    const code = r.error === 'order_not_found' || r.error === 'original_item_not_found' ? 404 : 409;
    return c.json({ error: r.error }, code);
  }
  return c.json({ substitution: r.substitution, requires_approval: r.requires_approval }, 201);
});

// ---------------------------------------------------------------------------
// Id-scoped (standalone /api/substitutions — own middleware, distinct prefix).
// ---------------------------------------------------------------------------
export const substitutions = new Hono<Env>();
substitutions.use('*', sessionMiddleware, requireAuth);
substitutions.use('*', idempotencyMiddleware);

async function loadSub(id: string, workspaceId: string): Promise<{ id: string; order_id: string; financial_handling: string; substitution_type: string } | null> {
  return (await query<{ id: string; order_id: string; financial_handling: string; substitution_type: string }>(sql`
    SELECT id, order_id, financial_handling, substitution_type FROM substitutions WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid LIMIT 1
  `))[0] ?? null;
}

substitutions.get('/:id', async (c) => {
  const session = c.get('session')!;
  const row = (await query<any>(sql`
    SELECT s.*, oi.description AS original_item_description, ri.description AS replacement_item_description
    FROM substitutions s
    LEFT JOIN order_items oi ON oi.id = s.original_order_item_id
    LEFT JOIN order_items ri ON ri.id = s.replacement_order_item_id
    WHERE s.id = ${c.req.param('id')}::uuid AND s.workspace_id = ${session.workspace.id}::uuid LIMIT 1
  `))[0];
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ substitution: row });
});

substitutions.post('/:id/execute', requirePermission('substitutions.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const sub = await loadSub(c.req.param('id'), session.workspace.id);
  if (!sub) return c.json({ error: 'not_found' }, 404);
  if (isFinancialSubstitution(sub.substitution_type as SubstitutionType, sub.financial_handling as FinancialHandling) && !can(session, 'substitutions.financial')) {
    return c.json({ error: 'forbidden', required_permission: ['substitutions.financial'] }, 403);
  }
  const r = await executeSubstitution({ workspaceId: session.workspace.id, orderId: sub.order_id, substitutionId: sub.id, actorUserId: session.user.id, ip: ipAddress, userAgent });
  if (!r.ok) return c.json({ error: r.error }, r.error === 'not_found' ? 404 : 409);
  return c.json({ executed: true, substitution: r.substitution });
});

substitutions.post('/:id/revert', requirePermission('substitutions.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = substitutionRevertSchema.safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const sub = await loadSub(c.req.param('id'), session.workspace.id);
  if (!sub) return c.json({ error: 'not_found' }, 404);
  const r = await revertSubstitution({ workspaceId: session.workspace.id, orderId: sub.order_id, substitutionId: sub.id, actorUserId: session.user.id, reason: parsed.data.reason ?? null, ip: ipAddress, userAgent });
  if (!r.ok) return c.json({ error: r.error }, 409);
  return c.json({ reverted: true });
});

substitutions.post('/:id/approve', requirePermission('substitutions.financial'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const sub = await loadSub(c.req.param('id'), session.workspace.id);
  if (!sub) return c.json({ error: 'not_found' }, 404);
  const r = await approveSubstitution({ workspaceId: session.workspace.id, orderId: sub.order_id, substitutionId: sub.id, actorUserId: session.user.id, ip: ipAddress, userAgent });
  if (!r.ok) return c.json({ error: r.error }, 409);
  return c.json({ approved: true });
});

substitutions.post('/:id/reject', requirePermission('substitutions.financial'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = substitutionRejectSchema.safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const sub = await loadSub(c.req.param('id'), session.workspace.id);
  if (!sub) return c.json({ error: 'not_found' }, 404);
  const r = await rejectSubstitution({ workspaceId: session.workspace.id, orderId: sub.order_id, substitutionId: sub.id, actorUserId: session.user.id, reason: parsed.data.reason ?? null, ip: ipAddress, userAgent });
  if (!r.ok) return c.json({ error: r.error }, 409);
  return c.json({ rejected: true });
});
