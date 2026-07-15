// ============================================================================
// test/smtp_send.test.ts
// ----------------------------------------------------------------------------
// Regression for the "Missing credentials for PLAIN" send failure (Sub-slice
// 2.1.5 second hotfix). Root cause: the Settings modal saved `username` (a
// credentialField of type text) into `config` instead of `credentials`, so the
// SMTP adapter's `auth.user` came back undefined and nodemailer rejected the send.
//
// Drives the REAL smtpEmailAdapter against a local SMTP sink that captures the
// AUTH LOGIN exchange, so we assert the transport actually receives a non-empty
// user + pass. Covers Aamir's exact production payload, the username-in-config
// repro (already-saved rows), and the incomplete-auth guard.
// ============================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { encryptJson, decryptJson } from '../src/lib/crypto.js';
import { smtpEmailAdapter } from '../src/lib/adapters/smtp.js';

const PORT = 2526;
const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const AAMIR = { username: 'aamir2307@gmail.com', password: 'opctlhsgebzadfez' };

let captured: { user: string; pass: string } | null = null;
let server: net.Server;

// Minimal SMTP sink implementing AUTH LOGIN so we can read back the credentials
// the transport sent. Not a real MTA — just enough to complete a session.
before(async () => {
  server = net.createServer((sock) => {
    let stage: 'none' | 'user' | 'pass' = 'none';
    let user = '';
    let inData = false; let buf = '';
    sock.write('220 sink\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; sock.write('250 queued\r\n'); } continue; }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250-sink\r\n250 AUTH LOGIN\r\n');
        else if (up === 'AUTH LOGIN') { stage = 'user'; sock.write('334 VXNlcm5hbWU6\r\n'); }
        else if (stage === 'user') { user = Buffer.from(line, 'base64').toString('utf8'); stage = 'pass'; sock.write('334 UGFzc3dvcmQ6\r\n'); }
        else if (stage === 'pass') { const pass = Buffer.from(line, 'base64').toString('utf8'); captured = { user, pass }; stage = 'none'; sock.write('235 ok\r\n'); }
        else if (up.startsWith('MAIL FROM')) sock.write('250 ok\r\n');
        else if (up.startsWith('RCPT TO')) sock.write('250 ok\r\n');
        else if (up === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (up.startsWith('QUIT')) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((res) => server.listen(PORT, '127.0.0.1', res));
  process.env.INTEGRATION_ENC_KEY = KEY;
});
after(() => { server.close(); });

const baseConfig = { host: '127.0.0.1', port: String(PORT), use_tls: 'false', from_email: 'noreply@dslrswala.com', from_name: 'DSLRSWALA' };
const sendArgs = (creds: Record<string, string>, config: Record<string, unknown>) => ({
  to: 'aamir.patel647@gmail.com', from: 'noreply@dslrswala.com', fromName: 'DSLRSWALA',
  subject: 'Test', html: '<pre>hi</pre>', text: 'hi', credentials: creds, config,
});

test('Aamir\'s exact creds round-trip encrypt→decrypt→send with non-empty auth', async () => {
  captured = null;
  // Simulate the save (username IS a credential now) → store → load → decrypt.
  const b64 = encryptJson(AAMIR).toString('base64');
  const decrypted = decryptJson(Buffer.from(b64, 'base64')) as Record<string, string>;
  assert.deepEqual(decrypted, AAMIR);
  const r = await smtpEmailAdapter.send(sendArgs(decrypted, baseConfig));
  assert.equal(r.status, 'sent');
  assert.ok(r.messageId, 'messageId → provider_ref');
  assert.deepEqual(captured, { user: AAMIR.username, pass: AAMIR.password }, 'transport got non-empty user+pass');
});

test('REPRO: username saved in CONFIG (already-saved rows) still authenticates', async () => {
  captured = null;
  // The bug shape: password in credentials, username stranded in config.
  const r = await smtpEmailAdapter.send(sendArgs({ password: AAMIR.password }, { ...baseConfig, username: AAMIR.username }));
  assert.equal(r.status, 'sent');
  assert.equal(captured!.user, AAMIR.username);
  assert.equal(captured!.pass, AAMIR.password);
});

test('incomplete auth (empty creds, e.g. decrypt failure) → clear SMTP_AUTH_INCOMPLETE, no send', async () => {
  captured = null;
  const r = await smtpEmailAdapter.send(sendArgs({}, baseConfig));
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /SMTP_AUTH_INCOMPLETE/);
  assert.equal(captured, null, 'never contacted the server with empty auth');
});
