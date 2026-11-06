/**
 * Small API client for the phone. Relative URLs only (the dev server or the LIKApcs server proxies
 * /api). The token lives in localStorage on this phone and is sent as a Bearer token.
 */
const TOKEN_KEY = 'likapcs-phone-token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (token: string): void => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

/** Fires when the server rejects the token (expired or signed out elsewhere). */
export const SESSION_LOST = 'likapcs-phone-session-lost';

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network', 'Nuk ka lidhje me serverin. Kontrolloni Tailscale.');
  }

  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    if (res.status === 401 && token && path !== '/auth/phone-login') {
      clearToken();
      window.dispatchEvent(new Event(SESSION_LOST));
    }
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

/** Money in euro cents → "12.50 €". */
export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')} €`;
}

/** Seconds → "1 h 05 min" / "42 min" / "30 s". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m > 0) return `${m} min`;
  return `${s} s`;
}

/** Today's date (YYYY-MM-DD) in the phone's own time zone. */
export const todayIso = (): string => new Date().toLocaleDateString('sv-SE');
