import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  type LoginResponse,
  type RegisterDeviceResponse,
  type RegistrationPollResponse,
  type SessionMutationResponse,
  type SettingsMap,
  type StationCommandResponse,
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

/**
 * End Task (0.17.0): "close the games on this PC" — the staff button, what the PC reports back,
 * the pressed/not-pressed state on the station, and the optional automatic run when a session
 * ends. The list of programs always comes from the settings on the server, never from the
 * request, and a protected name (LIKApcs itself, the Windows shell) can never be stored.
 */
describe('End Task', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let station: StationSummary;
  let deviceToken: string;
  let client: Awaited<ReturnType<typeof openSocket>>;
  let wsUrl: string;
  let heartbeat: NodeJS.Timeout | null = null;
  /** When on, the fake PC reports the outcome the moment it acks (see `attach`). */
  let autoReport = false;

  type Err = { error?: { code: string; message: string; details?: unknown } };
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

  const setExes = (list: string[]) =>
    call<SettingsMap & Err>('PATCH', '/settings', { 'stations.end_tasks_exes': list });
  const setAuto = (on: boolean) =>
    call<SettingsMap & Err>('PATCH', '/settings', { 'stations.end_tasks_auto': on });
  const stationNow = async () =>
    (await call<StationSummary[]>('GET', '/stations')).body.find((s) => s.id === station.id)!;
  /** Polls the station until its End Task state reaches `status` (or the time is up). */
  const waitForState = async (status: 'pending' | 'done' | 'failed', ms = 4_000) => {
    const until = Date.now() + ms;
    let value = null;
    while (Date.now() < until) {
      value = (await stationNow()).device?.tasksEnded ?? null;
      if (value?.status === status) return value;
      await sleep(50);
    }
    return value;
  };
  const endTasksCommand = () =>
    call<StationCommandResponse & Err>('POST', `/stations/${station.id}/command`, {
      command: 'tasks.end',
    });

  /** Waits for the next `tasks.end` command the server pushes to this PC (auto-acked). */
  const expectTasksEndCommand = async (exes?: string[]) => {
    const deadline = Date.now() + 5_000;
    const seen: string[] = [];
    while (Date.now() < deadline) {
      const msg = await client.next(deadline - Date.now()).catch(() => null);
      if (!msg) break;
      if (msg.type === 'server.command' && msg.command === 'tasks.end') {
        if (exes) expect((msg.payload as { exes: string[] }).exes).toEqual(exes);
        return msg as { commandId: string; payload: { exes: string[] } };
      }
      seen.push(`${String(msg.type)}${msg.command ? `/${String(msg.command)}` : ''}`);
    }
    throw new Error(`no tasks.end command; saw: ${seen.join(' | ') || 'nothing'}`);
  };

  /** The PC reports what it closed (`client.event` → `tasks_ended`). */
  const reportFromPc = (payload: Record<string, unknown>) =>
    client.send({ type: 'client.event', event: 'tasks_ended', payload });

  /**
   * A real PC answers every command at once and keeps beating; after a network blip the same
   * device simply opens a new socket, so the test can do the same.
   */
  function attach(socket: Awaited<ReturnType<typeof openSocket>>) {
    client = socket;
    socket.socket.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as {
        type: string;
        command?: string;
        commandId?: string;
        payload?: { exes?: string[] };
      };
      if (msg.type === 'server.command' && msg.commandId)
        socket.send({ type: 'client.ack', commandId: msg.commandId, ok: true });
      // A real PC closes the programs and reports in the same tick as the ack — the fastest
      // answer possible, which is exactly the case that must not be overwritten by "pending".
      if (autoReport && msg.type === 'server.command' && msg.command === 'tasks.end')
        socket.send({
          type: 'client.event',
          event: 'tasks_ended',
          payload: {
            closed: [],
            notRunning: msg.payload?.exes ?? [],
            failed: [],
            skipped: [],
          },
        });
    });
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (socket.socket.readyState === socket.socket.OPEN)
        socket.send({ type: 'client.heartbeat', ts: new Date().toISOString(), locked: true });
    }, 2_000);
  }

  const reconnect = async () => {
    const socket = await openSocket(`${wsUrl}/ws/client`);
    socket.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId: 'MACHINE-ENDTASK-1',
    });
    expect((await socket.next()).type).toBe('server.welcome');
    attach(socket);
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    wsUrl = `ws://127.0.0.1:${port}`;
    station = (await call<StationSummary>('POST', '/stations', { number: 1, name: 'PC 1' })).body;
    expect((await call('POST', '/cash/shifts/open', { openingCents: 5000 })).status).toBe(201);
    expect(
      (
        await call('POST', '/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 150,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);

    const registrationSecret = randomBytes(32).toString('base64url');
    const reg = await call<RegisterDeviceResponse>(
      'POST',
      '/client/register',
      {
        machineId: 'MACHINE-ENDTASK-1',
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
    deviceToken = poll.body.deviceToken!;
    client = await openSocket(`${wsUrl}/ws/client`);
    client.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId: 'MACHINE-ENDTASK-1',
    });
    expect((await client.next()).type).toBe('server.welcome');
    attach(client);
  }, 30_000);

  afterAll(async () => {
    if (heartbeat) clearInterval(heartbeat);
    client.socket.close();
    await ctx.close();
  });

  it('refuses to store a protected or malformed program name', async () => {
    const protectedName = await setExes(['steam.exe', 'likapcs-client.exe']);
    expect(protectedName.status).toBe(400);
    expect(protectedName.body.error?.code).toBe('validation_error');
    expect(JSON.stringify(protectedName.body.error)).toMatch(/can never be closed/);

    const shell = await setExes(['C:\\Windows\\explorer']);
    expect(shell.status).toBe(400);
    expect(JSON.stringify(shell.body.error)).toMatch(/can never be closed/);

    const malformed = await setExes(['steam', 'not a name?']);
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(malformed.body.error)).toMatch(/not a program name/);

    // Nothing was stored by the rejected patches.
    expect((await call<SettingsMap>('GET', '/settings')).body['stations.end_tasks_exes']).toEqual(
      [],
    );
  });

  it('stores the cleaned list: path stripped, .exe appended, duplicates dropped', async () => {
    const saved = await setExes(['C:\\Program Files (x86)\\Steam\\steam.exe', 'cs2', 'CS2.EXE']);
    expect(saved.status).toBe(200);
    expect(saved.body['stations.end_tasks_exes']).toEqual(['steam.exe', 'cs2.exe']);
    expect(saved.body['stations.end_tasks_auto']).toBe(false);
  });

  it('refuses the command while the list is empty', async () => {
    expect((await setExes([])).status).toBe(200);
    const res = await endTasksCommand();
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('end_tasks_empty');
    expect(res.body.error?.message).toMatch(/Settings/);
    await setExes(['steam', 'cs2.exe']);
  });

  it('sends only the owner-listed programs and shows the button as pressed', async () => {
    const res = await endTasksCommand();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ command: 'tasks.end', ok: true });

    const pushed = await expectTasksEndCommand(['steam.exe', 'cs2.exe']);
    expect(pushed.payload.exes).not.toContain('likapcs-client.exe');

    // Pressed at once (the desk must see the state before the PC answers).
    const pending = await stationNow();
    expect(pending.device?.tasksEnded).toMatchObject({ status: 'pending', trigger: 'manual' });
    expect(pending.device?.tasksEnded?.closed).toEqual([]);
    expect(typeof res.body.commandId).toBe('string');
  });

  it('records what the PC closed, what was not running and what failed', async () => {
    reportFromPc({
      closed: ['cs2.exe'],
      notRunning: ['steam.exe'],
      failed: [],
      skipped: [],
    });
    await sleep(300);
    const done = await stationNow();
    expect(done.device?.tasksEnded).toMatchObject({
      status: 'done',
      closed: ['cs2.exe'],
      notRunning: ['steam.exe'],
      failed: [],
      trigger: 'manual',
    });

    reportFromPc({
      closed: [],
      notRunning: ['steam.exe'],
      failed: [{ exe: 'cs2.exe', error: 'access denied' }],
      skipped: [],
    });
    await sleep(300);
    const failed = await stationNow();
    expect(failed.device?.tasksEnded).toMatchObject({
      status: 'failed',
      closed: [],
      notRunning: ['steam.exe'],
      failed: ['cs2.exe · access denied'],
      trigger: 'manual',
    });

    // A report the schema does not recognise is stored as a failure, never silently dropped.
    reportFromPc({ nonsense: true });
    await sleep(300);
    const malformed = await stationNow();
    expect(malformed.device?.tasksEnded?.status).toBe('failed');
    expect(malformed.device?.tasksEnded?.failed).toEqual(['malformed report from the PC']);
  });

  it('audits the command and every report', async () => {
    const rows = await ctx.pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE entity_id = $1 AND action LIKE '%tasks%' ORDER BY id`,
      [station.id],
    );
    const actions = rows.rows.map((r) => r.action);
    expect(actions).toContain('station.command.tasks.end');
    expect(actions.filter((a) => a === 'station.tasks_ended').length).toBeGreaterThanOrEqual(3);
  });

  it('releases the button when the next session starts', async () => {
    reportFromPc({ closed: ['cs2.exe'], notRunning: [], failed: [], skipped: [] });
    await sleep(300);
    expect((await stationNow()).device?.tasksEnded?.status).toBe('done');

    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: station.id,
      billingMode: 'prepaid',
      minutes: 10,
    });
    expect(started.status).toBe(201);
    await sleep(400); // the session.start command is auto-acked by the listener above
    expect((await stationNow()).device?.tasksEnded).toBeNull();
    await call('POST', `/sessions/${started.body.session.id}/end`, {});
  });

  it('keeps the pressed state when the PC drops for a moment and reconnects', async () => {
    expect((await endTasksCommand()).status).toBe(200);
    reportFromPc({ closed: ['cs2.exe'], notRunning: ['steam.exe'], failed: [], skipped: [] });
    await sleep(300);
    expect((await stationNow()).device?.tasksEnded?.status).toBe('done');

    client.socket.close(); // network blip
    await sleep(600);
    const offline = await stationNow();
    expect(offline.device?.online).toBe(false);
    expect(offline.device?.tasksEnded?.status, 'the run is remembered while offline').toBe('done');

    await reconnect();
    await sleep(400);
    const back = await stationNow();
    expect(back.device?.online).toBe(true);
    expect(back.device?.tasksEnded).toMatchObject({
      status: 'done',
      closed: ['cs2.exe'],
      trigger: 'manual',
    });
  });

  it('a PC that answers at once is never left showing "Closing…"', async () => {
    autoReport = true;
    try {
      expect((await endTasksCommand()).status).toBe(200);
      const settled = await waitForState('done');
      expect(settled, 'the report must have the last word').toMatchObject({
        status: 'done',
        trigger: 'manual',
        notRunning: ['steam.exe', 'cs2.exe'],
      });

      // The same race on the automatic path: the run must stay marked "automatic".
      expect((await setAuto(true)).status).toBe(200);
      const started = await call<SessionMutationResponse>('POST', '/sessions', {
        stationId: station.id,
        billingMode: 'postpaid',
      });
      expect(started.status).toBe(201);
      await sleep(200);
      expect(
        (await call('POST', `/sessions/${started.body.session.id}/cancel`, { reason: 'race' }))
          .status,
      ).toBe(200);
      expect(await waitForState('done')).toMatchObject({ status: 'done', trigger: 'auto' });
      expect((await setAuto(false)).status).toBe(200);
    } finally {
      autoReport = false;
    }
  });

  it('does nothing on its own while the automatic run is off', async () => {
    expect((await setAuto(false)).status).toBe(200);
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: station.id,
      billingMode: 'postpaid',
    });
    expect(started.status).toBe(201);
    await sleep(200);
    const cancelled = await call<SessionMutationResponse>(
      'POST',
      `/sessions/${started.body.session.id}/cancel`,
      { reason: 'test' },
    );
    expect(cancelled.status).toBe(200);
    await sleep(500);
    expect((await stationNow()).device?.tasksEnded).toBeNull();
  });

  it('closes the programs by itself when the session ends and the automatic run is on', async () => {
    expect((await setAuto(true)).status).toBe(200);
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: station.id,
      billingMode: 'postpaid',
    });
    expect(started.status).toBe(201);
    await sleep(200);
    const cancelled = await call<SessionMutationResponse>(
      'POST',
      `/sessions/${started.body.session.id}/cancel`,
      { reason: 'customer left' },
    );
    expect(cancelled.status).toBe(200);

    await expectTasksEndCommand(['steam.exe', 'cs2.exe']);
    await sleep(300);
    expect((await stationNow()).device?.tasksEnded).toMatchObject({
      status: 'pending',
      trigger: 'auto',
    });
    reportFromPc({ closed: ['steam.exe', 'cs2.exe'], notRunning: [], failed: [], skipped: [] });
    await sleep(300);
    expect((await stationNow()).device?.tasksEnded).toMatchObject({
      status: 'done',
      closed: ['steam.exe', 'cs2.exe'],
      trigger: 'auto',
    });
  });

  it('keeps the automatic run from failing the session when the PC will not answer', async () => {
    // The client goes away: the session must still end cleanly, and the failure is logged.
    client.socket.close();
    await sleep(300);
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: station.id,
      billingMode: 'postpaid',
    });
    expect(started.status).toBe(201);
    await sleep(200);
    const cancelled = await call<SessionMutationResponse>(
      'POST',
      `/sessions/${started.body.session.id}/cancel`,
      { reason: 'offline test' },
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.session.status).toBe('cancelled');
    await sleep(400);
    const manual = await endTasksCommand();
    expect(manual.status).toBe(409);
  });
});
