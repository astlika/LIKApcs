/**
 * 0.36.1 — the product search does not mind capitals or accents. The database is created with the
 * C locale, where only A–Z are folded: "Çaj" was found by neither "çaj" nor "Çaj". The till, the
 * Products page and the purchase form all search through `GET /products?q=`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoginResponse, ProductSummary } from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

describe('product search: capitals and accents do not matter', () => {
  let ctx: TestContext;
  let owner: LoginResponse;

  const call = <T>(method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(owner.token), payload })
      .then((r) => ({ status: r.statusCode, body: r.json() as T }));
  const found = async (q: string, extra = '') =>
    (
      await call<{ items: ProductSummary[]; total: number }>(
        'GET',
        `/products?q=${encodeURIComponent(q)}${extra}`,
      )
    ).body.items
      .map((p) => p.name)
      .sort();

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    const products: Record<string, unknown>[] = [
      { name: 'Çaj', sellingPriceCents: 100 },
      { name: 'ÇOKOLLATË', sellingPriceCents: 150 },
      { name: 'Ujë 0.5l', sellingPriceCents: 100, brand: 'Ëmbëlsira' },
      { name: 'Sanduiç', sellingPriceCents: 450 },
      { name: 'Müller Milch', sellingPriceCents: 180, barcodes: [{ barcode: '4025500021498' }] },
      { name: 'Coca-Cola 0.33l', sellingPriceCents: 190, sku: 'PIJE-Ç1' },
    ];
    for (const p of products) {
      const created = await call<ProductSummary>('POST', '/products', p);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
    }
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('finds a name that starts with Ç however it is typed', async () => {
    for (const q of ['Çaj', 'çaj', 'ÇAJ', 'caj', 'CAJ', 'Caj', 'aj']) {
      expect(await found(q), q).toEqual(['Çaj']);
    }
  });

  it('finds a name written in capitals, and letters in the middle and at the end', async () => {
    for (const q of ['çokollatë', 'cokollate', 'ÇOKOLLATË', 'Çokollatë', 'llatë', 'LLATE']) {
      expect(await found(q), q).toEqual(['ÇOKOLLATË']);
    }
    for (const q of ['ujë', 'uje', 'UJË', 'Ujë']) expect(await found(q), q).toEqual(['Ujë 0.5l']);
    for (const q of ['sanduiç', 'sanduic', 'SANDUIÇ'])
      expect(await found(q), q).toEqual(['Sanduiç']);
    for (const q of ['müller', 'muller', 'MÜLLER'])
      expect(await found(q), q).toEqual(['Müller Milch']);
  });

  it('plain names, the SKU, the brand and the barcode work as before', async () => {
    expect(await found('coca')).toEqual(['Coca-Cola 0.33l']);
    expect(await found('COCA-COLA')).toEqual(['Coca-Cola 0.33l']);
    expect(await found('pije-ç1')).toEqual(['Coca-Cola 0.33l']);
    expect(await found('PIJE-C1')).toEqual(['Coca-Cola 0.33l']);
    expect(await found('embelsira')).toEqual(['Ujë 0.5l']);
    expect(await found('Ëmbël')).toEqual(['Ujë 0.5l']);
    expect(await found('4025500021498')).toEqual(['Müller Milch']);
    // A part of a barcode is not a match: a scanner sends the whole code.
    expect(await found('40255')).toEqual([]);
    expect(await found('zzz')).toEqual([]);
  });

  it('one letter that several names share finds them all, with the other filters still applied', async () => {
    // "ç" is searched as "c": every name with a c or a ç in it.
    expect(await found('ç')).toEqual(
      ['Coca-Cola 0.33l', 'Müller Milch', 'Sanduiç', 'ÇOKOLLATË', 'Çaj'].sort(),
    );
    expect(await found('ë')).toEqual(
      ['Coca-Cola 0.33l', 'Müller Milch', 'Ujë 0.5l', 'ÇOKOLLATË'].sort(),
    );
    expect(await found('çaj', '&kind=internet_access')).toEqual([]);
    expect(await found('çaj', '&kind=standard')).toEqual(['Çaj']);
  });
});
