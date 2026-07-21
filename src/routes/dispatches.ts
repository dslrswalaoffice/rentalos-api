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
import { put } from '@vercel/blob';
import { sql, query } from '../db.js';
import {
  sessionMiddleware, requireAuth,
  type SessionUser, type SessionWorkspace,
} from '../middleware/session.js';
import { requirePermission } from '../lib/permissions.js';
import { idempotencyMiddleware } from '../lib/idempotency.js';
import { audit, type AuditEventType } from '../lib/audit.js';

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

// Default policy — used when workspace.settings.dispatch_return_policy is absent
// (mirrors the migration 057 seed; config-first, never hardcoded downstream).
const DEFAULT_POLICY = {
  photos_required_per_item: 2,
  signature_required: true,
  signature_types_allowed: ['digital_draw', 'paper_photo'] as string[],
  otp_required: true,
  otp_fallback_when_no_provider: 'allow_skip_with_reason',
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
export const signatureSchema = z.object({
  signature_type: z.enum(SIGNATURE_TYPES),
  signature_base64: z.string().min(16),
  content_type: z.string().max(80).optional(),
});
export const completeSchema = z.object({}).passthrough();

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

  const order = await query<{ id: string; order_number: number }>(sql`
    SELECT id, order_number FROM orders
    WHERE id = ${orderId}::uuid AND workspace_id = ${workspaceId}::uuid LIMIT 1
  `);
  if (!order.length) return c.json(err('order_not_found', 'Order not found in this workspace'), 404);

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
  const policy = await loadPolicy(workspaceId);
  return c.json({ dispatch: rows[0], policy }, 200);
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

  // Look up the active adapter for the channel's category (whatsapp/sms → whatsapp bucket in v1).
  const active = await query<{ provider: string }>(sql`
    SELECT provider FROM workspace_integrations
    WHERE workspace_id = ${workspaceId}::uuid AND category = 'whatsapp'::text AND is_active = true
    LIMIT 1
  `);
  const policy = await loadPolicy(workspaceId);

  if (!active.length) {
    // No provider — do NOT record a send row. Frontend offers skip-with-reason if policy allows.
    return c.json({
      status: 'provider_not_configured',
      fallback_allowed: policy.otp_fallback_when_no_provider === 'allow_skip_with_reason',
    }, 200);
  }

  // Provider present. Session 1 records the send intent (operator-attestation model —
  // the real templated WATI send + code storage lands in Session 2). provider_ref is a
  // placeholder correlation id until the adapter call is wired.
  const providerRef = `pending-${d.id.slice(0, 8)}-${session.user.id.slice(0, 8)}`;
  const custPhone = await query<{ phone: string | null }>(sql`
    SELECT p.phone FROM orders o LEFT JOIN people p ON p.id = o.customer_person_id
    WHERE o.id = ${d.order_id}::uuid AND o.workspace_id = ${workspaceId}::uuid LIMIT 1
  `);
  const otp = await query<{ id: string }>(sql`
    INSERT INTO dispatch_otp_verifications
      (workspace_id, dispatch_id, otp_sent_to_phone, otp_sent_via, provider_ref)
    VALUES (${workspaceId}::uuid, ${d.id}::uuid, ${custPhone[0]?.phone ?? null}::text, ${channel}::text, ${providerRef}::text)
    RETURNING id
  `);

  await recordDispatchEvent({
    workspaceId, orderId: d.order_id, actorUserId: session.user.id,
    timelineType: 'order.dispatch.otp_sent', auditType: 'dispatches.otp_sent',
    payload: { dispatch_id: d.id, otp_id: otp[0]!.id, channel, provider: active[0]!.provider },
    ip: ipAddress, ua: userAgent,
  });

  return c.json({ status: 'sent', otp_id: otp[0]!.id, channel, provider: active[0]!.provider }, 201);
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

  // Latest un-skipped OTP row for this dispatch.
  const rows = await query<{ id: string }>(sql`
    SELECT id FROM dispatch_otp_verifications
    WHERE dispatch_id = ${d.id}::uuid AND workspace_id = ${workspaceId}::uuid
      AND otp_sent_via <> 'skipped'
    ORDER BY created_at DESC LIMIT 1
  `);
  if (!rows.length) return c.json(err('no_otp_to_verify', 'No OTP has been sent for this dispatch'), 409);

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

  const otp = await query<{ id: string }>(sql`
    INSERT INTO dispatch_otp_verifications
      (workspace_id, dispatch_id, otp_sent_via, skip_reason, skip_reason_notes)
    VALUES (${workspaceId}::uuid, ${d.id}::uuid, 'skipped'::text, ${parsed.data.skip_reason}::text, ${parsed.data.skip_reason_notes ?? null}::text)
    RETURNING id
  `);

  await recordDispatchEvent({
    workspaceId, orderId: d.order_id, actorUserId: session.user.id,
    timelineType: 'order.dispatch.otp_skipped', auditType: 'dispatches.otp_skipped',
    payload: { dispatch_id: d.id, otp_id: otp[0]!.id, skip_reason: parsed.data.skip_reason },
    ip: ipAddress, ua: userAgent,
  });

  return c.json({ status: 'skipped', otp_id: otp[0]!.id }, 201);
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
  if (!policy.signature_types_allowed.includes(p.signature_type)) {
    return c.json(err('signature_type_not_allowed', `Signature type ${p.signature_type} is not allowed by policy`), 403);
  }

  let sigUrl: string;
  try {
    sigUrl = await persistImage(workspaceId, d.id, 'signatures', p.signature_base64, p.content_type ?? 'image/png');
  } catch (e) {
    console.error('dispatch signature persist failed', e);
    return c.json(err('upload_failed', 'Could not store the signature'), 500);
  }

  const inserted = await query<{ id: string; captured_at: string }>(sql`
    INSERT INTO dispatch_signatures
      (workspace_id, dispatch_id, signature_type, signature_url, captured_by_user_id)
    VALUES (${workspaceId}::uuid, ${d.id}::uuid, ${p.signature_type}::text, ${sigUrl}::text, ${session.user.id}::uuid)
    RETURNING id, captured_at
  `);

  await recordDispatchEvent({
    workspaceId, orderId: d.order_id, actorUserId: session.user.id,
    timelineType: 'order.dispatch.signature', auditType: 'dispatches.signature_captured',
    payload: { dispatch_id: d.id, signature_id: inserted[0]!.id, signature_type: p.signature_type },
    ip: ipAddress, ua: userAgent,
  });

  return c.json({ signature: { id: inserted[0]!.id, signature_type: p.signature_type, captured_at: inserted[0]!.captured_at } }, 201);
});

// POST /:dispatchId/complete — verify required captures per policy, finalize, and
// transition the order to dispatched. Blocked-Action pattern (Item 12): a 403 with
// a structured reasons[] array when a required capture is missing.
dispatches.post('/:dispatchId/complete', requirePermission('dispatch.execute'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const d = await loadDispatch(workspaceId, c.req.param('dispatchId'));
  if (!d) return c.json(err('dispatch_not_found', 'Dispatch not found'), 404);
  if (d.status === 'completed') return c.json(err('already_completed', 'This dispatch is already completed'), 409);

  const policy = await loadPolicy(workspaceId);
  const reasons: { code: string; message: string; order_item_id?: string }[] = [];

  // 1. photos_required_per_item — each rental line needs >= N photos referencing it.
  if (policy.photos_required_per_item > 0) {
    const shortfall = await query<{ order_item_id: string; n: number }>(sql`
      SELECT oi.id AS order_item_id, COUNT(dp.id)::int AS n
      FROM order_items oi
      LEFT JOIN dispatch_photos dp
        ON dp.order_item_id = oi.id AND dp.dispatch_id = ${d.id}::uuid
      WHERE oi.order_id = ${d.order_id}::uuid AND oi.workspace_id = ${workspaceId}::uuid
        AND oi.item_type = 'rental'
      GROUP BY oi.id
      HAVING COUNT(dp.id) < ${policy.photos_required_per_item}::int
    `);
    for (const s of shortfall) {
      reasons.push({ code: 'photos_missing', message: `Item needs ${policy.photos_required_per_item} condition photos (has ${s.n})`, order_item_id: s.order_item_id });
    }
  }

  // 2. signature_required.
  if (policy.signature_required) {
    const sig = await query<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM dispatch_signatures WHERE dispatch_id = ${d.id}::uuid`);
    if ((sig[0]?.n ?? 0) === 0) reasons.push({ code: 'signature_missing', message: 'A customer signature is required before completing' });
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

  // Finalize + transition the order confirmed→dispatched (advisory; does not touch
  // order_assets/asset status — that stays the legacy 12b flow, see file header).
  await sql`
    UPDATE dispatches SET status = 'completed'::text, dispatch_completed_at = now(),
           completed_by_user_id = ${session.user.id}::uuid, updated_at = now()
    WHERE id = ${d.id}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  const ord = await query<{ status: string }>(sql`
    UPDATE orders SET status = CASE WHEN status = 'confirmed' THEN 'dispatched'::order_status ELSE status END,
           updated_at = now()
    WHERE id = ${d.order_id}::uuid AND workspace_id = ${workspaceId}::uuid
    RETURNING status::text AS status
  `);

  await recordDispatchEvent({
    workspaceId, orderId: d.order_id, actorUserId: session.user.id,
    timelineType: 'order.dispatch.completed', auditType: 'dispatches.completed',
    payload: { dispatch_id: d.id, dispatch_number: d.dispatch_number, order_status: ord[0]?.status ?? null },
    ip: ipAddress, ua: userAgent,
  });

  return c.json({ status: 'completed', dispatch_id: d.id, order_status: ord[0]?.status ?? null }, 200);
});
