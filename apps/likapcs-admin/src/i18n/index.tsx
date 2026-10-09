import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Language } from '@likapcs/shared';
import { en, type Dictionary } from './en';
import { sq } from './sq';
import { storage } from '../lib/storage';

const DICTIONARIES: Record<Language, Dictionary> = { en, sq };

/** Dot-path keys of the dictionary, e.g. "stations.status.available". */
type PathKeys<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : PathKeys<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type TranslationKey = PathKeys<Dictionary>;

function lookup(dict: Dictionary, key: string): string | undefined {
  let current: unknown = dict;
  for (const part of key.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  /** Translates dynamic keys (e.g. status codes) with a fallback. */
  td: (key: string, fallback?: string) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  children,
  initialLanguage,
}: {
  children: ReactNode;
  initialLanguage?: Language;
}) {
  const [language, setLanguageState] = useState<Language>(
    () => (storage.get('language') as Language | null) ?? initialLanguage ?? 'en',
  );
  const setLanguage = useCallback((next: Language) => {
    storage.set('language', next);
    setLanguageState(next);
    document.documentElement.lang = next;
  }, []);
  const value = useMemo<I18nContextValue>(() => {
    const dict = DICTIONARIES[language];
    return {
      language,
      setLanguage,
      t: (key, params) => interpolate(lookup(dict, key) ?? lookup(en, key) ?? key, params),
      td: (key, fallback) => lookup(dict, key) ?? lookup(en, key) ?? fallback ?? key,
    };
  }, [language, setLanguage]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}
