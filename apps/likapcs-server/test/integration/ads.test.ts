/**
 * Ads (Admin › Ads → customer screens + promo prices): CRUD and permissions, the device feed
 * (live ads only, in order, promo = price + crossed-out regular), promo pricing enforced by the
 * server at the POS, schedule windows, "add all products with photos", custom-slide pictures,
 * albums (0.12.0) and the `server.display` push on every change. 0.19.3: only slides inside an
 * enabled album show, and a product with stock tracked at zero never shows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROTOCOL_VERSION,
  type AdAlbumSummary,
  type AdBulkResult,
  type AdSummary,
  type ClientAdAlbum,
  type ClientAdItem,
  type LoginResponse,
  type ProductSummary,
  type RegisterDeviceResponse,
  type RegistrationPollResponse,
  type SaleDetail,
  type ServerDisplay,
  type SettingsMap,
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
  /** 0.19.3: a loose slide never shows, so the tests put new slides in this album by default. */
  let baseAlbumId = '';

  const call = <T>(
    token: string | null,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => {
    // New slides land in the base album unless a test names one (or `albumId: null`).
    const body = (payload ?? {}) as Record<string, unknown>;
    const withAlbum =
      method === 'POST' &&
      (url === '/ads' || url === '/ads/products/bulk' || url === '/ads/products/all') &&
      !('albumId' in body)
        ? { albumId: baseAlbumId, ...body }
        : payload;
    return ctx.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: token ? authHeader(token) : {},
        payload: withAlbum === undefined ? undefined : (withAlbum as Record<string, unknown>),
      })
      .then((r) => ({ status: r.statusCode, body: r.body ? (r.json<T>() as T) : (null as T) }));
  };
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
  const expectDisplayPush = async (where: (m: Record<string, unknown>) => boolean = () => true) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const msg = await client.next(deadline - Date.now());
      if (msg.type === 'server.display' && where(msg)) return msg;
    }
    throw new Error('no server.display push');
  };

  beforeAll(async () => {
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'likapcs-ads-'));
    ctx = await createTestContext({ uploadDir });
    owner = await runSetup(ctx.app);
    baseAlbumId = (await call<AdAlbumSummary>(owner.token, 'POST', '/ads/albums', { name: 'Baza' }))
      .body.id;
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

  it('out of stock leaves the screens (state out_of_stock); an archived product is unavailable', async () => {
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
    expect(soldOut.state).toBe('out_of_stock');
    expect(soldOut.productInStock).toBe(false);
    // 0.19.3: sold out → gone from every screen (the owner still sees it in Admin › Ads).
    expect((await feed()).map((i) => i.name)).toEqual(['Coca-Cola 0.5L']);
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
    // Still sold out, so the state stays out_of_stock.
    expect((await call<AdSummary>(owner.token, 'GET', `/ads/${ad.id}`)).body.state).toBe(
      'out_of_stock',
    );
    expect((await feed()).map((i) => i.name)).toEqual(['Coca-Cola 0.5L']);
    // Restock → back on the screens at once (the feed is read live).
    expect(
      (
        await call(owner.token, 'POST', `/products/${chips.id}/stock`, {
          quantityMilliDelta: 10_000,
          reason: 'test restock',
        })
      ).status,
    ).toBeLessThan(300);
    expect((await feed()).map((i) => i.name)).toEqual(['Coca-Cola 0.5L', 'Chips Paprika']);
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

  it('screen options (0018): grid size, full screen, overlays, backdrop and ticker reach the PC live', async () => {
    // Fresh install = the 0.7.x look, so nothing changes on upgrade.
    const before = (await call<SettingsMap>(owner.token, 'GET', '/settings')).body;
    expect(before).toMatchObject({
      'client.ads_grid': '2x2',
      'client.ads_fullscreen': false,
      'client.ads_show_clock': true,
      'client.ads_ticker_text': '',
    });
    // Validation happens on the server, field by field.
    const bad = await call<{ error: { code: string } }>(owner.token, 'PATCH', '/settings', {
      'client.ads_grid': '5x4',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_error');
    expect(
      (
        await call(owner.token, 'PATCH', '/settings', {
          'client.ads_ticker_text': 'x'.repeat(201),
        })
      ).status,
    ).toBe(400);
    // Cashiers may read the screen options (the Admin preview) but not change them.
    expect(
      (await call(cashier.token, 'PATCH', '/settings', { 'client.ads_fullscreen': true })).status,
    ).toBe(403);

    const saved = await call(owner.token, 'PATCH', '/settings', {
      'client.ads_layout': 'grid',
      'client.ads_grid': '4x3',
      'client.ads_fullscreen': true,
      'client.ads_show_clock': false,
      'client.ads_show_status': false,
      'client.ads_image_fit': 'cover',
      'client.ads_caption': 'top',
      'client.ads_motion': false,
      'client.ads_background': 'gold',
      'client.ads_ticker_text': '  Happy hour 18:00 – 20:00  ',
    });
    expect(saved.status).toBe(200);
    // Earlier tests left older display pushes (ad changes) queued on the socket; the one for
    // this save is the first that carries the new grid.
    const push = (await expectDisplayPush(
      (m) => (m as unknown as ServerDisplay).display.ads.grid === '4x3',
    )) as unknown as ServerDisplay;
    expect(push.display.ads).toMatchObject({
      layout: 'grid',
      grid: '4x3',
      fullscreen: true,
      showClock: false,
      showBrand: true,
      showStation: true,
      showStatus: false,
      showCategory: true,
      showProgress: true,
      imageFit: 'cover',
      caption: 'top',
      motion: false,
      background: 'gold',
      tickerText: 'Happy hour 18:00 – 20:00',
    });
    // Stored trimmed; the Admin preview reads exactly what the PCs received.
    const after = (await call<SettingsMap>(owner.token, 'GET', '/settings')).body;
    expect(after['client.ads_grid']).toBe('4x3');
    expect(after['client.ads_ticker_text']).toBe('Happy hour 18:00 – 20:00');
    await call(owner.token, 'PATCH', '/settings', {
      'client.ads_layout': 'card',
      'client.ads_fullscreen': false,
      'client.ads_show_clock': true,
      'client.ads_show_status': true,
      'client.ads_ticker_text': '',
    });
    await expectDisplayPush(
      (m) => (m as unknown as ServerDisplay).display.ads.fullscreen === false,
    );
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
        initialStockMilli: 10_000,
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

  // ─── 0.10.0: ads v2 ───────────────────────────────────────────────────────────

  const hhmm = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const shifted = (minutes: number) => hhmm(new Date(Date.now() + minutes * 60_000));

  it('v2 fields: style, accent, call-to-action, weight reach the PC; validation holds', async () => {
    const created = await call<AdSummary>(owner.token, 'POST', '/ads', {
      kind: 'custom',
      title: 'Tournament Friday',
      style: 'poster',
      accent: '#ff5500',
      cta: 'Ask at the desk',
      weight: 3,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      style: 'poster',
      accent: '#ff5500',
      cta: 'Ask at the desk',
      weight: 3,
      daysMask: 127,
      timeFrom: null,
      timeTo: null,
      stationIds: [],
      videoUrl: null,
      state: 'live',
    });
    const fed = (await feed()).find((i) => i.id === created.body.id)!;
    expect(fed).toMatchObject({
      style: 'poster',
      accent: '#ff5500',
      cta: 'Ask at the desk',
      weight: 3,
    });
    expect(fed.endsAt).toBeNull();
    for (const bad of [
      { accent: 'red' },
      { style: 'neon' },
      { weight: 0 },
      { weight: 11 },
      { timeFrom: '18:00' }, // both or none
      { timeFrom: '25:00', timeTo: '20:00' },
      { daysMask: 128 },
      { videoUrl: 'ftp://x/y.mp4' },
    ])
      expect((await call(owner.token, 'PATCH', `/ads/${created.body.id}`, bad)).status).toBe(400);
    const feedWithMeta = await call<{ items: ClientAdItem[]; nextChangeAt: string | null }>(
      deviceToken,
      'GET',
      '/client/ads',
    );
    expect(feedWithMeta.body.nextChangeAt).toBeNull();
    expect((await call(owner.token, 'DELETE', `/ads/${created.body.id}`)).status).toBe(204);
  });

  it('weekly schedule: outside the hours or on other days the slide is off_hours; the PC learns when to refetch', async () => {
    const list = (await call<{ items: AdSummary[] }>(owner.token, 'GET', '/ads')).body.items;
    const colaAd = list.find((a) => a.productId === cola.id)!;
    // Window that contains now (wraps midnight when late in the day).
    const inside = await call<AdSummary>(owner.token, 'PATCH', `/ads/${colaAd.id}`, {
      timeFrom: shifted(-60),
      timeTo: shifted(+60),
    });
    expect(inside.status).toBe(200);
    expect(inside.body.state).toBe('live');
    expect(inside.body.timeFrom).toBe(shifted(-60));
    let fed = await call<{ items: ClientAdItem[]; nextChangeAt: string | null }>(
      deviceToken,
      'GET',
      '/client/ads',
    );
    expect(fed.body.items.map((i) => i.id)).toContain(colaAd.id);
    expect(fed.body.nextChangeAt).toBeTruthy();
    const next = Date.parse(fed.body.nextChangeAt!);
    expect(next).toBeGreaterThan(Date.now());
    expect(next - Date.now()).toBeLessThanOrEqual(61 * 60_000);

    // Window that starts in 2 hours.
    const later = await call<AdSummary>(owner.token, 'PATCH', `/ads/${colaAd.id}`, {
      timeFrom: shifted(+120),
      timeTo: shifted(+180),
    });
    expect(later.body.state).toBe('off_hours');
    fed = await call(deviceToken, 'GET', '/client/ads');
    expect(fed.body.items.map((i) => i.id)).not.toContain(colaAd.id);
    // An off-hours promo is not charged either.
    const lookup = await call<{ product: ProductSummary }>(
      owner.token,
      'GET',
      `/products/lookup?code=${encodeURIComponent(cola.sku ?? cola.barcodes[0]!)}`,
    );
    expect(lookup.body.product.promoPriceCents).toBeNull();

    // Every day except today.
    const today = (new Date().getDay() + 6) % 7;
    const otherDays = await call<AdSummary>(owner.token, 'PATCH', `/ads/${colaAd.id}`, {
      timeFrom: null,
      timeTo: null,
      daysMask: 127 & ~(1 << today),
    });
    expect(otherDays.body.state).toBe('off_hours');
    const everyDay = await call<AdSummary>(owner.token, 'PATCH', `/ads/${colaAd.id}`, {
      daysMask: 127,
    });
    expect(everyDay.body.state).toBe('live');
  });

  it('a slide can be limited to some PCs; others never receive it', async () => {
    const stations = (await call<{ id: string }[]>(owner.token, 'GET', '/stations')).body;
    const other = (
      await call<{ id: string }>(owner.token, 'POST', '/stations', { number: 9, name: 'PC 9' })
    ).body;
    const created = await call<AdSummary>(owner.token, 'POST', '/ads', {
      kind: 'custom',
      title: 'VIP corner only',
      stationIds: [other.id],
    });
    expect(created.status).toBe(201);
    expect(created.body.stationIds).toEqual([other.id]);
    expect((await feed()).map((i) => i.id)).not.toContain(created.body.id);
    const mine = await call<AdSummary>(owner.token, 'PATCH', `/ads/${created.body.id}`, {
      stationIds: [stations[0]!.id, other.id],
    });
    expect(mine.body.stationIds).toHaveLength(2);
    expect((await feed()).map((i) => i.id)).toContain(created.body.id);
    expect(
      (await call(owner.token, 'PATCH', `/ads/${created.body.id}`, { stationIds: [randomUUID()] }))
        .status,
    ).toBe(400);
    await call(owner.token, 'DELETE', `/ads/${created.body.id}`);
  });

  it('video slides: MP4/WebM upload (magic bytes, size cap), streamed with ranges, removed with the ad; links too', async () => {
    const created = await call<AdSummary>(owner.token, 'POST', '/ads', {
      kind: 'custom',
      title: 'Trailer',
      videoUrl: 'https://example.com/trailer.mp4',
    });
    expect(created.body.videoUrl).toBe('https://example.com/trailer.mp4');
    expect((await feed()).find((i) => i.id === created.body.id)!.videoUrl).toBe(
      'https://example.com/trailer.mp4',
    );
    const uploadVideo = (token: string, payload: Buffer, type = 'video/mp4') =>
      ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/ads/${created.body.id}/video`,
        headers: { ...authHeader(token), 'content-type': type },
        payload,
      });
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypisom'),
      Buffer.alloc(64, 1),
    ]);
    expect((await uploadVideo(cashier.token, mp4)).statusCode).toBe(403);
    expect((await uploadVideo(owner.token, PNG_1X1)).statusCode).toBe(400); // not a video
    expect((await uploadVideo(owner.token, PNG_1X1, 'image/png')).statusCode).toBe(415);
    const up = await uploadVideo(owner.token, mp4);
    expect(up.statusCode).toBe(200);
    const withVideo = up.json<AdSummary>();
    expect(withVideo.videoUrl).toMatch(/^\/api\/v1\/files\/videos\/[a-f0-9]{24}\.mp4$/);
    const file = withVideo.videoUrl!.split('/').pop()!;
    expect(fs.existsSync(path.join(uploadDir, 'videos', file))).toBe(true);
    const whole = await ctx.app.inject({ method: 'GET', url: withVideo.videoUrl! });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers['content-type']).toBe('video/mp4');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.rawPayload.length).toBe(mp4.length);
    const part = await ctx.app.inject({
      method: 'GET',
      url: withVideo.videoUrl!,
      headers: { range: 'bytes=4-7' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 4-7/${mp4.length}`);
    expect(part.rawPayload.toString('ascii')).toBe('ftyp');
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: withVideo.videoUrl!,
          headers: { range: 'bytes=999-' },
        })
      ).statusCode,
    ).toBe(416);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/files/videos/nope.mp4' })).statusCode,
    ).toBe(404);
    // WebM replaces the MP4 (old file gone); a link replaces the upload.
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32, 2)]);
    const up2 = await uploadVideo(owner.token, webm, 'video/webm');
    expect(up2.statusCode).toBe(200);
    expect(up2.json<AdSummary>().videoUrl).toMatch(/\.webm$/);
    expect(fs.existsSync(path.join(uploadDir, 'videos', file))).toBe(false);
    const file2 = up2.json<AdSummary>().videoUrl!.split('/').pop()!;
    const linked = await call<AdSummary>(owner.token, 'PATCH', `/ads/${created.body.id}`, {
      videoUrl: 'https://example.com/other.webm',
    });
    expect(linked.body.videoUrl).toBe('https://example.com/other.webm');
    expect(fs.existsSync(path.join(uploadDir, 'videos', file2))).toBe(false);
    const up3 = await uploadVideo(owner.token, mp4);
    const file3 = up3.json<AdSummary>().videoUrl!.split('/').pop()!;
    expect(
      (await call(owner.token, 'PATCH', `/ads/${created.body.id}`, { videoUrl: null })).status,
    ).toBe(200);
    expect(fs.existsSync(path.join(uploadDir, 'videos', file3))).toBe(false);
    const up4 = await uploadVideo(owner.token, mp4);
    const file4 = up4.json<AdSummary>().videoUrl!.split('/').pop()!;
    expect((await call(owner.token, 'DELETE', `/ads/${created.body.id}`)).status).toBe(204);
    expect(fs.existsSync(path.join(uploadDir, 'videos', file4))).toBe(false);
  });

  it('duplicate makes a disabled custom copy (picture cloned, promo dropped) ready to edit', async () => {
    const list = (await call<{ items: AdSummary[] }>(owner.token, 'GET', '/ads')).body.items;
    const colaAd = list.find((a) => a.productId === cola.id)!;
    await call(owner.token, 'PATCH', `/ads/${colaAd.id}`, {
      promoPriceCents: 100,
      badge: 'HOT',
      style: 'poster',
      cta: 'Order from your seat',
    });
    expect((await call(cashier.token, 'POST', `/ads/${colaAd.id}/duplicate`)).status).toBe(403);
    const copy = await call<AdSummary>(owner.token, 'POST', `/ads/${colaAd.id}/duplicate`);
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({
      kind: 'custom',
      productId: null,
      title: cola.name,
      promoPriceCents: null,
      badge: 'HOT',
      style: 'poster',
      cta: 'Order from your seat',
      enabled: false,
      state: 'disabled',
    });
    expect(copy.body.imageUrl).toBeTruthy();
    expect(copy.body.imageUrl).not.toBe(colaAd.imageUrl);
    expect((await feed()).map((i) => i.id)).not.toContain(copy.body.id);
    // The original is untouched and still the only ad of the product.
    expect(
      (await call(owner.token, 'POST', '/ads', { kind: 'product', productId: cola.id })).status,
    ).toBe(409);
    await call(owner.token, 'DELETE', `/ads/${copy.body.id}`);
  });

  it('albums (0.12.0): own look per album, played in order; off = whole album off; delete only ungroups', async () => {
    type Feed = { items: ClientAdItem[]; albums: ClientAdAlbum[] };
    const fullFeed = async () => (await call<Feed>(deviceToken, 'GET', '/client/ads')).body;
    const before = await fullFeed();
    const looseBefore = before.items.map((i) => i.id);
    expect(looseBefore.length).toBeGreaterThan(0);
    // 0.19.3: the only group is the base album (no implicit "no album" group any more).
    expect(before.albums.map((a) => a.id)).toEqual([baseAlbumId]);
    expect(before.albums[0]!.items.map((i) => i.id)).toEqual(looseBefore);

    // Permissions + validation.
    expect((await call(cashier.token, 'GET', '/ads/albums')).status).toBe(200);
    expect((await call(cashier.token, 'POST', '/ads/albums', { name: 'X' })).status).toBe(403);
    expect((await call(owner.token, 'POST', '/ads/albums', { name: '' })).status).toBe(400);
    expect(
      (await call(owner.token, 'POST', '/ads/albums', { name: 'X', grid: '5x4' })).status,
    ).toBe(400);
    expect(
      (await call(owner.token, 'POST', '/ads/albums', { name: 'X', intervalSeconds: 1 })).status,
    ).toBe(400);

    const grid = await call<AdAlbumSummary>(owner.token, 'POST', '/ads/albums', {
      name: 'Produktet',
      layout: 'grid',
      grid: '3x3',
      intervalSeconds: 12,
    });
    expect(grid.status).toBe(201);
    expect(grid.body).toMatchObject({
      name: 'Produktet',
      layout: 'grid',
      grid: '3x3',
      imageFit: null,
      caption: null,
      style: null,
      intervalSeconds: 12,
      shuffle: null,
      enabled: true,
      adCount: 0,
      liveCount: 0,
    });
    await expectDisplayPush();
    const photos = (
      await call<AdAlbumSummary>(owner.token, 'POST', '/ads/albums', {
        name: 'Foto',
        layout: 'full',
        imageFit: 'cover',
        caption: 'hidden',
        shuffle: false,
      })
    ).body;
    expect(photos.sortOrder).toBeGreaterThan(grid.body.sortOrder);

    // Slides straight into an album (create, bulk) and a slide with an unknown album.
    const slideIn = async (title: string, albumId: string | null) =>
      (
        await call<AdSummary>(owner.token, 'POST', '/ads', {
          kind: 'custom',
          title,
          albumId,
        })
      ).body;
    const g1 = await slideIn('Grid one', grid.body.id);
    const g2 = await slideIn('Grid two', grid.body.id);
    const f1 = await slideIn('Photo one', photos.id);
    expect(g1.albumId).toBe(grid.body.id);
    expect(f1.albumId).toBe(photos.id);
    expect(
      (
        await call(owner.token, 'POST', '/ads', {
          kind: 'custom',
          title: 'Nowhere',
          albumId: randomUUID(),
        })
      ).status,
    ).toBe(404);
    const snack = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Album Snack',
        sellingPriceCents: 90,
        purchaseCostCents: 40,
        initialStockMilli: 10_000,
      })
    ).body;
    const bulk = await call<AdBulkResult>(owner.token, 'POST', '/ads/products/bulk', {
      productIds: [snack.id],
      albumId: photos.id,
    });
    expect(bulk.body.created).toBe(1);
    const snackAd = bulk.body.items.find((a) => a.productId === snack.id)!;
    expect(snackAd.albumId).toBe(photos.id);

    // Admin list = playback order: the base album first, then album by album.
    const list = (await call<{ items: AdSummary[] }>(owner.token, 'GET', '/ads')).body.items;
    const albumOf = list.map((a) => a.albumId);
    const firstGrid = albumOf.indexOf(grid.body.id);
    const firstPhotos = albumOf.indexOf(photos.id);
    expect(albumOf.slice(0, firstGrid).every((id) => id === baseAlbumId)).toBe(true);
    expect(firstGrid).toBeLessThan(firstPhotos);
    expect(albumOf.slice(firstGrid, firstPhotos).every((id) => id === grid.body.id)).toBe(true);
    const albums = (await call<{ items: AdAlbumSummary[] }>(owner.token, 'GET', '/ads/albums')).body
      .items;
    const inBase = list.filter((a) => a.albumId === baseAlbumId);
    expect(albums.map((a) => [a.id, a.adCount, a.liveCount])).toEqual([
      [baseAlbumId, inBase.length, inBase.filter((a) => a.state === 'live').length],
      [grid.body.id, 2, 2],
      [photos.id, 2, 2],
    ]);

    // The PC receives the groups in order, each with its own look (null = owner's default).
    const grouped = await fullFeed();
    expect(grouped.albums.map((a) => a.id)).toEqual([baseAlbumId, grid.body.id, photos.id]);
    expect(grouped.albums[0]!.items.map((i) => i.id)).toEqual(looseBefore);
    expect(grouped.albums[1]).toMatchObject({
      name: 'Produktet',
      layout: 'grid',
      grid: '3x3',
      imageFit: null,
      intervalSeconds: 12,
    });
    expect(grouped.albums[1]!.items.map((i) => i.id)).toEqual([g1.id, g2.id]);
    expect(grouped.albums[2]).toMatchObject({
      name: 'Foto',
      layout: 'full',
      imageFit: 'cover',
      caption: 'hidden',
      shuffle: false,
    });
    expect(grouped.albums[2]!.items.map((i) => i.id)).toEqual([f1.id, snackAd.id]);
    // Flat list for pre-0.12 clients = the same slides, album by album.
    expect(grouped.items.map((i) => i.id)).toEqual([
      ...looseBefore,
      g1.id,
      g2.id,
      f1.id,
      snackAd.id,
    ]);

    // Albums can be reordered (the given ones first).
    const reordered = await call<{ items: AdAlbumSummary[] }>(
      owner.token,
      'PUT',
      '/ads/albums/order',
      {
        ids: [photos.id],
      },
    );
    expect(reordered.body.items.map((a) => a.id)).toEqual([photos.id, baseAlbumId, grid.body.id]);
    expect((await fullFeed()).albums.map((a) => a.id)).toEqual([
      photos.id,
      baseAlbumId,
      grid.body.id,
    ]);
    expect(
      (await call(owner.token, 'PUT', '/ads/albums/order', { ids: [randomUUID()] })).status,
    ).toBe(404);

    // Switching an album off takes all of its slides off the screens.
    const off = await call<AdAlbumSummary>(owner.token, 'PATCH', `/ads/albums/${photos.id}`, {
      enabled: false,
    });
    expect(off.body).toMatchObject({ enabled: false, adCount: 2, liveCount: 0 });
    expect((await call<AdSummary>(owner.token, 'GET', `/ads/${f1.id}`)).body.state).toBe(
      'album_off',
    );
    const dimmed = await fullFeed();
    expect(dimmed.albums.map((a) => a.id)).toEqual([baseAlbumId, grid.body.id]);
    expect(dimmed.items.map((i) => i.id)).not.toContain(f1.id);
    expect(dimmed.items.map((i) => i.id)).not.toContain(snackAd.id);
    // The album's look can be changed; patches are validated like the create body.
    expect(
      (await call(owner.token, 'PATCH', `/ads/albums/${photos.id}`, { layout: 'cube' })).status,
    ).toBe(400);
    expect((await call(owner.token, 'PATCH', `/ads/albums/${photos.id}`, {})).status).toBe(400);
    expect(
      (await call(owner.token, 'PATCH', `/ads/albums/${randomUUID()}`, { name: 'Z' })).status,
    ).toBe(404);

    // Moving slides between albums: bulk move, single patch, out of any album.
    const moved = await call<{ items: AdSummary[] }>(owner.token, 'PUT', '/ads/album', {
      ids: [f1.id, snackAd.id],
      albumId: grid.body.id,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.items.find((a) => a.id === f1.id)!.albumId).toBe(grid.body.id);
    expect(moved.body.items.find((a) => a.id === snackAd.id)!.state).toBe('live');
    expect(
      (await call(owner.token, 'PUT', '/ads/album', { ids: [randomUUID()], albumId: null })).status,
    ).toBe(404);
    expect(
      (await call(owner.token, 'PATCH', `/ads/${g2.id}`, { albumId: randomUUID() })).status,
    ).toBe(404);
    const loose = await call<AdSummary>(owner.token, 'PATCH', `/ads/${g2.id}`, { albumId: null });
    expect(loose.body.albumId).toBeNull();
    // 0.19.3: a slide with no album is kept in the list but never shown on a screen.
    const afterMove = await fullFeed();
    expect(afterMove.albums.map((a) => a.id)).toEqual([baseAlbumId, grid.body.id]);
    expect(afterMove.albums[0]!.items.map((i) => i.id)).toEqual(looseBefore);
    expect(afterMove.items.map((i) => i.id)).not.toContain(g2.id);
    expect(afterMove.albums[1]!.items.map((i) => i.id)).toEqual([g1.id, f1.id, snackAd.id]);

    // Deleting an album only ungroups its slides — they stay in the list, but a slide with no
    // album never shows (0.19.3), so the screens go back to the base album alone.
    expect((await call(cashier.token, 'DELETE', `/ads/albums/${grid.body.id}`)).status).toBe(403);
    expect((await call(owner.token, 'DELETE', `/ads/albums/${grid.body.id}`)).status).toBe(204);
    expect((await call(owner.token, 'DELETE', `/ads/albums/${grid.body.id}`)).status).toBe(404);
    expect((await call<AdSummary>(owner.token, 'GET', `/ads/${g1.id}`)).body.albumId).toBeNull();
    const ungrouped = await fullFeed();
    expect(ungrouped.albums).toHaveLength(1);
    expect(ungrouped.items.map((i) => i.id)).toEqual(looseBefore);
    expect((await call<AdSummary>(owner.token, 'GET', `/ads/${g1.id}`)).body.state).toBe(
      'no_album',
    );

    // Clean up what this test added.
    await call(owner.token, 'DELETE', `/ads/albums/${photos.id}`);
    for (const id of [g1.id, g2.id, f1.id, snackAd.id])
      await call(owner.token, 'DELETE', `/ads/${id}`);
    expect((await fullFeed()).items.map((i) => i.id)).toEqual(looseBefore);
  });

  it('0.19.3: only slides inside an enabled album show; a product with stock not tracked always shows', async () => {
    // A product that does not track stock (a service) has no stock to run out of.
    const service = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Shërbim pa stok',
        sellingPriceCents: 300,
        purchaseCostCents: 0,
        trackStock: false,
      })
    ).body;
    const serviceAd = await call<AdSummary>(owner.token, 'POST', '/ads', {
      kind: 'product',
      productId: service.id,
    });
    expect(serviceAd.status).toBe(201);
    expect(serviceAd.body.productInStock).toBe(true);
    expect((await feed()).map((i) => i.id)).toContain(serviceAd.body.id);

    // A slide in no album (explicit null) never shows, and says so in its state.
    const loose = await call<AdSummary>(owner.token, 'POST', '/ads', {
      kind: 'custom',
      title: 'Pa album',
      albumId: null,
    });
    expect(loose.body.state).toBe('no_album');
    expect((await feed()).map((i) => i.id)).not.toContain(loose.body.id);

    // A slide in an album that is switched off never shows; back on → it does.
    const album = (
      await call<AdAlbumSummary>(owner.token, 'POST', '/ads/albums', { name: 'Fikur' })
    ).body;
    const inAlbum = await call<AdSummary>(owner.token, 'POST', '/ads', {
      kind: 'custom',
      title: 'Në album',
      albumId: album.id,
    });
    expect(inAlbum.body.state).toBe('live');
    expect((await feed()).map((i) => i.id)).toContain(inAlbum.body.id);
    await call(owner.token, 'PATCH', `/ads/albums/${album.id}`, { enabled: false });
    expect((await feed()).map((i) => i.id)).not.toContain(inAlbum.body.id);
    expect((await call<AdSummary>(owner.token, 'GET', `/ads/${inAlbum.body.id}`)).body.state).toBe(
      'album_off',
    );
    await call(owner.token, 'PATCH', `/ads/albums/${album.id}`, { enabled: true });
    expect((await feed()).map((i) => i.id)).toContain(inAlbum.body.id);

    // Nothing else changed: the loose slide is still kept in the admin list, just never fed.
    expect((await feed()).map((i) => i.id)).not.toContain(loose.body.id);
  });
});
