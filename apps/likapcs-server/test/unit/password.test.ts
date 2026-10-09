import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, verifyPassword } from '../../src/security/password.js';
import { generateToken, hashToken } from '../../src/security/tokens.js';

describe('password hashing (scrypt)', () => {
  it('hashes and verifies, with a unique salt per hash', async () => {
    const a = await hashPassword('Correct-Horse-9');
    const b = await hashPassword('Correct-Horse-9');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$65536$8$1$')).toBe(true);
    expect(await verifyPassword('Correct-Horse-9', a)).toBe(true);
    expect(await verifyPassword('correct-horse-9', a)).toBe(false);
    expect(await verifyPassword('', a)).toBe(false);
  });

  it('rejects malformed stored hashes instead of throwing', async () => {
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$a$b$c$d$e')).toBe(false);
  });

  it('flags weak parameters for rehash', async () => {
    const strong = await hashPassword('Abcdef123');
    expect(needsRehash(strong)).toBe(false);
    expect(needsRehash('scrypt$16384$8$1$c2FsdA==$aGFzaA==')).toBe(true);
    expect(needsRehash('bcrypt$whatever')).toBe(true);
  });
});

describe('tokens', () => {
  it('generates unpredictable base64url tokens and stable hashes', () => {
    const t1 = generateToken();
    const t2 = generateToken();
    expect(t1).not.toBe(t2);
    expect(t1).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashToken(t1)).toBe(hashToken(t1));
    expect(hashToken(t1)).not.toBe(hashToken(t2));
    expect(hashToken(t1)).toMatch(/^[0-9a-f]{64}$/);
  });
});
