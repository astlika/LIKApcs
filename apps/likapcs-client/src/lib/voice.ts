/**
 * 0.35.0: spoken time warnings ("Edhe 5 minuta", "Koha juaj mbaroi").
 *
 * A game in exclusive fullscreen hides the countdown widget — Windows lets no other program draw
 * over it — but sound still reaches the headphones, in any game and at any resolution. What to
 * play is decided by `voicePlan` (shared): the owner's own recording, else the built-in voice,
 * else only the chime. This module plays it: one announcement after the other, never two at once,
 * and a recording that cannot be played falls through to the next one.
 */
import {
  VOICE_CHIME_FILE,
  voicePlan,
  type ClientVoiceConfig,
  type VoicePlan,
} from '@likapcs/shared';

/** Plays one sound file to its end; rejects when it cannot be loaded or played. */
export type PlaySound = (url: string, volume: number) => Promise<void>;

export interface VoicePlayerOptions {
  play: PlaySound;
  /** Address of a file that ships with the app (`voice/<file>`). */
  builtInUrl: (file: string) => string;
  /** Pause between the chime and the voice. */
  gapMs?: number;
  wait?: (ms: number) => Promise<void>;
  onError?: (url: string, error: unknown) => void;
}

/** The chime sits a little under the voice. */
const CHIME_VOLUME = 0.7;

export function createVoicePlayer(options: VoicePlayerOptions) {
  const wait = options.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gapMs = options.gapMs ?? 180;
  let queue: Promise<void> = Promise.resolve();

  /** Plays one plan to its end. Resolves with what was said: a source, or null for nothing. */
  async function run(plan: VoicePlan): Promise<string | null> {
    if (plan.chime) {
      const chime = options.builtInUrl(VOICE_CHIME_FILE);
      try {
        await options.play(chime, plan.volume * CHIME_VOLUME);
        if (plan.sources.length > 0) await wait(gapMs);
      } catch (error) {
        options.onError?.(chime, error);
      }
    }
    for (const source of plan.sources) {
      const url = source.kind === 'custom' ? source.url : options.builtInUrl(source.file);
      try {
        await options.play(url, plan.volume);
        return url;
      } catch (error) {
        // The owner's file is gone (a restore, another server) or cannot be decoded: the
        // built-in voice still speaks.
        options.onError?.(url, error);
      }
    }
    return null;
  }

  return {
    /**
     * Says one announcement (`5`, `1` … or `up`) after the ones already waiting. Resolves when it
     * is over, with the address that was played (null: nothing, or only the chime).
     */
    announce(config: ClientVoiceConfig | null | undefined, slot: string): Promise<string | null> {
      const plan = voicePlan(config, slot);
      if (!plan) return Promise.resolve(null);
      const said = queue.then(() => run(plan));
      queue = said.then(
        () => undefined,
        () => undefined,
      );
      return said;
    },
  };
}

/** How long one file may take before it is given up (a stalled download, an endless file). */
const SOUND_TIMEOUT_MS = 30_000;

/** Plays a file through the WebView's audio output. */
export const playWithAudioElement: PlaySound = (url, volume) =>
  new Promise<void>((resolve, reject) => {
    const audio = new Audio();
    let done = false;
    const finish = (error?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      audio.onended = null;
      audio.onerror = null;
      if (error === undefined) resolve();
      else {
        audio.pause();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const timer = setTimeout(() => finish(new Error('sound timed out')), SOUND_TIMEOUT_MS);
    audio.preload = 'auto';
    audio.volume = Math.min(1, Math.max(0, volume));
    audio.onended = () => finish();
    audio.onerror = () => finish(new Error(`cannot play ${url}`));
    audio.src = url;
    audio.play().catch((error: unknown) => finish(error));
  });

/** The player of this PC: built-in files come with the app, under `voice/`. */
export const voicePlayer = createVoicePlayer({
  play: playWithAudioElement,
  builtInUrl: (file) => `${import.meta.env.BASE_URL}voice/${file}`,
  onError: (url, error) => console.warn('[voice] could not play', url, error),
});
