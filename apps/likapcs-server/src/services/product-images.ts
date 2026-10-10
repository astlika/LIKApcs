import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { PRODUCT_IMAGE_MAX_BYTES } from '@likapcs/shared';
import { AppError, badRequest } from '../errors.js';

/**
 * Product pictures are plain files below `<data dir>/uploads/products/`, outside the installation
 * folder like every other business record. The database only keeps the file name
 * (`products.image_path`). Names are random and unique per upload, so a replaced picture gets a new
 * URL and old URLs can be cached forever by the Admin/POS screens.
 *
 * Two ways in: the Admin uploads the (already downscaled) picture, or sends a link and the server
 * downloads it once — afterwards the POS works without internet and without hot-linking.
 */

export type ImageKind = 'jpg' | 'png' | 'webp' | 'gif';

const MIME: Record<ImageKind, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** Only names we generate ourselves are served — never anything that could walk the file system. */
const FILE_NAME = /^[a-z0-9]{24}\.(jpg|png|webp|gif)$/;

/** Sniffs the real format from the first bytes; the declared content type is not trusted. */
export function detectImageKind(head: Buffer): ImageKind | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (
    head.length >= 6 &&
    (head.subarray(0, 6).toString('latin1') === 'GIF87a' ||
      head.subarray(0, 6).toString('latin1') === 'GIF89a')
  )
    return 'gif';
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'webp';
  return null;
}
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function readLimited(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > limit) {
      throw new AppError(
        413,
        'payload_too_large',
        `Image larger than ${Math.round(limit / 1024 / 1024)} MB`,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') return true;
  if (/^127\./.test(h) || /^169\.254\./.test(h) || /^fe80:/i.test(h)) return true;
  return false;
}

export interface ProductImageStoreOptions {
  /** Tests only: let `saveFromUrl` talk to loopback addresses. */
  allowLocalHosts?: boolean;
}

export class ProductImageStore {
  constructor(
    private readonly dir: string,
    private readonly options: ProductImageStoreOptions = {},
  ) {}

  get directory(): string {
    return this.dir;
  }

  /** Absolute path of a stored file, or null when the name is not one of ours. */
  resolve(fileName: string): { path: string; contentType: string } | null {
    const m = FILE_NAME.exec(fileName);
    if (!m) return null;
    return { path: path.join(this.dir, fileName), contentType: MIME[m[1] as ImageKind] };
  }

  static urlFor(fileName: string | null): string | null {
    return fileName ? `/api/v1/files/products/${fileName}` : null;
  }

  /** Stores an uploaded body (any supported format, size-limited) and returns the new file name. */
  async saveStream(body: Readable, limit = PRODUCT_IMAGE_MAX_BYTES): Promise<string> {
    const data = await readLimited(body, limit);
    return this.saveBuffer(data);
  }

  async saveBuffer(data: Buffer): Promise<string> {
    if (data.length === 0) throw badRequest('Empty image');
    if (data.length > PRODUCT_IMAGE_MAX_BYTES) {
      throw new AppError(413, 'payload_too_large', 'Image larger than 5 MB');
    }
    const kind = detectImageKind(data.subarray(0, 16));
    if (!kind) throw badRequest('Unsupported image format (use JPEG, PNG, WebP or GIF)');
    await fsp.mkdir(this.dir, { recursive: true });
    const name = `${randomBytes(12).toString('hex')}.${kind}`;
    const tmp = path.join(this.dir, `${name}.part`);
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, path.join(this.dir, name));
    return name;
  }

  /**
   * Downloads a picture from a link (http/https only, 15 s, ≤ 5 MB) and stores it like an upload.
   * Loopback/link-local targets are refused so the endpoint cannot be used to probe this machine.
   */
  async saveFromUrl(url: string): Promise<string> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw badRequest('Invalid link', { field: 'url' });
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw badRequest('Only http(s) links are supported', { field: 'url' });
    }
    if (!this.options.allowLocalHosts && isBlockedHost(target.hostname)) {
      throw badRequest('This address is not allowed', { field: 'url' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(target, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { accept: 'image/*,*/*;q=0.5', 'user-agent': 'LIKApcs-Server' },
      });
      if (!response.ok) {
        throw badRequest(`The link answered with HTTP ${response.status}`, { field: 'url' });
      }
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > PRODUCT_IMAGE_MAX_BYTES) {
        throw new AppError(413, 'payload_too_large', 'Image larger than 5 MB');
      }
      if (!response.body) throw badRequest('The link returned no data', { field: 'url' });
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > PRODUCT_IMAGE_MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new AppError(413, 'payload_too_large', 'Image larger than 5 MB');
        }
        chunks.push(Buffer.from(value));
      }
      const data = Buffer.concat(chunks);
      if (!detectImageKind(data.subarray(0, 16))) {
        throw badRequest('The link does not point to a JPEG, PNG, WebP or GIF picture', {
          field: 'url',
        });
      }
      return this.saveBuffer(data);
    } catch (err) {
      if (err instanceof AppError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw badRequest(`Could not download the picture: ${reason}`, { field: 'url' });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Best-effort removal; a missing file is not an error. */
  async remove(fileName: string | null): Promise<void> {
    if (!fileName || !FILE_NAME.test(fileName)) return;
    await fsp.rm(path.join(this.dir, fileName), { force: true });
  }

  exists(fileName: string): boolean {
    return FILE_NAME.test(fileName) && fs.existsSync(path.join(this.dir, fileName));
  }
}
