// ============================================================================
// src/routes/dispatches.ts (Slice 4 Session 1) — structured dispatch/handover.
// ----------------------------------------------------------------------------
// TWO routers, split by prefix (same pattern as substitutions/damage — avoids
// the double-mount trap):
//   * orderDispatches — order-scoped (POST /api/orders/:orderId/dispatches).
//     FOLDED into the orders router (orders.route('/', orderDispatches)); it
//     declares NO global middleware — the parent orders router already provides
//     session + auth + idempotency exactly once.
//   * dispatches — id-scoped (/api/dispatches/:dispatchId/...). A SEPARATE
//     prefix, so it carries its OWN session + auth + idempotency middleware.
//
// ADDITIVE to the legacy inline POST /api/orders/:id/dispatch (Sub-turn 12b),
// which stays unchanged (backward-compat decision, migration 057 header). This
// flow opens a first-class `dispatches` record, appends capture (recipient /
// photos / OTP / signature), and `.../complete` finalizes + transitions state.
//
// Autonomous Session-1 decisions (flagged for review):
//  1. OTP = operator-attestation. The approved 057 schema has no code column, so
//     `verify` RECORDS that verification happened (who/when) rather than doing a
//     cryptographic code comparison — matching the substrate, whose OTP is an
//     operator-entered read-back. Real code storage/comparison (a code_hash
//     column or an OTP-as-a-service provider) is a Session-2 hardening.
//  2. Photos/signatures come in as base64 (the substrate captures via camera).
//     Stored as a Vercel Blob URL when BLOB_READ_WRITE_TOKEN is set (reuses the
//     inventory.ts pattern), else inline as a data: URI so the flow works with
//     no external infra (and is round-trip testable).
//  3. `complete` transitions the order confirmed→dispatched + records events; it
//     does NOT allocate order_assets / flip asset status — that remains the
//     legacy 12b flow. Wiring the new dispatch to asset allocation is deferred.
//
// Every mutation writes BOTH an order_events row (per-order timeline) AND an
// audit_events row (workspace security log) — repo two-row convention.
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
import { commitDispatchToPhysicalState } from '../lib/dispatch_commit.js';
import { emitCustomerNotification } from '../lib/notify.js';

type SessionVar = { sessionId: string; user: SessionUser; workspace: SessionWorkspace } | null;
type Env = { Variables: { session: SessionVar } };

function clientCtx(c: Context) {
  const ipAddress = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null;
  return { ipAddress, userAgent: c.req.header('user-agent') ?? null };
}

// ---------------------------------------------------------------------------
// Taxonomies — mirror the DB CHECK vocabularies in migration 057 (single source
// on the client; the DB constraint is the backstop).
// ---------------------------------------------------------------------------
export const RECIPIENT_TYPES = ['customer', 'delegate'] as const;
export const DELEGATE_RELATIONSHIPS = ['assistant', 'driver', 'family', 'colleague', 'other'] as const;
export const PHOTO_TYPES = ['equipment', 'serial', 'accessory', 'damage', 'other'] as const;
export const OTP_SEND_CHANNELS = ['whatsapp', 'sms', 'voice'] as const;
export const SIGNATURE_TYPES = ['digital_draw', 'paper_photo'] as const;

export const CONDITION_VALUES = ['pristine', 'good', 'minor_wear', 'damage_flagged'] as const;

// Default policy — used when workspace.settings.dispatch_return_policy is absent
// (mirrors the migration 057 + 058 seed; config-first, never hardcoded downstream).
const DEFAULT_POLICY = {
  photos_required_per_item: 2,
  photos_required_per_item_type: { equipment: 1, serial: 1 } as Record<string, number>,
  signature_required: true,
  signature_types_allowed: ['digital_draw', 'paper_photo'] as string[],
  signature_skip_requires_reason: true,
  otp_required: true,
  otp_fallback_when_no_provider: 'allow_skip_with_reason',
  otp_valid_for_session_only: true,
  otp_skip_requires_approval_over_paise: 25000,
  // WhatsApp template (pre-approved) used to send the OTP; workspace-editable.
  otp_template_name: 'dispatch_otp',
  customer_notification_channels: ['whatsapp', 'email'] as string[],
  delegate_pickup_allowed: true,
  delegate_requires_id_proof: false,
  gps_capture_at_dispatch: false,
};
type DispatchPolicy = typeof DEFAULT_POLICY;

// ---------------------------------------------------------------------------
// Zod schemas (exported — Rule A contract tests parse/reject against these).
// ---------------------------------------------------------------------------
export const dispatchCreateSchema = z.object({
  recipient_type: z.enum(RECIPIENT_TYPES).optional(),
});

export const recipientSchema = z
  .object({
    recipient_type: z.enum(RECIPIENT_TYPES),
    delegate_name: z.string().min(1).max(200).nullish(),
    delegate_phone: z.string().min(3).max(40).nullish(),
    delegate_relationship: z.enum(DELEGATE_RELATIONSHIPS).nullish(),
    delegate_id_proof_url: z.string().max(2000).nullish(),
  })
  .refine((v) => v.recipient_type !== 'delegate' || (!!v.delegate_name && !!v.delegate_phone), {
    message: 'delegate pickup requires delegate_name and delegate_phone',
    path: ['delegate_name'],
  });

export const photoSchema = z.object({
  order_item_id: z.string().uuid().nullish(),
  asset_id: z.string().uuid().nullish(),
  photo_type: z.enum(PHOTO_TYPES),
  photo_base64: z.string().min(16), // data: URI or raw base64
  content_type: z.string().max(80).optional(),
  gps_lat: z.number().min(-90).max(90).nullish(),
  gps_lng: z.number().min(-180).max(180).nullish(),
  device_metadata: z.record(z.any()).optional(),
});

export const otpSendSchema = z.object({
  channel: z.enum(OTP_SEND_CHANNELS).optional(),
});
export const otpVerifySchema = z.object({
  code: z.string().regex(/^\d{4,8}$/, 'code must be 4–8 digits'),
});
export const otpSkipSchema = z.object({
  skip_reason: z.string().min(1).max(200),
  skip_reason_notes: z.string().max(2000).nullish(),
});
// Session 2 — signature now supports a policy-gated skip (signature_base64 omitted
// when skipped; a skip_reason is required when the policy demands one).
export const signatureSchema = z
  .object({
    signature_type: z.enum(SIGNATURE_TYPES).optional(),
    signature_base64: z.string().min(16).optional(),
    content_type: z.string().max(80).optional(),
    skipped: z.boolean().optional(),
    skip_reason: z.string().min(1).max(300).nullish(),
  })
  .refine((v) => v.skipped === true || (!!v.signature_type && !!v.signature_base64), {
    message: 'signature_type and signature_base64 are required unless skipped',
    path: ['signature_base64'],
  });

export const completeSchema = z
  .object({ item_ids: z.array(z.string().uuid()).optional() })
  .passthrough();

// Session 2 — Section B (equipment checklist) schemas.
export const itemsChecklistSchema = z.object({
  item_ids: z.array(z.string().uuid()).min(1),
});
export const serialSchema = z.object({
  captured_serial: z.string().min(1).max(120),
  override: z.boolean().optional(),
});
export const conditionSchema = z.object({
  condition: z.enum(CONDITION_VALUES),
});

// ---------------------------------------------------------------------------
// Shared helpers (inline — no new lib abstraction per Session-1 rules).
// ---------------------------------------------------------------------------
type DispatchRow = {
  id: string; workspace_id: string; order_id: string; dispatch_number: string | null;
  recipient_type: string; status: string;
};

async function loadDispatch(workspaceId: string, dispatchId: string): Promise<DispatchRow | null> {
  const rows = await query<DispatchRow>(sql`
    SELECT id, workspace_id, order_id, dispatch_number, recipient_type, status
    FROM dispatches
    WHERE id = ${dispatchId}::uuid AND workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `);
  return rows[0] ?? null;
}

async function loadPolicy(workspaceId: string): Promise<DispatchPolicy> {
  const rows = await query<{ policy: Partial<DispatchPolicy> | null }>(sql`
    SELECT settings->'dispatch_return_policy' AS policy
    FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
  `);
  return { ...DEFAULT_POLICY, ...(rows[0]?.policy ?? {}) };
}

// Section B persistence (reconciled to the shipped order_items schema — no new
// per-dispatch item table): the captured serial lives in order_items.dispatch_notes,
// the dispatch condition in order_items.condition_notes. Photo counts per type come
// from dispatch_photos for THIS dispatch. The wizard reads this back on reload.
type DispatchItemRow = {
  id: string; description: string; quantity: number; item_type: string;
  product_id: string | null; status: string;
  dispatch_notes: string | null; condition_notes: string | null;
  expected_serials: string[] | null;
  equipment_photos: number; serial_photos: number; total_photos: number;
};

async function loadDispatchItems(workspaceId: string, orderId: string, dispatchId: string) {
  return await query<DispatchItemRow>(sql`
    SELECT oi.id, oi.description, oi.quantity, oi.item_type::text AS item_type,
           oi.product_id, oi.status::text AS status,
           oi.dispatch_notes, oi.condition_notes,
           (SELECT json_agg(a.serial_number ORDER BY a.asset_code)
              FROM assets a
              WHERE a.product_id = oi.product_id AND a.workspace_id = ${workspaceId}::uuid
                AND a.deleted_at IS NULL AND a.serial_number IS NOT NULL
                AND a.status = 'available'::asset_status) AS expected_serials,
           COALESCE((SELECT COUNT(*) FROM dispatch_photos dp
              WHERE dp.dispatch_id = ${dispatchId}::uuid AND dp.order_item_id = oi.id
                AND dp.photo_type = 'equipment'), 0)::int AS equipment_photos,
           COALESCE((SELECT COUNT(*) FROM dispatch_photos dp
              WHERE dp.dispatch_id = ${dispatchId}::uuid AND dp.order_item_id = oi.id
                AND dp.photo_type = 'serial'), 0)::int AS serial_photos,
           COALESCE((SELECT COUNT(*) FROM dispatch_photos dp
              WHERE dp.dispatch_id = ${dispatchId}::uuid AND dp.order_item_id = oi.id), 0)::int AS total_photos
    FROM order_items oi
    WHERE oi.order_id = ${orderId}::uuid AND oi.workspace_id = ${workspaceId}::uuid
      AND oi.item_type = 'rental'
    ORDER BY oi.sort_order ASC, oi.created_at ASC
  `);
}

// Mask a phone for display: keep the last 4 digits (+91 98****5678).
function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const s = String(phone);
  if (s.length <= 4) return s;
  return s.slice(0, Math.max(0, s.length - 8)).replace(/./g, '*') + '****' + s.slice(-4);
}

// Two-row write: order_events (timeline) + audit_events (security). order_events
// event_type is plain text; audit uses the typed catalog.
async function recordDispatchEvent(args: {
  workspaceId: string; orderId: string; actorUserId: string;
  timelineType: string; auditType: AuditEventType;
  payload: Record<string, unknown>; ip: string | null; ua: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO order_events (workspace_id, order_id, event_type, payload, actor_user_id)
    VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, ${args.timelineType}::text,
            ${JSON.stringify(args.payload)}::jsonb, ${args.actorUserId}::uuid)
  `;
  await audit({
    workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: args.auditType,
    targetType: 'dispatch', targetId: String(args.payload.dispatch_id ?? ''),
    payload: args.payload, ipAddress: args.ip, userAgent: args.ua,
  });
}

// Persist a base64 image → Vercel Blob URL when a token is configured, else a
// data: URI (keeps the flow working with no external infra + round-trip testable).
async function persistImage(
  workspaceId: string, dispatchId: string, kind: 'photos' | 'signatures',
  base64: string, contentType: string,
): Promise<string> {
  const isDataUri = base64.startsWith('data:');
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    // No blob store → inline. Normalise to a data: URI.
    return isDataUri ? base64 : `data:${contentType};base64,${base64}`;
  }
  const raw = isDataUri ? base64.slice(base64.indexOf(',') + 1) : base64;
  const buffer = Buffer.from(raw, 'base64');
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `workspaces/${workspaceId}/dispatches/${dispatchId}/${kind}-${Date.now()}-${rand}.jpg`;
  const blob = await put(path, buffer, { access: 'public', contentType, addRandomSuffix: false });
  return blob.url;
}

const err = (code: string, message: string, reasons: unknown[] = []) => ({ error: { code, message, reasons } });

// ===========================================================================
// ORDER-SCOPED — folded into the orders router (NO global middleware here).
// ===========================================================================
export const orderDispatches = new Hono<Env>();

// POST /api/orders/:orderId/dispatches — open a new dispatch record.
orderDispatches.post('/:orderId/dispatches', requirePermission('dispatch.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const orderId = c.req.param('orderId');
  const { ipAddress, userAgent } = clientCtx(c);

  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = dispatchCreateSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid dispatch payload', parsed.error.issues), 400);

  const order = await query<{ id: string; order_number: number; customer_person_id: string | null; kyc_status: string | null; gate_on_dispatch: boolean | null }>(sql`
    SELECT o.id, o.order_number, o.customer_person_id, p.kyc_status,
           (w.settings->'kyc_policy'->>'gate_on_dispatch')::boolean AS gate_on_dispatch
    FROM orders o
    JOIN workspaces w ON w.id = o.workspace_id
    LEFT JOIN people p ON p.id = o.customer_person_id
    WHERE o.id = ${orderId}::uuid AND o.workspace_id = ${workspaceId}::uuid LIMIT 1
  `);
  if (!order.length) return c.json(err('order_not_found', 'Order not found in this workspace'), 404);

  // Slice 8: KYC dispatch gate (server-enforced hard block, Item 12 shape).
  // Config default true; a customer whose KYC is not 'verified' can't be
  // dispatched until an operator verifies them (or the workspace disables the
  // gate). The frontend pre-checks the same signal; this is the backstop.
  const gateOn = order[0]!.gate_on_dispatch !== false; // default true when unset
  if (gateOn && order[0]!.kyc_status !== 'verified') {
    return c.json({
      error: 'kyc_not_verified',
      reasons: [{
        message: `KYC not verified for this customer (status: ${order[0]!.kyc_status ?? 'not_started'}). Complete KYC before dispatch.`,
        severity: 'error',
        fix_link_target: order[0]!.customer_person_id ? `/person-360.html?id=${order[0]!.customer_person_id}#kyc` : null,
      }],
    }, 409);
  }

  // Mint DS-YYYY-{order_number}-{seq}. seq = existing dispatches for the order + 1;
  // the partial-unique index (workspace_id, dispatch_number) is the collision backstop.
  const seqRow = await query<{ seq: number }>(sql`
    SELECT COUNT(*)::int + 1 AS seq FROM dispatches
    WHERE order_id = ${orderId}::uuid AND workspace_id = ${workspaceId}::uuid
  `);
  const seq = seqRow[0]?.seq ?? 1;

  const inserted = await query<DispatchRow & { created_at: string }>(sql`
    INSERT INTO dispatches (workspace_id, order_id, dispatch_number, recipient_type, status, dispatch_started_at)
    VALUES (
      ${workspaceId}::uuid, ${orderId}::uuid,
      'DS-' || to_char(now(), 'YYYY') || '-' || ${order[0]!.order_number}::text || '-' || ${seq}::text,
      ${parsed.data.recipient_type ?? 'customer'}::text,
      'prepare'::text, now()
    )
    RETURNING id, workspace_id, order_id, dispatch_number, recipient_type, status, created_at
  `);
  const dispatch = inserted[0]!;

  await recordDispatchEvent({
    workspaceId, orderId, actorUserId: session.user.id,
    timelineType: 'order.dispatch.opened', auditType: 'dispatches.created',
    payload: { dispatch_id: dispatch.id, dispatch_number: dispatch.dispatch_number },
    ip: ipAddress, ua: userAgent,
  });

  return c.json({ dispatch }, 201);
});

// ===========================================================================
// ID-SCOPED — /api/dispatches/:dispatchId/... (own middleware chain).
// ===========================================================================
export const dispatches = new Hono<Env>();
dispatches.use('*', sessionMiddleware, requireAuth);
dispatches.use('*', idempotencyMiddleware);

// GET /:dispatchId — read a dispatch + its order summary + the workspace policy
// (powers /dispatch.html). Any authenticated member may view (reads are requireAuth
// per repo convention); GET is exempt from the idempotency middleware.
dispatches.get('/:dispatchId', async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const rows = await query<{
    id: string; dispatch_number: string | null; recipient_type: string; status: string;
    delegate_name: string | null; delegate_phone: string | null; delegate_relationship: string | null; delegate_id_proof_url: string | null;
    order_id: string; order_number: number; order_status: string; customer_name: string | null; customer_phone: string | null;
  }>(sql`
    SELECT d.id, d.dispatch_number, d.recipient_type, d.status,
           d.delegate_name, d.delegate_phone, d.delegate_relationship, d.delegate_id_proof_url,
           d.order_id, o.order_number, o.status::text AS order_status,
           p.display_name AS customer_name, p.phone AS customer_phone
    FROM dispatches d
    JOIN orders o ON o.id = d.order_id AND o.workspace_id = d.workspace_id
    LEFT JOIN people p ON p.id = o.customer_person_id
    WHERE d.id = ${c.req.param('dispatchId')}::uuid AND d.workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `);
  if (!rows.length) return c.json(err('dispatch_not_found', 'Dispatch not found'), 404);
  const d = rows[0]!;
  const policy = await loadPolicy(workspaceId);
  const items = await loadDispatchItems(workspaceId, d.order_id, d.id);

  // Latest OTP + signature state so the wizard rehydrates on reload.
  const otp = await query<{ id: string; otp_verified: boolean; otp_sent_via: string | null; skip_reason: string | null; otp_sent_to_phone: string | null }>(sql`
    SELECT id, otp_verified, otp_sent_via, skip_reason, otp_sent_to_phone
    FROM dispatch_otp_verifications WHERE dispatch_id = ${d.id}::uuid
    ORDER BY created_at DESC LIMIT 1
  `);
  const sig = await query<{ id: string; signature_type: string | null; signature_url: string | null; skipped: boolean; skip_reason: string | null }>(sql`
    SELECT id, signature_type, signature_url, skipped, skip_reason
    FROM dispatch_signatures WHERE dispatch_id = ${d.id}::uuid
    ORDER BY created_at DESC LIMIT 1
  `);
  const o = otp[0] ?? null;
  return c.json({
    dispatch: { ...d, customer_phone_masked: maskPhone(d.customer_phone) },
    policy,
    items,
    otp_state: o
      ? { verified: o.otp_verified, skipped: o.otp_sent_via === 'skipped', skip_reason: o.skip_reason, sent_to: maskPhone(o.otp_sent_to_phone) }
      : null,
    signature_state: sig[0] ?? null,
  }, 200);
});

// POST /:dispatchId/recipient — record recipient type + delegate info.
dispatches.post('/:dispatchId/recipient', requirePermission('dispatch.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const d = await loadDispatch(workspaceId, c.req.param('dispatchId'));
  if (!d) return c.json(err('dispatch_not_found', 'Dispatch not found'), 404);

  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = recipientSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid recipient payload', parsed.error.issues), 400);
  const p = parsed.data;

  const policy = await loadPolicy(workspaceId);
  if (p.recipient_type === 'delegate') {
    if (!policy.delegate_pickup_allowed) return c.json(err('delegate_not_allowed', 'Delegate pickup is disabled for this workspace'), 403);
    if (policy.delegate_requires_id_proof && !p.delegate_id_proof_url) {
      return c.json(err('delegate_id_required', 'Delegate ID proof is required by policy', [{ code: 'delegate_id_proof_url', message: 'ID proof required' }]), 403);
    }
  }

  const updated = await query<DispatchRow>(sql`
    UPDATE dispatches SET
      recipient_type        = ${p.recipient_type}::text,
      delegate_name         = ${p.recipient_type === 'delegate' ? p.delegate_name ?? null : null}::text,
      delegate_phone        = ${p.recipient_type === 'delegate' ? p.delegate_phone ?? null : null}::text,
      delegate_relationship = ${p.recipient_type === 'delegate' ? p.delegate_relationship ?? null : null}::text,
      delegate_id_proof_url = ${p.recipient_type === 'delegate' ? p.delegate_id_proof_url ?? null : null}::text,
      status                = CASE WHEN status = 'prepare' THEN 'handover' ELSE status END,
      updated_at            = now()
    WHERE id = ${d.id}::uuid AND workspace_id = ${workspaceId}::uuid
    RETURNING id, workspace_id, order_id, dispatch_number, recipient_type, status
  `);

  await recordDispatchEvent({
    workspaceId, orderId: d.order_id, actorUserId: session.user.id,
    timelineType: 'order.dispatch.recipient', auditType: 'dispatches.recipient_recorded',
    payload: { dispatch_id: d.id, recipient_type: p.recipient_type, delegate: p.recipient_type === 'delegate' ? { name: p.delegate_name, relationship: p.delegate_relationship } : null },
    ip: ipAddress, ua: userAgent,
  });

  return c.json({ dispatch: updated[0] }, 200);
});

// POST /:dispatchId/items — record the checklist scope (which items go out now).
// Supports partial dispatch: only the passed item_ids are in scope. Persistence of
// which subset rides on the timeline event + the frontend passes item_ids to
// /complete; the per-item serial/condition live on the order_items rows (below).
dispatches.post('/:dispatchId/items', requirePermission('dispatch.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const d = await loadDispatch(workspaceId, c.req.param('dispatchId'));
  if (!d) return c.json(err('dispatch_not_found', 'Dispatch not found'), 404);

  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = itemsChecklistSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid items payload', parsed.error.issues), 400);

  // Validate every id is a rental line on this order.
  const valid = await query<{ id: string }>(sql`
    SELECT id FROM order_items
    WHERE order_id = ${d.order_id}::uuid AND workspace_id = ${workspaceId}::uuid
      AND item_type = 'rental' AND id::text = ANY(string_to_array(${parsed.data.item_ids.join(',')}::text, ','))
  `);
  const validIds = new Set(valid.map((r) => r.id));
  const unknown = parsed.data.item_ids.filter((x) => !validIds.has(x));
  if (unknown.length) return c.json(err('invalid_item_ids', 'Some items are not rental lines on this order', unknown), 400);

  await recordDispatchEvent({
    workspaceId, orderId: d.order_id, actorUserId: session.user.id,
    timelineType: 'order.dispatch.items', auditType: 'dispatches.items_recorded',
    payload: { dispatch_id: d.id, item_ids: parsed.data.item_ids, count: parsed.data.item_ids.length },
    ip: ipAddress, ua: userAgent,
  });
  const items = await loadDispatchItems(workspaceId, d.order_id, d.id);
  return c.json({ status: 'recorded', item_ids: parsed.data.item_ids, items }, 200);
});

// POST /:dispatchId/items/:itemId/serial — capture + QR-verify a unit serial.
// Match = an AVAILABLE asset of this product carries that serial. A mismatch is
// advisory: it persists only when override=true (the operator confirmed). The
// captured serial is stored on order_items.dispatch_notes so it rehydrates.
dispatches.post('/:dispatchId/items/:itemId/serial', requirePermission('dispatch.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const d = await loadDispatch(workspaceId, c.req.param('dispatchId'));
  if (!d) return c.json(err('dispatch_not_found', 'Dispatch not found'), 404);
  const itemId = c.req.param('itemId');

  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = serialSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid serial payload', parsed.error.issues), 400);
  const captured = parsed.data.captured_serial.trim();

  const item = await query<{ id: string; product_id: string | null }>(sql`
    SELECT id, product_id FROM order_items
    WHERE id = ${itemId}::uuid AND order_id = ${d.order_id}::uuid AND workspace_id = ${workspaceId}::uuid
      AND item_type = 'rental' LIMIT 1
  `);
  if (!item.length) return c.json(err('item_not_found', 'Rental item not found on this order'), 404);

  // Match against an available serialized unit of this product.
  const matchRow = await query<{ asset_code: string }>(sql`
    SELECT asset_code FROM assets
    WHERE workspace_id = ${workspaceId}::uuid AND product_id = ${item[0]!.product_id}::uuid
      AND deleted_at IS NULL AND status = 'available'::asset_status
      AND lower(serial_number) = lower(${captured}::text)
    LIMIT 1
  `);
  const matched = matchRow.length > 0;

  // Mismatch without an override → advisory 409 with the expected serials so the
  // UI can show the warning modal. Nothing persisted until the operator overrides.
  if (!matched && parsed.data.override !== true) {
    const expected = await query<{ serial_number: string | null }>(sql`
      SELECT serial_number FROM assets
      WHERE workspace_id = ${workspaceId}::uuid AND product_id = ${item[0]!.product_id}::uuid
        AND deleted_at IS NULL AND status = 'available'::asset_status AND serial_number IS NOT NULL
      ORDER BY asset_code ASC
    `);
    return c.json({
      status: 'mismatch',
      matched: false,
      captured_serial: captured,
      expected_serials: expected.map((e) => e.serial_number).filter(Boolean),
    }, 409);
  }

  const note = matched ? captured : `${captured} (override: no available unit matches)`;
  await sql`
    UPDATE order_items SET dispatch_notes = ${note}::text, updated_at = now()
    WHERE id = ${itemId}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  await recordDispatchEvent({
    workspaceId, orderId: d.order_id, actorUserId: session.user.id,
    timelineType: 'order.dispatch.serial', auditType: 'dispatches.serial_verified',
    payload: { dispatch_id: d.id, item_id: itemId, captured_serial: captured, matched, override: parsed.data.override === true },
    ip: ipAddress, ua: userAgent,
  });
  return c.json({ status: matched ? 'matched' : 'overridden', matched, captured_serial: captured, asset_code: matchRow[0]?.asset_code ?? null }, 200);
});

// POST /:dispatchId/items/:itemId/condition — record the dispatch condition.
dispatches.post('/:dispatchId/items/:itemId/condition', requirePermission('dispatch.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const d = await loadDispatch(workspaceId, c.req.param('dispatchId'));
  if (!d) return c.json(err('dispatch_not_found', 'Dispatch not found'), 404);
  const itemId = c.req.param('itemId');

  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = conditionSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid condition payload', parsed.error.issues), 400);

  const updated = await query<{ id: string }>(sql`
    UPDATE order_items SET condition_notes = ${parsed.data.condition}::text, updated_at = now()
    WHERE id = ${itemId}::uuid AND order_id = ${d.order_id}::uuid AND workspace_id = ${workspaceId}::uuid
      AND item_type = 'rental'
    RETURNING id
  `);
  if (!updated.length) return c.json(err('item_not_found', 'Rental item not found on this order'), 404);

  await recordDispatchEvent({
    workspaceId, orderId: d.order_id, actorUserId: session.user.id,
    timelineType: 'order.dispatch.condition', auditType: 'dispatches.condition_recorded',
    payload: { dispatch_id: d.id, item_id: itemId, condition: parsed.data.condition },
    ip: ipAddress, ua: userAgent,
  });
  return c.json({ status: 'recorded', item_id: itemId, condition: parsed.data.condition }, 200);
});

// POST /:dispatchId/photos — capture a condition/handover photo.
dispatches.post('/:dispatchId/photos', requirePermission('dispatch.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const d = await loadDispatch(workspaceId, c.req.param('dispatchId'));
  if (!d) return c.json(err('dispatch_not_found', 'Dispatch not found'), 404);

  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = photoSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid photo payload', parsed.error.issues), 400);
  const p = parsed.data;

  let photoUrl: string;
  try {
    photoUrl = await persistImage(workspaceId, d.id, 'photos', p.photo_base64, p.content_type ?? 'image/jpeg');
  } catch (e) {
    console.error('dispatch photo persist failed', e);
    return c.json(err('upload_failed', 'Could not store the photo'), 500);
  }

  const inserted = await query<{ id: string; captured_at: string }>(sql`
    INSERT INTO dispatch_photos
      (workspace_id, dispatch_id, order_item_id, asset_id, photo_url, photo_type,
       captured_by_user_id, gps_lat, gps_lng, device_metadata)
    VALUES (
      ${workspaceId}::uuid, ${d.id}::uuid, ${p.order_item_id ?? null}::uuid, ${p.asset_id ?? null}::uuid,
      ${photoUrl}::text, ${p.photo_type}::text, ${session.user.id}::uuid,
      ${p.gps_lat ?? null}::numeric, ${p.gps_lng ?? null}::numeric,
      ${JSON.stringify(p.device_metadata ?? {})}::jsonb
    )
    RETURNING id, captured_at
  `);

  await recordDispatchEvent({
    workspaceId, orderId: d.order_id, actorUserId: session.user.id,
    timelineType: 'order.dispatch.photo', auditType: 'dispatches.photo_captured',
    payload: { dispatch_id: d.id, photo_id: inserted[0]!.id, photo_type: p.photo_type, order_item_id: p.order_item_id ?? null },
    ip: ipAddress, ua: userAgent,
  });

  return c.json({ photo: { id: inserted[0]!.id, photo_url: photoUrl, photo_type: p.photo_type, captured_at: inserted[0]!.captured_at } }, 201);
});

// POST /:dispatchId/otp — send an OTP via the active whatsapp adapter, or report
// provider_not_configured (frontend falls back to skip-with-reason per policy).
dispatches.post('/:dispatchId/otp', requirePermission('dispatch.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const d = await loadDispatch(workspaceId, c.req.param('dispatchId'));
  if (!d) return c.json(err('dispatch_not_found', 'Dispatch not found'), 404);

  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = otpSendSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid OTP payload', parsed.error.issues), 400);
  const channel = parsed.data.channel ?? 'whatsapp';
  const policy = await loadPolicy(workspaceId);

  const cust = await query<{ id: string | null; phone: string | null }>(sql`
    SELECT p.id, p.phone FROM orders o LEFT JOIN people p ON p.id = o.customer_person_id
    WHERE o.id = ${d.order_id}::uuid AND o.workspace_id = ${workspaceId}::uuid LIMIT 1
  `);
  const phone = cust[0]?.phone ?? null;
  const personId = cust[0]?.id ?? null;

  // REAL crypto: mint a 6-digit code (crypto.randomInt, not Math.random), bcrypt-hash
  // it, and store ONLY the hash + a generation timestamp. The plaintext is sent to the
  // customer and never persisted (Q3: session-based validity, no timer expiry).
  const code = String(randomInt(100000, 1000000));
  const codeHash = await bcrypt.hash(code, 10);

  // Slice 10 (Q3): route the WhatsApp OTP through the ONE canonical customer
  // pipeline (emitCustomerNotification) instead of calling the adapter directly.
  // dispatch_otp_send is seeded mode='auto' (real-time critical); policy + the
  // customer's channel opt-in still apply uniformly. redactRender keeps the
  // plaintext code out of the persisted delivery snapshot. Map the unified result
  // back to the existing send-result shape so the downstream OTP-row logic is
  // unchanged. No active real provider / opted-out → no OTP row; the frontend
  // offers skip-with-reason if policy allows.
  let sendResult: { status: 'sent' | 'failed' | 'provider_not_configured'; messageId?: string; error?: string } =
    { status: 'provider_not_configured' };
  if (phone) {
    const notif = await emitCustomerNotification({
      workspaceId, orderId: d.order_id, personId, eventType: 'dispatch_otp_send',
      message: 'Dispatch verification OTP', channels: ['whatsapp'], contact: { phone },
      whatsapp: { templateName: policy.otp_template_name, variables: { '1': code } },
      redactRender: true,
    });
    const wa = notif.deliveries.find((x) => x.channel === 'whatsapp');
    sendResult = wa?.status === 'sent'
      ? { status: 'sent', messageId: wa.provider_ref ?? undefined }
      : wa?.status === 'failed'
        ? { status: 'failed', error: wa.reason ?? 'send_failed' }
        : { status: 'provider_not_configured', error: wa?.reason };
  } else {
    sendResult = { status: 'failed', error: 'customer_has_no_phone' };
  }

  if (sendResult.status === 'provider_not_configured') {
    return c.json({
      status: 'provider_not_configured',
      reason: sendResult.error ?? null,
      fallback_allowed: policy.otp_fallback_when_no_provider === 'allow_skip_with_reason',
    }, 200);
  }

  // A send was attempted (sent OR failed) — record the OTP row with the hash so a
  // 'sent' code can be verified. A 'failed' send is surfaced honestly (Q6: no
  // silent failures) and the operator can re-send or skip.
  const otp = await query<{ id: string }>(sql`
    INSERT INTO dispatch_otp_verifications
      (workspace_id, dispatch_id, otp_sent_to_phone, otp_sent_via, otp_code_hash, otp_generated_at, provider_ref)
    VALUES (${workspaceId}::uuid, ${d.id}::uuid, ${phone}::text, ${channel}::text,
            ${codeHash}::text, now(), ${sendResult.messageId ?? null}::text)
    RETURNING id
  `);

  await recordDispatchEvent({
    workspaceId, orderId: d.order_id, actorUserId: session.user.id,
    timelineType: 'order.dispatch.otp_sent', auditType: 'dispatches.otp_sent',
    payload: { dispatch_id: d.id, otp_id: otp[0]!.id, channel, send_status: sendResult.status },
    ip: ipAddress, ua: userAgent,
  });

  if (sendResult.status === 'failed') {
    return c.json({ status: 'send_failed', otp_id: otp[0]!.id, error: sendResult.error ?? 'send_error',
      fallback_allowed: policy.otp_fallback_when_no_provider === 'allow_skip_with_reason' }, 200);
  }
  return c.json({ status: 'sent', otp_id: otp[0]!.id, channel, sent_to: maskPhone(phone) }, 201);
});

// POST /:dispatchId/otp/verify — mark the latest OTP verified (operator attestation).
dispatches.post('/:dispatchId/otp/verify', requirePermission('dispatch.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const d = await loadDispatch(workspaceId, c.req.param('dispatchId'));
  if (!d) return c.json(err('dispatch_not_found', 'Dispatch not found'), 404);

  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = otpVerifySchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid OTP code', parsed.error.issues), 400);

  // Latest un-skipped OTP row for this dispatch (session-based validity: the code
  // stays valid until the dispatch completes — no timer expiry, Q3).
  const rows = await query<{ id: string; otp_code_hash: string | null }>(sql`
    SELECT id, otp_code_hash FROM dispatch_otp_verifications
    WHERE dispatch_id = ${d.id}::uuid AND workspace_id = ${workspaceId}::uuid
      AND otp_sent_via <> 'skipped'
    ORDER BY created_at DESC LIMIT 1
  `);
  if (!rows.length) return c.json(err('no_otp_to_verify', 'No OTP has been sent for this dispatch'), 409);
  if (!rows[0]!.otp_code_hash) return c.json(err('no_otp_to_verify', 'No verifiable OTP code on record — re-send'), 409);

  // Real bcrypt comparison against the stored hash. A wrong code is a 401 (the
  // frontend caps retries at 3 before forcing a re-send or skip).
  const ok = await bcrypt.compare(parsed.data.code, rows[0]!.otp_code_hash);
  if (!ok) return c.json(err('otp_incorrect', 'The code does not match. Check with the customer and retry.'), 401);

  await sql`
    UPDATE dispatch_otp_verifications SET otp_verified = true, otp_verified_at = now()
    WHERE id = ${rows[0]!.id}::uuid AND workspace_id = ${workspaceId}::uuid
  `;

  await recordDispatchEvent({
    workspaceId, orderId: d.order_id, actorUserId: session.user.id,
    timelineType: 'order.dispatch.otp_verified', auditType: 'dispatches.otp_verified',
    payload: { dispatch_id: d.id, otp_id: rows[0]!.id },
    ip: ipAddress, ua: userAgent,
  });

  return c.json({ status: 'verified', otp_id: rows[0]!.id }, 200);
});

// POST /:dispatchId/otp/skip — record a skip with reason (only if policy allows).
dispatches.post('/:dispatchId/otp/skip', requirePermission('dispatch.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const d = await loadDispatch(workspaceId, c.req.param('dispatchId'));
  if (!d) return c.json(err('dispatch_not_found', 'Dispatch not found'), 404);

  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = otpSkipSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'A skip reason is required', parsed.error.issues), 400);

  const policy = await loadPolicy(workspaceId);
  if (policy.otp_required && policy.otp_fallback_when_no_provider !== 'allow_skip_with_reason') {
    return c.json(err('otp_skip_not_allowed', 'OTP is required and skipping is disabled by policy'), 403);
  }

  // Approval threshold: a skip on a high-value order is FLAGGED (requires_approval)
  // — not blocked (Q4: skip is always allowed with a reason). The flag is recorded
  // on the row + surfaced to the operator (Item 12). Routing to the approvals queue
  // is a later slice; for now the flag makes the risk visible + auditable.
  const ord = await query<{ total: number }>(sql`
    SELECT COALESCE(SUM(chargeable_paise), 0)::bigint AS total FROM order_items
    WHERE order_id = ${d.order_id}::uuid AND workspace_id = ${workspaceId}::uuid
  `);
  const orderTotal = Number(ord[0]?.total ?? 0);
  const requiresApproval = orderTotal > Number(policy.otp_skip_requires_approval_over_paise);

  const notes = requiresApproval
    ? `${parsed.data.skip_reason_notes ?? ''}${parsed.data.skip_reason_notes ? ' | ' : ''}requires_approval (order ₹${Math.round(orderTotal / 100)})`
    : parsed.data.skip_reason_notes ?? null;

  const otp = await query<{ id: string }>(sql`
    INSERT INTO dispatch_otp_verifications
      (workspace_id, dispatch_id, otp_sent_via, skip_reason, skip_reason_notes)
    VALUES (${workspaceId}::uuid, ${d.id}::uuid, 'skipped'::text, ${parsed.data.skip_reason}::text, ${notes}::text)
    RETURNING id
  `);

  await recordDispatchEvent({
    workspaceId, orderId: d.order_id, actorUserId: session.user.id,
    timelineType: 'order.dispatch.otp_skipped', auditType: 'dispatches.otp_skipped',
    payload: { dispatch_id: d.id, otp_id: otp[0]!.id, skip_reason: parsed.data.skip_reason, requires_approval: requiresApproval },
    ip: ipAddress, ua: userAgent,
  });

  return c.json({ status: 'skipped', otp_id: otp[0]!.id, requires_approval: requiresApproval }, 201);
});

// POST /:dispatchId/signature — record a witnessed pickup signature.
dispatches.post('/:dispatchId/signature', requirePermission('dispatch.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const d = await loadDispatch(workspaceId, c.req.param('dispatchId'));
  if (!d) return c.json(err('dispatch_not_found', 'Dispatch not found'), 404);

  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = signatureSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid signature payload', parsed.error.issues), 400);
  const p = parsed.data;
  const policy = await loadPolicy(workspaceId);

  // SKIP path (Q5): policy-gated. When signature_skip_requires_reason is on, a
  // skip_reason is mandatory. Stored as a skipped row (no image, no type).
  if (p.skipped === true) {
    if (policy.signature_skip_requires_reason && !p.skip_reason) {
      return c.json(err('skip_reason_required', 'A reason is required to skip the signature', [{ code: 'skip_reason', message: 'Reason required' }]), 400);
    }
    const skipped = await query<{ id: string; captured_at: string }>(sql`
      INSERT INTO dispatch_signatures
        (workspace_id, dispatch_id, signature_type, signature_url, skipped, skip_reason, captured_by_user_id)
      VALUES (${workspaceId}::uuid, ${d.id}::uuid, NULL, NULL, true, ${p.skip_reason ?? null}::text, ${session.user.id}::uuid)
      RETURNING id, captured_at
    `);
    await recordDispatchEvent({
      workspaceId, orderId: d.order_id, actorUserId: session.user.id,
      timelineType: 'order.dispatch.signature', auditType: 'dispatches.signature_captured',
      payload: { dispatch_id: d.id, signature_id: skipped[0]!.id, skipped: true, skip_reason: p.skip_reason ?? null },
      ip: ipAddress, ua: userAgent,
    });
    return c.json({ signature: { id: skipped[0]!.id, skipped: true, skip_reason: p.skip_reason ?? null, captured_at: skipped[0]!.captured_at } }, 201);
  }

  // Captured path — signature_type + base64 guaranteed present by the schema refine.
  const sigType = p.signature_type!;
  if (!policy.signature_types_allowed.includes(sigType)) {
    return c.json(err('signature_type_not_allowed', `Signature type ${sigType} is not allowed by policy`), 403);
  }

  let sigUrl: string;
  try {
    sigUrl = await persistImage(workspaceId, d.id, 'signatures', p.signature_base64!, p.content_type ?? 'image/png');
  } catch (e) {
    console.error('dispatch signature persist failed', e);
    return c.json(err('upload_failed', 'Could not store the signature'), 500);
  }

  const inserted = await query<{ id: string; captured_at: string }>(sql`
    INSERT INTO dispatch_signatures
      (workspace_id, dispatch_id, signature_type, signature_url, skipped, captured_by_user_id)
    VALUES (${workspaceId}::uuid, ${d.id}::uuid, ${sigType}::text, ${sigUrl}::text, false, ${session.user.id}::uuid)
    RETURNING id, captured_at
  `);

  await recordDispatchEvent({
    workspaceId, orderId: d.order_id, actorUserId: session.user.id,
    timelineType: 'order.dispatch.signature', auditType: 'dispatches.signature_captured',
    payload: { dispatch_id: d.id, signature_id: inserted[0]!.id, signature_type: sigType },
    ip: ipAddress, ua: userAgent,
  });

  return c.json({ signature: { id: inserted[0]!.id, signature_type: sigType, captured_at: inserted[0]!.captured_at } }, 201);
});

// POST /:dispatchId/complete — Phase 3 Confirm. Verify required captures per policy
// (Item 12 Blocked-Action: a 403 with a structured reasons[] when short), then run
// the shared physical commit + customer notification. Q7 atomic sequence.
dispatches.post('/:dispatchId/complete', requirePermission('dispatch.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const d = await loadDispatch(workspaceId, c.req.param('dispatchId'));
  if (!d) return c.json(err('dispatch_not_found', 'Dispatch not found'), 404);
  if (d.status === 'completed') return c.json(err('already_completed', 'This dispatch is already completed'), 409);

  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsedBody = completeSchema.safeParse(body);
  if (!parsedBody.success) return c.json(err('invalid_body', 'Invalid complete payload', parsedBody.error.issues), 400);

  const policy = await loadPolicy(workspaceId);
  const reasons: { code: string; message: string; order_item_id?: string }[] = [];

  // The pending rental lines to dispatch (optionally narrowed by body.item_ids).
  const requestedIds = parsedBody.data.item_ids ? new Set(parsedBody.data.item_ids) : null;
  const pending = await query<{ id: string; item_type: string; product_id: string | null; quantity: number }>(sql`
    SELECT id, item_type::text AS item_type, product_id, quantity FROM order_items
    WHERE order_id = ${d.order_id}::uuid AND workspace_id = ${workspaceId}::uuid
      AND item_type = 'rental' AND status = 'pending_dispatch'::order_item_status
    ORDER BY sort_order ASC, created_at ASC
  `);
  const items = requestedIds ? pending.filter((p) => requestedIds.has(p.id)) : pending;
  if (!items.length) return c.json(err('nothing_to_dispatch', 'No pending rental items to dispatch on this order'), 409);
  const scopeIds = items.map((i) => i.id);

  // 1. Photos — per-type policy (photos_required_per_item_type) with a flat fallback.
  const perType = policy.photos_required_per_item_type ?? {};
  const usePerType = perType && Object.values(perType).some((n) => Number(n) > 0);
  const counts = await query<{ order_item_id: string; equipment: number; serial: number; total: number }>(sql`
    SELECT oi.id AS order_item_id,
           COUNT(dp.id) FILTER (WHERE dp.photo_type = 'equipment')::int AS equipment,
           COUNT(dp.id) FILTER (WHERE dp.photo_type = 'serial')::int AS serial,
           COUNT(dp.id)::int AS total
    FROM order_items oi
    LEFT JOIN dispatch_photos dp ON dp.order_item_id = oi.id AND dp.dispatch_id = ${d.id}::uuid
    WHERE oi.order_id = ${d.order_id}::uuid AND oi.workspace_id = ${workspaceId}::uuid
      AND oi.id::text = ANY(string_to_array(${scopeIds.join(',')}::text, ','))
    GROUP BY oi.id
  `);
  const byItem = new Map(counts.map((r) => [r.order_item_id, r]));
  for (const it of items) {
    const cnt = byItem.get(it.id) ?? { equipment: 0, serial: 0, total: 0 };
    if (usePerType) {
      const needEq = Number(perType.equipment ?? 0);
      const needSer = Number(perType.serial ?? 0);
      if (cnt.equipment < needEq) reasons.push({ code: 'photos_missing', message: `Item needs ${needEq} equipment photo(s) (has ${cnt.equipment})`, order_item_id: it.id });
      if (cnt.serial < needSer) reasons.push({ code: 'photos_missing', message: `Item needs ${needSer} serial photo(s) (has ${cnt.serial})`, order_item_id: it.id });
    } else if (policy.photos_required_per_item > 0 && cnt.total < policy.photos_required_per_item) {
      reasons.push({ code: 'photos_missing', message: `Item needs ${policy.photos_required_per_item} condition photos (has ${cnt.total})`, order_item_id: it.id });
    }
  }

  // 2. signature_required — satisfied by a captured signature OR a policy-valid skip.
  if (policy.signature_required) {
    const sig = await query<{ captured: number; skipped_ok: number }>(sql`
      SELECT COUNT(*) FILTER (WHERE skipped = false AND signature_url IS NOT NULL)::int AS captured,
             COUNT(*) FILTER (WHERE skipped = true AND (${policy.signature_skip_requires_reason}::boolean = false OR skip_reason IS NOT NULL))::int AS skipped_ok
      FROM dispatch_signatures WHERE dispatch_id = ${d.id}::uuid
    `);
    if ((sig[0]?.captured ?? 0) === 0 && (sig[0]?.skipped_ok ?? 0) === 0) {
      reasons.push({ code: 'signature_missing', message: 'A customer signature (or a skip with reason) is required' });
    }
  }

  // 3. otp_required — satisfied by a verified OTP OR a recorded skip.
  if (policy.otp_required) {
    const otp = await query<{ verified: number; skipped: number }>(sql`
      SELECT COUNT(*) FILTER (WHERE otp_verified = true)::int AS verified,
             COUNT(*) FILTER (WHERE otp_sent_via = 'skipped')::int AS skipped
      FROM dispatch_otp_verifications WHERE dispatch_id = ${d.id}::uuid
    `);
    if ((otp[0]?.verified ?? 0) === 0 && (otp[0]?.skipped ?? 0) === 0) {
      reasons.push({ code: 'otp_unverified', message: 'OTP must be verified or skipped with a reason' });
    }
  }

  if (reasons.length) {
    return c.json(err('dispatch_not_ready', 'Required handover steps are incomplete', reasons), 403);
  }

  // Recipient summary → order_items.handed_to (who physically received the gear).
  const handedTo = d.recipient_type === 'delegate'
    ? await query<{ n: string | null; ph: string | null }>(sql`SELECT delegate_name AS n, delegate_phone AS ph FROM dispatches WHERE id = ${d.id}::uuid`)
        .then((r) => (r[0]?.n ? `${r[0].n}${r[0].ph ? ' (' + r[0].ph + ')' : ''} · delegate` : 'delegate'))
    : await query<{ name: string | null }>(sql`SELECT p.display_name AS name FROM orders o LEFT JOIN people p ON p.id = o.customer_person_id WHERE o.id = ${d.order_id}::uuid`)
        .then((r) => r[0]?.name ?? 'customer');

  // Order status before the commit (for the event from/to + advance decision).
  const before = await query<{ status: string; pickup_location_id: string | null }>(sql`
    SELECT status::text AS status, pickup_location_id FROM orders
    WHERE id = ${d.order_id}::uuid AND workspace_id = ${workspaceId}::uuid LIMIT 1
  `);
  const fromStatus = before[0]?.status ?? 'confirmed';

  // Q7 atomic commit (Neon HTTP = idempotent statement sequence, every write guarded):
  //  (1) dispatch → completed  (2..3) items → dispatched + assets 'out' via the SHARED
  //  helper  (order → dispatched inside it). Then the completion event.
  await sql`
    UPDATE dispatches SET status = 'completed'::text, dispatch_completed_at = now(),
           completed_by_user_id = ${session.user.id}::uuid, updated_at = now()
    WHERE id = ${d.id}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  const commit = await commitDispatchToPhysicalState({
    workspaceId,
    orderId: d.order_id,
    fromStatus,
    items,
    handedTo,
    receivedByUserId: session.user.id,
    dispatchNotes: null,
    pickupLocationId: before[0]?.pickup_location_id ?? null,
  });

  // 6. Customer notification (Q6) — reuse emitCustomerNotification (whatsapp records
  //    intent, email actually sends via SMTP). bypassPolicy: a completed dispatch
  //    always notifies. notification_sent/reason is surfaced to the operator.
  const cust = await query<{ person_id: string | null; phone: string | null; email: string | null; order_number: number; name: string | null }>(sql`
    SELECT o.customer_person_id AS person_id, p.phone, p.email, o.order_number, p.display_name AS name
    FROM orders o LEFT JOIN people p ON p.id = o.customer_person_id
    WHERE o.id = ${d.order_id}::uuid AND o.workspace_id = ${workspaceId}::uuid LIMIT 1
  `);
  const rentEnd = await query<{ return_date: string | null }>(sql`
    SELECT to_char(rental_end, 'DD Mon YYYY') AS return_date FROM orders WHERE id = ${d.order_id}::uuid
  `);
  const channels = (policy.customer_notification_channels ?? ['whatsapp', 'email']).filter((ch): ch is 'whatsapp' | 'email' => ch === 'whatsapp' || ch === 'email');
  const notify = await emitCustomerNotification({
    workspaceId,
    orderId: d.order_id,
    personId: cust[0]?.person_id ?? null,
    eventType: 'order.dispatch.completed',
    message: `Your order #${cust[0]?.order_number ?? ''} has been dispatched (${d.dispatch_number}). ${items.length} item(s) on their way.`,
    channels,
    contact: { phone: cust[0]?.phone ?? null, email: cust[0]?.email ?? null },
    bypassPolicy: true,
    variables: {
      order_number: cust[0]?.order_number ?? '',
      dispatch_number: d.dispatch_number ?? '',
      dispatch_date: new Date().toISOString().slice(0, 10),
      item_count: items.length,
      return_date: rentEnd[0]?.return_date ?? '',
      customer_name: cust[0]?.name ?? '',
    },
  });
  const notificationSent = notify.deliveries.some((x) => x.status === 'sent');
  const notificationReason = notificationSent
    ? null
    : (notify.deliveries.find((x) => x.reason === 'no_active_adapter' || x.reason === 'noop_adapter')
        ? 'provider_not_configured'
        : (notify.deliveries[0]?.reason ?? 'not_sent'));

  await recordDispatchEvent({
    workspaceId, orderId: d.order_id, actorUserId: session.user.id,
    timelineType: 'order.dispatch.completed', auditType: 'dispatches.completed',
    payload: {
      dispatch_id: d.id, dispatch_number: d.dispatch_number, order_status: commit.newStatus,
      item_count: items.length, assigned_assets: commit.assignedAssets,
      notification_sent: notificationSent, notification_reason: notificationReason,
    },
    ip: ipAddress, ua: userAgent,
  });

  return c.json({
    status: 'completed',
    dispatch_id: d.id,
    dispatch_number: d.dispatch_number,
    order_status: commit.newStatus,
    item_count: items.length,
    assigned_assets: commit.assignedAssets,
    notification_sent: notificationSent,
    notification_reason: notificationReason,
    notification_channels: notify.deliveries.map((x) => ({ channel: x.channel, status: x.status, reason: x.reason })),
  }, 200);
});
