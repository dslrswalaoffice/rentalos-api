import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import { recomputeOrderTotals, resolveGstState } from '../lib/pricing.js';
import { loadKitComponents } from '../lib/availability.js';
import { emitNotification } from '../lib/notify.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';
import { requirePermission } from '../lib/permissions.js';

// ============================================================================
// src/routes/invoices.ts  (Sub-turn 2.4a-endpoints)
// ----------------------------------------------------------------------------
// Immutable, snapshot-based invoicing. Mounted at /api/order-invoices (a sibling
// of orders/payments — keeps route composition flat and predictable).
//
//   GET   /:orderId                            list invoices for an order
//   POST  /:orderId?sequence=1                 generate a new invoice (revision-aware)
//   GET   /:orderId/:invoiceId                 one invoice incl. full snapshot
//   POST  /:orderId/:invoiceId/transitions     advisory invoice status change
//
// Invoices are permanent records: no PATCH, no DELETE. A regenerate creates the
// next revision and marks a live (draft/sent) predecessor as 'revised'. Order
// status is never touched here — invoice state is independent of order lifecycle.
//
// CONCURRENCY: the Neon HTTP driver has no cross-statement transactions, so the
// recompute → snapshot → insert sequence isn't atomic. Worst case is a snapshot
// off by a concurrent edit; regenerate to correct. No locking by design.
// ============================================================================

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = { Variables: { session: SessionVar } };

export const invoices = new Hono<Env>();
invoices.use('*', sessionMiddleware, requireAuth);

// Terminal item statuses — mirrors deriveCanFinalize in src/routes/orders.ts.
const TERMINAL_ITEM_STATUSES = new Set([
  'returned', 'returned_with_damage', 'not_returned_chargeable',
  'not_returned_non_chargeable', 'missing',
]);

// Invoice status machine (advisory, mirrors order transitions). 'revised' is
// system-only (assigned on regenerate), never a manual target.
const CANONICAL_INVOICE_TRANSITIONS: Record<string, string[]> = {
  draft:     ['sent', 'cancelled'],
  sent:      ['paid', 'cancelled'],
  paid:      ['cancelled'],
  revised:   [],
  cancelled: [],
};

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------
type OrderFull = {
  id: string;
  workspace_id: string;
  order_number: number;
  customer_person_id: string;
  status: string;
  rental_start: string | null;
  rental_end: string | null;
  channel: string;
  gst_state: string | null;
  notes: string | null;
  subtotal_paise: number;
  discount_paise: number;
  tax_paise: number;
  total_paise: number;
  paid_paise: number;
  balance_paise: number;
  deleted_at: string | null;
};

type ItemRow = {
  id: string; item_type: string; description: string;
  product_id: string | null; product_name: string | null; product_sku: string | null;
  hsn_code: string | null; is_kit: boolean | null;
  quantity: number; daily_rate_paise: number | null; billable_days: number | null;
  unit_amount_paise: number; total_amount_paise: number; chargeable_paise: number;
  cgst_paise: number; sgst_paise: number; igst_paise: number;
  status: string; manual_price: boolean; sort_order: number;
};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

async function loadOrderFull(orderId: string, workspaceId: string): Promise<OrderFull | null> {
  const rows = await query<OrderFull>(sql`
    SELECT id, workspace_id, order_number, customer_person_id, status::text AS status,
           rental_start, rental_end, channel, gst_state, notes,
           subtotal_paise, discount_paise, tax_paise, total_paise, paid_paise, balance_paise,
           deleted_at
    FROM orders
    WHERE id = ${orderId}::uuid AND workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `);
  const o = rows[0];
  if (!o || o.deleted_at) return null;
  return o;
}

async function loadItems(orderId: string, workspaceId: string): Promise<ItemRow[]> {
  return await query<ItemRow>(sql`
    SELECT oi.id, oi.item_type::text AS item_type, oi.description,
           oi.product_id, pr.name AS product_name, pr.sku AS product_sku,
           pr.hsn_code AS hsn_code, pr.is_kit AS is_kit,
           oi.quantity, oi.daily_rate_paise, oi.billable_days,
           oi.unit_amount_paise, oi.total_amount_paise, oi.chargeable_paise,
           oi.cgst_paise, oi.sgst_paise, oi.igst_paise,
           oi.status::text AS status, oi.manual_price, oi.sort_order
    FROM order_items oi
    LEFT JOIN products pr ON pr.id = oi.product_id
    WHERE oi.order_id = ${orderId}::uuid AND oi.workspace_id = ${workspaceId}::uuid
    ORDER BY oi.sort_order ASC, oi.created_at ASC
  `);
}

function deriveCanFinalize(items: ItemRow[]): boolean {
  if (items.length === 0) return false;
  return items.every((i) => TERMINAL_ITEM_STATUSES.has(i.status));
}

function orderLite(o: OrderFull) {
  return {
    id: o.id,
    order_number: o.order_number,
    status: o.status,
    total_paise: Number(o.total_paise),
    paid_paise: Number(o.paid_paise),
    balance_paise: Number(o.balance_paise),
  };
}

// Today in Asia/Kolkata as Y/M/D parts (invoice date, workspace timezone).
function kolkataYMD(): { y: string; m: string; d: string; iso: string } {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // 'YYYY-MM-DD'
  const [y, m, d] = s.split('-');
  return { y: y!, m: m!, d: d!, iso: s };
}

function buildInvoiceNumber(
  format: string,
  ymd: { y: string; m: string; d: string },
  orderNumber: number,
  sequence: number,
  revision: number,
): string {
  return format
    .replaceAll('YYYY', ymd.y)
    .replaceAll('MM', ymd.m)
    .replaceAll('DD', ymd.d)
    .replaceAll('{order}', String(orderNumber))
    .replaceAll('{seq}', String(sequence))
    .replaceAll('{rev}', String(revision));
}

// ============================================================================
// GET /:orderId — list invoices for an order
// ============================================================================
invoices.get('/:orderId', async (c) => {
  const session = c.get('session')!;
  const orderId = c.req.param('orderId');

  const order = await loadOrderFull(orderId, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);

  const rows = await query(sql`
    SELECT id, invoice_number, sequence, revision, status::text AS status,
           issued_at, sent_at, due_at, paid_at,
           total_paise, cgst_paise, sgst_paise, igst_paise, gst_state,
           pdf_url, notes
    FROM invoices
    WHERE order_id = ${orderId}::uuid AND workspace_id = ${session.workspace.id}::uuid
    ORDER BY issued_at DESC, created_at DESC
  `);

  return c.json({ order: orderLite(order), invoices: rows });
});

// ============================================================================
// POST /:orderId — generate a new invoice
// ============================================================================
const generateSchema = z.object({
  notes: z.string().max(500).optional(),
});

// Extracted so the rental-extension flow (POST /api/orders/:id/extend) can
// generate an invoice revision through the EXACT same snapshot / GST / kit path
// the route uses — no duplicated builder. Returns a structured result (not an
// HTTP response) so each caller maps it. `bypassReadiness` lets an extension
// re-invoice a still-running order (Booqable invoices running orders freely at
// any lifecycle point); the HTTP route keeps the readiness gate.
export type GenerateInvoiceResult =
  | {
      ok: true;
      invoice: Record<string, unknown>;
      order: ReturnType<typeof orderLite>;
      superseded: { id: string; invoice_number: string } | null;
      revision: number;
      invoice_number: string;
    }
  | { ok: false; error: string; status: 400 | 404 | 409; reason?: string };

export async function generateInvoice(params: {
  workspaceId: string;
  userId: string;
  orderId: string;
  sequence: number;
  notes: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  bypassReadiness?: boolean;
}): Promise<GenerateInvoiceResult> {
  // Shim so the (byte-identical) body below keeps referencing session.*.
  const session = { workspace: { id: params.workspaceId }, user: { id: params.userId } };
  const { ipAddress, userAgent, orderId, sequence, notes } = params;

  let order = await loadOrderFull(orderId, session.workspace.id);
  if (!order) return { ok: false, error: 'not_found', status: 404 };

  if (order.status === 'cancelled') {
    return { ok: false, error: 'cancelled_order_cannot_invoice', status: 409 };
  }

  // Readiness gate: closed orders always allowed; otherwise every item must be
  // in a terminal state (can_finalize) — computed server-side from ground truth.
  // The extension flow passes bypassReadiness so a running order can be re-invoiced.
  let items = await loadItems(orderId, session.workspace.id);
  if (!params.bypassReadiness && order.status !== 'closed' && !deriveCanFinalize(items)) {
    return { ok: false, error: 'order_not_ready_for_invoice', status: 409, reason: 'items_still_active' };
  }

  // Recompute so chargeable + GST split are fresh (skip for locked orders, which
  // recompute rejects — their totals are already frozen).
  if (order.status !== 'closed' && order.status !== 'cancelled') {
    await recomputeOrderTotals(orderId, session.workspace.id, session.user.id);
    order = (await loadOrderFull(orderId, session.workspace.id))!;
    items = await loadItems(orderId, session.workspace.id);
  }

  // Workspace + customer for the snapshot and number format.
  const wsRows = await query<Record<string, unknown>>(sql`
    SELECT id, legal_name, gstin, pan, place_of_supply, business_address,
           business_email, business_phone, settings
    FROM workspaces WHERE id = ${session.workspace.id}::uuid LIMIT 1
  `);
  const ws = wsRows[0]!;
  const wsSettings = (ws.settings ?? {}) as Record<string, any>;
  const numberFormat: string =
    wsSettings?.invoice?.number_format || 'YYYY-MM-DD-{order}-{seq}-R{rev}';
  const taxPct: number = Number(wsSettings?.tax?.default_gst_percent ?? 18);

  const personRows = await query<Record<string, unknown>>(sql`
    SELECT id, display_name, phone, email, gstin, default_gst_state,
           address_line, city, state, postal_code
    FROM people WHERE id = ${order.customer_person_id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    LIMIT 1
  `);
  const person = personRows[0] ?? null;

  const paymentRows = await query<Record<string, unknown>>(sql`
    SELECT id, amount_paise, direction::text AS direction, method::text AS method,
           reference, occurred_at
    FROM payments
    WHERE order_id = ${orderId}::uuid AND workspace_id = ${session.workspace.id}::uuid
      AND status = 'completed'
    ORDER BY occurred_at ASC
  `);

  // Revision handling — supersede a live predecessor for this sequence.
  const latestRows = await query<{ id: string; invoice_number: string; revision: number; status: string }>(sql`
    SELECT id, invoice_number, revision, status::text AS status
    FROM invoices
    WHERE order_id = ${orderId}::uuid AND workspace_id = ${session.workspace.id}::uuid
      AND sequence = ${sequence}::int
    ORDER BY revision DESC
    LIMIT 1
  `);
  let revision = 1;
  let superseded: { id: string; invoice_number: string } | null = null;
  if (latestRows.length) {
    const latest = latestRows[0]!;
    revision = Number(latest.revision) + 1;
    // Only a live (draft/sent) predecessor gets revised; paid/cancelled/revised
    // rows stay as permanent records and are left untouched.
    if (latest.status === 'draft' || latest.status === 'sent') {
      await sql`
        UPDATE invoices SET status = 'revised'::invoice_status
        WHERE id = ${latest.id}::uuid AND workspace_id = ${session.workspace.id}::uuid
      `;
      superseded = { id: latest.id, invoice_number: latest.invoice_number };
    }
  }

  // Frozen totals + GST state at generation time.
  const cgst = items.reduce((s, i) => s + Number(i.cgst_paise), 0);
  const sgst = items.reduce((s, i) => s + Number(i.sgst_paise), 0);
  const igst = items.reduce((s, i) => s + Number(i.igst_paise), 0);
  const resolvedState = resolveGstState({
    orderState: order.gst_state,
    personDefaultState: (person?.default_gst_state as string | null) ?? null,
    workspacePlaceOfSupply: (ws.place_of_supply as string | null) ?? null,
  });
  const isIntraState = resolvedState !== null && resolvedState === (ws.place_of_supply ?? null);

  const ymd = kolkataYMD();
  const invoiceNumber = buildInvoiceNumber(numberFormat, ymd, order.order_number, sequence, revision);
  const generatedAt = new Date().toISOString();

  // Pre-load kit components for any kit line items — the snapshot is built
  // synchronously below, so gather the async data first. Frozen into the
  // snapshot for audit; the customer still sees one line.
  const kitComponentMap = new Map<string, { product_name: string; product_sku: string; per_kit_qty: number }[]>();
  for (const it of items) {
    if (it.is_kit && it.product_id) {
      const comps = await loadKitComponents(session.workspace.id, it.product_id);
      kitComponentMap.set(it.id, comps.map((cmp) => ({
        product_name: cmp.component_name,
        product_sku: cmp.component_sku,
        per_kit_qty: Number(cmp.quantity),
      })));
    }
  }

  const snapshot = {
    workspace: {
      id: ws.id,
      legal_name: ws.legal_name,
      gstin: ws.gstin,
      pan: ws.pan,
      place_of_supply: ws.place_of_supply,
      business_address: ws.business_address,
      phone: ws.business_phone,
      email: ws.business_email,
    },
    customer: person
      ? {
          id: person.id,
          display_name: person.display_name,
          phone: person.phone,
          email: person.email,
          gstin: person.gstin,
          default_gst_state: person.default_gst_state,
          billing_address: [person.address_line, person.city, person.state, person.postal_code]
            .filter(Boolean)
            .join(', ') || null,
        }
      : null,
    order: {
      id: order.id,
      order_number: order.order_number,
      rental_start: order.rental_start,
      rental_end: order.rental_end,
      channel: order.channel,
      gst_state: order.gst_state,
      notes: order.notes,
    },
    line_items: items.map((i) => ({
      id: i.id,
      item_type: i.item_type,
      description: i.description,
      product_name: i.product_name,
      product_sku: i.product_sku,
      hsn_code: i.hsn_code ?? null,
      is_kit: i.is_kit ?? false,
      kit_components: i.is_kit
        ? (kitComponentMap.get(i.id) ?? []).map((cmp) => ({
            product_name: cmp.product_name,
            product_sku: cmp.product_sku,
            quantity: cmp.per_kit_qty * Number(i.quantity),
          }))
        : null,
      quantity: Number(i.quantity),
      daily_rate_paise: String(i.daily_rate_paise ?? ''),
      billable_days: i.billable_days,
      unit_amount_paise: String(i.unit_amount_paise),
      total_amount_paise: String(i.total_amount_paise),
      chargeable_paise: String(i.chargeable_paise),
      cgst_paise: String(i.cgst_paise),
      sgst_paise: String(i.sgst_paise),
      igst_paise: String(i.igst_paise),
      status: i.status,
      manual_price: i.manual_price,
      sort_order: i.sort_order,
    })),
    payments: paymentRows.map((p) => ({
      id: p.id,
      amount_paise: String(p.amount_paise),
      direction: p.direction,
      method: p.method,
      reference: p.reference,
      occurred_at: p.occurred_at,
    })),
    totals: {
      subtotal_paise: String(order.subtotal_paise),
      discount_paise: String(order.discount_paise),
      tax_paise: String(order.tax_paise),
      cgst_paise: String(cgst),
      sgst_paise: String(sgst),
      igst_paise: String(igst),
      total_paise: String(order.total_paise),
      paid_paise: String(order.paid_paise),
      balance_paise: String(order.balance_paise),
    },
    gst: {
      workspace_state: ws.place_of_supply ?? null,
      customer_state: resolvedState,
      is_intra_state: isIntraState,
      tax_pct: taxPct,
    },
    generated_at: generatedAt,
    generated_by_user_id: session.user.id,
  };

  const inserted = await query<Record<string, unknown>>(sql`
    INSERT INTO invoices (
      workspace_id, order_id, customer_id, invoice_number, sequence, revision,
      status, issued_at, place_of_supply,
      subtotal_paise, discount_paise, tax_paise, total_paise, paid_paise, balance_paise,
      cgst_paise, sgst_paise, igst_paise, gst_state,
      snapshot, notes, supersedes_invoice_id, created_by
    ) VALUES (
      ${session.workspace.id}::uuid,
      ${orderId}::uuid,
      ${order.customer_person_id}::uuid,
      ${invoiceNumber}::text,
      ${sequence}::int,
      ${revision}::int,
      'draft'::invoice_status,
      ${ymd.iso}::date,
      ${(ws.place_of_supply as string | null) ?? null}::text,
      ${order.subtotal_paise}::bigint,
      ${order.discount_paise}::bigint,
      ${order.tax_paise}::bigint,
      ${order.total_paise}::bigint,
      ${order.paid_paise}::bigint,
      ${order.balance_paise}::bigint,
      ${cgst}::bigint,
      ${sgst}::bigint,
      ${igst}::bigint,
      ${resolvedState}::text,
      ${JSON.stringify(snapshot)}::jsonb,
      ${notes}::text,
      ${superseded?.id ?? null}::uuid,
      ${session.user.id}::uuid
    )
    RETURNING *
  `);
  const invoice = inserted[0]!;

  // Timeline + audit.
  await sql`
    INSERT INTO order_events
      (workspace_id, order_id, event_type, from_status, to_status, payload, actor_user_id)
    VALUES (
      ${session.workspace.id}::uuid,
      ${orderId}::uuid,
      'order.invoice.generated',
      ${order.status}::order_status,
      ${order.status}::order_status,
      ${JSON.stringify({
        invoice_id: invoice.id,
        invoice_number: invoiceNumber,
        sequence,
        revision,
        total_paise: Number(order.total_paise),
        superseded_invoice_id: superseded?.id ?? null,
      })}::jsonb,
      ${session.user.id}::uuid
    )
  `;

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.invoice.generated',
    targetType: 'invoice',
    targetId: invoice.id as string,
    payload: {
      order_id: orderId,
      invoice_id: invoice.id,
      invoice_number: invoiceNumber,
      sequence,
      revision,
      total_paise: Number(order.total_paise),
      superseded_invoice_id: superseded?.id ?? null,
    },
    ipAddress, userAgent,
  });

  emitNotification({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'invoice.generated',
    targetType: 'invoice', targetId: invoice.id as string,
    linkUrl: `/order.html?id=${orderId}`,
    metadata: {
      invoice_number: invoiceNumber, order_number: order.order_number,
      amount: (Number(order.total_paise) / 100).toLocaleString('en-IN'),
    },
  }).catch(() => {});

  return { ok: true, invoice, order: orderLite(order), superseded, revision, invoice_number: invoiceNumber };
}

// POST /:orderId — generate a new invoice (thin wrapper over generateInvoice)
invoices.post('/:orderId', requirePermission('invoices.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const orderId = c.req.param('orderId');
  const sequence = Math.max(1, Number(c.req.query('sequence') || 1) || 1);

  const body = await c.req.json().catch(() => ({}));
  const parsed = generateSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  // Sub-turn 13: block-with-confirm when the customer's GST state was ASSUMED.
  // A wrong CGST/SGST-vs-IGST split breaks the customer's return too, so freezing
  // an invoice on a guess needs an explicit human confirm ({ confirm_state: true }).
  const ordRows = await query<{ state_assumed: boolean }>(sql`
    SELECT state_assumed FROM orders
    WHERE id = ${orderId}::uuid AND workspace_id = ${session.workspace.id}::uuid LIMIT 1
  `);
  if (ordRows[0]?.state_assumed && (body as Record<string, unknown>)?.confirm_state !== true) {
    return c.json({ error: 'state_assumed', reason: 'customer_gst_state_assumed_confirm_required' }, 409);
  }

  const result = await generateInvoice({
    workspaceId: session.workspace.id,
    userId: session.user.id,
    orderId,
    sequence,
    notes: parsed.data.notes ?? null,
    ipAddress, userAgent,
  });
  if (!result.ok) {
    const payload: Record<string, unknown> = { error: result.error };
    if (result.reason) payload.reason = result.reason;
    return c.json(payload, result.status);
  }
  return c.json({ invoice: result.invoice, order: result.order, superseded: result.superseded }, 201);
});

// ============================================================================
// GET /:orderId/:invoiceId — one invoice with full snapshot
// ============================================================================
invoices.get('/:orderId/:invoiceId', async (c) => {
  const session = c.get('session')!;
  const orderId = c.req.param('orderId');
  const invoiceId = c.req.param('invoiceId');

  const rows = await query<Record<string, unknown>>(sql`
    SELECT * FROM invoices
    WHERE id = ${invoiceId}::uuid
      AND order_id = ${orderId}::uuid
      AND workspace_id = ${session.workspace.id}::uuid
    LIMIT 1
  `);
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404);
  return c.json(rows[0]);
});

// ============================================================================
// POST /:orderId/:invoiceId/transitions — advisory invoice status change
// ============================================================================
const invoiceTransitionSchema = z.object({
  to:     z.enum(['sent', 'paid', 'cancelled']),
  reason: z.string().max(500).optional(),
  force:  z.boolean().default(false),
});

invoices.post('/:orderId/:invoiceId/transitions', requirePermission('invoices.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const orderId = c.req.param('orderId');
  const invoiceId = c.req.param('invoiceId');

  const body = await c.req.json().catch(() => null);
  const parsed = invoiceTransitionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { to, reason, force } = parsed.data;

  const invRows = await query<{ id: string; status: string; total_paise: number; invoice_number: string; order_number: number }>(sql`
    SELECT i.id, i.status::text AS status, i.total_paise, i.invoice_number, o.order_number
    FROM invoices i
    JOIN orders o ON o.id = i.order_id
    WHERE i.id = ${invoiceId}::uuid
      AND i.order_id = ${orderId}::uuid
      AND i.workspace_id = ${session.workspace.id}::uuid
    LIMIT 1
  `);
  if (invRows.length === 0) return c.json({ error: 'not_found' }, 404);
  const inv = invRows[0]!;
  const from = inv.status;

  if (from === to) return c.json({ invoice: inv, unchanged: true });

  const canonical = (CANONICAL_INVOICE_TRANSITIONS[from] ?? []).includes(to);
  if (!canonical && !force) {
    return c.json({
      error: 'non_canonical_transition',
      from, to,
      hint: 'resubmit with { "force": true } to override — reason recommended',
    }, 409);
  }

  // Marking paid requires the order to actually show full payment.
  if (to === 'paid') {
    const order = await loadOrderFull(orderId, session.workspace.id);
    if (!order) return c.json({ error: 'not_found' }, 404);
    if (Number(order.paid_paise) !== Number(inv.total_paise)) {
      return c.json({ error: 'invoice_not_fully_paid' }, 409);
    }
  }

  const setSent = to === 'sent';
  const setPaid = to === 'paid';
  const updated = await query<Record<string, unknown>>(sql`
    UPDATE invoices SET
      status  = ${to}::invoice_status,
      sent_at = CASE WHEN ${setSent}::boolean THEN COALESCE(sent_at, now()) ELSE sent_at END,
      paid_at = CASE WHEN ${setPaid}::boolean THEN COALESCE(paid_at, now()) ELSE paid_at END
    WHERE id = ${invoiceId}::uuid AND workspace_id = ${session.workspace.id}::uuid
    RETURNING *
  `);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: canonical ? 'orders.invoice.status.changed' : 'orders.invoice.status.forced',
    targetType: 'invoice',
    targetId: invoiceId,
    payload: { order_id: orderId, invoice_id: invoiceId, from, to, canonical, reason: reason ?? null },
    ipAddress, userAgent,
  });

  emitNotification({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'invoice.status.changed',
    targetType: 'invoice', targetId: invoiceId,
    linkUrl: `/order.html?id=${orderId}`,
    metadata: { invoice_number: inv.invoice_number, new_status: to, order_number: inv.order_number },
  }).catch(() => {});

  return c.json({ invoice: updated[0], canonical });
});
