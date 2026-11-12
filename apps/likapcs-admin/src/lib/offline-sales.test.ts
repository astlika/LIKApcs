import { beforeEach, describe, expect, it } from 'vitest';
import type { SyncSalesResponse } from '@likapcs/shared';
import {
  flushWith,
  getOfflineSnapshot,
  nextLocalNumber,
  queueOfflineSale,
  removeFailedSale,
  setDeviceCode,
  setOfflineStore,
  type KeyValue,
} from './offline-sales';

function memory(): KeyValue {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

const PRODUCT = '11111111-1111-4111-8111-111111111111';

function draft(id: string, price = 150) {
  return {
    request: {
      clientRequestId: id,
      items: [{ productId: PRODUCT, quantityMilli: 1000, discountCents: 0, addonIds: [] }],
      discountCents: 0,
      customerId: null,
      payments: [{ method: 'cash' as const, amountCents: 200 }],
      staff: false,
    },
    unitPrices: [{ productId: PRODUCT, unitPriceCents: price }],
    lines: [{ name: 'Cola', quantityMilli: 1000, unitPriceCents: price, lineCents: price }],
    totalCents: price,
  };
}

describe('offline sales queue', () => {
  beforeEach(() => {
    setOfflineStore(memory());
  });

  it('numbers the sales of this PC in order and never repeats a number', () => {
    expect(setDeviceCode('pc2')).toBe(true);
    const a = queueOfflineSale(draft('sale-aaaaaaaa'));
    const b = queueOfflineSale(draft('sale-bbbbbbbb'));
    expect(a.localNumber).toBe('PC2-000001');
    expect(b.localNumber).toBe('PC2-000002');
    expect(a.body.offline?.deviceCode).toBe('PC2');
    expect(a.body.offline?.unitPrices).toEqual([{ productId: PRODUCT, unitPriceCents: 150 }]);
  });

  it('refuses an invalid device code and refuses to queue without one', () => {
    expect(setDeviceCode('kasa')).toBe(false);
    expect(setDeviceCode('PC0')).toBe(false);
    expect(() => queueOfflineSale(draft('sale-cccccccc'))).toThrow('OFFLINE_NO_DEVICE');
  });

  it('keeps counting above a lost counter, using what is already queued', () => {
    setDeviceCode('PC2');
    queueOfflineSale(draft('sale-dddddddd'));
    queueOfflineSale(draft('sale-eeeeeeee'));
    const store = memory();
    // Counter lost (e.g. a reinstall) but the queue is still there: must not reuse 000001/000002.
    store.setItem('likapcs.offline-sales.v1', JSON.stringify(getOfflineSnapshot().queue));
    setOfflineStore(store);
    expect(nextLocalNumber('PC2')).toBe('PC2-000003');
  });

  it('sends pending sales and removes the created and duplicate ones', async () => {
    setDeviceCode('PC2');
    queueOfflineSale(draft('sale-ffffffff'));
    queueOfflineSale(draft('sale-gggggggg'));
    let sent = 0;
    const out = await flushWith(async (body) => {
      sent = body.sales.length;
      const response: SyncSalesResponse = {
        results: [
          {
            clientRequestId: 'sale-ffffffff',
            localNumber: 'PC2-000001',
            status: 'created',
            saleId: 's1',
            receiptNo: 'R-2026-000010',
            priceChanged: false,
            error: null,
          },
          {
            clientRequestId: 'sale-gggggggg',
            localNumber: 'PC2-000002',
            status: 'duplicate',
            saleId: 's2',
            receiptNo: 'R-2026-000009',
            priceChanged: false,
            error: null,
          },
        ],
      };
      return response;
    });
    expect(sent).toBe(2);
    expect(out).toEqual({ created: 1, duplicates: 1, failed: 0, unreachable: false });
    expect(getOfflineSnapshot().queue).toHaveLength(0);
    expect(getOfflineSnapshot().synced.map((s) => s.receiptNo)).toEqual([
      'R-2026-000010',
      'R-2026-000009',
    ]); // newest first
  });

  it('keeps a failed sale for review with its reason, and lets it be removed', async () => {
    setDeviceCode('PC2');
    queueOfflineSale(draft('sale-hhhhhhhh'));
    const out = await flushWith(async () => ({
      results: [
        {
          clientRequestId: 'sale-hhhhhhhh',
          localNumber: 'PC2-000001',
          status: 'failed',
          saleId: null,
          receiptNo: null,
          priceChanged: false,
          error: { code: 'OFFLINE_PRICES', message: 'Every product needs its unit price' },
        },
      ],
    }));
    expect(out.failed).toBe(1);
    const q = getOfflineSnapshot().queue;
    expect(q[0]!.status).toBe('failed');
    expect(q[0]!.error).toContain('OFFLINE_PRICES');
    removeFailedSale('sale-hhhhhhhh');
    expect(getOfflineSnapshot().queue).toHaveLength(0);
  });

  it('keeps everything pending when the server cannot be reached', async () => {
    setDeviceCode('PC2');
    queueOfflineSale(draft('sale-iiiiiiii'));
    const out = await flushWith(async () => {
      throw Object.assign(new Error('network'), { status: 0 });
    });
    expect(out.unreachable).toBe(true);
    expect(getOfflineSnapshot().queue[0]!.status).toBe('pending');
  });
});

import { offlineSlipHtml } from './offline-receipt';

describe('offline slip', () => {
  it('is marked non-fiscal, shows the local number and escapes names', () => {
    setOfflineStore(memory());
    setDeviceCode('PC2');
    const d = draft('sale-slip-0001', 150);
    const q = queueOfflineSale({
      ...d,
      lines: [{ name: 'Cola <b>&', quantityMilli: 2000, unitPriceCents: 150, lineCents: 300 }],
      totalCents: 300,
    });
    const html = offlineSlipHtml(q, 'Biznesi', new Date('2026-11-06T12:00:00Z'));
    expect(html).toContain('JO-FISKAL · PROVIZOR');
    expect(html).toContain('PC2-000001');
    expect(html).toContain('Cola &lt;b&gt;&amp;');
    expect(html).not.toContain('<b>&');
    expect(html).toContain('€3.00');
    expect(html).toContain('80mm');
  });
});
