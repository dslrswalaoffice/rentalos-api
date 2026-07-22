import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import { requirePermission } from '../lib/permissions.js';
import { verifyUnsubscribeToken, sendPendingDelivery, rejectPendingDelivery } from '../lib/notify.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';

// ============================================================================
// src/routes/notifications.ts  (Sub-turn 5d + Slice 10)
// ----------------------------------------------------------------------------
//   GET  /api/notifications                        recipient's recent (30d) list
//   GET  /api/notifications/unread-count            badge count
//   POST /api/notifications/:id/read                mark one read
//   POST /api/notifications/mark-all-read           mark all unread read
//   -- Slice 10 --
//   GET  /api/notifications/unsubscribe/:token      PUBLIC marketing opt-out
//   GET  /api/notifications/review-queue            pending (auto_with_review) list
//   POST /api/notifications/review-queue/:id/approve  send a pending delivery
//   POST /api/notifications/review-queue/:id/reject   skip a pending delivery
//   GET  /api/notifications/policy                   read notification_policy
//   PUT  /api/notifications/policy                   update notification_policy
//
// Member reads/writes are scoped to (workspace_id, recipient_user_id = current
// user). The unsubscribe link is PUBLIC (a logged-out customer clicks it from an
// email), so it is registered BEFORE the auth middleware.
// ============================================================================

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = { Variables: { session: SessionVar } };

function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

export const notifications = new Hono<Env>();

// ============================================================================
// GET /api/notifications/unsubscribe/:token — PUBLIC marketing opt-out (Q6).
// Registered BEFORE the auth middleware: a customer clicks this from an email
// with no session. The HMAC-signed token carries (workspace_id, person_id);
// verifying it sets notification_preferences.marketing = false for that person.
// Renders a tiny confirmation page. Never a hard error (fail-soft).
// ============================================================================
notifications.get('/unsubscribe/:token', async (c) => {
  const page = (title: string, msg: string) =>
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:12vh auto;padding:0 24px;color:#1a1f36;text-align:center}h1{font-size:20px}p{color:#4f566b;line-height:1.5}</style></head><body><h1>${title}</h1><p>${msg}</p></body></html>`;
  const decoded = verifyUnsubscribeToken(c.req.param('token'));
  if (!decoded) return c.html(page('Link expired', 'This unsubscribe link is invalid or has expired.'), 400);
  try {
    await sql`
      UPDATE people
      SET notification_preferences = COALESCE(notification_preferences, '{}'::jsonb) || '{"marketing": false}'::jsonb,
          updated_at = now()
      WHERE id = ${decoded.personId}::uuid AND workspace_id = ${decoded.workspaceId}::uuid
    `;
    await audit({
      workspaceId: decoded.workspaceId, actorUserId: null, eventType: 'notifications.unsubscribed',
      targetType: 'person', targetId: decoded.personId, payload: { channel: 'marketing' },
      ipAddress: clientCtx(c).ipAddress, userAgent: clientCtx(c).userAgent,
    }).catch(() => {});
    return c.html(page('You are unsubscribed', 'You will no longer receive marketing messages. Transactional updates about your rentals will still be sent.'));
  } catch (err) {
    console.error('unsubscribe failed', err);
    return c.html(page('Something went wrong', 'We could not process your request. Please contact the rental house directly.'), 500);
  }
});

notifications.use('*', sessionMiddleware, requireAuth);

const listSchema = z.object({
  cursor: z.string().datetime().optional(), // created_at of last item seen
  limit: z.coerce.number().int().min(1).max(50).default(20),
  unread_only: z.coerce.boolean().default(false),
});

// ============================================================================
// GET /api/notifications
// ============================================================================
notifications.get('/', async (c) => {
  const session = c.get('session')!;

  const parsed = listSchema.safeParse({
    cursor: c.req.query('cursor'),
    limit: c.req.query('limit'),
    unread_only: c.req.query('unread_only'),
  });
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { cursor, limit, unread_only } = parsed.data;

  const rows = await query<{
    id: string; event_type: string; title: string; body: string | null;
    link_url: string | null; read_at: string | null; created_at: string;
    actor_name: string | null;
  }>(sql`
    SELECT n.id, n.event_type, n.title, n.body, n.link_url, n.read_at, n.created_at,
           u.display_name AS actor_name
    FROM notifications n
    LEFT JOIN users u ON u.id = n.actor_user_id
    WHERE n.workspace_id = ${session.workspace.id}::uuid
      AND n.recipient_user_id = ${session.user.id}::uuid
      AND n.created_at > now() - interval '30 days'
      AND (${cursor ?? null}::timestamptz IS NULL OR n.created_at < ${cursor ?? null}::timestamptz)
      AND (${unread_only}::boolean = false OR n.read_at IS NULL)
    ORDER BY n.created_at DESC
    LIMIT ${limit}
  `);

  const next_cursor = rows.length === limit ? rows[rows.length - 1]!.created_at : null;
  return c.json({ notifications: rows, next_cursor });
});

// ============================================================================
// GET /api/notifications/unread-count
// ============================================================================
notifications.get('/unread-count', async (c) => {
  const session = c.get('session')!;
  const rows = await query<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM notifications
    WHERE workspace_id = ${session.workspace.id}::uuid
      AND recipient_user_id = ${session.user.id}::uuid
      AND read_at IS NULL
      AND created_at > now() - interval '30 days'
  `);
  return c.json({ count: rows[0]?.count ?? 0 });
});

// ============================================================================
// POST /api/notifications/:id/read — mark one read (idempotent)
// ============================================================================
// All members: a member marks THEIR OWN notifications read. No gate by design.
notifications.post('/:id/read', async (c) => {
  const session = c.get('session')!;
  const id = c.req.param('id');

  const updated = await query<{ id: string }>(sql`
    UPDATE notifications
    SET read_at = now()
    WHERE id = ${id}
      AND recipient_user_id = ${session.user.id}::uuid
      AND workspace_id = ${session.workspace.id}::uuid
      AND read_at IS NULL
    RETURNING id
  `);

  if (updated.length === 0) {
    return c.json({ id, already_read: true });
  }
  return c.json({ id, already_read: false });
});

// ============================================================================
// POST /api/notifications/mark-all-read
// ============================================================================
// All members: marks the caller's own notifications read. No gate by design.
notifications.post('/mark-all-read', async (c) => {
  const session = c.get('session')!;
  const updated = await query<{ id: string }>(sql`
    UPDATE notifications
    SET read_at = now()
    WHERE workspace_id = ${session.workspace.id}::uuid
      AND recipient_user_id = ${session.user.id}::uuid
      AND read_at IS NULL
    RETURNING id
  `);
  return c.json({ marked: updated.length });
});

// ============================================================================
// GET /api/notifications/review-queue — pending customer deliveries awaiting a
// reviewer (auto_with_review mode). Oldest first. Owner/manager (notifications.review).
// Filters: ?event_type=&search=&limit=&offset=
// ============================================================================
export const reviewListSchema = z.object({
  event_type: z.string().max(80).optional(),
  search: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

notifications.get('/review-queue', requirePermission('notifications.review'), async (c) => {
  const session = c.get('session')!;
  const parsed = reviewListSchema.safeParse({
    event_type: c.req.query('event_type'),
    search: c.req.query('search'),
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  });
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const { event_type, search, limit, offset } = parsed.data;
  const like = search ? `%${search}%` : null;

  const rows = await query<{
    id: string; channel: string; status: string; target_address: string | null;
    target_person_id: string | null; person_name: string | null; person_phone: string | null;
    event_type: string | null; message: string | null; is_marketing: boolean | null;
    order_id: string | null; created_at: string;
  }>(sql`
    SELECT d.id, d.channel, d.status, d.target_address, d.target_person_id,
           p.display_name AS person_name, p.phone AS person_phone,
           d.payload_snapshot->>'event_type' AS event_type,
           d.payload_snapshot->>'message'    AS message,
           (d.payload_snapshot->>'is_marketing')::boolean AS is_marketing,
           d.payload_snapshot->>'order_id'   AS order_id,
           d.created_at
    FROM notification_deliveries d
    LEFT JOIN people p ON p.id = d.target_person_id
    WHERE d.workspace_id = ${session.workspace.id}::uuid
      AND d.notification_id IS NULL
      AND d.status = 'pending'
      AND (${event_type ?? null}::text IS NULL OR d.payload_snapshot->>'event_type' = ${event_type ?? null}::text)
      AND (${like}::text IS NULL OR p.display_name ILIKE ${like}::text OR p.phone ILIKE ${like}::text)
    ORDER BY d.created_at ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const totalRows = await query<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM notification_deliveries d
    WHERE d.workspace_id = ${session.workspace.id}::uuid
      AND d.notification_id IS NULL AND d.status = 'pending'
  `);
  return c.json({ pending: rows, total: totalRows[0]?.count ?? 0, limit, offset });
});

// ============================================================================
// POST /api/notifications/review-queue/:deliveryId/approve — send a pending row.
// ============================================================================
notifications.post('/review-queue/:deliveryId/approve', requirePermission('notifications.review'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('deliveryId');
  const r = await sendPendingDelivery(session.workspace.id, id);
  if (!r.ok) return c.json({ error: r.error ?? 'approve_failed' }, r.error === 'not_found' ? 404 : 409);
  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id, eventType: 'notifications.review.approved',
    targetType: 'notification_delivery', targetId: id, payload: { status: r.status, reason: r.reason ?? null },
    ipAddress, userAgent,
  });
  return c.json({ approved: true, status: r.status, reason: r.reason ?? null });
});

// ============================================================================
// POST /api/notifications/review-queue/:deliveryId/reject — skip a pending row.
// ============================================================================
notifications.post('/review-queue/:deliveryId/reject', requirePermission('notifications.review'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('deliveryId');
  const r = await rejectPendingDelivery(session.workspace.id, id);
  if (!r.ok) return c.json({ error: r.error ?? 'reject_failed' }, 409);
  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id, eventType: 'notifications.review.rejected',
    targetType: 'notification_delivery', targetId: id, payload: {},
    ipAddress, userAgent,
  });
  return c.json({ rejected: true });
});

// ============================================================================
// GET /api/notifications/policy — read the workspace notification policy.
// PUT /api/notifications/policy — update event modes + language/receipt scalars.
// Owner/manager (settings.edit_notifications).
// ============================================================================
notifications.get('/policy', requirePermission('settings.edit_notifications'), async (c) => {
  const session = c.get('session')!;
  const rows = await query<{ policy: Record<string, unknown> | null }>(sql`
    SELECT settings->'notification_policy' AS policy FROM workspaces WHERE id = ${session.workspace.id}::uuid LIMIT 1
  `);
  return c.json({ policy: rows[0]?.policy ?? {} });
});

export const policyUpdateSchema = z.object({
  events: z.record(z.object({ mode: z.enum(['off', 'manual_only', 'auto_with_review', 'auto']) })).optional(),
  default_language: z.enum(['en', 'hi', 'gu']).optional(),
  enable_delivery_receipts: z.boolean().optional(),
  enforce_customer_preferences: z.boolean().optional(),
});

notifications.put('/policy', requirePermission('settings.edit_notifications'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const body = await c.req.json().catch(() => null);
  const parsed = policyUpdateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  // Read-modify-write the nested policy JSONB (Neon HTTP has no dynamic SQL;
  // COALESCE-merge here preserves templates + is_marketing flags + untouched events).
  const rows = await query<{ settings: Record<string, any> | null }>(sql`
    SELECT settings FROM workspaces WHERE id = ${session.workspace.id}::uuid LIMIT 1
  `);
  const settings = (rows[0]?.settings ?? {}) as Record<string, any>;
  const policy = (settings.notification_policy && typeof settings.notification_policy === 'object')
    ? settings.notification_policy : {};
  const events = (policy.events && typeof policy.events === 'object') ? { ...policy.events } : {};

  if (p.events) {
    for (const [evt, val] of Object.entries(p.events)) {
      // Merge mode onto the existing event object so is_marketing (read-only) survives.
      events[evt] = { ...(events[evt] && typeof events[evt] === 'object' ? events[evt] : {}), mode: val.mode };
    }
  }
  const nextPolicy: Record<string, unknown> = { ...policy, events };
  if (p.default_language !== undefined) nextPolicy.default_language = p.default_language;
  if (p.enable_delivery_receipts !== undefined) nextPolicy.enable_delivery_receipts = p.enable_delivery_receipts;
  if (p.enforce_customer_preferences !== undefined) nextPolicy.enforce_customer_preferences = p.enforce_customer_preferences;
  const nextSettings = { ...settings, notification_policy: nextPolicy };

  await sql`
    UPDATE workspaces SET settings = ${JSON.stringify(nextSettings)}::jsonb, updated_at = now()
    WHERE id = ${session.workspace.id}::uuid
  `;
  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id, eventType: 'notifications.policy.updated',
    targetType: 'workspace', targetId: session.workspace.id,
    payload: {
      events_changed: p.events ? Object.keys(p.events) : [],
      default_language: p.default_language ?? null,
      enable_delivery_receipts: p.enable_delivery_receipts ?? null,
      enforce_customer_preferences: p.enforce_customer_preferences ?? null,
    },
    ipAddress, userAgent,
  });
  return c.json({ policy: nextPolicy });
});
