import { useCallback } from 'react';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatTime,
  formatTimeOnDay,
  formatUnitMoney,
  timeOnDayParts,
  type Cents,
} from '@likapcs/shared';
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
  /**
   * The time of one line of a bill (0.40.0): "14:05" on the day of `reference` (today when left
   * out; on a receipt, the receipt's own date), with the day in front when it is another day.
   */
  const timeOn = useCallback(
    (v: string | Date | null | undefined, reference?: string | Date | null) =>
      v ? formatTimeOnDay(v, reference ?? new Date(), { timeZone }) : '—',
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
  /** A unit price or cost in mills: shows 3 decimals only when the value needs them (0.125 €). */
  const unitMoney = useCallback(
    (mills: number) => formatUnitMoney(mills, { currency, locale: language }),
    [currency, language],
  );
  /** The same, day and time apart ("22.11" / "23:40"; `day` null on the day of `reference`). */
  const timeOnParts = useCallback(
    (v: string | Date, reference?: string | Date | null) =>
      timeOnDayParts(v, reference ?? new Date(), { timeZone }),
    [timeZone],
  );
  return {
    money,
    unitMoney,
    date,
    time,
    timeOn,
    timeOnParts,
    dateTime,
    relative,
    currency,
    timeZone,
  };
}
