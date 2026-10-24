/**
 * 0.19.0 — product variants (size, colour…). Each variant is a product of its own: its own barcode,
 * selling price and stock. A variant points at one main product (one level only) and carries a
 * label. Selling a variant moves only that variant's stock.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  LoginResponse,
  ProductLookupResponse,
  ProductSummary,
  SaleDetail,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

const T0 = Math.floor(Date.now() / 60_000) * 60_000;

describe('product variants', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let shirt: ProductSummary;
  let medium: ProductSummary;
  let large: ProductSummary;

  const call = <T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(owner.token), payload })
      .then((r) => ({
        status: r.statusCode,
        body: (r.statusCode === 204 ? null : r.json()) as T,
      }));

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T0));
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    expect((await call('POST', '/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    shirt = (
      await call<ProductSummary>('POST', '/products', { name: 'T-Shirt', sellingPriceCents: 1000 })
    ).body;
    medium = (
      await call<ProductSummary>('POST', '/products', {
        name: 'T-Shirt M',
        sellingPriceCents: 1200,
        parentId: shirt.id,
        variantLabel: 'M',
        barcodes: [{ barcode: 'TS-M-001', isPrimary: true }],
        initialStockMilli: 5000,
      })
    ).body;
    large = (
      await call<ProductSummary>('POST', '/products', {
        name: 'T-Shirt L',
        sellingPriceCents: 1300,
        parentId: shirt.id,
        variantLabel: 'L',
        barcodes: [{ barcode: 'TS-L-001', isPrimary: true }],
        initialStockMilli: 2000,
      })
    ).body;
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  it('each variant has its own barcode, price and stock; the main product lists its variants', async () => {
    const byBarcode = await call<ProductLookupResponse>('GET', '/products/lookup?code=TS-M-001');
    expect(byBarcode.status).toBe(200);
    expect(byBarcode.body.product).toMatchObject({
      id: medium.id,
      sellingPriceCents: 1200,
      stockMilli: 5000,
      variantLabel: 'M',
      parentId: shirt.id,
      parentName: 'T-Shirt',
    });
    expect((await call<ProductSummary>('GET', `/products/${shirt.id}`)).body.variantCount).toBe(2);
  });

  it('selling one variant moves only its stock', async () => {
    const sale = await call<SaleDetail>('POST', '/sales', {
      items: [{ productId: medium.id, quantityMilli: 2000, discountCents: 0 }],
      payments: [{ method: 'cash', amountCents: 2400 }],
    });
    expect(sale.status).toBe(201);
    expect(sale.body.totalCents).toBe(2400);
    expect((await call<ProductSummary>('GET', `/products/${medium.id}`)).body.stockMilli).toBe(
      3000,
    );
    expect((await call<ProductSummary>('GET', `/products/${large.id}`)).body.stockMilli).toBe(2000);
    expect((await call<ProductSummary>('GET', `/products/${shirt.id}`)).body.stockMilli).toBe(0);
  });

  it('a variant needs a parent and a label; one level only; a parent with variants cannot become one', async () => {
    const noLabel = await call('POST', '/products', {
      name: 'T-Shirt XL',
      sellingPriceCents: 1400,
      parentId: shirt.id,
    });
    expect(noLabel.status).toBe(400);

    const labelOnly = await call('POST', '/products', {
      name: 'Loose label',
      sellingPriceCents: 100,
      variantLabel: 'XS',
    });
    expect(labelOnly.status).toBe(400);

    const grandchild = await call('POST', '/products', {
      name: 'T-Shirt M red',
      sellingPriceCents: 1200,
      parentId: medium.id,
      variantLabel: 'red',
    });
    expect(grandchild.status).toBe(400);

    // The main product (it has L) cannot become a variant of another main product.
    const hoodie = (
      await call<ProductSummary>('POST', '/products', { name: 'Hoodie', sellingPriceCents: 2000 })
    ).body;
    const promote = await call('PATCH', `/products/${shirt.id}`, {
      parentId: hoodie.id,
      variantLabel: 'x',
    });
    expect(promote.status).toBe(409);
  });

  it('a variant can be turned back into a main product (its label is cleared)', async () => {
    const back = await call<ProductSummary>('PATCH', `/products/${medium.id}`, { parentId: null });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ parentId: null, variantLabel: null });
    expect((await call<ProductSummary>('GET', `/products/${shirt.id}`)).body.variantCount).toBe(1);
  });

  it('a main product with variants is not deleted out from under them', async () => {
    const del = await call('DELETE', `/products/${shirt.id}`);
    expect(del.status).toBe(409);
    expect(del.body).toMatchObject({ error: { details: { code: 'HAS_VARIANTS' } } });
    expect((await call<ProductSummary>('GET', `/products/${large.id}`)).body.parentId).toBe(
      shirt.id,
    );
  });
});
