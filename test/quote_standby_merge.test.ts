// ============================================================================
// test/quote_standby_merge.test.ts
// ----------------------------------------------------------------------------
// Merge-field regression for Sub-slice 2.2 (Standby + Quote Versioning).
//
// The 2.1.5 email work shipped three bugs of the same shape: a customer email
// went out with an UNRESOLVED `{token}` or an EMPTY merge field (e.g. "Order
// #" with no number, or a signature line "Thank you,\n" with a blank workspace
// name). This test locks that class out for every 2.2 customer template.
//
// It uses the REAL `substitute()` from notify.ts, the EXACT default template
// bodies seeded by migrations 044/045, and the EXACT variable objects the code
// passes at each emit site. emitCustomerNotification seeds `workspace_name`
// from the workspace row FIRST, then spreads the caller's variables — that
// order is replicated here.
//
// The critical guard: quotes.ts must NOT pass `workspace_name: ''`, because the
// spread would clobber the resolved name and the email would render blank. Each
// template×site pairing is asserted to resolve every token it references.
//
// Run: `npm test`
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { substitute } from '../src/lib/notify.js';

const WS = 'DSLRSWALA';

// Exact default email templates as seeded by migrations 044_standbys.sql /
// 045_quote_versions.sql (verified against the seeded workspace row).
const TEMPLATES: Record<string, { subject: string; body: string }> = {
  quote_sent: {
    subject: 'Your quote {quote_number} from {workspace_name}',
    body:
      'Hi {customer_name},\n\nYour quote {quote_number} for {total_amount} is ready. Rental window: {rental_start} to {rental_end}. This quote is valid until {valid_until}.\n\nView and accept it here: {tracking_url}\n\nThank you,\n{workspace_name}',
  },
  quote_reminder: {
    subject: 'Reminder: your quote {quote_number} is waiting',
    body:
      'Hi {customer_name},\n\nA quick reminder about quote {quote_number} for {total_amount}, valid until {valid_until}. You can review and accept it here: {tracking_url}\n\nThank you,\n{workspace_name}',
  },
  quote_expiring: {
    subject: 'Your quote {quote_number} expires on {valid_until}',
    body:
      'Hi {customer_name},\n\nYour quote {quote_number} for {total_amount} expires on {valid_until}. Accept it here before then to lock in your booking: {tracking_url}\n\nThank you,\n{workspace_name}',
  },
  quote_accepted: {
    subject: 'Quote {quote_number} accepted — order confirmed',
    body:
      'Hi {customer_name},\n\nThank you — quote {quote_number} for {total_amount} has been accepted and your order #{order_number} is confirmed. We’ll be in touch with next steps.\n\n{workspace_name}',
  },
  standby_expiring: {
    subject: 'Your hold on order {standby_number} expires soon',
    body:
      'Hi {customer_name},\n\nYour hold {standby_number} ({items_summary}) expires at {expires_at}. Let us know soon if you’d like to confirm the booking.\n\nThank you,\n{workspace_name}',
  },
  standby_expired: {
    subject: 'Your hold {standby_number} has expired',
    body:
      'Hi {customer_name},\n\nYour hold {standby_number} has expired and the equipment has been released. If you’d still like it, reply within {reclaim_minutes} minutes and we’ll try to reclaim it.\n\nThank you,\n{workspace_name}',
  },
};

// The EXACT variable objects the code passes at each emit site.
//  - quote_sent      → src/lib/quotes.ts sendQuoteVersion   (workspace_name OMITTED — resolved by notify)
//  - quote_accepted  → src/lib/quotes.ts acceptQuoteVersion (workspace_name OMITTED — resolved by notify)
//  - quote_reminder / quote_expiring → src/routes/cron.ts   (workspace_name = ws.name)
//  - standby_expiring / standby_expired → src/routes/cron.ts (workspace_name = ws.name)
const CALLER_VARS: Record<string, Record<string, unknown>> = {
  quote_sent: {
    customer_name: 'Rahul', quote_number: 'Q-2026-0007', total_amount: '₹12,500',
    rental_start: '01 Aug 2026', rental_end: '05 Aug 2026', valid_until: '20 Jul 2026',
    tracking_url: 'https://app/quote-view.html?token=abc',
  },
  quote_reminder: {
    customer_name: 'Rahul', quote_number: 'Q-2026-0007', total_amount: '₹12,500',
    valid_until: '20 Jul 2026', tracking_url: 'https://app/quote-view.html?token=abc',
    workspace_name: WS,
  },
  quote_expiring: {
    customer_name: 'Rahul', quote_number: 'Q-2026-0007', total_amount: '₹12,500',
    valid_until: '20 Jul 2026', tracking_url: 'https://app/quote-view.html?token=abc',
    workspace_name: WS,
  },
  quote_accepted: {
    customer_name: 'Rahul', quote_number: 'Q-2026-0007', order_number: 24, total_amount: '₹12,500',
  },
  standby_expiring: {
    customer_name: 'Rahul', standby_number: 'SB-2026-0003', items_summary: '2× Sony FX3',
    expires_at: '15 Jul 2026 14:30', workspace_name: WS,
  },
  standby_expired: {
    customer_name: 'Rahul', standby_number: 'SB-2026-0003', reclaim_minutes: 60, workspace_name: WS,
  },
};

for (const eventType of Object.keys(TEMPLATES)) {
  test(`${eventType} email resolves every merge field (no leftover/empty tokens)`, () => {
    // Replicate emitCustomerNotification: workspace default first, caller vars win.
    const vars = { workspace_name: WS, ...CALLER_VARS[eventType] };
    for (const field of ['subject', 'body'] as const) {
      const raw = TEMPLATES[eventType][field];
      const out = substitute(raw, vars);
      // 1. No literal {token} survived (the unresolved-token bug).
      const leftover = out.match(/\{[a-z_]+\}/gi);
      assert.equal(leftover, null, `${eventType}.${field} has unresolved tokens: ${leftover?.join(', ')}`);
      // 2. Any {workspace_name} the template references renders non-empty (the
      //    empty-field bug: passing '' would clobber the resolved name).
      if (raw.includes('{workspace_name}')) {
        assert.ok(out.includes(WS), `${eventType}.${field} did not render the workspace name`);
      }
      // 3. No tell-tale empty patterns: "#<EOL>" (blank order number).
      assert.ok(!/#\s*$/m.test(out), `${eventType}.${field} has an empty "#" (blank order number)`);
    }
  });
}

// Direct contract test for substitute(): present→value, empty→empty, missing→literal.
test('substitute: present value fills, missing token stays literal, empty renders empty', () => {
  assert.equal(substitute('Hi {name}, order #{n}', { name: 'A', n: 7 }), 'Hi A, order #7');
  assert.equal(substitute('Hi {name}', {}), 'Hi {name}');
  assert.equal(substitute('X{gap}Y', { gap: '' }), 'XY');
});

// The specific 2.2 regression: passing workspace_name:'' clobbers the resolved
// name. Prove the spread order matters and that OMITTING it preserves the name.
test('omitting workspace_name preserves the notify-resolved value; passing empty clobbers it', () => {
  const tpl = 'from {workspace_name}';
  // Correct (fixed) path — caller omits workspace_name.
  assert.equal(substitute(tpl, { workspace_name: WS, ...{ customer_name: 'x' } }), `from ${WS}`);
  // Buggy path (what we removed) — caller passes '' and clobbers it.
  assert.equal(substitute(tpl, { workspace_name: WS, ...{ workspace_name: '' } }), 'from ');
});
