import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  WS_CLOSE_CODES,
  type LoginResponse,
  type RegisterDeviceResponse,
  type RegistrationPollResponse,
  type StationDeviceSummary,
  type StationSummary,
} from '@likapcs/shared';
import { SERVER_VERSION } from '../../src/version.js';
import {
  authHeader,
  createTestContext,
  openSocket,
  runSetup,
  sleep,
  type TestContext,
} from '../helpers.js';

describe('stations, device registration and realtime presence', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let baseUrl: string;
  let wsUrl: string;
  let station1: StationSummary;
  let station2: StationSummary;
  let registrationId: string;
  let deviceToken: string;
  const machineId = 'MACHINE-0001-ABCDEF';
  const registrationSecret = randomBytes(32).toString('base64url');

  const get = <T>(url: string, token = owner.token) =>
    ctx.app
      .inject({ method: 'GET', url, headers: authHeader(token) })
      .then((r) => ({ status: r.statusCode, body: r.json<T>() }));

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    wsUrl = `ws://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('creates stations with generated codes and rejects duplicate numbers', async () => {
    const r1 = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/stations',
      headers: authHeader(owner.token),
      payload: { number: 1, name: 'Main hall 1' },
    });
    expect(r1.statusCode).toBe(201);
    station1 = r1.json<StationSummary>();
    expect(station1.code).toBe('PC 01');
    expect(station1.status).toBe('offline');
    const r2 = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/stations',
      headers: authHeader(owner.token),
      payload: { number: 2, name: 'Main hall 2', zone: 'Main hall' },
    });
    station2 = r2.json<StationSummary>();
    const dup = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/stations',
      headers: authHeader(owner.token),
      payload: { number: 1, name: 'Dup' },
    });
    expect(dup.statusCode).toBe(409);
    const list = await get<StationSummary[]>('/api/v1/stations');
    expect(list.body.map((s) => s.code)).toEqual(['PC 01', 'PC 02']);
  });

  it('updates and disables a station', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/stations/${station2.id}`,
      headers: authHeader(owner.token),
      payload: { name: 'VIP 2', isEnabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<StationSummary>()).toMatchObject({ name: 'VIP 2', status: 'disabled' });
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/stations/${station2.id}`,
      headers: authHeader(owner.token),
      payload: { isEnabled: true },
    });
  });

  it('a client registers and lands in the pending list (no token yet)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: {
        machineId,
        hostname: 'GAMING-PC-01',
        osInfo: 'Windows 11 Pro 23H2',
        appVersion: SERVER_VERSION,
        registrationSecret,
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<RegisterDeviceResponse>();
    expect(body.status).toBe('pending');
    registrationId = body.registrationId;

    const pending = await get<StationDeviceSummary[]>('/api/v1/devices?status=pending');
    expect(pending.body).toHaveLength(1);
    expect(pending.body[0]!.hostname).toBe('GAMING-PC-01');

    const poll = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/client/registration/${registrationId}?secret=${registrationSecret}`,
    });
    expect(poll.json<RegistrationPollResponse>()).toEqual({ status: 'pending' });
    const wrongSecret = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/client/registration/${registrationId}?secret=${'x'.repeat(40)}`,
    });
    expect(wrongSecret.statusCode).toBe(401);
  });

  it('an unapproved device cannot open a realtime connection', async () => {
    const ws = await openSocket(`${wsUrl}/ws/client`);
    ws.send({
      type: 'client.hello',
      token: 'not-a-real-token-at-all',
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId,
    });
    const closed = await ws.closed();
    expect(closed.code).toBe(WS_CLOSE_CODES.UNAUTHORIZED);
  });

  it('approval binds the device to a station and the token is handed out exactly once', async () => {
    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${registrationId}/approve`,
      headers: authHeader(owner.token),
      payload: { stationId: station1.id },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json<StationDeviceSummary>()).toMatchObject({
      status: 'approved',
      stationId: station1.id,
      online: false,
    });

    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${registrationId}/approve`,
      headers: authHeader(owner.token),
      payload: { stationId: station1.id },
    });
    expect(again.statusCode).toBe(409);

    const poll = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/client/registration/${registrationId}?secret=${registrationSecret}`,
    });
    const body = poll.json<RegistrationPollResponse>();
    expect(body.status).toBe('approved');
    expect(body.deviceToken).toBeTruthy();
    expect(body.station?.code).toBe('PC 01');
    deviceToken = body.deviceToken!;

    const second = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/client/registration/${registrationId}?secret=${registrationSecret}`,
    });
    expect(second.json<RegistrationPollResponse>().deviceToken).toBeUndefined();

    const stored = await ctx.pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM station_devices WHERE id = $1',
      [registrationId],
    );
    expect(stored.rows[0]!.token_hash).not.toBe(deviceToken);
  });

  it('a second machine cannot be approved for the same station', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: {
        machineId: 'MACHINE-0002-ZZZZZZ',
        hostname: 'GAMING-PC-02',
        appVersion: SERVER_VERSION,
        registrationSecret,
      },
    });
    const id = res.json<RegisterDeviceResponse>().registrationId;
    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${id}/approve`,
      headers: authHeader(owner.token),
      payload: { stationId: station1.id },
    });
    expect(approve.statusCode).toBe(409);
    const reject = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${id}/reject`,
      headers: authHeader(owner.token),
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json<StationDeviceSummary>().status).toBe('rejected');
  });

  it('the device connects, receives authoritative welcome data and the station goes online', async () => {
    const admin = await openSocket(`${wsUrl}/ws/admin`);
    admin.send({ type: 'admin.hello', token: owner.token, protocolVersion: PROTOCOL_VERSION });
    expect((await admin.next()).type).toBe('server.welcome');

    const mismatch = await openSocket(`${wsUrl}/ws/client`);
    mismatch.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId: 'SOMEONE-ELSES-MACHINE',
    });
    expect((await mismatch.closed()).code).toBe(WS_CLOSE_CODES.UNAUTHORIZED);

    const client = await openSocket(`${wsUrl}/ws/client`);
    client.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId,
    });
    const welcome = await client.next();
    expect(welcome).toMatchObject({
      type: 'server.welcome',
      station: { code: 'PC 01', number: 1 },
      heartbeatIntervalSeconds: 10,
      session: null,
      businessName: 'Test Arena',
    });
    expect(typeof welcome.serverTime).toBe('string');

    const event = await admin.next();
    expect(event).toMatchObject({
      type: 'server.event',
      event: 'station.changed',
      payload: { id: station1.id, status: 'available' },
    });

    const station = await get<StationSummary>(`/api/v1/stations/${station1.id}`);
    expect(station.body.status).toBe('available');
    expect(station.body.device?.online).toBe(true);

    client.send({
      type: 'client.heartbeat',
      ts: new Date().toISOString(),
      locked: true,
      metrics: { cpuPercent: 12, memoryUsedMb: 2048 },
    });
    expect((await client.next()).type).toBe('server.heartbeat_ack');
    await sleep(50);
    const heartbeats = await ctx.pool.query<{ locked: boolean }>(
      'SELECT locked FROM station_heartbeats WHERE device_id = $1 ORDER BY id DESC LIMIT 1',
      [registrationId],
    );
    expect(heartbeats.rows[0]!.locked).toBe(true);

    // Server → device command round-trip with acknowledgement (used by session control in Phase 3/4)
    const commandPromise = ctx.app.hub.sendCommand(registrationId, 'message.show', {
      text: 'Hello PC 01',
    });
    const command = await client.next();
    expect(command).toMatchObject({ type: 'server.command', command: 'message.show', seq: 1 });
    client.send({ type: 'client.ack', commandId: command.commandId, ok: true });
    const result = await commandPromise;
    expect(result.ok).toBe(true);
    client.send({ type: 'client.ack', commandId: command.commandId, ok: true }); // duplicate ack is ignored

    // Disconnect → station offline, admins notified
    client.socket.close();
    const offlineEvent = await admin.next();
    expect(offlineEvent).toMatchObject({
      event: 'station.changed',
      payload: { id: station1.id, status: 'offline' },
    });
    await sleep(50);
    const logs = await get<{ event: string }[]>(`/api/v1/stations/${station1.id}/connection-logs`);
    expect(logs.body.map((l) => l.event)).toEqual(
      expect.arrayContaining(['connected', 'disconnected']),
    );
    admin.socket.close();
  });

  it('a newer connection from the same device replaces the stale one', async () => {
    const first = await openSocket(`${wsUrl}/ws/client`);
    first.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId,
    });
    await first.next();
    const second = await openSocket(`${wsUrl}/ws/client`);
    second.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId,
    });
    await second.next();
    expect((await first.closed()).code).toBe(WS_CLOSE_CODES.REPLACED_BY_NEW_CONNECTION);
    expect(ctx.app.hub.isDeviceOnline(registrationId)).toBe(true);
    second.socket.close();
    await sleep(50);
  });

  it('rejects incompatible protocol or application versions', async () => {
    const ws = await openSocket(`${wsUrl}/ws/client`);
    ws.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: '99.0.0',
      protocolVersion: PROTOCOL_VERSION,
      machineId,
    });
    expect((await ws.closed()).code).toBe(WS_CLOSE_CODES.INCOMPATIBLE_VERSION);
    const ws2 = await openSocket(`${wsUrl}/ws/client`);
    ws2.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: SERVER_VERSION,
      protocolVersion: 42,
      machineId,
    });
    expect((await ws2.closed()).code).toBe(WS_CLOSE_CODES.INCOMPATIBLE_VERSION);
    const ws3 = await openSocket(`${wsUrl}/ws/client`);
    ws3.send({ type: 'client.heartbeat', ts: new Date().toISOString() });
    expect((await ws3.closed()).code).toBe(WS_CLOSE_CODES.PROTOCOL_ERROR);
  });

  it('revoking a device closes its connection and invalidates the token', async () => {
    const client = await openSocket(`${wsUrl}/ws/client`);
    client.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId,
    });
    await client.next();
    const revoke = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${registrationId}/revoke`,
      headers: authHeader(owner.token),
    });
    expect(revoke.statusCode).toBe(200);
    expect((await client.closed()).code).toBe(WS_CLOSE_CODES.DEVICE_REVOKED);
    const retry = await openSocket(`${wsUrl}/ws/client`);
    retry.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId,
    });
    expect((await retry.closed()).code).toBe(WS_CLOSE_CODES.UNAUTHORIZED);
    const station = await get<StationSummary>(`/api/v1/stations/${station1.id}`);
    expect(station.body.device).toBeNull();
    expect(station.body.status).toBe('offline');
  });

  it('a revoked machine can register again and be approved on a different station', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: {
        machineId,
        hostname: 'GAMING-PC-01',
        appVersion: SERVER_VERSION,
        registrationSecret,
      },
    });
    expect(res.statusCode).toBe(202);
    const id = res.json<RegisterDeviceResponse>().registrationId;
    expect(id).not.toBe(registrationId);
    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${id}/approve`,
      headers: authHeader(owner.token),
      payload: { stationId: station2.id },
    });
    expect(approve.statusCode).toBe(200);
  });

  it('stations with an approved device cannot be deleted; empty ones can', async () => {
    const blocked = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/stations/${station2.id}`,
      headers: authHeader(owner.token),
    });
    expect(blocked.statusCode).toBe(409);
    const ok = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/stations/${station1.id}`,
      headers: authHeader(owner.token),
    });
    expect(ok.statusCode).toBe(204);
  });

  it('station management requires the right permission', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: authHeader(owner.token),
      payload: {
        username: 'cash2',
        fullName: 'C',
        password: 'Cashier123',
        roles: ['cashier'],
        mustChangePassword: false,
      },
    });
    const cashier = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'cash2', password: 'Cashier123' },
      })
    ).json<LoginResponse>();
    expect((await get<unknown>('/api/v1/stations', cashier.token)).status).toBe(200);
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/stations',
      headers: authHeader(cashier.token),
      payload: { number: 7, name: 'x' },
    });
    expect(create.statusCode).toBe(403);
    void baseUrl;
  });
});
