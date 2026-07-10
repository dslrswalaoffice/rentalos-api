import { Hono } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';

// ============================================================================
// src/routes/notifications.ts  (Sub-turn 5d)
// ----------------------------------------------------------------------------
//   GET  /api/notifications                 recipient's recent (30d) list, paged
//   GET  /api/notifications/unread-count     badge count
//   POST /api/notifications/:id/read         mark one read
//   POST /api/notifications/mark-all-read    mark all unread read
//
// Everything is scoped to (workspace_id, recipient_user_id = current user).
// No audit events — reads are too noisy; the underlying action is already
// audited.
// ============================================================================

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = { Variables: { session: SessionVar } };

export const notifications = new Hono<Env>();
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
