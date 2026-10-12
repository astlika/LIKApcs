/**
 * Ads (Admin › Ads → customer screens + promo prices): CRUD and permissions, the device feed
 * (live ads only, in order, promo = price + crossed-out regular), promo pricing enforced by the
 * server at the POS, schedule windows, "add all products with photos", custom-slide pictures and
 * the `server.display` push on every change.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROTOCOL_VERSION,
  type AdBulkResult,
  type AdSummary,
  type ClientAdItem,
  type LoginResponse,
  type ProductSummary,
  type RegisterDeviceResponse,
  type RegistrationPollResponse,
  type SaleDetail,
  type StationSummary,
} from '@likapcs/shared';
import { SERVER_VERSION } from '../../src/version.js';
import {
  authHeader,
  createTestContext,
  login,
  openSocket,
  runSetup,
  type TestContext,
} from '../helpers.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('ads: curated customer-screen slideshow and promo prices', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let deviceToken: string;
  let client: Awaited<ReturnType<typeof openSocket>>;
  let uploadDir: string;
  let cola: ProductSummary;
  let chips: ProductSummary;
  let noPhoto: ProductSummary;

  const call = <T>(
    token: string | null,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
  ) =>
    ctx.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: token ? authHeader(token) : {},
        payload: payload === undefined ? undefined : (payload as Record<string, unknown>),
      })
      .then((r) => ({ status: r.statusCode, body: r.body ? (r.json<T>() as T) : (null as T) }));
  const feed = async () =>
    (await call<{ items: ClientAdItem[] }>(deviceToken, 'GET', '/client/ads')).body.items;
  const upload = (url: string, token: string, payload: Buffer) =>
    ctx.app.inject({
      method: 'PUT',
      url: `/api/v1${url}`,
      headers: { ...authHeader(token), 'content-type': 'image/png' },
      payload,
    });
  /** Drains the device socket until a `server.display` arrives (or fails after 5 s). */
  const expectDisplayPush = async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const msg = await client.next(deadline - Date.now());
      if (msg.type === 'server.display') return msg;
    }
    throw new Error('no server.display push');
  };

  beforeAll(async () => {
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'likapcs-ads-'));
    ctx = await createTestContext({ uploadDir });
    owner = await runSetup(ctx.app);
    await call(owner.token, 'POST', '/users', {
      username: 'kasa',
      fullName: 'Kasa Cashier',
      password: 'Cashier123',
      roles: ['cashier'],
      mustChangePassword: false,
    });
    cashier = await login(ctx.app, 'kasa', 'Cashier123');
    expect(
      (await call(owner.token, 'POST', '/cash/shifts/open', { openingCents: 2000 })).status,
    ).toBe(201);
    const product = async (name: string, price: number, photo: boolean, stock = 100_000) => {
      const p = (
        await call<ProductSummary>(owner.token, 'POST', '/products', {
          name,
          sellingPriceCents: price,
          purchaseCostCents: Math.floor(price / 2),
          initialStockMilli: stock,
        })
      ).body;
      if (photo)
        expect((await upload(`/products/${p.id}/image`, owner.token, PNG_1X1)).statusCode).toBe(
          200,
        );
      return (await call<ProductSummary>(owner.token, 'GET', `/products/${p.id}`)).body;
    };
    cola = await product('Coca-Cola 0.5L', 150, true);
    chips = await product('Chips Paprika', 120, true);
    noPhoto = await product('Water 0.5L', 80, false);

    // A paired, connected PC for the feed and the push.
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const station = (
      await call<StationSummary>(owner.token, 'POST', '/stations', { number: 1, name: 'PC 1' })
    ).body;
    const registrationSecret = randomBytes(32).toString('base64url');
    const machineId = 'MACHINE-ADS-0001';
    const reg = await call<RegisterDeviceResponse>(null, 'POST', '/client/register', {
      machineId,
      hostname: 'PC-01',
      osInfo: 'Windows 11',
      appVersion: SERVER_VERSION,
      registrationSecret,
    });
    await call(owner.token, 'POST', `/devices/${reg.body.registrationId}/approve`, {
      stationId: station.id,
    });
    const poll = await call<RegistrationPollResponse>(
      null,
      'GET',
      `/client/registration/${reg.body.registrationId}?secret=${registrationSecret}`,
    );
    deviceToken = poll.body.deviceToken!;
    client = await openSocket(`ws://127.0.0.1:${port}/ws/client`);
    client.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId,
    });
    expect((await client.next()).type).toBe('server.welcome');
  }, 30_000);

  afterAll(async () => {
    client?.socket.close();
    await ctx.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  it('starts empty on a fresh install (products are not advertised until the owner says so)', async () => {
    expect((await call<{ items: AdSummary[] }>(owner.token, 'GET', '/ads')).body.items).toEqual([]);
    expect(await feed()).toEqual([]);
    expect(cola.promoPriceCents).toBeNull();
  });

  it('needs products.view to read and products.manage to change; validates the shape', async () => {
    expect((await call(null, 'GET', '/ads')).status).toBe(401);
    expect((await call(cashier.token, 'GET', '/ads')).status).toBe(200); // cashiers see products
    expect(
      (await call(cashier.token, 'POST', '/ads', { kind: 'product', productId: cola.id })).status,
    ).toBe(403);
    expect((await call(owner.token, 'POST', '/ads', { kind: 'product' })).status).toBe(400);
    expect(
      (await call(owner.token, 'POST', '/ads', { kind: 'custom', body: 'no title' })).status,
    ).toBe(400);
    expect(
      (
        await call(owner.token, 'POST', '/ads', {
          kind: 'custom',
          title: 'x',
          promoPriceCents: 100,
        })
      ).status,
    ).toBe(400);
    const notBelow = await call<{ error: { details: { code: string } } }>(
      owner.token,
      'POST',
      '/ads',
      {
        kind: 'product',
        productId: cola.id,
        promoPriceCents: 150,
      },
    );
    expect(notBelow.status).toBe(400);
    expect(notBelow.body.error.details.code).toBe('PROMO_NOT_BELOW_PRICE');
  });

  it('product ad with a promo: feed shows new + old price, the POS charges the promo, pushes server.display', async () => {
    const created = await call<AdSummary>(owner.token, 'POST', '/ads', {
      kind: 'product',
      productId: cola.id,
      promoPriceCents: 100,
      badge: '-33%',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'product',
      productId: cola.id,
      productName: 'Coca-Cola 0.5L',
      productPriceCents: 150,
      promoPriceCents: 100,
      badge: '-33%',
      enabled: true,
      state: 'live',
    });
    expect(created.body.imageUrl).toBe(cola.imageUrl);
    expect((await expectDisplayPush()).type).toBe('server.display');

    // One ad per product.
    const dup = await call<{ error: { details: { code: string } } }>(owner.token, 'POST', '/ads', {
      kind: 'product',
      productId: cola.id,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.code).toBe('AD_EXISTS');

    const items = await feed();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'product',
      name: 'Coca-Cola 0.5L',
      priceCents: 100,
      oldPriceCents: 150,
      badge: '-33%',
      imageUrl: cola.imageUrl,
      body: null,
    });

    // The catalogue reports the live promo; the POS never sends prices — the server charges it.
    const listed = (await call<ProductSummary>(owner.token, 'GET', `/products/${cola.id}`)).body;
    expect(listed.sellingPriceCents).toBe(150);
    expect(listed.promoPriceCents).toBe(100);
    const sale = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 2000 }],
      payments: [{ method: 'cash', amountCents: 200 }],
    });
    expect(sale.status).toBe(201);
    expect(sale.body.totalCents).toBe(200);
    expect(sale.body.items[0]!.unitPriceCents).toBe(100);

    // Disabled → gone from the feed and no longer charged.
    const off = await call<AdSummary>(owner.token, 'PATCH', `/ads/${created.body.id}`, {
      enabled: false,
    });
    expect(off.status).toBe(200);
    expect(off.body.state).toBe('disabled');
    expect(await feed()).toEqual([]);
    expect(
      (await call<ProductSummary>(owner.token, 'GET', `/products/${cola.id}`)).body.promoPriceCents,
    ).toBeNull();
    const full = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(full.status).toBe(201);
    expect(full.body.totalCents).toBe(150);
    await call(owner.token, 'PATCH', `/ads/${created.body.id}`, { enabled: true });
  });

  it('schedules: future start = scheduled, past end = expired; neither is in the feed or charged', async () => {
    const ad = (
      await call<AdSummary>(owner.token, 'POST', '/ads', {
        kind: 'product',
        productId: chips.id,
        promoPriceCents: 90,
        startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
    ).body;
    expect(ad.state).toBe('scheduled');
    expect((await feed()).map((i) => i.name)).toEqual(['Coca-Cola 0.5L']);
    expect(
      (await call<ProductSummary>(owner.token, 'GET', `/products/${chips.id}`)).body
        .promoPriceCents,
    ).toBeNull();

    const expired = await call<AdSummary>(owner.token, 'PATCH', `/ads/${ad.id}`, {
      startsAt: new Date(Date.now() - 7_200_000).toISOString(),
      endsAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    expect(expired.body.state).toBe('expired');
    expect((await feed()).map((i) => i.name)).toEqual(['Coca-Cola 0.5L']);

    const badWindow = await call(owner.token, 'PATCH', `/ads/${ad.id}`, {
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now()).toISOString(),
    });
    expect(badWindow.status).toBe(400);

    const live = await call<AdSummary>(owner.token, 'PATCH', `/ads/${ad.id}`, {
      startsAt: null,
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(live.body.state).toBe('live');
    expect((await feed()).map((i) => i.priceCents)).toEqual([100, 90]);
  });

  it('out of stock stays on the screens (only flagged); an archived product is unavailable', async () => {
    const ad = (await call<{ items: AdSummary[] }>(owner.token, 'GET', '/ads')).body.items.find(
      (a) => a.productId === chips.id,
    )!;
    // Sell the whole stock of chips (100 pcs) at the promo price.
    const sale = await call<SaleDetail>(owner.token, 'POST', '/sales', {
      items: [{ productId: chips.id, quantityMilli: 100_000 }],
      payments: [{ method: 'cash', amountCents: 9_000 }],
    });
    expect(sale.status).toBe(201);
    expect(sale.body.totalCents).toBe(9_000); // promo price 0.90 × 100
    const soldOut = (await call<AdSummary>(owner.token, 'GET', `/ads/${ad.id}`)).body;
    expect(soldOut.state).toBe('live');
    expect(soldOut.productInStock).toBe(false);
    expect((await feed()).map((i) => i.name)).toEqual(['Coca-Cola 0.5L', 'Chips Paprika']);
    // Archive the product → off the screens by itself; back when it is reactivated.
    expect(
      (await call(owner.token, 'PATCH', `/products/${chips.id}`, { isActive: false })).status,
    ).toBe(200);
    expect((await call<AdSummary>(owner.token, 'GET', `/ads/${ad.id}`)).body.state).toBe(
      'unavailable',
    );
    expect((await feed()).map((i) => i.name)).toEqual(['Coca-Cola 0.5L']);
    expect(
      (await call(owner.token, 'PATCH', `/products/${chips.id}`, { isActive: true })).status,
    ).toBe(200);
    expect((await call<AdSummary>(owner.token, 'GET', `/ads/${ad.id}`)).body.state).toBe('live');
    // Restock so the later sales in this file keep working.
    expect(
      (
        await call(owner.token, 'POST', `/products/${chips.id}/stock`, {
          quantityMilliDelta: 10_000,
          reason: 'test restock',
        })
      ).status,
    ).toBeLessThan(300);
  });

  it('options (0017): theme, own duration and a text line on a product ad reach the feed', async () => {
    const ad = (await call<{ items: AdSummary[] }>(owner.token, 'GET', '/ads')).body.items.find(
      (a) => a.productId === cola.id,
    )!;
    const bad = await call(owner.token, 'PATCH', `/ads/${ad.id}`, { theme: 'neon' });
    expect(bad.status).toBe(400);
    expect((await call(owner.token, 'PATCH', `/ads/${ad.id}`, { durationSeconds: 2 })).status).toBe(
      400,
    );
    const updated = await call<AdSummary>(owner.token, 'PATCH', `/ads/${ad.id}`, {
      theme: 'sunset',
      durationSeconds: 15,
      body: 'Ice cold — 2 for 1 until 20:00',
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ theme: 'sunset', durationSeconds: 15 });
    const item = (await feed()).find((i) => i.id === ad.id)!;
    expect(item).toMatchObject({
      theme: 'sunset',
      durationSeconds: 15,
      body: 'Ice cold — 2 for 1 until 20:00',
    });
    // Back to defaults: null clears both.
    const cleared = await call<AdSummary>(owner.token, 'PATCH', `/ads/${ad.id}`, {
      theme: null,
      durationSeconds: null,
      body: null,
    });
    expect(cleared.body).toMatchObject({ theme: null, durationSeconds: null, body: null });
  });

  it('custom slides: title/body, picture upload + link + removal, text-only slides are fed too', async () => {
    const created = await call<AdSummary>(owner.token, 'POST', '/ads', {
      kind: 'custom',
      title: 'Happy hour 18–20',
      body: 'Every PC −30% between 18:00 and 20:00',
      badge: 'HOT',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: 'custom', imageUrl: null, state: 'live' });
    const asFed = (await feed()).find((i) => i.id === created.body.id)!;
    expect(asFed).toMatchObject({
      kind: 'custom',
      name: 'Happy hour 18–20',
      body: 'Every PC −30% between 18:00 and 20:00',
      priceCents: null,
      oldPriceCents: null,
      badge: 'HOT',
      imageUrl: null,
    });

    expect((await upload(`/ads/${created.body.id}/image`, cashier.token, PNG_1X1)).statusCode).toBe(
      403,
    );
    const up = await upload(`/ads/${created.body.id}/image`, owner.token, PNG_1X1);
    expect(up.statusCode).toBe(200);
    const withImage = up.json<AdSummary>();
    expect(withImage.imageUrl).toMatch(/^\/api\/v1\/files\/products\/[a-z0-9]{24}\.png$/);
    const file = withImage.imageUrl!.split('/').pop()!;
    expect(fs.existsSync(path.join(uploadDir, 'products', file))).toBe(true);
    const served = await ctx.app.inject({ method: 'GET', url: withImage.imageUrl! });
    expect(served.statusCode).toBe(200);

    const cleared = await call<AdSummary>(owner.token, 'DELETE', `/ads/${created.body.id}/image`);
    expect(cleared.status).toBe(200);
    expect(cleared.body.imageUrl).toBeNull();
    expect(fs.existsSync(path.join(uploadDir, 'products', file))).toBe(false);

    // Title cannot be removed from a custom slide; promo price is refused.
    expect(
      (await call(owner.token, 'PATCH', `/ads/${created.body.id}`, { title: null })).status,
    ).toBe(400);
    expect(
      (await call(owner.token, 'PATCH', `/ads/${created.body.id}`, { promoPriceCents: 10 })).status,
    ).toBe(400);
  });

  it('reorders by hand and bulk-adds products exactly once (chosen ones, or all)', async () => {
    const before = (await call<{ items: AdSummary[] }>(owner.token, 'GET', '/ads')).body.items;
    expect(before.map((a) => a.kind)).toEqual(['product', 'product', 'custom']);
    const custom = before.find((a) => a.kind === 'custom')!;
    const reordered = await call<{ items: AdSummary[] }>(owner.token, 'PUT', '/ads/order', {
      ids: [custom.id],
    });
    expect(reordered.status).toBe(200);
    expect(reordered.body.items.map((a) => a.id)).toEqual([
      custom.id,
      ...before.filter((a) => a.id !== custom.id).map((a) => a.id),
    ]);
    expect((await feed())[0]!.id).toBe(custom.id);
    expect(
      (
        await call(owner.token, 'PUT', '/ads/order', {
          ids: ['00000000-0000-4000-8000-000000000000'],
        })
      ).status,
    ).toBe(404);

    // cola + chips already have ads; "Water" has no photo → "only with photo" adds nothing…
    const none = await call<AdBulkResult>(owner.token, 'POST', '/ads/products/all', {
      onlyWithPhoto: true,
    });
    expect(none.status).toBe(200);
    expect(none.body.created).toBe(0);
    // …the product browser adds the chosen products (existing ads and unknown ids are skipped)…
    const chosen = await call<AdBulkResult>(owner.token, 'POST', '/ads/products/bulk', {
      productIds: [cola.id, noPhoto.id, '00000000-0000-4000-8000-000000000000'],
    });
    expect(chosen.status).toBe(200);
    expect(chosen.body.created).toBe(1);
    expect(chosen.body.items.at(-1)).toMatchObject({
      kind: 'product',
      productId: noPhoto.id,
      promoPriceCents: null,
      imageUrl: null,
    });
    // …and a text-only product slide is part of the feed.
    expect((await feed()).find((i) => i.id === chosen.body.items.at(-1)!.id)).toMatchObject({
      name: 'Water 0.5L',
      imageUrl: null,
      priceCents: 80,
    });
    // "Add all" has nothing left to add; a fourth product shows it adds photo-less ones too.
    expect((await call<AdBulkResult>(owner.token, 'POST', '/ads/products/all')).body.created).toBe(
      0,
    );
    const fourth = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Gum',
        sellingPriceCents: 50,
        purchaseCostCents: 20,
      })
    ).body;
    const all = await call<AdBulkResult>(owner.token, 'POST', '/ads/products/all');
    expect(all.body.created).toBe(1);
    expect(all.body.items.at(-1)!.productId).toBe(fourth.id);
    expect(await feed()).toHaveLength(5);
  });

  it('deleting an ad (or its product) removes it everywhere', async () => {
    const list = (await call<{ items: AdSummary[] }>(owner.token, 'GET', '/ads')).body.items;
    const water = list.find((a) => a.productId === noPhoto.id)!;
    expect((await call(cashier.token, 'DELETE', `/ads/${water.id}`)).status).toBe(403);
    expect((await call(owner.token, 'DELETE', `/ads/${water.id}`)).status).toBe(204);
    expect((await call(owner.token, 'GET', `/ads/${water.id}`)).status).toBe(404);
    expect((await feed()).map((i) => i.id)).not.toContain(water.id);
  });
});
