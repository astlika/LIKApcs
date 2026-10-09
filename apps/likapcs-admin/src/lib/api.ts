import type { ApiErrorBody } from '@likapcs/shared';
import { storage } from './storage';

/**
 * Thin fetch wrapper for the LIKApcs Server HTTP API (v1).
 *  - Base URL is configurable (empty = same origin, used with the Vite dev proxy).
 *  - Bearer token is attached automatically; a 401 triggers the `onUnauthorized` hook so the
 *    app can return to the login screen without each page handling it.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

/** Default server address: same origin in the browser/dev build, localhost:4700 in the desktop app. */
export const DEFAULT_DESKTOP_SERVER_URL = 'http://127.0.0.1:4700';

export function getServerUrl(): string {
  const stored = storage.get('serverUrl');
  if (stored !== null) return stored.replace(/\/+$/, '');
  const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  return isDesktop ? DEFAULT_DESKTOP_SERVER_URL : '';
}
export function setServerUrl(url: string): void {
  const cleaned = url.trim().replace(/\/+$/, '');
  if (cleaned) storage.set('serverUrl', cleaned);
  else storage.remove('serverUrl');
}
export function getToken(): string | null {
  return storage.get('token');
}
export function setToken(token: string | null): void {
  if (token) storage.set('token', token);
  else storage.remove('token');
}

export function websocketUrl(path: string): string {
  const base = getServerUrl();
  if (base) return base.replace(/^http/, 'ws') + path;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  auth?: boolean;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = new URL(`${getServerUrl()}/api/v1${path}`, window.location.origin);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const token = getToken();
  if (options.auth !== false && token) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (err) {
    throw new ApiError(0, 'network_error', err instanceof Error ? err.message : 'network error');
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const body = (data ?? {}) as Partial<ApiErrorBody>;
    const error = new ApiError(
      response.status,
      body.error?.code ?? 'http_error',
      body.error?.message ?? `HTTP ${response.status}`,
      body.error?.details,
    );
    if (response.status === 401 && options.auth !== false && token && unauthorizedHandler)
      unauthorizedHandler();
    throw error;
  }
  return data as T;
}

/** Extracts a field-level validation message from an ApiError, if present. */
export function fieldError(err: unknown, field: string): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  if (err.code === 'validation_error' && Array.isArray(err.details)) {
    const issue = (err.details as { path: string; message: string }[]).find(
      (d) => d.path === field || d.path.endsWith(`.${field}`),
    );
    return issue?.message;
  }
  if (
    typeof err.details === 'object' &&
    err.details &&
    (err.details as { field?: string }).field === field
  )
    return err.message;
  return undefined;
}
