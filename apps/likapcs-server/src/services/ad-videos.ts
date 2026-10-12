/**
 * Video slides for the customer screens (0.10.0). Uploaded MP4 / WebM files live next to the
 * product pictures (`<uploadDir>/videos`), under random names, served read-only at
 * `/api/v1/files/videos/<name>` with long caching. Size-limited (`AD_VIDEO_MAX_BYTES`) and
 * type-checked by magic bytes — the content-type header is never trusted.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { AD_VIDEO_MAX_BYTES } from '@likapcs/shared';
import { AppError, badRequest } from '../errors.js';

export const AD_VIDEO_TYPES = ['video/mp4', 'video/webm'] as const;
const FILE_NAME = /^([0-9a-f]{24})\.(mp4|webm)$/;
const MIME = { mp4: 'video/mp4', webm: 'video/webm' } as const;

function detectKind(head: Buffer): 'mp4' | 'webm' | null {
  if (head.length >= 12 && head.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  return null;
}

export class AdVideoStore {
  constructor(private readonly dir: string) {}

  resolve(fileName: string): { path: string; contentType: string } | null {
    const m = FILE_NAME.exec(fileName);
    if (!m) return null;
    return { path: path.join(this.dir, fileName), contentType: MIME[m[2] as 'mp4' | 'webm'] };
  }

  exists(fileName: string): boolean {
    const file = this.resolve(fileName);
    return file !== null && fs.existsSync(file.path);
  }

  /** Streams the upload to a temp file (bounded), checks the magic bytes, then publishes it. */
  async saveStream(body: Readable, limit = AD_VIDEO_MAX_BYTES): Promise<string> {
    await fsp.mkdir(this.dir, { recursive: true });
    const token = randomBytes(12).toString('hex');
    const tmp = path.join(this.dir, `${token}.part`);
    const out = fs.createWriteStream(tmp);
    let size = 0;
    let head = Buffer.alloc(0);
    try {
      for await (const chunk of body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += buf.length;
        if (size > limit)
          throw new AppError(
            413,
            'payload_too_large',
            `Video larger than ${Math.round(limit / 1024 / 1024)} MB`,
          );
        if (head.length < 16) head = Buffer.concat([head, buf]).subarray(0, 16);
        if (!out.write(buf)) await new Promise<void>((resolve) => out.once('drain', resolve));
      }
      await new Promise<void>((resolve, reject) =>
        out.end((err?: Error | null) => (err ? reject(err) : resolve())),
      );
      if (size === 0) throw badRequest('Empty video');
      const kind = detectKind(head);
      if (!kind) throw badRequest('Unsupported video format (use MP4 or WebM)');
      const name = `${token}.${kind}`;
      await fsp.rename(tmp, path.join(this.dir, name));
      return name;
    } catch (err) {
      out.destroy();
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async remove(fileName: string | null): Promise<void> {
    if (!fileName) return;
    const file = this.resolve(fileName);
    if (!file) return;
    await fsp.rm(file.path, { force: true }).catch(() => undefined);
  }
}
