import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  type LoginResponse,
  type RegisterDeviceResponse,
  type RegistrationPollResponse,
  type StationSummary,
} from '@likapcs/shared';
import { SERVER_VERSION } from '../../src/version.js';
import {
  authHeader,
  createTestContext,
  openSocket,
  runSetup,
  type TestContext,
} from '../helpers.js';

/**
 * 0.17.1: the PC reports whether its countdown widget is really visible; the desk reads the
 * answer (and the cause) on the station. The report lives on the hub per device, survives a
 * reconnect and disappears with the device (revoke).
 */
describe('widget visibility reports', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let station: StationSummary;
  let wsUrl = '';
  let deviceToken = '';
  let deviceId = '';

  const call = <T>(method: 'GET' | 'POST', url: string, payload?: unknown) =>
    ctx.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: authHeader(owner.token),
        payload: payload === undefined ? undefined : (payload as Record<string, unknown>),
      })
      .then((r) => ({ status: r.statusCode, body: r.body ? (r.json<T>() as T) : (null as T) }));

  const stationNow = async () => {
    const list = await call<StationSummary[]>('GET', '/stations');
    return list.body.find((s) => s.id === station.id)!;
  };

  const connect = async () => {
    const socket = await openSocket(`${wsUrl}/ws/client`);
    socket.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId: 'MACHINE-WIDGET-1',
    });
    expect((await socket.next()).type).toBe('server.welcome');
    return socket;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    wsUrl = `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    station = (await call<StationSummary>('POST', '/stations', { number: 1, name: 'PC 1' })).body;

    const registrationSecret = randomBytes(32).toString('base64url');
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: {
        machineId: 'MACHINE-WIDGET-1',
        hostname: 'pc1',
        appVersion: SERVER_VERSION,
        registrationSecret,
      },
    });
    const { registrationId } = reg.json<RegisterDeviceResponse>();
    expect(
      (await call('POST', `/devices/${registrationId}/approve`, { stationId: station.id })).status,
    ).toBe(200);
    const poll = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/client/registration/${registrationId}?secret=${registrationSecret}`,
    });
    deviceToken = poll.json<RegistrationPollResponse>().deviceToken!;
    deviceId = (await stationNow()).device!.id;
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('carries the report to the station, keeps it across reconnects, clears it on revoke', async () => {
    expect((await stationNow()).device?.widget).toBeNull();

    const socket = await connect();
    socket.send({
      type: 'client.event',
      event: 'widget_report',
      payload: { ok: false, detail: 'fullscreen-app:cs2.exe', at: new Date().toISOString() },
    });
    // The hub stores it and broadcasts; the station summary must carry it.
    let seen: StationSummary | null = null;
    for (let i = 0; i < 20 && !seen; i++) {
      const s = await stationNow();
      if (s.device?.widget) seen = s;
      else await new Promise((r) => setTimeout(r, 100));
    }
    expect(seen?.device?.widget).toMatchObject({ ok: false, detail: 'fullscreen-app:cs2.exe' });

    // A reconnect keeps the last report (the desk must not flip back to "no news").
    socket.socket.close();
    const again = await connect();
    expect((await stationNow()).device?.widget?.ok).toBe(false);

    // A healthy report replaces the bad one.
    again.send({
      type: 'client.event',
      event: 'widget_report',
      payload: { ok: true, detail: 'visible', at: new Date().toISOString() },
    });
    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) {
      ok = (await stationNow()).device?.widget?.ok === true;
      if (!ok) await new Promise((r) => setTimeout(r, 100));
    }
    expect(ok).toBe(true);

    // Garbage is refused (the summary keeps the last good report).
    again.send({ type: 'client.event', event: 'widget_report', payload: { ok: 'yes' } });
    await new Promise((r) => setTimeout(r, 300));
    expect((await stationNow()).device?.widget).toMatchObject({ ok: true });

    // Revoking the PC drops the report with the device.
    again.socket.close();
    expect((await call('POST', `/devices/${deviceId}/revoke`, {})).status).toBe(200);
    expect((await stationNow()).device).toBeNull();
  }, 30_000);

  it('audits a hidden widget as a warning', async () => {
    const rows = await ctx.pool.query<{ action: string; details: { detail?: string } }>(
      `SELECT action, details FROM audit_logs WHERE action = 'station.widget_hidden' ORDER BY id`,
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.details.detail).toBe('fullscreen-app:cs2.exe');
  });
});
