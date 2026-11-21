/**
 * 0.37.0 — the program on a small main PC. What changed is only how much work a request costs;
 * these tests pin what each lighter path still has to say.
 *
 *  • a connected PC is written to the database on its first heartbeat, when something about it
 *    changes, and otherwise once a minute (one load sample every five) — not every 10 seconds;
 *  • `GET /cash/status?brief=true`: whether a shift is open, without its movements;
 *  • `GET /offers?money=false`: the offers without what they earn and what they have sold;
 *  • a product picture has a small copy for the tiles, tied to the picture it was made from;
 *  • the sessions that wait for their money are found the same way as before;
 *  • the heartbeats of an archive are not brought back by a restore.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BackupSummary,
  CashStatusBrief,
  CashStatusResponse,
  LoginResponse,
  OfferSummary,
  ProductSummary,
  ProductThumbMissing,
  RegisterDeviceResponse,
  SessionMutationResponse,
  SessionSummary,
  StationDeviceSummary,
  StationSummary,
} from '@likapcs/shared';
import {
  DEVICE_TOUCH_INTERVAL_MS,
  HEARTBEAT_SAMPLE_INTERVAL_MS,
} from '../../src/services/devices.js';
import { SERVER_VERSION } from '../../src/version.js';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('0.37.0: lighter paths for a small main PC', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let uploadDir: string;
  let backupDir: string;
  let pc1: StationSummary;
  let pc2: StationSummary;
  let deviceId: string;
  let cola: ProductSummary;

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
  const upload = (url: string, payload: Buffer, token = owner.token, type = 'image/png') =>
    ctx.app.inject({
      method: 'PUT',
      url: `/api/v1${url}`,
      headers: { ...authHeader(token), 'content-type': type },
      payload,
    });
  const product = async (id: string) => (await call<ProductSummary>('GET', `/products/${id}`)).body;
  const fileOf = (url: string | null | undefined) => url!.split('/').pop()!;
  const stored = (file: string) => fs.existsSync(path.join(uploadDir, 'products', file));
  const missing = async () =>
    (await call<{ items: ProductThumbMissing[] }>('GET', '/catalog/product-thumbs/missing')).body
      .items;

  beforeAll(async () => {
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'likapcs-speed-up-'));
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'likapcs-speed-bk-'));
    ctx = await createTestContext({ uploadDir, backupDir });
    owner = await runSetup(ctx.app);
    pc1 = (await call<StationSummary>('POST', '/stations', { number: 1, name: 'Arena 1' })).body;
    pc2 = (await call<StationSummary>('POST', '/stations', { number: 2, name: 'Arena 2' })).body;
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
    await call('POST', '/users', {
      username: 'kasa',
      fullName: 'Kasa',
      password: 'Cashier123',
      roles: ['cashier'],
      mustChangePassword: false,
    });
    cashier = await login(ctx.app, 'kasa', 'Cashier123');
    // A paired PC (never connected in this file: the heartbeats are given to the service).
    const registered = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: {
        machineId: 'MACHINE-SPEED-0001',
        hostname: 'GAMING-PC-01',
        appVersion: SERVER_VERSION,
        registrationSecret: 'speed-secret-0123456789abcdef-0123456789',
      },
    });
    expect(registered.statusCode).toBe(202);
    deviceId = registered.json<RegisterDeviceResponse>().registrationId;
    const approved = await call<StationDeviceSummary>('POST', `/devices/${deviceId}/approve`, {
      stationId: pc1.id,
    });
    expect(approved.status).toBe(200);
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
  });

  // ─── Heartbeats ───────────────────────────────────────────────────────────────

  describe('heartbeats of a connected PC', () => {
    const T0 = Date.UTC(2026, 10, 21, 10, 0, 0);
    const beat = (at: number, patch: Record<string, unknown> = {}) =>
      ctx.app.services.devices.recordHeartbeat(
        deviceId,
        pc1.id,
        {
          appVersion: SERVER_VERSION,
          ip: '192.168.1.21',
          locked: true,
          metrics: { cpuPercent: 12 },
          sessionId: null,
          ...patch,
        },
        at,
      );
    const samples = async () =>
      Number(
        (
          await ctx.pool.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM station_heartbeats WHERE device_id = $1',
            [deviceId],
          )
        ).rows[0]!.n,
      );
    const lastSeen = async () =>
      (
        await ctx.pool.query<{ last_seen_at: Date | null }>(
          'SELECT last_seen_at FROM station_devices WHERE id = $1',
          [deviceId],
        )
      ).rows[0]!.last_seen_at?.getTime() ?? null;

    it('the first one is written; the ones that follow within the minute are not', async () => {
      await beat(T0);
      expect(await lastSeen()).toBe(T0);
      expect(await samples()).toBe(1);
      for (let s = 10; s < 60; s += 10) await beat(T0 + s * 1000);
      expect(await lastSeen()).toBe(T0);
      expect(await samples()).toBe(1);
    });

    it('once a minute the PC is written again; a load sample is kept every five', async () => {
      await beat(T0 + DEVICE_TOUCH_INTERVAL_MS);
      expect(await lastSeen()).toBe(T0 + DEVICE_TOUCH_INTERVAL_MS);
      expect(await samples()).toBe(1);
      await beat(T0 + HEARTBEAT_SAMPLE_INTERVAL_MS);
      expect(await lastSeen()).toBe(T0 + HEARTBEAT_SAMPLE_INTERVAL_MS);
      expect(await samples()).toBe(2);
    });

    it('a change (unlocked, a session, another address) is written at once', async () => {
      const at = T0 + HEARTBEAT_SAMPLE_INTERVAL_MS + 10_000;
      await beat(at, { locked: false });
      expect(await lastSeen()).toBe(at);
      expect(await samples()).toBe(3);
      const row = await ctx.pool.query<{ locked: boolean; last_heartbeat: { locked: boolean } }>(
        `SELECT h.locked, d.last_heartbeat FROM station_heartbeats h
           JOIN station_devices d ON d.id = h.device_id
          WHERE h.device_id = $1 ORDER BY h.id DESC LIMIT 1`,
        [deviceId],
      );
      expect(row.rows[0]).toMatchObject({ locked: false, last_heartbeat: { locked: false } });
      // The same state again, ten seconds later: nothing to write.
      await beat(at + 10_000, { locked: false });
      expect(await lastSeen()).toBe(at);
      expect(await samples()).toBe(3);
    });

    it('when the PC goes, the time of its last heartbeat is what "last seen" says', async () => {
      const last = T0 + HEARTBEAT_SAMPLE_INTERVAL_MS + 45_000;
      await ctx.app.services.devices.deviceGone(deviceId, new Date(last));
      expect(await lastSeen()).toBe(last);
      // It connects again: its first heartbeat is written, whatever the time since the last one.
      await beat(last + 5_000, { locked: false });
      expect(await lastSeen()).toBe(last + 5_000);
      expect(await samples()).toBe(4);
    });
  });

  // ─── Cash status ──────────────────────────────────────────────────────────────

  it('the brief cash status says a shift is open without listing its movements', async () => {
    const sale = await call('POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 190 }],
    });
    expect(sale.status).toBe(201);
    const full = (await call<CashStatusResponse>('GET', '/cash/status')).body;
    expect(full.current?.movements.length).toBeGreaterThan(0);
    expect(full.current?.totals.cashSalesCents).toBe(190);

    const brief = await call<CashStatusBrief>('GET', '/cash/status?brief=true');
    expect(brief.status).toBe(200);
    expect(brief.body.current).toMatchObject({
      id: full.current!.id,
      status: 'open',
      openingCents: 5000,
      registerName: full.current!.registerName,
    });
    expect(brief.body.current).not.toHaveProperty('movements');
    expect(brief.body.current).not.toHaveProperty('totals');
    expect(brief.body.registers).toEqual(full.registers);
    expect(brief.body.requireOpenShift).toBe(full.requireOpenShift);
    expect(brief.body.differenceWarningCents).toBe(full.differenceWarningCents);
    // Who may not see the cash register gets neither.
    const made = await call('POST', '/users', {
      username: 'magazina',
      fullName: 'Magazina',
      password: 'Magazina123',
      roles: ['inventory'],
      mustChangePassword: false,
    });
    expect(made.status).toBe(201);
    const stock = await login(ctx.app, 'magazina', 'Magazina123');
    expect((await callAs(stock.token, 'GET', '/cash/status?brief=true')).status).toBe(403);
    expect((await call('GET', '/cash/status?brief=maybe')).status).toBe(400);
  });

  // ─── Offers ───────────────────────────────────────────────────────────────────

  it('the offers come without their money figures when asked so', async () => {
    const offer = await call<OfferSummary>('POST', '/offers', {
      name: 'Cola + 60 min',
      priceCents: 300,
      minutes: 60,
      items: [{ productId: cola.id, quantityMilli: 1000 }],
    });
    expect(offer.status).toBe(201);
    const list = async (query: string, token = owner.token) =>
      (await callAs<{ items: OfferSummary[] }>(token, 'GET', `/offers${query}`)).body.items;

    const withMoney = (await list('?active=true'))[0]!;
    expect(withMoney.profit).not.toBeNull();
    expect(withMoney.sold).toEqual({ count: 0, revenueCents: 0, profitCents: 0 });

    const without = (await list('?active=true&money=false'))[0]!;
    expect(without.profit).toBeNull();
    expect(without.sold).toBeNull();
    // Everything the till needs is still there.
    expect(without).toMatchObject({
      id: withMoney.id,
      name: 'Cola + 60 min',
      priceCents: 300,
      minutes: 60,
      available: true,
      stockUnits: withMoney.stockUnits,
      items: [{ productId: cola.id, quantityMilli: 1000 }],
    });
    // `money=true` never gives the figures to who may not see them.
    expect((await list('?active=true&money=true', cashier.token))[0]!.profit).toBeNull();
    expect((await call('GET', '/offers?money=maybe')).status).toBe(400);
  });

  // ─── Small copies of the product pictures ─────────────────────────────────────

  describe('small copy of a product picture', () => {
    let picture: string;
    let thumb: string;

    it('a new picture has none yet and is listed as missing', async () => {
      expect((await upload(`/products/${cola.id}/image`, PNG_1X1)).statusCode).toBe(200);
      const p = await product(cola.id);
      picture = fileOf(p.imageUrl);
      expect(p.imageThumbUrl).toBeNull();
      expect(await missing()).toEqual([{ id: cola.id, image: picture, imageUrl: p.imageUrl }]);
      // Only who manages the products makes the copies.
      expect((await callAs(cashier.token, 'GET', '/catalog/product-thumbs/missing')).status).toBe(
        403,
      );
    });

    it('the copy is stored for the picture it was made from', async () => {
      const refused = await upload(
        `/products/${cola.id}/image/thumb?of=${picture}`,
        PNG_1X1,
        cashier.token,
      );
      expect(refused.statusCode).toBe(403);
      const res = await upload(`/products/${cola.id}/image/thumb?of=${picture}`, PNG_1X1);
      expect(res.statusCode).toBe(200);
      const p = res.json<ProductSummary>();
      expect(p.imageUrl).toMatch(new RegExp(`${picture}$`));
      expect(p.imageThumbUrl).toMatch(/^\/api\/v1\/files\/products\/[a-z0-9]{24}\.png$/);
      thumb = fileOf(p.imageThumbUrl);
      expect(thumb).not.toBe(picture);
      expect(stored(thumb)).toBe(true);
      expect(await missing()).toEqual([]);
      // The lists and the offers carry it too.
      const listed = (await call<{ items: ProductSummary[] }>('GET', '/products?pageSize=200')).body
        .items;
      expect(listed.find((x) => x.id === cola.id)?.imageThumbUrl).toBe(p.imageThumbUrl);
      const offers = (await call<{ items: OfferSummary[] }>('GET', '/offers?money=false')).body
        .items;
      expect(offers[0]!.items[0]!.imageThumbUrl).toBe(p.imageThumbUrl);
      // It is served like any picture.
      const file = await ctx.app.inject({ method: 'GET', url: p.imageThumbUrl! });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toBe('image/png');
    });

    it('a copy made from another picture is refused and its file is not kept', async () => {
      const before = fs.readdirSync(path.join(uploadDir, 'products')).length;
      const res = await upload(
        `/products/${cola.id}/image/thumb?of=${'0'.repeat(24)}.png`,
        PNG_1X1,
      );
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { details?: { code?: string } } }>().error.details?.code).toBe(
        'IMAGE_CHANGED',
      );
      expect(fs.readdirSync(path.join(uploadDir, 'products')).length).toBe(before);
      expect((await product(cola.id)).imageThumbUrl).toMatch(new RegExp(`${thumb}$`));
      // Not a picture, a missing `of`, a file past the limit, an unknown product.
      expect(
        (await upload(`/products/${cola.id}/image/thumb?of=${picture}`, Buffer.from('nope')))
          .statusCode,
      ).toBe(400);
      expect((await upload(`/products/${cola.id}/image/thumb`, PNG_1X1)).statusCode).toBe(400);
      const big = Buffer.concat([PNG_1X1, Buffer.alloc(300 * 1024)]);
      expect((await upload(`/products/${cola.id}/image/thumb?of=${picture}`, big)).statusCode).toBe(
        413,
      );
      expect(
        (
          await upload(
            `/products/00000000-0000-4000-8000-000000000000/image/thumb?of=${picture}`,
            PNG_1X1,
          )
        ).statusCode,
      ).toBe(404);
      expect(fs.readdirSync(path.join(uploadDir, 'products')).length).toBe(before);
    });

    it('a second copy replaces the first; a new picture drops the copy of the old one', async () => {
      const again = await upload(`/products/${cola.id}/image/thumb?of=${picture}`, PNG_1X1);
      expect(again.statusCode).toBe(200);
      const second = fileOf(again.json<ProductSummary>().imageThumbUrl);
      expect(second).not.toBe(thumb);
      expect(stored(thumb)).toBe(false);
      expect(stored(second)).toBe(true);

      expect((await upload(`/products/${cola.id}/image`, PNG_1X1)).statusCode).toBe(200);
      const p = await product(cola.id);
      expect(fileOf(p.imageUrl)).not.toBe(picture);
      expect(p.imageThumbUrl).toBeNull();
      expect(stored(second)).toBe(false);
      expect(stored(picture)).toBe(false);
      expect((await missing()).map((m) => m.image)).toEqual([fileOf(p.imageUrl)]);
      // A copy that arrives late, made from the old picture, is not attached to the new one.
      expect(
        (await upload(`/products/${cola.id}/image/thumb?of=${picture}`, PNG_1X1)).statusCode,
      ).toBe(409);
      expect((await product(cola.id)).imageThumbUrl).toBeNull();
    });

    it('removing the picture, or the product, removes the copy too', async () => {
      const current = fileOf((await product(cola.id)).imageUrl);
      const made = await upload(`/products/${cola.id}/image/thumb?of=${current}`, PNG_1X1);
      const copy = fileOf(made.json<ProductSummary>().imageThumbUrl);
      expect((await call('DELETE', `/products/${cola.id}/image`)).status).toBe(200);
      expect(stored(copy)).toBe(false);
      expect(stored(current)).toBe(false);
      expect(await product(cola.id)).toMatchObject({ imageUrl: null, imageThumbUrl: null });
      expect(await missing()).toEqual([]);

      // A product that was never sold is deleted for good, with both of its files.
      const fresh = (
        await call<ProductSummary>('POST', '/products', { name: 'Çips', sellingPriceCents: 120 })
      ).body;
      expect((await upload(`/products/${fresh.id}/image`, PNG_1X1)).statusCode).toBe(200);
      const pic = fileOf((await product(fresh.id)).imageUrl);
      const withCopy = await upload(`/products/${fresh.id}/image/thumb?of=${pic}`, PNG_1X1);
      const freshCopy = fileOf(withCopy.json<ProductSummary>().imageThumbUrl);
      expect(stored(pic) && stored(freshCopy)).toBe(true);
      expect((await call('DELETE', `/products/${fresh.id}`)).status).toBe(200);
      expect(stored(pic) || stored(freshCopy)).toBe(false);
    });
  });

  // ─── Sessions that wait for their money ───────────────────────────────────────

  it('the sessions that wait for their money are the same as before', async () => {
    const waiting = async () =>
      (
        await call<{ items: SessionSummary[]; total: number }>(
          'GET',
          '/sessions?awaitingPayment=true',
        )
      ).body;
    expect(await waiting()).toMatchObject({ items: [], total: 0 });

    // Open time on PC 2, stopped: the bill waits. A paid hour on PC 1, stopped: nothing waits.
    const open = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: pc2.id,
      billingMode: 'postpaid',
    });
    expect(open.status).toBe(201);
    const paid = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: pc1.id,
      billingMode: 'prepaid',
      minutes: 60,
      payments: [{ method: 'cash', amountCents: 200 }],
    });
    expect(paid.status).toBe(201);
    expect((await waiting()).total).toBe(0);
    // Half an hour later (the open session started half an hour earlier): 1.00 is owed.
    await ctx.pool.query(
      `UPDATE gaming_sessions SET started_at = started_at - interval '30 minutes' WHERE id = $1`,
      [open.body.session.id],
    );
    // "Ndalo" without taking the money: the PC is free, the bill waits at the desk.
    expect(
      (await call('POST', `/sessions/${open.body.session.id}/end`, { parkForDesk: true })).status,
    ).toBe(200);
    expect((await call('POST', `/sessions/${paid.body.session.id}/end`, {})).status).toBe(200);

    const list = await waiting();
    expect(list.total).toBe(1);
    expect(list.items.map((s) => s.id)).toEqual([open.body.session.id]);
    expect(list.items[0]).toMatchObject({ awaitingPayment: true, stationId: pc2.id });
    // The Stations list says the same thing about the two PCs.
    const stations = (await call<StationSummary[]>('GET', '/stations')).body;
    expect(stations.find((s) => s.id === pc2.id)?.awaitingPayment).toEqual({
      count: 1,
      amountCents: 100,
    });
    expect(stations.find((s) => s.id === pc1.id)?.awaitingPayment.count).toBe(0);
    // With other filters next to it.
    const onPc1 = await call<{ total: number }>(
      'GET',
      `/sessions?awaitingPayment=true&stationId=${pc1.id}`,
    );
    expect(onPc1.body.total).toBe(0);
    const onPc2 = await call<{ total: number }>(
      'GET',
      `/sessions?awaitingPayment=true&stationId=${pc2.id}&status=completed`,
    );
    expect(onPc2.body.total).toBe(1);
  });

  // ─── Backups ──────────────────────────────────────────────────────────────────

  it('a restore does not bring the heartbeats of the archive back', async () => {
    const count = async (table: string) =>
      Number(
        (await ctx.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0]!
          .n,
      );
    expect(await count('station_heartbeats')).toBeGreaterThan(0);
    const sessions = await count('gaming_sessions');
    const created = await call<BackupSummary>('POST', '/backups', {});
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('succeeded');

    const restored = await call<{ tablesRestored: number }>(
      'POST',
      `/backups/${created.body.id}/restore`,
      { confirm: true, password: 'Owner12345' },
    );
    expect(restored.status).toBe(200);
    expect(await count('station_heartbeats')).toBe(0);
    // Everything else is back as it was.
    expect(await count('gaming_sessions')).toBe(sessions);
    expect(await count('station_devices')).toBe(1);
  });
});
