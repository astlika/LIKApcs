/**
 * Sounds of the phone app. Each kind has its own short pattern, so the ear knows what happened
 * without looking: a scan beep, a sale, a PC that starts, a staff login, a debt, a low stock.
 * The same patterns are written as WAV files in the APK (res/raw), used by the system notifications.
 *
 * Browsers only let sound play after a tap, so the app unlocks the audio on the first touch
 * (see main.tsx) and the scanner unlocks it when it opens.
 */

import { isQuiet } from './quiet';

export type SoundKind =
  | 'scan'
  | 'sale'
  | 'pc'
  | 'call'
  | 'reservation'
  | 'staff'
  | 'debt'
  | 'stock'
  | 'time'
  | 'error';

/** [frequency Hz, start s, length s] per note. */
export const SOUND_NOTES: Record<SoundKind, [number, number, number][]> = {
  scan: [[2400, 0, 0.09]],
  sale: [
    [880, 0, 0.12],
    [1320, 0.12, 0.22],
  ],
  pc: [
    [523, 0, 0.12],
    [784, 0.13, 0.2],
  ],
  call: [
    [1175, 0, 0.15],
    [880, 0.17, 0.15],
    [1175, 0.34, 0.15],
  ],
  reservation: [
    [698, 0, 0.15],
    [932, 0.17, 0.15],
    [1175, 0.34, 0.22],
  ],
  staff: [
    [660, 0, 0.14],
    [660, 0.18, 0.14],
  ],
  debt: [
    [440, 0, 0.25],
    [349, 0.27, 0.35],
  ],
  stock: [
    [988, 0, 0.12],
    [988, 0.2, 0.12],
    [988, 0.4, 0.12],
  ],
  time: [
    [1046, 0, 0.15],
    [784, 0.17, 0.15],
    [523, 0.34, 0.3],
  ],
  error: [[220, 0, 0.3]],
};

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

/** Call on a tap: the browser allows sound only after a user gesture. */
export function unlockSound(): void {
  try {
    const c = context();
    if (c && c.state === 'suspended') void c.resume();
  } catch {
    // No audio on this device: the messages still show.
  }
}

/** Plays one sound now. Silent when the device has no audio. */
export function playSound(kind: SoundKind): void {
  if (isQuiet()) return;
  try {
    const c = context();
    if (!c) return;
    if (c.state === 'suspended') void c.resume();
    const t0 = c.currentTime + 0.01;
    for (const [freq, start, len] of SOUND_NOTES[kind]) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(0.2, t0 + start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + len);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + len + 0.02);
    }
  } catch {
    // A failed sound never stops the app.
  }
}

/** Short vibration with the sound, where the phone has a motor. */
export function buzz(ms: number | number[] = 30): void {
  if (isQuiet()) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    // Not every device vibrates.
  }
}
