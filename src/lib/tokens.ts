import { randomBytes, createHash } from 'node:crypto';

/**
 * 32 bytes of CSPRNG → ~256 bits of entropy. base64url so it's safe in URLs
 * and cookies without escaping.
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 of the token. We only ever store the hash. The plaintext token lives
 * in the cookie / password-reset URL and nowhere else server-side.
 */
export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}
