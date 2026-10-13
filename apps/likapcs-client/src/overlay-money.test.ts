import { describe, expect, it } from 'vitest';
import type { ClientDisplayConfig } from '@likapcs/shared';
import { isBillFlash, moneyLine, orderFlashText } from './Overlay';
import type { OrderView, SessionView } from './lib/protocol';
import { t } from './lib/i18n';

const tr = (k: Parameters<typeof t>[1], vars?: Record<string, string | number>) => t('en', k, vars);
const display = { widgetShowPayment: true, currency: 'EUR' } as ClientDisplayConfig;
const view = (over: Partial<SessionView>): SessionView => ({
  kind: 'countdown',
  seconds: 600,
  paused: false,
  expired: false,
  paidCents: null,
  owedCents: null,
  billingMode: null,
  ...over,
});
const onBill: OrderView = {
  id: 'o1',
  number: 3,
  status: 'accepted',
  settlement: 'on_bill',
  totalCents: 250,
  reason: null,
  items: [],
  requestedAt: '2026-10-13T10:00:00Z',
  decidedAt: '2026-10-13T10:01:00Z',
  preparedAt: null,
};

describe('widget money line with orders on the bill (0.16.0)', () => {
  it('prepaid without orders shows what was paid', () => {
    const line = moneyLine(view({ paidCents: 500, billingMode: 'prepaid' }), display, 'en', tr);
    expect(line).toMatchObject({ kind: 'paid' });
    expect(line?.amount).toMatch(/5\.00/);
  });

  it('prepaid with an accepted order switches to what is still to pay', () => {
    const line = moneyLine(view({ paidCents: 500, billingMode: 'prepaid' }), display, 'en', tr, [
      onBill,
    ]);
    expect(line).toMatchObject({ kind: 'owed', label: 'To pay' });
    expect(line?.amount).toMatch(/2\.50/);
  });

  it('postpaid adds the running time and the orders', () => {
    const line = moneyLine(view({ owedCents: 480, billingMode: 'postpaid' }), display, 'en', tr, [
      onBill,
    ]);
    expect(line?.amount).toMatch(/7\.30/);
  });

  it('end pay keeps its label and includes the orders', () => {
    const line = moneyLine(view({ owedCents: 300, billingMode: 'endpay' }), display, 'en', tr, [
      onBill,
    ]);
    expect(line).toMatchObject({ label: 'Pay at the end' });
    expect(line?.amount).toMatch(/5\.50/);
  });

  it('hides the line when the owner switched payment info off', () => {
    expect(
      moneyLine(view({ owedCents: 300 }), { ...display, widgetShowPayment: false }, 'en', tr, [
        onBill,
      ]),
    ).toBeNull();
  });
});

describe('order accepted on the bill → the money line becomes "total to pay" and pulses', () => {
  it('relabels and highlights while the acceptance flashes', () => {
    const line = moneyLine(
      view({ owedCents: 480, billingMode: 'postpaid' }),
      display,
      'en',
      tr,
      [onBill],
      isBillFlash(onBill),
    );
    expect(line).toMatchObject({ label: 'Total to pay', kind: 'owed', highlight: true });
    expect(line?.amount).toMatch(/7\.30/);
  });

  it('does not highlight for pay-now, rejected or prepared flashes', () => {
    expect(isBillFlash({ ...onBill, settlement: 'pay_now', status: 'paid' })).toBe(false);
    expect(isBillFlash({ ...onBill, status: 'rejected' })).toBe(false);
    expect(isBillFlash(null)).toBe(false);
    const line = moneyLine(view({ owedCents: 480 }), display, 'en', tr, [onBill], false);
    expect(line).toMatchObject({ label: 'To pay', highlight: false });
  });

  it('keeps the flash text itself short', () => {
    expect(orderFlashText(onBill, tr)).toBe('Order #3 · Accepted — being prepared');
    expect(orderFlashText({ ...onBill, status: 'rejected' }, tr)).toBe('Order #3 · Not accepted');
  });
});
