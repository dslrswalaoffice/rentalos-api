import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import { emitNotification } from '../lib/notify.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';
import { requirePermission, can } from '../lib/permissions.js';
import { recomputeOrderTotals } from '../lib/pricing.js';
import { idempotencyMiddleware } from '../lib/idempotency.js';
import {
  loadOrderLite,
  netReceivedPaise,
  recomputeOrderPayments,
  applyDepositStatus,
  commitPaymentAndReconcile,
} from '../lib/payment_commit.js';

// ============================================================================
// src/routes/payments.ts  (Sub-turn 2.2a)
// ----------------------------------------------------------------------------
// Payment layer for orders. Mounted at /api/order-payments (a sibling of the
// orders router — see src/app.ts for why this is a top-level segment rather
// than nested under /api/orders/:id/payments).
//
//   GET    /:orderId                       list payments for an order
//   POST   /:orderId                       record a new (direction 'in') payment
//   DELETE /:orderId/:paymentId            delete a payment (5-min correction window)
//   POST   /:orderId/:paymentId/refund     refund a payment (direction 'out')
//
// paid_paise / balance_paise on the order are cached shortcuts. The source of
// truth is SUM(payments). recomputeOrderPayments() refreshes them after every
// write. This is a separate recompute chain from pricing — the two never touch.
//
// CONCURRENCY: like the pricing engine, the Neon HTTP driver has no
// cross-statement transactions, so two concurrent payment writes on one order
// can race and leave a stale cached total. Worst case self-corrects on the next
// payment write. No locking by design.
// ============================================================================

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = {
  Variables: {
    session: SessionVar;
  };
};

export const payments = new Hono<Env>();
// Slice 7: enforced-when-present idempotency (the new payment modal always sends
// an Idempotency-Key so a double-submit can't double-charge the customer).
payments.use('*', sessionMiddleware, requireAuth, idempotencyMiddleware);

const METHODS = ['upi', 'bank_transfer', 'cash', 'card', 'cheque', 'wallet', 'other'] as const;

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------
// OrderLite + the money primitives (loadOrderLite, netReceivedPaise,
// recomputeOrderPayments, applyDepositStatus) now live in ../lib/payment_commit.js
// (Slice 7) so the shared commit-and-reconcile helper can reuse them without a
// route->lib->route import cycle. Imported at the top of this file.

type PaymentRow = {
  id: string;
  order_id: string;
  workspace_id: string;
  amount_paise: number;
  direction: string;
  method: string;
  payment_kind: string;
  reference: string | null;
  status: string;
  notes: string | null;
  received_by: string | null;
  occurred_at: string;
  created_at: string;
  // SS-2.4 (migrations 055/056) — deposit-only metadata (NULL on rental rows).
  deposit_number: string | null;
  method_reference: Record<string, unknown> | null;
  cheque_status: string | null;
  custody_holder_user_id: string | null;
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

// Customer display name for a notification body (empty string if unavailable).
async function customerNameFor(orderId: string, workspaceId: string): Promise<string> {
  const r = await query<{ name: string }>(sql`
    SELECT p.display_name AS name
    FROM orders o JOIN people p ON p.id = o.customer_person_id
    WHERE o.id = ${orderId}::uuid AND o.workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `);
  return r[0]?.name ?? '';
}

function rupees(paise: number): string {
  return (Number(paise) / 100).toLocaleString('en-IN');
}

// Refund linkage rides in the notes field as a `refund_of:<uuid>\n` prefix.
// Lightweight — avoids a schema change; promote to a real column if refund
// analytics ever get complicated.
function parseRefundOf(notes: string | null): { refundOf: string | null; clean: string | null } {
  if (!notes) return { refundOf: null, clean: notes ?? null };
  const m = notes.match(/^refund_of:([0-9a-fA-F-]{36})\n?/);
  if (!m) return { refundOf: null, clean: notes };
  const clean = notes.slice(m[0].length);
  return { refundOf: m[1]!, clean: clean.length ? clean : null };
}

// ============================================================================
// GET /:orderId — list payments for an order
// ============================================================================
payments.get('/:orderId', async (c) => {
  const session = c.get('session')!;
  const orderId = c.req.param('orderId');

  const order = await loadOrderLite(orderId, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);

  const rows = await query<
    PaymentRow & {
      received_by_name: string | null; within_window: boolean; is_owner: boolean;
      custody_holder_name: string | null;
    }
  >(sql`
    SELECT
      p.*,
      u.display_name  AS received_by_name,
      cu.display_name AS custody_holder_name,
      (p.created_at > now() - interval '5 minutes') AS within_window,
      (p.received_by = ${session.user.id}::uuid)     AS is_owner
    FROM payments p
    LEFT JOIN users u  ON u.id  = p.received_by
    LEFT JOIN users cu ON cu.id = p.custody_holder_user_id
    WHERE p.order_id = ${orderId}::uuid
      AND p.workspace_id = ${session.workspace.id}::uuid
    ORDER BY p.occurred_at DESC, p.created_at DESC
  `);

  const paymentsOut = rows.map((r) => {
    const { refundOf, clean } = parseRefundOf(r.notes);
    return {
      id: r.id,
      amount_paise: Number(r.amount_paise),
      direction: r.direction,
      method: r.method,
      payment_kind: r.payment_kind,
      reference: r.reference,
      status: r.status,
      notes: clean,
      received_by_name: r.received_by_name,
      occurred_at: r.occurred_at,
      created_at: r.created_at,
      is_refund_of_payment_id: refundOf,
      is_deletable: Boolean(r.within_window && r.is_owner),
    };
  });

  // SS-2.4 P2a — Deposit Hold 360 block. Derived from the deposit-kind payments
  // (the shipped 6d model), never a separate deposit_holds table. The anchor is
  // the first 'deposit' row (carries the DP-number + custody + cheque state).
  const DEP_KINDS = ['deposit', 'deposit_refund', 'deposit_forfeit'];
  const depRows = rows.filter((r) => DEP_KINDS.includes(r.payment_kind) && r.status === 'completed');
  const sumKind = (k: string) =>
    depRows.filter((r) => r.payment_kind === k).reduce((s, r) => s + Number(r.amount_paise), 0);
  const heldPaise = sumKind('deposit');
  const releasedPaise = sumKind('deposit_refund');
  const forfeitedPaise = sumKind('deposit_forfeit');
  // Anchor = earliest 'deposit' row (rows are DESC, so take the last deposit).
  const depositAnchors = depRows.filter((r) => r.payment_kind === 'deposit');
  const anchor = depositAnchors[depositAnchors.length - 1] ?? null;

  const deposit =
    depRows.length === 0 && Number(order.deposit_required_paise) === 0
      ? null
      : {
          deposit_number: anchor?.deposit_number ?? null,
          status: order.deposit_status,
          required_paise: Number(order.deposit_required_paise),
          held_paise: heldPaise,
          released_paise: releasedPaise,
          forfeited_paise: forfeitedPaise,
          net_held_paise: heldPaise - releasedPaise - forfeitedPaise,
          custody_holder_user_id: anchor?.custody_holder_user_id ?? null,
          custody_holder_name: anchor?.custody_holder_name ?? null,
          cheque_status: anchor?.cheque_status ?? null,
          method_reference: anchor?.method_reference ?? null,
          // Deposit event trail = the deposit-kind payment rows (most-recent first).
          events: depRows.map((r) => ({
            payment_id: r.id,
            payment_kind: r.payment_kind,
            amount_paise: Number(r.amount_paise),
            method: r.method,
            cheque_status: r.cheque_status,
            occurred_at: r.occurred_at,
          })),
        };

  return c.json({
    order: {
      id: order.id,
      order_number: order.order_number,
      total_paise: Number(order.total_paise),
      paid_paise: Number(order.paid_paise),
      balance_paise: Number(order.balance_paise),
      deposit_required_paise: Number(order.deposit_required_paise),
      deposit_status: order.deposit_status,
    },
    payments: paymentsOut,
    deposit,
  });
});

// ============================================================================
// Payment policy (Slice 7) — settings.payment_policy, seeded by migration 061.
// Drives the modal's enabled methods + method-specific reference requirements.
// ============================================================================
type PaymentPolicy = {
  correction_window_minutes: number;
  methods_enabled: string[];
  require_reference_for_upi: boolean;
  require_reference_for_bank_transfer: boolean;
  require_cheque_number: boolean;
  require_custody_holder_for_cash: boolean;
};

const PAYMENT_POLICY_DEFAULTS: PaymentPolicy = {
  correction_window_minutes: 5,
  methods_enabled: [...METHODS],
  require_reference_for_upi: true,
  require_reference_for_bank_transfer: true,
  require_cheque_number: true,
  require_custody_holder_for_cash: false,
};

async function loadPaymentPolicy(workspaceId: string): Promise<PaymentPolicy> {
  const rows = await query<{ policy: Partial<PaymentPolicy> | null }>(sql`
    SELECT settings->'payment_policy' AS policy FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
  `);
  const p = rows[0]?.policy ?? {};
  return {
    ...PAYMENT_POLICY_DEFAULTS,
    ...p,
    methods_enabled: Array.isArray(p.methods_enabled) && p.methods_enabled.length
      ? p.methods_enabled.filter((m): m is string => (METHODS as readonly string[]).includes(m))
      : PAYMENT_POLICY_DEFAULTS.methods_enabled,
  };
}

// Is a reference/number required for this method under the workspace policy?
function referenceRequired(policy: PaymentPolicy, method: string): boolean {
  if (method === 'upi') return policy.require_reference_for_upi;
  if (method === 'bank_transfer') return policy.require_reference_for_bank_transfer;
  if (method === 'cheque') return policy.require_cheque_number;
  return false;
}

// Latest non-cancelled invoice status for the order (null if none). Used by the
// preview to tell the operator whether recording will auto-mark an invoice paid.
async function latestInvoiceStatus(orderId: string, workspaceId: string): Promise<{ id: string; status: string; invoice_number: string } | null> {
  const rows = await query<{ id: string; status: string; invoice_number: string }>(sql`
    SELECT id, status::text AS status, invoice_number FROM invoices
    WHERE order_id = ${orderId}::uuid AND workspace_id = ${workspaceId}::uuid
      AND status <> 'cancelled'::invoice_status
    ORDER BY sequence DESC, revision DESC LIMIT 1
  `);
  return rows[0] ?? null;
}

async function autoMarkPaidEnabled(workspaceId: string): Promise<boolean> {
  const rows = await query<{ v: boolean | null }>(sql`
    SELECT (settings->'invoice_policy'->>'auto_mark_paid_on_zero_balance')::boolean AS v
    FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
  `);
  return rows[0]?.v ?? true;
}

// ============================================================================
// GET /:orderId/payment-options — modal config: enabled methods, kinds the
// caller may record, reference rules, and the current money summary. Read-only.
// ============================================================================
payments.get('/:orderId/payment-options', async (c) => {
  const session = c.get('session')!;
  const orderId = c.req.param('orderId');

  const order = await loadOrderLite(orderId, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);

  const policy = await loadPaymentPolicy(session.workspace.id);

  // Which kinds this member may record. rental + deposit need payments.record;
  // deposit_refund / deposit_forfeit RELEASE held money → deposits.retain.
  // net_held = completed deposits − completed refunds − completed forfeits.
  const depRows = await query<{ kind: string; sum: number }>(sql`
    SELECT payment_kind AS kind, COALESCE(SUM(amount_paise), 0)::bigint AS sum FROM payments
    WHERE order_id = ${orderId}::uuid AND workspace_id = ${session.workspace.id}::uuid
      AND status = 'completed' AND payment_kind IN ('deposit', 'deposit_refund', 'deposit_forfeit')
    GROUP BY payment_kind
  `);
  const depSum = (k: string) => Number(depRows.find((r) => r.kind === k)?.sum ?? 0);
  const netHeldPaise = depSum('deposit') - depSum('deposit_refund') - depSum('deposit_forfeit');
  const hasDeposit = depSum('deposit') > 0;
  const canRecord = can(session, 'payments.record');
  const canRetain = can(session, 'deposits.retain');

  // Forfeit reason taxonomy is config-driven (deposit_policy). Frontend renders
  // the dropdown from this list; the display labels are formatted client-side.
  const dpRows = await query<{ tax: string[] | null }>(sql`
    SELECT ARRAY(SELECT jsonb_array_elements_text(COALESCE(settings->'deposit_policy'->'forfeit_reason_taxonomy', '[]'::jsonb)))::text[] AS tax
    FROM workspaces WHERE id = ${session.workspace.id}::uuid LIMIT 1
  `);
  const forfeitTaxonomy = (dpRows[0]?.tax && dpRows[0].tax.length)
    ? dpRows[0].tax
    : ['damage_customer_liable', 'missing_accessories', 'late_return', 'other'];

  const kinds = [
    { kind: 'rental', label: 'Rental payment', allowed: canRecord, needs_deposit: false },
    { kind: 'deposit', label: 'Security deposit', allowed: canRecord, needs_deposit: false },
    { kind: 'deposit_refund', label: 'Deposit refund', allowed: canRetain && hasDeposit, needs_deposit: true },
    { kind: 'deposit_forfeit', label: 'Damage settlement (retain deposit)', allowed: canRetain && hasDeposit, needs_deposit: true },
  ];

  return c.json({
    order: {
      id: order.id, order_number: order.order_number,
      total_paise: Number(order.total_paise),
      paid_paise: Number(order.paid_paise),
      balance_paise: Number(order.balance_paise),
      deposit_required_paise: Number(order.deposit_required_paise),
      deposit_status: order.deposit_status,
      has_deposit: hasDeposit,
    },
    policy: {
      methods_enabled: policy.methods_enabled,
      correction_window_minutes: policy.correction_window_minutes,
      require_reference_for_upi: policy.require_reference_for_upi,
      require_reference_for_bank_transfer: policy.require_reference_for_bank_transfer,
      require_cheque_number: policy.require_cheque_number,
      require_custody_holder_for_cash: policy.require_custody_holder_for_cash,
    },
    kinds,
    // Suggested prefill = outstanding rental balance (never negative).
    suggested_amount_paise: Math.max(0, Number(order.balance_paise)),
    // Net deposit still held — the default amount for a release/forfeit.
    net_held_deposit_paise: Math.max(0, netHeldPaise),
    forfeit_reason_taxonomy: forfeitTaxonomy,
    auto_mark_paid_on_zero_balance: await autoMarkPaidEnabled(session.workspace.id),
  });
});

// ============================================================================
// POST /:orderId/preview — non-mutating projection of a prospective payment:
// what the balance becomes + whether it would auto-mark the invoice paid + any
// reference requirement. Powers the modal's live preview panel (Q2). No writes.
// ============================================================================
export const paymentPreviewSchema = z.object({
  amount_paise: z.number().int().positive(),
  method:       z.enum(METHODS),
  payment_kind: z.enum(['rental', 'deposit', 'deposit_refund', 'deposit_forfeit']).default('rental'),
  reference:    z.string().max(200).optional(),
});

payments.post('/:orderId/preview', async (c) => {
  const session = c.get('session')!;
  const orderId = c.req.param('orderId');

  const body = await c.req.json().catch(() => null);
  const parsed = paymentPreviewSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  const order = await loadOrderLite(orderId, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);

  const policy = await loadPaymentPolicy(session.workspace.id);
  const kind = input.payment_kind;
  const isRentalMoney = kind === 'rental'; // only rental kind moves paid/balance

  const currentBalance = Number(order.balance_paise);
  const currentPaid = Number(order.paid_paise);
  // deposit_refund returns money (out); everything else here is inbound (in).
  const signed = kind === 'deposit_refund' ? -input.amount_paise : input.amount_paise;
  const projectedPaid = isRentalMoney ? currentPaid + signed : currentPaid;
  const projectedBalance = isRentalMoney ? currentBalance - signed : currentBalance;

  const inv = await latestInvoiceStatus(orderId, session.workspace.id);
  const autoMark = await autoMarkPaidEnabled(session.workspace.id);
  const wouldMarkInvoicePaid =
    Boolean(autoMark && isRentalMoney && projectedBalance <= 0 && inv?.status === 'sent');

  const refNeeded = referenceRequired(policy, input.method);
  const refMissing = refNeeded && !(input.reference && input.reference.trim().length);

  return c.json({
    current:   { paid_paise: currentPaid, balance_paise: currentBalance },
    projected: { paid_paise: projectedPaid, balance_paise: projectedBalance, fully_paid: projectedBalance <= 0 },
    affects_rental_balance: isRentalMoney,
    reference_required: refNeeded,
    reference_missing: refMissing,
    would_mark_invoice_paid: wouldMarkInvoicePaid,
    latest_invoice: inv ? { id: inv.id, invoice_number: inv.invoice_number, status: inv.status } : null,
  });
});

// ============================================================================
// POST /:orderId — record a new payment (direction 'in')
// ============================================================================
export const paymentCreateSchema = z.object({
  amount_paise: z.number().int().positive(),
  method:       z.enum(METHODS),
  reference:    z.string().max(200).optional(),
  notes:        z.string().max(1000).optional(),
  occurred_at:  z.string().datetime().optional(),
  payment_kind: z.enum(['rental', 'deposit', 'deposit_refund', 'deposit_forfeit']).default('rental'),
  // SS-2.4 P2a — deposit-only cheque/custody metadata (ignored for rental kind).
  // method_reference holds UPI ref / cheque number / bank txn id etc.
  method_reference:       z.record(z.string(), z.any()).optional(),
  cheque_status:          z.enum(['pending', 'deposited', 'cleared', 'bounced', 're_presented']).optional(),
  custody_holder_user_id: z.string().uuid().optional(),
});

// Deposit-kind → audit event + which direction the cash moves. deposit_refund
// returns money (out); everything else is an inbound receipt / obligation change.
const DEPOSIT_AUDIT: Record<string, 'payments.deposit_recorded' | 'payments.deposit_refunded' | 'payments.deposit_forfeited'> = {
  deposit: 'payments.deposit_recorded',
  deposit_refund: 'payments.deposit_refunded',
  deposit_forfeit: 'payments.deposit_forfeited',
};

payments.post('/:orderId', requirePermission('payments.record'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const orderId = c.req.param('orderId');

  const body = await c.req.json().catch(() => null);
  const parsed = paymentCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;
  const kind = input.payment_kind;
  const isDeposit = kind !== 'rental';

  // Sub-turn 12a: recording a rental payment or an incoming deposit needs
  // payments.record (route-gated). RELEASING money already held — a deposit
  // refund or forfeit — is deposits.retain, which staff don't have.
  if ((kind === 'deposit_refund' || kind === 'deposit_forfeit') && !can(session, 'deposits.retain')) {
    return c.json({ error: 'forbidden', required_permission: ['deposits.retain'] }, 403);
  }

  const order = await loadOrderLite(orderId, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  // Cancelled orders reject new payments. Closed orders accept them (a rental
  // can close before a final payment lands).
  if (order.status === 'cancelled') {
    return c.json({ error: 'order_cancelled' }, 409);
  }

  // A refund/forfeit can only act on money we actually hold — require a prior
  // completed deposit payment on this order.
  if (kind === 'deposit_refund' || kind === 'deposit_forfeit') {
    const held = await query<{ sum: number }>(sql`
      SELECT COALESCE(SUM(amount_paise), 0)::bigint AS sum
      FROM payments
      WHERE order_id = ${orderId}::uuid AND workspace_id = ${session.workspace.id}::uuid
        AND status = 'completed' AND payment_kind = 'deposit'
    `);
    if (Number(held[0]?.sum ?? 0) === 0) {
      return c.json({ error: 'no_deposit_to_release' }, 409);
    }
  }

  // Direction is derived from the kind, not trusted from the body: a deposit
  // refund returns cash (out); a deposit collection and a forfeit are both
  // inbound (a forfeit reclassifies money we already hold).
  const direction = kind === 'deposit_refund' ? 'out' : 'in';
  const occurredAt = input.occurred_at ?? new Date().toISOString();

  // SS-2.4 P2a — deposit-only metadata. A fresh 'deposit' anchors a deposit hold:
  // mint a human number DP-YYYY-{order#}-{seq} (seq = nth deposit on this order).
  // Cheque deposits default cheque_status to 'pending'. Rental / refund / forfeit
  // rows leave all of these NULL.
  let depositNumber: string | null = null;
  if (kind === 'deposit') {
    const seqRow = await query<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM payments
      WHERE order_id = ${orderId}::uuid AND workspace_id = ${session.workspace.id}::uuid
        AND payment_kind = 'deposit'
    `);
    const seq = Number(seqRow[0]?.n ?? 0) + 1;
    const year = new Date(occurredAt).getUTCFullYear();
    depositNumber = `DP-${year}-${String(order.order_number).padStart(4, '0')}-${seq}`;
  }
  const chequeStatus = kind === 'deposit'
    ? (input.cheque_status ?? (input.method === 'cheque' ? 'pending' : null))
    : null;
  const custodyHolder = kind === 'deposit' ? (input.custody_holder_user_id ?? null) : null;
  const methodRef = isDeposit && input.method_reference ? JSON.stringify(input.method_reference) : null;

  const inserted = await query<PaymentRow>(sql`
    INSERT INTO payments (
      workspace_id, order_id, amount_paise, direction, method, payment_kind,
      reference, status, notes, received_by, occurred_at,
      deposit_number, method_reference, cheque_status, custody_holder_user_id
    ) VALUES (
      ${session.workspace.id}::uuid,
      ${orderId}::uuid,
      ${input.amount_paise}::bigint,
      ${direction}::payment_direction,
      ${input.method}::payment_method,
      ${kind}::text,
      ${input.reference ?? null}::text,
      'completed'::payment_status,
      ${input.notes ?? null}::text,
      ${session.user.id}::uuid,
      ${occurredAt}::timestamptz,
      ${depositNumber}::text,
      ${methodRef}::jsonb,
      ${chequeStatus}::text,
      ${custodyHolder}::uuid
    )
    RETURNING *
  `);
  const payment = inserted[0]!;

  // Sub-turn 13: a RETAINED (forfeited) deposit becomes an order line so the
  // invoice EXPLAINS why the amount was withheld — not a mystery subtraction.
  // It's a custom line; recompute picks up the total + tax. Done BEFORE the
  // money commit so the balance + invoice reconcile see the final total.
  // Fail-open.
  if (kind === 'deposit_forfeit') {
    const reason = (input.notes ?? '').trim();
    await sql`
      INSERT INTO order_items
        (workspace_id, order_id, item_type, description, quantity,
         unit_amount_paise, total_amount_paise, is_custom_line, custom_name, sort_order)
      VALUES (${session.workspace.id}::uuid, ${orderId}::uuid, 'other'::order_item_type,
              ${reason ? 'Retained deposit — ' + reason : 'Retained deposit'}::text, 1,
              ${input.amount_paise}::bigint, ${input.amount_paise}::bigint,
              true, 'Retained deposit'::text, 8500)
    `;
    await recomputeOrderTotals(orderId, session.workspace.id, session.user.id).catch(() => {});
  }

  // Slice 7: the shared Money-Engine commit — recompute paid/balance from
  // SUM(payments), refresh deposit_status (deposit kinds), and auto-reconcile
  // the latest invoice against the new balance (payment -> zero balance ->
  // invoice 'paid', policy-gated). Deposits never touch rental paid/balance, so
  // recompute is a no-op there; reconcile still runs but the unchanged balance
  // yields no transition. Reconcile is fail-open inside the helper.
  const commit = await commitPaymentAndReconcile({
    workspaceId: session.workspace.id, orderId,
    actorUserId: session.user.id, isDeposit, ipAddress, userAgent,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: isDeposit ? DEPOSIT_AUDIT[kind]! : 'orders.payment.recorded',
    targetType: 'payment',
    targetId: payment.id,
    payload: {
      order_id: orderId,
      payment_id: payment.id,
      amount_paise: input.amount_paise,
      method: input.method,
      direction,
      payment_kind: kind,
    },
    ipAddress, userAgent,
  });

  // Deposit movements aren't customer rental payments — skip the payment.recorded
  // notification for them (it renders as a rental receipt).
  if (!isDeposit) {
    emitNotification({
      workspaceId: session.workspace.id,
      actorUserId: session.user.id,
      eventType: 'payment.recorded',
      targetType: 'payment', targetId: payment.id,
      linkUrl: `/order.html?id=${orderId}`,
      metadata: {
        order_number: order.order_number, amount: rupees(input.amount_paise),
        customer_name: await customerNameFor(orderId, session.workspace.id), method: input.method,
      },
    }).catch(() => {});
  }

  return c.json({
    payment,
    order: {
      id: order.id,
      order_number: order.order_number,
      total_paise: Number(order.total_paise),
      paid_paise: commit.order.paid_paise,
      balance_paise: commit.order.balance_paise,
    },
    invoice_reconcile: commit.invoice_reconcile,
  }, 201);
});

// ============================================================================
// DELETE /:orderId/:paymentId — delete a recent payment (correction window)
// ============================================================================
payments.delete('/:orderId/:paymentId', requirePermission('payments.record'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const orderId = c.req.param('orderId');
  const paymentId = c.req.param('paymentId');

  const order = await loadOrderLite(orderId, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);

  const rows = await query<{
    id: string; amount_paise: number; method: string; direction: string;
    within_window: boolean; is_owner: boolean;
  }>(sql`
    SELECT
      id, amount_paise, method, direction,
      (created_at > now() - interval '5 minutes')  AS within_window,
      (received_by = ${session.user.id}::uuid)      AS is_owner
    FROM payments
    WHERE id = ${paymentId}::uuid
      AND order_id = ${orderId}::uuid
      AND workspace_id = ${session.workspace.id}::uuid
    LIMIT 1
  `);
  const p = rows[0];

  if (!p) return c.json({ error: 'not_deletable', reason: 'not_found' }, 409);
  if (!p.is_owner) return c.json({ error: 'not_deletable', reason: 'not_your_payment' }, 409);
  if (!p.within_window) return c.json({ error: 'not_deletable', reason: 'outside_correction_window' }, 409);

  await sql`
    DELETE FROM payments
    WHERE id = ${paymentId}::uuid
      AND workspace_id = ${session.workspace.id}::uuid
  `;

  const rc = await recomputeOrderPayments(orderId, session.workspace.id, session.user.id);
  // A deleted deposit-kind payment shifts the lifecycle; recompute + audit.
  await applyDepositStatus({
    workspaceId: session.workspace.id, orderId,
    actorUserId: session.user.id, ipAddress, userAgent,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.payment.deleted',
    targetType: 'payment',
    targetId: paymentId,
    payload: {
      order_id: orderId,
      payment_id: paymentId,
      amount_paise: Number(p.amount_paise),
      method: p.method,
      direction: p.direction,
    },
    ipAddress, userAgent,
  });

  emitNotification({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'payment.deleted',
    targetType: 'order', targetId: orderId,
    linkUrl: `/order.html?id=${orderId}`,
    metadata: { order_number: order.order_number, amount: rupees(Number(p.amount_paise)) },
  }).catch(() => {});

  return c.json({
    ok: true,
    order: {
      id: order.id,
      order_number: order.order_number,
      total_paise: Number(order.total_paise),
      paid_paise: rc.paid_paise,
      balance_paise: rc.balance_paise,
    },
  });
});

// ============================================================================
// POST /:orderId/:paymentId/refund — refund a payment (direction 'out')
// ============================================================================
export const refundSchema = z.object({
  amount_paise: z.number().int().positive(),
  method:       z.enum(METHODS),
  reference:    z.string().max(200).optional(),
  notes:        z.string().max(1000).optional(),
  occurred_at:  z.string().datetime().optional(),
});

payments.post('/:orderId/:paymentId/refund', requirePermission('payments.refund'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const orderId = c.req.param('orderId');
  const paymentId = c.req.param('paymentId');

  const body = await c.req.json().catch(() => null);
  const parsed = refundSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const order = await loadOrderLite(orderId, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (order.status === 'cancelled') {
    return c.json({ error: 'order_cancelled' }, 409);
  }

  // Original must be a completed inbound payment on this order.
  const origRows = await query<PaymentRow>(sql`
    SELECT * FROM payments
    WHERE id = ${paymentId}::uuid
      AND order_id = ${orderId}::uuid
      AND workspace_id = ${session.workspace.id}::uuid
      AND direction = 'in'
      AND status = 'completed'
    LIMIT 1
  `);
  if (origRows.length === 0) return c.json({ error: 'payment_not_found' }, 404);

  // Cannot refund more than the net-received amount on the order.
  const net = await netReceivedPaise(orderId, session.workspace.id);
  if (input.amount_paise > net) {
    return c.json({
      error: 'refund_exceeds_refundable',
      refundable_paise: net,
      requested_paise: input.amount_paise,
    }, 400);
  }

  const occurredAt = input.occurred_at ?? new Date().toISOString();
  const refundNotes = `refund_of:${paymentId}\n${input.notes ?? ''}`;

  const inserted = await query<PaymentRow>(sql`
    INSERT INTO payments (
      workspace_id, order_id, amount_paise, direction, method,
      reference, status, notes, received_by, occurred_at
    ) VALUES (
      ${session.workspace.id}::uuid,
      ${orderId}::uuid,
      ${input.amount_paise}::bigint,
      'out'::payment_direction,
      ${input.method}::payment_method,
      ${input.reference ?? null}::text,
      'completed'::payment_status,
      ${refundNotes}::text,
      ${session.user.id}::uuid,
      ${occurredAt}::timestamptz
    )
    RETURNING *
  `);
  const refund = inserted[0]!;

  // Slice 7: shared money commit — recompute paid/balance and reconcile the
  // latest invoice. A refund that reopens a positive balance reverts a
  // previously auto-marked invoice 'paid' -> 'sent' (fail-open inside).
  const commit = await commitPaymentAndReconcile({
    workspaceId: session.workspace.id, orderId,
    actorUserId: session.user.id, isDeposit: false, ipAddress, userAgent,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.payment.refunded',
    targetType: 'payment',
    targetId: refund.id,
    payload: {
      order_id: orderId,
      original_payment_id: paymentId,
      refund_payment_id: refund.id,
      amount_paise: input.amount_paise,
      method: input.method,
    },
    ipAddress, userAgent,
  });

  emitNotification({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'payment.refunded',
    targetType: 'payment', targetId: refund.id,
    linkUrl: `/order.html?id=${orderId}`,
    metadata: { order_number: order.order_number, amount: rupees(input.amount_paise), method: input.method },
  }).catch(() => {});

  return c.json({
    payment: refund,
    order: {
      id: order.id,
      order_number: order.order_number,
      total_paise: Number(order.total_paise),
      paid_paise: commit.order.paid_paise,
      balance_paise: commit.order.balance_paise,
    },
    invoice_reconcile: commit.invoice_reconcile,
  }, 201);
});

// ============================================================================
// POST /:orderId/:paymentId/complete — finalize a PENDING payment (Slice 7 S2).
// ----------------------------------------------------------------------------
// The deposit auto-release creates a deposit_refund with status='pending' (the
// bank transfer is settled out-of-band). Accounts marks it 'completed' here,
// optionally adjusting the amount first (Q3). Completing a deposit_refund flips
// the deposit_status to 'released' via the shared commit. Gated by
// deposits.retain (releasing held money). Only pending rows are completable.
// ============================================================================
export const completeSchema = z.object({
  amount_paise: z.number().int().positive().optional(),
  notes:        z.string().max(1000).optional(),
});

payments.post('/:orderId/:paymentId/complete', requirePermission('deposits.retain'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const orderId = c.req.param('orderId');
  const paymentId = c.req.param('paymentId');

  const body = await c.req.json().catch(() => null);
  const parsed = completeSchema.safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  const order = await loadOrderLite(orderId, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);

  const rows = await query<{ id: string; status: string; payment_kind: string; amount_paise: number }>(sql`
    SELECT id, status::text AS status, payment_kind, amount_paise
    FROM payments
    WHERE id = ${paymentId}::uuid AND order_id = ${orderId}::uuid AND workspace_id = ${session.workspace.id}::uuid
    LIMIT 1
  `);
  const p = rows[0];
  if (!p) return c.json({ error: 'payment_not_found' }, 404);
  if (p.status !== 'pending') return c.json({ error: 'not_pending', current_status: p.status }, 409);

  const newAmount = input.amount_paise ?? Number(p.amount_paise);
  await sql`
    UPDATE payments SET
      status      = 'completed'::payment_status,
      amount_paise = ${newAmount}::bigint,
      notes       = COALESCE(${input.notes ?? null}::text, notes),
      occurred_at = now()
    WHERE id = ${paymentId}::uuid AND workspace_id = ${session.workspace.id}::uuid AND status = 'pending'::payment_status
  `;

  const isDeposit = ['deposit', 'deposit_refund', 'deposit_forfeit'].includes(p.payment_kind);
  const commit = await commitPaymentAndReconcile({
    workspaceId: session.workspace.id, orderId, actorUserId: session.user.id, isDeposit, ipAddress, userAgent,
  });

  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id,
    eventType: 'deposits.release_completed',
    targetType: 'payment', targetId: paymentId,
    payload: { order_id: orderId, payment_id: paymentId, payment_kind: p.payment_kind, amount_paise: newAmount, deposit_status: commit.deposit_status?.new ?? null },
    ipAddress, userAgent,
  });

  return c.json({
    ok: true,
    payment_id: paymentId,
    amount_paise: newAmount,
    deposit_status: commit.deposit_status,
    order: { id: order.id, order_number: order.order_number, paid_paise: commit.order.paid_paise, balance_paise: commit.order.balance_paise },
  });
});
