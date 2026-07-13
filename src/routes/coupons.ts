import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import { emitNotification } from '../lib/notify.js';
import { recomputeOrderTotals } from '../lib/pricing.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';
import { requirePermission } from '../lib/permissions.js';

// ============================================================================
// src/routes/coupons.ts  (Sub-turn 8b) — mounted at /api/coupons
// ----------------------------------------------------------------------------
// Reusable discount codes. CRUD is owner/manager; validate/apply/remove are any
// authenticated member. The discount itself is materialised as an
// order_items row (item_type='discount', negative total) by recomputeOrderTotals
// — this route only manages the coupon definitions + the redemption records and
// triggers a recompute. GST-on-discounted-base + revision reuse come for free.
//
// v1 scope: whole-order discount, one coupon per order, no stacking. Codes are
// UPPERCASE-normalised on create + lookup.
// ============================================================================

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = { Variables: { session: SessionVar } };

export const coupons = new Hono<Env>();
coupons.use('*', sessionMiddleware, requireAuth);

function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

// Coupon-eligible subtotal = the SUBTOTAL_TYPES from pricing.ts (rental,
// delivery_fee, late_fee, damage, other). Deposits/tax/discount are excluded.
// The list is written as a static literal inside each query (no sql.unsafe).

type CouponRow = {
  id: string; workspace_id: string; code: string; description: string | null;
  discount_type: string; discount_value: number; max_discount_paise: number | null;
  min_order_paise: number; valid_from: string | null; valid_until: string | null;
  max_uses_total: number | null; max_uses_per_customer: number | null;
  is_active: boolean; created_at: string; updated_at: string;
};

// Pure discount computation (fixed or capped-percentage), clamped to subtotal.
function computeDiscount(coupon: {
  discount_type: string; discount_value: number; max_discount_paise: number | null;
}, subtotalPaise: number): number {
  let d = 0;
  if (coupon.discount_type === 'fixed') {
    d = Number(coupon.discount_value);
  } else {
    d = Math.floor((subtotalPaise * Number(coupon.discount_value)) / 100);
    if (coupon.max_discount_paise != null && d > Number(coupon.max_discount_paise)) {
      d = Number(coupon.max_discount_paise);
    }
  }
  return Math.max(0, Math.min(d, subtotalPaise));
}

// ============================================================================
// GET /api/coupons — list (owner/manager)
// ============================================================================
coupons.get('/', requirePermission('orders.apply_discount'), async (c) => {
  const session = c.get('session')!;
  const rows = await query<CouponRow & { active_uses: number; total_redemptions: number }>(sql`
    SELECT c.*,
      (SELECT COUNT(*)::int FROM coupon_redemptions cr WHERE cr.coupon_id = c.id AND cr.removed_at IS NULL) AS active_uses,
      (SELECT COUNT(*)::int FROM coupon_redemptions cr WHERE cr.coupon_id = c.id) AS total_redemptions
    FROM coupons c
    WHERE c.workspace_id = ${session.workspace.id}::uuid
    ORDER BY c.is_active DESC, c.created_at DESC
  `);
  return c.json({ coupons: rows });
});

// ============================================================================
// POST /api/coupons — create (owner/manager)
// ============================================================================
const createSchema = z.object({
  code: z.string().min(2).max(30).regex(/^[A-Za-z0-9_-]+$/, 'Alphanumeric with _ and -'),
  description: z.string().max(500).nullable().optional(),
  discount_type: z.enum(['percentage', 'fixed']),
  discount_value: z.number().int().positive(),
  max_discount_paise: z.number().int().positive().nullable().optional(),
  min_order_paise: z.number().int().nonnegative().default(0),
  valid_from: z.string().datetime().nullable().optional(),
  valid_until: z.string().datetime().nullable().optional(),
  max_uses_total: z.number().int().positive().nullable().optional(),
  max_uses_per_customer: z.number().int().positive().nullable().optional(),
});

coupons.post('/', requirePermission('orders.apply_discount'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);

  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  if (input.discount_type === 'percentage' && input.discount_value > 100) {
    return c.json({ error: 'percentage_too_high' }, 400);
  }
  if (input.valid_from && input.valid_until && new Date(input.valid_from) >= new Date(input.valid_until)) {
    return c.json({ error: 'invalid_date_range' }, 400);
  }

  const code = input.code.toUpperCase();

  const existing = await query<{ id: string }>(sql`
    SELECT id FROM coupons WHERE workspace_id = ${session.workspace.id}::uuid AND code = ${code}::text LIMIT 1
  `);
  if (existing.length) return c.json({ error: 'code_taken' }, 409);

  const inserted = await query<CouponRow>(sql`
    INSERT INTO coupons (
      workspace_id, code, description, discount_type, discount_value, max_discount_paise,
      min_order_paise, valid_from, valid_until, max_uses_total, max_uses_per_customer, created_by_user_id
    ) VALUES (
      ${session.workspace.id}::uuid, ${code}::text, ${input.description ?? null}::text,
      ${input.discount_type}::text, ${input.discount_value}::bigint, ${input.max_discount_paise ?? null}::bigint,
      ${input.min_order_paise}::bigint, ${input.valid_from ?? null}::timestamptz, ${input.valid_until ?? null}::timestamptz,
      ${input.max_uses_total ?? null}::int, ${input.max_uses_per_customer ?? null}::int, ${session.user.id}::uuid
    )
    RETURNING *
  `);

  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id,
    eventType: 'coupons.created', targetType: 'coupon', targetId: inserted[0]!.id,
    payload: { code, discount_type: input.discount_type, discount_value: input.discount_value },
    ipAddress, userAgent,
  });

  return c.json({ coupon: inserted[0] }, 201);
});

// ============================================================================
// POST /api/coupons/validate — preview discount without applying (any member)
// ============================================================================
const validateSchema = z.object({ code: z.string(), order_id: z.string().uuid() });

type ValidateContext =
  | { ok: true; coupon: CouponRow; order: { id: string; customer_person_id: string | null; order_number: number; customer_name: string | null }; subtotal: number; discount: number }
  | { ok: false; status: number; body: Record<string, unknown> };

// Shared validation used by /validate and /apply.
async function validateCoupon(workspaceId: string, code: string, orderId: string): Promise<ValidateContext> {
  const normalized = code.toUpperCase();

  const couponRows = await query<CouponRow>(sql`
    SELECT * FROM coupons
    WHERE workspace_id = ${workspaceId}::uuid AND code = ${normalized}::text AND is_active = true
    LIMIT 1
  `);
  if (!couponRows.length) {
    return { ok: false, status: 200, body: { valid: false, reason: 'not_found', message: 'Coupon code not found or inactive' } };
  }
  const coupon = couponRows[0]!;

  const orderRows = await query<{ id: string; customer_person_id: string | null; status: string; order_number: number; customer_name: string | null; subtotal_paise: string | number }>(sql`
    SELECT o.id, o.customer_person_id, o.status::text AS status, o.order_number,
           p.display_name AS customer_name,
           (SELECT COALESCE(SUM(oi.total_amount_paise), 0)::bigint
            FROM order_items oi
            WHERE oi.order_id = o.id AND oi.workspace_id = o.workspace_id
              AND oi.item_type::text IN ('rental', 'delivery_fee', 'late_fee', 'damage', 'other')) AS subtotal_paise
    FROM orders o
    LEFT JOIN people p ON p.id = o.customer_person_id
    WHERE o.id = ${orderId}::uuid AND o.workspace_id = ${workspaceId}::uuid AND o.deleted_at IS NULL
    LIMIT 1
  `);
  if (!orderRows.length) return { ok: false, status: 404, body: { error: 'order_not_found' } };
  const order = orderRows[0]!;
  const subtotal = Number(order.subtotal_paise);

  // A closed/cancelled order can't be re-priced, so a coupon can't apply.
  if (order.status === 'closed' || order.status === 'cancelled') {
    return { ok: false, status: 200, body: { valid: false, reason: 'order_locked', message: `Order is ${order.status} and can't take a coupon` } };
  }

  const now = new Date();
  if (coupon.valid_from && new Date(coupon.valid_from) > now) {
    return { ok: false, status: 200, body: { valid: false, reason: 'not_yet_valid', message: 'Coupon is not valid yet' } };
  }
  if (coupon.valid_until && new Date(coupon.valid_until) < now) {
    return { ok: false, status: 200, body: { valid: false, reason: 'expired', message: 'Coupon has expired' } };
  }
  if (subtotal < Number(coupon.min_order_paise)) {
    return { ok: false, status: 200, body: { valid: false, reason: 'below_min_order', message: `Order subtotal ₹${Math.round(subtotal / 100)} is below the minimum ₹${Math.round(Number(coupon.min_order_paise) / 100)}` } };
  }

  if (coupon.max_uses_total != null) {
    const usage = await query<{ c: number }>(sql`
      SELECT COUNT(*)::int AS c FROM coupon_redemptions WHERE coupon_id = ${coupon.id}::uuid AND removed_at IS NULL
    `);
    if (Number(usage[0]?.c ?? 0) >= Number(coupon.max_uses_total)) {
      return { ok: false, status: 200, body: { valid: false, reason: 'usage_limit_reached', message: 'Coupon usage limit reached' } };
    }
  }

  if (coupon.max_uses_per_customer != null && order.customer_person_id) {
    const custUse = await query<{ c: number }>(sql`
      SELECT COUNT(*)::int AS c FROM coupon_redemptions
      WHERE coupon_id = ${coupon.id}::uuid AND customer_person_id = ${order.customer_person_id}::uuid AND removed_at IS NULL
    `);
    if (Number(custUse[0]?.c ?? 0) >= Number(coupon.max_uses_per_customer)) {
      return { ok: false, status: 200, body: { valid: false, reason: 'customer_limit_reached', message: 'This customer has already used this coupon the maximum number of times' } };
    }
  }

  const activeRows = await query<{ id: string }>(sql`
    SELECT id FROM coupon_redemptions WHERE order_id = ${orderId}::uuid AND removed_at IS NULL LIMIT 1
  `);
  if (activeRows.length) {
    return { ok: false, status: 200, body: { valid: false, reason: 'order_has_coupon', message: 'Another coupon is already applied to this order' } };
  }

  const discount = computeDiscount(coupon, subtotal);
  return { ok: true, coupon, order: { id: order.id, customer_person_id: order.customer_person_id, order_number: Number(order.order_number), customer_name: order.customer_name }, subtotal, discount };
}

coupons.post('/validate', requirePermission('orders.apply_discount'), async (c) => {
  const session = c.get('session')!;
  const body = await c.req.json().catch(() => null);
  const parsed = validateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);

  const res = await validateCoupon(session.workspace.id, parsed.data.code, parsed.data.order_id);
  if (!res.ok) return c.json(res.body, res.status as 200 | 400 | 404);

  return c.json({
    valid: true,
    coupon: {
      id: res.coupon.id, code: res.coupon.code, description: res.coupon.description,
      discount_type: res.coupon.discount_type, discount_value: Number(res.coupon.discount_value),
    },
    preview: {
      subtotal_paise: res.subtotal,
      discount_paise: res.discount,
      new_subtotal_paise: res.subtotal - res.discount,
    },
  });
});

// ============================================================================
// POST /api/coupons/apply — apply to an order + recompute (any member)
// ============================================================================
coupons.post('/apply', requirePermission('orders.apply_discount'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const body = await c.req.json().catch(() => null);
  const parsed = validateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);

  const res = await validateCoupon(session.workspace.id, parsed.data.code, parsed.data.order_id);
  if (!res.ok) {
    // A failed validation with valid:false is a 400 for the apply flow.
    if ('valid' in res.body && res.body.valid === false) {
      const reason = res.body.reason;
      const status = reason === 'not_found' ? 404 : 400;
      return c.json(res.body, status as 400 | 404);
    }
    return c.json(res.body, res.status as 400 | 404);
  }

  // Record the redemption (partial unique index backstops one-active-per-order).
  try {
    await sql`
      INSERT INTO coupon_redemptions (
        workspace_id, coupon_id, order_id, customer_person_id,
        discount_paise_applied, subtotal_at_apply_paise, applied_by_user_id
      ) VALUES (
        ${session.workspace.id}::uuid, ${res.coupon.id}::uuid, ${res.order.id}::uuid,
        ${res.order.customer_person_id ?? null}::uuid,
        ${res.discount}::bigint, ${res.subtotal}::bigint, ${session.user.id}::uuid
      )
    `;
  } catch {
    return c.json({ error: 'order_has_coupon' }, 409);
  }

  // Recompute materialises the discount line + refreshes totals + GST.
  try {
    await recomputeOrderTotals(res.order.id, session.workspace.id, session.user.id);
  } catch (err) {
    // Recompute can throw on locked orders — surface but the redemption stands.
    console.error('coupon apply recompute failed', err);
  }

  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id,
    eventType: 'coupons.applied', targetType: 'order', targetId: res.order.id,
    payload: { coupon_id: res.coupon.id, code: res.coupon.code, discount_paise: res.discount },
    ipAddress, userAgent,
  });

  emitNotification({
    workspaceId: session.workspace.id, actorUserId: session.user.id,
    eventType: 'order.coupon.applied', targetType: 'order', targetId: res.order.id,
    linkUrl: `/order.html?id=${res.order.id}`,
    metadata: {
      code: res.coupon.code, discount: Math.round(res.discount / 100),
      order_number: res.order.order_number, customer_name: res.order.customer_name ?? 'Customer',
    },
  }).catch(() => {});

  return c.json({ ok: true, discount_paise: res.discount });
});

// ============================================================================
// POST /api/coupons/remove — remove active redemption + recompute (any member)
// ============================================================================
const removeSchema = z.object({ order_id: z.string().uuid() });

coupons.post('/remove', requirePermission('orders.apply_discount'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const body = await c.req.json().catch(() => null);
  const parsed = removeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);

  const removed = await query<{ id: string; coupon_id: string; discount_paise_applied: number }>(sql`
    UPDATE coupon_redemptions
    SET removed_at = now(), removed_by_user_id = ${session.user.id}::uuid
    WHERE order_id = ${parsed.data.order_id}::uuid
      AND workspace_id = ${session.workspace.id}::uuid
      AND removed_at IS NULL
    RETURNING id, coupon_id, discount_paise_applied
  `);
  if (!removed.length) return c.json({ error: 'no_active_redemption' }, 404);

  try {
    await recomputeOrderTotals(parsed.data.order_id, session.workspace.id, session.user.id);
  } catch (err) {
    console.error('coupon remove recompute failed', err);
  }

  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id,
    eventType: 'coupons.removed', targetType: 'order', targetId: parsed.data.order_id,
    payload: { coupon_id: removed[0]!.coupon_id, redemption_id: removed[0]!.id, discount_paise: Number(removed[0]!.discount_paise_applied) },
    ipAddress, userAgent,
  });

  return c.json({ ok: true });
});

// ============================================================================
// GET /api/coupons/:id — single coupon + recent redemptions (owner/manager)
// :id is UUID-constrained so the literal /validate,/apply,/remove POST paths and
// (defensively) any future literal GET path can't be captured as an id.
// ============================================================================
coupons.get('/:id{[0-9a-fA-F-]{36}}', requirePermission('orders.apply_discount'), async (c) => {
  const session = c.get('session')!;
  const id = c.req.param('id');
  const rows = await query<CouponRow & { active_uses: number; total_redemptions: number }>(sql`
    SELECT c.*,
      (SELECT COUNT(*)::int FROM coupon_redemptions cr WHERE cr.coupon_id = c.id AND cr.removed_at IS NULL) AS active_uses,
      (SELECT COUNT(*)::int FROM coupon_redemptions cr WHERE cr.coupon_id = c.id) AS total_redemptions
    FROM coupons c
    WHERE c.id = ${id}::uuid AND c.workspace_id = ${session.workspace.id}::uuid
    LIMIT 1
  `);
  if (!rows.length) return c.json({ error: 'not_found' }, 404);

  const redemptions = await query<{
    id: string; order_id: string; order_number: number; customer_name: string | null;
    discount_paise_applied: number; applied_at: string; removed_at: string | null;
  }>(sql`
    SELECT cr.id, cr.order_id, o.order_number, p.display_name AS customer_name,
           cr.discount_paise_applied, cr.applied_at, cr.removed_at
    FROM coupon_redemptions cr
    JOIN orders o ON o.id = cr.order_id
    LEFT JOIN people p ON p.id = cr.customer_person_id
    WHERE cr.coupon_id = ${id}::uuid AND cr.workspace_id = ${session.workspace.id}::uuid
    ORDER BY cr.applied_at DESC
    LIMIT 20
  `);

  return c.json({ coupon: rows[0], redemptions });
});

// ============================================================================
// PATCH /api/coupons/:id — update (owner/manager). Code is immutable.
// ============================================================================
const updateSchema = z.object({
  description: z.string().max(500).nullable().optional(),
  discount_type: z.enum(['percentage', 'fixed']).optional(),
  discount_value: z.number().int().positive().optional(),
  max_discount_paise: z.number().int().positive().nullable().optional(),
  min_order_paise: z.number().int().nonnegative().optional(),
  valid_from: z.string().datetime().nullable().optional(),
  valid_until: z.string().datetime().nullable().optional(),
  max_uses_total: z.number().int().positive().nullable().optional(),
  max_uses_per_customer: z.number().int().positive().nullable().optional(),
  is_active: z.boolean().optional(),
});

coupons.patch('/:id{[0-9a-fA-F-]{36}}', requirePermission('orders.apply_discount'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  if (p.discount_type === 'percentage' && p.discount_value != null && p.discount_value > 100) {
    return c.json({ error: 'percentage_too_high' }, 400);
  }

  const updated = await query<CouponRow>(sql`
    UPDATE coupons SET
      description           = CASE WHEN ${p.description !== undefined}::boolean THEN ${p.description ?? null}::text ELSE description END,
      discount_type         = COALESCE(${p.discount_type ?? null}::text, discount_type),
      discount_value        = COALESCE(${p.discount_value ?? null}::bigint, discount_value),
      max_discount_paise    = CASE WHEN ${p.max_discount_paise !== undefined}::boolean THEN ${p.max_discount_paise ?? null}::bigint ELSE max_discount_paise END,
      min_order_paise       = COALESCE(${p.min_order_paise ?? null}::bigint, min_order_paise),
      valid_from            = CASE WHEN ${p.valid_from !== undefined}::boolean THEN ${p.valid_from ?? null}::timestamptz ELSE valid_from END,
      valid_until           = CASE WHEN ${p.valid_until !== undefined}::boolean THEN ${p.valid_until ?? null}::timestamptz ELSE valid_until END,
      max_uses_total        = CASE WHEN ${p.max_uses_total !== undefined}::boolean THEN ${p.max_uses_total ?? null}::int ELSE max_uses_total END,
      max_uses_per_customer = CASE WHEN ${p.max_uses_per_customer !== undefined}::boolean THEN ${p.max_uses_per_customer ?? null}::int ELSE max_uses_per_customer END,
      is_active             = COALESCE(${p.is_active ?? null}::boolean, is_active),
      updated_at            = now()
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    RETURNING *
  `);
  if (!updated.length) return c.json({ error: 'not_found' }, 404);

  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id,
    eventType: 'coupons.updated', targetType: 'coupon', targetId: id,
    payload: { fields: Object.keys(p) }, ipAddress, userAgent,
  });

  return c.json({ coupon: updated[0] });
});

// ============================================================================
// DELETE /api/coupons/:id — soft-delete (deactivate). Redemptions preserved.
// ============================================================================
coupons.delete('/:id{[0-9a-fA-F-]{36}}', requirePermission('orders.apply_discount'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const updated = await query<{ id: string }>(sql`
    UPDATE coupons SET is_active = false, updated_at = now()
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid AND is_active = true
    RETURNING id
  `);
  if (!updated.length) return c.json({ error: 'not_found' }, 404);

  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id,
    eventType: 'coupons.deactivated', targetType: 'coupon', targetId: id,
    payload: {}, ipAddress, userAgent,
  });

  return c.json({ ok: true });
});
