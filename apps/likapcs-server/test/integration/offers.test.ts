/**
 * 0.36.0 — offers: products and PC minutes sold together at one price ("Coca-Cola + 60 min").
 *
 * Selling an offer writes its products and its PC time as ordinary sale lines that together cost
 * the offer's price (shared by what each costs outside the offer), takes the products from stock,
 * and gives the minutes to the chosen PC at once: a free PC starts, a running one is extended.
 * When they cannot be given at once they stay a paid credit of that PC (migration 0062).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  receiptRows,
  type LoginResponse,
  type OfferSummary,
  type ProductSummary,
  type SaleDetail,
  type SessionMutationResponse,
  type SessionSummary,
  type StationSummary,
  type TimeCreditSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

// A frozen clock, as in time-credits: sessions never run down during the test.
const T0 = Math.floor(Date.now() / 60_000) * 60_000;

describe('offers: products and PC minutes at one price', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let a: StationSummary;
  let b: StationSummary;
  let c: StationSummary;
  let d: StationSummary;
  let cola: ProductSummary;
  let tost: ProductSummary;
  let offer: OfferSummary;

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
  const sell = (items: Record<string, unknown>[], token = owner.token) =>
    callAs<SaleDetail>(token, 'POST', '/sales', {
      items,
      payments: [{ method: 'cash', amountCents: 100_000 }],
    });

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(T0));
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    a = (await call<StationSummary>('POST', '/stations', { number: 1, name: 'Arena 1' })).body;
    b = (await call<StationSummary>('POST', '/stations', { number: 2, name: 'Arena 2' })).body;
    c = (await call<StationSummary>('POST', '/stations', { number: 3, name: 'Arena 3' })).body;
    d = (await call<StationSummary>('POST', '/stations', { number: 4, name: 'Arena 4' })).body;
    expect((await call('POST', '/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    // 6.00 an hour: 60 minutes cost 600 on their own.
    await call('POST', '/pricing/rules', {
      name: 'Standard',
      rateCentsPerHour: 600,
      billingIncrementMinutes: 1,
    });
    cola = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Coca-Cola',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 30_000,
      })
    ).body;
    tost = (
      await call<ProductSummary>('POST', '/products', {
        name: 'Tost',
        sellingPriceCents: 300,
        purchaseCostCents: 120,
        initialStockMilli: 5_000,
      })
    ).body;
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    vi.useRealTimers();
  });

  it('an offer is made from a product, minutes and a price; it needs something in it', async () => {
    const created = await call<OfferSummary>('POST', '/offers', {
      name: 'Coca-Cola + 60 min',
      priceCents: 600,
      minutes: 60,
      items: [{ productId: cola.id, quantityMilli: 1000 }],
    });
    expect(created.status).toBe(201);
    offer = created.body;
    expect(offer).toMatchObject({
      name: 'Coca-Cola + 60 min',
      priceCents: 600,
      minutes: 60,
      isActive: true,
      productsCents: 150,
      available: true,
    });
    expect(offer.items).toEqual([
      expect.objectContaining({
        productId: cola.id,
        name: 'Coca-Cola',
        quantityMilli: 1000,
        unitPriceCents: 150,
        available: true,
      }),
    ]);

    const empty = await call('POST', '/offers', { name: 'Asgjë', priceCents: 100, items: [] });
    expect(empty.status).toBe(400);
    const twice = await call('POST', '/offers', {
      name: 'Dy herë',
      priceCents: 100,
      items: [
        { productId: cola.id, quantityMilli: 1000 },
        { productId: cola.id, quantityMilli: 1000 },
      ],
    });
    expect(twice.status).toBe(400);

    const listed = await call<{ items: OfferSummary[] }>('GET', '/offers?active=true');
    expect(listed.body.items.map((o) => o.id)).toEqual([offer.id]);
  });

  it('sold for a free PC: one price shared over the lines, the drink leaves the stock, the PC starts', async () => {
    const sale = await sell([{ offerId: offer.id, stationId: a.id }]);
    expect(sale.status).toBe(201);
    expect(sale.body.totalCents).toBe(600);
    expect(sale.body.changeCents).toBe(100_000 - 600);

    // 150 + 600 outside the offer → 600 shared 1 : 4.
    expect(
      sale.body.items.map((i) => [i.description, i.lineTotalCents, i.offer?.group, i.offer?.name]),
    ).toEqual([
      ['Coca-Cola', 120, 1, 'Coca-Cola + 60 min'],
      [`${a.code} · 60 min`, 480, 1, 'Coca-Cola + 60 min'],
    ]);
    expect(sale.body.items[0]!.productId).toBe(cola.id);
    expect(sale.body.items.every((i) => i.discountCents === 0)).toBe(true);
    expect(await stockOf(cola.id)).toBe(29_000);

    expect(sale.body.offerStarts).toEqual([
      { stationId: a.id, stationCode: a.code, minutes: 60, result: 'started', reason: null },
    ]);
    const session = await live(a.id);
    expect(session).toMatchObject({ billingMode: 'prepaid', plannedSeconds: 3600 });
    // The minutes were paid with the sale: nothing waits at the PC, and no second sale was made.
    expect(await credits(a.id)).toEqual([]);
    const sales = await ctx.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sales');
    expect(sales.rows[0]!.n).toBe('1');
  });

  it('sold for a PC that is running: the minutes are added to its session', async () => {
    const sale = await sell([{ offerId: offer.id, stationId: a.id }]);
    expect(sale.status).toBe(201);
    expect(sale.body.offerStarts).toEqual([
      { stationId: a.id, stationCode: a.code, minutes: 60, result: 'extended', reason: null },
    ]);
    expect(await live(a.id)).toMatchObject({ plannedSeconds: 7200 });
    expect(await stockOf(cola.id)).toBe(28_000);
  });

  it('sold without a PC: the minutes belong to a name with a PIN, the drink is sold', async () => {
    const sale = await sell([{ offerId: offer.id, holderName: 'Arben' }]);
    expect(sale.status).toBe(201);
    expect(sale.body.totalCents).toBe(600);
    expect(sale.body.offerStarts).toBeUndefined();
    expect(sale.body.claimPins).toHaveLength(1);
    expect(sale.body.claimPins![0]).toMatchObject({ holderName: 'Arben', minutes: 60 });
    const open = await credits();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ stationId: null, holderName: 'Arben', minutesRemaining: 60 });
    expect(await stockOf(cola.id)).toBe(27_000);
  });

  it('with other lines on the same sale: only the offer is priced as one; the receipt shows it as one row', async () => {
    const sale = await sell([
      { productId: tost.id, quantityMilli: 1000 },
      { offerId: offer.id, stationId: b.id },
    ]);
    expect(sale.status).toBe(201);
    expect(sale.body.totalCents).toBe(300 + 600);
    expect(sale.body.items.map((i) => [i.description, i.lineTotalCents, i.offer?.group])).toEqual([
      ['Tost', 300, undefined],
      ['Coca-Cola', 120, 1],
      [`${b.code} · 60 min`, 480, 1],
    ]);
    expect(sale.body.offerStarts?.[0]).toMatchObject({ stationId: b.id, result: 'started' });

    const again = await call<SaleDetail>('GET', `/sales/${sale.body.id}`);
    expect(receiptRows(again.body.items)).toEqual([
      expect.objectContaining({ description: 'Tost', parts: [], lineTotalCents: 300 }),
      expect.objectContaining({
        description: 'Coca-Cola + 60 min',
        parts: ['Coca-Cola', `${b.code} · 60 min`],
        quantityMilli: 1000,
        unitPriceCents: 600,
        lineTotalCents: 600,
      }),
    ]);
  });

  it('two units and a price that does not divide: the line still costs exactly its share', async () => {
    const pair = await call<OfferSummary>('POST', '/offers', {
      name: '2 Coca-Cola',
      priceCents: 251,
      items: [{ productId: cola.id, quantityMilli: 2000 }],
    });
    expect(pair.status).toBe(201);
    expect(pair.body).toMatchObject({ minutes: 0, productsCents: 300 });
    const before = await stockOf(cola.id);
    // Products only: no PC is asked for and none starts.
    const sale = await sell([{ offerId: pair.body.id }]);
    expect(sale.status).toBe(201);
    expect(sale.body.totalCents).toBe(251);
    expect(sale.body.items).toHaveLength(1);
    expect(sale.body.items[0]).toMatchObject({
      quantityMilli: 2000,
      unitPriceCents: 126,
      discountCents: 1,
      lineTotalCents: 251,
    });
    expect(sale.body.offerStarts).toBeUndefined();
    expect(await stockOf(cola.id)).toBe(before - 2000);
  });

  it('two of the same offer on one sale are two groups', async () => {
    const sale = await sell([
      { offerId: offer.id, stationId: c.id },
      { offerId: offer.id, stationId: c.id },
    ]);
    expect(sale.status).toBe(201);
    expect(sale.body.totalCents).toBe(1200);
    expect(sale.body.items.map((i) => i.offer?.group)).toEqual([1, 1, 2, 2]);
    expect(sale.body.offerStarts?.map((s) => s.result)).toEqual(['started', 'extended']);
    expect(await live(c.id)).toMatchObject({ plannedSeconds: 7200 });
    // 0.36.1: the same offer for the same PC twice is one receipt row with its count.
    expect(
      receiptRows(sale.body.items).map((r) => [
        r.quantityMilli,
        r.unitPriceCents,
        r.lineTotalCents,
      ]),
    ).toEqual([[2000, 600, 1200]]);
  });

  it('a PC on open time keeps the minutes as its paid credit', async () => {
    const open = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: d.id,
      billingMode: 'postpaid',
    });
    expect(open.status).toBe(201);
    const sale = await sell([{ offerId: offer.id, stationId: d.id }]);
    expect(sale.status).toBe(201);
    expect(sale.body.totalCents).toBe(600);
    expect(sale.body.offerStarts).toEqual([
      expect.objectContaining({ stationId: d.id, minutes: 60, result: 'kept' }),
    ]);
    expect(sale.body.offerStarts![0]!.reason).toMatch(/prepaid/i);
    expect(await credits(d.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ stationId: d.id, minutesRemaining: 60 })]),
    );
  });

  it('a cashier who may not control the PCs sells it; the minutes wait at the PC', async () => {
    await ctx.pool.query(
      `DELETE FROM role_permissions
        WHERE permission_code = 'stations.control'
          AND role_id = (SELECT id FROM roles WHERE code = 'cashier')`,
    );
    const created = await call('POST', '/users', {
      username: 'kasa',
      fullName: 'Kasa',
      password: 'Cashier123',
      roles: ['cashier'],
      mustChangePassword: false,
    });
    expect(created.status).toBe(201);
    const cashier = await login(ctx.app, 'kasa', 'Cashier123');
    const offers = await callAs<{ items: OfferSummary[] }>(
      cashier.token,
      'GET',
      '/offers?active=true',
    );
    expect(offers.status).toBe(200);
    // A cashier sells offers but does not make them.
    expect(
      (
        await callAs(cashier.token, 'POST', '/offers', {
          name: 'X',
          priceCents: 1,
          items: [{ productId: cola.id, quantityMilli: 1000 }],
        })
      ).status,
    ).toBe(403);

    const sale = await sell([{ offerId: offer.id, stationId: b.id }], cashier.token);
    expect(sale.status).toBe(201);
    expect(sale.body.offerStarts).toEqual([
      { stationId: b.id, stationCode: b.code, minutes: 60, result: 'kept', reason: 'permission' },
    ]);
    // PC b still runs on the hour it got before; the new hour waits as its credit.
    expect(await live(b.id)).toMatchObject({ plannedSeconds: 3600 });
    expect(await credits(b.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ stationId: b.id, minutesRemaining: 60 })]),
    );
  });

  it('an offer cannot be parked, and one that is off the till is not sold', async () => {
    const parked = await call<{ error?: { details?: { code?: string } } }>(
      'POST',
      '/sales/suspend',
      { items: [{ offerId: offer.id, stationId: a.id }] },
    );
    expect(parked.status).toBe(409);

    const off = await call<OfferSummary>('PATCH', `/offers/${offer.id}`, { isActive: false });
    expect(off.body.isActive).toBe(false);
    expect(
      (await call<{ items: OfferSummary[] }>('GET', '/offers?active=true')).body.items.some(
        (o) => o.id === offer.id,
      ),
    ).toBe(false);
    const before = await stockOf(cola.id);
    const refused = await sell([{ offerId: offer.id, stationId: a.id }]);
    expect(refused.status).toBe(409);
    expect(await stockOf(cola.id)).toBe(before);
    expect(
      (await call<OfferSummary>('PATCH', `/offers/${offer.id}`, { isActive: true })).status,
    ).toBe(200);
  });

  it('a product that ran out stops the offer; nothing is sold and no PC starts', async () => {
    const left = await stockOf(tost.id);
    const meal = await call<OfferSummary>('POST', '/offers', {
      name: 'Tost + 30 min',
      priceCents: 400,
      minutes: 30,
      items: [{ productId: tost.id, quantityMilli: left + 1000 }],
    });
    expect(meal.status).toBe(201);
    expect(meal.body.available).toBe(false);
    const planned = (await live(a.id))!.plannedSeconds;
    const refused = await sell([{ offerId: meal.body.id, stationId: a.id }]);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await stockOf(tost.id)).toBe(left);
    expect((await live(a.id))!.plannedSeconds).toBe(planned);
  });

  it('changing an offer replaces its products; deleting it leaves its name on the sales', async () => {
    const changed = await call<OfferSummary>('PUT', `/offers/${offer.id}`, {
      name: 'Coca-Cola + Tost + 90 min',
      priceCents: 1000,
      minutes: 90,
      items: [
        { productId: cola.id, quantityMilli: 1000 },
        { productId: tost.id, quantityMilli: 1000 },
      ],
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ priceCents: 1000, minutes: 90, productsCents: 450 });
    expect(changed.body.items.map((i) => i.name)).toEqual(['Coca-Cola', 'Tost']);

    // 150 + 300 + 900 outside the offer → 1000 shared 1 : 2 : 6 (111.1, 222.2, 666.7).
    const sale = await sell([{ offerId: offer.id, stationId: a.id }]);
    expect(sale.status).toBe(201);
    expect(sale.body.items.map((i) => i.lineTotalCents)).toEqual([111, 222, 667]);
    expect(sale.body.totalCents).toBe(1000);

    expect((await call('DELETE', `/offers/${offer.id}`)).status).toBe(204);
    const kept = await call<SaleDetail>('GET', `/sales/${sale.body.id}`);
    expect(kept.body.items.map((i) => i.offer)).toEqual([
      { id: null, name: 'Coca-Cola + Tost + 90 min', group: 1 },
      { id: null, name: 'Coca-Cola + Tost + 90 min', group: 1 },
      { id: null, name: 'Coca-Cola + Tost + 90 min', group: 1 },
    ]);
    expect((await sell([{ offerId: offer.id, stationId: a.id }])).status).toBe(404);
  });
});
