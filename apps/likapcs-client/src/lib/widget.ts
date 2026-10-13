/**
 * Pure helpers of the countdown widget (0.13.0 designs) — kept free of React / Tauri so they are
 * unit-tested like the rest of `lib/`.
 */
import { widgetDesign } from '@likapcs/shared';
import type { Key } from './i18n';
import type { OrderView, SessionView } from './protocol';

type T = (k: Key, vars?: Record<string, string | number>) => string;

/** How long the action tray stays after the pointer left the widget. */
export const TRAY_LINGER_MS = 1500;

/**
 * The design the window should take right now: a design without room for words gives way to the
 * classic card while something textual (staff notice, maintenance, order flash) must be shown.
 * `card` designs show all of it inline; `line` designs carry the order flash themselves.
 */
export function effectiveWidgetStyle(
  style: string | null | undefined,
  needs: { notice: boolean; maintenance: boolean; flash: boolean },
): string {
  const spec = widgetDesign(style);
  if (spec.text === 'card') return spec.id;
  if (needs.notice || needs.maintenance) return 'detailed';
  if (needs.flash && spec.text === 'none') return 'detailed';
  return spec.id;
}

/** "23 min" / "1h 05m" / "45 s" — the compact duration of the one-line designs. */
export function compactDuration(seconds: number, t: T): string {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe} ${t('secShort')}`;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours === 0) return `${minutes} ${t('minShort')}`;
  return `${hours}${t('hourShort')} ${String(minutes).padStart(2, '0')}${t('minShort')}`;
}

/**
 * The big number of the ring / dot designs: whole minutes left; under a minute the seconds, so the
 * number keeps moving right to the end. `unit` is the i18n key of the label next to it.
 */
export function bigNumber(seconds: number): { value: number; unit: 'minShort' | 'secShort' } {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return { value: safe, unit: 'secShort' };
  return { value: Math.floor(safe / 60), unit: 'minShort' };
}

/**
 * Orders the desk accepted "on the bill" — settled together with the PC time when the session
 * ends. Pending ones are not promised yet; paid / billed ones are already settled.
 */
export function ordersOnBillCents(orders: readonly OrderView[]): number {
  return orders
    .filter((o) => o.status === 'accepted' && o.settlement === 'on_bill')
    .reduce((acc, o) => acc + o.totalCents, 0);
}

/**
 * What the customer will pay at the desk (0.16.0): the time part the server gave (postpaid so far,
 * end pay reserved; prepaid is already paid → 0) plus the orders on the bill. null when the server
 * gave no figure for the time and nothing is on the bill.
 */
export function billTotalCents(
  view: SessionView | null,
  orders: readonly OrderView[],
): number | null {
  const onBill = ordersOnBillCents(orders);
  if (!view) return onBill > 0 ? onBill : null;
  const time = view.owedCents ?? 0;
  if (view.owedCents === null && view.paidCents === null && onBill === 0) return null;
  return time + onBill;
}
