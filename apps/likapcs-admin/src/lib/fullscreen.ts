/**
 * Whole-application full screen (no taskbar, no title bar) — toggled with F11 / F12 or the
 * topbar button. In the desktop app the native window goes fullscreen (works everywhere,
 * including the login screen) and the preference is restored at the next start; in a browser
 * the Fullscreen API is used (it requires a user gesture, so nothing is restored automatically).
 */
import { useSyncExternalStore } from 'react';
import { storage } from './storage';
import { isDesktopApp } from './updater';

let current = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function setCurrent(value: boolean) {
  if (current === value) return;
  current = value;
  emit();
}

async function desktopWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

export async function isFullscreen(): Promise<boolean> {
  if (isDesktopApp()) {
    try {
      return await (await desktopWindow()).isFullscreen();
    } catch {
      return current;
    }
  }
  return Boolean(document.fullscreenElement);
}

export async function setFullscreen(on: boolean): Promise<void> {
  if (isDesktopApp()) {
    const win = await desktopWindow();
    await win.setFullscreen(on);
    storage.set('fullscreen', on ? '1' : '0');
    setCurrent(on);
    return;
  }
  if (on) {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
  } else if (document.fullscreenElement) {
    await document.exitFullscreen();
  }
  setCurrent(Boolean(document.fullscreenElement));
}

export async function toggleFullscreen(): Promise<boolean> {
  const next = !(await isFullscreen());
  await setFullscreen(next);
  return next;
}

/** Restores the saved preference (desktop only) and keeps the store in sync with the window. */
export function initFullscreen(): () => void {
  if (isDesktopApp()) {
    void (async () => {
      try {
        if (storage.get('fullscreen') === '1') await setFullscreen(true);
        else setCurrent(await isFullscreen());
      } catch {
        /* window API unavailable — stay windowed */
      }
    })();
    // The user may also leave full screen through the OS; re-check whenever the app regains focus.
    const onFocus = () => void isFullscreen().then(setCurrent);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }
  const onChange = () => setCurrent(Boolean(document.fullscreenElement));
  document.addEventListener('fullscreenchange', onChange);
  return () => document.removeEventListener('fullscreenchange', onChange);
}

/** True when a full-screen toggle key was pressed (F11, or F12 as requested by the business). */
export function isFullscreenKey(e: KeyboardEvent): boolean {
  return (e.key === 'F11' || e.key === 'F12') && !e.ctrlKey && !e.altKey && !e.metaKey;
}

export function useFullscreen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => false,
  );
}
