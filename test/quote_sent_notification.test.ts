// ============================================================================
// test/quote_sent_notification.test.ts   (PR #81)
// ----------------------------------------------------------------------------
// Bug: clicking "Send" on a quote version never emailed the customer, and
// notification_deliveries had ZERO rows with event_type='quote_sent' — while the
// manual "Send Update" flow worked. Root cause: sendQuoteVersion FIRE-AND-FORGOT
// the emit (`emitCustomerNotification({…}).catch(()=>{})`). This runs in a Vercel
// serverless function; once the HTTP handler returns, un-awaited async work is
// frozen. The notification_deliveries INSERT happens LAST (after the slow SMTP
// send), so the whole chain was killed before the row was written — hence zero
// rows (a MISSING TEMPLATE would instead have written a `no_template` skipped
// row). The manual flow `await`s its emit; this test locks the same discipline
// onto the quote flows.
//
// These are contract/source-level assertions because a true "POST endpoint →
// assert row" needs the live DB-backed app (the neon HTTP driver can't reach a
// local Postgres, and node:test mock.module isn't available in this runtime).
// The exact behavior is verified end-to-end by Aamir sending a quote in prod and
// checking for a quote_sent row; the DB-level insert shape is proven in
// scripts/quote_sent_notification_pg16.ts.
//
// Run: `npm test`
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// Pull out a named async function body from quotes.ts so assertions are scoped.
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} not found`);
  // crude but sufficient: from the signature to the next `export async function`.
  const rest = src.slice(start + 1);
  const next = rest.indexOf('\nexport async function ');
  return rest.slice(0, next < 0 ? undefined : next);
}

const quotes = read('../src/lib/quotes.ts');

test('sendQuoteVersion emits quote_sent AND awaits it (not fire-and-forget)', () => {
  const body = fnBody(quotes, 'sendQuoteVersion');
  assert.match(body, /eventType:\s*'quote_sent'/, 'sendQuoteVersion must emit event_type quote_sent');
  assert.match(body, /await\s+emitCustomerNotification\(/, 'the quote_sent emit MUST be awaited (serverless kills fire-and-forget)');
  // Regression guard: the old fire-and-forget shape must be gone.
  assert.doesNotMatch(body, /emitCustomerNotification\([\s\S]*?\)\.catch\(\s*\(\)\s*=>/,
    'quote_sent emit is fire-and-forget again — it will be killed by the serverless freeze');
});

test('acceptQuoteVersion awaits its notification emits too', () => {
  const body = fnBody(quotes, 'acceptQuoteVersion');
  assert.match(body, /await\s+emitNotification\(/, 'quote_accepted_internal emit must be awaited');
  assert.match(body, /await\s+emitCustomerNotification\(/, 'quote_accepted customer emit must be awaited');
  assert.doesNotMatch(body, /emit(Customer)?Notification\([\s\S]*?\)\.catch\(\s*\(\)\s*=>/,
    'accept emits are fire-and-forget again');
});

test('quote_sent email template is seeded and its key matches the emit event_type', () => {
  const migration = read('../migrations/045_quote_versions.sql');
  // Template exists under notification_policy.templates.quote_sent.email.
  assert.match(migration, /'quote_sent',\s*jsonb_build_object\(\s*'email'/, 'migration 045 must seed a quote_sent email template');
  // It references the merge fields the emit provides (Memory #23 vocabulary).
  for (const token of ['{customer_name}', '{quote_number}', '{total_amount}', '{tracking_url}', '{workspace_name}']) {
    assert.ok(migration.includes(token), `quote_sent template should use ${token}`);
  }
  // The pipeline looks up the template by event_type (notify.ts:
  // settings.notification_policy.templates[eventType]). So the emit's event_type
  // string MUST equal the seeded template key, or it resolves no template and
  // silently skips — the exact 'quote_sent' vs 'quote.sent' / 'quote_sent_customer'
  // mismatch the investigation flagged.
  const emitEvent = quotes.match(/eventType:\s*'(quote_sent)'/)?.[1];
  const templateKey = migration.match(/'(quote_sent)',\s*jsonb_build_object\(\s*'email'/)?.[1];
  assert.equal(emitEvent, 'quote_sent', 'emit event_type');
  assert.equal(templateKey, 'quote_sent', 'seeded template key');
  assert.equal(emitEvent, templateKey, 'emit event_type must equal the template key');
});
