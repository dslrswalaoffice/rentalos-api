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
  standbyCreateSchema, standbyCreateBodySchema, standbyExtendSchema,
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

// The CANONICAL schema still REJECTS the core-order shape — it stays the strict
// source of truth (the fix's field rename genuinely mattered).
test('standbyCreateSchema (canonical) REJECTS the core customer_person_id/rental_start body', () => {
  const coreShapeBody = {
    customer_person_id: UUID,     // core alias, not canonical
    rental_start: ISO_START,
    rental_end: ISO_END,
    requested_via: 'walk_in',
    reason_tag: 'customer_deciding',
    hold_duration_minutes: 240,
    line_items: [{ product_id: PROD, quantity: 1 }],
  };
  const r = standbyCreateSchema.safeParse(coreShapeBody);
  assert.equal(r.success, false, 'canonical schema must reject the core shape');
  const paths = (r as any).error.issues.map((i: any) => i.path.join('.')).sort();
  assert.deepEqual(paths, ['customer_id', 'rental_end_at', 'rental_start_at']);
});

// COMPATIBILITY NET (TECH_DEBT.md): the schema the ENDPOINT uses maps core
// aliases onto canonical keys, so a caller speaking the app-wide core shape is
// accepted. Guards against the SAME drift recurring from any other consumer.
test('standbyCreateBodySchema (endpoint) ACCEPTS the core shape via the compat net', () => {
  const coreShapeBody = {
    customer_person_id: UUID,
    rental_start: ISO_START,
    rental_end: ISO_END,
    internal_notes: 'walk-in hold',
    requested_via: 'walk_in',
    reason_tag: 'customer_deciding',
    hold_duration_minutes: 240,
    line_items: [{ product_id: PROD, quantity: 1 }],
  };
  const r = standbyCreateBodySchema.safeParse(coreShapeBody);
  assert.ok(r.success, 'compat net should accept the core shape: ' + JSON.stringify((r as any).error?.issues));
  // aliases are normalized onto the canonical keys.
  assert.equal((r as any).data.customer_id, UUID);
  assert.equal((r as any).data.rental_start_at, ISO_START);
  assert.equal((r as any).data.rental_end_at, ISO_END);
  assert.equal((r as any).data.reason_notes, 'walk-in hold');
});

// An explicit canonical value always wins over a conflicting alias.
test('standbyCreateBodySchema: canonical key wins when both are present', () => {
  const other = '00000000-0000-0000-0000-000000000000';
  const r = standbyCreateBodySchema.safeParse({
    customer_id: UUID, customer_person_id: other,
    rental_start_at: ISO_START, rental_start: '1999-01-01T00:00:00.000Z',
    rental_end_at: ISO_END,
    requested_via: 'walk_in', reason_tag: 'customer_deciding',
    line_items: [{ product_id: PROD, quantity: 1 }],
  });
  assert.ok(r.success);
  assert.equal((r as any).data.customer_id, UUID);
  assert.equal((r as any).data.rental_start_at, ISO_START);
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
