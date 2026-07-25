import { Hono } from 'hono';
import { sql, query } from '../db.js';
import {
  sessionMiddleware, requireAuth,
  type SessionUser, type SessionWorkspace,
} from '../middleware/session.js';
import { can } from '../lib/permissions.js';

// ============================================================================
// src/routes/reviews.ts (Approval Engine S2) — unified "attention" summary.
// ----------------------------------------------------------------------------
// GET /api/reviews/summary → the three review-queue pending counts, each gated by
// the SAME permission that governs its queue, so a member only ever counts the
// work they can actually action. Fail-soft per source (a query error contributes
// 0, never a 500). Powers the single shell badge number.
// ============================================================================

type SessionVar = { sessionId: string; user: SessionUser; workspace: SessionWorkspace } | null;
type Env = { Variables: { session: SessionVar } };

export const reviews = new Hono<Env>();
reviews.use('*', sessionMiddleware, requireAuth);

async function count(qFn: () => Promise<{ n: number }[]>): Promise<number> {
  try { return Number((await qFn())[0]?.n ?? 0); } catch { return 0; }
}

reviews.get('/summary', async (c) => {
  const session = c.get('session')!;
  const ws = session.workspace.id;

  const approvals_pending = can(session, 'approvals.review')
    ? await count(() => query<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM approval_requests WHERE workspace_id = ${ws}::uuid AND status = 'pending'`))
    : 0;
  const kyc_pending = can(session, 'people.review_kyc')
    // Match the KYC queue count: exclude docs whose person is soft-deleted.
    ? await count(() => query<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM kyc_documents d JOIN people p ON p.id = d.person_id WHERE d.workspace_id = ${ws}::uuid AND d.status = 'pending' AND p.deleted_at IS NULL`))
    : 0;
  const notifications_pending = can(session, 'notifications.review')
    // Mirror the review-queue's discriminator exactly: notification_id IS NULL
    // (a customer send awaiting review), NOT every pending delivery row.
    ? await count(() => query<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM notification_deliveries WHERE workspace_id = ${ws}::uuid AND notification_id IS NULL AND status = 'pending'`))
    : 0;

  return c.json({
    approvals_pending, kyc_pending, notifications_pending,
    total_pending: approvals_pending + kyc_pending + notifications_pending,
  });
});
