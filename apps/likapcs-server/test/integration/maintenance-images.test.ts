import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  PROTOCOL_VERSION,
  type LoginResponse,
  type ProductSummary,
  type RegisterDeviceResponse,
  type RegistrationPollResponse,
  type StaffUnlockResponse,
  type StationSummary,
} from '@likapcs/shared';
import { SERVER_VERSION } from '../../src/version.js';
import { ProductImageStore, detectImageKind } from '../../src/services/product-images.js';
import {
  authHeader,
  createTestContext,
  login,
  openSocket,
  runSetup,
  type TestContext,
} from '../helpers.js';

/** Smallest valid PNG (1×1, transparent). */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('staff unlock (maintenance) and product pictures', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let wsUrl: string;
  let station: StationSummary;
  let deviceToken: string;
  let client: Awaited<ReturnType<typeof openSocket>>;
  let uploadDir: string;
  const machineId = 'MACHINE-MAINT-0001';

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

  /** Reads the next server.command on the device socket and acks it like the real client. */
  const expectCommand = async (command: string) => {
    const msg = await client.next(5_000);
    expect(msg.type).toBe('server.command');
    expect(msg.command).toBe(command);
    client.send({ type: 'client.ack', commandId: msg.commandId, ok: true });
    return msg;
  };

  beforeAll(async () => {
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'likapcs-uploads-'));
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
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    wsUrl = `ws://127.0.0.1:${port}`;

    station = (
      await call<StationSummary>(owner.token, 'POST', '/stations', { number: 7, name: 'VIP 7' })
    ).body;
    const registrationSecret = randomBytes(32).toString('base64url');
    const reg = await call<RegisterDeviceResponse>(null, 'POST', '/client/register', {
      machineId,
      hostname: 'VIP-PC-07',
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

    client = await openSocket(`${wsUrl}/ws/client`);
    client.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId,
    });
    const welcome = await client.next();
    expect(welcome.type).toBe('server.welcome');
    expect(welcome.maintenance).toBeNull();
  });

  afterAll(async () => {
    client?.socket.close();
    await ctx.close();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  it('rejects wrong credentials, missing device token and accounts without the permission', async () => {
    const noDevice = await call(null, 'POST', '/client/staff-unlock', {
      username: 'owner',
      password: 'x',
    });
    expect(noDevice.status).toBe(401);

    const wrong = await call(deviceToken, 'POST', '/client/staff-unlock', {
      username: 'owner',
      password: 'definitely-wrong',
    });
    expect(wrong.status).toBe(401);

    const cashierTry = await call(deviceToken, 'POST', '/client/staff-unlock', {
      username: 'kasa',
      password: 'Cashier123',
    });
    expect(cashierTry.status).toBe(403);
    expect(cashier.user.permissions).not.toContain('stations.unlock');

    const stations = await call<StationSummary[]>(owner.token, 'GET', '/stations');
    expect(stations.body.find((s) => s.id === station.id)?.status).toBe('available');
  });

  it('unlocks the PC for maintenance with staff credentials, survives a reconnect and locks on request', async () => {
    const res = call<StaffUnlockResponse>(deviceToken, 'POST', '/client/staff-unlock', {
      username: 'owner',
      password: 'Owner12345',
      minutes: 20,
    });
    const cmd = await expectCommand('unlock');
    expect(cmd.payload).toMatchObject({ reason: 'maintenance', byName: 'Shop Owner' });
    const unlocked = await res;
    expect(unlocked.status).toBe(200);
    expect(unlocked.body.minutes).toBe(20);
    expect(new Date(unlocked.body.until).getTime()).toBeGreaterThan(Date.now() + 19 * 60_000);

    let s = (await call<StationSummary[]>(owner.token, 'GET', '/stations')).body.find(
      (x) => x.id === station.id,
    )!;
    expect(s.status).toBe('maintenance');
    expect(s.maintenance).toMatchObject({ byName: 'Shop Owner' });

    // Reconnect: the welcome carries the live grant, so the PC stays unlocked.
    client.socket.close();
    client = await openSocket(`${wsUrl}/ws/client`);
    client.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId,
    });
    const welcome = await client.next();
    expect(welcome.type).toBe('server.welcome');
    expect(welcome.maintenance).toMatchObject({ byName: 'Shop Owner' });

    // Staff press "Lock" on the PC.
    const locked = await call<StationSummary>(deviceToken, 'POST', '/client/staff-lock', {});
    expect(locked.status).toBe(200);
    expect(locked.body.maintenance).toBeNull();
    s = (await call<StationSummary[]>(owner.token, 'GET', '/stations')).body.find(
      (x) => x.id === station.id,
    )!;
    expect(s.status).toBe('available');

    const audit = await call<{ items: { action: string }[] }>(
      owner.token,
      'GET',
      '/audit-logs?action=station.maintenance',
    );
    expect(audit.body.items.map((a) => a.action)).toEqual(
      expect.arrayContaining(['station.maintenance_unlock', 'station.maintenance_lock']),
    );
  });

  it('an Admin unlock is a grant too, an Admin lock ends it, and expired grants lock the PC', async () => {
    const adminUnlock = call(owner.token, 'POST', `/stations/${station.id}/command`, {
      command: 'unlock',
    });
    const cmd = await expectCommand('unlock');
    expect(cmd.payload).toMatchObject({ reason: 'maintenance', byName: 'owner' });
    expect((await adminUnlock).status).toBe(200);
    let s = (await call<StationSummary[]>(owner.token, 'GET', '/stations')).body.find(
      (x) => x.id === station.id,
    )!;
    expect(s.status).toBe('maintenance');

    const adminLock = call(owner.token, 'POST', `/stations/${station.id}/command`, {
      command: 'lock',
    });
    await expectCommand('lock');
    expect((await adminLock).status).toBe(200);
    s = (await call<StationSummary[]>(owner.token, 'GET', '/stations')).body.find(
      (x) => x.id === station.id,
    )!;
    expect(s.status).toBe('available');

    // Expiry: grant in the past → the sweep locks the PC and clears the grant.
    await ctx.pool.query(
      `UPDATE stations SET maintenance_until = now() - interval '1 second', maintenance_by_name = 'x' WHERE id = $1`,
      [station.id],
    );
    const sweep = ctx.app.services.maintenance.sweep();
    await expectCommand('lock');
    await sweep;
    s = (await call<StationSummary[]>(owner.token, 'GET', '/stations')).body.find(
      (x) => x.id === station.id,
    )!;
    expect(s.status).toBe('available');
    expect(s.maintenance).toBeNull();
  });

  it('refuses a staff unlock while a customer session is running', async () => {
    await call(owner.token, 'PATCH', '/settings', { 'stations.maintenance_minutes': 5 });
    const start = call(owner.token, 'POST', '/sessions', {
      stationId: station.id,
      billingMode: 'postpaid',
    });
    await expectCommand('session.start');
    expect((await start).status).toBe(201);

    const refused = await call(deviceToken, 'POST', '/client/staff-unlock', {
      username: 'owner',
      password: 'Owner12345',
    });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: { code: string } }).error.code).toBe('session_active');
  });

  // ─── Product pictures ───────────────────────────────────────────────────────

  it('stores an uploaded picture, serves it publicly with long caching, replaces and removes it', async () => {
    const product = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Red Bull 250ml',
        sellingPriceCents: 250,
        unitCode: 'pc',
        trackStock: false,
      })
    ).body;
    expect(product.imageUrl).toBeNull();

    const bad = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/products/${product.id}/image`,
      headers: { ...authHeader(owner.token), 'content-type': 'image/png' },
      payload: Buffer.from('this is not a picture'),
    });
    expect(bad.statusCode).toBe(400);

    const up = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/products/${product.id}/image`,
      headers: { ...authHeader(owner.token), 'content-type': 'image/png' },
      payload: PNG_1X1,
    });
    expect(up.statusCode).toBe(200);
    const withImage = up.json<ProductSummary>();
    expect(withImage.imageUrl).toMatch(/^\/api\/v1\/files\/products\/[a-z0-9]{24}\.png$/);
    const firstFile = withImage.imageUrl!.split('/').pop()!;
    expect(fs.existsSync(path.join(uploadDir, 'products', firstFile))).toBe(true);

    // Public read (no Authorization header) — the POS shows it in <img> tags.
    const served = await ctx.app.inject({ method: 'GET', url: withImage.imageUrl! });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['cache-control']).toContain('immutable');
    expect(served.rawPayload.equals(PNG_1X1)).toBe(true);

    // Nothing but our own file names can be addressed.
    for (const name of ['..%2F..%2Fconfig.json', 'config.json', `${'a'.repeat(24)}.exe`]) {
      const r = await ctx.app.inject({ method: 'GET', url: `/api/v1/files/products/${name}` });
      expect([400, 404]).toContain(r.statusCode);
    }

    // Cashiers can see pictures but not change them.
    const forbidden = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/products/${product.id}/image`,
      headers: { ...authHeader(cashier.token), 'content-type': 'image/png' },
      payload: PNG_1X1,
    });
    expect(forbidden.statusCode).toBe(403);

    // Replacing removes the previous file.
    const again = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/products/${product.id}/image`,
      headers: { ...authHeader(owner.token), 'content-type': 'image/png' },
      payload: PNG_1X1,
    });
    const secondFile = again.json<ProductSummary>().imageUrl!.split('/').pop()!;
    expect(secondFile).not.toBe(firstFile);
    expect(fs.existsSync(path.join(uploadDir, 'products', firstFile))).toBe(false);

    const listed = await call<{ items: ProductSummary[] }>(owner.token, 'GET', '/products');
    expect(listed.body.items.find((p) => p.id === product.id)?.imageUrl).toContain(secondFile);

    const cleared = await call<ProductSummary>(
      owner.token,
      'DELETE',
      `/products/${product.id}/image`,
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.imageUrl).toBeNull();
    expect(fs.existsSync(path.join(uploadDir, 'products', secondFile))).toBe(false);
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/api/v1/files/products/${secondFile}` }))
        .statusCode,
    ).toBe(404);

    // Deleting a never-sold product removes its picture file with it.
    const third = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/products/${product.id}/image`,
      headers: { ...authHeader(owner.token), 'content-type': 'image/png' },
      payload: PNG_1X1,
    });
    const thirdFile = third.json<ProductSummary>().imageUrl!.split('/').pop()!;
    expect(fs.existsSync(path.join(uploadDir, 'products', thirdFile))).toBe(true);
    const deleted = await call<{ archived: boolean }>(
      owner.token,
      'DELETE',
      `/products/${product.id}`,
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body.archived).toBe(false);
    expect(fs.existsSync(path.join(uploadDir, 'products', thirdFile))).toBe(false);
  });

  it('downloads a picture from a link (and refuses non-images and local addresses)', async () => {
    // The store itself, with loopback allowed so a local test server can stand in for the internet.
    const dir = path.join(uploadDir, 'from-url');
    const store = new ProductImageStore(dir, { allowLocalHosts: true });
    const server = http.createServer((req, res) => {
      if (req.url === '/pic.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG_1X1);
      } else if (req.url === '/page.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html>not a picture</html>');
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const name = await store.saveFromUrl(`http://127.0.0.1:${port}/pic.png`);
      expect(name).toMatch(/\.png$/);
      expect(fs.readFileSync(path.join(dir, name)).equals(PNG_1X1)).toBe(true);
      await expect(store.saveFromUrl(`http://127.0.0.1:${port}/page.html`)).rejects.toThrow(
        /JPEG, PNG/,
      );
      await expect(store.saveFromUrl(`http://127.0.0.1:${port}/missing.png`)).rejects.toThrow(
        /HTTP 404/,
      );
      await expect(store.saveFromUrl('ftp://example.com/a.png')).rejects.toThrow(/http\(s\)/);
      // The production store refuses this machine's own addresses.
      const strict = new ProductImageStore(dir);
      await expect(strict.saveFromUrl(`http://127.0.0.1:${port}/pic.png`)).rejects.toThrow(
        /not allowed/,
      );
      await expect(strict.saveFromUrl('http://localhost/pic.png')).rejects.toThrow(/not allowed/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // Through the API the endpoint validates the link shape before contacting anything.
    const product = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Coca-Cola 330ml',
        sellingPriceCents: 150,
        unitCode: 'pc',
        trackStock: false,
      })
    ).body;
    const invalid = await call(owner.token, 'POST', `/products/${product.id}/image/from-url`, {
      url: 'nope',
    });
    expect(invalid.status).toBe(400);
  });

  it('sniffs image formats from magic bytes', () => {
    expect(detectImageKind(PNG_1X1)).toBe('png');
    expect(detectImageKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('jpg');
    expect(detectImageKind(Buffer.from('GIF89a......'))).toBe('gif');
    expect(detectImageKind(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(detectImageKind(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });
});
