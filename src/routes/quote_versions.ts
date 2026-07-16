import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import { config } from '../lib/config.js';
import {
  type SessionUser, type SessionWorkspace,
} from '../middleware/session.js';
import { requirePermission } from '../lib/permissions.js';
import { orderBlock, reason as reasonB } from '../lib/blocked_action.js';
import { loadWorkspaceSettings, createApprovalRequest } from '../lib/approvals.js';
import { createQuoteVersionFromOrder, sendQuoteVersion, acceptQuoteVersion } from '../lib/quotes.js';

// ============================================================================
// src/routes/quote_versions.ts (Sub-slice 2.2) — /api/orders/:id/quote-versions
// ----------------------------------------------------------------------------
// These routes are FOLDED INTO the orders router (src/routes/orders.ts does
// `orders.route('/', quoteVersions)`), NOT mounted separately on the app.
//
// WHY (Bug A / PR #80): originally this router was a SECOND `app.route('/api/
// orders', quoteVersions)` alongside the orders router, and it carried its OWN
// `use('*', sessionMiddleware, requireAuth)` + `use('*', idempotencyMiddleware)`.
// Two routers at the same prefix means Hono runs BOTH `use('*')` chains for a
// path the first router doesn't own — so the idempotency middleware executed
// TWICE per quote-version request: pass 1 wrote the record `in_flight`, pass 2
// saw it and returned 409 "identical request already being processed", for every
// fresh key. Folding these routes under the orders router gives them the orders
// router's single session+idempotency pass. This module therefore adds NO global
// middleware of its own (the parent provides it).
// ============================================================================
type SessionVar = { sessionId: string; user: SessionUser; workspace: SessionWorkspace } | null;
type Env = { Variables: { session: SessionVar } };

export const quoteVersions = new Hono<Env>();
// NOTE: no `quoteVersions.use('*', …)` here — session + idempotency come from the
// orders router this is folded into. Adding them back reintroduces Bug A.

function clientCtx(c: Context) {
  const ipAddress = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null;
  return { ipAddress, userAgent: c.req.header('user-agent') ?? null };
}

async function orderExists(orderId: string, workspaceId: string): Promise<boolean> {
  const r = await query<{ id: string }>(sql`SELECT id FROM orders WHERE id = ${orderId}::uuid AND workspace_id = ${workspaceId}::uuid AND deleted_at IS NULL LIMIT 1`);
  return r.length > 0;
}

// GET list
quoteVersions.get('/:id/quote-versions', async (c) => {
  const session = c.get('session')!;
  const id = c.req.param('id');
  const rows = await query<any>(sql`
    SELECT id, version_number, quote_number, status, total_paise, deposit_paise, valid_until,
           sent_at, first_viewed_at, last_viewed_at, view_count, accepted_at, revision_reason_tag,
           tracking_link_url IS NOT NULL AS has_tracking_link, created_at
    FROM quote_versions WHERE order_id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    ORDER BY version_number ASC
  `);
  return c.json({ quote_versions: rows });
});

// GET detail (with content snapshot + diff)
quoteVersions.get('/:id/quote-versions/:vid', async (c) => {
  const session = c.get('session')!;
  const rows = await query<any>(sql`
    SELECT * FROM quote_versions WHERE id = ${c.req.param('vid')}::uuid AND order_id = ${c.req.param('id')}::uuid AND workspace_id = ${session.workspace.id}::uuid LIMIT 1
  `);
  if (!rows.length) return c.json({ error: 'not_found' }, 404);
  return c.json({ quote_version: rows[0] });
});

// POST create draft version
export const quoteCreateSchema = z.object({
  revision_reason_tag: z.string().max(50).optional(),
  revision_reason_notes: z.string().max(2000).optional(),
});
quoteVersions.post('/:id/quote-versions', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const id = c.req.param('id');
  if (!(await orderExists(id, session.workspace.id))) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = quoteCreateSchema.safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);

  // Revision reason required by policy once a prior version exists.
  const settings = await loadWorkspaceSettings(session.workspace.id);
  const priorCount = Number((await query<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM quote_versions WHERE order_id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid`))[0]?.n ?? 0);
  if (priorCount > 0 && settings?.quote_policy?.require_reason_tag_on_revision && !parsed.data.revision_reason_tag) {
    return c.json(orderBlock('QUOTE_BLOCKED', 'A revision reason is required', [reasonB('data_prerequisite', 'REVISION_REASON_REQUIRED', 'Select a reason tag for this revision.')]), 422);
  }
  const qv = await createQuoteVersionFromOrder({ workspaceId: session.workspace.id, orderId: id, actorUserId: session.user.id, revisionReasonTag: parsed.data.revision_reason_tag ?? null, revisionReasonNotes: parsed.data.revision_reason_notes ?? null });
  return c.json({ quote_version: qv }, 201);
});

// POST send the latest draft
quoteVersions.post('/:id/quote-versions/send', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const id = c.req.param('id');
  const draft = (await query<{ id: string }>(sql`SELECT id FROM quote_versions WHERE order_id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid AND status = 'draft' ORDER BY version_number DESC LIMIT 1`))[0];
  if (!draft) return c.json({ error: 'no_draft_to_send' }, 409);
  const r = await sendQuoteVersion({ workspaceId: session.workspace.id, orderId: id, versionId: draft.id, actorUserId: session.user.id, appOrigin: config.appOrigin });
  if (!r.ok) return c.json({ error: r.error }, 409);
  return c.json({ sent: true, version: r.version });
});

// POST send/resend a specific version
quoteVersions.post('/:id/quote-versions/:vid/send', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const id = c.req.param('id'); const vid = c.req.param('vid');
  const v = (await query<{ status: string; tracking_link_url: string | null }>(sql`SELECT status, tracking_link_url FROM quote_versions WHERE id = ${vid}::uuid AND order_id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid LIMIT 1`))[0];
  if (!v) return c.json({ error: 'not_found' }, 404);
  if (v.status === 'draft') {
    const r = await sendQuoteVersion({ workspaceId: session.workspace.id, orderId: id, versionId: vid, actorUserId: session.user.id, appOrigin: config.appOrigin });
    if (!r.ok) return c.json({ error: r.error }, 409);
    return c.json({ sent: true, version: r.version });
  }
  if ((v.status === 'sent' || v.status === 'viewed') && v.tracking_link_url) {
    // Resend: re-emit the notification without changing state (best-effort).
    await audit({ workspaceId: session.workspace.id, actorUserId: session.user.id, eventType: 'quotes.sent', targetType: 'quote_version', targetId: vid, payload: { order_id: id, resend: true }, ...clientCtx(c) });
    return c.json({ resent: true });
  }
  return c.json(orderBlock('QUOTE_BLOCKED', 'This version cannot be sent', [reasonB('lifecycle_state', 'NOT_SENDABLE', `Version is ${v.status}.`)]), 409);
});

// POST accept (staff_confirmed)
export const quoteAcceptSchema = z.object({ acceptance_notes: z.string().max(2000).optional(), acceptance_source: z.enum(['staff_confirmed', 'in_person_signature', 'email_reply', 'whatsapp']).default('staff_confirmed'), signature_url: z.string().max(500000).optional() });
quoteVersions.post('/:id/quote-versions/:vid/accept', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress } = clientCtx(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = quoteAcceptSchema.safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const r = await acceptQuoteVersion({ workspaceId: session.workspace.id, orderId: c.req.param('id'), versionId: c.req.param('vid'), actorUserId: session.user.id, source: parsed.data.acceptance_source, ip: ipAddress, notes: parsed.data.acceptance_notes ?? null, signatureUrl: parsed.data.signature_url ?? null });
  if (!r.ok) return c.json(orderBlock('QUOTE_BLOCKED', 'Cannot accept this quote', [reasonB('lifecycle_state', 'NOT_ACCEPTABLE', r.error ?? 'not acceptable')]), 409);
  return c.json({ accepted: true });
});

// POST withdraw
export const quoteWithdrawSchema = z.object({ reason: z.string().max(2000).optional() });
quoteVersions.post('/:id/quote-versions/:vid/withdraw', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id'); const vid = c.req.param('vid');
  const body = await c.req.json().catch(() => ({}));
  const parsed = quoteWithdrawSchema.safeParse(body ?? {});
  const v = (await query<{ status: string }>(sql`SELECT status FROM quote_versions WHERE id = ${vid}::uuid AND order_id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid LIMIT 1`))[0];
  if (!v) return c.json({ error: 'not_found' }, 404);

  // Withdrawing an ACCEPTED quote may require approval per policy.
  const settings = await loadWorkspaceSettings(session.workspace.id);
  if (v.status === 'accepted') {
    if (settings?.quote_policy?.allow_withdrawn_quote_after_acceptance === false) {
      return c.json(orderBlock('QUOTE_BLOCKED', 'Cannot withdraw an accepted quote', [reasonB('policy', 'WITHDRAW_AFTER_ACCEPT_DISALLOWED', 'Policy does not allow withdrawing after acceptance.')]), 409);
    }
    if (settings?.quote_policy?.withdrawn_after_acceptance_requires_approval) {
      const ap = await createApprovalRequest({ workspaceId: session.workspace.id, requesterUserId: session.user.id, requiredRole: 'manager', resourceType: 'quote_withdrawal', resourceId: vid, orderId: id, reasonTag: 'withdraw_after_accept', reasonNotes: parsed.data?.reason ?? null, requestSnapshot: { version_id: vid }, policySnapshot: { quote_policy: settings.quote_policy } });
      return c.json({ requires_approval: true, approval_request_id: ap.id });
    }
  }
  if (!['sent', 'viewed', 'accepted'].includes(v.status)) {
    return c.json(orderBlock('QUOTE_BLOCKED', 'Cannot withdraw this quote', [reasonB('lifecycle_state', 'NOT_WITHDRAWABLE', `Version is ${v.status}.`)]), 409);
  }
  await sql`UPDATE quote_versions SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by_user_id = ${session.user.id}::uuid, withdrawn_reason = ${parsed.data?.reason ?? null}::text, tracking_link_url = NULL, updated_at = now() WHERE id = ${vid}::uuid AND workspace_id = ${session.workspace.id}::uuid`;
  await audit({ workspaceId: session.workspace.id, actorUserId: session.user.id, eventType: 'quotes.withdrawn', targetType: 'quote_version', targetId: vid, payload: { order_id: id, reason: parsed.data?.reason ?? null }, ipAddress, userAgent });
  return c.json({ withdrawn: true });
});

// POST reject (staff records a customer rejection)
export const quoteRejectSchema = z.object({ reason: z.string().max(2000).optional() });
quoteVersions.post('/:id/quote-versions/:vid/reject', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id'); const vid = c.req.param('vid');
  const body = await c.req.json().catch(() => ({}));
  const parsed = quoteRejectSchema.safeParse(body ?? {});
  const v = (await query<{ status: string }>(sql`SELECT status FROM quote_versions WHERE id = ${vid}::uuid AND order_id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid LIMIT 1`))[0];
  if (!v) return c.json({ error: 'not_found' }, 404);
  if (!['sent', 'viewed'].includes(v.status)) return c.json(orderBlock('QUOTE_BLOCKED', 'Cannot reject this quote', [reasonB('lifecycle_state', 'NOT_REJECTABLE', `Version is ${v.status}.`)]), 409);
  await sql`UPDATE quote_versions SET status = 'rejected', rejected_at = now(), reject_reason = ${parsed.data?.reason ?? null}::text, tracking_link_url = NULL, updated_at = now() WHERE id = ${vid}::uuid AND workspace_id = ${session.workspace.id}::uuid`;
  await audit({ workspaceId: session.workspace.id, actorUserId: session.user.id, eventType: 'quotes.rejected', targetType: 'quote_version', targetId: vid, payload: { order_id: id, reason: parsed.data?.reason ?? null }, ipAddress, userAgent });
  return c.json({ rejected: true });
});
