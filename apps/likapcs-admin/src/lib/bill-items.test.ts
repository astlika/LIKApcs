import { describe, expect, it } from 'vitest';
import type { OrderItemSummary, StationOrder } from '@likapcs/shared';
import { orderAddedAt, quantityText, sessionBill } from './bill-items';

let nextItemId = 1;
const item = (name: string, quantity: number, unitPriceCents: number): OrderItemSummary => ({
  id: nextItemId++,
  productId: `product-${name}`,
  name,
  quantityMilli: quantity * 1000,
  unitPriceCents,
  lineTotalCents: quantity * unitPriceCents,
  imageUrl: null,
  verifiedMilli: 0,
  verification: null,
});

const order = (
  over: Partial<StationOrder> & Pick<StationOrder, 'number' | 'items'>,
): StationOrder => ({
  id: `order-${over.number}`,
  stationId: 'station-1',
  stationCode: 'PC05',
  stationName: 'PC 5',
  sessionId: 'session-1',
  customerId: null,
  customerName: null,
  status: 'accepted',
  settlement: 'on_bill',
  note: null,
  totalCents: over.items.reduce((acc, i) => acc + i.lineTotalCents, 0),
  reason: null,
  saleId: null,
  receiptNo: null,
  requestedAt: '2026-11-23T13:05:00.000Z',
  decidedAt: '2026-11-23T13:05:00.000Z',
  decidedByName: 'Arta',
  settledAt: null,
  preparedAt: null,
  fromDevice: false,
  ...over,
});

describe('sessionBill — the products of a PC bill with their times', () => {
  it('lists every product line with the time its order was added, oldest first', () => {
    // The list comes newest first from the server.
    const bill = sessionBill([
      order({
        number: 3,
        items: [item('Çips', 1, 150), item('Coca-Cola', 1, 150)],
        requestedAt: '2026-11-23T14:40:00.000Z',
        decidedAt: '2026-11-23T14:40:00.000Z',
      }),
      order({ number: 2, items: [item('Coca-Cola', 2, 150)] }),
    ]);
    expect(bill.open.map((l) => [l.addedAt.slice(11, 16), l.quantityMilli, l.name])).toEqual([
      ['13:05', 2000, 'Coca-Cola'],
      ['14:40', 1000, 'Çips'],
      ['14:40', 1000, 'Coca-Cola'],
    ]);
    expect(bill.openCents).toBe(600);
    expect(bill.open.every((l) => l.byName === 'Arta' && l.requestedAt === null)).toBe(true);
    expect(bill.paid).toEqual([]);
    expect(bill.paidCents).toBe(0);
    // Every line has a key of its own, also the same product taken twice.
    expect(new Set(bill.open.map((l) => l.key)).size).toBe(3);
  });

  it('an order sent from the PC counts from the moment the desk accepted it', () => {
    const sent = order({
      number: 4,
      items: [item('Red Bull', 1, 250)],
      fromDevice: true,
      requestedAt: '2026-11-23T15:40:10.000Z',
      decidedAt: '2026-11-23T15:42:03.000Z',
    });
    expect(orderAddedAt(sent)).toBe('2026-11-23T15:42:03.000Z');
    const [line] = sessionBill([sent]).open;
    expect(line).toMatchObject({
      addedAt: '2026-11-23T15:42:03.000Z',
      requestedAt: '2026-11-23T15:40:10.000Z',
      byName: 'Arta',
    });
    // Without a decision yet (never the case on a bill) the request time is all there is.
    expect(orderAddedAt({ decidedAt: null, requestedAt: '2026-11-23T15:40:10.000Z' })).toBe(
      '2026-11-23T15:40:10.000Z',
    );
  });

  it('keeps what is paid apart, and leaves out what is not on the bill', () => {
    const bill = sessionBill([
      order({ number: 1, items: [item('Ujë', 1, 50)], status: 'paid', receiptNo: 'R-2026-000321' }),
      order({
        number: 2,
        items: [item('Tost', 1, 200)],
        status: 'billed',
        receiptNo: 'R-2026-000330',
        decidedAt: '2026-11-23T13:30:00.000Z',
      }),
      order({ number: 3, items: [item('Coca-Cola', 1, 150)] }),
      // Waiting for the desk, rejected, taken back by the customer, written off: not on the bill.
      order({ number: 4, items: [item('Çips', 1, 150)], status: 'pending', decidedAt: null }),
      order({ number: 5, items: [item('Çips', 1, 150)], status: 'rejected' }),
      order({ number: 6, items: [item('Çips', 1, 150)], status: 'cancelled' }),
      order({ number: 7, items: [item('Çips', 1, 150)], status: 'void' }),
    ]);
    expect(bill.open.map((l) => l.name)).toEqual(['Coca-Cola']);
    expect(bill.openCents).toBe(150);
    expect(bill.paid.map((l) => [l.name, l.receiptNo, l.paid])).toEqual([
      ['Ujë', 'R-2026-000321', true],
      ['Tost', 'R-2026-000330', true],
    ]);
    expect(bill.paidCents).toBe(250);
  });

  it('orders of the same minute stay in the order they were made', () => {
    const bill = sessionBill([
      order({ number: 9, items: [item('B', 1, 100)] }),
      order({ number: 8, items: [item('A', 1, 100)] }),
    ]);
    expect(bill.open.map((l) => l.name)).toEqual(['A', 'B']);
  });

  it('an empty bill is empty', () => {
    expect(sessionBill([])).toEqual({ open: [], paid: [], openCents: 0, paidCents: 0 });
  });

  it('writes a quantity without trailing zeros', () => {
    expect([1000, 2000, 1500, 250, 12_000].map(quantityText)).toEqual([
      '1',
      '2',
      '1.5',
      '0.25',
      '12',
    ]);
  });
});
