import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import { emitNotification } from '../lib/notify.js';
import { recomputeOrderTotals } from '../lib/pricing.js';
import { checkAvailability, getDefaultLocationId } from '../lib/availability.js';
import { applyDepositStatus } from './payments.js';
import { loadCustomFieldValues, upsertCustomFieldValues } from '../lib/custom_fields.js';
import {
  loadTagsForEntity,
  loadTagsForEntities,
  filterEntityIdsByTags,
  parseTagIdsParam,
  replaceEntityTags,
} from '../lib/tags.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';
import { requirePermission, can } from '../lib/permissions.js';
import { deriveAggregateStatus, aggregateInputFromLoaded } from '../lib/aggregate_status.js';
import { orderBlock, reason as reasonB } from '../lib/blocked_action.js';
import { idempotencyMiddleware } from '../lib/idempotency.js';
import {
  createApprovalRequest,
  evaluateExtensionApproval,
  evaluateCancellationApproval,
  loadWorkspaceSettings,
} from '../lib/approvals.js';
import { applyExtensionEffects, applyCancellationEffects } from '../lib/order_actions.js';
import { emitCustomerNotification } from '../lib/notify.js';

// ============================================================================
// src/routes/orders.ts
// ----------------------------------------------------------------------------
// Sub-turn 1 scope:
//   * Create draft orders (customer + rental window)
//   * List / detail with filters
//   * Update draft
//   * Add / update / remove order items
//   * Advisory state transitions (draft -> quoted -> confirmed -> ...)
//   * Every mutation writes to order_events AND audit_events
//
// Explicitly NOT here yet (later sub-turns):
//   * Pricing engine — Sub-turn 2 (src/lib/pricing.ts)
//   * Payment endpoints — Sub-turn 2
//   * Invoice generation — Sub-turn 2
//   * OTP handover, dispatch, return — Sub-turn 3
//   * Availability endpoint — separate file src/routes/availability.ts
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

export const orders = new Hono<Env>();
orders.use('*', sessionMiddleware, requireAuth);
// Slice 1 — idempotency for mutating routes (enforced-when-present; GET exempt).
// Runs after the session is established so it can scope records by workspace+user.
orders.use('*', idempotencyMiddleware);

// ----------------------------------------------------------------------------
// State machine (advisory — recorded, not enforced)
// ----------------------------------------------------------------------------
// Non-canonical jumps are allowed with { force: true } and logged distinctly.
// This matches rental reality: walk-ins skip quotes, repeat customers skip
// confirmation, B2B negotiations bounce back and forth. Enforcement can be
// flipped on later via workspace.settings without a schema change.

const ORDER_STATUSES = [
  'draft', 'quoted', 'confirmed', 'dispatched',
  'active', 'returned', 'closed', 'cancelled',
] as const;
type OrderStatus = typeof ORDER_STATUSES[number];

const CANONICAL_NEXT: Record<OrderStatus, OrderStatus[]> = {
  draft:      ['quoted', 'confirmed', 'cancelled'],
  quoted:     ['confirmed', 'draft', 'cancelled'],
  confirmed:  ['dispatched', 'cancelled'],
  dispatched: ['returned', 'active'],
  active:     ['returned'],
  returned:   ['closed'],
  closed:     [],
  cancelled:  [],
};

function isCanonical(from: OrderStatus, to: OrderStatus): boolean {
  return CANONICAL_NEXT[from]?.includes(to) ?? false;
}

const ITEM_TYPES = [
  'rental', 'delivery_fee', 'late_fee', 'damage',
  'discount', 'tax', 'deposit', 'other',
] as const;

const DISPATCH_TYPES = ['pickup', 'delivery'] as const;
const CHANNELS = ['walk_in', 'planned', 'whatsapp', 'phone', 'other'] as const;

// ----------------------------------------------------------------------------
// Item-level status machine (advisory — mirrors order.status)
// ----------------------------------------------------------------------------
// pending_dispatch is initial; the last four are terminal; dispatched is a
// non-terminal middle state. Non-canonical jumps require { force: true }.
const ITEM_STATUSES = [
  'pending_dispatch',
  'dispatched',
  'returned',
  'returned_with_damage',
  'not_returned_chargeable',
  'not_returned_non_chargeable',
  'missing',
] as const;
type OrderItemStatus = typeof ITEM_STATUSES[number];

const CANONICAL_ITEM_TRANSITIONS: Record<OrderItemStatus, OrderItemStatus[]> = {
  pending_dispatch:            ['dispatched', 'not_returned_non_chargeable', 'missing'],
  dispatched:                  ['returned', 'returned_with_damage', 'not_returned_chargeable', 'missing'],
  returned:                    ['returned_with_damage'],   // damage discovered post-return
  returned_with_damage:        [],
  not_returned_chargeable:     ['returned'],               // customer eventually returns it
  not_returned_non_chargeable: ['returned'],               // customer eventually returns it
  missing:                     ['returned'],               // recovered
};

const TERMINAL_ITEM_STATUSES: readonly OrderItemStatus[] = [
  'returned',
  'returned_with_damage',
  'not_returned_chargeable',
  'not_returned_non_chargeable',
  'missing',
];

function isCanonicalItem(from: OrderItemStatus, to: OrderItemStatus): boolean {
  return CANONICAL_ITEM_TRANSITIONS[from]?.includes(to) ?? false;
}

// Computed on read — an order can finalize only when every item is terminal.
function deriveCanFinalize(items: OrderItemRow[]): boolean {
  if (items.length === 0) return false; // empty order can't finalize
  return items.every((item) =>
    (TERMINAL_ITEM_STATUSES as readonly string[]).includes(item.status),
  );
}

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

type OrderRow = {
  id: string;
  workspace_id: string;
  order_number: number;
  customer_person_id: string;
  status: OrderStatus;
  rental_start: string | null;
  rental_end: string | null;
  dispatch_type: string;
  delivery_address: string | null;
  channel: string;
  pickup_location_id: string;
  return_location_id: string;
  pickup_location_name?: string | null;
  subtotal_paise: number;
  tax_paise: number;
  discount_paise: number;
  total_paise: number;
  deposit_paise: number;
  paid_paise: number;
  balance_paise: number;
  deposit_required_paise: number;
  deposit_status: string;
  notes: string | null;
  internal_notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string | null;
  is_late?: boolean;
};

type OrderItemRow = {
  id: string;
  order_id: string;
  workspace_id: string;
  parent_item_id: string | null;
  item_type: string;
  product_id: string | null;
  description: string;
  quantity: number;
  daily_rate_paise: number | null;
  billable_days: number | null;
  unit_amount_paise: number;
  total_amount_paise: number;
  manual_price: boolean;
  status: OrderItemStatus;
  dispatched_at: string | null;
  returned_at: string | null;
  condition_notes: string | null;
  handed_to: string | null;
  received_by_user_id: string | null;
  dispatch_notes: string | null;
  received_by_name?: string | null;
  returned_by_user_id: string | null;
  returned_from: string | null;
  returned_by_name?: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  product_name?: string | null;
  product_sku?: string | null;
};

async function nextOrderNumber(workspaceId: string): Promise<number> {
  // Atomic: bump the counter and return the value we consumed.
  const rows = await query<{ n: number }>(sql`
    UPDATE workspaces
       SET next_order_number = next_order_number + 1
     WHERE id = ${workspaceId}
     RETURNING next_order_number - 1 AS n
  `);
  return Number(rows[0]!.n);
}

async function loadOrder(orderId: string, workspaceId: string) {
  const rows = await query<OrderRow>(sql`
    SELECT
      o.*,
      p.display_name AS customer_name,
      p.phone        AS customer_phone,
      p.email        AS customer_email,
      loc.name       AS pickup_location_name,
      (o.rental_end < now() AND EXISTS (
        SELECT 1 FROM order_items oi
        WHERE oi.order_id = o.id
          AND oi.workspace_id = o.workspace_id
          AND oi.status::text = 'dispatched'
      )) AS is_late
    FROM orders o
    JOIN people p ON p.id = o.customer_person_id
    LEFT JOIN locations loc ON loc.id = o.pickup_location_id
    WHERE o.id = ${orderId}
      AND o.workspace_id = ${workspaceId}
      AND o.deleted_at IS NULL
    LIMIT 1
  `);
  return rows[0] ?? null;
}

async function loadItems(orderId: string) {
  return await query<OrderItemRow>(sql`
    SELECT
      oi.*,
      pr.name AS product_name,
      pr.sku  AS product_sku,
      ru.display_name AS received_by_name,
      rt.display_name AS returned_by_name
    FROM order_items oi
    LEFT JOIN products pr ON pr.id = oi.product_id
    LEFT JOIN users ru ON ru.id = oi.received_by_user_id
    LEFT JOIN users rt ON rt.id = oi.returned_by_user_id
    WHERE oi.order_id = ${orderId}
    ORDER BY oi.sort_order ASC, oi.created_at ASC
  `);
}

// ============================================================================
// Physical object tracking (Sub-turn 12b) — MODULE_AUDIT findings 1, 2, 6
// ----------------------------------------------------------------------------
// Assignment (order_assets) is created at DISPATCH, never at reservation:
// availability reasons about order_items (capacity claims); WHICH specific unit
// goes out is decided at the counter. asset.status is written here and only in
// this file's dispatch/return flow — 'out' on dispatch, back to 'available' or
// 'retired' on return per the outcome table. Every physical write folds into the
// batch order_event + audit payload (per-asset audit rows would be noise; the
// repo convention is one batch row carrying the detail — see the dispatch
// handler's own comment).
// ============================================================================

type AssignedAsset = { asset_id: string; asset_code: string; item_id: string };

/** Physical units pinned to an order (order_assets), for the detail response. */
async function loadOrderAssets(orderId: string, workspaceId: string) {
  return await query<{
    id: string; order_item_id: string | null; asset_id: string;
    asset_code: string; status: string;
    dispatched_at: string | null; returned_at: string | null;
  }>(sql`
    SELECT oa.id, oa.order_item_id, oa.asset_id,
           a.asset_code, oa.status::text AS status,
           oa.dispatched_at, oa.returned_at
    FROM order_assets oa
    JOIN assets a ON a.id = oa.asset_id
    WHERE oa.order_id = ${orderId}::uuid
      AND oa.workspace_id = ${workspaceId}::uuid
    ORDER BY a.asset_code ASC
  `);
}

/** Pin physical units for one dispatched rental line: order_assets row +
 *  asset.status='out'. Tracked products only (bulk have no serialized units).
 *  Explicit ids are validated (in-workspace, right product, currently
 *  available); otherwise auto-assign available units at the pickup location up
 *  to the line quantity. Returns the units actually pinned (may be fewer than
 *  quantity if the product is short — the advisory model dispatches anyway). */
async function pinAssetsForItem(args: {
  workspaceId: string; orderId: string; itemId: string;
  productId: string; quantity: number;
  pickupLocationId: string | null;
  explicitAssetIds?: string[];
}): Promise<AssignedAsset[]> {
  const prodRows = await query<{ tracking_method: string | null; nature: string }>(sql`
    SELECT tracking_method::text AS tracking_method, nature::text AS nature FROM products
    WHERE id = ${args.productId}::uuid AND workspace_id = ${args.workspaceId}::uuid
    LIMIT 1
  `);
  if (!prodRows.length) return [];
  const nature = prodRows[0]!.nature;
  const isBulk = prodRows[0]!.tracking_method === 'bulk';

  // SERVICE: nothing physical to dispatch.
  if (nature === 'service') return [];

  // SALE — dispatch PERMANENTLY removes stock (Sub-turn 13). This is the ONLY
  // place the sale/rental behaviours diverge: a rental reserves and comes back;
  // a sale is decremented/retired and never returns.
  if (nature === 'sale') {
    if (isBulk) {
      // Decrement on-hand at the pickup location. Clamped at 0 (never negative).
      await sql`
        UPDATE stock_levels
           SET quantity = GREATEST(0, quantity - ${args.quantity}::int)
         WHERE product_id = ${args.productId}::uuid
           AND location_id = ${args.pickupLocationId}::uuid
      `;
      return [];
    }
    // Serialized sale: retire the units sold (status='retired' + soft-delete),
    // recording which units on order_assets. They never rejoin availability.
    const sold = await query<{ id: string; asset_code: string }>(sql`
      SELECT id, asset_code FROM assets
      WHERE workspace_id = ${args.workspaceId}::uuid
        AND product_id = ${args.productId}::uuid
        AND deleted_at IS NULL
        AND status = 'available'::asset_status
        AND (${args.pickupLocationId}::uuid IS NULL OR location_id = ${args.pickupLocationId}::uuid)
      ORDER BY asset_code ASC
      LIMIT ${args.quantity}::int
    `);
    const soldOut: AssignedAsset[] = [];
    for (const a of sold) {
      await sql`
        INSERT INTO order_assets (workspace_id, order_id, order_item_id, asset_id, status, dispatched_at)
        VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, ${args.itemId}::uuid,
                ${a.id}::uuid, 'dispatched'::order_asset_status, now())
        ON CONFLICT (order_id, asset_id) DO NOTHING
      `;
      await sql`
        UPDATE assets SET status = 'retired'::asset_status, deleted_at = now(), updated_at = now()
        WHERE id = ${a.id}::uuid AND workspace_id = ${args.workspaceId}::uuid
          AND status = 'available'::asset_status
      `;
      soldOut.push({ asset_id: a.id, asset_code: a.asset_code, item_id: args.itemId });
    }
    return soldOut;
  }

  // RENTAL: bulk has no serialized units to pin (the reservation blocks it).
  if (isBulk) return [];

  let chosen: { id: string; asset_code: string }[] = [];
  if (args.explicitAssetIds && args.explicitAssetIds.length) {
    const ids = [...new Set(args.explicitAssetIds)];
    chosen = await query<{ id: string; asset_code: string }>(sql`
      SELECT id, asset_code FROM assets
      WHERE workspace_id = ${args.workspaceId}::uuid
        AND product_id = ${args.productId}::uuid
        AND deleted_at IS NULL
        AND status = 'available'::asset_status
        AND id::text = ANY(string_to_array(${ids.join(',')}::text, ','))
      ORDER BY asset_code ASC
    `);
  } else {
    chosen = await query<{ id: string; asset_code: string }>(sql`
      SELECT id, asset_code FROM assets
      WHERE workspace_id = ${args.workspaceId}::uuid
        AND product_id = ${args.productId}::uuid
        AND deleted_at IS NULL
        AND status = 'available'::asset_status
        AND (${args.pickupLocationId}::uuid IS NULL OR location_id = ${args.pickupLocationId}::uuid)
      ORDER BY asset_code ASC
      LIMIT ${args.quantity}::int
    `);
  }

  const pinned: AssignedAsset[] = [];
  for (const a of chosen) {
    // Idempotent against races: skip a unit already on this order, and only flip
    // a still-available unit to 'out'.
    await sql`
      INSERT INTO order_assets (workspace_id, order_id, order_item_id, asset_id, status, dispatched_at)
      VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, ${args.itemId}::uuid,
              ${a.id}::uuid, 'dispatched'::order_asset_status, now())
      ON CONFLICT (order_id, asset_id) DO NOTHING
    `;
    await sql`
      UPDATE assets SET status = 'out'::asset_status, updated_at = now()
      WHERE id = ${a.id}::uuid AND workspace_id = ${args.workspaceId}::uuid
        AND status = 'available'::asset_status
    `;
    pinned.push({ asset_id: a.id, asset_code: a.asset_code, item_id: args.itemId });
  }
  return pinned;
}

type Disposition = { asset_id: string; asset_code: string; outcome: string; downtime_id: string | null };

/** Apply a return outcome to the physical units pinned to a line. OK →
 *  available; damaged → available + an auto-created asset-level repair downtime
 *  (capacity-1 for its window, so it doesn't rejoin availability until fixed);
 *  missing → retired (soft-deleted out of capacity). not_returned_* leaves the
 *  unit 'out' (still with the customer). Returns a summary for the batch audit. */
async function applyReturnDisposition(args: {
  workspaceId: string; orderId: string; orderNumber: number; itemId: string;
  outcome: string; actorUserId: string; repairDays: number;
}): Promise<Disposition[]> {
  const rows = await query<{ asset_id: string; asset_code: string }>(sql`
    SELECT oa.asset_id, a.asset_code
    FROM order_assets oa JOIN assets a ON a.id = oa.asset_id
    WHERE oa.order_id = ${args.orderId}::uuid
      AND oa.order_item_id = ${args.itemId}::uuid
      AND oa.workspace_id = ${args.workspaceId}::uuid
      AND oa.status = 'dispatched'::order_asset_status
  `);

  const out: Disposition[] = [];
  for (const r of rows) {
    let oaStatus: string;
    let downtimeId: string | null = null;

    if (args.outcome === 'returned') {
      oaStatus = 'returned';
      await sql`
        UPDATE assets SET status = 'available'::asset_status, updated_at = now()
        WHERE id = ${r.asset_id}::uuid AND workspace_id = ${args.workspaceId}::uuid
      `;
    } else if (args.outcome === 'returned_with_damage') {
      oaStatus = 'damaged';
      await sql`
        UPDATE assets SET status = 'available'::asset_status, updated_at = now()
        WHERE id = ${r.asset_id}::uuid AND workspace_id = ${args.workspaceId}::uuid
      `;
      const dt = await query<{ id: string }>(sql`
        INSERT INTO product_downtimes
          (workspace_id, asset_id, kind, status, start_at, end_at, reason, order_id, created_by_user_id)
        VALUES (
          ${args.workspaceId}::uuid, ${r.asset_id}::uuid,
          'repair'::downtime_reason, 'scheduled'::downtime_status,
          now(), now() + make_interval(days => ${args.repairDays}::int),
          ${`Damage on return (order #${args.orderNumber})`}::text,
          ${args.orderId}::uuid, ${args.actorUserId}::uuid
        )
        RETURNING id
      `);
      downtimeId = dt[0]?.id ?? null;
    } else if (args.outcome === 'missing') {
      oaStatus = 'lost';
      // Retired = status 'retired' AND soft-deleted (CLAUDE.md), out of capacity.
      await sql`
        UPDATE assets SET status = 'retired'::asset_status, deleted_at = now(), updated_at = now()
        WHERE id = ${r.asset_id}::uuid AND workspace_id = ${args.workspaceId}::uuid
      `;
    } else {
      // not_returned_chargeable / not_returned_non_chargeable: the unit is still
      // physically with the customer. Leave it 'out' and its order_assets row
      // 'dispatched' — the line keeps reserving (RESERVING_ITEM_STATUSES).
      continue;
    }

    await sql`
      UPDATE order_assets
        SET status = ${oaStatus}::order_asset_status, returned_at = now(), updated_at = now()
      WHERE order_id = ${args.orderId}::uuid AND asset_id = ${r.asset_id}::uuid
        AND workspace_id = ${args.workspaceId}::uuid
    `;
    out.push({ asset_id: r.asset_id, asset_code: r.asset_code, outcome: oaStatus, downtime_id: downtimeId });
  }
  return out;
}

async function loadEvents(orderId: string) {
  return await query<{
    id: string; event_type: string;
    from_status: string | null; to_status: string | null;
    payload: unknown; occurred_at: string;
    actor_name: string | null;
  }>(sql`
    SELECT
      oe.id, oe.event_type, oe.from_status::text AS from_status,
      oe.to_status::text AS to_status,
      oe.payload, oe.occurred_at,
      u.display_name AS actor_name
    FROM order_events oe
    LEFT JOIN users u ON u.id = oe.actor_user_id
    WHERE oe.order_id = ${orderId}
    ORDER BY oe.occurred_at DESC
    LIMIT 200
  `);
}

async function recordOrderEvent(input: {
  workspaceId: string;
  orderId: string;
  eventType: string;
  fromStatus?: OrderStatus | null;
  toStatus?: OrderStatus | null;
  payload?: Record<string, unknown>;
  actorUserId: string;
}): Promise<string | null> {
  const rows = await query<{ id: string }>(sql`
    INSERT INTO order_events
      (workspace_id, order_id, event_type, from_status, to_status, payload, actor_user_id)
    VALUES (
      ${input.workspaceId},
      ${input.orderId},
      ${input.eventType},
      ${input.fromStatus ?? null}::order_status,
      ${input.toStatus ?? null}::order_status,
      ${JSON.stringify(input.payload ?? {})}::jsonb,
      ${input.actorUserId}
    )
    RETURNING id
  `);
  return rows[0]?.id ?? null;
}

// ============================================================================
// GET /api/orders — list with search, filters, sort, pagination
// ----------------------------------------------------------------------------
// Server-side everything so the list stays usable past a handful of orders.
// Response shape: { orders, pagination, filters_applied }.
//
// SQL discipline (per CLAUDE.md + the Neon HTTP driver's quirks):
//   * Predicates are null-guarded inline params — the driver can't nest sql
//     fragments, so we keep one static template and toggle each clause on a
//     param being NULL.
//   * Multi-status uses string_to_array(<csv>, ',') → text[] built DB-side,
//     compared as o.status::text = ANY(...). No JS-array→enum[] cast (banned).
//   * Sort is a Zod-validated enum mapped to a CASE-per-key ORDER BY; only the
//     matching key yields non-null values, the rest sort as all-NULL no-ops.
//     created_at DESC is the final stable tiebreaker.
// ============================================================================
const LIST_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const listDateParam = z.string().refine(
  (v) => LIST_DATE_ONLY.test(v) || !Number.isNaN(Date.parse(v)),
  { message: 'must be YYYY-MM-DD or an ISO datetime' },
);

const listQuerySchema = z.object({
  q: z.string().max(200).optional(),
  status: z.string().max(200).optional(), // comma-separated
  from: listDateParam.optional(),
  to: listDateParam.optional(),
  sort: z.enum([
    'created_at_desc', 'created_at_asc',
    'rental_start_asc', 'rental_start_desc',
    'order_number_desc',
    'total_paise_desc',
  ]).default('created_at_desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  late_only: z.coerce.boolean().default(false),
});

orders.get('/', async (c) => {
  const session = c.get('session')!;

  const parsed = listQuerySchema.safeParse({
    q: c.req.query('q'),
    status: c.req.query('status'),
    from: c.req.query('from'),
    to: c.req.query('to'),
    sort: c.req.query('sort'),
    page: c.req.query('page'),
    limit: c.req.query('limit'),
    late_only: c.req.query('late_only'),
  });
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const qp = parsed.data;
  const lateOnly = qp.late_only;

  // Status: comma-separated → validated array. Any unknown enum value is a 400.
  let statusArr: string[] = [];
  if (qp.status && qp.status.trim()) {
    statusArr = qp.status.split(',').map((s) => s.trim()).filter(Boolean);
    for (const s of statusArr) {
      if (!(ORDER_STATUSES as readonly string[]).includes(s)) {
        return c.json({ error: 'invalid_request', reason: 'unknown_status', value: s }, 400);
      }
    }
  }
  const statusCsv = statusArr.length ? statusArr.join(',') : null;

  const q = qp.q?.trim() || null;
  const searchPattern = q ? `%${q}%` : null;

  // Date-only inputs bracket the whole day so `to` stays inclusive.
  const fromNorm = qp.from
    ? (LIST_DATE_ONLY.test(qp.from) ? qp.from + 'T00:00:00.000Z' : qp.from)
    : null;
  const toNorm = qp.to
    ? (LIST_DATE_ONLY.test(qp.to) ? qp.to + 'T23:59:59.999Z' : qp.to)
    : null;

  const limit = qp.limit;
  const offset = (qp.page - 1) * limit;
  const sort = qp.sort;

  // Tag filter (Sub-turn 8a) — AND semantics, resolved to matching order ids.
  const tagIds = parseTagIdsParam(c.req.queries('tag_ids'));
  let tagMatchCsv: string | null = null;
  if (tagIds.length) {
    const ids = await filterEntityIdsByTags(session.workspace.id, 'order', tagIds);
    if (ids.length === 0) {
      return c.json({
        orders: [],
        pagination: { page: qp.page, limit, total: 0, total_pages: 0 },
        filters_applied: { q, status: statusArr, from: fromNorm, to: toNorm, sort, late_only: lateOnly, tag_ids: tagIds },
      });
    }
    tagMatchCsv = ids.join(',');
  }

  const rows = await query<OrderRow>(sql`
    SELECT
      o.id, o.workspace_id, o.order_number, o.customer_person_id, o.status,
      o.rental_start, o.rental_end, o.dispatch_type, o.delivery_address,
      o.channel,
      o.subtotal_paise, o.tax_paise, o.discount_paise, o.total_paise,
      o.deposit_paise, o.paid_paise, o.balance_paise,
      o.deposit_required_paise, o.deposit_status,
      o.notes, o.internal_notes, o.created_by,
      o.created_at, o.updated_at, o.deleted_at,
      p.display_name AS customer_name,
      p.phone        AS customer_phone,
      (o.rental_end < now() AND EXISTS (
        SELECT 1 FROM order_items oi
        WHERE oi.order_id = o.id
          AND oi.workspace_id = o.workspace_id
          AND oi.status::text = 'dispatched'
      )) AS is_late,
      -- Slice 1 — per-order item-status counts for aggregate_status derivation.
      ic.total_rental, ic.pending_dispatch, ic.dispatched_cnt, ic.returned_cnt, ic.terminal_cnt,
      ic.item_count,
      EXISTS (SELECT 1 FROM order_assets oa
              WHERE oa.order_id = o.id AND oa.workspace_id = o.workspace_id) AS has_assets,
      COUNT(*) OVER()::int AS full_total
    FROM orders o
    JOIN people p ON p.id = o.customer_person_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS item_count,
        COUNT(*) FILTER (WHERE oi.item_type = 'rental')::int AS total_rental,
        COUNT(*) FILTER (WHERE oi.item_type = 'rental' AND oi.status::text = 'pending_dispatch')::int AS pending_dispatch,
        COUNT(*) FILTER (WHERE oi.item_type = 'rental' AND oi.status::text = 'dispatched')::int AS dispatched_cnt,
        COUNT(*) FILTER (WHERE oi.item_type = 'rental' AND oi.status::text IN ('returned','returned_with_damage'))::int AS returned_cnt,
        COUNT(*) FILTER (WHERE oi.item_type = 'rental' AND oi.status::text IN ('returned','returned_with_damage','not_returned_chargeable','not_returned_non_chargeable','missing'))::int AS terminal_cnt
      FROM order_items oi
      WHERE oi.order_id = o.id AND oi.workspace_id = o.workspace_id
    ) ic ON true
    WHERE o.workspace_id = ${session.workspace.id}
      AND o.deleted_at IS NULL
      AND (${statusCsv}::text IS NULL
           OR o.status::text = ANY(string_to_array(${statusCsv}::text, ',')))
      AND (${searchPattern}::text IS NULL
           OR p.display_name ILIKE ${searchPattern}::text
           OR CAST(o.order_number AS text) ILIKE ${searchPattern}::text)
      AND (${fromNorm}::timestamptz IS NULL OR o.rental_start >= ${fromNorm}::timestamptz)
      AND (${toNorm}::timestamptz   IS NULL OR o.rental_start <= ${toNorm}::timestamptz)
      AND (${lateOnly}::boolean = false OR (
        o.rental_end < now() AND EXISTS (
          SELECT 1 FROM order_items oi
          WHERE oi.order_id = o.id
            AND oi.workspace_id = o.workspace_id
            AND oi.status::text = 'dispatched'
        )
      ))
      AND (${tagMatchCsv}::text IS NULL
           OR o.id = ANY(string_to_array(${tagMatchCsv}::text, ',')::uuid[]))
    ORDER BY
      (CASE WHEN ${sort}::text = 'created_at_desc'   THEN o.created_at   END) DESC NULLS LAST,
      (CASE WHEN ${sort}::text = 'created_at_asc'    THEN o.created_at   END) ASC  NULLS LAST,
      (CASE WHEN ${sort}::text = 'rental_start_asc'  THEN o.rental_start END) ASC  NULLS LAST,
      (CASE WHEN ${sort}::text = 'rental_start_desc' THEN o.rental_start END) DESC NULLS LAST,
      (CASE WHEN ${sort}::text = 'order_number_desc' THEN o.order_number END) DESC NULLS LAST,
      (CASE WHEN ${sort}::text = 'total_paise_desc'  THEN o.total_paise  END) DESC NULLS LAST,
      o.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  // Total comes from the COUNT(*) OVER() window in the rows query (evaluated
  // before LIMIT/OFFSET), collapsing the old separate count round trip — and
  // removing the drift hazard of maintaining the WHERE block twice (perf audit
  // F3). Sole gap: a page beyond the end returns zero rows, so the window
  // value is unavailable — fall back to a real count on that rare path so the
  // frontend's pagination totals stay exact.
  let total: number;
  if (rows.length > 0) {
    total = Number((rows[0] as unknown as { full_total: number }).full_total);
  } else if (offset > 0) {
    const counted = await query<{ total: number }>(sql`
      SELECT COUNT(*)::int AS total
      FROM orders o
      JOIN people p ON p.id = o.customer_person_id
      WHERE o.workspace_id = ${session.workspace.id}
        AND o.deleted_at IS NULL
        AND (${statusCsv}::text IS NULL
             OR o.status::text = ANY(string_to_array(${statusCsv}::text, ',')))
        AND (${searchPattern}::text IS NULL
             OR p.display_name ILIKE ${searchPattern}::text
             OR CAST(o.order_number AS text) ILIKE ${searchPattern}::text)
        AND (${fromNorm}::timestamptz IS NULL OR o.rental_start >= ${fromNorm}::timestamptz)
        AND (${toNorm}::timestamptz   IS NULL OR o.rental_start <= ${toNorm}::timestamptz)
        AND (${lateOnly}::boolean = false OR (
          o.rental_end < now() AND EXISTS (
            SELECT 1 FROM order_items oi
            WHERE oi.order_id = o.id
              AND oi.workspace_id = o.workspace_id
              AND oi.status::text = 'dispatched'
          )
        ))
        AND (${tagMatchCsv}::text IS NULL
             OR o.id = ANY(string_to_array(${tagMatchCsv}::text, ',')::uuid[]))
    `);
    total = counted[0]?.total ?? 0;
  } else {
    total = 0;
  }
  // The window count is a per-row artefact — strip it from the payload.
  for (const r of rows) delete (r as Partial<{ full_total: number }>).full_total;
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

  // Slice 1 — derive aggregate_status per row from the LATERAL counts, then strip
  // the raw count columns (keep item_count, which the list UI shows).
  type CountedRow = OrderRow & {
    total_rental: number; pending_dispatch: number; dispatched_cnt: number;
    returned_cnt: number; terminal_cnt: number; has_assets: boolean; item_count: number;
    aggregate_status?: string; aggregate_status_context?: unknown;
  };
  for (const r of rows as CountedRow[]) {
    const agg = deriveAggregateStatus({
      order_status: r.status,
      total_rental: Number(r.total_rental ?? 0),
      pending_dispatch: Number(r.pending_dispatch ?? 0),
      dispatched: Number(r.dispatched_cnt ?? 0),
      returned: Number(r.returned_cnt ?? 0),
      terminal: Number(r.terminal_cnt ?? 0),
      has_assets: !!r.has_assets,
      payment_complete: Number(r.balance_paise ?? 0) <= 0,
    });
    r.aggregate_status = agg.aggregate_status;
    r.aggregate_status_context = agg.aggregate_status_context;
    delete (r as Partial<CountedRow>).total_rental;
    delete (r as Partial<CountedRow>).pending_dispatch;
    delete (r as Partial<CountedRow>).dispatched_cnt;
    delete (r as Partial<CountedRow>).returned_cnt;
    delete (r as Partial<CountedRow>).terminal_cnt;
    delete (r as Partial<CountedRow>).has_assets;
  }

  // Batch-load tag chips for this page (Sub-turn 8a).
  const tagMap = await loadTagsForEntities(session.workspace.id, 'order', rows.map((r) => r.id));
  for (const r of rows) (r as OrderRow & { tags: unknown }).tags = tagMap.get(r.id) ?? [];

  return c.json({
    orders: rows,
    pagination: { page: qp.page, limit, total, total_pages: totalPages },
    filters_applied: {
      q,
      status: statusArr,
      from: fromNorm,
      to: toNorm,
      sort,
      late_only: lateOnly,
      tag_ids: tagIds,
    },
  });
});

// ============================================================================
// GET /api/orders/:id — detail with items + timeline
// ============================================================================
orders.get('/:id', async (c) => {
  const session = c.get('session')!;
  const id = c.req.param('id');

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);

  const [items, events, customFields, tags, redemption] = await Promise.all([
    loadItems(id),
    loadEvents(id),
    loadCustomFieldValues(session.workspace.id, 'order', id),
    loadTagsForEntity(session.workspace.id, 'order', id),
    // Active coupon redemption (Sub-turn 8b), if any.
    query<{
      id: string; discount_paise_applied: number; applied_at: string;
      code: string; discount_type: string; discount_value: number; description: string | null;
    }>(sql`
      SELECT cr.id, cr.discount_paise_applied, cr.applied_at,
             c.code, c.discount_type, c.discount_value, c.description
      FROM coupon_redemptions cr
      JOIN coupons c ON c.id = cr.coupon_id
      WHERE cr.order_id = ${id}::uuid AND cr.workspace_id = ${session.workspace.id}::uuid
        AND cr.removed_at IS NULL
      LIMIT 1
    `),
  ]);

  const canFinalize = deriveCanFinalize(items);
  // Physical units pinned to this order (Sub-turn 12b) — empty until dispatch.
  const orderAssets = await loadOrderAssets(id, session.workspace.id);
  // Slice 1 — aggregate status derived from item micro-lifecycle counts.
  const aggregate = deriveAggregateStatus(
    aggregateInputFromLoaded(order, items as { item_type: string; status: string }[], orderAssets.length > 0),
  );

  // Sub-slice 2.1 — extensions, cancellation, pending approvals, enriched customer.
  const [extensions, cancellationRows, activeApprovals, custEnrich] = await Promise.all([
    query(sql`
      SELECT e.id, e.extension_number, e.original_rental_end_at, e.new_rental_end_at, e.additional_days,
             e.additional_charges_paise, e.reason_tag, e.reason_notes, e.status, e.requires_approval,
             e.approval_request_id, e.requested_at, e.approved_at, e.had_conflict,
             ru.display_name AS requested_by_name
      FROM order_extensions e
      LEFT JOIN users ru ON ru.id = e.requested_by_user_id
      WHERE e.order_id = ${id}::uuid AND e.workspace_id = ${session.workspace.id}::uuid
      ORDER BY e.extension_number ASC
    `),
    query(sql`
      SELECT ca.id, ca.reason_tag, ca.reason_notes, ca.status, ca.original_amount_paise,
             ca.refund_amount_paise, ca.forfeit_amount_paise, ca.deposit_refunded_paise,
             ca.deposit_forfeited_paise, ca.requires_approval, ca.approval_request_id,
             ca.refund_initiated_at, ca.refund_expected_credit_by, ca.requested_at, ca.confirmed_at,
             ru.display_name AS requested_by_name
      FROM order_cancellations ca
      LEFT JOIN users ru ON ru.id = ca.requested_by_user_id
      WHERE ca.order_id = ${id}::uuid AND ca.workspace_id = ${session.workspace.id}::uuid
      LIMIT 1
    `),
    query(sql`
      SELECT ar.id, ar.resource_type, ar.resource_id, ar.approver_role_required, ar.status,
             ar.requested_at, ar.request_reason_tag, ru.display_name AS requester_name
      FROM approval_requests ar
      LEFT JOIN users ru ON ru.id = ar.requester_user_id
      WHERE ar.order_id = ${id}::uuid AND ar.workspace_id = ${session.workspace.id}::uuid
        AND ar.status = 'pending'
      ORDER BY ar.requested_at DESC
    `),
    query<{ tier: string | null; trust_score: number | null; prior_completed: number; outstanding_paise: number }>(sql`
      SELECT p.tier, p.trust_score,
        (SELECT COUNT(*)::int FROM orders o2
           WHERE o2.workspace_id = p.workspace_id AND o2.customer_person_id = p.id
             AND o2.id != ${id}::uuid AND o2.status::text IN ('confirmed','dispatched','active','returned','closed')
        ) AS prior_completed,
        COALESCE((SELECT SUM(o3.balance_paise)::bigint FROM orders o3
           WHERE o3.workspace_id = p.workspace_id AND o3.customer_person_id = p.id
             AND o3.deleted_at IS NULL AND o3.status::text NOT IN ('cancelled','draft')
        ), 0) AS outstanding_paise
      FROM people p
      WHERE p.id = ${order.customer_person_id}::uuid AND p.workspace_id = ${session.workspace.id}::uuid
      LIMIT 1
    `),
  ]);

  // Customer segment: vip tier wins; else repeat when they have prior completed
  // orders; else new. kyc_status / credit_limit have no columns yet → null (the
  // 360 renders gracefully without them).
  const ce = custEnrich[0];
  const segment = ce
    ? (ce.tier === 'vip' ? 'vip' : Number(ce.prior_completed) > 0 ? 'repeat' : 'new')
    : null;
  const customer = {
    id: order.customer_person_id,
    name: order.customer_name ?? null,
    phone: order.customer_phone ?? null,
    email: order.customer_email ?? null,
    kyc_status: null as string | null,
    trust_score: ce?.trust_score ?? null,
    tier: ce?.tier ?? null,
    segment,
    credit_limit_paise: null as number | null,
    outstanding_paise: Number(ce?.outstanding_paise ?? 0),
  };

  return c.json({
    order, items, events, can_finalize: canFinalize, custom_fields: customFields, tags,
    coupon_redemption: redemption[0] ?? null,
    assets: orderAssets,
    aggregate_status: aggregate.aggregate_status,
    aggregate_status_context: aggregate.aggregate_status_context,
    extensions,
    cancellation: cancellationRows[0] ?? null,
    active_approvals: activeApprovals,
    customer,
  });
});

// ============================================================================
// POST /api/orders — create a draft
// ============================================================================
const createSchema = z.object({
  customer_person_id: z.string().uuid(),
  rental_start:       z.string().datetime().optional(),
  rental_end:         z.string().datetime().optional(),
  dispatch_type:      z.enum(DISPATCH_TYPES).default('pickup'),
  delivery_address:   z.string().max(500).optional(),
  channel:            z.enum(CHANNELS).default('planned'),
  notes:              z.string().max(2000).optional(),
  internal_notes:     z.string().max(2000).optional(),
  // Sub-turn 6i — pickup location. Phase 1 forces return == pickup, so we only
  // take one id; omitted falls back to the workspace default location.
  pickup_location_id: z.string().uuid().optional(),
});

/** Resolve + validate an order's location (Sub-turn 6i). Falls back to the
 *  workspace default when none is given. Returns the active, in-workspace
 *  location id, or an error code the caller maps to a 400/404. */
async function resolveOrderLocation(
  workspaceId: string,
  locationId: string | undefined,
): Promise<{ id: string } | { error: string }> {
  if (!locationId) {
    const def = await getDefaultLocationId(workspaceId);
    if (!def) return { error: 'no_default_location' };
    return { id: def };
  }
  const rows = await query<{ id: string; is_active: boolean }>(sql`
    SELECT id, is_active FROM locations
    WHERE id = ${locationId}::uuid AND workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `);
  if (!rows.length) return { error: 'location_not_found' };
  if (!rows[0]!.is_active) return { error: 'location_inactive' };
  return { id: rows[0]!.id };
}

orders.post('/', requirePermission('orders.create'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);

  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  // Verify customer belongs to workspace.
  const customer = await query<{ id: string; display_name: string }>(sql`
    SELECT id, display_name FROM people
    WHERE id = ${input.customer_person_id}
      AND workspace_id = ${session.workspace.id}
      AND deleted_at IS NULL
    LIMIT 1
  `);
  if (customer.length === 0) {
    return c.json({ error: 'customer_not_found' }, 404);
  }

  if (input.rental_start && input.rental_end &&
      new Date(input.rental_end) <= new Date(input.rental_start)) {
    return c.json({ error: 'invalid_request', reason: 'end_before_start' }, 400);
  }

  // Resolve the pickup location (Phase 1: return == pickup).
  const loc = await resolveOrderLocation(session.workspace.id, input.pickup_location_id);
  if ('error' in loc) {
    const status = loc.error === 'location_not_found' ? 404 : 400;
    return c.json({ error: loc.error }, status);
  }

  const orderNumber = await nextOrderNumber(session.workspace.id);

  const inserted = await query<OrderRow>(sql`
    INSERT INTO orders (
      workspace_id, order_number, customer_person_id, status,
      rental_start, rental_end, dispatch_type, delivery_address,
      channel, notes, internal_notes,
      pickup_location_id, return_location_id, created_by
    ) VALUES (
      ${session.workspace.id},
      ${orderNumber},
      ${input.customer_person_id},
      'draft'::order_status,
      ${input.rental_start ?? null}::timestamptz,
      ${input.rental_end   ?? null}::timestamptz,
      ${input.dispatch_type}::text,
      ${input.delivery_address ?? null},
      ${input.channel}::text,
      ${input.notes ?? null},
      ${input.internal_notes ?? null},
      ${loc.id}::uuid,
      ${loc.id}::uuid,
      ${session.user.id}
    )
    RETURNING *
  `);

  const order = inserted[0]!;

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: order.id,
    eventType: 'order.created',
    toStatus: 'draft',
    payload: {
      order_number: order.order_number,
      customer_name: customer[0]!.display_name,
      channel: order.channel,
    },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.order.created',
    targetType: 'order',
    targetId: order.id,
    payload: { order_number: order.order_number },
    ipAddress, userAgent,
  });

  emitNotification({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'order.created',
    targetType: 'order', targetId: order.id,
    linkUrl: `/order.html?id=${order.id}`,
    metadata: { order_number: order.order_number, customer_name: customer[0]!.display_name },
  }).catch(() => {});

  return c.json({ order }, 201);
});

// ============================================================================
// PATCH /api/orders/:id — update non-terminal order (COALESCE pattern)
// ============================================================================
const updateSchema = z.object({
  customer_person_id: z.string().uuid().optional(),
  rental_start:       z.string().datetime().optional(),
  rental_end:         z.string().datetime().optional(),
  dispatch_type:      z.enum(DISPATCH_TYPES).optional(),
  delivery_address:   z.string().max(500).optional(),
  channel:            z.enum(CHANNELS).optional(),
  notes:              z.string().max(2000).optional(),
  internal_notes:     z.string().max(2000).optional(),
  pickup_location_id: z.string().uuid().optional(),
  custom_fields:      z.array(z.object({ definition_id: z.string().uuid(), value: z.string().nullable() })).optional(),
  tag_ids:            z.array(z.string().uuid()).optional(), // Sub-turn 8a — replace-all
});

orders.patch('/:id', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const p = parsed.data;

  const before = await loadOrder(id, session.workspace.id);
  if (!before) return c.json({ error: 'not_found' }, 404);
  if (before.status === 'closed' || before.status === 'cancelled') {
    return c.json({ error: 'locked', reason: `status_${before.status}` }, 409);
  }

  // Customer swap only on drafts.
  if (p.customer_person_id && before.status !== 'draft') {
    return c.json({ error: 'customer_locked_after_draft' }, 409);
  }
  if (p.customer_person_id) {
    const check = await query<{ id: string }>(sql`
      SELECT id FROM people
      WHERE id = ${p.customer_person_id}
        AND workspace_id = ${session.workspace.id}
        AND deleted_at IS NULL
      LIMIT 1
    `);
    if (check.length === 0) return c.json({ error: 'customer_not_found' }, 404);
  }

  // Location change only on drafts — moving it after commitment would shift the
  // per-location reservation out from under dispatched gear (Sub-turn 6i).
  let resolvedLocationId: string | null = null;
  if (p.pickup_location_id) {
    if (before.status !== 'draft') {
      return c.json({ error: 'location_locked_after_draft' }, 409);
    }
    const loc = await resolveOrderLocation(session.workspace.id, p.pickup_location_id);
    if ('error' in loc) {
      const status = loc.error === 'location_not_found' ? 404 : 400;
      return c.json({ error: loc.error }, status);
    }
    resolvedLocationId = loc.id;
  }

  // Cross-field validation with merged values.
  const nextStart = p.rental_start ?? before.rental_start;
  const nextEnd   = p.rental_end   ?? before.rental_end;
  if (nextStart && nextEnd && new Date(nextEnd) <= new Date(nextStart)) {
    return c.json({ error: 'invalid_request', reason: 'end_before_start' }, 400);
  }

  const updated = await query<OrderRow>(sql`
    UPDATE orders SET
      customer_person_id = COALESCE(${p.customer_person_id ?? null}::uuid,        customer_person_id),
      rental_start       = COALESCE(${p.rental_start       ?? null}::timestamptz, rental_start),
      rental_end         = COALESCE(${p.rental_end         ?? null}::timestamptz, rental_end),
      dispatch_type      = COALESCE(${p.dispatch_type      ?? null}::text,        dispatch_type),
      delivery_address   = COALESCE(${p.delivery_address   ?? null}::text,        delivery_address),
      channel            = COALESCE(${p.channel            ?? null}::text,        channel),
      notes              = COALESCE(${p.notes              ?? null}::text,        notes),
      internal_notes     = COALESCE(${p.internal_notes     ?? null}::text,        internal_notes),
      pickup_location_id = COALESCE(${resolvedLocationId ?? null}::uuid,          pickup_location_id),
      return_location_id = COALESCE(${resolvedLocationId ?? null}::uuid,          return_location_id),
      updated_at         = now()
    WHERE id = ${id}
      AND workspace_id = ${session.workspace.id}
    RETURNING *
  `);

  if (updated.length === 0) return c.json({ error: 'not_found' }, 404);
  const changedFields = Object.keys(p);

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: 'order.updated',
    fromStatus: before.status,
    toStatus: before.status,
    payload: { fields: changedFields },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.order.updated',
    targetType: 'order',
    targetId: id,
    payload: { fields: changedFields },
    ipAddress, userAgent,
  });

  // Custom field values (Sub-turn 6g) — accepted inline to save a roundtrip.
  if (p.custom_fields) {
    await upsertCustomFieldValues({
      workspaceId: session.workspace.id, entityType: 'order', entityId: id,
      actorUserId: session.user.id, values: p.custom_fields,
    });
  }

  // Tag assignments (Sub-turn 8a) — replace-all when provided inline.
  if (p.tag_ids) {
    await replaceEntityTags(session.workspace.id, 'order', id, session.user.id, p.tag_ids);
  }

  // Moving the rental window changes billable days -> recompute rental pricing.
  const windowMoved =
    updated[0]!.rental_start !== before.rental_start ||
    updated[0]!.rental_end !== before.rental_end;
  if (windowMoved) {
    const { order } = await recomputeOrderTotals(id, session.workspace.id, session.user.id);
    return c.json({ order });
  }

  return c.json({ order: updated[0] });
});

// ============================================================================
// POST /api/orders/:id/items — add a line item
// ============================================================================
const addItemSchema = z.object({
  item_type:         z.enum(ITEM_TYPES),
  product_id:        z.string().uuid().optional(),
  parent_item_id:    z.string().uuid().optional(),
  description:       z.string().min(1).max(500),
  quantity:          z.number().int().positive().default(1),
  // Sub-turn 13-0: for a RENTAL line the SERVER computes the rate from the
  // product — a client-supplied unit_amount_paise/daily_rate_paise is ignored
  // (and billable_days always comes from the order window via recompute).
  // Non-rental lines (delivery_fee, damage, other, …) are operator-priced, so
  // unit_amount_paise still applies to them. A rental price change is only
  // possible through `override`, which requires orders.override_price.
  unit_amount_paise: z.number().int().default(0),
  daily_rate_paise:  z.number().int().optional(),
  billable_days:     z.number().int().positive().optional(),
  sort_order:        z.number().int().default(0),
  override: z.object({
    unit_amount_paise: z.number().int(),
    label:             z.string().min(1).max(200),
  }).optional(),
  // Sub-turn 13, chunk 7: a custom line — an operator-named charge with its own
  // amount, NO product. Negative unit is allowed ONLY here (a fixed-amount
  // discount / goodwill). Custom lines are excluded from the deposit base.
  is_custom_line: z.boolean().optional(),
  custom_name:    z.string().min(1).max(200).optional(),
});

orders.post('/:id/items', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = addItemSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (order.status === 'closed' || order.status === 'cancelled') {
    return c.json({ error: 'locked' }, 409);
  }

  // Resolve the line's money SERVER-SIDE (Sub-turn 13-0). For a rental line the
  // rate comes from the product, never the client; the only way to set a
  // different price is an explicit `override`, which requires
  // orders.override_price. Non-rental lines stay operator-priced.
  let lineDailyRate: number | null = null;
  let lineUnit = input.unit_amount_paise;
  let manualPrice = false;
  let overrideLabel: string | null = null;

  if (input.item_type === 'rental') {
    if (!input.product_id) {
      return c.json({ error: 'invalid_request', reason: 'product_id_required_for_rental' }, 400);
    }
    const p = await query<{ id: string; base_price_paise: number | null; daily_rate: number }>(sql`
      SELECT id, base_price_paise, daily_rate FROM products
      WHERE id = ${input.product_id}
        AND workspace_id = ${session.workspace.id}
        AND deleted_at IS NULL
      LIMIT 1
    `);
    if (p.length === 0) return c.json({ error: 'product_not_found' }, 404);

    if (input.override) {
      if (!can(session, 'orders.override_price')) {
        return c.json({ error: 'forbidden', required_permission: ['orders.override_price'] }, 403);
      }
      lineDailyRate = input.override.unit_amount_paise;
      lineUnit = input.override.unit_amount_paise;
      manualPrice = true;
      overrideLabel = input.override.label;
    } else {
      // Server-authoritative: snapshot the product's base rate (Sub-turn 13).
      // The pricing engine turns this into the line total on the recompute that
      // fires immediately after insert; client rate fields are ignored.
      lineDailyRate = Number(p[0]!.base_price_paise ?? p[0]!.daily_rate);
      lineUnit = Number(p[0]!.base_price_paise ?? p[0]!.daily_rate);
    }
  } else if (input.override) {
    // Override on a non-rental line is still a permissioned, labelled act.
    if (!can(session, 'orders.override_price')) {
      return c.json({ error: 'forbidden', required_permission: ['orders.override_price'] }, 403);
    }
    lineUnit = input.override.unit_amount_paise;
    manualPrice = true;
    overrideLabel = input.override.label;
  }

  // Custom line (chunk 7): operator-named charge, no product, negative allowed.
  const isCustom = input.is_custom_line === true;
  if (isCustom) {
    if (input.item_type === 'rental') {
      return c.json({ error: 'invalid_request', reason: 'custom_line_cannot_be_rental' }, 400);
    }
    if (!input.custom_name) {
      return c.json({ error: 'invalid_request', reason: 'custom_name_required' }, 400);
    }
    lineUnit = input.unit_amount_paise; // as entered (may be negative)
  }
  // Negative unit price is legal ONLY on a custom line (DB CHECK enforces it too).
  if (lineUnit < 0 && !isCustom) {
    return c.json({ error: 'invalid_request', reason: 'negative_price_only_on_custom_line' }, 400);
  }

  const totalAmount = lineUnit * input.quantity;

  const inserted = await query<OrderItemRow>(sql`
    INSERT INTO order_items (
      workspace_id, order_id, parent_item_id, item_type, product_id,
      description, quantity, daily_rate_paise, billable_days,
      unit_amount_paise, total_amount_paise, manual_price, price_override_label,
      is_custom_line, custom_name, sort_order
    ) VALUES (
      ${session.workspace.id},
      ${id},
      ${input.parent_item_id ?? null}::uuid,
      ${input.item_type}::order_item_type,
      ${input.product_id ?? null}::uuid,
      ${input.description},
      ${input.quantity},
      ${lineDailyRate}::bigint,
      ${input.billable_days ?? null},
      ${lineUnit},
      ${totalAmount},
      ${manualPrice}::boolean,
      ${overrideLabel}::text,
      ${isCustom}::boolean,
      ${isCustom ? input.custom_name : null}::text,
      ${input.sort_order}
    )
    RETURNING *
  `);

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: 'order.item.added',
    fromStatus: order.status,
    toStatus: order.status,
    payload: {
      item_id: inserted[0]!.id,
      item_type: input.item_type,
      description: input.description,
    },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.item.added',
    targetType: 'order_item',
    targetId: inserted[0]!.id,
    payload: { order_id: id, item_type: input.item_type },
    ipAddress, userAgent,
  });

  // Auto-recompute pricing so totals reflect the new line before we respond.
  const { items } = await recomputeOrderTotals(id, session.workspace.id, session.user.id);
  const fresh = items.find((it) => it.id === inserted[0]!.id) ?? inserted[0];

  return c.json({ item: fresh }, 201);
});

// ============================================================================
// PATCH /api/orders/:id/items/:itemId — update a line item
// ============================================================================
const updateItemSchema = z.object({
  description:       z.string().min(1).max(500).optional(),
  quantity:          z.number().int().positive().optional(),
  unit_amount_paise: z.number().int().optional(),
  daily_rate_paise:  z.number().int().optional(),
  billable_days:     z.number().int().positive().optional(),
  sort_order:        z.number().int().optional(),
  parent_item_id:    z.string().uuid().optional(),
  manual_price:      z.boolean().optional(),
});

orders.patch('/:id/items/:itemId', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  const itemId = c.req.param('itemId');

  const body = await c.req.json().catch(() => null);
  const parsed = updateItemSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const p = parsed.data;

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (order.status === 'closed' || order.status === 'cancelled') {
    return c.json({ error: 'locked' }, 409);
  }

  const existing = await query<OrderItemRow>(sql`
    SELECT * FROM order_items
    WHERE id = ${itemId}
      AND order_id = ${id}
      AND workspace_id = ${session.workspace.id}
    LIMIT 1
  `);
  if (existing.length === 0) return c.json({ error: 'not_found' }, 404);

  const nextQty  = p.quantity          ?? existing[0]!.quantity;
  const nextUnit = p.unit_amount_paise ?? existing[0]!.unit_amount_paise;
  const nextTotal = nextQty * nextUnit;

  // Manual-price detection:
  //   * explicit { manual_price: false } reverts the line to engine control
  //   * editing unit_amount_paise on a rental line locks it as a manual override
  //   * explicit { manual_price: true } also locks it
  // A null here means "leave manual_price as-is" (COALESCE below preserves it).
  const isRental = existing[0]!.item_type === 'rental';
  const wantsRevert = p.manual_price === false;
  // Sub-turn 13-0: changing EITHER unit_amount_paise OR daily_rate_paise on a
  // rental line is a price override (the server otherwise owns the rate), so
  // both require orders.override_price via the guard below.
  const wantsOverride =
    !wantsRevert &&
    (((p.unit_amount_paise !== undefined || p.daily_rate_paise !== undefined) && isRental)
      || p.manual_price === true);
  const manualPriceToSet: boolean | null = wantsRevert
    ? false
    : wantsOverride
      ? true
      : null;

  // Manually overriding the calculated price is a distinct capability (Sub-turn
  // 12a). Ordinary edits (qty, description, revert-to-auto) need only orders.edit
  // (already gated on the route); locking in a manual price needs override_price.
  if (wantsOverride && !can(session, 'orders.override_price')) {
    return c.json({ error: 'forbidden', required_permission: ['orders.override_price'] }, 403);
  }

  const updated = await query<OrderItemRow>(sql`
    UPDATE order_items SET
      description       = COALESCE(${p.description       ?? null}::text, description),
      quantity          = COALESCE(${p.quantity          ?? null}::int,  quantity),
      unit_amount_paise = COALESCE(${p.unit_amount_paise ?? null}::bigint, unit_amount_paise),
      daily_rate_paise  = COALESCE(${p.daily_rate_paise  ?? null}::bigint, daily_rate_paise),
      billable_days     = COALESCE(${p.billable_days     ?? null}::int,  billable_days),
      sort_order        = COALESCE(${p.sort_order        ?? null}::int,  sort_order),
      parent_item_id    = COALESCE(${p.parent_item_id    ?? null}::uuid, parent_item_id),
      manual_price      = COALESCE(${manualPriceToSet    ?? null}::boolean, manual_price),
      total_amount_paise = ${nextTotal},
      updated_at         = now()
    WHERE id = ${itemId}
      AND workspace_id = ${session.workspace.id}
    RETURNING *
  `);

  if (updated.length === 0) return c.json({ error: 'not_found' }, 404);

  const priceOverridden = wantsOverride && p.unit_amount_paise !== undefined && isRental;
  const auditEventType = priceOverridden
    ? 'orders.item.price_overridden'
    : wantsRevert
      ? 'orders.item.price_reverted'
      : 'orders.item.updated';

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: 'order.item.updated',
    fromStatus: order.status,
    toStatus: order.status,
    payload: {
      item_id: itemId,
      fields: Object.keys(p),
      price_overridden: priceOverridden,
      price_reverted: wantsRevert,
    },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: auditEventType,
    targetType: 'order_item',
    targetId: itemId,
    payload: priceOverridden
      ? {
          order_id: id,
          old_unit_amount_paise: existing[0]!.unit_amount_paise,
          new_unit_amount_paise: p.unit_amount_paise,
        }
      : { order_id: id, fields: Object.keys(p) },
    ipAddress, userAgent,
  });

  // Auto-recompute so the override / revert is reflected in totals immediately.
  const { items } = await recomputeOrderTotals(id, session.workspace.id, session.user.id);
  const fresh = items.find((it) => it.id === itemId) ?? updated[0];

  return c.json({ item: fresh });
});

// ============================================================================
// DELETE /api/orders/:id/items/:itemId — remove a line item
// ============================================================================
orders.delete('/:id/items/:itemId', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  const itemId = c.req.param('itemId');

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (order.status === 'closed' || order.status === 'cancelled') {
    return c.json({ error: 'locked' }, 409);
  }

  const deleted = await query<{ id: string; description: string }>(sql`
    DELETE FROM order_items
    WHERE id = ${itemId}
      AND order_id = ${id}
      AND workspace_id = ${session.workspace.id}
    RETURNING id, description
  `);
  if (deleted.length === 0) return c.json({ error: 'not_found' }, 404);

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: 'order.item.removed',
    fromStatus: order.status,
    toStatus: order.status,
    payload: { item_id: itemId, description: deleted[0]!.description },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.item.removed',
    targetType: 'order_item',
    targetId: itemId,
    payload: { order_id: id },
    ipAddress, userAgent,
  });

  // Auto-recompute so cached totals drop the removed line.
  await recomputeOrderTotals(id, session.workspace.id, session.user.id);

  return c.json({ ok: true });
});

// ============================================================================
// PATCH /api/orders/:id/items/:itemId/status — advisory item-status change
// Body: { to, reason?, force?, condition_notes? }
// ============================================================================
// Physical lifecycle of a single line item. Does NOT touch order.status (that
// stays operator-driven) and does NOT recompute pricing (money is settled by
// the invoice module, Sub-turn 2.4). Non-canonical jumps need { force: true }.
const itemStatusSchema = z.object({
  to:              z.enum(ITEM_STATUSES),
  reason:          z.string().max(500).optional(),
  force:           z.boolean().default(false),
  condition_notes: z.string().max(2000).optional(),
});

orders.patch('/:id/items/:itemId/status', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  const itemId = c.req.param('itemId');

  const body = await c.req.json().catch(() => null);
  const parsed = itemStatusSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { to, reason, force, condition_notes } = parsed.data;

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (order.status === 'closed' || order.status === 'cancelled') {
    return c.json({ error: 'order_locked' }, 409);
  }

  const existing = await query<OrderItemRow>(sql`
    SELECT * FROM order_items
    WHERE id = ${itemId}
      AND order_id = ${id}
      AND workspace_id = ${session.workspace.id}
    LIMIT 1
  `);
  if (existing.length === 0) return c.json({ error: 'not_found' }, 404);

  const from = existing[0]!.status;
  if (from === to) {
    return c.json({ item: existing[0], unchanged: true });
  }

  const canonical = isCanonicalItem(from, to);
  if (!canonical && !force) {
    return c.json({
      error: 'non_canonical_transition',
      from,
      to,
      hint: 'resubmit with { "force": true } to override — reason recommended',
    }, 409);
  }

  // Side-effects: stamp timestamps (once) for the relevant transitions.
  const setDispatched = to === 'dispatched';
  const setReturned = to === 'returned' || to === 'returned_with_damage';

  const updated = await query<OrderItemRow>(sql`
    UPDATE order_items SET
      status          = ${to}::order_item_status,
      dispatched_at   = CASE WHEN ${setDispatched}::boolean THEN COALESCE(dispatched_at, now()) ELSE dispatched_at END,
      returned_at     = CASE WHEN ${setReturned}::boolean   THEN COALESCE(returned_at, now())   ELSE returned_at   END,
      condition_notes = COALESCE(${condition_notes ?? null}::text, condition_notes),
      updated_at      = now()
    WHERE id = ${itemId}
      AND workspace_id = ${session.workspace.id}
    RETURNING *
  `);
  if (updated.length === 0) return c.json({ error: 'not_found' }, 404);

  const eventPayload: Record<string, unknown> = { item_id: itemId, from, to, canonical };
  if (reason) eventPayload.reason = reason;
  if (condition_notes) eventPayload.condition_notes = condition_notes;

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: canonical ? 'order.item.status.changed' : 'order.item.status.forced',
    payload: eventPayload,
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: canonical ? 'orders.item.status.changed' : 'orders.item.status.forced',
    targetType: 'order_item',
    targetId: itemId,
    payload: {
      order_id: id,
      item_id: itemId,
      from,
      to,
      canonical,
      reason: reason ?? null,
      condition_notes: condition_notes ?? null,
    },
    ipAddress, userAgent,
  });

  // Item status drives chargeable_paise + tax breakdown (e.g.
  // not_returned_non_chargeable → chargeable 0). Batch dispatch/return already
  // recompute; the per-item PATCH must too, so post-invoice/return corrections
  // update the line + order totals. Fail-open — a recompute error must not undo
  // the status change (same pattern as emitNotification).
  try {
    await recomputeOrderTotals(id, session.workspace.id, session.user.id);
  } catch (err) {
    console.error('recompute after item-status change failed', err);
  }

  emitNotification({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'order.item.status.changed',
    targetType: 'order', targetId: id,
    linkUrl: `/order.html?id=${id}`,
    metadata: {
      order_number: order.order_number,
      item_description: existing[0]!.description ?? '',
      old_status: from, new_status: to,
    },
  }).catch(() => {});

  return c.json({ item: updated[0], canonical });
});

// ============================================================================
// POST /api/orders/:id/recompute — force a pricing recompute
// ============================================================================
orders.post('/:id/recompute', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (order.status === 'closed' || order.status === 'cancelled') {
    return c.json({ error: 'order_locked' }, 409);
  }

  // This endpoint IS the explicit "Recalculate prices" action, so it re-prices
  // every rental line against the CURRENT config by default. Pass
  // { reprice: false } to only true-up totals without repricing frozen lines.
  const body = await c.req.json().catch(() => null);
  const reprice = body?.reprice !== false;

  const { order: fresh, items, changed } = await recomputeOrderTotals(
    id,
    session.workspace.id,
    session.user.id,
    { reprice },
  );

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.pricing.recomputed',
    targetType: 'order',
    targetId: id,
    payload: { changed },
    ipAddress, userAgent,
  });

  return c.json({ order: fresh, items, changed });
});

// ============================================================================
// PATCH /api/orders/:id/deposit — set the required deposit amount (Sub-turn 6d)
// ----------------------------------------------------------------------------
// Dedicated (not the generic PATCH, which is draft-scoped) so the deposit can be
// set at any order status. Recomputes deposit_status (e.g. none → pending when
// set > 0 with nothing held yet).
// ============================================================================
const depositSchema = z.object({
  deposit_required_paise: z.number().int().nonnegative(),
});

orders.patch('/:id/deposit', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = depositSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);

  const updated = await query<{ id: string }>(sql`
    UPDATE orders SET deposit_required_paise = ${parsed.data.deposit_required_paise}::bigint, updated_at = now()
    WHERE id = ${id} AND workspace_id = ${session.workspace.id}
    RETURNING id
  `);
  if (updated.length === 0) return c.json({ error: 'not_found' }, 404);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.order.updated',
    targetType: 'order',
    targetId: id,
    payload: { fields: ['deposit_required_paise'], deposit_required_paise: parsed.data.deposit_required_paise },
    ipAddress, userAgent,
  });

  // Recompute deposit_status now that the required amount changed.
  await applyDepositStatus({
    workspaceId: session.workspace.id, orderId: id,
    actorUserId: session.user.id, ipAddress, userAgent,
  });

  const fresh = await loadOrder(id, session.workspace.id);
  return c.json({ order: fresh });
});

// ============================================================================
// POST /api/orders/:id/extend — first-class rental extension (Sub-turn 6c)
// ----------------------------------------------------------------------------
// Customers extend mid-flight ("keep the camera two more days"). This moves
// rental_end forward, availability-checks the EXTENSION WINDOW only (advisory,
// per app-wide warn-don't-block), re-prices via recomputeOrderTotals, and —
// following Booqable, which invoices running orders freely — revises any
// existing invoice through the shared generateInvoice() path (old snapshots
// stay immutable). Dedicated order.extended timeline + orders.extended audit +
// notification. Contraction (moving rental_end backward) is NOT supported here.
// ============================================================================
const EXTENDABLE_STATUSES: readonly OrderStatus[] = ['confirmed', 'dispatched', 'active', 'returned'];
const MAX_EXTENSION_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Sub-slice 2.1 enhances the payload: the new date may arrive as `new_rental_end`
// (legacy order.html) OR `new_rental_end_at` (new modal). `reason` (legacy) folds
// into `reason_notes`; a `reason_tag` classifies it. Extra fields drive the
// policy/approval flow. At least one of the two date fields is required.
const REASON_TAGS = ['customer_request', 'shoot_extended', 'weather', 'equipment_delay', 'logistics_delay', 'other'] as const;
const extendSchema = z.object({
  new_rental_end:     z.string().datetime().optional(),
  new_rental_end_at:  z.string().datetime().optional(),
  reason:             z.string().max(2000).optional(),
  reason_tag:         z.enum(REASON_TAGS).optional(),
  reason_notes:       z.string().max(2000).optional(),
  additional_deposit_paise: z.number().int().min(0).optional(),
  conflict_resolution: z.enum(['shorten', 'substitute', 'reshuffle', 'force', 'none']).optional(),
  conflict_resolution_data: z.record(z.string(), z.any()).optional(),
  customer_notification_channels: z.array(z.enum(['whatsapp', 'email'])).optional(),
}).refine((d) => !!(d.new_rental_end || d.new_rental_end_at), {
  message: 'new_rental_end_at is required', path: ['new_rental_end_at'],
});

type ExtensionConflict = {
  product_id: string;
  product_name: string | null;
  quantity: number;
  available: boolean;
  shortage_used: boolean;
  order_conflicts: unknown[];
};

orders.post('/:id/extend', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = extendSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const p = parsed.data;
  const newEndStr = p.new_rental_end_at ?? p.new_rental_end!;
  const reasonNotes = p.reason_notes ?? p.reason ?? null;
  const reasonTag = p.reason_tag ?? 'customer_request';

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (!EXTENDABLE_STATUSES.includes(order.status)) {
    return c.json(orderBlock('EXTEND_BLOCKED', 'Cannot extend this order', [
      reasonB('lifecycle_state', 'NOT_EXTENDABLE',
        `An order in "${order.status}" can't be extended (allowed: ${EXTENDABLE_STATUSES.join(', ')})`),
    ]), 409);
  }
  if (!order.rental_end) {
    return c.json(orderBlock('EXTEND_BLOCKED', 'Cannot extend this order', [
      reasonB('data_prerequisite', 'NO_RENTAL_END', 'This order has no rental end date to extend from'),
    ]), 409);
  }

  const oldEnd = new Date(order.rental_end);
  const newEnd = new Date(newEndStr);
  if (newEnd.getTime() <= oldEnd.getTime()) {
    return c.json({ error: 'not_an_extension', reason: 'new_end_must_be_after_current_end' }, 400);
  }
  const deltaMs = newEnd.getTime() - oldEnd.getTime();
  if (deltaMs > MAX_EXTENSION_DAYS * MS_PER_DAY) {
    return c.json({ error: 'range_too_large', max_days: MAX_EXTENSION_DAYS }, 400);
  }
  const deltaDays = Math.ceil(deltaMs / MS_PER_DAY);

  // Availability sweep of the extension window (current end -> new end) per
  // rental line. Advisory: collect conflicts, never block. Fail-soft per item.
  const items = await loadItems(id);
  const rentalItems = items.filter((it) => it.item_type === 'rental' && it.product_id);
  const conflicts: ExtensionConflict[] = [];
  for (const it of rentalItems) {
    try {
      const check = await checkAvailability({
        workspaceId: session.workspace.id,
        productId: it.product_id!,
        quantity: Number(it.quantity),
        start: oldEnd,
        end: newEnd,
        excludeOrderId: id,
        locationId: order.pickup_location_id,
      });
      if (!check.available || check.conflicts.length > 0) {
        conflicts.push({
          product_id: it.product_id!,
          product_name: it.product_name ?? null,
          quantity: Number(it.quantity),
          available: check.available,
          shortage_used: check.shortage_used,
          order_conflicts: check.conflicts,
        });
      }
    } catch (err) {
      console.error('extension availability check failed', err);
    }
  }

  // Estimate the additional charges (rate x qty x added days) for the policy
  // check BEFORE applying — the exact figure comes from the recompute in
  // applyExtensionEffects. Estimate uses added days beyond the current end.
  const addedDays = Math.ceil(deltaMs / MS_PER_DAY);
  let estCharges = 0;
  for (const it of rentalItems) {
    estCharges += Number(it.daily_rate_paise || 0) * Number(it.quantity) * addedDays;
  }

  // Policy evaluation — all thresholds from workspace.settings (never hardcoded).
  const settings = await loadWorkspaceSettings(session.workspace.id);
  const priorCompleted = (await query<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM orders
    WHERE workspace_id = ${session.workspace.id}::uuid
      AND customer_person_id = ${order.customer_person_id}::uuid
      AND id != ${id}::uuid
      AND status::text IN ('confirmed','dispatched','active','returned','closed')
  `))[0]?.n ?? 0;
  const decision = evaluateExtensionApproval(settings, {
    additionalDays: deltaDays,
    additionalChargesPaise: estCharges,
    originalUnpaid: Number(order.balance_paise) > 0,
    isNewCustomer: priorCompleted === 0,
  });

  // Persist the extension record (first-class row). extension_number is 1-based.
  const extNum = ((await query<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM order_extensions
    WHERE order_id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
  `))[0]?.n ?? 0) + 1;
  const policySnapshot = {
    extension_policy: settings.extension_policy ?? {},
    approval_routing: settings.approval_routing ?? {},
    evaluated: { requires_approval: decision.requires, role: decision.role, reasons: decision.reasons },
  };
  const extRow = (await query<{ id: string }>(sql`
    INSERT INTO order_extensions (
      workspace_id, order_id, extension_number, original_rental_end_at, new_rental_end_at,
      additional_days, additional_deposit_paise, reason_tag, reason_notes,
      had_conflict, conflict_resolution, conflict_resolution_data,
      requires_approval, requested_by_user_id, status, policy_applied_snapshot
    ) VALUES (
      ${session.workspace.id}::uuid, ${id}::uuid, ${extNum}::int,
      ${oldEnd.toISOString()}::timestamptz, ${newEnd.toISOString()}::timestamptz,
      ${deltaDays}::int, ${p.additional_deposit_paise ?? 0}::bigint,
      ${reasonTag}::text, ${reasonNotes}::text,
      ${conflicts.length > 0}::boolean, ${p.conflict_resolution ?? null}::text,
      ${p.conflict_resolution_data ? JSON.stringify(p.conflict_resolution_data) : null}::jsonb,
      ${decision.requires}::boolean, ${session.user.id}::uuid,
      ${decision.requires ? 'pending_approval' : 'approved'}::text,
      ${JSON.stringify(policySnapshot)}::jsonb
    )
    RETURNING id
  `))[0]!;

  // ---- Approval-required path: create the request, notify, do NOT move dates.
  if (decision.requires) {
    const ap = await createApprovalRequest({
      workspaceId: session.workspace.id,
      requesterUserId: session.user.id,
      requiredRole: decision.role,
      resourceType: 'order_extension',
      resourceId: extRow.id,
      orderId: id,
      reasonTag,
      reasonNotes,
      requestSnapshot: {
        order_number: order.order_number, customer_name: order.customer_name,
        old_rental_end: oldEnd.toISOString(), new_rental_end: newEnd.toISOString(),
        additional_days: deltaDays, estimated_additional_charges_paise: estCharges,
        conflicts,
      },
      policySnapshot,
    });
    await sql`
      UPDATE order_extensions SET approval_request_id = ${ap.id}::uuid, updated_at = now()
      WHERE id = ${extRow.id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    `;
    await recordOrderEvent({
      workspaceId: session.workspace.id, orderId: id, eventType: 'order.extension.requested',
      fromStatus: order.status, toStatus: order.status,
      payload: { extension_id: extRow.id, approval_request_id: ap.id, delta_days: deltaDays, requires_approval: true, reasons: decision.reasons },
      actorUserId: session.user.id,
    });
    await audit({
      workspaceId: session.workspace.id, actorUserId: session.user.id, eventType: 'orders.extension.requested',
      targetType: 'order', targetId: id,
      payload: { extension_id: extRow.id, approval_request_id: ap.id, requires_approval: true, role: decision.role },
      ipAddress, userAgent,
    });
    emitNotification({
      workspaceId: session.workspace.id, actorUserId: session.user.id, eventType: 'extension_pending_approval',
      targetType: 'order', targetId: id, linkUrl: `/order-360.html?id=${id}`,
      metadata: {
        order_number: order.order_number, delta_days: deltaDays,
        additional_charges: '₹' + Math.round(estCharges / 100).toLocaleString('en-IN'),
        actor_name: session.user.displayName ?? '',
      },
    }).catch(() => {});
    return c.json({
      extension_id: extRow.id,
      status: 'pending_approval',
      approval_request_id: ap.id,
      requires_approval: true,
      approver_role_required: decision.role,
      reasons: decision.reasons,
      conflicts,
    });
  }

  // ---- No-approval path: apply immediately via the shared effects.
  const applied = await applyExtensionEffects({
    workspaceId: session.workspace.id, orderId: id, actorUserId: session.user.id,
    extensionId: extRow.id, approvedByUserId: null, ctx: { ipAddress, userAgent },
  });
  const freshOrder = (await loadOrder(id, session.workspace.id)) ?? order;
  // Backward-compatible response shape (legacy order.html reads order/delta/…)
  // plus the new extension_id + status.
  return c.json({
    extension_id: extRow.id,
    status: 'approved',
    requires_approval: false,
    order: {
      id: freshOrder.id,
      rental_end: freshOrder.rental_end,
      total_paise: Number(freshOrder.total_paise),
      balance_paise: Number(freshOrder.balance_paise),
      status: freshOrder.status,
    },
    delta: { days: applied.delta_days, paise: applied.delta_paise },
    conflicts,
    invoice_revision: applied.invoice_revision,
  });
});

// ============================================================================
// POST /api/orders/:id/cancel — first-class cancellation (Sub-slice 2.1)
// ----------------------------------------------------------------------------
// Computes the policy tier from hours-before-dispatch, applies reason overrides,
// freezes the policy snapshot (legal defense), routes for approval when required,
// and — when not — flips the order to cancelled (releasing availability) via the
// shared applyCancellationEffects. Structured Blocked errors for ineligible states.
// ============================================================================
const CANCEL_REASON_TAGS = [
  'customer_change_of_plans', 'customer_budget_issue', 'shoot_cancelled', 'duplicate_booking',
  'customer_found_alternative', 'weather', 'equipment_issue_on_our_side', 'no_kyc',
  'payment_failed', 'customer_no_show', 'staff_error', 'other',
] as const;
const cancelSchema = z.object({
  reason_tag: z.enum(CANCEL_REASON_TAGS),
  reason_notes: z.string().max(2000).optional(),
  customer_notification_channels: z.array(z.enum(['whatsapp', 'email'])).optional(),
  editable_message: z.string().max(2000).optional(),
});

orders.post('/:id/cancel', requirePermission('orders.cancel'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = cancelSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);

  // State gate (Item 12): dispatched/on-rent → Return flow; returned/closed →
  // Finance void; already cancelled → terminal.
  if (order.status === 'dispatched' || order.status === 'active') {
    return c.json(orderBlock('CANCEL_BLOCKED', 'Cannot cancel a dispatched order', [
      reasonB('lifecycle_state', 'ALREADY_DISPATCHED',
        'Equipment is with the customer — use the Return flow to bring it back, then settle charges.',
        { type: 'internal', target: `/order.html?id=${id}` }),
    ]), 409);
  }
  if (order.status === 'returned' || order.status === 'closed') {
    return c.json(orderBlock('CANCEL_BLOCKED', 'Cannot cancel a completed order', [
      reasonB('terminal_state', 'ORDER_COMPLETE',
        `This order is ${order.status} — use a Finance void / credit note to reverse charges.`),
    ]), 409);
  }
  if (order.status === 'cancelled') {
    return c.json(orderBlock('CANCEL_BLOCKED', 'Order already cancelled', [
      reasonB('terminal_state', 'ALREADY_CANCELLED', 'This order is already cancelled.'),
    ]), 409);
  }

  // One cancellation per order.
  const existing = await query<{ id: string; status: string }>(sql`
    SELECT id, status FROM order_cancellations
    WHERE order_id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid LIMIT 1
  `);
  if (existing.length) {
    return c.json(orderBlock('CANCEL_BLOCKED', 'A cancellation already exists for this order', [
      reasonB('lifecycle_state', 'CANCELLATION_EXISTS', `A cancellation is already ${existing[0]!.status}.`),
    ]), 409);
  }

  const settings = await loadWorkspaceSettings(session.workspace.id);
  const cp = settings.cancellation_policy ?? {};
  const tiers = cp.tiers ?? {};

  // Hours before dispatch (rental_start is the scheduled pickup).
  const now = Date.now();
  const startMs = order.rental_start ? new Date(order.rental_start).getTime() : null;
  const hoursBeforeDispatch = startMs != null ? (startMs - now) / 3_600_000 : null;

  // No-show: past the scheduled pickup + grace, still merely confirmed. Or the
  // operator explicitly tags it a no-show.
  const graceHours = Number(settings.billing?.grace_period_hours ?? 2);
  const isNoShow =
    p.reason_tag === 'customer_no_show' ||
    (order.status === 'confirmed' && startMs != null && now > startMs + graceHours * 3_600_000);

  // Tier by time (default before_72hr when there's no scheduled pickup — nothing
  // is committed yet).
  let tier: 'before_72hr' | '24_to_72hr' | 'under_24hr' = 'before_72hr';
  if (hoursBeforeDispatch != null) {
    if (hoursBeforeDispatch < 24) tier = 'under_24hr';
    else if (hoursBeforeDispatch < 72) tier = '24_to_72hr';
    else tier = 'before_72hr';
  }

  // Base refund percent from the tier, then reason overrides.
  const tierCfg = tiers[tier] ?? { refund_percent: 100, processing_fee_paise: 0 };
  let refundPercent = Number(tierCfg.refund_percent ?? 100);
  let processingFee = Number(tierCfg.processing_fee_paise ?? 0);
  const autoRefund: string[] = cp.auto_refund_reasons ?? [];
  const autoZero: string[] = cp.auto_zero_refund_reasons ?? [];
  let depositForfeitPercent = 0;
  if (autoRefund.includes(p.reason_tag)) {
    refundPercent = 100; processingFee = 0;  // our fault → full refund
  } else if (isNoShow || autoZero.includes(p.reason_tag)) {
    refundPercent = 0;
    depositForfeitPercent = Number(cp.no_show_policy?.deposit_forfeit_percent ?? 100);
  }

  const original = Number(order.total_paise);
  const refundAmount = Math.round((original * refundPercent) / 100);
  const forfeitAmount = original - refundAmount;

  // Held deposit (net of prior refunds/forfeits).
  const depRows = await query<{ payment_kind: string; amount_paise: number }>(sql`
    SELECT payment_kind, amount_paise FROM payments
    WHERE order_id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
      AND status = 'completed'
      AND payment_kind = ANY(string_to_array('deposit,deposit_refund,deposit_forfeit'::text, ','))
  `);
  const dSum = (k: string) => depRows.filter((r) => r.payment_kind === k).reduce((s, r) => s + Number(r.amount_paise), 0);
  const heldDeposit = Math.max(0, dSum('deposit') - dSum('deposit_refund') - dSum('deposit_forfeit'));
  const depositForfeited = depositForfeitPercent > 0 ? Math.round((heldDeposit * depositForfeitPercent) / 100) : 0;
  const depositRefunded = heldDeposit - depositForfeited;

  const decision = evaluateCancellationApproval(settings, {
    tier, refundAmountPaise: refundAmount, isNoShow,
  });

  const policySnapshot = {
    cancellation_policy: cp, approval_routing: settings.approval_routing ?? {},
    computed: { tier, hours_before_dispatch: hoursBeforeDispatch, is_no_show: isNoShow,
      refund_percent: refundPercent, deposit_forfeit_percent: depositForfeitPercent },
    evaluated: { requires_approval: decision.requires, role: decision.role, reasons: decision.reasons },
  };

  const cancelRow = (await query<{ id: string }>(sql`
    INSERT INTO order_cancellations (
      workspace_id, order_id, order_state_at_cancellation, hours_before_dispatch,
      reason_tag, reason_notes, original_amount_paise, refund_amount_paise, forfeit_amount_paise,
      processing_fee_paise, deposit_refunded_paise, deposit_forfeited_paise,
      requires_approval, requested_by_user_id, status, policy_applied_snapshot
    ) VALUES (
      ${session.workspace.id}::uuid, ${id}::uuid, ${order.status}::text, ${hoursBeforeDispatch}::numeric,
      ${p.reason_tag}::text, ${p.reason_notes ?? null}::text, ${original}::bigint,
      ${refundAmount}::bigint, ${forfeitAmount}::bigint, ${processingFee}::bigint,
      ${depositRefunded}::bigint, ${depositForfeited}::bigint,
      ${decision.requires}::boolean, ${session.user.id}::uuid,
      ${decision.requires ? 'pending_approval' : 'pending_approval'}::text,
      ${JSON.stringify(policySnapshot)}::jsonb
    )
    RETURNING id
  `))[0]!;

  // Line items to be freed (for the operational-impact preview).
  const freedItems = (await loadItems(id)).filter((it) => it.item_type === 'rental');
  const operationalImpact = {
    availability_released_from: order.rental_start,
    availability_released_until: order.rental_end,
    line_item_ids_freed: freedItems.map((it) => it.id),
  };
  const financialImpact = {
    refund_amount_paise: refundAmount, forfeit_amount_paise: forfeitAmount,
    processing_fee_paise: processingFee,
    deposit_refunded_paise: depositRefunded, deposit_forfeited_paise: depositForfeited,
    total_to_customer_paise: refundAmount + depositRefunded,
    tier, refund_percent: refundPercent,
  };

  // ---- Approval-required path.
  if (decision.requires) {
    const ap = await createApprovalRequest({
      workspaceId: session.workspace.id, requesterUserId: session.user.id, requiredRole: decision.role,
      resourceType: 'order_cancellation', resourceId: cancelRow.id, orderId: id,
      reasonTag: p.reason_tag, reasonNotes: p.reason_notes ?? null,
      requestSnapshot: {
        order_number: order.order_number, customer_name: order.customer_name,
        tier, financial_impact: financialImpact, operational_impact: operationalImpact,
      },
      policySnapshot,
    });
    await sql`UPDATE order_cancellations SET approval_request_id = ${ap.id}::uuid, updated_at = now()
              WHERE id = ${cancelRow.id}::uuid AND workspace_id = ${session.workspace.id}::uuid`;
    await recordOrderEvent({
      workspaceId: session.workspace.id, orderId: id, eventType: 'order.cancellation.requested',
      fromStatus: order.status, toStatus: order.status,
      payload: { cancellation_id: cancelRow.id, approval_request_id: ap.id, reason_tag: p.reason_tag, requires_approval: true, reasons: decision.reasons },
      actorUserId: session.user.id,
    });
    await audit({
      workspaceId: session.workspace.id, actorUserId: session.user.id, eventType: 'orders.cancellation.requested',
      targetType: 'order', targetId: id,
      payload: { cancellation_id: cancelRow.id, approval_request_id: ap.id, requires_approval: true, role: decision.role },
      ipAddress, userAgent,
    });
    emitNotification({
      workspaceId: session.workspace.id, actorUserId: session.user.id, eventType: 'cancellation_pending_approval',
      targetType: 'order', targetId: id, linkUrl: `/order-360.html?id=${id}`,
      metadata: {
        order_number: order.order_number,
        refund_amount: '₹' + Math.round(refundAmount / 100).toLocaleString('en-IN'),
        actor_name: session.user.displayName ?? '',
      },
    }).catch(() => {});
    return c.json({
      cancellation_id: cancelRow.id, status: 'pending_approval', approval_request_id: ap.id,
      requires_approval: true, approver_role_required: decision.role, reasons: decision.reasons,
      financial_impact: financialImpact, operational_impact: operationalImpact,
    });
  }

  // ---- No-approval path: apply immediately.
  const applied = await applyCancellationEffects({
    workspaceId: session.workspace.id, orderId: id, actorUserId: session.user.id,
    cancellationId: cancelRow.id, approvedByUserId: null, settings, ctx: { ipAddress, userAgent },
  });
  return c.json({
    cancellation_id: cancelRow.id, status: applied.status, approval_request_id: null,
    requires_approval: false, financial_impact: financialImpact, operational_impact: operationalImpact,
    refund_expected_credit_by: applied.refund_expected_credit_by,
  });
});

// ============================================================================
// GET /api/orders/:id/extensions — extensions on this order (Related Events).
// ============================================================================
orders.get('/:id/extensions', async (c) => {
  const session = c.get('session')!;
  const id = c.req.param('id');
  const rows = await query(sql`
    SELECT e.*, ru.display_name AS requested_by_name, au.display_name AS approved_by_name
    FROM order_extensions e
    LEFT JOIN users ru ON ru.id = e.requested_by_user_id
    LEFT JOIN users au ON au.id = e.approved_by_user_id
    WHERE e.order_id = ${id}::uuid AND e.workspace_id = ${session.workspace.id}::uuid
    ORDER BY e.extension_number ASC
  `);
  return c.json({ extensions: rows });
});

// ============================================================================
// GET /api/orders/:id/cancellation — the cancellation, if any.
// ============================================================================
orders.get('/:id/cancellation', async (c) => {
  const session = c.get('session')!;
  const id = c.req.param('id');
  const rows = await query(sql`
    SELECT ca.*, ru.display_name AS requested_by_name, au.display_name AS approved_by_name
    FROM order_cancellations ca
    LEFT JOIN users ru ON ru.id = ca.requested_by_user_id
    LEFT JOIN users au ON au.id = ca.approved_by_user_id
    WHERE ca.order_id = ${id}::uuid AND ca.workspace_id = ${session.workspace.id}::uuid
    LIMIT 1
  `);
  return c.json({ cancellation: rows[0] ?? null });
});

// ============================================================================
// GET /api/orders/:id/communications — customer notification deliveries for the
// Order 360 Communications card (Sub-slice 2.1). Reads the customer-facing
// delivery rows (notification_id NULL, tagged with this order in the payload).
// ============================================================================
orders.get('/:id/communications', async (c) => {
  const session = c.get('session')!;
  const id = c.req.param('id');
  const rows = await query(sql`
    SELECT id, channel, status, target_person_id, target_address,
           payload_snapshot, error_message, delivered_at, created_at
    FROM notification_deliveries
    WHERE workspace_id = ${session.workspace.id}::uuid
      AND notification_id IS NULL
      AND payload_snapshot->>'order_id' = ${id}::text
    ORDER BY created_at DESC
    LIMIT 100
  `);
  return c.json({ communications: rows });
});

// ============================================================================
// POST /api/orders/:id/send-update — manual customer notification (Send Update).
// Bypasses the notification-policy mode (a manual send always fires). Records the
// delivery rows + an order timeline event.
// ============================================================================
const sendUpdateSchema = z.object({
  event_type: z.string().max(80).default('manual_update'),
  channels: z.array(z.enum(['whatsapp', 'email'])).min(1),
  message: z.string().min(1).max(4000),
  alt_phone: z.string().max(30).optional(),
  alt_email: z.string().email().max(200).optional(),
  update_customer_default: z.boolean().optional(),
});

orders.post('/:id/send-update', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = sendUpdateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);

  const contact = {
    phone: p.alt_phone ?? order.customer_phone ?? null,
    email: p.alt_email ?? order.customer_email ?? null,
  };
  const result = await emitCustomerNotification({
    workspaceId: session.workspace.id, orderId: id, personId: order.customer_person_id,
    eventType: p.event_type, message: p.message, channels: p.channels, contact, bypassPolicy: true,
  });

  // Opt-in: only update the customer's default number when explicitly requested.
  if (p.update_customer_default && p.alt_phone) {
    await sql`UPDATE people SET phone = ${p.alt_phone}::text, updated_at = now()
              WHERE id = ${order.customer_person_id}::uuid AND workspace_id = ${session.workspace.id}::uuid`
      .catch(() => {});
  }

  await recordOrderEvent({
    workspaceId: session.workspace.id, orderId: id, eventType: 'order.comm.sent',
    fromStatus: order.status, toStatus: order.status,
    payload: { event_type: p.event_type, channels: p.channels, deliveries: result.deliveries },
    actorUserId: session.user.id,
  });
  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id, eventType: 'orders.comm.sent',
    targetType: 'order', targetId: id, payload: { channels: p.channels, event_type: p.event_type },
    ipAddress, userAgent,
  });
  return c.json({ sent: true, deliveries: result.deliveries });
});

// ============================================================================
// POST /api/orders/:id/transitions — advisory state change
// Body: { to, reason?, force? }
// ============================================================================
const transitionSchema = z.object({
  to:     z.enum(ORDER_STATUSES),
  reason: z.string().max(500).optional(),
  force:  z.boolean().default(false),
});

/** Undo a dispatch when an order is REVERTED back across the dispatch boundary
 *  (Sub-turn 13, chunk 7). This is an UNDO of an operator error, distinct from a
 *  customer return (still rejected for sale lines):
 *    - rental: units flip 'out' → 'available'; order_assets removed.
 *    - sale bulk: stock_levels RE-INCREMENTED (else one mistake silently
 *      corrupts the count forever).
 *    - sale serialized: the retired/sold units are UN-retired back to 'available'.
 *  Every dispatched line resets to pending_dispatch. Returns a summary to audit. */
async function undoDispatch(args: {
  workspaceId: string; orderId: string; pickupLocationId: string | null;
}): Promise<{ item_id: string; kind: string; quantity: number; asset_codes: string[] }[]> {
  const items = await query<{
    item_id: string; product_id: string | null; quantity: number;
    nature: string | null; tracking_method: string | null;
  }>(sql`
    SELECT oi.id AS item_id, oi.product_id, oi.quantity,
           p.nature::text AS nature, p.tracking_method::text AS tracking_method
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ${args.orderId}::uuid AND oi.workspace_id = ${args.workspaceId}::uuid
      AND oi.item_type = 'rental' AND oi.status::text = 'dispatched'
  `);
  const restored: { item_id: string; kind: string; quantity: number; asset_codes: string[] }[] = [];
  for (const it of items) {
    const isBulk = it.tracking_method === 'bulk';
    let kind = 'rental';
    let codes: string[] = [];
    if (it.nature === 'sale' && isBulk && it.product_id) {
      // Restore on-hand at the pickup location.
      await sql`
        UPDATE stock_levels SET quantity = quantity + ${Number(it.quantity)}::int
        WHERE product_id = ${it.product_id}::uuid AND location_id = ${args.pickupLocationId}::uuid
      `;
      kind = 'sale_bulk';
    } else if (it.nature === 'service') {
      // nothing physical
      kind = 'service';
    } else {
      // rental OR serialized sale: reclaim the pinned/sold units.
      const assets = await query<{ asset_id: string; asset_code: string }>(sql`
        SELECT oa.asset_id, a.asset_code FROM order_assets oa JOIN assets a ON a.id = oa.asset_id
        WHERE oa.order_id = ${args.orderId}::uuid AND oa.order_item_id = ${it.item_id}::uuid
          AND oa.workspace_id = ${args.workspaceId}::uuid
      `);
      for (const a of assets) {
        // Un-retire a sold serialized unit or flip a rented one back on the shelf.
        await sql`
          UPDATE assets SET status = 'available'::asset_status, deleted_at = NULL, updated_at = now()
          WHERE id = ${a.asset_id}::uuid AND workspace_id = ${args.workspaceId}::uuid
        `;
      }
      await sql`
        DELETE FROM order_assets WHERE order_id = ${args.orderId}::uuid
          AND order_item_id = ${it.item_id}::uuid AND workspace_id = ${args.workspaceId}::uuid
      `;
      codes = assets.map((a) => a.asset_code);
      kind = it.nature === 'sale' ? 'sale_serialized' : 'rental';
    }
    await sql`
      UPDATE order_items SET status = 'pending_dispatch'::order_item_status,
             dispatched_at = NULL, updated_at = now()
      WHERE id = ${it.item_id}::uuid AND workspace_id = ${args.workspaceId}::uuid
    `;
    restored.push({ item_id: it.item_id, kind, quantity: Number(it.quantity), asset_codes: codes });
  }
  return restored;
}

orders.post('/:id/transitions', async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = transitionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { to, reason, force } = parsed.data;

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);

  if (order.status === to) {
    return c.json({ order, unchanged: true });
  }

  // Permission gate (Sub-turn 12a): cancel / revert / forward-progression are
  // distinct capabilities. Staff may PROGRESS an order but not cancel it or
  // revert its status. Cancelling is always orders.cancel; a move to an earlier
  // lifecycle stage is a revert; anything else is ordinary editing.
  const LIFECYCLE_RANK: Record<string, number> = {
    draft: 0, quoted: 1, confirmed: 2, dispatched: 3, active: 3,
    returned: 4, closed: 5, cancelled: 6,
  };
  const neededPerm: 'orders.cancel' | 'orders.revert_status' | 'orders.edit' =
    to === 'cancelled'
      ? 'orders.cancel'
      : (LIFECYCLE_RANK[to] ?? 99) < (LIFECYCLE_RANK[order.status] ?? 0)
        ? 'orders.revert_status'
        : 'orders.edit';
  if (!can(session, neededPerm)) {
    return c.json(orderBlock('TRANSITION_BLOCKED', `Cannot move this order to "${to}"`, [
      reasonB('permission', 'PERMISSION_DENIED', `Your role can't perform this transition (needs ${neededPerm})`),
    ]), 403);
  }

  let canonical = isCanonical(order.status, to);
  let finalizeViaCanFinalize = false;

  // Closing is canonical from ANY status once every item is in a terminal state.
  // Computed server-side from ground truth (item statuses) — never trusted from
  // the client. This lets the "Ready to close" banner close cleanly without a
  // forced transition.
  if (to === 'closed' && !canonical) {
    const items = await loadItems(id);
    if (deriveCanFinalize(items)) {
      canonical = true;
      finalizeViaCanFinalize = true;
    }
  }

  // Advisory: non-canonical needs explicit { force: true }. UI shows a warning.
  if (!canonical && !force) {
    return c.json({
      error: 'non_canonical_transition',
      from: order.status,
      to,
      hint: 'resubmit with { "force": true } to override — reason recommended',
    }, 409);
  }

  const updated = await query<OrderRow>(sql`
    UPDATE orders
       SET status = ${to}::order_status,
           updated_at = now()
     WHERE id = ${id}
       AND workspace_id = ${session.workspace.id}
    RETURNING *
  `);

  // Sub-turn 13, chunk 7: reverting BACKWARD across the dispatch boundary undoes
  // the dispatch — critically, it restores sale stock (bulk re-increment /
  // serialized un-retire), so an operator dispatching the wrong order can't
  // silently corrupt the count. Audited as a stock correction.
  const crossesDispatchBackward =
    (LIFECYCLE_RANK[order.status] ?? 0) >= 3 && (LIFECYCLE_RANK[to] ?? 0) < 3;
  if (crossesDispatchBackward) {
    const restored = await undoDispatch({
      workspaceId: session.workspace.id,
      orderId: id,
      pickupLocationId: order.pickup_location_id ?? null,
    });
    if (restored.length) {
      await audit({
        workspaceId: session.workspace.id,
        actorUserId: session.user.id,
        eventType: 'orders.dispatch.reverted',
        targetType: 'order',
        targetId: id,
        payload: { from: order.status, to, restored },
        ipAddress, userAgent,
      });
    }
  }

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: canonical ? 'order.status.changed' : 'order.status.forced',
    fromStatus: order.status,
    toStatus: to,
    payload: { canonical, forced: !canonical, reason: reason ?? null, finalize_via_can_finalize: finalizeViaCanFinalize },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: canonical ? 'orders.status.changed' : 'orders.status.forced',
    targetType: 'order',
    targetId: id,
    payload: { from: order.status, to, canonical, reason: reason ?? null, finalize_via_can_finalize: finalizeViaCanFinalize },
    ipAddress, userAgent,
  });

  emitNotification({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: canonical ? 'order.status.changed' : 'order.status.forced',
    targetType: 'order', targetId: id,
    linkUrl: `/order.html?id=${id}`,
    metadata: {
      order_number: order.order_number, old_status: order.status, new_status: to,
      customer_name: order.customer_name ?? '', reason: reason ?? '',
    },
  }).catch(() => {});

  return c.json({ order: updated[0], canonical });
});

// ============================================================================
// Contract template rendering (Sub-turn 6e). Substitutes {variable} tokens with
// order data; unknown tokens are left as-is so a typo in the template is visible.
function renderContractTemplate(text: string, ctx: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => (key in ctx ? ctx[key]! : `{${key}}`));
}

// Asia/Kolkata display for the frozen snapshot (UTC over the wire, IST for humans).
function contractDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function rupeesLabel(paise: number | null | undefined): string {
  return '₹' + (Number(paise ?? 0) / 100).toLocaleString('en-IN');
}

// POST /api/orders/:id/dispatch — batch hand-over of pending items
// ============================================================================
// Transitions a chosen subset of pending_dispatch items to dispatched in one
// request, stamps hand-over metadata, and (if the order is still pre-dispatch)
// advances order.status to 'dispatched'. Records ONE batch order_event + audit
// row — not per-item events (those would be noise).
//
// Sub-turn 6e: when the `contract_signatures` flag is on, a contract record is
// written for the batch — signed if a signature payload is present, otherwise
// an unsigned record for the audit trail. Contract creation is fail-open — it
// never fails the dispatch itself.
const dispatchSchema = z.object({
  item_ids:            z.array(z.string().uuid()).min(1),
  handed_to:           z.string().max(200).optional(),
  received_by_user_id: z.string().uuid().optional(),
  dispatch_notes:      z.string().max(1000).optional(),
  // Sub-turn 12b: which physical units go out per line. Optional — omitted lines
  // auto-assign available units at the pickup location. Bulk lines are ignored.
  assignments: z.array(z.object({
    item_id:   z.string().uuid(),
    asset_ids: z.array(z.string().uuid()).max(100),
  })).optional(),
  contract: z.object({
    signature_png_base64: z.string().max(200000).optional(),
    signer_name:          z.string().max(200),
    signer_role:          z.enum(['customer', 'representative']),
  }).optional(),
});

orders.post('/:id/dispatch', requirePermission('dispatch.execute'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = dispatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { handed_to, dispatch_notes } = parsed.data;
  const requested = [...new Set(parsed.data.item_ids)];

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (order.status === 'closed' || order.status === 'cancelled') {
    return c.json(orderBlock('DISPATCH_BLOCKED', 'Cannot dispatch this order', [
      reasonB('terminal_state', 'ORDER_LOCKED', `This order is ${order.status} and can no longer be dispatched`),
    ]), 409);
  }

  const allItems = await loadItems(id);
  const byId = new Map(allItems.map((it) => [it.id, it]));

  const missing = requested.filter((x) => !byId.has(x));
  if (missing.length) {
    return c.json({ error: 'invalid_item_ids', item_ids: missing }, 400);
  }

  const notPending = requested
    .map((x) => byId.get(x)!)
    .filter((it) => it.status !== 'pending_dispatch');
  if (notPending.length) {
    return c.json({
      error: 'items_not_pending',
      items: notPending.map((it) => ({ id: it.id, status: it.status })),
    }, 409);
  }

  // Resolve the staff member — default to the session user; if supplied, verify
  // they're a member of this workspace.
  let receivedBy = session.user.id;
  if (parsed.data.received_by_user_id) {
    const u = await query<{ id: string }>(sql`
      SELECT u.id FROM users u
      JOIN workspace_memberships wm ON wm.user_id = u.id
      WHERE u.id = ${parsed.data.received_by_user_id}::uuid
        AND wm.workspace_id = ${session.workspace.id}::uuid
      LIMIT 1
    `);
    if (u.length === 0) return c.json({ error: 'invalid_user' }, 400);
    receivedBy = parsed.data.received_by_user_id;
  }

  // Per-item UPDATE (avoids the JS-array-param serialization gotcha called out
  // in CLAUDE.md). The status guard makes each write idempotent against a race.
  for (const itemId of requested) {
    await sql`
      UPDATE order_items SET
        status              = 'dispatched'::order_item_status,
        dispatched_at       = now(),
        handed_to           = ${handed_to ?? null}::text,
        received_by_user_id = ${receivedBy}::uuid,
        dispatch_notes      = ${dispatch_notes ?? null}::text,
        updated_at          = now()
      WHERE id = ${itemId}::uuid
        AND workspace_id = ${session.workspace.id}::uuid
        AND status = 'pending_dispatch'::order_item_status
    `;
  }

  // Pin physical units (Sub-turn 12b): order_assets rows + asset.status='out'.
  // Tracked rental lines only; bulk/non-rental lines are skipped inside the
  // helper. Explicit picks come from the request; otherwise auto-assign.
  const assignmentsMap = new Map<string, string[]>();
  for (const a of parsed.data.assignments ?? []) assignmentsMap.set(a.item_id, a.asset_ids);
  const assignedAssets: AssignedAsset[] = [];
  for (const itemId of requested) {
    const it = byId.get(itemId)!;
    if (it.item_type !== 'rental' || !it.product_id) continue;
    const pinned = await pinAssetsForItem({
      workspaceId: session.workspace.id,
      orderId: id,
      itemId,
      productId: it.product_id,
      quantity: Number(it.quantity),
      pickupLocationId: order.pickup_location_id ?? null,
      explicitAssetIds: assignmentsMap.get(itemId),
    });
    assignedAssets.push(...pinned);
  }

  // Auto-advance order status if it's still pre-dispatch.
  const orderStatusChanged = ['draft', 'quoted', 'confirmed'].includes(order.status);
  if (orderStatusChanged) {
    await sql`
      UPDATE orders SET status = 'dispatched'::order_status, updated_at = now()
      WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    `;
  }

  const payload: Record<string, unknown> = {
    item_ids: requested,
    count: requested.length,
    handed_to: handed_to ?? null,
    received_by_user_id: receivedBy,
    dispatch_notes: dispatch_notes ?? null,
    auto_order_status_transition: orderStatusChanged,
    // Sub-turn 12b: the specific units pinned (one batch row, not per-asset).
    assigned_assets: assignedAssets,
  };

  const dispatchEventId = await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: 'order.dispatch.batch',
    fromStatus: order.status,
    toStatus: orderStatusChanged ? 'dispatched' : order.status,
    payload,
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.dispatch.batch',
    targetType: 'order',
    targetId: id,
    payload,
    ipAddress, userAgent,
  });

  emitNotification({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'order.item.dispatched',
    targetType: 'order', targetId: id,
    linkUrl: `/order.html?id=${id}`,
    metadata: {
      order_number: order.order_number, count: requested.length,
      handed_to: handed_to ?? 'customer', actor_name: session.user.displayName,
    },
  }).catch(() => {});

  const freshOrder = await loadOrder(id, session.workspace.id);
  const freshItems = await loadItems(id);
  const dispatched = freshItems
    .filter((it) => requested.includes(it.id))
    .map((it) => ({
      id: it.id,
      description: it.description,
      status: it.status,
      handed_to: it.handed_to,
      received_by_user_id: it.received_by_user_id,
      dispatched_at: it.dispatched_at,
      dispatch_notes: it.dispatch_notes,
    }));

  // ---- Contract record (Sub-turn 6e) — only when the flag is on. Fail-open. ----
  let contractSummary: {
    id: string; signed: boolean; signer_name: string | null; signed_at: string | null;
  } | null = null;
  try {
    const wsRows = await query<{ legal_name: string | null; settings: any }>(sql`
      SELECT legal_name, settings FROM workspaces
      WHERE id = ${session.workspace.id}::uuid LIMIT 1
    `);
    const ws = wsRows[0];
    const contractsEnabled = ws?.settings?.features?.contract_signatures === true;
    if (contractsEnabled && ws) {
      const templateText: string = ws.settings?.contract?.template_text ?? '';
      const templateVersion: string | null = ws.settings?.contract?.template_version ?? null;
      const rentalLines = freshItems.filter((it) => it.item_type === 'rental');
      const ctx: Record<string, string> = {
        workspace_name: ws.legal_name || session.workspace.name || 'Workspace',
        customer_name: freshOrder?.customer_name || 'Customer',
        customer_phone: freshOrder?.customer_phone || '',
        order_number: String(freshOrder?.order_number ?? order.order_number),
        rental_start: contractDate(freshOrder?.rental_start ?? null),
        rental_end: contractDate(freshOrder?.rental_end ?? null),
        total_amount: rupeesLabel(freshOrder?.total_paise),
        deposit_required: rupeesLabel(freshOrder?.deposit_required_paise),
        items_list: rentalLines.map((it) => `- ${it.description} (Qty: ${Number(it.quantity)})`).join('\n'),
      };
      const rendered = renderContractTemplate(templateText, ctx);

      const contractInput = parsed.data.contract;
      const hasSignature = !!(contractInput && contractInput.signature_png_base64 && contractInput.signer_name);
      // Strip any data-URL prefix — store raw base64.
      const sigB64 = hasSignature
        ? contractInput!.signature_png_base64!.replace(/^data:image\/\w+;base64,/, '')
        : null;
      // inet cast is strict — only pass an IP-shaped string, else null.
      const safeIp = hasSignature && ipAddress && /^[0-9a-fA-F:.]+$/.test(ipAddress) ? ipAddress : null;

      const inserted = await query<{ id: string; signed_at: string | null }>(sql`
        INSERT INTO order_contracts (
          workspace_id, order_id, dispatch_event_id,
          contract_text_snapshot, template_version,
          signature_png, signer_name, signer_role, signed_at,
          ip_address, user_agent, witness_user_id
        ) VALUES (
          ${session.workspace.id}::uuid,
          ${id}::uuid,
          ${dispatchEventId}::uuid,
          ${rendered}::text,
          ${templateVersion}::text,
          ${sigB64}::text,
          ${hasSignature ? contractInput!.signer_name : null}::text,
          ${hasSignature ? contractInput!.signer_role : 'unsigned'}::text,
          ${hasSignature ? new Date().toISOString() : null}::timestamptz,
          ${safeIp}::inet,
          ${hasSignature ? userAgent : null}::text,
          ${session.user.id}::uuid
        )
        RETURNING id, signed_at
      `);
      const contract = inserted[0]!;
      contractSummary = {
        id: contract.id,
        signed: hasSignature,
        signer_name: hasSignature ? contractInput!.signer_name : null,
        signed_at: contract.signed_at,
      };

      await audit({
        workspaceId: session.workspace.id,
        actorUserId: session.user.id,
        eventType: hasSignature ? 'orders.contract.signed' : 'orders.contract.unsigned_generated',
        targetType: 'order',
        targetId: id,
        payload: {
          contract_id: contract.id,
          dispatch_event_id: dispatchEventId,
          signed: hasSignature,
          signer_name: hasSignature ? contractInput!.signer_name : null,
          signer_role: hasSignature ? contractInput!.signer_role : 'unsigned',
        },
        ipAddress, userAgent,
      });
    }
  } catch (err) {
    console.error('contract creation on dispatch failed (non-fatal)', err);
  }

  return c.json({
    order: freshOrder,
    items_dispatched: dispatched,
    order_status_changed: orderStatusChanged,
    contract: contractSummary,
    assigned_assets: assignedAssets,
  });
});

// ============================================================================
// GET /api/orders/:id/contracts — light list of an order's contracts (6e)
// ============================================================================
orders.get('/:id/contracts', async (c) => {
  const session = c.get('session')!;
  const id = c.req.param('id');
  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);

  const rows = await query<{
    id: string; dispatch_event_id: string | null; signer_name: string | null;
    signer_role: string | null; signed_at: string | null; created_at: string;
  }>(sql`
    SELECT id, dispatch_event_id, signer_name, signer_role, signed_at, created_at
    FROM order_contracts
    WHERE order_id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    ORDER BY created_at DESC
  `);
  return c.json({
    contracts: rows.map((r) => ({
      id: r.id,
      dispatch_event_id: r.dispatch_event_id,
      signed: r.signed_at != null,
      signer_name: r.signer_name,
      signer_role: r.signer_role,
      signed_at: r.signed_at,
      created_at: r.created_at,
    })),
  });
});

// ============================================================================
// GET /api/orders/:id/contracts/:contractId — full contract + signature (6e)
// ============================================================================
orders.get('/:id/contracts/:contractId', async (c) => {
  const session = c.get('session')!;
  const id = c.req.param('id');
  const contractId = c.req.param('contractId');

  const rows = await query<{
    id: string; order_id: string; contract_text_snapshot: string;
    template_version: string | null; signature_png: string | null;
    signer_name: string | null; signer_role: string | null; signed_at: string | null;
    ip_address: string | null; witness_user_id: string | null; witness_name: string | null;
    created_at: string;
  }>(sql`
    SELECT oc.id, oc.order_id, oc.contract_text_snapshot, oc.template_version,
           oc.signature_png, oc.signer_name, oc.signer_role, oc.signed_at,
           host(oc.ip_address) AS ip_address, oc.witness_user_id,
           u.display_name AS witness_name, oc.created_at
    FROM order_contracts oc
    LEFT JOIN users u ON u.id = oc.witness_user_id
    WHERE oc.id = ${contractId}::uuid
      AND oc.order_id = ${id}::uuid
      AND oc.workspace_id = ${session.workspace.id}::uuid
    LIMIT 1
  `);
  const contract = rows[0];
  if (!contract) return c.json({ error: 'not_found' }, 404);
  return c.json({ contract });
});

// ============================================================================
// POST /api/orders/:id/return — batch check-in of dispatched items
// ============================================================================
// The mirror of dispatch: each dispatched item is classified into one of five
// terminal outcomes. condition_notes is required for damage / not-returned-
// chargeable / missing. When every item on the order becomes terminal, the
// order auto-advances to 'returned'. Pricing is recomputed so chargeable_paise
// (0 for waived items) and the tax breakdown refresh. ONE batch event + audit.
const RETURN_OUTCOMES = [
  'returned', 'returned_with_damage', 'not_returned_chargeable',
  'not_returned_non_chargeable', 'missing',
] as const;
const NOTES_REQUIRED_OUTCOMES = new Set([
  'returned_with_damage', 'not_returned_chargeable', 'missing',
]);

const returnSchema = z.object({
  items: z.array(z.object({
    item_id:         z.string().uuid(),
    outcome:         z.enum(RETURN_OUTCOMES),
    condition_notes: z.string().max(2000).optional(),
  })).min(1),
  received_from:       z.string().max(200).optional(),
  returned_by_user_id: z.string().uuid().optional(),
});

orders.post('/:id/return', requirePermission('returns.execute'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = returnSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { items: reqItems, received_from } = parsed.data;

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (order.status === 'closed' || order.status === 'cancelled') {
    return c.json(orderBlock('RETURN_BLOCKED', 'Cannot process a return for this order', [
      reasonB('terminal_state', 'ORDER_LOCKED', `This order is ${order.status} and can no longer accept returns`),
    ]), 409);
  }

  const allItems = await loadItems(id);
  const byId = new Map(allItems.map((it) => [it.id, it]));

  const missing = reqItems.map((r) => r.item_id).filter((x) => !byId.has(x));
  if (missing.length) {
    return c.json({ error: 'invalid_item_ids', item_ids: [...new Set(missing)] }, 400);
  }

  const notDispatched = reqItems.filter((r) => byId.get(r.item_id)!.status !== 'dispatched');
  if (notDispatched.length) {
    return c.json({
      error: 'items_not_dispatched',
      items: notDispatched.map((r) => ({ id: r.item_id, status: byId.get(r.item_id)!.status })),
    }, 409);
  }

  // Sub-turn 13: SALE lines never return — dispatch already permanently removed
  // the stock. Reject any attempt so sold gear can't be resurrected (verify #4).
  const returnedProductIds = [...new Set(reqItems.map((r) => byId.get(r.item_id)!.product_id).filter(Boolean) as string[])];
  if (returnedProductIds.length) {
    const saleRows = await query<{ id: string }>(sql`
      SELECT id FROM products
      WHERE workspace_id = ${session.workspace.id}::uuid
        AND nature = 'sale'::product_nature
        AND id::text = ANY(string_to_array(${returnedProductIds.join(',')}::text, ','))
    `);
    const saleSet = new Set(saleRows.map((s) => s.id));
    const saleItems = reqItems.filter((r) => {
      const pid = byId.get(r.item_id)!.product_id;
      return pid && saleSet.has(pid);
    });
    if (saleItems.length) {
      return c.json({ error: 'sale_not_returnable', item_ids: saleItems.map((r) => r.item_id) }, 409);
    }
  }

  const notesMissing = reqItems.filter(
    (r) => NOTES_REQUIRED_OUTCOMES.has(r.outcome) && (r.condition_notes ?? '').trim().length < 5,
  );
  if (notesMissing.length) {
    return c.json({
      error: 'condition_notes_required',
      item_ids: notesMissing.map((r) => r.item_id),
    }, 400);
  }

  // Resolve the staff member — default to session user; if supplied, verify.
  let returnedBy = session.user.id;
  if (parsed.data.returned_by_user_id) {
    const u = await query<{ id: string }>(sql`
      SELECT u.id FROM users u
      JOIN workspace_memberships wm ON wm.user_id = u.id
      WHERE u.id = ${parsed.data.returned_by_user_id}::uuid
        AND wm.workspace_id = ${session.workspace.id}::uuid
      LIMIT 1
    `);
    if (u.length === 0) return c.json({ error: 'invalid_user' }, 400);
    returnedBy = parsed.data.returned_by_user_id;
  }

  // Per-item UPDATE (each item gets its own outcome). Loop avoids the JS-array
  // param gotcha; the status guard keeps each write race-safe. Pre-existing
  // condition_notes is preserved when this batch doesn't supply one.
  for (const r of reqItems) {
    await sql`
      UPDATE order_items SET
        status              = ${r.outcome}::order_item_status,
        returned_at         = now(),
        returned_by_user_id = ${returnedBy}::uuid,
        returned_from       = ${received_from ?? null}::text,
        condition_notes     = COALESCE(${r.condition_notes ?? null}::text, condition_notes),
        updated_at          = now()
      WHERE id = ${r.item_id}::uuid
        AND workspace_id = ${session.workspace.id}::uuid
        AND status = 'dispatched'::order_item_status
    `;
  }

  // Release / re-block physical units per outcome (Sub-turn 12b): OK →
  // available (capacity released now, not at close); damaged → available + an
  // auto-created asset-level repair downtime; missing → retired. Reuses the
  // units pinned at dispatch (order_assets). Orders dispatched before this
  // sub-turn have no pinned units, so this is a no-op for them — the item-status
  // change alone still releases their capacity.
  const wsRows = await query<{ settings: any }>(sql`
    SELECT settings FROM workspaces WHERE id = ${session.workspace.id}::uuid LIMIT 1
  `);
  const rawRepairDays = Number(wsRows[0]?.settings?.downtime?.default_repair_days);
  const repairDays = Number.isFinite(rawRepairDays) && rawRepairDays > 0 ? rawRepairDays : 7;
  const dispositions: Disposition[] = [];
  for (const r of reqItems) {
    const d = await applyReturnDisposition({
      workspaceId: session.workspace.id,
      orderId: id,
      orderNumber: Number(order.order_number),
      itemId: r.item_id,
      outcome: r.outcome,
      actorUserId: session.user.id,
      repairDays,
    });
    dispositions.push(...d);
  }

  // Auto-advance to 'returned' once every item is terminal (and the order is
  // still mid-rental).
  const afterItems = await loadItems(id);
  const allTerminal = deriveCanFinalize(afterItems);
  const orderStatusChanged = allTerminal && ['dispatched', 'active'].includes(order.status);
  if (orderStatusChanged) {
    await sql`
      UPDATE orders SET status = 'returned'::order_status, updated_at = now()
      WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    `;
  }

  // Refresh chargeable_paise + tax breakdown + cached totals (order isn't locked).
  await recomputeOrderTotals(id, session.workspace.id, session.user.id);

  const terminalCount = afterItems.filter(
    (it) => (TERMINAL_ITEM_STATUSES as readonly string[]).includes(it.status),
  ).length;

  const payload: Record<string, unknown> = {
    items: reqItems.map((r) => ({
      item_id: r.item_id,
      outcome: r.outcome,
      condition_notes: r.condition_notes ?? null,
    })),
    received_from: received_from ?? null,
    returned_by_user_id: returnedBy,
    auto_order_status_transition: orderStatusChanged,
    terminal_items_count: terminalCount,
    total_items_count: afterItems.length,
    // Sub-turn 12b: physical dispositions (unit → outcome, + any repair downtime).
    asset_dispositions: dispositions,
  };

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: 'order.return.batch',
    fromStatus: order.status,
    toStatus: orderStatusChanged ? 'returned' : order.status,
    payload,
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.return.batch',
    targetType: 'order',
    targetId: id,
    payload,
    ipAddress, userAgent,
  });

  emitNotification({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'order.item.returned',
    targetType: 'order', targetId: id,
    linkUrl: `/order.html?id=${id}`,
    metadata: {
      order_number: order.order_number, count: reqItems.length,
      customer_name: order.customer_name ?? '',
    },
  }).catch(() => {});

  const freshOrder = await loadOrder(id, session.workspace.id);
  const freshItems = await loadItems(id);
  const requestedIds = new Set(reqItems.map((r) => r.item_id));
  const returned = freshItems
    .filter((it) => requestedIds.has(it.id))
    .map((it) => ({
      id: it.id,
      description: it.description,
      status: it.status,
      returned_at: it.returned_at,
      returned_by_user_id: it.returned_by_user_id,
      returned_from: it.returned_from,
      condition_notes: it.condition_notes,
    }));

  return c.json({
    order: freshOrder,
    items_returned: returned,
    order_status_changed: orderStatusChanged,
    can_finalize: deriveCanFinalize(freshItems),
    asset_dispositions: dispositions,
  });
});

// ============================================================================
// DELETE /api/orders/:id — soft delete (only drafts)
// ============================================================================
orders.delete('/:id', requirePermission('orders.edit'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);

  if (order.status !== 'draft') {
    return c.json({
      error: 'not_deletable',
      reason: 'use_cancel_transition_for_non_drafts',
    }, 409);
  }

  await sql`
    UPDATE orders
       SET deleted_at = now(),
           updated_at = now()
     WHERE id = ${id}
       AND workspace_id = ${session.workspace.id}
  `;

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: 'order.deleted',
    fromStatus: order.status,
    payload: { order_number: order.order_number },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.order.deleted',
    targetType: 'order',
    targetId: id,
    payload: { order_number: order.order_number },
    ipAddress, userAgent,
  });

  return c.json({ ok: true });
});
