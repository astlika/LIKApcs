/**
 * Small API client for the phone. Relative URLs only (the dev server or the LIKApcs server proxies
 * /api). The token lives in localStorage on this phone and is sent as a Bearer token.
 */
import { apiOrigin, isNative } from './native';

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

  if (isNative() && !apiOrigin()) {
    throw new ApiError(0, 'no_server', 'Vendosni adresën e serverit LIKApcs.');
  }

  let res: Response;
  try {
    res = await fetch(`${apiOrigin()}/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network', 'Nuk ka lidhje me serverin. Kontrolloni Tailscale.');
  }

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    if (res.status === 401 && token && path !== '/auth/phone-login') {
      clearToken();
      window.dispatchEvent(new Event(SESSION_LOST));
    }
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? `Gabim ${res.status}`);
  }
  return data as T;
}

/** A message that is safe to show to staff, whatever went wrong. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Nuk keni leje për këtë veprim.';
    if (err.code === 'network') return err.message;
    return err.message;
  }
  return 'Diçka shkoi keq. Provoni përsëri.';
}

/** Money in euro cents → "12.50 €". */
export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')} €`;
}

/** "12,50" / "12.5" / "12" → 1250 cents. Returns null when the text is not a positive amount. */
export function parseEuroToCents(text: string): number | null {
  const normalized = text.trim().replace(',', '.');
  if (!/^\d{1,9}(\.\d{0,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return cents > 0 ? cents : null;
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

/** Short date for lists: 2026-11-07 → 07.11.2026 */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y && m && d ? `${d}.${m}.${y}` : iso;
}

/**
 * Idempotency key for money requests. `crypto.randomUUID` only exists in secure contexts, and the
 * phone is often opened over plain http on the Tailscale address, so use getRandomValues.
 */
export function newRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
