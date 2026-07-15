import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import { emitNotification } from '../lib/notify.js';
import {
  sessionMiddleware, requireAuth, type SessionUser, type SessionWorkspace,
} from '../middleware/session.js';
import { requirePermission } from '../lib/permissions.js';
import { idempotencyMiddleware } from '../lib/idempotency.js';
import { orderBlock, reason as reasonB } from '../lib/blocked_action.js';
import { loadWorkspaceSettings, createApprovalRequest } from '../lib/approvals.js';
import { getDefaultLocationId } from '../lib/availability.js';
import { recomputeOrderTotals } from '../lib/pricing.js';
import { createQuoteVersionFromOrder } from '../lib/quotes.js';
import {
  STANDBY_REASON_TAGS, STANDBY_VIA, computeStandbySegment, generateStandbyNumber,
  standbyPolicy, activeHoldCount, releaseStandbyHold,
} from '../lib/standby.js';

// ============================================================================
// src/routes/standbys.ts (Sub-slice 2.2) — /api/standbys
// ============================================================================
type SessionVar = { sessionId: string; user: SessionUser; workspace: SessionWorkspace } | null;
type Env = { Variables: { session: SessionVar } };

export const standbys = new Hono<Env>();
standbys.use('*', sessionMiddleware, requireAuth);
standbys.use('*', idempotencyMiddleware);

function clientCtx(c: Context) {
  const ipAddress = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null;
  return { ipAddress, userAgent: c.req.header('user-agent') ?? null };
}
const MS_PER_MIN = 60_000;

async function loadStandby(id: string, workspaceId: string) {
  const rows = await query<any>(sql`
    SELECT s.*, p.display_name AS customer_name, p.phone AS customer_phone, p.email AS customer_email,
           o.order_number
    FROM standbys s
    JOIN people p ON p.id = s.customer_id
    LEFT JOIN orders o ON o.id = s.order_id
    WHERE s.id = ${id}::uuid AND s.workspace_id = ${workspaceId}::uuid LIMIT 1
  `);
  return rows[0] ?? null;
}

// ----------------------------------------------------------------------------
// POST /api/standbys — create a standby (backing order + soft-reserved lines).
// ----------------------------------------------------------------------------
export const standbyCreateSchema = z.object({
  customer_id: z.string().uuid(),
  rental_start_at: z.string().datetime(),
  rental_end_at: z.string().datetime(),
  line_items: z.array(z.object({ product_id: z.string().uuid(), quantity: z.number().int().positive().default(1) })).min(1),
  requested_via: z.enum(STANDBY_VIA),
  reason_tag: z.enum(STANDBY_REASON_TAGS),
  reason_notes: z.string().max(2000).optional(),
  hold_duration_minutes: z.number().int().positive().optional(),
  pickup_location_id: z.string().uuid().optional(),
});

standbys.post('/', requirePermission('orders.create'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const body = await c.req.json().catch(() => null);
  const parsed = standbyCreateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  if (new Date(p.rental_end_at) <= new Date(p.rental_start_at)) {
    return c.json({ error: 'invalid_request', reason: 'end_before_start' }, 400);
  }
  const customer = (await query<{ id: string; display_name: string }>(sql`
    SELECT id, display_name FROM people WHERE id = ${p.customer_id}::uuid AND workspace_id = ${session.workspace.id}::uuid AND deleted_at IS NULL LIMIT 1
  `))[0];
  if (!customer) return c.json({ error: 'customer_not_found' }, 404);

  const settings = await loadWorkspaceSettings(session.workspace.id);
  const pol = standbyPolicy(settings);

  // Concurrent-hold cap by segment.
  const segment = await computeStandbySegment(session.workspace.id, p.customer_id);
  const cap = Number(pol.concurrent_holds_cap_by_segment?.[segment] ?? 1);
  const held = await activeHoldCount(session.workspace.id, p.customer_id);
  const capOverride = pol.requires_approval?.cap_override === true;
  if (held >= cap && !capOverride) {
    return c.json(orderBlock('STANDBY_BLOCKED', 'Concurrent hold cap reached', [
      reasonB('policy', 'HOLD_CAP_REACHED', `This customer already holds ${held} of ${cap} allowed standbys (${segment}).`),
    ]), 409);
  }

  // Hold duration — default from policy, clamped to the role max.
  const roleMax = Number(pol.max_hold_duration_by_role?.[session.user.role] ?? pol.default_hold_duration_minutes ?? 240);
  const holdMinutes = Math.min(p.hold_duration_minutes ?? Number(pol.default_hold_duration_minutes ?? 240), roleMax);
  const graceMinutes = Number(pol.grace_period_minutes ?? 0);

  // Location.
  const locId = p.pickup_location_id ?? (await getDefaultLocationId(session.workspace.id));
  if (!locId) return c.json({ error: 'no_default_location' }, 400);

  // Estimated value + line snapshot from product rates.
  let estValue = 0;
  const days = Math.max(1, Math.ceil((new Date(p.rental_end_at).getTime() - new Date(p.rental_start_at).getTime()) / 86_400_000));
  const snapshot: Array<{ product_id: string; quantity: number; rate_paise: number; name: string }> = [];
  const products: Array<{ id: string; rate: number; name: string; qty: number }> = [];
  for (const li of p.line_items) {
    const pr = (await query<{ id: string; base_price_paise: number | null; daily_rate: number; name: string }>(sql`
      SELECT id, base_price_paise, daily_rate, name FROM products
      WHERE id = ${li.product_id}::uuid AND workspace_id = ${session.workspace.id}::uuid AND deleted_at IS NULL LIMIT 1
    `))[0];
    if (!pr) return c.json({ error: 'product_not_found', product_id: li.product_id }, 404);
    const rate = Number(pr.base_price_paise ?? pr.daily_rate);
    estValue += rate * li.quantity * days;
    snapshot.push({ product_id: pr.id, quantity: li.quantity, rate_paise: rate, name: pr.name });
    products.push({ id: pr.id, rate, name: pr.name, qty: li.quantity });
  }

  // Approval policy.
  const ra = pol.requires_approval ?? {};
  const reasons: string[] = [];
  if (Number(ra.value_over_paise ?? Infinity) > 0 && estValue > Number(ra.value_over_paise ?? Infinity)) reasons.push('Hold value exceeds the approval threshold');
  if (Number(ra.duration_over_minutes ?? Infinity) > 0 && holdMinutes > Number(ra.duration_over_minutes ?? Infinity)) reasons.push('Hold duration exceeds the approval threshold');
  if (held >= cap && capOverride) reasons.push('Concurrent-hold cap override');
  const requiresApproval = reasons.length > 0;

  // Backing order (status 'standby') + soft-reserved rental lines.
  const orderNumber = Number((await query<{ n: number }>(sql`
    UPDATE workspaces SET next_order_number = next_order_number + 1 WHERE id = ${session.workspace.id}::uuid RETURNING next_order_number - 1 AS n
  `))[0]!.n);
  const order = (await query<{ id: string }>(sql`
    INSERT INTO orders (workspace_id, order_number, customer_person_id, status, rental_start, rental_end,
      dispatch_type, channel, pickup_location_id, return_location_id, created_by)
    VALUES (${session.workspace.id}::uuid, ${orderNumber}::int, ${p.customer_id}::uuid, 'standby'::order_status,
      ${p.rental_start_at}::timestamptz, ${p.rental_end_at}::timestamptz, 'pickup', 'planned',
      ${locId}::uuid, ${locId}::uuid, ${session.user.id}::uuid)
    RETURNING id
  `))[0]!;

  const stbNumber = await generateStandbyNumber(session.workspace.id);
  const nowMs = Date.now();
  const expiresAt = new Date(nowMs + holdMinutes * MS_PER_MIN).toISOString();
  const graceEndsAt = graceMinutes > 0 ? new Date(nowMs + (holdMinutes + graceMinutes) * MS_PER_MIN).toISOString() : null;
  const policySnapshot = { standby_policy: pol, segment, evaluated: { requires_approval: requiresApproval, reasons, cap, held } };

  const stb = (await query<{ id: string }>(sql`
    INSERT INTO standbys (workspace_id, order_id, customer_id, standby_number, requested_by_source, requested_via,
      requested_by_user_id, rental_start_at, rental_end_at, expires_at, hold_duration_minutes, grace_period_ends_at,
      reason_tag, reason_notes, estimated_value_paise, line_items_snapshot, requires_approval, status, policy_applied_snapshot)
    VALUES (${session.workspace.id}::uuid, ${order.id}::uuid, ${p.customer_id}::uuid, ${stbNumber}::text, 'staff', ${p.requested_via}::text,
      ${session.user.id}::uuid, ${p.rental_start_at}::timestamptz, ${p.rental_end_at}::timestamptz, ${expiresAt}::timestamptz,
      ${holdMinutes}::int, ${graceEndsAt}::timestamptz, ${p.reason_tag}::text, ${p.reason_notes ?? null}::text,
      ${estValue}::bigint, ${JSON.stringify(snapshot)}::jsonb, ${requiresApproval}::boolean,
      ${requiresApproval ? 'pending_approval' : 'active'}::text, ${JSON.stringify(policySnapshot)}::jsonb)
    RETURNING id
  `))[0]!;

  // Soft-reserved rental lines (hold availability).
  for (const pr of products) {
    await sql`
      INSERT INTO order_items (workspace_id, order_id, item_type, product_id, description, quantity,
        daily_rate_paise, unit_amount_paise, total_amount_paise, is_soft_reserved, soft_reserved_standby_id)
      VALUES (${session.workspace.id}::uuid, ${order.id}::uuid, 'rental'::order_item_type, ${pr.id}::uuid, ${pr.name}::text,
        ${pr.qty}::int, ${pr.rate}::bigint, ${pr.rate}::bigint, ${pr.rate * pr.qty * days}::bigint, true, ${stb.id}::uuid)
    `;
  }
  await sql`
    INSERT INTO order_events (workspace_id, order_id, event_type, to_status, payload, actor_user_id)
    VALUES (${session.workspace.id}::uuid, ${order.id}::uuid, 'order.standby.created', 'standby'::order_status,
      ${JSON.stringify({ standby_id: stb.id, standby_number: stbNumber, expires_at: expiresAt, requires_approval: requiresApproval })}::jsonb,
      ${session.user.id}::uuid)
  `;
  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id, eventType: 'standbys.created',
    targetType: 'standby', targetId: stb.id,
    payload: { standby_number: stbNumber, order_id: order.id, segment, estimated_value_paise: estValue, requires_approval: requiresApproval },
    ipAddress, userAgent,
  });

  let approvalId: string | null = null;
  if (requiresApproval) {
    const ap = await createApprovalRequest({
      workspaceId: session.workspace.id, requesterUserId: session.user.id, requiredRole: 'manager',
      resourceType: 'standby', resourceId: stb.id, orderId: order.id, reasonTag: p.reason_tag, reasonNotes: p.reason_notes ?? null,
      requestSnapshot: { standby_number: stbNumber, customer_name: customer.display_name, estimated_value_paise: estValue, hold_minutes: holdMinutes, reasons },
      policySnapshot,
    });
    approvalId = ap.id;
    await sql`UPDATE standbys SET approval_request_id = ${ap.id}::uuid WHERE id = ${stb.id}::uuid`;
    emitNotification({
      workspaceId: session.workspace.id, actorUserId: session.user.id, eventType: 'approval_required',
      targetType: 'standby', targetId: stb.id, linkUrl: `/order-360.html?id=${order.id}`,
      emailRecipientUserId: ap.approver_user_id,
      metadata: { order_number: orderNumber, resource_label: 'Standby', actor_name: session.user.displayName ?? '' },
    }).catch(() => {});
  }

  const fresh = await loadStandby(stb.id, session.workspace.id);
  return c.json({ standby: fresh, order_id: order.id, approval_request_id: approvalId, requires_approval: requiresApproval }, 201);
});

// ----------------------------------------------------------------------------
// GET /api/standbys — list (filter by status / customer). Includes live countdown.
// ----------------------------------------------------------------------------
standbys.get('/', async (c) => {
  const session = c.get('session')!;
  const status = c.req.query('status') || null;
  const customerId = c.req.query('customer_id') || null;
  const rows = await query<any>(sql`
    SELECT s.id, s.standby_number, s.order_id, s.customer_id, s.status, s.reason_tag,
           s.rental_start_at, s.rental_end_at, s.expires_at, s.hold_duration_minutes,
           s.estimated_value_paise, s.requires_approval, s.created_at,
           p.display_name AS customer_name, o.order_number,
           GREATEST(0, EXTRACT(EPOCH FROM (s.expires_at - now())))::bigint AS seconds_to_expiry
    FROM standbys s
    JOIN people p ON p.id = s.customer_id
    LEFT JOIN orders o ON o.id = s.order_id
    WHERE s.workspace_id = ${session.workspace.id}::uuid
      AND (${status}::text IS NULL OR s.status = ${status}::text)
      AND (${customerId}::uuid IS NULL OR s.customer_id = ${customerId}::uuid)
    ORDER BY s.created_at DESC LIMIT 200
  `);
  return c.json({ standbys: rows });
});

standbys.get('/:id', async (c) => {
  const session = c.get('session')!;
  const s = await loadStandby(c.req.param('id'), session.workspace.id);
  if (!s) return c.json({ error: 'not_found' }, 404);
  return c.json({ standby: s });
});

// ----------------------------------------------------------------------------
// POST /:id/convert-to-booking — soft-reserve → hard-reserve, order → confirmed.
// ----------------------------------------------------------------------------
standbys.post('/:id/convert-to-booking', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  const s = await loadStandby(id, session.workspace.id);
  if (!s) return c.json({ error: 'not_found' }, 404);
  if (s.status !== 'active') {
    return c.json(orderBlock('STANDBY_BLOCKED', 'Cannot convert this standby', [
      reasonB('lifecycle_state', 'NOT_ACTIVE', `Standby is ${s.status}, not active.`)]), 409);
  }
  if (!s.order_id) return c.json({ error: 'no_backing_order' }, 409);

  await sql`
    UPDATE order_items SET is_soft_reserved = false, soft_reserved_standby_id = NULL, updated_at = now()
    WHERE order_id = ${s.order_id}::uuid AND workspace_id = ${session.workspace.id}::uuid
  `;
  await sql`UPDATE orders SET status = 'confirmed'::order_status, updated_at = now() WHERE id = ${s.order_id}::uuid AND workspace_id = ${session.workspace.id}::uuid`;
  await sql`UPDATE standbys SET status = 'converted_to_booking', converted_to_type = 'booking', converted_to_id = ${s.order_id}::uuid, outcome_reason = 'customer_confirmed', updated_at = now() WHERE id = ${id}::uuid`;
  try { await recomputeOrderTotals(s.order_id, session.workspace.id, session.user.id); } catch { /* fail-open */ }
  await sql`
    INSERT INTO order_events (workspace_id, order_id, event_type, to_status, payload, actor_user_id)
    VALUES (${session.workspace.id}::uuid, ${s.order_id}::uuid, 'order.standby.converted', 'confirmed'::order_status,
      ${JSON.stringify({ standby_id: id, to: 'booking' })}::jsonb, ${session.user.id}::uuid)
  `;
  await audit({ workspaceId: session.workspace.id, actorUserId: session.user.id, eventType: 'standbys.converted', targetType: 'standby', targetId: id, payload: { to: 'booking', order_id: s.order_id }, ipAddress, userAgent });
  return c.json({ standby_id: id, order_id: s.order_id, order_status: 'confirmed' });
});

// ----------------------------------------------------------------------------
// POST /:id/convert-to-quote — create a draft quote_version from the standby order.
// ----------------------------------------------------------------------------
standbys.post('/:id/convert-to-quote', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  const s = await loadStandby(id, session.workspace.id);
  if (!s) return c.json({ error: 'not_found' }, 404);
  if (s.status !== 'active') return c.json(orderBlock('STANDBY_BLOCKED', 'Cannot convert this standby', [reasonB('lifecycle_state', 'NOT_ACTIVE', `Standby is ${s.status}.`)]), 409);
  if (!s.order_id) return c.json({ error: 'no_backing_order' }, 409);

  const qv = await createQuoteVersionFromOrder({ workspaceId: session.workspace.id, orderId: s.order_id, actorUserId: session.user.id, revisionReasonTag: 'other' });
  await sql`UPDATE standbys SET status = 'converted_to_quote', converted_to_type = 'quote', converted_to_id = ${qv.id}::uuid, outcome_reason = 'customer_wanted_price', updated_at = now() WHERE id = ${id}::uuid`;
  // Release the soft hold — the quote flow governs availability now.
  await sql`UPDATE order_items SET is_soft_reserved = false, soft_reserved_standby_id = NULL WHERE order_id = ${s.order_id}::uuid AND workspace_id = ${session.workspace.id}::uuid`;
  await audit({ workspaceId: session.workspace.id, actorUserId: session.user.id, eventType: 'standbys.converted', targetType: 'standby', targetId: id, payload: { to: 'quote', quote_version_id: qv.id }, ipAddress, userAgent });
  return c.json({ standby_id: id, quote_version_id: qv.id, version_number: qv.version_number });
});

// ----------------------------------------------------------------------------
// POST /:id/release — manual release.
// ----------------------------------------------------------------------------
standbys.post('/:id/release', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const id = c.req.param('id');
  const s = await loadStandby(id, session.workspace.id);
  if (!s) return c.json({ error: 'not_found' }, 404);
  if (s.status !== 'active' && s.status !== 'pending_approval') {
    return c.json(orderBlock('STANDBY_BLOCKED', 'Cannot release this standby', [reasonB('lifecycle_state', 'NOT_RELEASABLE', `Standby is ${s.status}.`)]), 409);
  }
  await releaseStandbyHold({ workspaceId: session.workspace.id, standbyId: id, actorUserId: session.user.id, newStatus: 'released_manually', orderStatus: 'standby_released', outcomeReason: 'staff_released' });
  return c.json({ standby_id: id, status: 'released_manually' });
});

// ----------------------------------------------------------------------------
// POST /:id/extend — extend the hold window.
// ----------------------------------------------------------------------------
export const standbyExtendSchema = z.object({ additional_minutes: z.number().int().positive().max(4320) });
standbys.post('/:id/extend', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = standbyExtendSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const s = await loadStandby(id, session.workspace.id);
  if (!s) return c.json({ error: 'not_found' }, 404);
  if (s.status !== 'active') return c.json(orderBlock('STANDBY_BLOCKED', 'Cannot extend this standby', [reasonB('lifecycle_state', 'NOT_ACTIVE', `Standby is ${s.status}.`)]), 409);

  const settings = await loadWorkspaceSettings(session.workspace.id);
  const pol = standbyPolicy(settings);
  const roleMax = Number(pol.max_hold_duration_by_role?.[session.user.role] ?? 4320);
  const newTotal = Math.min(Number(s.hold_duration_minutes) + parsed.data.additional_minutes, roleMax);
  const newExpires = new Date(new Date(s.hold_started_at).getTime() + newTotal * MS_PER_MIN).toISOString();
  await sql`
    UPDATE standbys SET hold_duration_minutes = ${newTotal}::int, expires_at = ${newExpires}::timestamptz,
      customer_reminder_sent_at = NULL, staff_reminder_sent_at = NULL, updated_at = now()
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
  `;
  await audit({ workspaceId: session.workspace.id, actorUserId: session.user.id, eventType: 'standbys.extended', targetType: 'standby', targetId: id, payload: { new_hold_minutes: newTotal, new_expires_at: newExpires }, ipAddress, userAgent });
  return c.json({ standby_id: id, expires_at: newExpires, hold_duration_minutes: newTotal });
});
