// ============================================================================
// test/app_route_composition.test.ts   (Rule G — full-app integration)
// ----------------------------------------------------------------------------
// This is the test class that was MISSING for 5 hotfix cycles. Bug A lived
// entirely in route composition in src/app.ts (two routers — `orders` and
// `quoteVersions` — mounted at the SAME prefix `/api/orders`, each applying
// `idempotencyMiddleware` via `use('*')`). Hono then ran the idempotency
// middleware TWICE per quote-version request: pass 1 wrote the record
// `in_flight`, pass 2 saw it and returned 409 for every fresh key. Every prior
// test exercised schemas/handlers/DB in isolation, BELOW the routing layer, so
// none caught it.
//
// These tests mount the REAL assembled `app` (src/app.ts) and inspect its actual
// route table, plus a source-level mount audit. If anyone re-adds a second
// mount at an existing prefix, or re-adds duplicate global middleware, CI fails.
//
// Run: `npm test`  (requires DATABASE_URL set to any value — neon() is lazy and
// never connects at import; INTEGRATION_ENC_KEY set so the module graph loads.)
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';
process.env.INTEGRATION_ENC_KEY ??= 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

const { app } = await import('../src/app.js');
const { idempotencyMiddleware } = await import('../src/lib/idempotency.js');

// --- 1. The real assembled app must apply idempotencyMiddleware AT MOST ONCE per
//        registered path. Two mounts at the same prefix (Bug A) makes it 2. ----
test('idempotencyMiddleware is registered at most once per path in the real app', () => {
  const byPath = new Map<string, number>();
  for (const r of (app as any).routes as Array<{ method: string; path: string; handler: unknown }>) {
    if (r.handler === idempotencyMiddleware) byPath.set(r.path, (byPath.get(r.path) ?? 0) + 1);
  }
  const doubled = [...byPath.entries()].filter(([, n]) => n > 1);
  assert.deepEqual(
    doubled, [],
    `idempotencyMiddleware is registered more than once for: ${doubled.map(([p, n]) => `${p} (${n}x)`).join(', ')}. ` +
    `This is the Bug A double-mount — two routers share a prefix and both use('*') the middleware.`,
  );
  // And it must still be present for /api/orders (guards against removing it entirely).
  assert.ok([...byPath.keys()].some((p) => p.startsWith('/api/orders')), 'idempotencyMiddleware missing from /api/orders');
});

// --- 2. Quote-version POST routes must exist under /api/orders (the fold kept
//        them reachable — a broken fold would drop them). --------------------
test('quote-version routes are registered under /api/orders', () => {
  const paths = new Set(((app as any).routes as Array<{ path: string }>).map((r) => r.path));
  assert.ok(paths.has('/api/orders/:id/quote-versions'), 'POST /api/orders/:id/quote-versions not registered');
  assert.ok(paths.has('/api/orders/:id/quote-versions/:vid/accept'), 'quote accept route not registered');
});

// --- 3. Dependency-tree audit (source): no two app.route() calls share a base
//        prefix. This is the exact regression guard the sweep recommended. -----
test('no two routers mount at the same base prefix in app.ts', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/app.ts', import.meta.url)), 'utf8');
  // Only real mount statements — skip comment lines (which may quote app.route()
  // in prose, e.g. the note explaining why the second mount was removed).
  const prefixes = src.split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .flatMap((line) => [...line.matchAll(/app\.route\(\s*'([^']+)'/g)].map((m) => m[1]));
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const p of prefixes) { if (seen.has(p)) dups.add(p); else seen.add(p); }
  assert.deepEqual(
    [...dups], [],
    `Duplicate app.route() prefixes: ${[...dups].join(', ')}. Two routers at one prefix double-run use('*') ` +
    `middleware (Bug A). Fold the routes into one router instead.`,
  );
  assert.ok(prefixes.length > 10, 'sanity: expected many mounts');
});

// --- 4. Behavioral proof with real Hono: the FOLDED mount runs the idempotency
//        middleware once → a fresh key gets 201; the DOUBLE mount runs it twice
//        → a fresh key gets 409. (Uses a faithful in-memory model of the
//        middleware, since the real app.request path needs a live DB-backed
//        session; this test guards the routing SHAPE that Bug A broke.) --------
// Both middleware instances must share ONE store — in the real app the two
// idempotencyMiddleware copies share the same idempotency_records DB table.
function makeIdem(store = new Map<string, string>()) {
  return async (c: any, next: any) => {
    const key = c.req.header('Idempotency-Key');
    if (!key) return next();
    if (store.get(key) === 'in_flight') {
      return c.json({ error: { code: 'REQUEST_IN_FLIGHT', message: 'An identical request is already being processed' } }, 409);
    }
    if (!store.has(key)) store.set(key, 'in_flight');
    await next();
    store.set(key, c.res.status >= 500 ? 'failed' : 'completed');
  };
}
function quoteRouter() {
  const r = new Hono();
  r.post('/:id/quote-versions', (c) => c.json({ quote_version: { id: 'qv1', version_number: 1 } }, 201));
  return r;
}

test('FOLDED mount (the fix): fresh key → 201', async () => {
  const orders = new Hono();
  orders.use('*', makeIdem());
  orders.post('/:id/items', (c) => c.text('item'));
  orders.route('/', quoteRouter());            // folded — no second global middleware
  const app2 = new Hono();
  app2.route('/api/orders', orders);           // single mount
  const res = await app2.request('/api/orders/878/quote-versions', { method: 'POST', headers: { 'Idempotency-Key': 'fresh-1' } });
  assert.equal(res.status, 201, 'folded mount must return 201 for a fresh key');
});

test('DOUBLE mount (the bug): fresh key → 409 (documents what we fixed)', async () => {
  const shared = new Map<string, string>();    // both mounts hit the same "table"
  const orders = new Hono();
  orders.use('*', makeIdem(shared));
  orders.post('/:id/items', (c) => c.text('item'));
  // The bug: a second router with its OWN global middleware (registered BEFORE
  // its routes, as it was in the real quote_versions.ts) mounted at the same prefix.
  const quotes = new Hono();
  quotes.use('*', makeIdem(shared));           // second global middleware (the bug)
  quotes.post('/:id/quote-versions', (c) => c.json({ quote_version: { id: 'qv1', version_number: 1 } }, 201));
  const app2 = new Hono();
  app2.route('/api/orders', orders);
  app2.route('/api/orders', quotes);           // second mount at same prefix (the bug)
  const res = await app2.request('/api/orders/878/quote-versions', { method: 'POST', headers: { 'Idempotency-Key': 'fresh-2' } });
  assert.equal(res.status, 409, 'the double mount reproduces Bug A (409 on a fresh key)');
});

// ============================================================================
// Sub-slice 2.3 — Rule G for substitutions + damage incidents (extends the above,
// does not downgrade it). Order-scoped routes are FOLDED into the orders router
// (like quote-versions); id-scoped routes are STANDALONE mounts at distinct
// prefixes (/api/substitutions, /api/damage-incidents) with their own middleware.
// ============================================================================

// --- 5. Folded + standalone 2.3 routes are all registered in the real app. ----
test('2.3 substitution + damage routes are registered in the real assembled app', () => {
  const paths = new Set(((app as any).routes as Array<{ path: string }>).map((r) => r.path));
  // Folded into /api/orders (a broken fold would drop these).
  assert.ok(paths.has('/api/orders/:id/substitutions'), 'POST/GET /api/orders/:id/substitutions missing');
  assert.ok(paths.has('/api/orders/:id/damage-incidents'), 'POST/GET /api/orders/:id/damage-incidents missing');
  // Standalone id-scoped routes.
  assert.ok(paths.has('/api/substitutions/:id/execute'), '/api/substitutions/:id/execute missing');
  assert.ok(paths.has('/api/substitutions/:id/revert'), '/api/substitutions/:id/revert missing');
  assert.ok(paths.has('/api/damage-incidents/:id/save-the-shoot'), '/api/damage-incidents/:id/save-the-shoot missing');
  assert.ok(paths.has('/api/damage-incidents/:id/financial-resolution'), '/api/damage-incidents/:id/financial-resolution missing');
  assert.ok(paths.has('/api/damage-incidents/:id/timeline'), '/api/damage-incidents/:id/timeline missing');
});

// --- 6. Distinct standalone prefixes → NOT a double-mount. The /api/orders folded
//        routes share the orders router's single idempotency pass (test 1 already
//        proves ≤1 per path across the WHOLE app, including these). ------------
test('2.3 standalone mounts use distinct prefixes (no Bug-A double-mount)', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/app.ts', import.meta.url)), 'utf8');
  const mounts = src.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .flatMap((l) => [...l.matchAll(/app\.route\(\s*'([^']+)'/g)].map((m) => m[1]));
  assert.ok(mounts.includes('/api/substitutions'), '/api/substitutions not mounted');
  assert.ok(mounts.includes('/api/damage-incidents'), '/api/damage-incidents not mounted');
  // Neither collides with /api/orders (the folded routes live INSIDE the orders router).
  assert.ok(!mounts.includes('/api/orders/substitutions'), 'unexpected nested-prefix mount');
});

// --- 7. Behavioral proof through the REAL assembled app (app.request): a POST to
//        each new route with NO session must reach auth and 401 — NOT 404. A 404
//        would mean the fold/mount dropped the route (the failure Bug A-class bugs
//        cause). This exercises real Hono routing + the real middleware chain.
//        (A 201 needs a live DB-backed session; that path is covered by the PG16
//        round-trip harnesses — neon can't reach local PG in-process.) ----------
const U = '00000000-0000-0000-0000-000000000000';
for (const [label, path] of [
  ['folded substitutions POST', `/api/orders/${U}/substitutions`],
  ['folded damage POST', `/api/orders/${U}/damage-incidents`],
  ['standalone substitution execute', `/api/substitutions/${U}/execute`],
  ['standalone damage save-the-shoot', `/api/damage-incidents/${U}/save-the-shoot`],
] as const) {
  test(`real app.request: ${label} is wired (401 not 404) with no session`, async () => {
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'rule-g-' + label.replace(/\W+/g, '-') },
      body: JSON.stringify({}),
    });
    assert.notEqual(res.status, 404, `${label}: route not registered (404) — a broken fold/mount`);
    assert.equal(res.status, 401, `${label}: expected 401 (auth runs) — got ${res.status}`);
  });
}
