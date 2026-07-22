// ============================================================================
// src/routes/returns.ts (Slice 5 Session 1) — structured return + inspection routing.
// ----------------------------------------------------------------------------
// The reverse of the dispatch flow (src/routes/dispatches.ts), same TWO-router
// split (avoids the double-mount trap):
//   * orderReturns  — order-scoped POST /api/orders/:orderId/returns; FOLDED into
//     the orders router (inherits its session + auth + idempotency once).
//   * returns       — id-scoped /api/returns/:returnId/...; own middleware chain.
//
// ADDITIVE to the legacy inline POST /api/orders/:id/return (Sub-turn 12b) — that
// stays unchanged. This flow opens a first-class `returns` record, captures
// recipient/serial/condition/photos/OTP/signature, and `.../complete` releases
// each line to inspection: item -> 'returned', an inspection-hold downtime per
// unit (availability stays "awaiting inspection" until inspected — Q7), and a
// scheduled inspection_events row per item. The physical DISPOSITION (asset ->
// available / repair downtime) is deferred to POST /api/inspections/:id/complete,
// which calls the SHARED commitReturnToPhysicalState (src/lib/return_commit.ts).
//
// Reconciled to the shipped schema (Slice 5 diagnostic, Aamir-approved): no new
// enum values — "awaiting inspection" = an open inspection_events row + the derived
// aggregate_status; a damaged unit is 'returned_with_damage' + a repair downtime.
// ============================================================================

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { put } from '@vercel/blob';
import { sql, query } from '../db.js';
import {
  sessionMiddleware, requireAuth,
  type SessionUser, type SessionWorkspace,
} from '../middleware/session.js';
import { requirePermission } from '../lib/permissions.js';
import { idempotencyMiddleware } from '../lib/idempotency.js';
import { audit, type AuditEventType } from '../lib/audit.js';
import { createInspectionHolds } from '../lib/return_commit.js';
import { emitCustomerNotification } from '../lib/notify.js';

type SessionVar = { sessionId: string; user: SessionUser; workspace: SessionWorkspace } | null;
type Env = { Variables: { session: SessionVar } };

function clientCtx(c: Context) {
  const ipAddress = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null;
  return { ipAddress, userAgent: c.req.header('user-agent') ?? null };
}

export const RECIPIENT_TYPES = ['customer', 'delegate'] as const;
export const DELEGATE_RELATIONSHIPS = ['assistant', 'driver', 'family', 'colleague', 'other'] as const;
export const RETURN_PHOTO_TYPES = ['equipment', 'serial', 'condition_front', 'condition_back', 'damage', 'other'] as const;
export const OTP_SEND_CHANNELS = ['whatsapp', 'sms', 'voice'] as const;
export const SIGNATURE_TYPES = ['digital_draw', 'paper_photo'] as const;
export const CONDITION_IN_VALUES = ['pristine', 'good', 'minor_wear', 'damage_flagged', 'missing'] as const;

// Default policy — mirrors the migration 059 seed (config-first, never hardcoded).
const DEFAULT_POLICY = {
  photos_required_per_item_type_return: { equipment: 1, serial: 1, condition_front: 1, condition_back: 1 } as Record<string, number>,
  otp_required_at_return: false,
  inspection_required_by_category: true,
  inspection_default_action: 'schedule' as string,
  inspection_hold_days: 3,
  late_return_fee_grace_hours: 2,
  early_return_credit_threshold_hours: 12,
  signature_required_at_return: true,
  signature_skip_requires_reason: true,
  otp_fallback_when_no_provider: 'allow_skip_with_reason',
  otp_template_name: 'return_otp',
  customer_notification_channels: ['whatsapp', 'email'] as string[],
  delegate_pickup_allowed: true,
  delegate_requires_id_proof: false,
  auto_release_deposit_on_inspection_pass: false,
};
type ReturnPolicy = typeof DEFAULT_POLICY;

// ---------------------------------------------------------------------------
// Zod schemas (exported — Rule A contract tests parse/reject against these).
// ---------------------------------------------------------------------------
export const returnCreateSchema = z.object({ recipient_type: z.enum(RECIPIENT_TYPES).optional() });
export const recipientSchema = z
  .object({
    recipient_type: z.enum(RECIPIENT_TYPES),
    delegate_name: z.string().min(1).max(200).nullish(),
    delegate_phone: z.string().min(3).max(40).nullish(),
    delegate_relationship: z.enum(DELEGATE_RELATIONSHIPS).nullish(),
    delegate_id_proof_url: z.string().max(2000).nullish(),
  })
  .refine((v) => v.recipient_type !== 'delegate' || (!!v.delegate_name && !!v.delegate_phone), {
    message: 'delegate return requires delegate_name and delegate_phone', path: ['delegate_name'],
  });
export const itemsChecklistSchema = z.object({ item_ids: z.array(z.string().uuid()).min(1) });
export const serialSchema = z.object({ captured_serial: z.string().min(1).max(120), override: z.boolean().optional() });
export const conditionSchema = z.object({ condition: z.enum(CONDITION_IN_VALUES) });
export const missingAccessoriesSchema = z.object({ notes: z.string().max(1000) });
export const photoSchema = z.object({
  order_item_id: z.string().uuid().nullish(),
  asset_id: z.string().uuid().nullish(),
  photo_type: z.enum(RETURN_PHOTO_TYPES),
  photo_base64: z.string().min(16),
  content_type: z.string().max(80).optional(),
});
export const otpSendSchema = z.object({ channel: z.enum(OTP_SEND_CHANNELS).optional() });
export const otpVerifySchema = z.object({ code: z.string().regex(/^\d{4,8}$/, 'code must be 4-8 digits') });
export const otpSkipSchema = z.object({ skip_reason: z.string().min(1).max(200), skip_reason_notes: z.string().max(2000).nullish() });
export const signatureSchema = z
  .object({
    signature_type: z.enum(SIGNATURE_TYPES).optional(),
    signature_base64: z.string().min(16).optional(),
    content_type: z.string().max(80).optional(),
    skipped: z.boolean().optional(),
    skip_reason: z.string().min(1).max(300).nullish(),
  })
  .refine((v) => v.skipped === true || (!!v.signature_type && !!v.signature_base64), {
    message: 'signature_type and signature_base64 are required unless skipped', path: ['signature_base64'],
  });
export const completeSchema = z.object({ item_ids: z.array(z.string().uuid()).optional() }).passthrough();

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
type ReturnRow = { id: string; workspace_id: string; order_id: string; return_number: string | null; recipient_type: string; status: string };

async function loadReturn(workspaceId: string, returnId: string): Promise<ReturnRow | null> {
  const rows = await query<ReturnRow>(sql`
    SELECT id, workspace_id, order_id, return_number, recipient_type, status
    FROM returns WHERE id = ${returnId}::uuid AND workspace_id = ${workspaceId}::uuid LIMIT 1
  `);
  return rows[0] ?? null;
}

async function loadPolicy(workspaceId: string): Promise<ReturnPolicy> {
  const rows = await query<{ policy: Partial<ReturnPolicy> | null }>(sql`
    SELECT settings->'dispatch_return_policy' AS policy FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
  `);
  return { ...DEFAULT_POLICY, ...(rows[0]?.policy ?? {}) };
}

// Per-item return state persisted on return_line_items; photo counts per type.
type ReturnItemRow = {
  id: string; order_item_id: string; description: string; quantity: number; product_id: string | null;
  captured_serial: string | null; serial_matched: boolean | null; condition_in: string | null; missing_accessories_notes: string | null;
  expected_serials: string[] | null; equipment_photos: number; serial_photos: number; condition_front_photos: number; condition_back_photos: number;
};

async function loadReturnItems(workspaceId: string, returnId: string) {
  return await query<ReturnItemRow>(sql`
    SELECT rli.id, rli.order_item_id, oi.description, oi.quantity, oi.product_id,
           rli.captured_serial, rli.serial_matched, rli.condition_in, rli.missing_accessories_notes,
           (SELECT json_agg(a.serial_number ORDER BY a.asset_code) FROM assets a
              WHERE a.product_id = oi.product_id AND a.workspace_id = ${workspaceId}::uuid
                AND a.deleted_at IS NULL AND a.serial_number IS NOT NULL) AS expected_serials,
           COALESCE((SELECT COUNT(*) FROM return_photos rp WHERE rp.return_id = ${returnId}::uuid AND rp.order_item_id = rli.order_item_id AND rp.photo_type = 'equipment'),0)::int AS equipment_photos,
           COALESCE((SELECT COUNT(*) FROM return_photos rp WHERE rp.return_id = ${returnId}::uuid AND rp.order_item_id = rli.order_item_id AND rp.photo_type = 'serial'),0)::int AS serial_photos,
           COALESCE((SELECT COUNT(*) FROM return_photos rp WHERE rp.return_id = ${returnId}::uuid AND rp.order_item_id = rli.order_item_id AND rp.photo_type = 'condition_front'),0)::int AS condition_front_photos,
           COALESCE((SELECT COUNT(*) FROM return_photos rp WHERE rp.return_id = ${returnId}::uuid AND rp.order_item_id = rli.order_item_id AND rp.photo_type = 'condition_back'),0)::int AS condition_back_photos
    FROM return_line_items rli
    JOIN order_items oi ON oi.id = rli.order_item_id
    WHERE rli.return_id = ${returnId}::uuid AND rli.workspace_id = ${workspaceId}::uuid
    ORDER BY oi.sort_order ASC, oi.created_at ASC
  `);
}

// Ensure a return_line_items row exists for an order item (created on first touch).
async function ensureLineItem(workspaceId: string, returnId: string, orderItemId: string): Promise<string | null> {
  const existing = await query<{ id: string }>(sql`
    SELECT id FROM return_line_items WHERE return_id = ${returnId}::uuid AND order_item_id = ${orderItemId}::uuid AND workspace_id = ${workspaceId}::uuid LIMIT 1
  `);
  if (existing.length) return existing[0]!.id;
  const ins = await query<{ id: string }>(sql`
    INSERT INTO return_line_items (workspace_id, return_id, order_item_id)
    VALUES (${workspaceId}::uuid, ${returnId}::uuid, ${orderItemId}::uuid) RETURNING id
  `);
  return ins[0]?.id ?? null;
}

async function recordReturnEvent(args: {
  workspaceId: string; orderId: string; actorUserId: string;
  timelineType: string; auditType: AuditEventType; payload: Record<string, unknown>; ip: string | null; ua: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO order_events (workspace_id, order_id, event_type, payload, actor_user_id)
    VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, ${args.timelineType}::text, ${JSON.stringify(args.payload)}::jsonb, ${args.actorUserId}::uuid)
  `;
  await audit({
    workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: args.auditType,
    targetType: 'return', targetId: String(args.payload.return_id ?? ''), payload: args.payload, ipAddress: args.ip, userAgent: args.ua,
  });
}

async function persistImage(workspaceId: string, returnId: string, kind: 'photos' | 'signatures', base64: string, contentType: string): Promise<string> {
  const isDataUri = base64.startsWith('data:');
  if (!process.env.BLOB_READ_WRITE_TOKEN) return isDataUri ? base64 : `data:${contentType};base64,${base64}`;
  const raw = isDataUri ? base64.slice(base64.indexOf(',') + 1) : base64;
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `workspaces/${workspaceId}/returns/${returnId}/${kind}-${Date.now()}-${rand}.jpg`;
  const blob = await put(path, Buffer.from(raw, 'base64'), { access: 'public', contentType, addRandomSuffix: false });
  return blob.url;
}

function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const s = String(phone);
  return s.length <= 4 ? s : s.slice(0, Math.max(0, s.length - 8)).replace(/./g, '*') + '****' + s.slice(-4);
}

const err = (code: string, message: string, reasons: unknown[] = []) => ({ error: { code, message, reasons } });

// ===========================================================================
// ORDER-SCOPED — folded into the orders router (NO global middleware here).
// ===========================================================================
export const orderReturns = new Hono<Env>();

orderReturns.post('/:orderId/returns', requirePermission('returns.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const orderId = c.req.param('orderId');
  const { ipAddress, userAgent } = clientCtx(c);

  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = returnCreateSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid return payload', parsed.error.issues), 400);

  const order = await query<{ id: string; order_number: number; status: string; rental_end: string | null }>(sql`
    SELECT id, order_number, status::text AS status, rental_end FROM orders
    WHERE id = ${orderId}::uuid AND workspace_id = ${workspaceId}::uuid LIMIT 1
  `);
  if (!order.length) return c.json(err('order_not_found', 'Order not found in this workspace'), 404);
  if (['closed', 'cancelled'].includes(order[0]!.status)) return c.json(err('order_locked', `This order is ${order[0]!.status}`), 409);

  // Early / late relative to rental_end (Q1 — advisory, never blocks).
  const rentalEnd = order[0]!.rental_end ? new Date(order[0]!.rental_end) : null;
  const now = new Date();
  let isEarly = false, isLate = false, earlyHours: number | null = null, lateHours: number | null = null;
  if (rentalEnd) {
    const diffH = (now.getTime() - rentalEnd.getTime()) / 3.6e6;
    if (diffH < 0) { isEarly = true; earlyHours = Math.round(-diffH * 100) / 100; }
    else if (diffH > 0) { isLate = true; lateHours = Math.round(diffH * 100) / 100; }
  }

  const seqRow = await query<{ seq: number }>(sql`SELECT COUNT(*)::int + 1 AS seq FROM returns WHERE order_id = ${orderId}::uuid AND workspace_id = ${workspaceId}::uuid`);
  const seq = seqRow[0]?.seq ?? 1;

  const inserted = await query<ReturnRow & { is_early_return: boolean; is_late_return: boolean }>(sql`
    INSERT INTO returns (workspace_id, order_id, return_number, recipient_type, status, return_started_at, is_early_return, is_late_return, early_return_hours, late_return_hours)
    VALUES (${workspaceId}::uuid, ${orderId}::uuid,
      'RT-' || to_char(now(), 'YYYY') || '-' || ${order[0]!.order_number}::text || '-' || ${seq}::text,
      ${parsed.data.recipient_type ?? 'customer'}::text, 'receive'::text, now(),
      ${isEarly}::boolean, ${isLate}::boolean, ${earlyHours}::numeric, ${lateHours}::numeric)
    RETURNING id, workspace_id, order_id, return_number, recipient_type, status, is_early_return, is_late_return
  `);
  const ret = inserted[0]!;

  await recordReturnEvent({
    workspaceId, orderId, actorUserId: session.user.id,
    timelineType: 'order.return.opened', auditType: 'returns.created',
    payload: { return_id: ret.id, return_number: ret.return_number, is_early: isEarly, is_late: isLate },
    ip: ipAddress, ua: userAgent,
  });

  return c.json({ return: ret }, 201);
});

// ===========================================================================
// ID-SCOPED — /api/returns/:returnId/... (own middleware chain).
// ===========================================================================
export const returns = new Hono<Env>();
returns.use('*', sessionMiddleware, requireAuth);
returns.use('*', idempotencyMiddleware);

returns.get('/:returnId', async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const rows = await query<{
    id: string; return_number: string | null; recipient_type: string; status: string;
    delegate_name: string | null; delegate_phone: string | null; delegate_relationship: string | null; delegate_id_proof_url: string | null;
    is_early_return: boolean; is_late_return: boolean; early_return_hours: number | null; late_return_hours: number | null;
    order_id: string; order_number: number; order_status: string; customer_name: string | null; customer_phone: string | null;
  }>(sql`
    SELECT r.id, r.return_number, r.recipient_type, r.status,
           r.delegate_name, r.delegate_phone, r.delegate_relationship, r.delegate_id_proof_url,
           r.is_early_return, r.is_late_return, r.early_return_hours, r.late_return_hours,
           r.order_id, o.order_number, o.status::text AS order_status,
           p.display_name AS customer_name, p.phone AS customer_phone
    FROM returns r
    JOIN orders o ON o.id = r.order_id AND o.workspace_id = r.workspace_id
    LEFT JOIN people p ON p.id = o.customer_person_id
    WHERE r.id = ${c.req.param('returnId')}::uuid AND r.workspace_id = ${workspaceId}::uuid LIMIT 1
  `);
  if (!rows.length) return c.json(err('return_not_found', 'Return not found'), 404);
  const r = rows[0]!;
  const policy = await loadPolicy(workspaceId);
  // Dispatched rental items = the returnable set; ensure a line row per item.
  const dispatched = await query<{ id: string }>(sql`
    SELECT id FROM order_items WHERE order_id = ${r.order_id}::uuid AND workspace_id = ${workspaceId}::uuid
      AND item_type = 'rental' AND status = 'dispatched'::order_item_status
  `);
  for (const it of dispatched) await ensureLineItem(workspaceId, r.id, it.id);
  const items = await loadReturnItems(workspaceId, r.id);

  const otp = await query<{ otp_verified: boolean; otp_sent_via: string | null; skip_reason: string | null; otp_sent_to_phone: string | null }>(sql`
    SELECT otp_verified, otp_sent_via, skip_reason, otp_sent_to_phone FROM return_otp_verifications WHERE return_id = ${r.id}::uuid ORDER BY created_at DESC LIMIT 1
  `);
  const sig = await query<{ signature_type: string | null; signature_url: string | null; skipped: boolean; skip_reason: string | null }>(sql`
    SELECT signature_type, signature_url, skipped, skip_reason FROM return_signatures WHERE return_id = ${r.id}::uuid ORDER BY created_at DESC LIMIT 1
  `);
  const o = otp[0] ?? null;
  return c.json({
    return: { ...r, customer_phone_masked: maskPhone(r.customer_phone) },
    policy, items,
    otp_state: o ? { verified: o.otp_verified, skipped: o.otp_sent_via === 'skipped', skip_reason: o.skip_reason, sent_to: maskPhone(o.otp_sent_to_phone) } : null,
    signature_state: sig[0] ?? null,
  }, 200);
});

returns.post('/:returnId/recipient', requirePermission('returns.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const r = await loadReturn(workspaceId, c.req.param('returnId'));
  if (!r) return c.json(err('return_not_found', 'Return not found'), 404);

  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = recipientSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid recipient payload', parsed.error.issues), 400);
  const p = parsed.data;
  const policy = await loadPolicy(workspaceId);
  if (p.recipient_type === 'delegate') {
    if (!policy.delegate_pickup_allowed) return c.json(err('delegate_not_allowed', 'Delegate return is disabled'), 403);
    if (policy.delegate_requires_id_proof && !p.delegate_id_proof_url) return c.json(err('delegate_id_required', 'Delegate ID proof is required', [{ code: 'delegate_id_proof_url' }]), 403);
  }

  const updated = await query<ReturnRow>(sql`
    UPDATE returns SET
      recipient_type = ${p.recipient_type}::text,
      delegate_name = ${p.recipient_type === 'delegate' ? p.delegate_name ?? null : null}::text,
      delegate_phone = ${p.recipient_type === 'delegate' ? p.delegate_phone ?? null : null}::text,
      delegate_relationship = ${p.recipient_type === 'delegate' ? p.delegate_relationship ?? null : null}::text,
      delegate_id_proof_url = ${p.recipient_type === 'delegate' ? p.delegate_id_proof_url ?? null : null}::text,
      status = CASE WHEN status IN ('draft','receive') THEN 'handover' ELSE status END, updated_at = now()
    WHERE id = ${r.id}::uuid AND workspace_id = ${workspaceId}::uuid
    RETURNING id, workspace_id, order_id, return_number, recipient_type, status
  `);
  await recordReturnEvent({
    workspaceId, orderId: r.order_id, actorUserId: session.user.id,
    timelineType: 'order.return.recipient', auditType: 'returns.recipient_recorded',
    payload: { return_id: r.id, recipient_type: p.recipient_type }, ip: ipAddress, ua: userAgent,
  });
  return c.json({ return: updated[0] }, 200);
});

returns.post('/:returnId/items', requirePermission('returns.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const r = await loadReturn(workspaceId, c.req.param('returnId'));
  if (!r) return c.json(err('return_not_found', 'Return not found'), 404);
  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = itemsChecklistSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid items payload', parsed.error.issues), 400);
  const valid = await query<{ id: string }>(sql`
    SELECT id FROM order_items WHERE order_id = ${r.order_id}::uuid AND workspace_id = ${workspaceId}::uuid
      AND item_type = 'rental' AND status = 'dispatched'::order_item_status
      AND id::text = ANY(string_to_array(${parsed.data.item_ids.join(',')}::text, ','))
  `);
  const validIds = new Set(valid.map((x) => x.id));
  const unknown = parsed.data.item_ids.filter((x) => !validIds.has(x));
  if (unknown.length) return c.json(err('invalid_item_ids', 'Some items are not dispatched rental lines on this order', unknown), 400);
  for (const id of parsed.data.item_ids) await ensureLineItem(workspaceId, r.id, id);
  await recordReturnEvent({
    workspaceId, orderId: r.order_id, actorUserId: session.user.id,
    timelineType: 'order.return.items', auditType: 'returns.items_recorded',
    payload: { return_id: r.id, item_ids: parsed.data.item_ids, count: parsed.data.item_ids.length }, ip: ipAddress, ua: userAgent,
  });
  return c.json({ status: 'recorded', items: await loadReturnItems(workspaceId, r.id) }, 200);
});

returns.post('/:returnId/items/:itemId/serial', requirePermission('returns.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const r = await loadReturn(workspaceId, c.req.param('returnId'));
  if (!r) return c.json(err('return_not_found', 'Return not found'), 404);
  const itemId = c.req.param('itemId');
  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = serialSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid serial payload', parsed.error.issues), 400);
  const captured = parsed.data.captured_serial.trim();

  const item = await query<{ product_id: string | null }>(sql`
    SELECT product_id FROM order_items WHERE id = ${itemId}::uuid AND order_id = ${r.order_id}::uuid AND workspace_id = ${workspaceId}::uuid AND item_type = 'rental' LIMIT 1
  `);
  if (!item.length) return c.json(err('item_not_found', 'Rental item not found on this order'), 404);
  // Match against a unit of this product that is currently OUT (dispatched on this order).
  const match = await query<{ asset_code: string }>(sql`
    SELECT asset_code FROM assets WHERE workspace_id = ${workspaceId}::uuid AND product_id = ${item[0]!.product_id}::uuid
      AND deleted_at IS NULL AND lower(serial_number) = lower(${captured}::text) LIMIT 1
  `);
  const matched = match.length > 0;
  if (!matched && parsed.data.override !== true) {
    const expected = await query<{ serial_number: string | null }>(sql`
      SELECT serial_number FROM assets WHERE workspace_id = ${workspaceId}::uuid AND product_id = ${item[0]!.product_id}::uuid AND deleted_at IS NULL AND serial_number IS NOT NULL ORDER BY asset_code ASC
    `);
    return c.json({ status: 'mismatch', matched: false, captured_serial: captured, expected_serials: expected.map((e) => e.serial_number).filter(Boolean) }, 409);
  }
  await ensureLineItem(workspaceId, r.id, itemId);
  await sql`
    UPDATE return_line_items SET captured_serial = ${captured}::text, serial_matched = ${matched}::boolean, updated_at = now()
    WHERE return_id = ${r.id}::uuid AND order_item_id = ${itemId}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  await recordReturnEvent({
    workspaceId, orderId: r.order_id, actorUserId: session.user.id,
    timelineType: 'order.return.serial', auditType: 'returns.serial_verified',
    payload: { return_id: r.id, item_id: itemId, captured_serial: captured, matched, override: parsed.data.override === true }, ip: ipAddress, ua: userAgent,
  });
  return c.json({ status: matched ? 'matched' : 'overridden', matched, captured_serial: captured }, 200);
});

returns.post('/:returnId/items/:itemId/condition', requirePermission('returns.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const r = await loadReturn(workspaceId, c.req.param('returnId'));
  if (!r) return c.json(err('return_not_found', 'Return not found'), 404);
  const itemId = c.req.param('itemId');
  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = conditionSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid condition payload', parsed.error.issues), 400);
  await ensureLineItem(workspaceId, r.id, itemId);
  const upd = await query<{ id: string }>(sql`
    UPDATE return_line_items SET condition_in = ${parsed.data.condition}::text, updated_at = now()
    WHERE return_id = ${r.id}::uuid AND order_item_id = ${itemId}::uuid AND workspace_id = ${workspaceId}::uuid RETURNING id
  `);
  if (!upd.length) return c.json(err('item_not_found', 'Return line not found'), 404);
  await recordReturnEvent({
    workspaceId, orderId: r.order_id, actorUserId: session.user.id,
    timelineType: 'order.return.condition', auditType: 'returns.condition_recorded',
    payload: { return_id: r.id, item_id: itemId, condition: parsed.data.condition }, ip: ipAddress, ua: userAgent,
  });
  return c.json({ status: 'recorded', item_id: itemId, condition: parsed.data.condition }, 200);
});

returns.post('/:returnId/items/:itemId/missing-accessories', requirePermission('returns.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const r = await loadReturn(workspaceId, c.req.param('returnId'));
  if (!r) return c.json(err('return_not_found', 'Return not found'), 404);
  const itemId = c.req.param('itemId');
  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = missingAccessoriesSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid notes payload', parsed.error.issues), 400);
  await ensureLineItem(workspaceId, r.id, itemId);
  await sql`
    UPDATE return_line_items SET missing_accessories_notes = ${parsed.data.notes || null}::text, updated_at = now()
    WHERE return_id = ${r.id}::uuid AND order_item_id = ${itemId}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  await recordReturnEvent({
    workspaceId, orderId: r.order_id, actorUserId: session.user.id,
    timelineType: 'order.return.accessories', auditType: 'returns.accessories_recorded',
    payload: { return_id: r.id, item_id: itemId }, ip: ipAddress, ua: userAgent,
  });
  return c.json({ status: 'recorded', item_id: itemId }, 200);
});

returns.post('/:returnId/photos', requirePermission('returns.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const r = await loadReturn(workspaceId, c.req.param('returnId'));
  if (!r) return c.json(err('return_not_found', 'Return not found'), 404);
  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = photoSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid photo payload', parsed.error.issues), 400);
  const p = parsed.data;
  let photoUrl: string;
  try { photoUrl = await persistImage(workspaceId, r.id, 'photos', p.photo_base64, p.content_type ?? 'image/jpeg'); }
  catch (e) { console.error('return photo persist failed', e); return c.json(err('upload_failed', 'Could not store the photo'), 500); }
  const ins = await query<{ id: string; captured_at: string }>(sql`
    INSERT INTO return_photos (workspace_id, return_id, order_item_id, asset_id, photo_url, photo_type, captured_by_user_id)
    VALUES (${workspaceId}::uuid, ${r.id}::uuid, ${p.order_item_id ?? null}::uuid, ${p.asset_id ?? null}::uuid, ${photoUrl}::text, ${p.photo_type}::text, ${session.user.id}::uuid)
    RETURNING id, captured_at
  `);
  await recordReturnEvent({
    workspaceId, orderId: r.order_id, actorUserId: session.user.id,
    timelineType: 'order.return.photo', auditType: 'returns.photo_captured',
    payload: { return_id: r.id, photo_id: ins[0]!.id, photo_type: p.photo_type, order_item_id: p.order_item_id ?? null }, ip: ipAddress, ua: userAgent,
  });
  return c.json({ photo: { id: ins[0]!.id, photo_url: photoUrl, photo_type: p.photo_type, captured_at: ins[0]!.captured_at } }, 201);
});

returns.post('/:returnId/otp', requirePermission('returns.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const r = await loadReturn(workspaceId, c.req.param('returnId'));
  if (!r) return c.json(err('return_not_found', 'Return not found'), 404);
  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = otpSendSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid OTP payload', parsed.error.issues), 400);
  const channel = parsed.data.channel ?? 'whatsapp';
  const policy = await loadPolicy(workspaceId);
  const cust = await query<{ id: string | null; phone: string | null }>(sql`SELECT p.id, p.phone FROM orders o LEFT JOIN people p ON p.id = o.customer_person_id WHERE o.id = ${r.order_id}::uuid AND o.workspace_id = ${workspaceId}::uuid LIMIT 1`);
  const phone = cust[0]?.phone ?? null;
  const personId = cust[0]?.id ?? null;
  const code = String(randomInt(100000, 1000000));
  const codeHash = await bcrypt.hash(code, 10);
  // Slice 10 (Q3): unify the WhatsApp OTP through emitCustomerNotification (one
  // canonical pipeline). return_otp_send is seeded mode='auto'; policy + opt-in
  // apply; redactRender keeps the plaintext code out of the delivery snapshot.
  let send: { status: 'sent' | 'failed' | 'provider_not_configured'; messageId?: string; error?: string } = { status: 'provider_not_configured' };
  if (phone) {
    const notif = await emitCustomerNotification({
      workspaceId, orderId: r.order_id, personId, eventType: 'return_otp_send',
      message: 'Return verification OTP', channels: ['whatsapp'], contact: { phone },
      whatsapp: { templateName: policy.otp_template_name, variables: { '1': code } },
      redactRender: true,
    });
    const wa = notif.deliveries.find((x) => x.channel === 'whatsapp');
    send = wa?.status === 'sent'
      ? { status: 'sent', messageId: wa.provider_ref ?? undefined }
      : wa?.status === 'failed'
        ? { status: 'failed', error: wa.reason ?? 'send_failed' }
        : { status: 'provider_not_configured', error: wa?.reason };
  } else send = { status: 'failed', error: 'customer_has_no_phone' };
  if (send.status === 'provider_not_configured') return c.json({ status: 'provider_not_configured', reason: send.error ?? null, fallback_allowed: policy.otp_fallback_when_no_provider === 'allow_skip_with_reason' }, 200);
  const otp = await query<{ id: string }>(sql`
    INSERT INTO return_otp_verifications (workspace_id, return_id, otp_sent_to_phone, otp_sent_via, otp_code_hash, otp_generated_at, provider_ref)
    VALUES (${workspaceId}::uuid, ${r.id}::uuid, ${phone}::text, ${channel}::text, ${codeHash}::text, now(), ${send.messageId ?? null}::text) RETURNING id
  `);
  await recordReturnEvent({
    workspaceId, orderId: r.order_id, actorUserId: session.user.id,
    timelineType: 'order.return.otp_sent', auditType: 'returns.otp_sent',
    payload: { return_id: r.id, otp_id: otp[0]!.id, channel, send_status: send.status }, ip: ipAddress, ua: userAgent,
  });
  if (send.status === 'failed') return c.json({ status: 'send_failed', otp_id: otp[0]!.id, error: send.error ?? 'send_error', fallback_allowed: policy.otp_fallback_when_no_provider === 'allow_skip_with_reason' }, 200);
  return c.json({ status: 'sent', otp_id: otp[0]!.id, channel, sent_to: maskPhone(phone) }, 201);
});

returns.post('/:returnId/otp/verify', requirePermission('returns.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const r = await loadReturn(workspaceId, c.req.param('returnId'));
  if (!r) return c.json(err('return_not_found', 'Return not found'), 404);
  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = otpVerifySchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid OTP code', parsed.error.issues), 400);
  const rows = await query<{ id: string; otp_code_hash: string | null }>(sql`
    SELECT id, otp_code_hash FROM return_otp_verifications WHERE return_id = ${r.id}::uuid AND workspace_id = ${workspaceId}::uuid AND otp_sent_via <> 'skipped' ORDER BY created_at DESC LIMIT 1
  `);
  if (!rows.length || !rows[0]!.otp_code_hash) return c.json(err('no_otp_to_verify', 'No verifiable OTP on record'), 409);
  if (!(await bcrypt.compare(parsed.data.code, rows[0]!.otp_code_hash))) return c.json(err('otp_incorrect', 'The code does not match'), 401);
  await sql`UPDATE return_otp_verifications SET otp_verified = true, otp_verified_at = now() WHERE id = ${rows[0]!.id}::uuid AND workspace_id = ${workspaceId}::uuid`;
  await recordReturnEvent({
    workspaceId, orderId: r.order_id, actorUserId: session.user.id,
    timelineType: 'order.return.otp_verified', auditType: 'returns.otp_verified',
    payload: { return_id: r.id, otp_id: rows[0]!.id }, ip: ipAddress, ua: userAgent,
  });
  return c.json({ status: 'verified', otp_id: rows[0]!.id }, 200);
});

returns.post('/:returnId/otp/skip', requirePermission('returns.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const r = await loadReturn(workspaceId, c.req.param('returnId'));
  if (!r) return c.json(err('return_not_found', 'Return not found'), 404);
  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = otpSkipSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'A skip reason is required', parsed.error.issues), 400);
  const otp = await query<{ id: string }>(sql`
    INSERT INTO return_otp_verifications (workspace_id, return_id, otp_sent_via, skip_reason, skip_reason_notes)
    VALUES (${workspaceId}::uuid, ${r.id}::uuid, 'skipped'::text, ${parsed.data.skip_reason}::text, ${parsed.data.skip_reason_notes ?? null}::text) RETURNING id
  `);
  await recordReturnEvent({
    workspaceId, orderId: r.order_id, actorUserId: session.user.id,
    timelineType: 'order.return.otp_skipped', auditType: 'returns.otp_skipped',
    payload: { return_id: r.id, otp_id: otp[0]!.id, skip_reason: parsed.data.skip_reason }, ip: ipAddress, ua: userAgent,
  });
  return c.json({ status: 'skipped', otp_id: otp[0]!.id }, 201);
});

returns.post('/:returnId/signature', requirePermission('returns.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const r = await loadReturn(workspaceId, c.req.param('returnId'));
  if (!r) return c.json(err('return_not_found', 'Return not found'), 404);
  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = signatureSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid signature payload', parsed.error.issues), 400);
  const p = parsed.data;
  const policy = await loadPolicy(workspaceId);
  if (p.skipped === true) {
    if (policy.signature_skip_requires_reason && !p.skip_reason) return c.json(err('skip_reason_required', 'A reason is required to skip the signature', [{ code: 'skip_reason' }]), 400);
    const s = await query<{ id: string; captured_at: string }>(sql`
      INSERT INTO return_signatures (workspace_id, return_id, signature_type, signature_url, skipped, skip_reason, captured_by_user_id)
      VALUES (${workspaceId}::uuid, ${r.id}::uuid, NULL, NULL, true, ${p.skip_reason ?? null}::text, ${session.user.id}::uuid) RETURNING id, captured_at
    `);
    await recordReturnEvent({ workspaceId, orderId: r.order_id, actorUserId: session.user.id, timelineType: 'order.return.signature', auditType: 'returns.signature_captured', payload: { return_id: r.id, signature_id: s[0]!.id, skipped: true, skip_reason: p.skip_reason ?? null }, ip: ipAddress, ua: userAgent });
    return c.json({ signature: { id: s[0]!.id, skipped: true, captured_at: s[0]!.captured_at } }, 201);
  }
  let sigUrl: string;
  try { sigUrl = await persistImage(workspaceId, r.id, 'signatures', p.signature_base64!, p.content_type ?? 'image/png'); }
  catch (e) { console.error('return signature persist failed', e); return c.json(err('upload_failed', 'Could not store the signature'), 500); }
  const ins = await query<{ id: string; captured_at: string }>(sql`
    INSERT INTO return_signatures (workspace_id, return_id, signature_type, signature_url, skipped, captured_by_user_id)
    VALUES (${workspaceId}::uuid, ${r.id}::uuid, ${p.signature_type!}::text, ${sigUrl}::text, false, ${session.user.id}::uuid) RETURNING id, captured_at
  `);
  await recordReturnEvent({ workspaceId, orderId: r.order_id, actorUserId: session.user.id, timelineType: 'order.return.signature', auditType: 'returns.signature_captured', payload: { return_id: r.id, signature_id: ins[0]!.id, signature_type: p.signature_type }, ip: ipAddress, ua: userAgent });
  return c.json({ signature: { id: ins[0]!.id, signature_type: p.signature_type, captured_at: ins[0]!.captured_at } }, 201);
});

// POST /:returnId/complete — Phase 3. Readiness (Item 12 reasons[]), then release
// each line to inspection: item -> 'returned', an inspection-hold downtime per
// unit, and a scheduled inspection_events row per item. Asset DISPOSITION is
// deferred to POST /api/inspections/:id/complete (the shared helper).
returns.post('/:returnId/complete', requirePermission('returns.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const r = await loadReturn(workspaceId, c.req.param('returnId'));
  if (!r) return c.json(err('return_not_found', 'Return not found'), 404);
  if (r.status === 'completed') return c.json(err('already_completed', 'This return is already completed'), 409);

  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsedBody = completeSchema.safeParse(body);
  if (!parsedBody.success) return c.json(err('invalid_body', 'Invalid complete payload', parsedBody.error.issues), 400);
  const policy = await loadPolicy(workspaceId);

  const order = await query<{ order_number: number; status: string }>(sql`SELECT order_number, status::text AS status FROM orders WHERE id = ${r.order_id}::uuid AND workspace_id = ${workspaceId}::uuid LIMIT 1`);
  const items = await loadReturnItems(workspaceId, r.id);
  if (!items.length) return c.json(err('nothing_to_return', 'No dispatched rental items to return'), 409);

  const reasons: { code: string; message: string; order_item_id?: string }[] = [];
  // condition required per item.
  for (const it of items) if (!it.condition_in) reasons.push({ code: 'condition_missing', message: `Record the return condition for ${it.description}`, order_item_id: it.order_item_id });
  // photos per type (Q4).
  const perType = policy.photos_required_per_item_type_return ?? {};
  for (const it of items) {
    for (const [type, have] of [['equipment', it.equipment_photos], ['serial', it.serial_photos], ['condition_front', it.condition_front_photos], ['condition_back', it.condition_back_photos]] as [string, number][]) {
      const need = Number(perType[type] ?? 0);
      if (need > 0 && have < need) reasons.push({ code: 'photos_missing', message: `${it.description}: needs ${need} ${type.replace('_', ' ')} photo(s) (has ${have})`, order_item_id: it.order_item_id });
    }
  }
  // signature (policy).
  if (policy.signature_required_at_return) {
    const sig = await query<{ captured: number; skipped_ok: number }>(sql`
      SELECT COUNT(*) FILTER (WHERE skipped = false AND signature_url IS NOT NULL)::int AS captured,
             COUNT(*) FILTER (WHERE skipped = true AND (${policy.signature_skip_requires_reason}::boolean = false OR skip_reason IS NOT NULL))::int AS skipped_ok
      FROM return_signatures WHERE return_id = ${r.id}::uuid
    `);
    if ((sig[0]?.captured ?? 0) === 0 && (sig[0]?.skipped_ok ?? 0) === 0) reasons.push({ code: 'signature_missing', message: 'A signature (or a skip with reason) is required' });
  }
  // OTP only if required at return (default false).
  if (policy.otp_required_at_return) {
    const otp = await query<{ ok: number }>(sql`SELECT COUNT(*) FILTER (WHERE otp_verified = true OR otp_sent_via = 'skipped')::int AS ok FROM return_otp_verifications WHERE return_id = ${r.id}::uuid`);
    if ((otp[0]?.ok ?? 0) === 0) reasons.push({ code: 'otp_unverified', message: 'OTP must be verified or skipped' });
  }
  if (reasons.length) return c.json(err('return_not_ready', 'Required return steps are incomplete', reasons), 403);

  // Recipient summary -> order_items.returned_from.
  const returnedFrom = r.recipient_type === 'delegate'
    ? await query<{ n: string | null }>(sql`SELECT delegate_name AS n FROM returns WHERE id = ${r.id}::uuid`).then((x) => (x[0]?.n ? `${x[0].n} (delegate)` : 'delegate'))
    : 'customer';

  const holdDays = Number(policy.inspection_hold_days) > 0 ? Number(policy.inspection_hold_days) : 3;
  const inspectionRequired = policy.inspection_required_by_category !== false;
  const inspectionIds: string[] = [];
  const seqBase = await query<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM inspection_events WHERE order_id = ${r.order_id}::uuid AND workspace_id = ${workspaceId}::uuid`);
  let seq = seqBase[0]?.n ?? 0;

  for (const it of items) {
    // item -> 'returned' (releases the reservation; the hold downtime keeps the
    // physical unit out of availability until inspection).
    await sql`
      UPDATE order_items SET status = 'returned'::order_item_status, returned_at = now(),
        returned_by_user_id = ${session.user.id}::uuid, returned_from = ${returnedFrom}::text,
        condition_notes = COALESCE(${it.condition_in ?? null}::text, condition_notes), updated_at = now()
      WHERE id = ${it.order_item_id}::uuid AND workspace_id = ${workspaceId}::uuid AND status = 'dispatched'::order_item_status
    `;
    if (inspectionRequired) {
      await createInspectionHolds({ workspaceId, orderId: r.order_id, orderNumber: Number(order[0]?.order_number ?? 0), itemId: it.order_item_id, actorUserId: session.user.id, holdDays });
      seq += 1;
      const ins = await query<{ id: string }>(sql`
        INSERT INTO inspection_events (workspace_id, order_id, return_id, order_item_id, inspection_number, status, scheduled_for)
        VALUES (${workspaceId}::uuid, ${r.order_id}::uuid, ${r.id}::uuid, ${it.order_item_id}::uuid,
          'INS-' || to_char(now(),'YYYY') || '-' || ${order[0]?.order_number ?? 0}::text || '-' || ${seq}::text,
          'scheduled'::text, ${policy.inspection_default_action === 'schedule' ? new Date(Date.now() + 864e5).toISOString() : null}::timestamptz)
        RETURNING id
      `);
      if (ins[0]?.id) inspectionIds.push(ins[0].id);
    }
  }

  await sql`UPDATE returns SET status = 'completed'::text, return_completed_at = now(), completed_by_user_id = ${session.user.id}::uuid, updated_at = now() WHERE id = ${r.id}::uuid AND workspace_id = ${workspaceId}::uuid`;

  // Order -> 'returned' when every rental line is terminal (mirrors the legacy path).
  const remaining = await query<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = ${r.order_id}::uuid AND workspace_id = ${workspaceId}::uuid AND item_type = 'rental' AND status = 'dispatched'::order_item_status`);
  const orderAdvanced = (remaining[0]?.n ?? 0) === 0 && ['dispatched', 'active'].includes(order[0]?.status ?? '');
  if (orderAdvanced) await sql`UPDATE orders SET status = 'returned'::order_status, updated_at = now() WHERE id = ${r.order_id}::uuid AND workspace_id = ${workspaceId}::uuid`;

  // Customer notification (fail-open).
  const cust = await query<{ person_id: string | null; phone: string | null; email: string | null; name: string | null }>(sql`SELECT o.customer_person_id AS person_id, p.phone, p.email, p.display_name AS name FROM orders o LEFT JOIN people p ON p.id = o.customer_person_id WHERE o.id = ${r.order_id}::uuid LIMIT 1`);
  const channels = (policy.customer_notification_channels ?? ['whatsapp', 'email']).filter((ch): ch is 'whatsapp' | 'email' => ch === 'whatsapp' || ch === 'email');
  const notify = await emitCustomerNotification({
    workspaceId, orderId: r.order_id, personId: cust[0]?.person_id ?? null,
    eventType: 'order.return.completed', message: `Return ${r.return_number} received for order #${order[0]?.order_number ?? ''} — ${items.length} item(s), inspection ${inspectionRequired ? 'pending' : 'not required'}.`,
    channels, contact: { phone: cust[0]?.phone ?? null, email: cust[0]?.email ?? null }, bypassPolicy: true,
    variables: { order_number: order[0]?.order_number ?? '', return_number: r.return_number ?? '', item_count: items.length, customer_name: cust[0]?.name ?? '' },
  });
  const notificationSent = notify.deliveries.some((x) => x.status === 'sent');
  const notificationReason = notificationSent ? null : (notify.deliveries.find((x) => x.reason === 'no_active_adapter' || x.reason === 'noop_adapter') ? 'provider_not_configured' : (notify.deliveries[0]?.reason ?? 'not_sent'));

  await recordReturnEvent({
    workspaceId, orderId: r.order_id, actorUserId: session.user.id,
    timelineType: 'order.return.completed', auditType: 'returns.completed',
    payload: { return_id: r.id, return_number: r.return_number, item_count: items.length, inspection_event_ids: inspectionIds, order_status: orderAdvanced ? 'returned' : order[0]?.status, notification_sent: notificationSent },
    ip: ipAddress, ua: userAgent,
  });

  return c.json({
    status: 'completed', return_id: r.id, return_number: r.return_number, order_status: orderAdvanced ? 'returned' : order[0]?.status,
    item_count: items.length,
    inspection_routing_options: { default_action: policy.inspection_default_action, inspection_event_ids: inspectionIds },
    notification_sent: notificationSent, notification_reason: notificationReason,
  }, 200);
});
