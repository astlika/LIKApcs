import { describe, expect, it } from 'vitest';
import { unitProfit } from './unit-profit';

describe('unitProfit', () => {
  it('takes VAT out of a tax-inclusive shelf price before measuring profit', () => {
    // 1.50 € incl. 18 % VAT → 1.27 € net; cost 0.90 € → 0.37 € profit on 1.27 € net (29.13 %).
    const p = unitProfit({ priceCents: 150, costCents: 90, rateBp: 1800, priceIncludesTax: true });
    expect(p).toMatchObject({ netCents: 127, vatCents: 23, profitCents: 37, marginBp: 2913 });
  });

  it('adds VAT on top of an exclusive price and does not count it as profit', () => {
    // 1.00 € + 18 % VAT → customer pays 1.18 €; profit is 1.00 − 0.60 = 0.40 €.
    const p = unitProfit({ priceCents: 100, costCents: 60, rateBp: 1800, priceIncludesTax: false });
    expect(p).toMatchObject({ netCents: 100, vatCents: 18, profitCents: 40, marginBp: 4000 });
  });

  it('without a cost the whole net price is profit, and with no tax the price is the net', () => {
    const p = unitProfit({ priceCents: 50, costCents: 0, rateBp: 0, priceIncludesTax: true });
    expect(p).toMatchObject({ netCents: 50, vatCents: 0, profitCents: 50, marginBp: 10_000 });
  });

  it('a loss shows as a negative profit', () => {
    const p = unitProfit({ priceCents: 100, costCents: 150, rateBp: 0, priceIncludesTax: true });
    expect(p.profitCents).toBe(-50);
    expect(p.marginBp).toBe(-5000);
  });

  it('has no margin when the net price is zero', () => {
    const p = unitProfit({ priceCents: 0, costCents: 0, rateBp: 1800, priceIncludesTax: true });
    expect(p.marginBp).toBeNull();
  });
});
