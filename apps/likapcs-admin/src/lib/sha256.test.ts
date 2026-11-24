import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256 } from './sha256';

const hex = (data: Uint8Array) => new Sha256().update(data).digestHex();
const text = (s: string) => new TextEncoder().encode(s);

describe('Sha256 (piece by piece)', () => {
  it('gives the published checksums', () => {
    expect(hex(text(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hex(text('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hex(text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    // One million times "a", fed in pieces of an awkward size.
    const million = new Sha256();
    const piece = text('a'.repeat(977));
    let left = 1_000_000;
    while (left > 0) {
      const take = Math.min(left, piece.length);
      million.update(piece.subarray(0, take));
      left -= take;
    }
    expect(million.digestHex()).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('agrees with the platform for every length around the block edges', () => {
    for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
      const data = randomBytes(length);
      expect(hex(data)).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });

  it('does not depend on how the input is cut into pieces', () => {
    const data = randomBytes(300_000);
    const expected = createHash('sha256').update(data).digest('hex');
    for (const size of [1, 7, 63, 64, 65, 4096, 65_536, 299_999]) {
      const sha = new Sha256();
      for (let at = 0; at < data.length; at += size) sha.update(data.subarray(at, at + size));
      expect(sha.digestHex()).toBe(expected);
    }
  });

  it('gives the same answer when asked twice and refuses more input afterwards', () => {
    const sha = new Sha256().update(text('abc'));
    expect(sha.digestHex()).toBe(sha.digestHex());
    expect(() => sha.update(text('d'))).toThrow();
  });
});
