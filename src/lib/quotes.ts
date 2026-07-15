// ============================================================================
// src/lib/quotes.ts (Sub-slice 2.2) — quote versioning, diff, tracking, send/accept
// ----------------------------------------------------------------------------
// A quote_version is an immutable content snapshot of an order at send time.
// Revising = a new draft version whose diff_from_parent is computed structurally.
// Sending a newer version supersedes the previously sent one (and invalidates its
// public tracking link, per policy). Acceptance confirms the order. Shared effects
// live here so routes + the public tracking endpoint + standby-convert reuse them.
// ============================================================================

import { randomBytes } from 'node:crypto';
import { sql, query } from '../db.js';
import { audit } from './audit.js';
import { emitNotification, emitCustomerNotification } from './notify.js';

const MS_PER_DAY = 86_400_000;

/**
 * True when an error is a UNIQUE-violation on quote_versions' (order_id,
 * version_number) index — i.e. a concurrent create raced us to the same version
 * number. Postgres SQLSTATE 23505; the Neon driver surfaces `.code`, and we also
 * match the message/constraint name defensively (driver versions vary).
 */
export function isVersionNumberConflict(e: unknown): boolean {
  const err = e as { code?: string; message?: string; constraint?: string } | null;
  if (!err) return false;
  if (err.code === '23505') return true;
  const hay = `${err.constraint ?? ''} ${err.message ?? ''}`.toLowerCase();
  return hay.includes('version_number') && (hay.includes('unique') || hay.includes('duplicate key'));
}

/** 48-hex-char cryptographically-random tracking token (unique index enforced). */
export function generateTrackingToken(): string {
  return randomBytes(24).toString('hex');
}

function inr(paise: number): string {
  return '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Number(paise) / 100));
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso);
  return isNaN(t.getTime()) ? '—' : t.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

type OrderSnapshotRow = {
  order_number: number; status: string; customer_person_id: string;
  rental_start: string | null; rental_end: string | null;
  subtotal_paise: number; tax_paise: number; discount_paise: number; total_paise: number; deposit_required_paise: number;
  customer_name: string | null; customer_phone: string | null; customer_email: string | null;
};

/** Build the immutable content snapshot for a quote from current order state. */
export async function buildOrderContentSnapshot(orderId: string, workspaceId: string): Promise<{
  snapshot: Record<string, any>; total_paise: number; deposit_paise: number;
  rental_start_at: string | null; rental_end_at: string | null;
  customer: { id: string; name: string | null; phone: string | null; email: string | null };
} | null> {
  const o = (await query<OrderSnapshotRow>(sql`
    SELECT o.order_number, o.status::text AS status, o.customer_person_id, o.rental_start, o.rental_end,
           o.subtotal_paise, o.tax_paise, o.discount_paise, o.total_paise, o.deposit_required_paise,
           p.display_name AS customer_name, p.phone AS customer_phone, p.email AS customer_email
    FROM orders o JOIN people p ON p.id = o.customer_person_id
    WHERE o.id = ${orderId}::uuid AND o.workspace_id = ${workspaceId}::uuid AND o.deleted_at IS NULL LIMIT 1
  `))[0];
  if (!o) return null;
  const items = await query<{ product_id: string | null; description: string; quantity: number; daily_rate_paise: number | null; total_amount_paise: number; item_type: string }>(sql`
    SELECT product_id, description, quantity, daily_rate_paise, total_amount_paise, item_type::text AS item_type
    FROM order_items WHERE order_id = ${orderId}::uuid AND workspace_id = ${workspaceId}::uuid
      AND item_type != 'tax' ORDER BY sort_order ASC, created_at ASC
  `);
  const snapshot = {
    order_number: o.order_number,
    customer: { name: o.customer_name, phone: o.customer_phone, email: o.customer_email },
    rental_start: o.rental_start, rental_end: o.rental_end,
    line_items: items.map((it) => ({
      product_id: it.product_id, description: it.description, quantity: Number(it.quantity),
      daily_rate_paise: Number(it.daily_rate_paise ?? 0), total_amount_paise: Number(it.total_amount_paise), item_type: it.item_type,
    })),
    subtotal_paise: Number(o.subtotal_paise), tax_paise: Number(o.tax_paise),
    discount_paise: Number(o.discount_paise), total_paise: Number(o.total_paise),
    deposit_required_paise: Number(o.deposit_required_paise),
  };
  return {
    snapshot, total_paise: Number(o.total_paise), deposit_paise: Number(o.deposit_required_paise),
    rental_start_at: o.rental_start, rental_end_at: o.rental_end,
    customer: { id: o.customer_person_id, name: o.customer_name, phone: o.customer_phone, email: o.customer_email },
  };
}

/** Structured diff between a parent snapshot and the current one (by product/line). */
export function computeDiff(parent: Record<string, any> | null, current: Record<string, any>): Record<string, any> {
  if (!parent) return { is_first_version: true, changes: [] };
  const key = (li: any) => `${li.product_id ?? li.description}`;
  const pItems: any[] = parent.line_items ?? [];
  const cItems: any[] = current.line_items ?? [];
  const pMap = new Map(pItems.map((li) => [key(li), li]));
  const cMap = new Map(cItems.map((li) => [key(li), li]));
  const added: any[] = [], removed: any[] = [], changed: any[] = [];
  for (const [k, li] of cMap) if (!pMap.has(k)) added.push({ description: li.description, quantity: li.quantity, total_amount_paise: li.total_amount_paise });
  for (const [k, li] of pMap) if (!cMap.has(k)) removed.push({ description: li.description, quantity: li.quantity, total_amount_paise: li.total_amount_paise });
  for (const [k, cli] of cMap) {
    const pli = pMap.get(k);
    if (pli && (pli.quantity !== cli.quantity || pli.total_amount_paise !== cli.total_amount_paise || pli.daily_rate_paise !== cli.daily_rate_paise)) {
      changed.push({ description: cli.description, from: { quantity: pli.quantity, total_amount_paise: pli.total_amount_paise }, to: { quantity: cli.quantity, total_amount_paise: cli.total_amount_paise } });
    }
  }
  const dateChanged = parent.rental_start !== current.rental_start || parent.rental_end !== current.rental_end;
  return {
    is_first_version: false,
    added_items: added, removed_items: removed, changed_items: changed,
    total_change_paise: Number(current.total_paise ?? 0) - Number(parent.total_paise ?? 0),
    date_changed: dateChanged,
    date_from: dateChanged ? { start: parent.rental_start, end: parent.rental_end } : null,
    date_to: dateChanged ? { start: current.rental_start, end: current.rental_end } : null,
  };
}

/** Compute valid_until: max of segment-based days and any exceeded value threshold. */
export function computeValidUntil(settings: Record<string, any>, segment: string, totalPaise: number, fromMs: number): Date {
  const qp = settings?.quote_policy ?? {};
  let days = Number(qp.validity_by_customer_segment?.[segment] ?? qp.default_validity_days ?? 7);
  const byValue = qp.validity_by_value_paise ?? {};
  for (const [k, v] of Object.entries(byValue)) {
    const m = String(k).match(/(\d+)/);
    const threshold = m ? Number(m[1]) : Infinity;
    if (totalPaise >= threshold) days = Math.max(days, Number(v));
  }
  return new Date(fromMs + days * MS_PER_DAY);
}

async function customerSegment(workspaceId: string, customerId: string): Promise<string> {
  const r = (await query<{ tier: string | null; completed: number }>(sql`
    SELECT p.tier, (SELECT COUNT(*)::int FROM orders o WHERE o.workspace_id=p.workspace_id AND o.customer_person_id=p.id AND o.status::text IN ('confirmed','dispatched','active','returned','closed')) AS completed
    FROM people p WHERE p.id = ${customerId}::uuid AND p.workspace_id = ${workspaceId}::uuid LIMIT 1
  `))[0];
  if (!r) return 'new_customer';
  if (r.tier === 'vip') return 'vip';
  return Number(r.completed) > 0 ? 'repeat' : 'new_customer';
}

/** Create a new DRAFT quote version from current order state (revision-aware). */
export async function createQuoteVersionFromOrder(args: {
  workspaceId: string; orderId: string; actorUserId: string;
  revisionReasonTag?: string | null; revisionReasonNotes?: string | null;
}): Promise<{ id: string; version_number: number; quote_number: string }> {
  const built = await buildOrderContentSnapshot(args.orderId, args.workspaceId);
  if (!built) throw new Error('order_not_found');
  const settings = (await query<{ settings: Record<string, any> | null }>(sql`SELECT settings FROM workspaces WHERE id = ${args.workspaceId}::uuid LIMIT 1`))[0]?.settings ?? {};
  const orderNumber = built.snapshot.order_number;
  const fmt = String(settings?.quote_policy?.quote_document_number_format ?? 'QT-{year}-{sequence}-v{version}');
  const policySnapshot = { quote_policy: settings?.quote_policy ?? {} };

  // Version numbering is "prev max + 1", which races: two concurrent creates
  // both read the same max and both try the same version_number, and the loser
  // hits the UNIQUE (order_id, version_number) index (SQLSTATE 23505). Rather
  // than surface that as a 500 (which orphans the caller's idempotency record
  // and shows a misleading "identical request" error on the next same-key
  // retry), recompute and retry a few times so a genuine double-submit produces
  // v1 + v2 cleanly. Each attempt re-reads the latest version so the numbering
  // stays gap-free.
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; ; attempt++) {
    const prev = (await query<{ id: string; version_number: number; content_snapshot: Record<string, any> }>(sql`
      SELECT id, version_number, content_snapshot FROM quote_versions
      WHERE order_id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid
      ORDER BY version_number DESC LIMIT 1
    `))[0];
    const versionNumber = (prev?.version_number ?? 0) + 1;
    const quoteNumber = fmt
      .replaceAll('{year}', String(new Date().getUTCFullYear()))
      .replaceAll('{sequence}', String(orderNumber).padStart(4, '0'))
      .replaceAll('{version}', String(versionNumber));
    const diff = computeDiff(prev?.content_snapshot ?? null, built.snapshot);
    try {
      const row = (await query<{ id: string }>(sql`
        INSERT INTO quote_versions (workspace_id, order_id, version_number, quote_number, content_snapshot,
          total_paise, deposit_paise, rental_start_at, rental_end_at, status, created_by_user_id,
          parent_version_id, diff_from_parent, revision_reason_tag, revision_reason_notes, policy_applied_snapshot)
        VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, ${versionNumber}::int, ${quoteNumber}::text, ${JSON.stringify(built.snapshot)}::jsonb,
          ${built.total_paise}::bigint, ${built.deposit_paise}::bigint, ${built.rental_start_at}::timestamptz, ${built.rental_end_at}::timestamptz,
          'draft', ${args.actorUserId}::uuid, ${prev?.id ?? null}::uuid, ${JSON.stringify(diff)}::jsonb,
          ${args.revisionReasonTag ?? null}::text, ${args.revisionReasonNotes ?? null}::text, ${JSON.stringify(policySnapshot)}::jsonb)
        RETURNING id
      `))[0]!;
      await audit({ workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'quotes.created', targetType: 'quote_version', targetId: row.id, payload: { order_id: args.orderId, version_number: versionNumber, quote_number: quoteNumber }, ipAddress: null, userAgent: null });
      return { id: row.id, version_number: versionNumber, quote_number: quoteNumber };
    } catch (e) {
      if (isVersionNumberConflict(e) && attempt < MAX_ATTEMPTS) continue; // a concurrent create won this number — recompute + retry
      throw e;
    }
  }
}

/** Freeze + send a draft version: token, valid_until, supersede prior sent, notify. */
export async function sendQuoteVersion(args: {
  workspaceId: string; orderId: string; versionId: string; actorUserId: string; appOrigin: string;
}): Promise<{ ok: boolean; error?: string; version?: any }> {
  const v = (await query<{ id: string; status: string; version_number: number; quote_number: string }>(sql`
    SELECT id, status, version_number, quote_number FROM quote_versions WHERE id = ${args.versionId}::uuid AND order_id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid LIMIT 1
  `))[0];
  if (!v) return { ok: false, error: 'not_found' };
  if (v.status !== 'draft') return { ok: false, error: 'not_draft' };

  const built = await buildOrderContentSnapshot(args.orderId, args.workspaceId);
  if (!built) return { ok: false, error: 'order_not_found' };
  const settings = (await query<{ settings: Record<string, any> | null }>(sql`SELECT settings FROM workspaces WHERE id = ${args.workspaceId}::uuid LIMIT 1`))[0]?.settings ?? {};
  const segment = await customerSegment(args.workspaceId, built.customer.id);
  const nowMs = Date.now();
  const validUntil = computeValidUntil(settings, segment, built.total_paise, nowMs).toISOString();
  const token = generateTrackingToken();

  // Supersede prior sent/viewed versions + invalidate their tracking links.
  const invalidate = settings?.quote_policy?.invalidate_superseded_tracking_links !== false;
  await sql`
    UPDATE quote_versions SET status = 'superseded', superseded_at = now(), superseded_by_version_id = ${v.id}::uuid,
      tracking_link_url = CASE WHEN ${invalidate}::boolean THEN NULL ELSE tracking_link_url END, updated_at = now()
    WHERE order_id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid
      AND status IN ('sent','viewed') AND id != ${v.id}::uuid
  `;
  await sql`
    UPDATE quote_versions SET status = 'sent', sent_at = now(), sent_by_user_id = ${args.actorUserId}::uuid,
      content_snapshot = ${JSON.stringify(built.snapshot)}::jsonb, total_paise = ${built.total_paise}::bigint,
      valid_until = ${validUntil}::timestamptz, tracking_link_url = ${token}::text,
      document_url = ${`/quote-view.html?token=${token}`}::text, updated_at = now()
    WHERE id = ${v.id}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;
  await sql`UPDATE orders SET active_quote_version_id = ${v.id}::uuid, updated_at = now() WHERE id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid`;
  await sql`
    INSERT INTO order_events (workspace_id, order_id, event_type, payload, actor_user_id)
    VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, 'order.quote.sent', ${JSON.stringify({ version_id: v.id, version_number: v.version_number, quote_number: v.quote_number, valid_until: validUntil })}::jsonb, ${args.actorUserId}::uuid)
  `;
  await audit({ workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'quotes.sent', targetType: 'quote_version', targetId: v.id, payload: { order_id: args.orderId, quote_number: v.quote_number, valid_until: validUntil }, ipAddress: null, userAgent: null });

  const trackingUrl = `${args.appOrigin}/quote-view.html?token=${token}`;
  emitCustomerNotification({
    workspaceId: args.workspaceId, orderId: args.orderId, personId: built.customer.id, eventType: 'quote_sent',
    message: `Your quote ${v.quote_number} for ${inr(built.total_paise)} is ready. View and accept it here: ${trackingUrl}`,
    channels: ['whatsapp', 'email'], contact: { phone: built.customer.phone, email: built.customer.email }, settings,
    variables: {
      customer_name: built.customer.name ?? 'there', quote_number: v.quote_number, total_amount: inr(built.total_paise),
      rental_start: fmtDate(built.rental_start_at), rental_end: fmtDate(built.rental_end_at),
      valid_until: fmtDate(validUntil), tracking_url: trackingUrl,
      // workspace_name is resolved by emitCustomerNotification from the workspace
      // row; do NOT pass an empty string here or it clobbers the real name.
    },
  }).catch(() => {});
  return { ok: true, version: { id: v.id, status: 'sent', valid_until: validUntil, tracking_token: token } };
}

/** Accept a version: order → confirmed, supersede others, notify. Shared by staff
 *  accept + public portal accept. `actorUserId` null for a customer portal accept. */
export async function acceptQuoteVersion(args: {
  workspaceId: string; orderId: string; versionId: string; actorUserId: string | null;
  source: string; ip?: string | null; signatureUrl?: string | null; notes?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const v = (await query<{ id: string; status: string; version_number: number; quote_number: string }>(sql`
    SELECT id, status, version_number, quote_number FROM quote_versions WHERE id = ${args.versionId}::uuid AND order_id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid LIMIT 1
  `))[0];
  if (!v) return { ok: false, error: 'not_found' };
  if (v.status !== 'sent' && v.status !== 'viewed') return { ok: false, error: 'not_acceptable' };

  await sql`
    UPDATE quote_versions SET status = 'accepted', accepted_at = now(), acceptance_source = ${args.source}::text,
      acceptance_ip_address = ${args.ip ?? null}::text, acceptance_signature_url = ${args.signatureUrl ?? null}::text,
      acceptance_notes = ${args.notes ?? null}::text, updated_at = now()
    WHERE id = ${v.id}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;
  // Supersede any other sent/viewed versions.
  await sql`
    UPDATE quote_versions SET status = 'superseded', superseded_at = now(), superseded_by_version_id = ${v.id}::uuid, tracking_link_url = NULL, updated_at = now()
    WHERE order_id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid AND status IN ('sent','viewed') AND id != ${v.id}::uuid
  `;
  await sql`
    UPDATE orders SET accepted_quote_version_id = ${v.id}::uuid, status = 'confirmed'::order_status, updated_at = now()
    WHERE id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;
  // Release any soft holds now that it's a committed booking.
  await sql`UPDATE order_items SET is_soft_reserved = false, soft_reserved_standby_id = NULL WHERE order_id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid AND is_soft_reserved = true`;

  const order = (await query<{ order_number: number; customer_person_id: string; total_paise: number; customer_name: string | null; customer_phone: string | null; customer_email: string | null }>(sql`
    SELECT o.order_number, o.customer_person_id, o.total_paise, p.display_name AS customer_name, p.phone AS customer_phone, p.email AS customer_email
    FROM orders o JOIN people p ON p.id = o.customer_person_id WHERE o.id = ${args.orderId}::uuid AND o.workspace_id = ${args.workspaceId}::uuid LIMIT 1
  `))[0];
  await sql`
    INSERT INTO order_events (workspace_id, order_id, event_type, to_status, payload, actor_user_id)
    VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, 'order.quote.accepted', 'confirmed'::order_status, ${JSON.stringify({ version_id: v.id, quote_number: v.quote_number, source: args.source })}::jsonb, ${args.actorUserId}::uuid)
  `;
  await audit({ workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'quotes.accepted', targetType: 'quote_version', targetId: v.id, payload: { order_id: args.orderId, source: args.source, quote_number: v.quote_number }, ipAddress: args.ip ?? null, userAgent: null });

  // Internal sales notification (in-product; no customer-worded email to members).
  emitNotification({
    workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'quote_accepted_internal',
    targetType: 'order', targetId: args.orderId, linkUrl: `/order-360.html?id=${args.orderId}`,
    metadata: { order_number: order?.order_number ?? '', quote_number: v.quote_number, customer_name: order?.customer_name ?? '', total_amount: inr(Number(order?.total_paise ?? 0)) },
  }).catch(() => {});
  // Customer confirmation.
  if (order) {
    emitCustomerNotification({
      workspaceId: args.workspaceId, orderId: args.orderId, personId: order.customer_person_id, eventType: 'quote_accepted',
      message: `Thank you — quote ${v.quote_number} has been accepted and your order #${order.order_number} is confirmed.`,
      channels: ['whatsapp', 'email'], contact: { phone: order.customer_phone, email: order.customer_email },
      variables: { customer_name: order.customer_name ?? 'there', quote_number: v.quote_number, order_number: order.order_number, total_amount: inr(Number(order.total_paise)) /* workspace_name resolved in emitCustomerNotification */ },
    }).catch(() => {});
  }
  return { ok: true };
}
