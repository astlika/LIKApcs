/**
 * System notifications on the APK. Every notification follows a server event (see liveSales.tsx);
 * this file only shows it. The app asks for the permission once (Android 13+).
 * In the browser, and while the app is open, the in-app message and the in-app sound are used.
 *
 * Each kind of event has its own channel, and so its own sound (the WAV files in
 * android/app/src/main/res/raw, made from the same patterns as sound.ts). Android fixes a
 * channel's sound when the channel is created, so the channel ids carry the kind name.
 */
import { LocalNotifications } from '@capacitor/local-notifications';
import { isNative } from './native';
import { playSound, type SoundKind } from './sound';

/** Event kinds that the APK sends as system notifications, with the sound file of each. */
const CHANNELS: { kind: SoundKind; name: string; sound: string }[] = [
  { kind: 'sale', name: 'Shitjet', sound: 'likapcs_sale' },
  { kind: 'pc', name: 'PC-të', sound: 'likapcs_pc' },
  { kind: 'call', name: 'Kërkesa dhe porosi', sound: 'likapcs_call' },
  { kind: 'reservation', name: 'Rezervimet', sound: 'likapcs_reservation' },
  { kind: 'staff', name: 'Punonjësit', sound: 'likapcs_staff' },
  { kind: 'debt', name: 'Borxhet', sound: 'likapcs_debt' },
  { kind: 'stock', name: 'Stoku', sound: 'likapcs_stock' },
  { kind: 'time', name: 'Koha e PC-ve', sound: 'likapcs_time' },
  { kind: 'error', name: 'Probleme', sound: 'likapcs_error' },
];

const channelOf = (kind: SoundKind): string => `likapcs-${kind}`;
const OLD_CHANNEL = 'likapcs-events';

let ready: Promise<boolean> | null = null;
let nextId = 1;

/** Asks for the permission once and creates the channels. False when refused, or not the APK. */
export function ensureNativeAlerts(): Promise<boolean> {
  if (!isNative()) return Promise.resolve(false);
  ready ??= (async () => {
    try {
      let { display } = await LocalNotifications.checkPermissions();
      if (display !== 'granted') display = (await LocalNotifications.requestPermissions()).display;
      if (display !== 'granted') return false;
      try {
        await LocalNotifications.deleteChannel({ id: OLD_CHANNEL });
      } catch {
        // Not there: nothing to remove.
      }
      for (const c of CHANNELS) {
        await LocalNotifications.createChannel({
          id: channelOf(c.kind),
          name: `LIKApcs · ${c.name}`,
          description: c.name,
          importance: 4,
          visibility: 1,
          vibration: true,
          sound: c.sound,
        });
      }
      return true;
    } catch {
      return false;
    }
  })();
  return ready;
}

/** Shows one system notification now, with the sound of its kind. */
export async function systemAlert(text: string, kind: SoundKind = 'pc'): Promise<void> {
  if (!(await ensureNativeAlerts())) return;
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: nextId++,
          title: 'LIKApcs',
          body: text,
          channelId: channelOf(kind),
          schedule: { at: new Date(Date.now() + 100) },
        },
      ],
    });
  } catch {
    // The in-app message still shows when the system refuses.
  }
}

/**
 * One message for the user: a system notification (with its sound) when the APK is in the
 * background, the in-app message otherwise (and always in the browser).
 */
export function alertUser(
  text: string,
  notify: (text: string, tone?: 'ok' | 'info') => void,
  kind: SoundKind = 'pc',
): void {
  if (isNative() && document.visibilityState === 'hidden') void systemAlert(text, kind);
  else {
    notify(text, 'info');
    playSound(kind);
  }
}
