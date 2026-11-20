import { describe, expect, it } from 'vitest';
import type { SaleItemSummary } from '../src/dto.js';
import { multiplyByQuantity } from '../src/money.js';
import {
  offerDefaultName,
  offerInputSchema,
  offerLinePrice,
  receiptRows,
  shareOfferPrice,
} from '../src/offers.js';

const PRODUCT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('offerInputSchema', () => {
  it('takes products with minutes, products alone, and minutes alone', () => {
    const both = offerInputSchema.parse({
      name: ' Coca-Cola + 60 min ',
      priceCents: 300,
      minutes: 60,
      items: [{ productId: PRODUCT, quantityMilli: 1000 }],
    });
    expect(both.name).toBe('Coca-Cola + 60 min');
    expect(both.isActive).toBe(true);
    expect(
      offerInputSchema.safeParse({
        name: 'Dy pije',
        priceCents: 250,
        items: [{ productId: PRODUCT, quantityMilli: 2000 }],
      }).success,
    ).toBe(true);
    expect(
      offerInputSchema.safeParse({ name: '2 orë', priceCents: 300, minutes: 120 }).success,
    ).toBe(true);
  });

  it('refuses an offer with nothing in it and the same product twice', () => {
    expect(offerInputSchema.safeParse({ name: 'Bosh', priceCents: 100 }).success).toBe(false);
    expect(
      offerInputSchema.safeParse({
        name: 'Dy herë',
        priceCents: 100,
        items: [
          { productId: PRODUCT, quantityMilli: 1000 },
          { productId: PRODUCT, quantityMilli: 2000 },
        ],
      }).success,
    ).toBe(false);
    expect(
      offerInputSchema.safeParse({
        name: 'Dy produkte',
        priceCents: 100,
        items: [
          { productId: PRODUCT, quantityMilli: 1000 },
          { productId: OTHER, quantityMilli: 1000 },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('offerDefaultName', () => {
  it('names the products, their quantities and the minutes', () => {
    expect(offerDefaultName([{ name: 'Coca-Cola', quantityMilli: 1000 }], 60)).toBe(
      'Coca-Cola + 60 min',
    );
    expect(
      offerDefaultName(
        [
          { name: 'Coca-Cola', quantityMilli: 2000 },
          { name: ' Tost ', quantityMilli: 1000 },
        ],
        0,
      ),
    ).toBe('2× Coca-Cola + Tost');
    expect(offerDefaultName([], 120)).toBe('120 min');
    expect(offerDefaultName([{ name: 'Fara', quantityMilli: 500 }], 30)).toBe(
      '0.500× Fara + 30 min',
    );
  });

  it('never exceeds the length a name may have', () => {
    const long = Array.from({ length: 10 }, (_, i) => ({
      name: `Produkt me emër të gjatë ${i}`,
      quantityMilli: 1000,
    }));
    expect(offerDefaultName(long, 60).length).toBeLessThanOrEqual(80);
  });
});

describe('shareOfferPrice', () => {
  it('shares the price by what each line costs outside the offer', () => {
    // Coca-Cola 1.50 + 60 min 6.00, sold together for 6.00.
    expect(shareOfferPrice(600, [150, 600])).toEqual([120, 480]);
  });

  it('always adds up to the offer price', () => {
    for (const [price, normal] of [
      [100, [33, 33, 33]],
      [299, [150, 70, 600]],
      [1, [500, 500]],
      [777, [1, 999]],
    ] as const) {
      const shares = shareOfferPrice(price, normal);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(price);
      expect(shares.every((s) => s >= 0)).toBe(true);
    }
  });

  it('gives a free line nothing, and the whole price to the first line when all are free', () => {
    expect(shareOfferPrice(300, [0, 150])).toEqual([0, 300]);
    expect(shareOfferPrice(300, [0, 0])).toEqual([300, 0]);
    expect(shareOfferPrice(0, [150, 600])).toEqual([0, 0]);
  });
});

describe('offerLinePrice', () => {
  it('is the share itself for one unit', () => {
    expect(offerLinePrice(120, 1000)).toEqual({ unitPriceCents: 120, discountCents: 0 });
  });

  it('rounds the unit price up and takes the cents too many off as a discount', () => {
    // Three units that together cost 1.00: 0.34 each is 1.02, minus 0.02.
    expect(offerLinePrice(100, 3000)).toEqual({ unitPriceCents: 34, discountCents: 2 });
    for (const [share, quantity] of [
      [100, 3000],
      [199, 2000],
      [250, 1500],
      [1, 7000],
      [0, 2000],
      [333, 250],
    ] as const) {
      const { unitPriceCents, discountCents } = offerLinePrice(share, quantity);
      expect(discountCents).toBeGreaterThanOrEqual(0);
      expect(multiplyByQuantity(unitPriceCents, quantity) - discountCents).toBe(share);
    }
  });
});

describe('receiptRows', () => {
  const line = (over: Partial<SaleItemSummary> & Pick<SaleItemSummary, 'id'>): SaleItemSummary => ({
    lineNo: over.id,
    productId: null,
    gamingSessionId: null,
    description: 'Line',
    sku: null,
    quantityMilli: 1000,
    unitPriceCents: 100,
    discountCents: 0,
    taxRateBp: 1800,
    taxCents: 15,
    lineTotalCents: 100,
    refundedMilli: 0,
    addonIds: [],
    accessCodes: [],
    ...over,
  });

  it('leaves plain lines as they are', () => {
    const rows = receiptRows([
      line({ id: 1, productId: PRODUCT, description: 'Coca-Cola', quantityMilli: 2000 }),
      line({ id: 2, description: 'Kohë PC', offer: null }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      key: 'line:1',
      description: 'Coca-Cola',
      parts: [],
      quantityMilli: 2000,
      unitPriceCents: 100,
      lineTotalCents: 100,
    });
  });

  it('shows the lines of one offer as one row with its name, price and content', () => {
    const offer = { id: 'o1', name: 'Coca-Cola + 60 min', group: 1 };
    const rows = receiptRows([
      line({
        id: 1,
        productId: OTHER,
        description: 'Tost',
        unitPriceCents: 200,
        lineTotalCents: 200,
      }),
      line({
        id: 2,
        productId: PRODUCT,
        description: 'Coca-Cola',
        unitPriceCents: 60,
        lineTotalCents: 60,
        offer,
      }),
      line({
        id: 3,
        description: 'PC05 · 60 min',
        unitPriceCents: 240,
        lineTotalCents: 240,
        offer,
      }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(['line:1', 'offer:1']);
    expect(rows[1]).toEqual({
      key: 'offer:1',
      description: 'Coca-Cola + 60 min',
      parts: ['Coca-Cola', 'PC05 · 60 min'],
      quantityMilli: 1000,
      unitPriceCents: 300,
      discountCents: 0,
      lineTotalCents: 300,
    });
    // The receipt adds up to the same total as the sale's lines.
    expect(rows.reduce((a, r) => a + r.lineTotalCents, 0)).toBe(500);
  });

  it('keeps two sales of the same offer apart and writes the quantity of a product', () => {
    const rows = receiptRows([
      line({
        id: 1,
        productId: PRODUCT,
        description: 'Coca-Cola',
        quantityMilli: 2000,
        unitPriceCents: 75,
        lineTotalCents: 150,
        offer: { id: 'o1', name: 'Dy pije', group: 1 },
      }),
      line({
        id: 2,
        productId: PRODUCT,
        description: 'Coca-Cola',
        quantityMilli: 2000,
        unitPriceCents: 75,
        lineTotalCents: 150,
        // The offer itself was deleted since: its name stays with the sale.
        offer: { id: null, name: 'Dy pije', group: 2 },
      }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.parts).toEqual(['2× Coca-Cola']);
    expect(rows.map((r) => r.lineTotalCents)).toEqual([150, 150]);
  });
});
