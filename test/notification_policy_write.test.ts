// ============================================================================
// test/notification_policy_write.test.ts — hotfix regression for the Slice 10
// notification-policy save (production incident: "Save failed: internal_error").
// ----------------------------------------------------------------------------
// ROOT CAUSE: PUT /api/notifications/policy ran
//   UPDATE workspaces SET settings = …::jsonb, updated_at = now()
// but `workspaces` has NO updated_at column (migration 001 defines only
// created_at + deleted_at). Postgres 500'd; the global handler masked it as an
// opaque internal_error.
//
// Rule E (static regression guard — runs in `npm test`, would have caught the
//         bug): the policy handler's UPDATE writes `settings` alone and never
//         references a non-existent `updated_at` on workspaces; the global error
//         handler now attaches a `detail` so a future opaque 500 can't hide.
//
// Rule B (real DB round-trip): the fixed UPDATE runs against the fully-migrated
//         PostgreSQL 16 schema and settings.notification_policy persists. The
//         Neon HTTP driver can't reach a local Postgres from `npm test`, so this
//         is executed against real PG16 via the scratchpad round-trip
//         (notif_policy_write_roundtrip.sql) and captured in the PR — the exact
//         `UPDATE workspaces SET settings = …::jsonb WHERE id = …` statement plus
//         a read-back of settings->'notification_policy'.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('policy handler UPDATE writes settings only — never workspaces.updated_at', () => {
  const src = read('../src/routes/notifications.ts');
  // Isolate the UPDATE workspaces statement in the policy PUT.
  const m = src.match(/UPDATE workspaces SET settings[\s\S]*?WHERE id = \$\{session\.workspace\.id\}/);
  assert.ok(m, 'the policy handler must UPDATE workspaces.settings');
  const stmt = m![0];
  // The regression: no reference to a non-existent updated_at column here.
  assert.equal(/updated_at/.test(stmt), false, 'workspaces has no updated_at column — do not set it');
  assert.match(stmt, /settings = \$\{JSON\.stringify\(nextSettings\)\}::jsonb/);
});

test('workspaces has no updated_at column (guards the assumption the fix relies on)', () => {
  const mig = read('../migrations/001_init.sql');
  const create = mig.match(/CREATE TABLE workspaces \(([\s\S]*?)\);/);
  assert.ok(create, 'workspaces CREATE TABLE present in 001');
  assert.equal(/\bupdated_at\b/.test(create![1]), false, 'workspaces defines created_at + deleted_at, no updated_at');
});

test('global error handler attaches a detail so a 500 is no longer opaque (Lesson N)', () => {
  const app = read('../src/app.ts');
  const m = app.match(/app\.onError\(\(err, c\) => \{[\s\S]*?\}\);/);
  assert.ok(m, 'app.onError handler present');
  assert.match(m![0], /detail/);
  assert.match(m![0], /err instanceof Error \? err\.message/);
});

test('the settings-notifications page surfaces detail on a failed save', () => {
  const html = read('../public/settings-notifications.html');
  assert.match(html, /err\.body\.detail\|\|err\.body\.error/);
});
