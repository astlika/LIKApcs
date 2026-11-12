/**
 * Native (Android APK, built with Capacitor) support. In the browser and in the server-served PWA
 * nothing changes: API calls stay relative. In the APK the app has no server of its own, so the
 * address of the LIKApcs Server (e.g. http://100.x.y.z:4700 over Tailscale) is typed once at sign-in.
 */
const SERVER_KEY = 'likapcs-phone-server';

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
}

export const isNative = (): boolean =>
  typeof window !== 'undefined' &&
  !!(window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor?.isNativePlatform?.();

export const getServerUrl = (): string | null => localStorage.getItem(SERVER_KEY);

/** Accepts `http(s)://host[:port]` only; returns the normalized address or null. */
export function normalizeServerUrl(input: string): string | null {
  const value = input.trim().replace(/\/+$/, '');
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

export function setServerUrl(url: string): void {
  localStorage.setItem(SERVER_KEY, url);
}

/** Prefix for API calls: empty in the browser (same origin), the saved server in the APK. */
export const apiOrigin = (): string => (isNative() ? (getServerUrl() ?? '') : '');
