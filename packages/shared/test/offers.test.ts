import { describe, expect, it } from 'vitest';
import type { SaleItemSummary } from '../src/dto.js';
import { multiplyByQuantity } from '../src/money.js';
import {
  offerDefaultName,
  offerInputSchema,
  offerLinePrice,
  offerPreviewSchema,
  offerProfit,
  offerStockUnits,
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

  it('carries the time a product was put on a PC bill; other rows have none (0.40.0)', () => {
    const offer = { id: 'o1', name: 'Coca-Cola + 60 min', group: 1 };
    const rows = receiptRows([
      line({ id: 1, description: 'PC05 · 1 h', gamingSessionId: 'g1' }),
      line({
        id: 2,
        productId: PRODUCT,
        description: 'Coca-Cola',
        gamingSessionId: 'g1',
        addedAt: '2026-11-23T13:05:00.000Z',
      }),
      line({
        id: 3,
        productId: PRODUCT,
        description: 'Coca-Cola',
        gamingSessionId: 'g1',
        addedAt: '2026-11-23T14:40:00.000Z',
      }),
      line({ id: 4, productId: OTHER, description: 'Tost', addedAt: null }),
      line({ id: 5, productId: OTHER, description: 'Tost', offer }),
    ]);
    // The same product taken twice stays two rows: each has its own time.
    expect(rows.map((r) => [r.description, r.addedAt])).toEqual([
      ['PC05 · 1 h', null],
      ['Coca-Cola', '2026-11-23T13:05:00.000Z'],
      ['Coca-Cola', '2026-11-23T14:40:00.000Z'],
      ['Tost', null],
      ['Coca-Cola + 60 min', null],
    ]);
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
      addedAt: null,
    });
    // The receipt adds up to the same total as the sale's lines.
    expect(rows.reduce((a, r) => a + r.lineTotalCents, 0)).toBe(500);
  });

  it('the same offer twice is one row with its count; the quantity of a product is written', () => {
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
    expect(rows).toEqual([
      {
        key: 'offer:1',
        description: 'Dy pije',
        parts: ['2× Coca-Cola'],
        quantityMilli: 2000,
        unitPriceCents: 150,
        discountCents: 0,
        lineTotalCents: 300,
        addedAt: null,
      },
    ]);
  });

  it('offers that differ stay apart: another PC, another price', () => {
    const drink = (id: number, group: number, cents = 60): SaleItemSummary =>
      line({
        id,
        productId: PRODUCT,
        description: 'Coca-Cola',
        unitPriceCents: cents,
        lineTotalCents: cents,
        offer: { id: 'o1', name: 'Coca-Cola + 60 min', group },
      });
    const time = (id: number, group: number, description: string): SaleItemSummary =>
      line({
        id,
        description,
        unitPriceCents: 240,
        lineTotalCents: 240,
        offer: { id: 'o1', name: 'Coca-Cola + 60 min', group },
      });
    const rows = receiptRows([
      drink(1, 1),
      time(2, 1, 'PC05 · 60 min'),
      drink(3, 2),
      time(4, 2, 'PC06 · 60 min'),
      drink(5, 3),
      time(6, 3, 'PC05 · 60 min'),
      // The same content at another price (the offer was changed between two units).
      drink(7, 4, 50),
      time(8, 4, 'PC05 · 60 min'),
    ]);
    expect(rows.map((r) => [r.key, r.quantityMilli, r.unitPriceCents, r.lineTotalCents])).toEqual([
      ['offer:1', 2000, 300, 600],
      ['offer:2', 1000, 300, 300],
      ['offer:4', 1000, 290, 290],
    ]);
    // The receipt still adds up to the lines of the sale.
    expect(rows.reduce((a, r) => a + r.lineTotalCents, 0)).toBe(1190);
  });
});

describe('offerProfit (0.36.1)', () => {
  it('without VAT: the price less what the products cost to buy', () => {
    // "Coca-Cola + 60 min" at 1.20: the drink costs 0.45 at the wholesaler.
    expect(
      offerProfit(120, [
        { normalCents: 190, taxRateBp: 0, costCents: 45 },
        { normalCents: 200, taxRateBp: 0, costCents: 0 },
      ]),
    ).toEqual({ netCents: 120, vatCents: 0, costCents: 45, profitCents: 75 });
  });

  it('takes the VAT out of each share at its own rate, as the sale books it', () => {
    // 3.00 shared 1.46 / 1.54 (by 1.90 and 2.00 outside the offer), both at 18 %.
    expect(
      offerProfit(300, [
        { normalCents: 190, taxRateBp: 1800, costCents: 45 },
        { normalCents: 200, taxRateBp: 1800, costCents: 0 },
      ]),
    ).toEqual({ netCents: 124 + 131, vatCents: 45, costCents: 45, profitCents: 210 });
    // The drink at 8 %, the time at 18 %.
    expect(
      offerProfit(300, [
        { normalCents: 190, taxRateBp: 800, costCents: 45 },
        { normalCents: 200, taxRateBp: 1800, costCents: 0 },
      ]),
    ).toEqual({ netCents: 135 + 131, vatCents: 34, costCents: 45, profitCents: 221 });
  });

  it('counts every product and says a loss as a loss', () => {
    const out = offerProfit(100, [
      { normalCents: 380, taxRateBp: 0, costCents: 90 },
      { normalCents: 100, taxRateBp: 0, costCents: 30 },
    ]);
    expect(out).toEqual({ netCents: 100, vatCents: 0, costCents: 120, profitCents: -20 });
  });

  it('parts that cost nothing outside the offer: the first carries the price; no parts: the price itself', () => {
    expect(
      offerProfit(118, [
        { normalCents: 0, taxRateBp: 1800, costCents: 10 },
        { normalCents: 0, taxRateBp: 0, costCents: 0 },
      ]),
    ).toEqual({ netCents: 100, vatCents: 18, costCents: 10, profitCents: 90 });
    expect(offerProfit(250, [])).toEqual({
      netCents: 250,
      vatCents: 0,
      costCents: 0,
      profitCents: 250,
    });
    expect(offerProfit(0, [{ normalCents: 190, taxRateBp: 1800, costCents: 45 }])).toEqual({
      netCents: 0,
      vatCents: 0,
      costCents: 45,
      profitCents: -45,
    });
  });
});

describe('offerStockUnits (0.36.1)', () => {
  it('is how many times the stock covers the offer: the product that runs out first decides', () => {
    expect(offerStockUnits([{ quantityMilli: 1000, stockMilli: 24_000 }])).toBe(24);
    expect(offerStockUnits([{ quantityMilli: 2000, stockMilli: 3000 }])).toBe(1);
    expect(
      offerStockUnits([
        { quantityMilli: 1000, stockMilli: 24_000 },
        { quantityMilli: 2000, stockMilli: 5000 },
      ]),
    ).toBe(2);
  });

  it('leaves out products that do not count their stock, and is never below zero', () => {
    expect(offerStockUnits([{ quantityMilli: 1000, stockMilli: null }])).toBeNull();
    expect(offerStockUnits([])).toBeNull();
    expect(
      offerStockUnits([
        { quantityMilli: 1000, stockMilli: null },
        { quantityMilli: 1000, stockMilli: 7000 },
      ]),
    ).toBe(7);
    expect(offerStockUnits([{ quantityMilli: 1000, stockMilli: -2000 }])).toBe(0);
  });
});

describe('offerPreviewSchema (0.36.1)', () => {
  it('takes the form as it stands: a price not typed yet, no products, no minutes', () => {
    expect(offerPreviewSchema.parse({})).toEqual({ priceCents: 0, minutes: 0, items: [] });
    expect(
      offerPreviewSchema.parse({
        priceCents: 120,
        minutes: 60,
        items: [{ productId: PRODUCT, quantityMilli: 1000 }],
      }).items,
    ).toHaveLength(1);
    expect(offerPreviewSchema.safeParse({ minutes: 60 * 25 }).success).toBe(false);
  });
});
