import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  VOICE_CUSTOM_MAX,
  VOICE_FILE_PATTERN,
  VOICE_UPLOAD_MAX_BYTES,
  isVoiceSlot,
  type VoiceCustomMap,
} from '@likapcs/shared';
import { AppError, badRequest, conflict } from '../errors.js';
import type { AuditActor } from './audit.js';
import type { SettingsService } from './settings.js';

/**
 * 0.35.0: the owner's own recordings for the spoken time warnings on the PCs ("Edhe 5 minuta").
 *
 * The files live below `<data dir>/uploads/voice/` under random names, like product pictures; the
 * setting `client.voice_custom` says which file belongs to which announcement. A change of that
 * setting reaches every connected PC at once (it is one of the customer-screen settings).
 */

export type VoiceKind = 'mp3' | 'wav' | 'ogg' | 'm4a';

const MIME: Record<VoiceKind, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
};

/** Sniffs the real format from the first bytes; the declared content type is not trusted. */
export function detectVoiceKind(head: Buffer): VoiceKind | null {
  const text = (from: number, to: number) => head.subarray(from, to).toString('latin1');
  if (head.length >= 12 && text(0, 4) === 'RIFF' && text(8, 12) === 'WAVE') return 'wav';
  if (head.length >= 4 && text(0, 4) === 'OggS') return 'ogg';
  if (head.length >= 12 && text(4, 8) === 'ftyp') return 'm4a';
  if (head.length >= 3 && text(0, 3) === 'ID3') return 'mp3';
  // An MPEG audio frame without a tag in front: eleven sync bits, then "Layer III".
  if (
    head.length >= 2 &&
    head[0] === 0xff &&
    (head[1]! & 0xe0) === 0xe0 &&
    (head[1]! & 0x06) === 0x02
  )
    return 'mp3';
  return null;
}

async function readLimited(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > limit) throw tooLarge();
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

const tooLarge = () =>
  new AppError(
    413,
    'payload_too_large',
    `Recording larger than ${Math.round(VOICE_UPLOAD_MAX_BYTES / 1024 / 1024)} MB`,
  );

export class VoiceClipStore {
  constructor(private readonly dir: string) {}

  /** Absolute path of a stored file, or null when the name is not one of ours. */
  resolve(fileName: string): { path: string; contentType: string } | null {
    const m = VOICE_FILE_PATTERN.exec(fileName);
    if (!m) return null;
    return { path: path.join(this.dir, fileName), contentType: MIME[m[1] as VoiceKind] };
  }

  exists(fileName: string): boolean {
    return VOICE_FILE_PATTERN.test(fileName) && fs.existsSync(path.join(this.dir, fileName));
  }

  async saveStream(body: Readable): Promise<string> {
    return this.saveBuffer(await readLimited(body, VOICE_UPLOAD_MAX_BYTES));
  }

  async saveBuffer(data: Buffer): Promise<string> {
    if (data.length === 0) throw badRequest('Empty recording', { code: 'VOICE_EMPTY' });
    if (data.length > VOICE_UPLOAD_MAX_BYTES) throw tooLarge();
    const kind = detectVoiceKind(data.subarray(0, 16));
    if (!kind) {
      throw badRequest('Unsupported audio format (use MP3, WAV, OGG or M4A)', {
        code: 'VOICE_FORMAT',
      });
    }
    await fsp.mkdir(this.dir, { recursive: true });
    const name = `${randomBytes(12).toString('hex')}.${kind}`;
    const tmp = path.join(this.dir, `${name}.part`);
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, path.join(this.dir, name));
    return name;
  }

  /** Best-effort removal; a missing file is not an error. */
  async remove(fileName: string | null | undefined): Promise<void> {
    if (!fileName || !VOICE_FILE_PATTERN.test(fileName)) return;
    await fsp.rm(path.join(this.dir, fileName), { force: true });
  }
}

/** The name the file had on the owner's computer, made safe to store and show. */
export function cleanClipName(raw: string | undefined): string {
  const name = (raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^.*[\\/]/, '')
    .trim()
    .slice(0, 120);
  return name || 'audio';
}

export class VoiceService {
  /** One change of the recordings at a time: each one reads the map, then writes it back. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly settings: SettingsService,
    readonly clips: VoiceClipStore,
  ) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Stores the owner's recording for one announcement; the PCs are told through the setting. */
  async setCustom(
    slot: string,
    body: Readable,
    originalName: string | undefined,
    actor: AuditActor,
  ): Promise<VoiceCustomMap> {
    if (!isVoiceSlot(slot)) throw badRequest('Unknown announcement', { code: 'VOICE_SLOT' });
    const file = await this.clips.saveStream(body);
    try {
      return await this.serial(async () => {
        const current = await this.settings.get('client.voice_custom');
        if (!current[slot] && Object.keys(current).length >= VOICE_CUSTOM_MAX) {
          throw conflict(`At most ${VOICE_CUSTOM_MAX} own recordings; remove one first`, {
            code: 'VOICE_TOO_MANY',
          });
        }
        const previous = current[slot]?.file;
        const next: VoiceCustomMap = {
          ...current,
          [slot]: { file, name: cleanClipName(originalName) },
        };
        const all = await this.settings.update({ 'client.voice_custom': next }, actor);
        // The replaced file is no longer referenced by anything.
        if (previous && previous !== file) await this.clips.remove(previous);
        return all['client.voice_custom'];
      });
    } catch (err) {
      await this.clips.remove(file);
      throw err;
    }
  }

  /** Back to the built-in voice for one announcement. */
  async removeCustom(slot: string, actor: AuditActor): Promise<VoiceCustomMap> {
    if (!isVoiceSlot(slot)) throw badRequest('Unknown announcement', { code: 'VOICE_SLOT' });
    return this.serial(async () => {
      const current = await this.settings.get('client.voice_custom');
      const previous = current[slot];
      if (!previous) return current;
      const next: VoiceCustomMap = { ...current };
      delete next[slot];
      const all = await this.settings.update({ 'client.voice_custom': next }, actor);
      await this.clips.remove(previous.file);
      return all['client.voice_custom'];
    });
  }
}
