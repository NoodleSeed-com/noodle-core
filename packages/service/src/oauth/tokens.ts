import { createHash, randomBytes } from 'node:crypto';

/** A high-entropy (256-bit) opaque token used for codes, refresh tokens, and upstream-login state. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 hash (hex) of an opaque token. The authorization server stores only the hash, so a store dump
 * never yields a usable credential; the raw value is returned to the client and re-hashed on lookup.
 */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
