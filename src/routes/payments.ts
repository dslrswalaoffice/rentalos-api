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
payments.use('*', sessionMiddleware, requireAuth);

const METHODS = ['upi', 'bank_transfer', 'cash', 'card', 'cheque', 'wallet', 'other'] as const;

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------
type OrderLite = {
  id: string;
  order_number: number;
  status: string;
  total_paise: number;
  paid_paise: number;
  balance_paise: number;
  deposit_required_paise: number;
  deposit_status: string;
  deleted_at: string | null;
};

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

async function loadOrderLite(orderId: string, workspaceId: string): Promise<OrderLite | null> {
  const rows = await query<OrderLite>(sql`
    SELECT id, order_number, status::text AS status,
           total_paise, paid_paise, balance_paise,
           deposit_required_paise, deposit_status, deleted_at
    FROM orders
    WHERE id = ${orderId}::uuid
      AND workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `);
  const o = rows[0];
  if (!o || o.deleted_at) return null;
  return o;
}

// Net received = SUM(in) - SUM(out) over completed payments on this order.
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

// RENTAL payments only — deposits (deposit / deposit_refund / deposit_forfeit)
// are refundable holdings, not sales, so they never touch the order's
// paid_paise / balance_paise. Existing rows all backfill to 'rental', so this
// leaves pre-6d behaviour unchanged.
async function netReceivedPaise(orderId: string, workspaceId: string): Promise<number> {
  const rows = await query<{ net: number }>(sql`
    SELECT COALESCE(SUM(
      CASE WHEN direction = 'in' THEN amount_paise ELSE -amount_paise END
    ), 0)::bigint AS net
    FROM payments
    WHERE order_id = ${orderId}::uuid
      AND workspace_id = ${workspaceId}::uuid
      AND status = 'completed'
      AND payment_kind = 'rental'
  `);
  return Number(rows[0]?.net ?? 0);
}

// ----------------------------------------------------------------------------
// Deposit lifecycle (Sub-turn 6d)
// ----------------------------------------------------------------------------
// deposit_status is denormalised on orders and recomputed from the deposit-kind
// payments after every deposit write/delete. There is no soft-delete on
// payments (hard DELETE within the correction window), so we sum live rows only.
const DEPOSIT_KINDS = ['deposit', 'deposit_refund', 'deposit_forfeit'] as const;

export async function computeDepositStatus(
  orderId: string,
  workspaceId: string,
  requiredPaise: number,
): Promise<string> {
  if (Number(requiredPaise) === 0) return 'none';

  const rows = await query<{ payment_kind: string; amount_paise: number }>(sql`
    SELECT payment_kind, amount_paise
    FROM payments
    WHERE order_id = ${orderId}::uuid
      AND workspace_id = ${workspaceId}::uuid
      AND status = 'completed'
      AND payment_kind = ANY(string_to_array(${DEPOSIT_KINDS.join(',')}::text, ','))
  `);

  const sumOf = (kind: string) =>
    rows.filter((r) => r.payment_kind === kind).reduce((s, r) => s + Number(r.amount_paise), 0);
  const held = sumOf('deposit');
  const refunded = sumOf('deposit_refund');
  const forfeited = sumOf('deposit_forfeit');
  const netHeld = held - refunded - forfeited;

  if (held === 0) return 'pending';
  if (netHeld > 0) return 'held';
  // netHeld === 0 (or defensively negative) → fully resolved one way or another.
  if (forfeited > 0 && refunded > 0) return 'partial_forfeited';
  if (forfeited >= held) return 'fully_forfeited';
  if (refunded > 0) return 'released';
  return 'held';
}

// Recompute + persist deposit_status; audit on change. Returns { old, new }.
// Exported so the deposit-amount PATCH in orders.ts can reuse it.
export async function applyDepositStatus(args: {
  workspaceId: string;
  orderId: string;
  actorUserId: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<{ old: string; new: string } | null> {
  const order = await loadOrderLite(args.orderId, args.workspaceId);
  if (!order) return null;
  const oldStatus = order.deposit_status;
  const newStatus = await computeDepositStatus(
    args.orderId,
    args.workspaceId,
    Number(order.deposit_required_paise),
  );
  if (newStatus === oldStatus) return { old: oldStatus, new: newStatus };

  await sql`
    UPDATE orders SET deposit_status = ${newStatus}::text, updated_at = now()
    WHERE id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;
  await audit({
    workspaceId: args.workspaceId,
    actorUserId: args.actorUserId,
    eventType: 'orders.deposit_status.changed',
    targetType: 'order',
    targetId: args.orderId,
    payload: { old: oldStatus, new: newStatus },
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  });
  return { old: oldStatus, new: newStatus };
}

// Refresh paid_paise / balance_paise on the order from SUM(payments).
// Writes an order_events row (only) on change — never audit_events, matching
// the pricing auto-recompute convention.
async function recomputeOrderPayments(
  orderId: string,
  workspaceId: string,
  actorUserId: string,
): Promise<{ paid_paise: number; balance_paise: number; changed: boolean }> {
  const order = await loadOrderLite(orderId, workspaceId);
  if (!order) throw new Error('not_found');

  const net = await netReceivedPaise(orderId, workspaceId);
  const paidPaise = net;
  const balancePaise = Number(order.total_paise) - paidPaise;

  const oldPaid = Number(order.paid_paise);
  const oldBalance = Number(order.balance_paise);
  const changed = oldPaid !== paidPaise || oldBalance !== balancePaise;

  if (changed) {
    await sql`
      UPDATE orders SET
        paid_paise    = ${paidPaise}::bigint,
        balance_paise = ${balancePaise}::bigint,
        updated_at    = now()
      WHERE id = ${orderId}::uuid
        AND workspace_id = ${workspaceId}::uuid
    `;

    const payload: Record<string, unknown> = {
      old: { paid_paise: oldPaid, balance_paise: oldBalance },
      new: { paid_paise: paidPaise, balance_paise: balancePaise },
    };
    await sql`
      INSERT INTO order_events
        (workspace_id, order_id, event_type, from_status, to_status, payload, actor_user_id)
      VALUES (
        ${workspaceId}::uuid,
        ${orderId}::uuid,
        'order.payments.recomputed',
        ${order.status}::order_status,
        ${order.status}::order_status,
        ${JSON.stringify(payload)}::jsonb,
        ${actorUserId}::uuid
      )
    `;
  }

  return { paid_paise: paidPaise, balance_paise: balancePaise, changed };
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
    PaymentRow & { received_by_name: string | null; within_window: boolean; is_owner: boolean }
  >(sql`
    SELECT
      p.*,
      u.display_name AS received_by_name,
      (p.created_at > now() - interval '5 minutes') AS within_window,
      (p.received_by = ${session.user.id}::uuid)     AS is_owner
    FROM payments p
    LEFT JOIN users u ON u.id = p.received_by
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
  });
});

// ============================================================================
// POST /:orderId — record a new payment (direction 'in')
// ============================================================================
const createSchema = z.object({
  amount_paise: z.number().int().positive(),
  method:       z.enum(METHODS),
  reference:    z.string().max(200).optional(),
  notes:        z.string().max(1000).optional(),
  occurred_at:  z.string().datetime().optional(),
  payment_kind: z.enum(['rental', 'deposit', 'deposit_refund', 'deposit_forfeit']).default('rental'),
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
  const parsed = createSchema.safeParse(body);
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

  const inserted = await query<PaymentRow>(sql`
    INSERT INTO payments (
      workspace_id, order_id, amount_paise, direction, method, payment_kind,
      reference, status, notes, received_by, occurred_at
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
      ${occurredAt}::timestamptz
    )
    RETURNING *
  `);
  const payment = inserted[0]!;

  // Deposits never touch rental paid/balance; still call recompute so a rental
  // payment updates the order (recompute is a no-op for deposit-only writes).
  const rc = await recomputeOrderPayments(orderId, session.workspace.id, session.user.id);

  // Deposit lifecycle: refresh deposit_status (audits its own change event).
  if (isDeposit) {
    await applyDepositStatus({
      workspaceId: session.workspace.id, orderId,
      actorUserId: session.user.id, ipAddress, userAgent,
    });
  }

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
      paid_paise: rc.paid_paise,
      balance_paise: rc.balance_paise,
    },
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
const refundSchema = z.object({
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

  const rc = await recomputeOrderPayments(orderId, session.workspace.id, session.user.id);

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
      paid_paise: rc.paid_paise,
      balance_paise: rc.balance_paise,
    },
  }, 201);
});
