import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SETTING_DEFAULTS, type SettingsMap } from '@likapcs/shared';
import { api } from '../lib/api';
import { useAuth } from './auth';

/**
 * Server-side settings relevant to presentation (currency, time zone, business name).
 * Public keys load before login; the full map loads for users with settings.view.
 */
type Presentation = Pick<
  SettingsMap,
  'business.name' | 'locale.currency' | 'locale.timezone' | 'locale.default_language'
>;

const AppSettingsContext = createContext<Presentation>({
  'business.name': SETTING_DEFAULTS['business.name'],
  'locale.currency': SETTING_DEFAULTS['locale.currency'],
  'locale.timezone': SETTING_DEFAULTS['locale.timezone'],
  'locale.default_language': SETTING_DEFAULTS['locale.default_language'],
});

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const publicQuery = useQuery({
    queryKey: ['settings', 'public'],
    queryFn: () => api<Partial<SettingsMap>>('/settings/public', { auth: false }),
    staleTime: 60_000,
    retry: 1,
  });
  const value = useMemo<Presentation>(() => {
    const s = publicQuery.data ?? {};
    return {
      'business.name': s['business.name'] ?? SETTING_DEFAULTS['business.name'],
      'locale.currency': s['locale.currency'] ?? SETTING_DEFAULTS['locale.currency'],
      'locale.timezone': s['locale.timezone'] ?? SETTING_DEFAULTS['locale.timezone'],
      'locale.default_language':
        s['locale.default_language'] ?? SETTING_DEFAULTS['locale.default_language'],
    };
  }, [publicQuery.data]);
  void status;
  return <AppSettingsContext.Provider value={value}>{children}</AppSettingsContext.Provider>;
}

export function useAppSettings(): Presentation {
  return useContext(AppSettingsContext);
}
