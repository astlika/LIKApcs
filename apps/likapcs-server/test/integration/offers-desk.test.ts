/**
 * 0.36.1 — an offer is sold with one click and nothing is asked; its PC minutes wait at the desk
 * as paid time (no PIN) and are given when a PC is started or gets more time. An offer also says
 * how many of it the stock covers, what one sale of it earns (its price without VAT, less what
 * its products cost to buy) and what it has sold so far.
 *
 * The numbers: PC time costs 2.00 an hour, Coca-Cola sells at 1.90 and costs 0.45 to buy, VAT is
 * 18 %. "Coca-Cola + 60 min" at 3.00 is shared 1.46 / 1.54; without VAT that is 1.24 + 1.31.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  CustomerSummary,
  LoginResponse,
  OfferPreview,
  OfferSummary,
  ProductSummary,
  SaleDetail,
  SessionMutationResponse,
  SessionSummary,
  StationSummary,
  TimeCreditSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

const T0 = Math.floor(Date.now() / 60_000) * 60_000;

describe('offers: one click at the till, paid minutes at the desk, stock and profit', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let a: StationSummary;
  let b: StationSummary;
  let cola: ProductSummary;
  let tost: ProductSummary;
  let offer: OfferSummary;
  let firstSale: SaleDetail;

  const callAs = <T>(
    token: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(token), payload })
      .then((r) => ({ status: r.statusCode, body: (r.statusCode === 204 ? null : r.json()) as T }));
  const call = <T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) => callAs<T>(owner.token, method, url, payload);

  const stockOf = async (id: string) =>
    (await call<ProductSummary>('GET', `/products/${id}`)).body.stockMilli;
  const live = async (stationId: string) =>
    (
      await call<{ items: SessionSummary[] }>(
        'GET',
        `/sessions?stationId=${stationId}&status=active`,
      )
    ).body.items[0] ?? null;
  const credits = async (stationId?: string) =>
    (
      await call<{ credits: TimeCreditSummary[] }>(
        'GET',
        `/time-credits${stationId ? `?stationId=${stationId}` : ''}`,
      )
    ).body.credits;
  const sell = (
    items: Record<string, unknown>[],
    extra: Record<string, unknown> = {},
    token = owner.token,
  ) =>
    callAs<SaleDetail>(token, 'POST', '/sales', {
      items,
      payments: [{ method: 'cash', amountCents: 100_000 }],
      ...extra,
    });
  const listed = async (token = owner.token) =>
    (await callAs<{ items: OfferSummary[] }>(token, 'GET', '/offers')).body.items;
  const mine = async (token = owner.token) => (await listed(token)).find((o) => o.id === offer.id)!;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T0));
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    a = (await call<StationSummary>('POST', '/stations', { number: 1, name: 'Arena 1' })).body;
    b = (await call<StationSummary>('POST', '/stations', { number: 2, name: 'Arena 2' })).body;
    expect((await call('POST', '/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    await call('POST', '/pricing/rules', {
      name: 'Standard',
      rateCentsPerHour: 200,
      billingIncrementMinutes: 1,
    });
    cola = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Coca-Cola',
        sellingPriceCents: 190,
        purchaseCostCents: 45,
        initialStockMilli: 10_000,
      })
    ).body;
    // No purchase cost and no stock count: the profit says so, the stock does not limit it.
    tost = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Tost',
        sellingPriceCents: 300,
        trackStock: false,
      })
    ).body;
    const created = await call('POST', '/users', {
      username: 'kasa',
      fullName: 'Kasa',
      password: 'Cashier123',
      roles: ['cashier'],
      mustChangePassword: false,
    });
    expect(created.status).toBe(201);
    cashier = await login(ctx.app, 'kasa', 'Cashier123');
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  it('the form is told what the offer would earn before it is saved', async () => {
    expect(cola.taxRateBp).toBe(1800);
    const preview = await call<OfferPreview>('POST', '/offers/preview', {
      priceCents: 120,
      minutes: 60,
      items: [{ productId: cola.id, quantityMilli: 1000 }],
    });
    expect(preview.status).toBe(200);
    // 1.20 shared 0.58 / 0.62 → 0.49 + 0.53 without VAT; the drink costs 0.45.
    expect(preview.body).toMatchObject({
      productsCents: 190,
      timeCents: 200,
      stockUnits: 10,
      profit: { netCents: 102, vatCents: 18, costCents: 45, profitCents: 57, missingCost: [] },
    });
    expect(preview.body.items).toEqual([
      expect.objectContaining({
        productId: cola.id,
        stockMilli: 10_000,
        stockLimited: true,
        taxRateBp: 1800,
        unitCostMills: 450,
      }),
    ]);

    // Two of it in the offer: the stock covers five; the cost doubles.
    const pair = await call<OfferPreview>('POST', '/offers/preview', {
      priceCents: 300,
      items: [{ productId: cola.id, quantityMilli: 2000 }],
    });
    expect(pair.body).toMatchObject({
      productsCents: 380,
      timeCents: 0,
      stockUnits: 5,
      profit: { netCents: 254, vatCents: 46, costCents: 90, profitCents: 164 },
    });

    // A product without a purchase cost is named; one that does not count its stock limits nothing.
    const loose = await call<OfferPreview>('POST', '/offers/preview', {
      priceCents: 236,
      items: [{ productId: tost.id, quantityMilli: 1000 }],
    });
    expect(loose.body).toMatchObject({
      stockUnits: null,
      profit: {
        netCents: 200,
        vatCents: 36,
        costCents: 0,
        profitCents: 200,
        missingCost: ['Tost'],
      },
    });
    expect(loose.body.items[0]).toMatchObject({ stockMilli: null, stockLimited: false });

    // A price kept without VAT is shown as the till charges it: the business default rate is
    // added (the default comes from the settings when there is no default tax category).
    const tea = await call<ProductSummary>('POST', '/products', {
      name: 'Çaj',
      sellingPriceCents: 100,
      priceIncludesTax: false,
      trackStock: false,
    });
    const taxed = await call<OfferPreview>('POST', '/offers/preview', {
      priceCents: 118,
      items: [{ productId: tea.body.id, quantityMilli: 1000 }],
    });
    expect(taxed.body.items[0]).toMatchObject({ unitPriceCents: 118, taxRateBp: 1800 });
    expect(taxed.body).toMatchObject({ productsCents: 118, profit: { netCents: 100 } });

    // Nothing typed yet is not an error; a product that does not exist is; a cashier may not ask.
    expect((await call('POST', '/offers/preview', {})).status).toBe(200);
    expect(
      (
        await call('POST', '/offers/preview', {
          items: [{ productId: '11111111-1111-4111-8111-111111111111', quantityMilli: 1000 }],
        })
      ).status,
    ).toBe(404);
    expect((await callAs(cashier.token, 'POST', '/offers/preview', {})).status).toBe(403);
  });

  it('an offer says its stock and what one sale earns; the till gets neither cost nor totals', async () => {
    const created = await call<OfferSummary>('POST', '/offers', {
      name: 'Coca-Cola + 60 min',
      priceCents: 300,
      minutes: 60,
      items: [{ productId: cola.id, quantityMilli: 1000 }],
    });
    expect(created.status).toBe(201);
    offer = created.body;
    // 3.00 shared 1.46 / 1.54 → 1.24 + 1.31 without VAT.
    expect(offer).toMatchObject({
      stockUnits: 10,
      available: true,
      profit: { netCents: 255, vatCents: 45, costCents: 45, profitCents: 210, missingCost: [] },
      sold: { count: 0, revenueCents: 0, profitCents: 0 },
    });
    expect(await mine()).toMatchObject({ profit: { profitCents: 210 }, sold: { count: 0 } });

    const atTill = await mine(cashier.token);
    expect(atTill).toMatchObject({ stockUnits: 10, available: true, profit: null, sold: null });
    expect(atTill.items[0]).toMatchObject({ stockMilli: 10_000, stockLimited: true });
  });

  it('sold with one click: no PC, no name, no PIN — the drink leaves the stock, the hour waits', async () => {
    const sale = await sell([{ offerId: offer.id }], {}, cashier.token);
    expect(sale.status).toBe(201);
    firstSale = sale.body;
    expect(sale.body.totalCents).toBe(300);
    expect(sale.body.claimPins).toBeUndefined();
    expect(sale.body.offerStarts).toBeUndefined();
    expect(sale.body.items.map((i) => [i.description, i.lineTotalCents, i.offer?.name])).toEqual([
      ['Coca-Cola', 146, 'Coca-Cola + 60 min'],
      ['60 min PC', 154, 'Coca-Cola + 60 min'],
    ]);
    expect(await stockOf(cola.id)).toBe(9000);
    expect(await live(a.id)).toBeNull();

    // The hour is paid time for any PC, under the offer's name.
    const open = await credits();
    expect(open).toEqual([
      expect.objectContaining({
        stationId: null,
        holderName: null,
        offerName: 'Coca-Cola + 60 min',
        minutesRemaining: 60,
        saleId: sale.body.id,
      }),
    ]);
    expect((await credits(a.id)).map((c) => c.id)).toEqual([open[0]!.id]);
    expect((await credits(b.id)).map((c) => c.id)).toEqual([open[0]!.id]);
    const pins = await ctx.pool.query<{ pin_hash: string | null }>(
      'SELECT pin_hash FROM time_credits WHERE id = $1',
      [open[0]!.id],
    );
    expect(pins.rows[0]!.pin_hash).toBeNull();
  });

  it('starting a PC with the paid hour: it runs as a paid session and nothing is charged again', async () => {
    const [credit] = await credits(a.id);
    const salesBefore = await ctx.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM sales',
    );
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: a.id,
      billingMode: 'prepaid',
      minutes: 60,
      creditId: credit!.id,
    });
    expect(started.status).toBe(201);
    expect(started.body.payment ?? null).toBeNull();
    expect(await live(a.id)).toMatchObject({ billingMode: 'prepaid', plannedSeconds: 3600 });
    expect(await credits()).toEqual([]);
    const salesAfter = await ctx.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sales');
    expect(salesAfter.rows[0]!.n).toBe(salesBefore.rows[0]!.n);
    // Used once: the same hour cannot start a second PC.
    const again = await call('POST', '/sessions', {
      stationId: b.id,
      billingMode: 'prepaid',
      minutes: 60,
      creditId: credit!.id,
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(await live(b.id)).toBeNull();
  });

  it('two at once are two hours; a running PC gets one added, the other waits', async () => {
    const sale = await sell([{ offerId: offer.id }, { offerId: offer.id }]);
    expect(sale.status).toBe(201);
    expect(sale.body.totalCents).toBe(600);
    expect(sale.body.claimPins).toBeUndefined();
    expect(sale.body.items.map((i) => i.offer?.group)).toEqual([1, 1, 2, 2]);
    expect(await stockOf(cola.id)).toBe(7000);
    const waiting = await credits(a.id);
    expect(waiting).toHaveLength(2);

    const session = (await live(a.id))!;
    const extended = await call<SessionMutationResponse>('POST', `/sessions/${session.id}/extend`, {
      minutes: 60,
      creditId: waiting[0]!.id,
    });
    expect(extended.status).toBe(200);
    expect(extended.body.payment ?? null).toBeNull();
    expect(await live(a.id)).toMatchObject({ plannedSeconds: 7200 });
    expect((await credits()).map((c) => c.id)).toEqual([waiting[1]!.id]);
  });

  it('a sale with a customer puts the customer’s name on the waiting hour — still no PIN', async () => {
    const customer = await call<CustomerSummary>('POST', '/customers', { name: 'Arben Krasniqi' });
    expect(customer.status).toBe(201);
    const sale = await sell([{ offerId: offer.id }], { customerId: customer.body.id });
    expect(sale.status).toBe(201);
    expect(sale.body.claimPins).toBeUndefined();
    const open = await credits();
    expect(open.map((c) => [c.holderName, c.offerName])).toEqual([
      [null, 'Coca-Cola + 60 min'],
      ['Arben Krasniqi', 'Coca-Cola + 60 min'],
    ]);
    expect(await stockOf(cola.id)).toBe(6000);
  });

  it('a name given with the offer still makes minutes with a PIN (as before)', async () => {
    const sale = await sell([{ offerId: offer.id, holderName: 'Besa' }]);
    expect(sale.status).toBe(201);
    expect(sale.body.claimPins).toEqual([
      expect.objectContaining({ holderName: 'Besa', minutes: 60 }),
    ]);
    expect(await stockOf(cola.id)).toBe(5000);
  });

  it('the offer says what it has sold: how many, the takings, the profit', async () => {
    // Five sold at 3.00; each keeps 2.55 without VAT and costs 0.45 of drink.
    expect(await mine()).toMatchObject({
      stockUnits: 5,
      sold: { count: 5, revenueCents: 1500, profitCents: 5 * 210 },
    });
    expect((await mine(cashier.token)).sold).toBeNull();
  });

  it('a refund comes off: the drink back on the shelf is no cost, its money is no takings', async () => {
    const drink = firstSale.items.find((i) => i.productId === cola.id)!;
    const refund = await call('POST', `/sales/${firstSale.id}/refund`, {
      items: [{ saleItemId: drink.id, quantityMilli: 1000 }],
      reason: 'kthim i pijes',
      restock: true,
    });
    expect(refund.status).toBe(200);
    expect(await stockOf(cola.id)).toBe(6000);
    // The hour of that sale was used, so the offer still counts as sold: 15.00 − 1.46 taken;
    // the VAT of the drink (0.22) and its cost (0.45) are gone with it.
    expect(await mine()).toMatchObject({
      stockUnits: 6,
      sold: { count: 5, revenueCents: 1500 - 146, profitCents: 5 * 210 - (124 - 45) },
    });
  });

  it('a discount on the whole sale is shared over the offer: takings and profit follow what was paid', async () => {
    const sale = await sell([{ offerId: offer.id }], { discountCents: 30 });
    expect(sale.status).toBe(201);
    expect(sale.body.totalCents).toBe(270);
    // 1.31 + 1.39 charged → 1.11 + 1.18 without VAT, less 0.45 of drink.
    expect(await mine()).toMatchObject({
      sold: {
        count: 6,
        revenueCents: 1500 - 146 + 270,
        profitCents: 5 * 210 - (124 - 45) + (111 + 118 - 45),
      },
    });
  });

  it('the whole offer refunded while its hour waits: the hour is gone and it is not counted as sold', async () => {
    const before = await mine();
    const sale = await sell([{ offerId: offer.id }]);
    expect(sale.status).toBe(201);
    const hour = (await credits()).find((c) => c.saleId === sale.body.id)!;
    expect(hour).toMatchObject({ stationId: null, minutesRemaining: 60 });
    expect((await mine()).sold?.count).toBe(before.sold!.count + 1);

    const refund = await call('POST', `/sales/${sale.body.id}/refund`, {
      items: sale.body.items.map((i) => ({ saleItemId: i.id, quantityMilli: i.quantityMilli })),
      reason: 'u pendua',
      restock: true,
    });
    expect(refund.status).toBe(200);
    expect((await credits()).some((c) => c.id === hour.id)).toBe(false);
    // The refunded hour starts no PC.
    const free = (await call<StationSummary>('POST', '/stations', { number: 7, name: 'Arena 7' }))
      .body;
    const start = await call('POST', '/sessions', {
      stationId: free.id,
      billingMode: 'prepaid',
      minutes: 60,
      creditId: hour.id,
    });
    expect(start.status).toBeGreaterThanOrEqual(400);
    expect(await live(free.id)).toBeNull();
    // The drink is back on the shelf and the offer's figures are as before the sale.
    const after = await mine();
    expect(after.stockUnits).toBe(before.stockUnits);
    expect(after.sold).toEqual(before.sold);
  });

  it('an hour a PC already took is not refunded; the drink of that offer still is', async () => {
    const sale = await sell([{ offerId: offer.id }]);
    expect(sale.status).toBe(201);
    const hour = (await credits()).find((c) => c.saleId === sale.body.id)!;
    const pc = (await call<StationSummary>('POST', '/stations', { number: 8, name: 'Arena 8' }))
      .body;
    const start = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: pc.id,
      billingMode: 'prepaid',
      minutes: 60,
      creditId: hour.id,
    });
    expect(start.status).toBe(201);
    const time = sale.body.items.find((i) => !i.productId)!;
    const drink = sale.body.items.find((i) => i.productId === cola.id)!;
    const refused = await call<{ error: { details?: { code?: string } } }>(
      'POST',
      `/sales/${sale.body.id}/refund`,
      { items: [{ saleItemId: time.id, quantityMilli: 1000 }], reason: 'kthim' },
    );
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('CREDIT_USED');
    const stock = await stockOf(cola.id);
    const drinkBack = await call('POST', `/sales/${sale.body.id}/refund`, {
      items: [{ saleItemId: drink.id, quantityMilli: 1000 }],
      reason: 'kthim i pijes',
      restock: true,
    });
    expect(drinkBack.status).toBe(200);
    expect(await stockOf(cola.id)).toBe(stock + 1000);
    // The PC keeps running on its paid hour.
    expect(await live(pc.id)).toMatchObject({ billingMode: 'prepaid', plannedSeconds: 3600 });
  });

  it('the stock limits the offer: the product that runs out first decides, and none left stops it', async () => {
    const last = await call<ProductSummary>('POST', '/products', {
      name: 'Red Bull',
      sellingPriceCents: 250,
      purchaseCostCents: 140,
      initialStockMilli: 1000,
    });
    const both = await call<OfferSummary>('POST', '/offers', {
      name: 'Red Bull + Coca-Cola',
      priceCents: 350,
      items: [
        { productId: last.body.id, quantityMilli: 1000 },
        { productId: cola.id, quantityMilli: 1000 },
      ],
    });
    expect(both.status).toBe(201);
    expect(both.body).toMatchObject({ stockUnits: 1, available: true, minutes: 0 });
    expect((await sell([{ offerId: both.body.id }])).status).toBe(201);
    const after = (await listed()).find((o) => o.id === both.body.id)!;
    expect(after).toMatchObject({ stockUnits: 0, available: false, sold: { count: 1 } });
    const colaLeft = await stockOf(cola.id);
    expect((await sell([{ offerId: both.body.id }])).status).toBeGreaterThanOrEqual(400);
    expect(await stockOf(cola.id)).toBe(colaLeft);
  });

  it('no price rule for PC time: the offer is still costed, its whole price on the products', async () => {
    await ctx.pool.query('UPDATE pricing_rules SET is_active = false');
    const preview = await call<OfferPreview>('POST', '/offers/preview', {
      priceCents: 118,
      minutes: 60,
      items: [{ productId: cola.id, quantityMilli: 1000 }],
    });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      timeCents: 0,
      profit: { netCents: 100, vatCents: 18, costCents: 45, profitCents: 55 },
    });
    expect((await listed()).length).toBeGreaterThan(0);
    await ctx.pool.query('UPDATE pricing_rules SET is_active = true');
  });
});
