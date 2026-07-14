-- 039_idempotency_records.sql — Slice 1: idempotency for mutating endpoints.
-- ---------------------------------------------------------------------------
-- A client sends a UUID-v4 Idempotency-Key per user action. The server records
-- {key, user_id, endpoint, request_hash, response} so a retry (flaky network,
-- double-tap) replays the original response instead of duplicating a dispatch /
-- return / payment. 24h TTL. Same key + different body → 409 (key reuse).
--
-- Fully additive + idempotent (IF NOT EXISTS). Runs inside the transactional
-- migration runner (migration discipline).

CREATE TABLE IF NOT EXISTS idempotency_records (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text        NOT NULL,
  endpoint        text        NOT NULL,          -- "METHOD /api/orders/:id/dispatch"
  request_hash    text        NOT NULL,          -- sha256(method + path + body)
  status          text        NOT NULL DEFAULT 'in_flight'
                              CHECK (status IN ('in_flight', 'completed', 'failed')),
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  -- One record per (workspace, user, endpoint, key) — the dedup identity.
  UNIQUE (workspace_id, user_id, endpoint, idempotency_key)
);

-- Sweep index for TTL expiry (a later cron/lazy-delete removes expired rows).
CREATE INDEX IF NOT EXISTS idempotency_records_expiry_idx
  ON idempotency_records (expires_at);

COMMENT ON TABLE idempotency_records IS
  'Slice 1 idempotency ledger. Replays the original response for a repeated Idempotency-Key; 24h TTL; same key + different body → 409.';
