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
  // Phase 1 S2 enhancements — all optional, backward compatible (omitted => the
  // pre-S2 unfiltered response). view_status is applied CLIENT-side (warnings
  // depend on the full booking set), so it is not accepted here.
  category: z.string().trim().min(1).max(120).optional(),
  location_id: z.string().uuid().optional(),
  search: z.string().trim().min(1).max(120).optional(),
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
  customer_person_id: string;
  customer_name: string;
  start: string;
  end: string;
  quantity: number;
  status: string;
};

type Booking = {
  order_id: string;
  order_number: number;
  customer_person_id: string;
  customer_name: string;
  start: string;
  end: string;
  quantity: number;
  status: string;
  // Standby soft-reservation metadata (Slice 4). Null / false for non-standby bars.
  is_standby: boolean;
  expires_at: string | null;
  is_grace_period: boolean;
  is_expiring_soon: boolean;
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
// computeWarnings only reads start/end/quantity, so it accepts a minimal
// interval — decoupled from the (richer) Booking shape the API returns.
type BookingInterval = { start: string; end: string; quantity: number };

function computeWarnings(product: ProductRow, bookings: BookingInterval[]): Warning[] {
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
    category: c.req.query('category') || undefined,
    location_id: c.req.query('location_id') || undefined,
    search: c.req.query('search') || undefined,
  });
  if (!parsed.success) {
    return c.json({
      error: 'invalid_request',
      reason: 'from_and_to_required_as_iso_datetime',
      issues: parsed.error.issues,
    }, 400);
  }
  const { from, to, category, location_id, search } = parsed.data;

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
      AND (${category ?? null}::text IS NULL OR p.category = ${category ?? null}::text)
    ORDER BY p.name ASC
  `);

  // Rental bookings overlapping the window. One row per (order, product):
  // an order with two rental lines of the same product folds into one bar.
  const bookingRows = await query<BookingRow>(sql`
    SELECT
      oi.product_id,
      o.id            AS order_id,
      o.order_number,
      pe.id           AS customer_person_id,
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
      -- Location filter (Phase 1 S2): v1 forces pickup = return, so pickup is the
      -- order's location. Omitted => all locations (single-location workspaces).
      AND (${location_id ?? null}::uuid IS NULL OR o.pickup_location_id = ${location_id ?? null}::uuid)
      AND o.rental_start <= ${to}::timestamptz
      AND o.rental_end   >= ${from}::timestamptz
    GROUP BY oi.product_id, o.id, o.order_number, pe.id, pe.display_name,
             o.rental_start, o.rental_end, o.status
    ORDER BY o.rental_start ASC
  `);

  // Standby soft-reservation metadata (Slice 4). Order-backed standby bars pull
  // their expiry + grace window so the calendar can flag holds that are in the
  // grace period or about to expire. One keyed query, only when standby bars exist.
  const standbyOrderIds = [...new Set(bookingRows.filter((r) => r.status === 'standby').map((r) => r.order_id))];
  const standbyMeta = new Map<string, { expires_at: string; grace_period_ends_at: string | null }>();
  if (standbyOrderIds.length) {
    const sbRows = await query<{ order_id: string; expires_at: string; grace_period_ends_at: string | null }>(sql`
      SELECT DISTINCT ON (order_id) order_id, expires_at, grace_period_ends_at
      FROM standbys
      WHERE workspace_id = ${session.workspace.id}::uuid
        AND status = 'active'
        AND order_id::text = ANY(string_to_array(${standbyOrderIds.join(',')}::text, ','))
      ORDER BY order_id, hold_started_at DESC
    `);
    for (const r of sbRows) standbyMeta.set(r.order_id, { expires_at: r.expires_at, grace_period_ends_at: r.grace_period_ends_at });
  }
  const nowMs = Date.now();
  const ONE_HOUR_MS = 3600 * 1000;

  // Group bookings by product, normalising timestamps to ISO.
  const byProduct = new Map<string, Booking[]>();
  for (const r of bookingRows) {
    const list = byProduct.get(r.product_id) ?? [];
    const isStandby = r.status === 'standby';
    const sb = isStandby ? standbyMeta.get(r.order_id) : undefined;
    const expiresMs = sb?.expires_at ? new Date(sb.expires_at).getTime() : null;
    list.push({
      order_id: r.order_id,
      order_number: r.order_number,
      customer_person_id: r.customer_person_id,
      customer_name: r.customer_name,
      start: new Date(r.start).toISOString(),
      end: new Date(r.end).toISOString(),
      quantity: Number(r.quantity),
      status: r.status,
      is_standby: isStandby,
      expires_at: sb?.expires_at ? new Date(sb.expires_at).toISOString() : null,
      is_grace_period: !!(sb?.grace_period_ends_at && new Date(sb.grace_period_ends_at).getTime() > nowMs),
      is_expiring_soon: expiresMs != null && expiresMs > nowMs && expiresMs <= nowMs + ONE_HOUR_MS,
    });
    byProduct.set(r.product_id, list);
  }

  // Downtimes overlapping the window (Sub-turn 8a) — rendered as gray bars,
  // distinct from bookings. One batch query, grouped by product.
  const downtimeRows = await query<{
    product_id: string; start_at: string; end_at: string; reason: string;
    location_id: string | null; location_name: string | null;
  }>(sql`
    SELECT d.product_id, d.start_at, d.end_at, d.reason, d.location_id, l.name AS location_name
    FROM product_downtimes d
    LEFT JOIN locations l ON l.id = d.location_id
    WHERE d.workspace_id = ${session.workspace.id}::uuid
      AND d.start_at <= ${to}::timestamptz
      AND d.end_at   >= ${from}::timestamptz
    ORDER BY d.start_at ASC
  `);
  const dtByProduct = new Map<string, Array<{ start: string; end: string; reason: string; location_name: string | null }>>();
  for (const r of downtimeRows) {
    const list = dtByProduct.get(r.product_id) ?? [];
    list.push({
      start: new Date(r.start_at).toISOString(),
      end: new Date(r.end_at).toISOString(),
      reason: r.reason,
      location_name: r.location_name,
    });
    dtByProduct.set(r.product_id, list);
  }

  // Bars show the full non-draft/cancelled schedule (visual context).
  const productsOut = products.map((p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    total_units: p.total_units,
    bookings: byProduct.get(p.id) ?? [],
    downtimes: dtByProduct.get(p.id) ?? [],
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
    // Exclude downtime rows (Sub-turn 8a) — they aren't bookings and get their
    // own gray bars; counting them here would fire spurious overbook warnings.
    const bookings: BookingInterval[] = res.conflicts
      .filter((cf) => cf.type !== 'downtime')
      .map((cf) => ({
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

  // Search (Phase 1 S2) — server-side text match over product name/sku and each
  // product's booking customer names / order numbers. A product survives if it
  // matches by name/sku OR carries a matching booking; warnings are pruned to the
  // surviving set so the client never renders a mask for a hidden row.
  let outProducts = productsOut;
  let outWarnings = warnings;
  if (search) {
    const q = search.toLowerCase();
    outProducts = productsOut.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      p.sku.toLowerCase().includes(q) ||
      p.bookings.some((b) => (b.customer_name ?? '').toLowerCase().includes(q) || String(b.order_number).includes(q)),
    );
    const keep = new Set(outProducts.map((p) => p.id));
    outWarnings = warnings.filter((w) => keep.has(w.product_id));
  }

  return c.json({
    range: { from, to },
    products: outProducts,
    warnings: outWarnings,
  });
});
