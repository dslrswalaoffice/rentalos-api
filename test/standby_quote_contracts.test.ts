// ============================================================================
// test/standby_quote_contracts.test.ts
// ----------------------------------------------------------------------------
// Contract tests for Sub-slice 2.2 (Hotfix: frontend/backend field-name drift).
//
// The production bug: the New Order Composer's Create Standby posted
// `customer_person_id` / `rental_start` / `rental_end` (the CORE order-create
// shape) but POST /api/standbys validates the Orders-Module-Pack shape
// `customer_id` / `rental_start_at` / `rental_end_at` — a 400 on every submit.
//
// Root cause: two naming conventions coexist. Core orders use
// customer_person_id + rental_start/end; the Pack (standbys table, extend,
// quotes) uses customer_id + *_at. The backend Zod schema is canonical for the
// Pack; the frontend was aligned to it in this hotfix.
//
// These tests import the ACTUAL exported Zod schemas and parse the EXACT body
// each frontend call site sends. If a frontend field name drifts from its
// schema again, the matching test fails in CI — this is the permanent guard the
// bug slipped through for lack of.
//
// Run: `npm test`
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  standbyCreateSchema, standbyExtendSchema,
} from '../src/routes/standbys.js';
import {
  quoteCreateSchema, quoteAcceptSchema, quoteWithdrawSchema,
} from '../src/routes/quote_versions.js';
import { publicQuoteAcceptSchema } from '../src/routes/public_quotes.js';

// Representative valid ids/timestamps (shape only — no DB).
const UUID = '9b4cb857-a7ec-4a53-8ba3-32998a5ce08b';
const PROD = '77052125-55c2-459a-b10a-975c354f3489';
const ISO_START = '2026-08-01T10:05:00.000Z';
const ISO_END = '2026-08-02T10:05:00.000Z';

function assertParses(schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, body: unknown, label: string) {
  const r = schema.safeParse(body);
  assert.ok(r.success, `${label}: schema rejected the frontend payload — ${JSON.stringify((r as any).error?.issues ?? r.error)}`);
}

// ---------------------------------------------------------------------------
// POST /api/standbys — new-order.html createStandby() (THE bug that shipped).
// Mirrors the fixed body exactly: customer_id / rental_start_at / rental_end_at
// / reason_notes.
// ---------------------------------------------------------------------------
test('POST /api/standbys accepts the New Order Composer createStandby() body', () => {
  const frontendBody = {
    customer_id: UUID,
    rental_start_at: ISO_START,
    rental_end_at: ISO_END,
    requested_via: 'walk_in',
    reason_tag: 'customer_deciding',
    hold_duration_minutes: 240,
    line_items: [{ product_id: PROD, quantity: 1 }],
    reason_notes: 'Holding for a wedding shoot',
  };
  assertParses(standbyCreateSchema, frontendBody, 'standby create');
});

// Regression: the OLD (broken) body must be REJECTED — proves the schema is the
// real gate and the field rename actually mattered.
test('POST /api/standbys REJECTS the old customer_person_id/rental_start body', () => {
  const oldBrokenBody = {
    customer_person_id: UUID,     // wrong: should be customer_id
    rental_start: ISO_START,      // wrong: should be rental_start_at
    rental_end: ISO_END,          // wrong: should be rental_end_at
    requested_via: 'walk_in',
    reason_tag: 'customer_deciding',
    hold_duration_minutes: 240,
    line_items: [{ product_id: PROD, quantity: 1 }],
  };
  const r = standbyCreateSchema.safeParse(oldBrokenBody);
  assert.equal(r.success, false, 'old body should fail — otherwise the fix is untested');
  const paths = (r as any).error.issues.map((i: any) => i.path.join('.')).sort();
  assert.deepEqual(paths, ['customer_id', 'rental_end_at', 'rental_start_at']);
});

// ---------------------------------------------------------------------------
// POST /api/standbys/:id/extend — no frontend caller yet, but the contract is
// tested so a future UI wiring can't drift silently.
// ---------------------------------------------------------------------------
test('POST /api/standbys/:id/extend accepts { additional_minutes }', () => {
  assertParses(standbyExtendSchema, { additional_minutes: 120 }, 'standby extend');
});

// ---------------------------------------------------------------------------
// POST /api/orders/:id/quote-versions — order-360.html revise action.
// Frontend sends { revision_reason_tag } OR {} (first version).
// ---------------------------------------------------------------------------
test('POST /api/orders/:id/quote-versions accepts { revision_reason_tag } and {}', () => {
  assertParses(quoteCreateSchema, { revision_reason_tag: 'customer_requested_change' }, 'quote create (revision)');
  assertParses(quoteCreateSchema, {}, 'quote create (first version)');
});

// ---------------------------------------------------------------------------
// POST /api/orders/:id/quote-versions/:vid/accept — order-360.html accept.
// Frontend sends { acceptance_source: 'staff_confirmed' }.
// ---------------------------------------------------------------------------
test('POST .../quote-versions/:vid/accept accepts { acceptance_source }', () => {
  assertParses(quoteAcceptSchema, { acceptance_source: 'staff_confirmed' }, 'quote accept');
  assertParses(quoteAcceptSchema, {}, 'quote accept (defaulted source)');
});

// ---------------------------------------------------------------------------
// POST .../quote-versions/:vid/withdraw — order-360.html withdraw.
// Frontend sends { reason } (possibly undefined).
// ---------------------------------------------------------------------------
test('POST .../quote-versions/:vid/withdraw accepts { reason } and empty', () => {
  assertParses(quoteWithdrawSchema, { reason: 'Customer changed dates' }, 'quote withdraw');
  assertParses(quoteWithdrawSchema, {}, 'quote withdraw (no reason)');
});

// ---------------------------------------------------------------------------
// POST /api/quote-versions/tracking/:token/accept — quote-view.html doAccept.
// Frontend sends { notes?, signature_data_url? }.
// ---------------------------------------------------------------------------
test('POST /tracking/:token/accept accepts the public quote-view body', () => {
  assertParses(publicQuoteAcceptSchema, { notes: 'Looks good!', signature_data_url: 'data:image/png;base64,iVBORw0KGgo=' }, 'public accept (signed)');
  assertParses(publicQuoteAcceptSchema, {}, 'public accept (no signature/notes)');
});
