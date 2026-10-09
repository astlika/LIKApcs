import { useCallback } from 'react';
import { formatDate, formatDateTime, formatMoney, formatTime, type Cents } from '@likapcs/shared';
import { useI18n } from '../i18n';
import { useAppSettings } from '../state/app-settings';

/** Formatting helpers bound to the current language, currency and business time zone. */
export function useFormat() {
  const { language } = useI18n();
  const settings = useAppSettings();
  const timeZone = settings['locale.timezone'];
  const currency = settings['locale.currency'];
  const money = useCallback(
    (cents: Cents) => formatMoney(cents, { currency, locale: language }),
    [currency, language],
  );
  const date = useCallback(
    (v: string | Date | null | undefined) => (v ? formatDate(v, { timeZone }) : '—'),
    [timeZone],
  );
  const time = useCallback(
    (v: string | Date | null | undefined) => (v ? formatTime(v, { timeZone }) : '—'),
    [timeZone],
  );
  const dateTime = useCallback(
    (v: string | Date | null | undefined) => (v ? formatDateTime(v, { timeZone }) : '—'),
    [timeZone],
  );
  const relative = useCallback(
    (v: string | Date | null | undefined) => {
      if (!v) return '—';
      const diff = Date.now() - new Date(v).getTime();
      const s = Math.max(0, Math.round(diff / 1000));
      if (s < 60) return language === 'sq' ? `${s} sek më parë` : `${s}s ago`;
      const m = Math.round(s / 60);
      if (m < 60) return language === 'sq' ? `${m} min më parë` : `${m} min ago`;
      const h = Math.round(m / 60);
      if (h < 24) return language === 'sq' ? `${h} orë më parë` : `${h}h ago`;
      return formatDateTime(v, { timeZone });
    },
    [language, timeZone],
  );
  return { money, date, time, dateTime, relative, currency, timeZone };
}
