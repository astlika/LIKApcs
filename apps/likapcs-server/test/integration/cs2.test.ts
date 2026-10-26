import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  type LoginResponse,
  type RegisterDeviceResponse,
  type RegistrationPollResponse,
  type StationSummary,
} from '@likapcs/shared';
import { SERVER_VERSION } from '../../src/version.js';
import { decodeRconPackets, encodeRconPacket, RCON_TYPE } from '../../src/services/cs2-rcon.js';
import {
  authHeader,
  createTestContext,
  openSocket,
  runSetup,
  sleep,
  type TestContext,
} from '../helpers.js';

/**
 * CS2 match server (0.24.0): configuration without secrets in the answer, the commands that
 * reach the server PC and the joining PCs, and the RCON match commands against a stand-in CS2
 * server that checks the password like the real one does.
 */
describe('CS2 match server', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let station: StationSummary;
  let client: Awaited<ReturnType<typeof openSocket>>;
  let heartbeat: NodeJS.Timeout | null = null;
  const received: { command: string; payload: Record<string, unknown> }[] = [];
  let rconServer: net.Server;
  let rconPort = 0;
  let rconPasswordExpected = '';
  const rconCommands: string[] = [];

  type Err = { error?: { code: string; message: string } };
  const call = <T>(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: unknown,
    token: string | null = owner.token,
  ) =>
    ctx.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: token ? authHeader(token) : {},
        payload: payload === undefined ? undefined : (payload as Record<string, unknown>),
      })
      .then((r) => ({ status: r.statusCode, body: r.body ? (r.json<T>() as T) : (null as T) }));

  /** Waits until the fake PC has received a command of this name. */
  const waitFor = async (command: string, ms = 4000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = received.find((r) => r.command === command);
      if (hit) return hit;
      await sleep(40);
    }
    throw new Error(`no ${command} command; got: ${received.map((r) => r.command).join(', ')}`);
  };

  /** A stand-in CS2 server: Source RCON with one password, answers every command with "ok". */
  function startRconServer(): Promise<void> {
    return new Promise((resolve) => {
      rconServer = net.createServer((socket) => {
        let buf: Buffer = Buffer.alloc(0);
        let authed = false;
        socket.on('data', (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          const { packets, rest } = decodeRconPackets(buf);
          buf = Buffer.from(rest);
          for (const p of packets) {
            if (!authed && p.type === RCON_TYPE.AUTH) {
              socket.write(encodeRconPacket(p.id, RCON_TYPE.RESPONSE, ''));
              authed = p.body === rconPasswordExpected;
              socket.write(encodeRconPacket(authed ? p.id : -1, RCON_TYPE.AUTH_RESPONSE, ''));
            } else if (authed && p.type === RCON_TYPE.EXEC) {
              rconCommands.push(p.body);
              socket.write(encodeRconPacket(p.id, RCON_TYPE.RESPONSE, `ok: ${p.body}`));
            } else if (authed && p.type === RCON_TYPE.RESPONSE) {
              socket.write(encodeRconPacket(p.id, RCON_TYPE.RESPONSE, ''));
            }
          }
        });
      });
      rconServer.listen(0, '127.0.0.1', () => {
        rconPort = (rconServer.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  /** The fake server PC: acks every command and records it. */
  function attach(socket: Awaited<ReturnType<typeof openSocket>>) {
    client = socket;
    socket.socket.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as {
        type: string;
        command?: string;
        commandId?: string;
        payload?: Record<string, unknown>;
      };
      if (msg.type === 'server.command' && msg.commandId) {
        received.push({ command: msg.command ?? '', payload: msg.payload ?? {} });
        socket.send({ type: 'client.ack', commandId: msg.commandId, ok: true });
      }
    });
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (socket.socket.readyState === socket.socket.OPEN)
        socket.send({ type: 'client.heartbeat', ts: new Date().toISOString(), locked: true });
    }, 2_000);
  }

  const rconSecret = async () => {
    const r = await ctx.pool.query<{ config: { rconPassword: string } }>(
      'SELECT config FROM cs2_config WHERE id = 1',
    );
    return r.rows[0]!.config.rconPassword;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const wsUrl = `ws://127.0.0.1:${port}`;
    station = (await call<StationSummary>('POST', '/stations', { number: 1, name: 'PC 1' })).body;
    await startRconServer();

    const registrationSecret = randomBytes(32).toString('base64url');
    const reg = await call<RegisterDeviceResponse>(
      'POST',
      '/client/register',
      {
        machineId: 'MACHINE-CS2-1',
        hostname: 'pc1',
        osInfo: 'Windows 11',
        appVersion: SERVER_VERSION,
        registrationSecret,
      },
      null,
    );
    await call('POST', `/devices/${reg.body.registrationId}/approve`, { stationId: station.id });
    const poll = await call<RegistrationPollResponse>(
      'GET',
      `/client/registration/${reg.body.registrationId}?secret=${registrationSecret}`,
      null,
    );
    const deviceToken = poll.body.deviceToken!;
    const socket = await openSocket(`${wsUrl}/ws/client`);
    socket.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId: 'MACHINE-CS2-1',
    });
    expect((await socket.next()).type).toBe('server.welcome');
    attach(socket);
  }, 30_000);

  afterAll(async () => {
    if (heartbeat) clearInterval(heartbeat);
    client?.socket.close();
    await new Promise<void>((r) => (rconServer ? rconServer.close(() => r()) : r()));
    await ctx.app.close();
  });

  it('shows the config without any password', async () => {
    const res = await call<Record<string, unknown>>('GET', '/cs2');
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('rconPassword"');
    expect(text).not.toContain('playerPassword"');
    expect(res.body).toMatchObject({ config: { port: 27015, map: 'de_dust2', maxPlayers: 10 } });
  });

  it('refuses a password typed in the request and a bad map name', async () => {
    expect((await call<Err>('PATCH', '/cs2', { rconPassword: 'typed' })).status).toBe(400);
    expect((await call<Err>('PATCH', '/cs2', { map: 'de dust 2' })).status).toBe(400);
  });

  it('saves the server PC and generates the RCON password on the server side', async () => {
    const res = await call<{
      config: { rconPasswordSet: boolean };
      serverStation: { online: boolean };
    }>('PATCH', '/cs2', {
      serverStationId: station.id,
      serverAddress: '127.0.0.1',
      port: rconPort,
      map: 'de_nuke',
    });
    expect(res.status).toBe(200);
    expect(res.body.config.rconPasswordSet).toBe(true);
    expect(res.body.serverStation).toMatchObject({ id: station.id, online: true });
    rconPasswordExpected = await rconSecret();
    expect(rconPasswordExpected.length).toBeGreaterThanOrEqual(16);
  });

  it('starts the server PC with arguments built from the config', async () => {
    const res = await call<{ ok: boolean }>('POST', '/cs2/server/start');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const cmd = await waitFor('cs2.start');
    const args = cmd.payload.args as string[];
    expect(args).toContain('-dedicated');
    expect(args[args.indexOf('+map') + 1]).toBe('de_nuke');
    expect(args[args.indexOf('+rcon_password') + 1]).toBe(rconPasswordExpected);
  });

  it('sends every chosen PC a one-click connect link', async () => {
    const res = await call<{ results: { stationId: string; ok: boolean }[] }>(
      'POST',
      '/cs2/connect',
      { stationIds: [station.id] },
    );
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ stationId: station.id, ok: true });
    const cmd = await waitFor('cs2.connect');
    expect(String(cmd.payload.url)).toBe(`steam://rungameid/730//+connect%20127.0.0.1:${rconPort}`);
  });

  it('runs the match commands over RCON', async () => {
    for (const preset of ['freezetime', 'restart', 'warmup_end'] as const) {
      const res = await call<{ command: string; output: string }>('POST', '/cs2/rcon', { preset });
      expect(res.status).toBe(200);
      expect(res.body.output).toMatch(/^ok: /);
    }
    expect(rconCommands).toEqual(['mp_freezetime 3', 'mp_restartgame 3', 'mp_warmup_end']);
  });

  it('reports a wrong RCON password as a clear error', async () => {
    const regen = await call('POST', '/cs2/passwords/rcon');
    expect(regen.status).toBe(200);
    const res = await call<Err>('POST', '/cs2/rcon', { preset: 'warmup_end' });
    expect(res.status).toBe(502);
    expect(res.body.error?.code).toBe('cs2_rcon_auth_failed');
  });

  it('refuses CS2 commands on the generic station route', async () => {
    const res = await call<Err>('POST', `/stations/${station.id}/command`, {
      command: 'cs2.start',
      args: ['-dedicated', '+rcon_password', 'x'],
    });
    expect(res.status).toBe(400);
  });

  it('installs the server on the server PC', async () => {
    const res = await call<{ ok: boolean }>('POST', '/cs2/server/install');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    await waitFor('cs2.install');
  });
  it('shows what the server PC last reported (start, listening or not)', async () => {
    client.send({
      type: 'client.event',
      event: 'cs2_result',
      payload: { action: 'start', ok: false, message: 'not listening on UDP 27015 yet' },
    });
    type Last = { action: string; ok: boolean; message: string } | null;
    let last: Last = null;
    for (let i = 0; i < 60 && !last; i++) {
      await sleep(40);
      const res = await call<{ serverStation: { lastResult: Last } | null }>('GET', '/cs2');
      last = res.body.serverStation?.lastResult ?? null;
    }
    expect(last).toMatchObject({
      action: 'start',
      ok: false,
      message: 'not listening on UDP 27015 yet',
    });
  });

  it('keeps saving after a factory reset emptied the config row', async () => {
    // A factory reset truncates cs2_config (it is not on the keep list): the row is simply gone.
    await ctx.pool.query('DELETE FROM cs2_config');
    const res = await call<{ config: { map: string } }>('PATCH', '/cs2', { map: 'de_inferno' });
    expect(res.status).toBe(200);
    expect(res.body.config.map).toBe('de_inferno');
    const again = await call<{ config: { map: string } }>('GET', '/cs2');
    expect(again.body.config.map).toBe('de_inferno');
  });
});
