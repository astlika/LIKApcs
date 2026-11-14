import { describe, expect, it } from 'vitest';
import type { ClientVoiceConfig } from '@likapcs/shared';
import { createVoicePlayer } from './voice';

const config = (patch: Partial<ClientVoiceConfig> = {}): ClientVoiceConfig => ({
  enabled: true,
  language: 'sq',
  volume: 100,
  chime: true,
  custom: {},
  ...patch,
});

/** A player whose "speaker" writes down what it was asked to play. */
function setup(failing: string[] = []) {
  const played: { url: string; volume: number }[] = [];
  const errors: string[] = [];
  let running = 0;
  let overlap = false;
  const player = createVoicePlayer({
    play: async (url, volume) => {
      running += 1;
      if (running > 1) overlap = true;
      await new Promise((r) => setTimeout(r, 2));
      running -= 1;
      if (failing.includes(url)) throw new Error(`cannot play ${url}`);
      played.push({ url, volume });
    },
    builtInUrl: (file) => `/voice/${file}`,
    gapMs: 0,
    onError: (url) => errors.push(url),
  });
  return { player, played, errors, overlapped: () => overlap };
}

describe('voice player', () => {
  it('plays the chime, then the built-in voice in the chosen language', async () => {
    const { player, played } = setup();
    expect(await player.announce(config(), '5')).toBe('/voice/sq-5.mp3');
    expect(played.map((p) => p.url)).toEqual(['/voice/chime.mp3', '/voice/sq-5.mp3']);
    expect(played[1]!.volume).toBe(1);
    expect(played[0]!.volume).toBeLessThan(1);

    const english = setup();
    await english.player.announce(config({ language: 'en', chime: false, volume: 40 }), 'up');
    expect(english.played).toEqual([{ url: '/voice/en-up.mp3', volume: 0.4 }]);
  });

  it("plays the owner's recording instead of the built-in voice", async () => {
    const { player, played } = setup();
    const custom = { '5': 'http://server:4700/api/v1/files/voice/aaaaaaaaaaaaaaaaaaaaaaaa.mp3' };
    expect(await player.announce(config({ custom }), '5')).toBe(custom['5']);
    expect(played.map((p) => p.url)).toEqual(['/voice/chime.mp3', custom['5']]);
    // Another announcement keeps the built-in voice.
    await player.announce(config({ custom }), '1');
    expect(played.at(-1)!.url).toBe('/voice/sq-1.mp3');
  });

  it("falls back to the built-in voice when the owner's file cannot be played", async () => {
    const gone = 'http://server:4700/api/v1/files/voice/bbbbbbbbbbbbbbbbbbbbbbbb.mp3';
    const { player, played, errors } = setup([gone]);
    expect(await player.announce(config({ custom: { '5': gone } }), '5')).toBe('/voice/sq-5.mp3');
    expect(played.map((p) => p.url)).toEqual(['/voice/chime.mp3', '/voice/sq-5.mp3']);
    expect(errors).toEqual([gone]);
  });

  it('a minute without a built-in voice gets the chime; without the chime, nothing', async () => {
    const { player, played } = setup();
    expect(await player.announce(config(), '3')).toBeNull();
    expect(played.map((p) => p.url)).toEqual(['/voice/chime.mp3']);
    expect(await player.announce(config({ chime: false }), '3')).toBeNull();
    expect(played).toHaveLength(1);
  });

  it('says nothing when the voice is off, silent, missing or the slot is unknown', async () => {
    const { player, played } = setup();
    expect(await player.announce(config({ enabled: false }), '5')).toBeNull();
    expect(await player.announce(config({ volume: 0 }), '5')).toBeNull();
    expect(await player.announce(undefined, '5')).toBeNull();
    expect(await player.announce(null, 'up')).toBeNull();
    expect(await player.announce(config(), 'nonsense')).toBeNull();
    expect(await player.announce(config(), '0')).toBeNull();
    expect(played).toEqual([]);
  });

  it('never talks over itself: announcements wait for each other', async () => {
    const { player, played, overlapped } = setup();
    await Promise.all([
      player.announce(config(), '5'),
      player.announce(config(), '1'),
      player.announce(config({ chime: false }), 'up'),
    ]);
    expect(overlapped()).toBe(false);
    expect(played.map((p) => p.url)).toEqual([
      '/voice/chime.mp3',
      '/voice/sq-5.mp3',
      '/voice/chime.mp3',
      '/voice/sq-1.mp3',
      '/voice/sq-up.mp3',
    ]);
  });

  it('keeps going after a sound that fails', async () => {
    const { player, played } = setup(['/voice/chime.mp3', '/voice/sq-5.mp3']);
    expect(await player.announce(config(), '5')).toBeNull();
    expect(await player.announce(config(), '1')).toBe('/voice/sq-1.mp3');
    expect(played.map((p) => p.url)).toEqual(['/voice/sq-1.mp3']);
  });
});
