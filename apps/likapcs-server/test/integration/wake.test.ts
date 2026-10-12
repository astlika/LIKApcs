import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  type LoginResponse,
  type RegisterDeviceResponse,
  type RegistrationPollResponse,
  type StationSummary,
  type StationWakeAllResponse,
  type StationWakeResponse,
} from '@likapcs/shared';
import { SERVER_VERSION } from '../../src/version.js';
import { broadcastOf, wakeTargets, type WakeSender } from '../../src/services/wake.js';
import {
  authHeader,
  createTestContext,
  openSocket,
  runSetup,
  sleep,
  type TestContext,
} from '../helpers.js';

/** Records what would have gone out on the wire instead of opening a UDP socket. */
class RecordingSender implements WakeSender {
  calls: { mac: string; targets: string[] }[] = [];
  async send(mac: string, targets: string[]): Promise<void> {
    this.calls.push({ mac, targets });
  }
}

describe('Wake-on-LAN', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let wsUrl: string;
  let pc1: StationSummary;
  let pc2: StationSummary;
  let pc3: StationSummary;
  const sender = new RecordingSender();
  const registrationSecret = randomBytes(32).toString('base64url');

  const post = <T>(url: string, payload?: Record<string, unknown>) =>
    ctx.app
      .inject({ method: 'POST', url, headers: authHeader(owner.token), payload })
      .then((r) => ({ status: r.statusCode, body: r.json<T>() }));

  /** Registers + approves a device for a station and returns its token. */
  async function pairDevice(stationId: string, machineId: string): Promise<string> {
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: {
        machineId,
        hostname: `PC-${machineId}`,
        appVersion: SERVER_VERSION,
        registrationSecret,
      },
    });
    const { registrationId } = reg.json<RegisterDeviceResponse>();
    const approve = await post(`/api/v1/devices/${registrationId}/approve`, { stationId });
    expect(approve.status).toBe(200);
    const poll = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/client/registration/${registrationId}?secret=${registrationSecret}`,
    });
    return poll.json<RegistrationPollResponse>().deviceToken!;
  }

  /** Connects a client with the given hardware, waits for the welcome, then disconnects. */
  async function connectOnce(token: string, machineId: string, hardware: unknown) {
    const client = await openSocket(`${wsUrl}/ws/client`);
    client.send({
      type: 'client.hello',
      token,
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId,
      hardware,
    });
    expect((await client.next()).type).toBe('server.welcome');
    return client;
  }

  beforeAll(async () => {
    ctx = await createTestContext({}, { wakeSender: sender });
    owner = await runSetup(ctx.app);
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    wsUrl = `ws://127.0.0.1:${port}`;
    pc1 = (await post<StationSummary>('/api/v1/stations', { number: 1, name: 'PC 1' })).body;
    pc2 = (await post<StationSummary>('/api/v1/stations', { number: 2, name: 'PC 2' })).body;
    pc3 = (await post<StationSummary>('/api/v1/stations', { number: 3, name: 'PC 3' })).body;
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('computes directed broadcasts and always includes the limited broadcast + last IP', () => {
    expect(broadcastOf('192.168.1.21', '255.255.255.0')).toBe('192.168.1.255');
    expect(broadcastOf('10.4.7.9', '255.255.0.0')).toBe('10.4.255.255');
    expect(broadcastOf('bad', '255.255.255.0')).toBeNull();
    const targets = wakeTargets('192.168.1.50', {
      eth0: [
        {
          address: '192.168.1.2',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '192.168.1.2/24',
        },
      ],
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
      ],
    });
    expect(targets).toEqual(['255.255.255.255', '192.168.1.255', '192.168.1.50']);
    // garbage last IPs (IPv6, hostnames) are left out rather than sent to
    expect(wakeTargets('::1', {})).toEqual(['255.255.255.255']);
  });

  it('refuses while the PC is online, wakes it once it is offline (MAC normalised, last IP targeted)', async () => {
    const token = await pairDevice(pc1.id, 'MACHINE-WOL-0001');
    const client = await connectOnce(token, 'MACHINE-WOL-0001', {
      cpu: 'Intel Core i5-12400F',
      gpus: [],
      network: [
        // Wi-Fi first on purpose: the wired adapter that carried the connection must win
        {
          name: 'Wi-Fi',
          description: 'Intel Wi-Fi 6 AX200',
          mac: '3c-f0-11-aa-bb-cc',
          up: true,
          wakeOnMagicPacket: true,
        },
        {
          name: 'Ethernet',
          description: 'Realtek PCIe GbE',
          mac: '08-bf-b8-12-34-56',
          ipv4: '127.0.0.1',
          up: true,
          wakeOnMagicPacket: true,
        },
      ],
      fastStartup: false,
    });

    const online = await post<{ error: { details: { code: string } } }>(
      `/api/v1/stations/${pc1.id}/wake`,
    );
    expect(online.status).toBe(409);
    expect(online.body.error.details.code).toBe('STATION_ONLINE');
    expect(sender.calls).toHaveLength(0);

    client.socket.close();
    await sleep(100);
    const woke = await post<StationWakeResponse>(`/api/v1/stations/${pc1.id}/wake`);
    expect(woke.status).toBe(200);
    expect(woke.body).toMatchObject({ code: 'PC 01', mac: '08:BF:B8:12:34:56', warnings: [] });
    expect(woke.body.targets).toContain('255.255.255.255');
    // the device connected from 127.0.0.1 → the last IP is a unicast target too
    expect(woke.body.targets).toContain('127.0.0.1');
    expect(sender.calls).toEqual([{ mac: '08:BF:B8:12:34:56', targets: woke.body.targets }]);

    const audit = await ctx.pool.query<{ action: string; details: { mac: string } }>(
      "SELECT action, details FROM audit_logs WHERE action = 'station.wake' ORDER BY id DESC LIMIT 1",
    );
    expect(audit.rows[0]?.details.mac).toBe('08:BF:B8:12:34:56');
  });

  it('reports readiness problems as warnings but still sends', async () => {
    const token = await pairDevice(pc2.id, 'MACHINE-WOL-0002');
    const client = await connectOnce(token, 'MACHINE-WOL-0002', {
      gpus: [],
      network: [{ name: 'Ethernet', mac: 'AA:BB:CC:DD:EE:01', up: true, wakeOnMagicPacket: false }],
      fastStartup: true,
    });
    client.socket.close();
    await sleep(100);
    sender.calls = [];
    const woke = await post<StationWakeResponse>(`/api/v1/stations/${pc2.id}/wake`);
    expect(woke.status).toBe(200);
    expect(woke.body.warnings).toEqual(['wol_off', 'fast_startup']);
    expect(sender.calls).toHaveLength(1);
  });

  it('cannot wake a PC that never reported a MAC (older client) or has no device', async () => {
    const token = await pairDevice(pc3.id, 'MACHINE-WOL-0003');
    const client = await connectOnce(token, 'MACHINE-WOL-0003', { gpus: [], cpu: 'old client' });
    client.socket.close();
    await sleep(100);
    const noMac = await post<{ error: { details: { code: string } } }>(
      `/api/v1/stations/${pc3.id}/wake`,
    );
    expect(noMac.status).toBe(409);
    expect(noMac.body.error.details.code).toBe('NO_MAC');

    const pc4 = (await post<StationSummary>('/api/v1/stations', { number: 4, name: 'PC 4' })).body;
    const noDevice = await post<{ error: { details: { code: string } } }>(
      `/api/v1/stations/${pc4.id}/wake`,
    );
    expect(noDevice.status).toBe(409);
    expect(noDevice.body.error.details.code).toBe('NO_MAC');
  });

  it('wake-all sends to every offline PC with a MAC and lists the skipped ones with a reason', async () => {
    sender.calls = [];
    const all = await post<StationWakeAllResponse>('/api/v1/stations/wake-all');
    expect(all.status).toBe(200);
    expect(all.body.sent.map((s) => s.code).sort()).toEqual(['PC 01', 'PC 02']);
    expect(all.body.skipped).toEqual(
      expect.arrayContaining([
        { stationId: pc3.id, code: 'PC 03', reason: 'no_mac' },
        expect.objectContaining({ code: 'PC 04', reason: 'no_device' }),
      ]),
    );
    expect(sender.calls.map((c) => c.mac).sort()).toEqual([
      '08:BF:B8:12:34:56',
      'AA:BB:CC:DD:EE:01',
    ]);
  });

  it('needs the stations.power permission', async () => {
    const cashier = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: authHeader(owner.token),
      payload: {
        username: 'kasa',
        password: 'Cashier123',
        fullName: 'Kasa',
        roles: ['cashier'],
        mustChangePassword: false,
      },
    });
    expect(cashier.statusCode).toBe(201);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'kasa', password: 'Cashier123' },
    });
    const token = login.json<LoginResponse>().token;
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/stations/${pc1.id}/wake`,
      headers: authHeader(token),
    });
    expect(denied.statusCode).toBe(403);
  });
});
