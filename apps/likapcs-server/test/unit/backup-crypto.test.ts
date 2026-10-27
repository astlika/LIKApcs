import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ArchiveCryptoError,
  BackupKeyRing,
  decryptFile,
  deriveKey,
  encryptFile,
  isEncryptedFile,
  readEncryptedHeader,
} from '../../src/services/backup-crypto.js';

describe('backup encryption', () => {
  let dir: string;
  const plain = Buffer.from('tar archive bytes '.repeat(50_000)); // ~900 KB, several chunks

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-crypto-'));
    await fsp.writeFile(path.join(dir, 'plain.bin'), plain);
  });

  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('round-trips a large file and hides the content', async () => {
    const salt = Buffer.alloc(16, 7);
    const key = deriveKey('correct horse battery', salt);
    await encryptFile(path.join(dir, 'plain.bin'), path.join(dir, 'a.enc'), key, salt);
    const cipherText = await fsp.readFile(path.join(dir, 'a.enc'));
    expect(await isEncryptedFile(path.join(dir, 'a.enc'))).toBe(true);
    expect(cipherText.includes(Buffer.from('tar archive bytes'))).toBe(false);
    const header = await readEncryptedHeader(path.join(dir, 'a.enc'));
    expect(header.salt.equals(salt)).toBe(true);

    await decryptFile(path.join(dir, 'a.enc'), path.join(dir, 'a.out'), key);
    expect((await fsp.readFile(path.join(dir, 'a.out'))).equals(plain)).toBe(true);
  });

  it('refuses a wrong password and leaves no partial output', async () => {
    const salt = Buffer.alloc(16, 9);
    await encryptFile(
      path.join(dir, 'plain.bin'),
      path.join(dir, 'b.enc'),
      deriveKey('right password', salt),
      salt,
    );
    const wrong = deriveKey('wrong password', salt);
    await expect(
      decryptFile(path.join(dir, 'b.enc'), path.join(dir, 'b.out'), wrong),
    ).rejects.toMatchObject({
      reason: 'wrong_password',
    });
    await expect(fsp.stat(path.join(dir, 'b.out'))).rejects.toThrow();
  });

  it('detects a damaged file', async () => {
    const salt = Buffer.alloc(16, 3);
    const key = deriveKey('damage test', salt);
    await encryptFile(path.join(dir, 'plain.bin'), path.join(dir, 'c.enc'), key, salt);
    const bytes = await fsp.readFile(path.join(dir, 'c.enc'));
    bytes[bytes.length >> 1]! ^= 0xff;
    await fsp.writeFile(path.join(dir, 'c.enc'), bytes);
    await expect(
      decryptFile(path.join(dir, 'c.enc'), path.join(dir, 'c.out'), key),
    ).rejects.toBeInstanceOf(ArchiveCryptoError);
  });

  it('tells a plain archive apart from an encrypted one', async () => {
    expect(await isEncryptedFile(path.join(dir, 'plain.bin'))).toBe(false);
    await expect(readEncryptedHeader(path.join(dir, 'plain.bin'))).rejects.toMatchObject({
      reason: 'not_encrypted',
    });
  });

  it('keeps old passwords so older archives still open on this PC', async () => {
    const ring = new BackupKeyRing(path.join(dir, 'keys-1.json'));
    expect(await ring.status()).toEqual({ enabled: false, changedAt: null, previousKeys: 0 });
    expect(await ring.currentKey()).toBeNull();

    await ring.setPassword('first password');
    const first = await ring.currentKey();
    expect(first).not.toBeNull();
    await ring.setPassword('second password');
    const second = await ring.currentKey();
    expect(second!.salt.equals(first!.salt)).toBe(false);
    expect(await ring.keyForSalt(first!.salt)).toEqual(first!.key);
    expect(await ring.keyForSalt(second!.salt)).toEqual(second!.key);
    expect((await ring.status()).previousKeys).toBe(1);

    const mode = (await fsp.stat(path.join(dir, 'keys-1.json'))).mode & 0o777;
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
  });
});
