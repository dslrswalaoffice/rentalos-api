// ============================================================================
// test/invoice_pdf.test.ts — Slice 6 Session 1 (GST invoice PDF + delivery).
// ----------------------------------------------------------------------------
// Rule A  — contract test for the send schema.
// PDF     — deterministic byte-identical render from the same snapshot (revision
//           integrity), valid %PDF header, Indian-format + amount-in-words.
// Rule E  — composition: the new invoice PDF/issue/send/deliveries routes are
//           mounted AND the existing invoice routes + order transitions survive.
//
// Rule B (real DB round-trip: complete return -> inspection pass -> auto-close ->
//         invoice + pdf_url + delivery rows; both close paths converge) and Rule D
//         (policy toggles) are validated SEPARATELY against real PostgreSQL 16.
//         See the scratchpad invoice_s6_roundtrip.sql.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';
process.env.INTEGRATION_ENC_KEY ??= 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

import { generateInvoicePDF, paiseToINR, rupeesInWords } from '../src/lib/invoice_pdf.js';
import { sendSchema } from '../src/routes/invoices.js';

// ---------- formatting ----------
test('paiseToINR — Indian digit grouping + 2 decimals', () => {
  assert.equal(paiseToINR(0), '0.00');
  assert.equal(paiseToINR(12345), '123.45');
  assert.equal(paiseToINR(100000), '1,000.00');
  assert.equal(paiseToINR(12345678), '1,23,456.78');
  assert.equal(paiseToINR(1234567890), '1,23,45,678.90');
});
test('rupeesInWords — Indian crore/lakh system', () => {
  assert.equal(rupeesInWords(0), 'Zero Rupees Only');
  assert.equal(rupeesInWords(100000), 'One Thousand Rupees Only');
  assert.equal(rupeesInWords(12345678), 'One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees and Seventy Eight Paise Only');
});

// ---------- deterministic PDF ----------
const SNAP = {
  workspace: { legal_name: 'DSLRSWALA', gstin: '24ABCDE1234F1Z5', pan: 'ABCDE1234F', place_of_supply: 'Gujarat', business_address: 'Vadodara', phone: '+91', email: 'a@b.in' },
  customer: { display_name: 'Rahul', gstin: '24XYZ', billing_address: 'Ahmedabad' },
  order: { order_number: 24, rental_start: '2026-01-10', rental_end: '2026-01-15' },
  line_items: [{ description: 'Nanlite', hsn_code: '9006', quantity: 2, chargeable_paise: '100000', cgst_paise: '9000', sgst_paise: '9000', igst_paise: '0', item_type: 'rental' }],
  totals: { subtotal_paise: '100000', discount_paise: '0', tax_paise: '18000', cgst_paise: '9000', sgst_paise: '9000', igst_paise: '0', total_paise: '118000', paid_paise: '0', balance_paise: '118000' },
  gst: { is_intra_state: true, tax_pct: 18 },
  generated_at: '2026-01-15T04:30:00Z',
};
const INV = { invoice_number: '2026-01-15-24-1-R1', issued_at: '2026-01-15', due_date: '2026-01-22', status: 'draft', place_of_supply: 'Gujarat', snapshot: SNAP };

test('generateInvoicePDF — valid PDF + byte-identical for the same snapshot', async () => {
  const a = await generateInvoicePDF(INV, { bank_details: 'HDFC', terms_and_conditions: 'Net 7', footer_note: 'Thanks' });
  const b = await generateInvoicePDF(INV, { bank_details: 'HDFC', terms_and_conditions: 'Net 7', footer_note: 'Thanks' });
  assert.equal(a.slice(0, 5).toString(), '%PDF-', 'must be a PDF');
  assert.ok(a.length > 1000, 'non-trivial size');
  assert.equal(Buffer.compare(a, b), 0, 'same snapshot must render byte-identical (revision integrity)');
});

test('generateInvoicePDF — inter-state (IGST) snapshot also renders', async () => {
  const inter = { ...INV, snapshot: { ...SNAP, gst: { is_intra_state: false, tax_pct: 18 }, line_items: [{ ...SNAP.line_items[0], cgst_paise: '0', sgst_paise: '0', igst_paise: '18000' }], totals: { ...SNAP.totals, cgst_paise: '0', sgst_paise: '0', igst_paise: '18000' } } };
  const pdf = await generateInvoicePDF(inter as any);
  assert.equal(pdf.slice(0, 5).toString(), '%PDF-');
});

// ---------- Rule A: sendSchema ----------
test('sendSchema — channels enum + optional recipient override', () => {
  assert.equal(sendSchema.safeParse({}).success, true);
  assert.equal(sendSchema.safeParse({ channels: ['whatsapp', 'email'] }).success, true);
  assert.equal(sendSchema.safeParse({ channels: ['sms'] }).success, false);
  assert.equal(sendSchema.safeParse({ channels: ['email'], recipient_override: 'x@y.z' }).success, true);
});

// ---------- Rule E: composition ----------
const { app } = await import('../src/app.js');
const { idempotencyMiddleware } = await import('../src/lib/idempotency.js');
const routes = (app as any).routes as Array<{ method: string; path: string; handler: unknown }>;
const paths = new Set(routes.map((r) => r.path));

test('Rule E — new invoice PDF/issue/send/deliveries routes mounted', () => {
  for (const suffix of ['pdf/generate', 'pdf', 'issue', 'send', 'deliveries']) {
    assert.ok(paths.has(`/api/order-invoices/:orderId/:invoiceId/${suffix}`), `missing invoice route: ${suffix}`);
  }
});
test('Rule E — existing invoice + order-close routes survive', () => {
  assert.ok(paths.has('/api/order-invoices/:orderId'), 'list invoices');
  assert.ok(paths.has('/api/order-invoices/:orderId/:invoiceId'), 'get invoice');
  assert.ok(paths.has('/api/order-invoices/:orderId/:invoiceId/transitions'), 'invoice transitions');
  assert.ok(paths.has('/api/orders/:id/transitions'), 'order transitions (operator close)');
  assert.ok(paths.has('/api/inspections/:inspectionId/complete'), 'inspection complete (auto close)');
});
test('Rule E — idempotencyMiddleware still at-most-once per path', () => {
  const byPath = new Map<string, number>();
  for (const r of routes) if (r.handler === idempotencyMiddleware) byPath.set(r.path, (byPath.get(r.path) ?? 0) + 1);
  assert.deepEqual([...byPath.entries()].filter(([, n]) => n > 1), []);
});
