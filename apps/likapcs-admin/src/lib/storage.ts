/**
 * Small typed wrapper over localStorage. In the packaged Tauri build this is the WebView's
 * storage (per installation); tokens are session-scoped on the server and can be revoked.
 */
const PREFIX = 'likapcs.';

type Key =
  | 'token'
  | 'serverUrl'
  | 'language'
  | 'theme'
  | 'sidebarCollapsed'
  | 'mapIconSize'
  | 'mapGroupZones'
  | 'rememberChoice'
  /** '1' when the desktop app should start in full screen (restored at launch). */
  | 'fullscreen'
  /** Admin version seen at the previous start — used to report a completed self-update. */
  | 'lastVersion';

export const storage = {
  get(key: Key): string | null {
    try {
      return window.localStorage.getItem(PREFIX + key);
    } catch {
      return null;
    }
  },
  set(key: Key, value: string): void {
    try {
      window.localStorage.setItem(PREFIX + key, value);
    } catch {
      /* storage unavailable (private mode) — keep working in memory */
    }
  },
  remove(key: Key): void {
    try {
      window.localStorage.removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
  },
};

/**
 * Window-scoped storage (sessionStorage): survives page reloads but is cleared when the app /
 * browser tab is closed. Used for sign-ins without "Stay signed in on this PC".
 */
export const sessionScoped = {
  get(key: Key): string | null {
    try {
      return window.sessionStorage.getItem(PREFIX + key);
    } catch {
      return null;
    }
  },
  set(key: Key, value: string): void {
    try {
      window.sessionStorage.setItem(PREFIX + key, value);
    } catch {
      /* ignore */
    }
  },
  remove(key: Key): void {
    try {
      window.sessionStorage.removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
  },
};
