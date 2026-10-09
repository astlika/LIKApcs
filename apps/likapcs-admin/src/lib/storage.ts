/**
 * Small typed wrapper over localStorage. In the packaged Tauri build this is the WebView's
 * storage (per installation); tokens are session-scoped on the server and can be revoked.
 */
const PREFIX = 'likapcs.';

type Key = 'token' | 'serverUrl' | 'language' | 'theme' | 'sidebarCollapsed';

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
