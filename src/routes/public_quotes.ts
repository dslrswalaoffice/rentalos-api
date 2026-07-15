import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { acceptQuoteVersion } from '../lib/quotes.js';

// ============================================================================
// src/routes/public_quotes.ts (Sub-slice 2.2) — /api/quote-versions
// ----------------------------------------------------------------------------
// UNAUTHENTICATED, token-based customer surface. NO session middleware.
// Security posture (Item 7 + pack §B):
//   * Token is a 48-hex-char random string; DB-unique; nulled on supersession /
//     withdrawal / rejection (invalidate_superseded_tracking_links).
//   * An invalid/expired/unknown token returns a GENERIC 404 — never leaks whether
//     a quote exists or which workspace it belongs to.
//   * Per-IP rate limiting (in-memory, best-effort) blunts token brute-forcing.
//   * Views are logged with IP for dispute defense; telemetry incremented atomically.
// ============================================================================
export const publicQuotes = new Hono();

// --- tiny in-memory per-IP rate limiter (best-effort; Vercel recycles) --------
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) { // crude cap so the map can't grow unbounded
    for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  }
  return arr.length > MAX_PER_WINDOW;
}
function ipOf(c: Context): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? 'unknown';
}

const TOKEN_RE = /^[0-9a-f]{32,96}$/;

/** Resolve a live quote by token (only sent/viewed/accepted are viewable). */
async function loadByToken(token: string) {
  const rows = await query<any>(sql`
    SELECT qv.id, qv.workspace_id, qv.order_id, qv.version_number, qv.quote_number, qv.status,
           qv.content_snapshot, qv.diff_from_parent, qv.total_paise, qv.deposit_paise,
           qv.rental_start_at, qv.rental_end_at, qv.valid_until, qv.accepted_at, qv.acceptance_notes,
           w.name AS workspace_name
    FROM quote_versions qv JOIN workspaces w ON w.id = qv.workspace_id
    WHERE qv.tracking_link_url = ${token}::text
      AND qv.status IN ('sent','viewed','accepted')
    LIMIT 1
  `);
  return rows[0] ?? null;
}

// GET /api/quote-versions/tracking/:token — customer view.
publicQuotes.get('/tracking/:token', async (c) => {
  const ip = ipOf(c);
  if (rateLimited(ip)) return c.json({ error: 'rate_limited' }, 429);
  const token = c.req.param('token');
  if (!TOKEN_RE.test(token)) return c.json({ error: 'not_found' }, 404);

  const qv = await loadByToken(token);
  if (!qv) return c.json({ error: 'not_found' }, 404); // generic — no existence leak

  // Expiry: if past valid_until and not accepted, treat as gone.
  if (qv.status !== 'accepted' && qv.valid_until && new Date(qv.valid_until).getTime() < Date.now()) {
    return c.json({ error: 'not_found' }, 404);
  }

  // Telemetry — atomic increment; first view stamps first_viewed_at; sent → viewed.
  if (qv.status !== 'accepted') {
    await sql`
      UPDATE quote_versions SET view_count = view_count + 1, last_viewed_at = now(),
        first_viewed_at = COALESCE(first_viewed_at, now()),
        status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END, updated_at = now()
      WHERE id = ${qv.id}::uuid
    `;
    // View log (audit) with IP for dispute defense.
    await sql`
      INSERT INTO order_events (workspace_id, order_id, event_type, payload, actor_user_id)
      VALUES (${qv.workspace_id}::uuid, ${qv.order_id}::uuid, 'order.quote.viewed',
        ${JSON.stringify({ version_id: qv.id, ip })}::jsonb, NULL)
    `.catch(() => {});
  }

  return c.json({
    quote: {
      quote_number: qv.quote_number, version_number: qv.version_number, status: qv.status,
      workspace_name: qv.workspace_name, content: qv.content_snapshot, diff: qv.diff_from_parent,
      total_paise: Number(qv.total_paise), deposit_paise: Number(qv.deposit_paise),
      rental_start_at: qv.rental_start_at, rental_end_at: qv.rental_end_at, valid_until: qv.valid_until,
      accepted_at: qv.accepted_at, acceptance_notes: qv.acceptance_notes,
    },
  });
});

// POST /api/quote-versions/tracking/:token/accept — customer portal acceptance.
const acceptSchema = z.object({
  signature_data_url: z.string().max(500000).optional(),
  notes: z.string().max(2000).optional(),
});
publicQuotes.post('/tracking/:token/accept', async (c) => {
  const ip = ipOf(c);
  if (rateLimited(ip)) return c.json({ error: 'rate_limited' }, 429);
  const token = c.req.param('token');
  if (!TOKEN_RE.test(token)) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = acceptSchema.safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);

  const qv = await loadByToken(token);
  if (!qv) return c.json({ error: 'not_found' }, 404);
  if (qv.status === 'accepted') return c.json({ accepted: true, already: true });
  if (qv.valid_until && new Date(qv.valid_until).getTime() < Date.now()) return c.json({ error: 'expired' }, 410);

  const r = await acceptQuoteVersion({
    workspaceId: qv.workspace_id, orderId: qv.order_id, versionId: qv.id, actorUserId: null,
    source: 'customer_portal', ip, signatureUrl: parsed.data.signature_data_url ?? null, notes: parsed.data.notes ?? null,
  });
  if (!r.ok) return c.json({ error: r.error ?? 'not_acceptable' }, 409);
  return c.json({ accepted: true });
});
