import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  VOICE_BUILT_IN_MINUTES,
  VOICE_CHIME_FILE,
  VOICE_LANGUAGES,
  VOICE_SLOT_UP,
  builtInVoiceFile,
} from '@likapcs/shared';

/**
 * The built-in voices are files that ship with two apps: the client plays them on the PC, the
 * Admin plays them for "Try". Both folders must hold the same files, and every announcement the
 * code promises a voice for must really have one.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, '../../public/voice');
const adminDir = path.resolve(here, '../../../likapcs-admin/public/voice');
const hashes = (dir: string) =>
  Object.fromEntries(
    fs
      .readdirSync(dir)
      .sort()
      .map((name) => [
        name,
        createHash('sha256')
          .update(fs.readFileSync(path.join(dir, name)))
          .digest('hex'),
      ]),
  );

describe('built-in voice files', () => {
  it('exist for every language and every announcement, and are real MP3 files', () => {
    const expected = [
      VOICE_CHIME_FILE,
      ...VOICE_LANGUAGES.flatMap((language) =>
        [...VOICE_BUILT_IN_MINUTES.map(String), VOICE_SLOT_UP].map((slot) =>
          builtInVoiceFile(language, slot)!,
        ),
      ),
    ].sort();
    expect(fs.readdirSync(clientDir).sort()).toEqual(expected);
    for (const name of expected) {
      const data = fs.readFileSync(path.join(clientDir, name));
      // An announcement is a second or two of speech: a few kilobytes, never megabytes.
      expect(data.length, name).toBeGreaterThan(4_000);
      expect(data.length, name).toBeLessThan(120_000);
      const tagged = data.subarray(0, 3).toString('latin1') === 'ID3';
      const frame = data[0] === 0xff && (data[1]! & 0xe0) === 0xe0;
      expect(tagged || frame, `${name} is MP3`).toBe(true);
    }
  });

  it('are the same in the client and in the Admin', () => {
    expect(hashes(adminDir)).toEqual(hashes(clientDir));
  });
});
