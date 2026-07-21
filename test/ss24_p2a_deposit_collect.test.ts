// ============================================================================
// test/ss24_p2a_deposit_collect.test.ts — SS-2.4 P2a contract + backward-compat
// ----------------------------------------------------------------------------
// Rule A (contract): the exported paymentCreateSchema accepts the deposit
// cheque/custody metadata the new_deposit modal sends, and rejects malformed
// cheque state / custody id.
// Rule E (backward-compat): the cheque/custody fields are OPTIONAL, so a legacy
// collect payload (rental OR deposit) that predates SS-2.4 still parses — the
// endpoint doesn't start rejecting old clients.
//
// DB round-trip (Rule B) + row-level backward-compat run against the Vercel
// preview DB (Rule J) — the repo's automated tests are pure/contract only (no
// DATABASE_URL in CI), same as ss23_contracts.test.ts.
// Run: `npm test`
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentCreateSchema } from '../src/routes/payments.js';

const UUID = '9b4cb857-a7ec-4a53-8ba3-32998a5ce08b';

function parses(body: unknown, label: string) {
  assert.equal(paymentCreateSchema.safeParse(body).success, true, `${label} should PARSE`);
}
function rejects(body: unknown, label: string) {
  assert.equal(paymentCreateSchema.safeParse(body).success, false, `${label} should REJECT`);
}

// ── Rule A — the deposit collect payload the modal sends ─────────────────────
test('paymentCreateSchema — cash deposit collect parses', () => {
  parses({ amount_paise: 500000, method: 'cash', payment_kind: 'deposit',
           custody_holder_user_id: UUID }, 'cash deposit + custody');
});

test('paymentCreateSchema — cheque deposit with method_reference + cheque_status parses', () => {
  parses({
    amount_paise: 500000, method: 'cheque', payment_kind: 'deposit',
    method_reference: { cheque_number: '004521', bank: 'HDFC' },
    cheque_status: 'pending',
    custody_holder_user_id: UUID,
  }, 'cheque deposit full payload');
});

test('paymentCreateSchema — upi deposit with method_reference parses', () => {
  parses({ amount_paise: 500000, method: 'upi', payment_kind: 'deposit',
           method_reference: { upi_ref: 'T2408011234' } }, 'upi deposit');
});

test('paymentCreateSchema — bad cheque_status rejects', () => {
  rejects({ amount_paise: 500000, method: 'cheque', payment_kind: 'deposit',
            cheque_status: 'returned' }, 'invalid cheque_status');
});

test('paymentCreateSchema — non-uuid custody_holder rejects', () => {
  rejects({ amount_paise: 500000, method: 'cash', payment_kind: 'deposit',
            custody_holder_user_id: 'irfan' }, 'non-uuid custody id');
});

// ── Rule E — legacy payloads (pre-SS-2.4) still parse ────────────────────────
test('paymentCreateSchema — legacy rental payment (no deposit fields) still parses', () => {
  parses({ amount_paise: 200000, method: 'upi' }, 'legacy rental');
});

test('paymentCreateSchema — legacy deposit collect (no cheque/custody fields) still parses', () => {
  parses({ amount_paise: 500000, method: 'cash', payment_kind: 'deposit' }, 'legacy deposit');
});
