// ============================================================================
// test/idempotency_multipart.test.ts — hotfix for the KYC-upload bug.
// ----------------------------------------------------------------------------
// The idempotency middleware hashed the request body via clone().text(). For a
// multipart upload that drains the one-shot body stream, so the handler's
// formData() yields Files with no bytes and Vercel Blob put() fails
// ("upload_failed"). Fix: bodyHashInput() skips the body for multipart and hashes
// the Content-Length surrogate instead.
//
// Rule B — a real multipart body survives bodyHashInput() and reaches the handler
//          with its bytes intact; dedup semantics hold at the hash layer
//          (same length => same hash-input; different length => different).
// Rule E — JSON payloads are still hashed by body CONTENT (Slice 4/5/6/7 callers
//          unchanged) and the JSON body still survives the clone.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';

import { Hono } from 'hono';
import { bodyHashInput } from '../src/lib/idempotency.js';

// ---------- Rule B: a real multipart body reaches the handler intact ----------
test('Rule B — bodyHashInput does NOT drain a multipart body; file bytes survive to the handler', async () => {
  const app = new Hono();
  // Mimic the middleware's body-identity read BEFORE the handler.
  app.use('*', async (c, next) => { await bodyHashInput(c.req.raw); await next(); });
  app.post('/up', async (c) => {
    const form = await c.req.formData();
    const f = form.get('files');
    if (!(f instanceof File)) return c.json({ ok: false, got: typeof f });
    const bytes = new Uint8Array(await f.arrayBuffer());
    return c.json({ ok: true, name: f.name, type: f.type, bytes_read: bytes.length });
  });

  const payload = Buffer.from('PNG-BYTES-abcdefghijklmnopqrstuvwxyz-0123456789'); // 47 bytes
  const fd = new FormData();
  fd.append('document_type', 'pan');
  fd.append('files', new File([payload], 'aadhaar.png', { type: 'image/png' }));

  const res = await app.fetch(new Request('http://x/up', { method: 'POST', body: fd }));
  const body = await res.json() as any;
  assert.equal(body.ok, true, 'file must reach the handler');
  assert.equal(body.name, 'aadhaar.png');
  assert.equal(body.type, 'image/png');
  assert.equal(body.bytes_read, payload.length, 'ALL file bytes must survive (not drained by the middleware)');
});

// ---------- Rule B: multipart hash surrogate + dedup semantics ----------
test('Rule B — multipart hashes the Content-Length surrogate, never the body', async () => {
  const mk = (len: string) => new Request('http://x/up', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=----abc', 'content-length': len },
    body: 'ignored-for-hash',
  });
  assert.equal(await bodyHashInput(mk('12345')), 'multipart:12345');
  // same length -> same hash input -> a same-key retry replays the cached response
  assert.equal(await bodyHashInput(mk('12345')), await bodyHashInput(mk('12345')));
  // different length -> different hash input -> same-key reuse is rejected
  assert.notEqual(await bodyHashInput(mk('12345')), await bodyHashInput(mk('99999')));
});

test('Rule B — multipart body is still fully readable AFTER bodyHashInput (not consumed)', async () => {
  const fd = new FormData();
  fd.append('files', new File([Buffer.from('hello-world')], 'x.png', { type: 'image/png' }));
  const req = new Request('http://x/up', { method: 'POST', body: fd });
  await bodyHashInput(req);                 // must not consume `req`
  const form = await req.formData();        // original still parseable
  const f = form.get('files') as File;
  assert.equal(new Uint8Array(await f.arrayBuffer()).length, 'hello-world'.length);
});

// ---------- Rule E: JSON still hashed by body content, body survives ----------
test('Rule E — JSON requests are hashed by body CONTENT (unchanged behaviour)', async () => {
  const mkJson = (b: string) => new Request('http://x/pay', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: b,
  });
  assert.equal(await bodyHashInput(mkJson('{"amount":100}')), '{"amount":100}');
  // identical JSON -> identical hash input (replay); different JSON -> different (rejected)
  assert.equal(await bodyHashInput(mkJson('{"amount":100}')), await bodyHashInput(mkJson('{"amount":100}')));
  assert.notEqual(await bodyHashInput(mkJson('{"amount":100}')), await bodyHashInput(mkJson('{"amount":200}')));
});

test('Rule E — a cloned JSON body is still readable by the handler', async () => {
  const req = new Request('http://x/pay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"k":1}' });
  const hashInput = await bodyHashInput(req);
  assert.equal(hashInput, '{"k":1}');
  assert.deepEqual(await req.json(), { k: 1 }, 'original JSON body survives the clone');
});

// ---------- Rule E: composition — middleware still mounted at-most-once ----------
test('Rule E — idempotencyMiddleware still at-most-once per path across the app', async () => {
  const { app } = await import('../src/app.js');
  const { idempotencyMiddleware } = await import('../src/lib/idempotency.js');
  const routes = (app as any).routes as Array<{ path: string; handler: unknown }>;
  const byPath = new Map<string, number>();
  for (const r of routes) if (r.handler === idempotencyMiddleware) byPath.set(r.path, (byPath.get(r.path) ?? 0) + 1);
  assert.deepEqual([...byPath.entries()].filter(([, n]) => n > 1), []);
});
