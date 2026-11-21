/**
 * 0.35.0: spoken time warnings on the customer PC ("Edhe 5 minuta", "Koha juaj mbaroi").
 *
 * A game in exclusive fullscreen hides every window of every other program, the countdown widget
 * included, so the customer cannot see the time. A voice in the headphones works in any game and
 * at any screen resolution. The PC plays, for each warning: the owner's own recording when one was
 * uploaded, else the built-in voice in the chosen language, else only the attention chime.
 */

export const VOICE_LANGUAGES = ['sq', 'en'] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

/** The announcement when the time has run out. Every other slot is a number of minutes left. */
export const VOICE_SLOT_UP = 'up';
/** `up`, or the minutes left as in `stations.expiry_warning_minutes` (1–120). */
export const VOICE_SLOT_PATTERN = /^(up|[1-9]\d{0,2})$/;

/** The minutes the built-in voices can say (files `voice/<language>-<minutes>.mp3`). */
export const VOICE_BUILT_IN_MINUTES: readonly number[] = [15, 10, 5, 1];

/** An uploaded recording: random name, format sniffed from its bytes by the server. */
export const VOICE_FILE_PATTERN = /^[0-9a-f]{24}\.(mp3|wav|ogg|m4a)$/;
export const VOICE_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
/** An announcement is a few words: anything longer is a mistake (a song, a whole recording). */
export const VOICE_UPLOAD_MAX_SECONDS = 20;
/** Own recordings at most: the five warning minutes, `up`, and a few left over from old minutes. */
export const VOICE_CUSTOM_MAX = 12;

export interface VoiceCustomClip {
  /** File name in the server's `uploads/voice` folder. */
  file: string;
  /** The name the file had on the owner's computer (shown in the Admin). */
  name: string;
}
/** Setting `client.voice_custom`: slot → the owner's own recording. */
export type VoiceCustomMap = Record<string, VoiceCustomClip>;

/** What the PC receives (`ClientDisplayConfig.voice`). */
export interface ClientVoiceConfig {
  enabled: boolean;
  language: VoiceLanguage;
  /** 0–100. */
  volume: number;
  /** A short attention chime before the voice. */
  chime: boolean;
  /** slot → URL of the owner's recording (server-relative until the PC resolves it). */
  custom: Record<string, string>;
}

export function isVoiceSlot(slot: string): boolean {
  if (!VOICE_SLOT_PATTERN.test(slot)) return false;
  return slot === VOICE_SLOT_UP || Number(slot) <= 120;
}

/** The slot of a warning "n minutes left". */
export function voiceSlotOfMinutes(minutes: number): string | null {
  const n = Math.round(minutes);
  return Number.isFinite(n) && n >= 1 && n <= 120 ? String(n) : null;
}

/** True when the built-in voices can say this slot. */
export function hasBuiltInVoice(slot: string): boolean {
  return slot === VOICE_SLOT_UP || VOICE_BUILT_IN_MINUTES.includes(Number(slot));
}

/** File of the built-in voice for a slot (inside the app's `voice/` folder), or null. */
export function builtInVoiceFile(language: VoiceLanguage, slot: string): string | null {
  return isVoiceSlot(slot) && hasBuiltInVoice(slot) ? `${language}-${slot}.mp3` : null;
}

export const VOICE_CHIME_FILE = 'chime.mp3';

/** Server path of an uploaded recording. */
export function voiceFileUrl(file: string): string {
  return `/api/v1/files/voice/${file}`;
}

/**
 * The announcements the owner can set up: one per warning minute (most minutes first), then the
 * end of the time. Follows `stations.expiry_warning_minutes`.
 */
export function voiceSlots(warningMinutes: readonly number[]): string[] {
  const minutes = [...new Set(warningMinutes.map((m) => Math.round(m)))]
    .filter((m) => m >= 1 && m <= 120)
    .sort((a, b) => b - a);
  return [...minutes.map(String), VOICE_SLOT_UP];
}

export type VoiceSource = { kind: 'custom'; url: string } | { kind: 'builtin'; file: string };

/** What is played for one announcement: the chime (or not), then the first source that plays. */
export interface VoicePlan {
  chime: boolean;
  /** 0–1. */
  volume: number;
  sources: VoiceSource[];
}

/**
 * What the PC plays for a slot, or null for nothing: voice off, volume zero, an unknown slot, or
 * neither a recording nor a chime to play. The owner's recording comes first; if it cannot be
 * played (file gone after a restore, server unreachable) the built-in voice still speaks.
 */
export function voicePlan(
  config: ClientVoiceConfig | null | undefined,
  slot: string,
): VoicePlan | null {
  if (!config || !config.enabled || !isVoiceSlot(slot)) return null;
  const volume = Math.min(100, Math.max(0, Number(config.volume) || 0)) / 100;
  if (volume <= 0) return null;
  const sources: VoiceSource[] = [];
  const custom = config.custom?.[slot];
  if (typeof custom === 'string' && custom) sources.push({ kind: 'custom', url: custom });
  const language: VoiceLanguage = VOICE_LANGUAGES.includes(config.language)
    ? config.language
    : 'sq';
  const builtIn = builtInVoiceFile(language, slot);
  if (builtIn) sources.push({ kind: 'builtin', file: builtIn });
  const chime = Boolean(config.chime);
  if (sources.length === 0 && !chime) return null;
  return { chime, volume, sources };
}
