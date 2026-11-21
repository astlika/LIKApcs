/**
 * Encryption for backup archives (0.26.0).
 *
 * Encrypted file layout:
 *   magic   8 bytes  "LKPBENC1"
 *   salt   16 bytes  the key-derivation salt (identifies which password/key was used)
 *   iv     12 bytes  random per file
 *   body   …         AES-256-GCM ciphertext of the plain archive (.tar.gz)
 *   tag    16 bytes  GCM authentication tag: a wrong key or a damaged file is detected on restore
 *
 * Keys: the owner sets a backup password once (Backups page). It is turned into a 256-bit key with
 * scrypt and stored in a local key file next to the data directory — never in the database and
 * never inside a backup. Old keys are kept so archives made before a password change stay readable
 * on this PC. On another PC the password itself is needed (the key file is not in the archive).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const ENCRYPTED_MAGIC = Buffer.from('LKPBENC1', 'ascii');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = ENCRYPTED_MAGIC.length + SALT_BYTES + IV_BYTES;
const KEY_BYTES = 32;
const SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const CIPHER = 'aes-256-gcm';

export class ArchiveCryptoError extends Error {
  constructor(
    readonly reason: 'wrong_password' | 'corrupt' | 'not_encrypted',
    message: string,
  ) {
    super(message);
  }
}

export function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, KEY_BYTES, SCRYPT_OPTIONS);
}

/** A fresh key-derivation salt, for a file that gets a password of its own (0.38.0). */
export function newSalt(): Buffer {
  return crypto.randomBytes(SALT_BYTES);
}

/** Passes the data through and reports how many bytes went by (for progress bars). */
function meter(onBytes?: (bytes: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onBytes?.(chunk.length);
      callback(null, chunk);
    },
  });
}

/** True when the file starts with the encrypted-archive magic. */
export async function isEncryptedFile(file: string): Promise<boolean> {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(ENCRYPTED_MAGIC.length);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return bytesRead === buf.length && buf.equals(ENCRYPTED_MAGIC);
  } finally {
    await fh.close();
  }
}

/** Reads the salt and IV of an encrypted file (validates the magic and the minimum size). */
export async function readEncryptedHeader(
  file: string,
): Promise<{ salt: Buffer; iv: Buffer; size: number }> {
  const { size } = await fsp.stat(file);
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEADER_BYTES, 0);
    if (
      bytesRead !== HEADER_BYTES ||
      !buf.subarray(0, ENCRYPTED_MAGIC.length).equals(ENCRYPTED_MAGIC)
    ) {
      throw new ArchiveCryptoError('not_encrypted', 'The file is not an encrypted backup');
    }
    if (size <= HEADER_BYTES + TAG_BYTES) {
      throw new ArchiveCryptoError('corrupt', 'The encrypted backup is incomplete');
    }
    return {
      salt: Buffer.from(buf.subarray(ENCRYPTED_MAGIC.length, ENCRYPTED_MAGIC.length + SALT_BYTES)),
      iv: Buffer.from(buf.subarray(ENCRYPTED_MAGIC.length + SALT_BYTES, HEADER_BYTES)),
      size,
    };
  } finally {
    await fh.close();
  }
}

/** Encrypts `src` into `dst` with `key`; `salt` is written in the header so the key can be found later. */
export async function encryptFile(
  src: string,
  dst: string,
  key: Buffer,
  salt: Buffer,
  onBytes?: (bytes: number) => void,
): Promise<void> {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
  await pipeline(
    fs.createReadStream(src),
    meter(onBytes),
    cipher,
    async (source: AsyncIterable<Buffer>) => {
      const out = fs.createWriteStream(dst);
      try {
        out.write(Buffer.concat([ENCRYPTED_MAGIC, salt, iv]));
        for await (const chunk of source) {
          if (!out.write(chunk)) await once(out, 'drain');
        }
        // The source has ended, so the cipher is finalised and the tag is available.
        await new Promise<void>((resolve, reject) => {
          out.end(cipher.getAuthTag(), (err?: Error | null) => (err ? reject(err) : resolve()));
        });
      } catch (err) {
        out.destroy();
        throw err;
      }
    },
  );
}

/** Decrypts `src` into `dst`. Throws ArchiveCryptoError('wrong_password') when the key does not match. */
export async function decryptFile(
  src: string,
  dst: string,
  key: Buffer,
  onBytes?: (bytes: number) => void,
): Promise<void> {
  const { iv, size } = await readEncryptedHeader(src);
  const tag = await readTag(src, size);
  const decipher = crypto.createDecipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      fs.createReadStream(src, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }),
      meter(onBytes),
      decipher,
      fs.createWriteStream(dst),
    );
  } catch (err) {
    await fsp.rm(dst, { force: true }).catch(() => undefined);
    throw new ArchiveCryptoError(
      'wrong_password',
      `The backup could not be opened with this password (${err instanceof Error ? err.message : 'authentication failed'})`,
    );
  }
}

async function readTag(file: string, size: number): Promise<Buffer> {
  const fh = await fsp.open(file, 'r');
  try {
    const tag = Buffer.alloc(TAG_BYTES);
    await fh.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    return tag;
  } finally {
    await fh.close();
  }
}

/**
 * The plain bytes of an encrypted file as a stream, without writing them anywhere (0.38.0). Used
 * to look at the first entry of an archive (its manifest) and stop: a large encrypted file is
 * then not decrypted in full only to be identified. The reader is expected to stop early, so the
 * authentication tag is only checked when the stream is read to its end.
 */
export async function decryptedStream(file: string, key: Buffer): Promise<Readable> {
  const { iv, size } = await readEncryptedHeader(file);
  const decipher = crypto.createDecipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(await readTag(file, size));
  const source = fs.createReadStream(file, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 });
  source.on('error', (err) => decipher.destroy(err));
  decipher.on('close', () => source.destroy());
  return source.pipe(decipher);
}

/** Size of the plain archive inside an encrypted file. */
export function plainSizeOf(encryptedSize: number): number {
  return Math.max(0, encryptedSize - HEADER_BYTES - TAG_BYTES);
}

// ─── Key ring ───────────────────────────────────────────────────────────────

interface KeyEntry {
  salt: string; // hex
  key: string; // hex
  createdAt: string;
}

interface KeyRingFile {
  version: 1;
  current: KeyEntry | null;
  previous: KeyEntry[];
}

export interface EncryptionStatus {
  enabled: boolean;
  changedAt: string | null;
  /** Older passwords kept so archives made before a change still open on this PC. */
  previousKeys: number;
}

/** Keys live in a local file (0600), outside the database and outside every backup. */
export class BackupKeyRing {
  constructor(private readonly file: string) {}

  private async load(): Promise<KeyRingFile> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.file, 'utf8')) as KeyRingFile;
      return { version: 1, current: parsed.current ?? null, previous: parsed.previous ?? [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, current: null, previous: [] };
      }
      throw err;
    }
  }

  private async save(ring: KeyRingFile): Promise<void> {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(ring, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, this.file);
  }

  async status(): Promise<EncryptionStatus> {
    const ring = await this.load();
    return {
      enabled: ring.current !== null,
      changedAt: ring.current?.createdAt ?? null,
      previousKeys: ring.previous.length,
    };
  }

  /** The key used for new backups (null when no password is set). */
  async currentKey(): Promise<{ key: Buffer; salt: Buffer } | null> {
    const ring = await this.load();
    if (!ring.current) return null;
    return {
      key: Buffer.from(ring.current.key, 'hex'),
      salt: Buffer.from(ring.current.salt, 'hex'),
    };
  }

  /** A key this PC already knows for the given archive salt (current or previous passwords). */
  async keyForSalt(salt: Buffer): Promise<Buffer | null> {
    const ring = await this.load();
    const hex = salt.toString('hex');
    const entry = [ring.current, ...ring.previous].find((e) => e?.salt === hex);
    return entry ? Buffer.from(entry.key, 'hex') : null;
  }

  /** Sets a new backup password. The previous one is kept so older archives stay readable here. */
  async setPassword(password: string): Promise<void> {
    const ring = await this.load();
    const salt = crypto.randomBytes(SALT_BYTES);
    const entry: KeyEntry = {
      salt: salt.toString('hex'),
      key: deriveKey(password, salt).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    const previous = ring.current ? [ring.current, ...ring.previous] : ring.previous;
    await this.save({ version: 1, current: entry, previous });
  }
}
