import crypto from 'node:crypto';

// ============================================================================
// src/lib/crypto.ts  (Sub-turn 6a)
// ----------------------------------------------------------------------------
// AES-256-GCM encrypt/decrypt for integration credentials at rest.
// Key comes from INTEGRATION_ENC_KEY (64-char hex = 32 bytes). Read lazily so a
// missing key only breaks the integration endpoints, not the whole backend at
// startup — every integration read/write funnels through getKey() and throws a
// clear error if it's absent.
// ============================================================================

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Thrown when INTEGRATION_ENC_KEY is missing or malformed. A TYPED error (not a
 * bare Error) so callers can catch it specifically and return an actionable,
 * structured response instead of a generic 500 — the SMTP-save hotfix: a missing
 * key must tell the operator "set INTEGRATION_ENC_KEY", not "internal_error".
 */
export class EncKeyMissingError extends Error {
  code = 'ENCRYPTION_KEY_UNAVAILABLE' as const;
  constructor(message = 'INTEGRATION_ENC_KEY missing or invalid (expected 64-char hex)') {
    super(message);
    this.name = 'EncKeyMissingError';
  }
}

/** True when a usable 64-char-hex key is configured. Never throws. */
export function encKeyAvailable(): boolean {
  const hex = process.env.INTEGRATION_ENC_KEY;
  return !!hex && hex.length === 64 && /^[0-9a-fA-F]+$/.test(hex);
}

function getKey(): Buffer {
  const hex = process.env.INTEGRATION_ENC_KEY;
  if (!hex || hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new EncKeyMissingError();
  }
  return Buffer.from(hex, 'hex');
}

export function encryptJson(obj: unknown): Buffer {
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Layout: [IV | authTag | ciphertext]
  return Buffer.concat([iv, authTag, encrypted]);
}

export function decryptJson(buf: Buffer): unknown {
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}
