// ============================================================================
// test/approval_executors.test.ts — Approval Engine Unification S1.
// ----------------------------------------------------------------------------
// Rule A — the executor registry: every resource_type resolves, unregistered
//   types fail FAST (never a silent no-op), labels are complete.
// Rule E/source — /decide dispatches through the registry (no inline switch left),
//   gates on approvals.review, createApprovalRequest emits approval_requested, the
//   approvals-tick cron + workflow exist, the permission + templates + migration
//   seed are wired.
//
// Rule B (real PG16: bulk-retire executor idempotency + skip-retired, tick expiry,
//   067 seed on fresh + existing policy) validated SEPARATELY against PostgreSQL 16
//   — captured in the PR.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';

import { getExecutor, REGISTERED_RESOURCE_TYPES, resourceLabel, RESOURCE_LABEL } from '../src/lib/approval_executors.js';
import { PERMISSIONS, PRESETS } from '../src/lib/permissions.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const approvalsRoute = read('../src/routes/approvals.ts');
const approvalsLib = read('../src/lib/approvals.ts');
const cronRoute = read('../src/routes/cron.ts');
const notifyLib = read('../src/lib/notify.ts');
const migration = read('../migrations/067_approval_unification_s1.sql');
const workflow = read('../.github/workflows/approvals-tick.yml');

// ---------- Rule A — registry ----------
test('registry — all five resource types registered + resolvable', () => {
  for (const t of ['order_extension', 'order_cancellation', 'standby', 'quote_withdrawal', 'asset_bulk_retire']) {
    assert.ok(REGISTERED_RESOURCE_TYPES.includes(t), `${t} registered`);
    const ex = getExecutor(t);
    assert.equal(typeof ex.execute, 'function');
    assert.equal(typeof ex.reject, 'function');
  }
});

test('registry — unregistered resource_type FAILS FAST (no silent no-op)', () => {
  assert.throws(() => getExecutor('totally_unknown'), /No approval executor registered/);
});

test('registry — labels complete for every registered type', () => {
  for (const t of REGISTERED_RESOURCE_TYPES) {
    assert.ok(RESOURCE_LABEL[t], `${t} has a label`);
  }
  assert.equal(resourceLabel('asset_bulk_retire'), 'Bulk asset retire');
  assert.equal(resourceLabel('unknown_x'), 'unknown_x'); // falls back to the raw type
});

// ---------- Rule E/source — /decide uses the registry, gated ----------
test('approvals route — dispatches through the registry, inline switch removed', () => {
  assert.match(approvalsRoute, /executeApproval\(executorCtx\)/);
  assert.match(approvalsRoute, /rejectApproval\(executorCtx\)/);
  // The old inline dispatch on resource_type must be gone from the decide arm.
  assert.doesNotMatch(approvalsRoute, /ap\.resource_type === 'order_extension'[\s\S]*?applyExtensionEffects/);
});

test('approvals route — decide gated on approvals.review permission', () => {
  assert.match(approvalsRoute, /can\(session, 'approvals\.review'\)/);
});

test('permissions — approvals.review exists + granted to manager (owner is *)', () => {
  assert.ok('approvals.review' in PERMISSIONS);
  assert.ok((PRESETS.manager as string[]).includes('approvals.review'));
  assert.equal(PRESETS.owner, '*');
  assert.ok(!(PRESETS.staff as string[]).includes('approvals.review'));
});

test('createApprovalRequest — emits approval_requested (fail-soft, flag-gated)', () => {
  assert.match(approvalsLib, /eventType: 'approval_requested'/);
  assert.match(approvalsLib, /approval_requested_notification_enabled !== false/);
});

test('cron — approvals-tick endpoint (expire + remind) + workflow', () => {
  assert.match(cronRoute, /cron\.post\('\/approvals-tick'/);
  assert.match(cronRoute, /status = 'expired'/);
  assert.match(cronRoute, /reminded_at = now\(\)/);
  assert.match(workflow, /\/api\/cron\/approvals-tick/);
});

test('notify — three internal approval templates present', () => {
  for (const k of ['approval_requested', 'approval_expired', 'approval_reminder']) {
    assert.ok(notifyLib.includes(`'${k}':`), `${k} template`);
  }
});

test('migration 067 — seeds via top-level notification_policy merge (065 gotcha) + flag', () => {
  assert.match(migration, /'\{notification_policy\}'/);
  assert.match(migration, /approval_requested_notification_enabled/);
  // Must NOT use the nested {notification_policy,events} path that skips
  // workspaces lacking a policy.
  assert.doesNotMatch(migration, /'\{notification_policy,events\}'/);
});
