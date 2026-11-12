import { useQuery } from '@tanstack/react-query';
import type { UserPreferences } from '@likapcs/shared';
import { api } from './api';
import { setLanguage } from './i18n';

/**
 * Display preferences of the signed-in account (theme, text size). The server keeps them per
 * username; this file applies them to the page and keeps a copy on the phone so the login
 * screen uses the same look before anyone has signed in.
 */
export const DEFAULT_PREFS: UserPreferences = {
  theme: 'dark',
  textSize: 'normal',
  language: 'sq',
  stationsView: 'grid',
};
const CACHE_KEY = 'likapcs-phone-prefs';

export function cachedPrefs(): UserPreferences {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<UserPreferences>) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

const systemDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;

export function applyPrefs(p: UserPreferences): void {
  const root = document.documentElement;
  const dark = p.theme === 'dark' || (p.theme === 'system' && systemDark());
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.text = p.textSize;
  root.lang = p.language;
  setLanguage(p.language);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(p));
  } catch {
    // Private mode: the look still applies for this visit.
  }
}

/** The account's saved preferences. Loaded after sign-in; the same query key everywhere. */
export const PREFS_KEY = ['phone', 'prefs'] as const;
export function usePrefsQuery(enabled: boolean) {
  return useQuery({
    queryKey: PREFS_KEY,
    queryFn: () => api<UserPreferences>('/auth/preferences'),
    enabled,
    staleTime: 10 * 60_000,
  });
}
