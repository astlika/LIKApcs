import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/**
 * Password hashing with scrypt (built into Node, no native dependency to break Windows builds).
 * Parameters follow OWASP guidance (N = 2^16, r = 8, p = 1 → 64 MiB per hash).
 * Stored format is self-describing so parameters can be raised later without breaking logins:
 *   scrypt$N$r$p$<salt base64>$<hash base64>
 */
const DEFAULT_N = 2 ** 16;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function maxmemFor(N: number, r: number): number {
  return 128 * N * r * 2; // generous headroom above the theoretical requirement
}

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('password must be a non-empty string');
  }
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
    maxmem: maxmemFor(DEFAULT_N, DEFAULT_R),
  });
  return [
    'scrypt',
    DEFAULT_N,
    DEFAULT_R,
    DEFAULT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    expected.length === 0
  ) {
    return false;
  }
  const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N,
    r,
    p,
    maxmem: maxmemFor(N, r),
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** True when a stored hash uses weaker parameters than the current defaults (re-hash on login). */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return (
    Number(parts[1]) < DEFAULT_N || Number(parts[2]) < DEFAULT_R || Number(parts[3]) < DEFAULT_P
  );
}

/** A pre-computed hash used to equalise timing when a username does not exist. */
export const DUMMY_HASH_PROMISE: Promise<string> = hashPassword(
  'likapcs-dummy-password-for-timing',
);
