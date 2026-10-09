import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** Opaque bearer tokens: 256 bits of randomness, base64url. Only the SHA-256 hash is stored. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function newId(): string {
  return randomUUID();
}
