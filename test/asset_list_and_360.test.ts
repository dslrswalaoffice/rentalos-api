// ============================================================================
// test/asset_list_and_360.test.ts — Asset List S1 (per-unit list + Asset-360
// endpoint + cost redaction + bulk ops).
// ----------------------------------------------------------------------------
// Rule A — the asset-list / bulk-transfer / bulk-retire schemas.
// Rule E — the analytics helpers are fail-soft (no throw with no DB); the new
//          routes are mounted; the new permission key exists; cost redaction is
//          wired at the query layer (source assertion — the security floor).
//
// Rule B (real PG16 round-trip: holder LATERAL join, line-share revenue,
//         bulk-transfer CTE UPDATE, bulk-retire UPDATE) is validated SEPARATELY
//         against PostgreSQL 16 — the Neon HTTP driver can't reach a local PG
//         from `npm test`. Output captured in the PR (scratchpad al.sql).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';

import { assetListSchema, bulkTransferSchema, bulkRetireSchema } from '../src/routes/inventory.js';
import { computeAssetMetricsBatch, computeAssetLifetimeMetrics } from '../src/lib/asset_analytics.js';
import { PERMISSIONS } from '../src/lib/permissions.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// ---------- Rule A ----------
test('assetListSchema — defaults + enum guards', () => {
  const ok = assetListSchema.safeParse({});
  assert.equal(ok.success && ok.data.sort, 'code_asc');
  assert.equal(ok.success && ok.data.limit, 50);
  assert.equal(ok.success && ok.data.offset, 0);
  assert.equal(assetListSchema.safeParse({ status: 'lost' }).success, false);
  assert.equal(assetListSchema.safeParse({ utilization_range: 'high' }).success, false);
  assert.equal(assetListSchema.safeParse({ sort: 'price' }).success, false);
  assert.equal(assetListSchema.safeParse({ limit: 500 }).success, false);
});

test('bulkTransferSchema / bulkRetireSchema — required fields + enums', () => {
  assert.equal(bulkTransferSchema.safeParse({ asset_ids: ['11111111-1111-1111-1111-111111111111'], target_location_id: '22222222-2222-2222-2222-222222222222' }).success, true);
  assert.equal(bulkTransferSchema.safeParse({ asset_ids: [], target_location_id: '22222222-2222-2222-2222-222222222222' }).success, false);
  assert.equal(bulkRetireSchema.safeParse({ asset_ids: ['11111111-1111-1111-1111-111111111111'], reason: 'end_of_life' }).success, true);
  assert.equal(bulkRetireSchema.safeParse({ asset_ids: ['11111111-1111-1111-1111-111111111111'], reason: 'because' }).success, false);
});

// ---------- Rule E ----------
test('the new inventory.retire permission exists', () => {
  assert.ok('inventory.retire' in PERMISSIONS);
});

test('analytics helpers are fail-soft (no DB -> no throw, zeroed shape)', async () => {
  const batch = await computeAssetMetricsBatch('w', ['a5000000-0000-0000-0000-000000000001'], 30);
  assert.ok(batch instanceof Map); // empty on DB failure, never throws
  const life = await computeAssetLifetimeMetrics('w', 'a5000000-0000-0000-0000-000000000001');
  assert.deepEqual(life, { total_revenue_paise: 0, total_days_utilized: 0, total_rentals_count: 0, total_damage_incidents: 0, total_maintenance_days: 0, average_revenue_per_rental_paise: 0 });
});

test('cost redaction is enforced at the query layer (security floor, not just UI)', () => {
  const src = read('../src/routes/inventory.ts');
  // list + detail both null out cost for members without inventory.costs.
  assert.match(src, /!can\(session, 'inventory\.costs'\)/);
  assert.match(src, /default_purchase_cost_paise = null/);
  // the asset list + 360 endpoints gate cost on the same permission.
  assert.match(src, /const showCost = can\(session, 'inventory\.costs'\)/);
});

test('the new asset + bulk routes are mounted', async () => {
  const { app } = await import('../src/app.js');
  const paths = new Set(((app as any).routes as Array<{ path: string }>).map((r) => r.path));
  for (const p of ['/api/inventory/assets', '/api/inventory/assets/:id', '/api/inventory/assets/bulk-location-transfer', '/api/inventory/assets/bulk-retire']) {
    assert.ok([...paths].some((x) => x === p), `${p} must be mounted`);
  }
});
