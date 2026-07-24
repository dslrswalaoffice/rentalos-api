// ============================================================================
// test/notification_frontend.test.ts — Slice 10 Session 1, PR-C (frontend).
// ----------------------------------------------------------------------------
// Source-level wiring assertions for the notification-settings page, the review
// queue, and the Q7 cross-reference on person-360 / order-360. The pages need a
// live DB/auth to render, so (like order360_quote_card.test.ts) these guard the
// contract statically: if someone drops an endpoint call or a cross-ref field,
// CI fails here. The module scripts are separately `node --check`-clean.
//
// Run: `npm test`
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('settings-notifications.html — reads + writes the notification policy', () => {
  const html = read('../public/settings-notifications.html');
  assert.match(html, /api\.get\('\/api\/notifications\/policy'\)/);
  assert.match(html, /api\.put\('\/api\/notifications\/policy'/);
  // Per-event mode select offers all four modes, and marketing is read-only (badge only).
  for (const m of ['auto', 'auto_with_review', 'manual_only', 'off']) assert.match(html, new RegExp(`'${m}'`));
  assert.match(html, /renderShell\('system'/);
  // Language + preference scalars are editable.
  assert.match(html, /default_language/);
  assert.match(html, /enforce_customer_preferences/);
});

test('notification_review_queue.html — lists + approves + rejects pending deliveries', () => {
  const html = read('../public/notification_review_queue.html');
  assert.match(html, /api\.get\('\/api\/notifications\/review-queue'/);
  assert.match(html, /\/api\/notifications\/review-queue\/'\+id\+'\/approve/);
  assert.match(html, /\/api\/notifications\/review-queue\/'\+id\+'\/reject/);
  assert.match(html, /renderShell\('system'/);
});

test('person-360.html — notification-preferences card + delivery cross-ref (Q7)', () => {
  const html = read('../public/person-360.html');
  // Preferences read from the person payload + PUT on save.
  assert.match(html, /notification-preferences/);
  assert.match(html, /api\.put\('\/api\/people\/'\+encodeURIComponent\(id\)\+'\/notification-preferences'/);
  // The Communications card now merges automated deliveries with the manual log.
  assert.match(html, /renderComms\(communications,\s*deliveries\)/);
  assert.match(html, /data\.deliveries/);
});

test('order-360.html — Communications card cross-references person_communications (Q7)', () => {
  const html = read('../public/order-360.html');
  assert.match(html, /S\.personComms\s*=\s*r\.person_communications/);
  assert.match(html, /Manual log/);
  // The status map carries the new queued value from the extended CHECK.
  assert.match(html, /queued:\s*\['◷ Queued'/);
});
