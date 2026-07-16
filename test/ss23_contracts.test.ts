// ============================================================================
// test/ss23_contracts.test.ts — Rule A contract tests for Sub-slice 2.3
// ----------------------------------------------------------------------------
// Imports the ACTUAL exported Zod schemas and parses the EXACT payload shapes the
// substitution modal + damage-incident modal send. Valid payloads must pass;
// known-broken shapes must reject. Guards against the frontend/backend field
// drift that bit Sub-slice 2.2. Also exercises the pure decision helper
// isFinancialSubstitution (the permission gate hinges on it).
// Run: `npm test`
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  substitutionCreateSchema, substitutionRevertSchema, substitutionRejectSchema,
} from '../src/routes/substitutions.js';
import {
  damageCreateSchema, saveTheShootSchema, financialResolutionSchema, damageRejectSchema,
} from '../src/routes/damage.js';
import { isFinancialSubstitution } from '../src/lib/substitutions.js';

const UUID = '9b4cb857-a7ec-4a53-8ba3-32998a5ce08b';
const UUID2 = '77052125-55c2-459a-b10a-975c354f3489';
const ISO = '2026-08-01T10:05:00.000Z';

function assertParses(schema: { safeParse: (v: unknown) => { success: boolean } }, body: unknown, label: string) {
  const r = schema.safeParse(body);
  assert.equal(r.success, true, `${label} should PARSE`);
}
function assertRejects(schema: { safeParse: (v: unknown) => { success: boolean } }, body: unknown, label: string) {
  const r = schema.safeParse(body);
  assert.equal(r.success, false, `${label} should REJECT`);
}

// ── Substitution create ─────────────────────────────────────────────────────
test('substitutionCreateSchema — the exact modal payload parses', () => {
  assertParses(substitutionCreateSchema, {
    original_order_item_id: UUID,
    original_asset_id: UUID2,
    replacement_product_id: UUID2,
    substitution_type: 'equivalent_product_swap',
    reason_tag: 'unit_damaged_in_rental',
    reason_notes: 'FX3 mount cracked mid-shoot',
    financial_handling: 'no_change',
    timing: 'rush_mid_rental',
  }, 'full substitution');

  // Minimal valid (optional fields omitted).
  assertParses(substitutionCreateSchema, {
    original_order_item_id: UUID,
    substitution_type: 'same_unit_swap',
    reason_tag: 'unit_failed_precheck',
    timing: 'immediate_before_dispatch',
  }, 'minimal substitution');
});

test('substitutionCreateSchema — bad taxonomies / ids reject', () => {
  assertRejects(substitutionCreateSchema, { original_order_item_id: UUID, substitution_type: 'teleport', reason_tag: 'other', timing: 'scheduled' }, 'bad substitution_type');
  assertRejects(substitutionCreateSchema, { original_order_item_id: UUID, substitution_type: 'same_unit_swap', reason_tag: 'made_up', timing: 'scheduled' }, 'bad reason_tag');
  assertRejects(substitutionCreateSchema, { original_order_item_id: 'not-a-uuid', substitution_type: 'same_unit_swap', reason_tag: 'other', timing: 'scheduled' }, 'bad uuid');
  assertRejects(substitutionCreateSchema, { substitution_type: 'same_unit_swap', reason_tag: 'other', timing: 'scheduled' }, 'missing original_order_item_id');
  assertRejects(substitutionCreateSchema, { original_order_item_id: UUID, substitution_type: 'same_unit_swap', reason_tag: 'other', timing: 'whenever' }, 'bad timing');
});

test('substitution revert/reject schemas accept optional reason', () => {
  assertParses(substitutionRevertSchema, {}, 'empty revert');
  assertParses(substitutionRevertSchema, { reason: 'wrong unit picked' }, 'revert with reason');
  assertParses(substitutionRejectSchema, { reason: 'not approved' }, 'reject with reason');
});

// ── isFinancialSubstitution (permission gate) ───────────────────────────────
test('isFinancialSubstitution — only money-touching swaps are financial', () => {
  assert.equal(isFinancialSubstitution('same_unit_swap', 'no_change'), false);
  assert.equal(isFinancialSubstitution('same_product_swap', 'business_absorb'), false);
  assert.equal(isFinancialSubstitution('upgrade_free', 'business_absorb'), false);
  // Type-driven financial.
  assert.equal(isFinancialSubstitution('upgrade_paid', 'no_change'), true);
  assert.equal(isFinancialSubstitution('downgrade_credit', 'no_change'), true);
  // Handling-driven financial.
  assert.equal(isFinancialSubstitution('same_product_swap', 'additional_charge'), true);
  assert.equal(isFinancialSubstitution('equivalent_product_swap', 'credit_to_customer'), true);
});

// ── Damage incident create ──────────────────────────────────────────────────
test('damageCreateSchema — the exact 5-step modal payload parses', () => {
  assertParses(damageCreateSchema, {
    reported_by_type: 'customer_whatsapp',
    occurred_at: ISO,
    incident_type: 'accidental_drop',
    severity: 'major',
    description: 'Dropped on concrete; lens mount cracked.',
    photos: [{ url: 'https://x/1.jpg' }, { url: 'https://x/2.jpg' }],
    affected_items: [
      { order_item_id: UUID, asset_id: UUID2, severity: 'major', photos_after: [{ url: 'https://x/3.jpg' }] },
    ],
    estimated_cost_paise: 4500000,
  }, 'full damage incident');
});

test('damageCreateSchema — bad enums / empty affected_items reject', () => {
  assertRejects(damageCreateSchema, { reported_by_type: 'pigeon', occurred_at: ISO, incident_type: 'accidental_drop', severity: 'major', description: 'x', affected_items: [{ order_item_id: UUID, severity: 'major' }] }, 'bad reported_by_type');
  assertRejects(damageCreateSchema, { reported_by_type: 'staff_observation', occurred_at: ISO, incident_type: 'volcano', severity: 'major', description: 'x', affected_items: [{ order_item_id: UUID, severity: 'major' }] }, 'bad incident_type');
  assertRejects(damageCreateSchema, { reported_by_type: 'staff_observation', occurred_at: ISO, incident_type: 'misuse', severity: 'apocalyptic', description: 'x', affected_items: [{ order_item_id: UUID, severity: 'minor' }] }, 'bad severity');
  assertRejects(damageCreateSchema, { reported_by_type: 'staff_observation', occurred_at: ISO, incident_type: 'misuse', severity: 'minor', description: 'x', affected_items: [] }, 'empty affected_items');
  assertRejects(damageCreateSchema, { reported_by_type: 'staff_observation', occurred_at: 'yesterday', incident_type: 'misuse', severity: 'minor', description: 'x', affected_items: [{ order_item_id: UUID, severity: 'minor' }] }, 'bad occurred_at');
});

// ── Save The Shoot + financial resolution ───────────────────────────────────
test('saveTheShootSchema — all 6 decisions + substitute detail', () => {
  for (const d of ['substitute_with_another_unit', 'dispatch_replacement_keep_damaged', 'early_return_damaged_only', 'continue_with_damaged', 'full_early_return', 'pending']) {
    assertParses(saveTheShootSchema, { operational_decision: d }, `decision ${d}`);
  }
  assertParses(saveTheShootSchema, {
    operational_decision: 'substitute_with_another_unit',
    substitution: { original_order_item_id: UUID, replacement_product_id: UUID2 },
  }, 'substitute with detail');
  assertRejects(saveTheShootSchema, { operational_decision: 'panic' }, 'bad decision');
});

test('financialResolutionSchema — liability + resolution + deposit action', () => {
  assertParses(financialResolutionSchema, {
    customer_liability: 'partial', liability_percent: 60, final_cost_paise: 3000000,
    financial_resolution: 'deposit_plus_additional', deposit_action: 'forfeit_partial', deposit_forfeit_amount_paise: 1500000,
  }, 'full resolution');
  assertRejects(financialResolutionSchema, { customer_liability: 'maybe', financial_resolution: 'customer_pays', deposit_action: 'hold' }, 'bad liability');
  assertRejects(financialResolutionSchema, { customer_liability: 'yes', financial_resolution: 'lottery', deposit_action: 'hold' }, 'bad resolution');
  assertRejects(financialResolutionSchema, { customer_liability: 'yes', liability_percent: 150, financial_resolution: 'customer_pays', deposit_action: 'hold' }, 'liability_percent > 100');
  assertParses(damageRejectSchema, { reason: 'insufficient evidence' }, 'reject with reason');
});
