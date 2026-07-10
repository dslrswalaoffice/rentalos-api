import { Hono } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { checkAvailability } from '../lib/availability.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';

// ============================================================================
// src/routes/calendar.ts  (Sub-turn 4b)
// ----------------------------------------------------------------------------
// GET /api/calendar?from=ISO&to=ISO
//   → equipment-first Gantt data: every active product with the rental
//     bookings that overlap [from, to], plus overbook warnings.
//
// Equipment-first = rows are products, X-axis is time, bars are rentals.
// Answers "is X available on Tuesday?" in one glance.
//
// total_units is measured the same way as availability.ts: COUNT(assets) not
// soft-deleted. (There is NO products.total_units column — capacity lives in
// the assets table.)
//
// Bookings excluded: drafts (not commitments) and cancelled (irrelevant).
// Read-only endpoint — no audit event.
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

export const calendar = new Hono<Env>();
calendar.use('*', sessionMiddleware, requireAuth);

const MAX_RANGE_DAYS = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const rangeSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

type ProductRow = {
  id: string;
  name: string;
  sku: string;
  total_units: number;
};

type BookingRow = {
  product_id: string;
  order_id: string;
  order_number: number;
  customer_name: string;
  start: string;
  end: string;
  quantity: number;
  status: string;
};

type Booking = {
  order_id: string;
  order_number: number;
  customer_name: string;
  start: string;
  end: string;
  quantity: number;
  status: string;
};

type Warning = {
  product_id: string;
  product_name: string;
  conflict_start: string;
  conflict_end: string;
  total_units: number;
  requested_units: number;
};

// ----------------------------------------------------------------------------
// Overbook sweep — walk a product's booking edges in time order, tracking the
// running unit count. When it exceeds total_units, open a warning interval;
// close it when the count drops back to within capacity. Ends are applied
// before starts at the same instant so a hand-back-then-re-rent at the same
// timestamp is NOT flagged as a conflict.
// ----------------------------------------------------------------------------
function computeWarnings(product: ProductRow, bookings: Booking[]): Warning[] {
  const events: { t: number; delta: number }[] = [];
  for (const b of bookings) {
    events.push({ t: new Date(b.start).getTime(), delta: b.quantity });
    events.push({ t: new Date(b.end).getTime(), delta: -b.quantity });
  }
  // Time asc; at ties, releases (negative) before reservations (positive).
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);

  const warnings: Warning[] = [];
  let running = 0;
  let open: { start: number; peak: number } | null = null;

  for (const e of events) {
    running += e.delta;
    if (running > product.total_units) {
      if (!open) open = { start: e.t, peak: running };
      else open.peak = Math.max(open.peak, running);
    } else if (open) {
      warnings.push({
        product_id: product.id,
        product_name: product.name,
        conflict_start: new Date(open.start).toISOString(),
        conflict_end: new Date(e.t).toISOString(),
        total_units: product.total_units,
        requested_units: open.peak,
      });
      open = null;
    }
  }
  return warnings;
}

// ============================================================================
// GET /api/calendar?from=...&to=...
// ============================================================================
calendar.get('/', async (c) => {
  const session = c.get('session')!;

  const parsed = rangeSchema.safeParse({
    from: c.req.query('from'),
    to: c.req.query('to'),
  });
  if (!parsed.success) {
    return c.json({
      error: 'invalid_request',
      reason: 'from_and_to_required_as_iso_datetime',
      issues: parsed.error.issues,
    }, 400);
  }
  const { from, to } = parsed.data;

  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  if (toMs <= fromMs) {
    return c.json({ error: 'invalid_request', reason: 'end_before_start' }, 400);
  }
  if (toMs - fromMs > MAX_RANGE_DAYS * MS_PER_DAY) {
    return c.json({ error: 'range_too_large', max_days: MAX_RANGE_DAYS }, 400);
  }

  // All active products for the workspace. total_units from the assets count.
  const products = await query<ProductRow>(sql`
    SELECT
      p.id, p.name, p.sku,
      COALESCE(a.total, 0)::int AS total_units
    FROM products p
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS total
      FROM assets
      WHERE product_id = p.id
        AND workspace_id = p.workspace_id
        AND deleted_at IS NULL
    ) a ON true
    WHERE p.workspace_id = ${session.workspace.id}
      AND p.is_active = true
      AND p.deleted_at IS NULL
    ORDER BY p.name ASC
  `);

  // Rental bookings overlapping the window. One row per (order, product):
  // an order with two rental lines of the same product folds into one bar.
  const bookingRows = await query<BookingRow>(sql`
    SELECT
      oi.product_id,
      o.id            AS order_id,
      o.order_number,
      pe.display_name AS customer_name,
      o.rental_start  AS start,
      o.rental_end    AS end,
      SUM(oi.quantity)::int AS quantity,
      o.status::text  AS status
    FROM order_items oi
    JOIN orders o  ON o.id = oi.order_id
    JOIN people pe ON pe.id = o.customer_person_id
    WHERE oi.workspace_id = ${session.workspace.id}
      AND o.workspace_id  = ${session.workspace.id}
      AND oi.item_type = 'rental'
      AND oi.product_id IS NOT NULL
      AND o.deleted_at IS NULL
      AND o.status::text NOT IN ('draft', 'cancelled')
      AND o.rental_start <= ${to}::timestamptz
      AND o.rental_end   >= ${from}::timestamptz
    GROUP BY oi.product_id, o.id, o.order_number, pe.display_name,
             o.rental_start, o.rental_end, o.status
    ORDER BY o.rental_start ASC
  `);

  // Group bookings by product, normalising timestamps to ISO.
  const byProduct = new Map<string, Booking[]>();
  for (const r of bookingRows) {
    const list = byProduct.get(r.product_id) ?? [];
    list.push({
      order_id: r.order_id,
      order_number: r.order_number,
      customer_name: r.customer_name,
      start: new Date(r.start).toISOString(),
      end: new Date(r.end).toISOString(),
      quantity: Number(r.quantity),
      status: r.status,
    });
    byProduct.set(r.product_id, list);
  }

  // Bars show the full non-draft/cancelled schedule (visual context).
  const productsOut = products.map((p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    total_units: p.total_units,
    bookings: byProduct.get(p.id) ?? [],
  }));

  // Overbook warnings come from the shared availability engine — single source
  // of truth for which statuses actually reserve inventory (confirmed /
  // dispatched / active / returned) and for buffer application. This is
  // intentionally narrower than the bars above: quoted / closed orders appear
  // as bars but don't trigger overbook warnings (they aren't commitments).
  // One call per product for the whole range; we only use `.conflicts`, then
  // run the same interval sweep as before.
  const availResults = await Promise.all(
    products.map((p) =>
      checkAvailability({
        workspaceId: session.workspace.id,
        productId: p.id,
        quantity: 1, // ignored here — we only read `.conflicts`
        start: new Date(from),
        end: new Date(to),
      }).catch(() => null),
    ),
  );

  const warnings: Warning[] = [];
  products.forEach((p, i) => {
    const res = availResults[i];
    if (!res) return;
    const bookings: Booking[] = res.conflicts.map((cf) => ({
      order_id: cf.order_id,
      order_number: cf.order_number,
      customer_name: cf.customer_name ?? '',
      start: cf.start,
      end: cf.end,
      quantity: cf.quantity,
      status: cf.status,
    }));
    warnings.push(...computeWarnings(p, bookings));
  });

  return c.json({
    range: { from, to },
    products: productsOut,
    warnings,
  });
});
