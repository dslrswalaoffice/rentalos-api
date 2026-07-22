// ============================================================================
// test/kyc_upload_errors.test.ts — KYC upload typed-error surfacing.
// ----------------------------------------------------------------------------
// The upload previously masked every failure as "upload_failed", which hid the
// real cause (a missing Blob token) for a long debug. uploadKYCFiles now returns
// a specific code + a human-readable `detail` for each failure mode. These are
// pure validation branches (no DB, no network) — they return before put().
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';

import { uploadKYCFiles, KYC_MAX_BYTES, KYC_MAX_FILES } from '../src/lib/kyc_upload.js';

const base = { workspaceId: 'ws', personId: 'p', documentType: 'pan' };
const png = () => new File([Buffer.from('PNGDATA')], 'a.png', { type: 'image/png' });

test('invalid_mime_type — wrong type, detail names received vs expected', async () => {
  const r = await uploadKYCFiles({ ...base, files: [new File([Buffer.from('x')], 'a.gif', { type: 'image/gif' })] });
  assert.equal(r.ok, false);
  assert.equal((r as any).error, 'invalid_mime_type');
  assert.match((r as any).detail, /received image\/gif/);
  assert.match((r as any).detail, /application\/pdf/);
});

test('file_size_exceeded — over the cap, detail names received vs cap', async () => {
  const big = new File([new Uint8Array(KYC_MAX_BYTES + 1024)], 'big.png', { type: 'image/png' });
  const r = await uploadKYCFiles({ ...base, files: [big] });
  assert.equal((r as any).error, 'file_size_exceeded');
  assert.match((r as any).detail, /cap 5\.0MB/);
});

test('too_many_files — over the per-document limit', async () => {
  const files = Array.from({ length: KYC_MAX_FILES + 1 }, png);
  const r = await uploadKYCFiles({ ...base, files });
  assert.equal((r as any).error, 'too_many_files');
  assert.match((r as any).detail, new RegExp(`max ${KYC_MAX_FILES}`));
});

test('no_files — empty submission', async () => {
  const r = await uploadKYCFiles({ ...base, files: [] });
  assert.equal((r as any).error, 'no_files');
  assert.ok((r as any).detail);
});

test('blob_token_missing — a valid file with no Blob token in the env', async () => {
  const saved = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const r = await uploadKYCFiles({ ...base, files: [png()] });
    assert.equal((r as any).error, 'blob_token_missing');
    assert.match((r as any).detail, /BLOB_READ_WRITE_TOKEN/);
  } finally {
    if (saved !== undefined) process.env.BLOB_READ_WRITE_TOKEN = saved;
  }
});
