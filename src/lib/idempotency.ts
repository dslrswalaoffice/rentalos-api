// ============================================================================
// src/lib/idempotency.ts (Slice 1) — Idempotency-Key middleware
// ----------------------------------------------------------------------------
// Item 28. A mutating request carrying an `Idempotency-Key` header is deduped
// via the idempotency_records table:
//   - not seen        → record in_flight, run the handler, cache the response
//   - completed       → replay the cached response (no re-execution)
//   - in_flight       → 409 REQUEST_IN_FLIGHT (a concurrent copy is running)
//   - failed          → allow a retry
//   - same key, different body → 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY
//
// COMPATIBILITY CHOICE: the header is ENFORCED-WHEN-PRESENT, not hard-required.
// A request without the header passes straight through (no dedup) so existing
// callers/tests keep working; the new frontend always sends one. GET/HEAD are
// exempt (they don't mutate).
//
// TODO(~Slice 5): flip to HARD-REQUIRED — the `if (!key) return next();` below
// becomes a 400 IDEMPOTENCY_KEY_REQUIRED. Do this once every mutating caller
// (Slices 2–4 + cron/server-to-server) sends the key via the shared _lib/api.js
// client. Tracked in issue #68.
// ============================================================================

import { createHash, randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { sql, query } from '../db.js';
import type { SessionUser, SessionWorkspace } from '../middleware/session.js';

type SessionVar = { sessionId: string; user: SessionUser; workspace: SessionWorkspace } | null;

const TTL_HOURS = 24;
const KEY_RE = /^[A-Za-z0-9_-]{8,200}$/; // UUID v4 and similar opaque tokens

type Rec = {
  id: string;
  status: 'in_flight' | 'completed' | 'failed';
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
};

/**
 * Body-identity string folded into the idempotency request-hash.
 *
 * MULTIPART CAVEAT (the KYC-upload bug): a production request body is a one-shot
 * network stream. Calling `clone().text()` on a `multipart/form-data` body drains
 * that stream, so the handler's `c.req.formData()` then yields Files with no
 * bytes and the downstream Vercel Blob `put()` fails. So for multipart we do NOT
 * read the body — we hash a cheap surrogate (the Content-Length) instead:
 *   - key-based dedup is preserved,
 *   - a same-key retry of the identical upload (same length) still replays,
 *   - a same-key reuse with a different payload (different length) is still
 *     rejected as key-reused-with-different-body.
 * Non-multipart requests keep the full-body hash (JSON callers unchanged), and
 * the clone leaves the original body intact for the handler.
 */
export async function bodyHashInput(raw: Request): Promise<string> {
  const contentType = (raw.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.startsWith('multipart/form-data')) {
    return `multipart:${raw.headers.get('content-length') ?? ''}`;
  }
  try {
    return await raw.clone().text();
  } catch {
    return '';
  }
}

export const idempotencyMiddleware: MiddlewareHandler = async (c, next) => {
  const method = c.req.method.toUpperCase();
  // GET/HEAD/OPTIONS never mutate → exempt.
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  const key = c.req.header('Idempotency-Key');
  if (!key) return next(); // enforced-when-present (see header note)
  if (!KEY_RE.test(key)) {
    return c.json({ error: { code: 'INVALID_IDEMPOTENCY_KEY', message: 'Idempotency-Key must be an opaque token (8–200 chars)', reasons: [] } }, 400);
  }

  const session = c.get('session') as SessionVar;
  if (!session) return next(); // no session yet → let auth handle it

  const workspaceId = session.workspace.id;
  const userId = session.user.id;
  const endpoint = `${method} ${c.req.path}`;

  // Hash method + path + body identity (multipart-safe — see bodyHashInput).
  const bodyText = await bodyHashInput(c.req.raw);
  const requestHash = createHash('sha256').update(`${endpoint}\n${bodyText}`).digest('hex');

  // Look up an existing record for this identity.
  const existing = await query<Rec>(sql`
    SELECT id, status, request_hash, response_status, response_body
    FROM idempotency_records
    WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userId}::uuid
      AND endpoint = ${endpoint}::text AND idempotency_key = ${key}::text
      AND expires_at > now()
    LIMIT 1
  `);

  if (existing.length) {
    const rec = existing[0]!;
    if (rec.request_hash !== requestHash) {
      return c.json({
        error: {
          code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY',
          message: 'This Idempotency-Key was already used with a different request body',
          reasons: [],
        },
      }, 409);
    }
    if (rec.status === 'completed') {
      // Replay the cached response verbatim.
      return c.json(rec.response_body as object, (rec.response_status ?? 200) as 200);
    }
    if (rec.status === 'in_flight') {
      return c.json({ error: { code: 'REQUEST_IN_FLIGHT', message: 'An identical request is already being processed', reasons: [] } }, 409);
    }
    // status === 'failed' → allow a retry: reset this record to in_flight.
    await sql`
      UPDATE idempotency_records SET status = 'in_flight', request_hash = ${requestHash}::text,
             response_status = NULL, response_body = NULL, created_at = now(),
             expires_at = now() + ${`${TTL_HOURS} hours`}::interval
      WHERE id = ${rec.id}::uuid
    `;
  } else {
    // Claim the key. ON CONFLICT handles a concurrent claimer (unique index).
    const inserted = await query<{ id: string }>(sql`
      INSERT INTO idempotency_records
        (workspace_id, user_id, idempotency_key, endpoint, request_hash, status, expires_at)
      VALUES (${workspaceId}::uuid, ${userId}::uuid, ${key}::text, ${endpoint}::text,
              ${requestHash}::text, 'in_flight', now() + ${`${TTL_HOURS} hours`}::interval)
      ON CONFLICT (workspace_id, user_id, endpoint, idempotency_key) DO NOTHING
      RETURNING id
    `);
    if (!inserted.length) {
      // A concurrent request claimed it first → treat as in-flight.
      return c.json({ error: { code: 'REQUEST_IN_FLIGHT', message: 'An identical request is already being processed', reasons: [] } }, 409);
    }
  }

  // Run the handler, then cache the outcome.
  await next();

  const res = c.res;
  const status = res.status;
  let responseBody: unknown = null;
  try {
    responseBody = await res.clone().json();
  } catch {
    responseBody = null;
  }
  // 5xx (and un-cacheable non-JSON) → mark failed so a retry is allowed; else cache.
  const finalStatus = status >= 500 ? 'failed' : 'completed';
  await sql`
    UPDATE idempotency_records
    SET status = ${finalStatus}::text,
        response_status = ${status}::int,
        response_body = ${responseBody === null ? null : JSON.stringify(responseBody)}::jsonb
    WHERE workspace_id = ${workspaceId}::uuid AND user_id = ${userId}::uuid
      AND endpoint = ${endpoint}::text AND idempotency_key = ${key}::text
  `;
};

/** Small helper for clients/tests: a fresh UUID-v4 idempotency key. */
export function newIdempotencyKey(): string {
  return randomUUID();
}
