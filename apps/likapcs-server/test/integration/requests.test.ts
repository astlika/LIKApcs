/**
 * Customer login on the PCs + session requests (0.9.0): staff give a customer a username/PIN,
 * the customer signs in on a paired PC, asks for time (quick duration or package) or an
 * extension, staff approve (= the normal start / extend with `requestId`, exactly once) or reject;
 * the PC and the Admins are told live; requests never expire but are cancelled when staff act on
 * the PC directly; wrong PINs lock the login; everything is scoped to the device.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  type ClientRequestOptions,
  type CustomerLoginResponse,
  type CustomerSummary,
  type GamingPackageSummary,
  type LoginResponse,
  type RegisterDeviceResponse,
  type RegistrationPollResponse,
  type SessionMutationResponse,
  type SessionRequest,
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

describe('session requests: customer login on the PC, approve / reject in the Admin', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let station: StationSummary;
  let other: StationSummary;
  let deviceToken: string;
  let deviceId: string;
  let hourPackage: GamingPackageSummary;
  let lika: CustomerSummary;
  let client: Awaited<ReturnType<typeof openSocket>>;
  let admin: Awaited<ReturnType<typeof openSocket>>;
  let wsUrl: string;

  const call = <T>(
    token: string | null,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    ctx.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: { ...(token ? authHeader(token) : {}), ...headers },
        payload: payload === undefined ? undefined : (payload as Record<string, unknown>),
      })
      .then((r) => ({ status: r.statusCode, body: r.body ? (r.json<T>() as T) : (null as T) }));

  const customerLogin = (username: string, password: string) =>
    call<CustomerLoginResponse & { error?: { code: string } }>(
      deviceToken,
      'POST',
      '/client/customer-login',
      { username, password },
    );
  const request = (customerToken: string, body: Record<string, unknown>) =>
    call<SessionRequest & { error?: { code: string; message: string } }>(
      deviceToken,
      'POST',
      '/client/session-request',
      body,
      { 'x-customer-token': customerToken },
    );
  /** Waits for a message of `type` on a socket, skipping unrelated pushes (stale displays …). */
  const expectMessage = async (
    socket: Awaited<ReturnType<typeof openSocket>>,
    type: string,
    where: (m: Record<string, unknown>) => boolean = () => true,
  ) => {
    const deadline = Date.now() + 5_000;
    const seen: string[] = [];
    while (Date.now() < deadline) {
      const msg = await socket.next(deadline - Date.now()).catch(() => null);
      if (!msg) break;
      if (msg.type === type && where(msg)) return msg;
      seen.push(JSON.stringify(msg).slice(0, 160));
    }
    throw new Error(`no ${type} message; saw: ${seen.join(' | ') || 'nothing'}`);
  };
  /**
   * Behaves like the real PC: acknowledges every command at once (otherwise each start / extend /
   * end would wait 15 s for the ack) and heartbeats so the presence sweep keeps it online.
   */
  let heartbeat: NodeJS.Timeout | null = null;
  const keepAlive = (socket: Awaited<ReturnType<typeof openSocket>>) => {
    socket.socket.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type: string; commandId?: string };
      if (msg.type === 'server.command' && msg.commandId)
        socket.send({ type: 'client.ack', commandId: msg.commandId, ok: true });
    });
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (socket.socket.readyState === socket.socket.OPEN)
        socket.send({ type: 'client.heartbeat', ts: new Date().toISOString(), locked: true });
    }, 2_000);
  };
  const expectRequestPush = (status: string, id?: string) =>
    expectMessage(client, 'server.request', (m) => {
      const r = m.request as { status: string; id: string };
      return r.status === status && (!id || r.id === id);
    }).then(
      (m) => m.request as { id: string; kind: string; status: string; reason: string | null },
    );
  const expectAdminEvent = (status: string, id?: string) =>
    expectMessage(admin, 'server.event', (m) => {
      if (m.event !== 'request.changed') return false;
      const r = m.payload as SessionRequest;
      return r.status === status && (!id || r.id === id);
    }).then((m) => m.payload as SessionRequest);

  const pairDevice = async (target: StationSummary, machineId: string) => {
    const registrationSecret = randomBytes(32).toString('base64url');
    const reg = await call<RegisterDeviceResponse>(null, 'POST', '/client/register', {
      machineId,
      hostname: machineId,
      osInfo: 'Windows 11',
      appVersion: SERVER_VERSION,
      registrationSecret,
    });
    await call(owner.token, 'POST', `/devices/${reg.body.registrationId}/approve`, {
      stationId: target.id,
    });
    const poll = await call<RegistrationPollResponse>(
      null,
      'GET',
      `/client/registration/${reg.body.registrationId}?secret=${registrationSecret}`,
    );
    return { token: poll.body.deviceToken!, deviceId: reg.body.registrationId };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
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
    expect(
      (
        await call(owner.token, 'POST', '/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 120,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);
    hourPackage = (
      await call<GamingPackageSummary>(owner.token, 'POST', '/pricing/packages', {
        name: '1 orë',
        durationMinutes: 60,
        priceCents: 100,
      })
    ).body;
    station = (
      await call<StationSummary>(owner.token, 'POST', '/stations', { number: 1, name: 'PC 1' })
    ).body;
    other = (
      await call<StationSummary>(owner.token, 'POST', '/stations', { number: 2, name: 'PC 2' })
    ).body;

    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    wsUrl = `ws://127.0.0.1:${port}`;
    const paired = await pairDevice(station, 'MACHINE-REQ-0001');
    deviceToken = paired.token;
    deviceId = paired.deviceId;
    client = await openSocket(`${wsUrl}/ws/client`);
    client.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId: 'MACHINE-REQ-0001',
    });
    const welcome = await client.next();
    expect(welcome.type).toBe('server.welcome');
    expect(welcome.request).toBeNull();
    keepAlive(client);
    admin = await openSocket(`${wsUrl}/ws/admin`);
    admin.send({ type: 'admin.hello', token: owner.token, protocolVersion: PROTOCOL_VERSION });
    expect((await admin.next()).type).toBe('server.welcome');
  }, 30_000);

  afterAll(async () => {
    if (heartbeat) clearInterval(heartbeat);
    client?.socket.close();
    admin?.socket.close();
    await ctx.close();
  });

  // ─── Customers: login fields ───────────────────────────────────────────────────

  it('staff give a customer a username + PIN (≥ 4 chars); the PIN is never returned', async () => {
    const short = await call(owner.token, 'POST', '/customers', {
      name: 'Lika',
      loginUsername: 'lika',
      loginPassword: '199',
    });
    expect(short.status).toBe(400);
    const noPin = await call(owner.token, 'POST', '/customers', {
      name: 'Lika',
      loginUsername: 'lika',
    });
    expect(noPin.status).toBe(400);

    const created = await call<CustomerSummary>(owner.token, 'POST', '/customers', {
      name: 'Lika',
      phone: '+383 44 000 000',
      loginUsername: 'lika',
      loginPassword: '1998',
    });
    expect(created.status).toBe(201);
    lika = created.body;
    expect(lika.loginUsername).toBe('lika');
    expect(lika.loginEnabled).toBe(true);
    expect(JSON.stringify(created.body)).not.toContain('1998');
    expect(JSON.stringify(created.body)).not.toContain('scrypt');

    // Case-insensitive uniqueness.
    const dup = await call(owner.token, 'POST', '/customers', {
      name: 'Other',
      loginUsername: 'LIKA',
      loginPassword: '0000',
    });
    expect(dup.status).toBe(409);

    // The audit trail records that a PIN was set, never the PIN.
    const audit = await call<{ items: { action: string; details: Record<string, unknown> }[] }>(
      owner.token,
      'GET',
      '/audit-logs?pageSize=50&action=customer.create',
    );
    const row = audit.body.items.find((a) => a.action === 'customer.create');
    expect(row).toBeTruthy();
    expect(JSON.stringify(audit.body)).not.toContain('1998');
  });

  it('a cashier (customers.manage) may edit the login too; a read-only role may not', async () => {
    const patched = await call<CustomerSummary>(cashier.token, 'PATCH', `/customers/${lika.id}`, {
      loginPassword: '2026',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.loginUsername).toBe('lika');
    // Keep the rest of the suite on the original PIN.
    expect(
      (
        await call(owner.token, 'PATCH', `/customers/${lika.id}`, {
          loginPassword: '1998',
        })
      ).status,
    ).toBe(200);
  });

  // ─── Login on the PC ───────────────────────────────────────────────────────────

  it('the customer signs in on the PC; wrong PINs are refused and lock the login after too many tries', async () => {
    const wrong = await customerLogin('lika', '0000');
    expect(wrong.status).toBe(401);
    expect(wrong.body.error?.code).toBe('invalid_credentials');
    const unknown = await customerLogin('nobody', '1234');
    expect(unknown.status).toBe(401);

    const ok = await customerLogin('LIKA', '1998');
    expect(ok.status).toBe(200);
    expect(ok.body.customerToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(ok.body.customer.name).toBe('Lika');
    expect(ok.body.pending).toBeNull();

    // Lockout: security.max_failed_logins (default 5) wrong PINs in a row.
    for (let i = 0; i < 5; i += 1) expect((await customerLogin('lika', '9999')).status).toBe(401);
    const locked = await customerLogin('lika', '1998');
    expect(locked.status).toBe(423);
    expect(locked.body.error?.code).toBe('locked');
    // Staff reset the PIN → unlocked.
    await call(owner.token, 'PATCH', `/customers/${lika.id}`, { loginPassword: '1998' });
    expect((await customerLogin('lika', '1998')).status).toBe(200);
  });

  it('login needs a device token; a disabled login or blocked customer is refused', async () => {
    const noDevice = await call(null, 'POST', '/client/customer-login', {
      username: 'lika',
      password: '1998',
    });
    expect(noDevice.status).toBe(401);

    await call(owner.token, 'PATCH', `/customers/${lika.id}`, { loginEnabled: false });
    const disabled = await customerLogin('lika', '1998');
    expect(disabled.status).toBe(403);
    expect(disabled.body.error?.code).toBe('login_disabled');
    await call(owner.token, 'PATCH', `/customers/${lika.id}`, { loginEnabled: true });

    await call(owner.token, 'PATCH', `/customers/${lika.id}`, { status: 'blocked' });
    expect((await customerLogin('lika', '1998')).status).toBe(403);
    await call(owner.token, 'PATCH', `/customers/${lika.id}`, { status: 'active' });
  });

  // ─── Options + create ──────────────────────────────────────────────────────────

  it('tells the PC what can be requested: quick durations with prices and the packages', async () => {
    const res = await call<ClientRequestOptions>(deviceToken, 'GET', '/client/request-options');
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('start');
    expect(res.body.quickMinutes).toEqual([30, 60, 120, 180]);
    expect(res.body.quickPrices['60']).toBe(120);
    expect(res.body.quickPrices['30']).toBe(60);
    expect(res.body.packages.map((p) => p.id)).toEqual([hourPackage.id]);
    expect(res.body.staffOnline).toBe(true);
    expect(res.body.currency).toBe('EUR');
  });

  let first: SessionRequest;

  it('creates a request (customer token bound to the device), pushes it to Admins and the PC', async () => {
    const session = (await customerLogin('lika', '1998')).body;
    const noToken = await call(deviceToken, 'POST', '/client/session-request', {
      kind: 'start',
      minutes: 60,
    });
    expect(noToken.status).toBe(401);
    const odd = await request(session.customerToken, { kind: 'start', minutes: 45 });
    expect(odd.status).toBe(400);

    const created = await request(session.customerToken, { kind: 'start', minutes: 60 });
    expect(created.status).toBe(201);
    first = created.body;
    expect(first.status).toBe('pending');
    expect(first.kind).toBe('start');
    expect(first.customerName).toBe('Lika');
    expect(first.durationMinutes).toBe(60);
    expect(first.stationCode).toBe(station.code);

    const event = await expectAdminEvent('pending', first.id);
    expect(event.customerId).toBe(lika.id);
    const push = await expectRequestPush('pending', first.id);
    expect(push.kind).toBe('start');

    // Only one pending request per PC.
    const second = await request(session.customerToken, { kind: 'start', minutes: 30 });
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe('request_pending');

    // The station grid shows it.
    const grid = await call<StationSummary[]>(owner.token, 'GET', '/stations');
    const tile = grid.body.find((s) => s.id === station.id)!;
    expect(tile.pendingRequest?.id).toBe(first.id);
    expect(tile.pendingRequest?.customerName).toBe('Lika');
    expect(tile.pendingRequest?.durationMinutes).toBe(60);

    // A new login on the same PC sees the waiting request.
    const again = (await customerLogin('lika', '1998')).body;
    expect(again.pending?.id).toBe(first.id);

    // A reconnecting PC is told about it in the welcome.
    const reconnect = await openSocket(`${wsUrl}/ws/client`);
    reconnect.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      machineId: 'MACHINE-REQ-0001',
    });
    const welcome = await reconnect.next();
    expect(welcome.type).toBe('server.welcome');
    expect((welcome.request as { id: string }).id).toBe(first.id);
    // That connection replaced the first one; keep using the newest socket.
    client.socket.close();
    client = reconnect;
    keepAlive(client);
  });

  it('the Admin lists pending requests; rejecting needs stations.control and tells the PC the reason', async () => {
    const list = await call<SessionRequest[]>(
      owner.token,
      'GET',
      '/session-requests?status=pending',
    );
    expect(list.status).toBe(200);
    expect(list.body.map((r) => r.id)).toEqual([first.id]);

    const anonymous = await call(null, 'POST', `/session-requests/${first.id}/reject`, {});
    expect(anonymous.status).toBe(401);

    const rejected = await call<SessionRequest>(
      owner.token,
      'POST',
      `/session-requests/${first.id}/reject`,
      { reason: 'PC rezervuar' },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');
    expect(rejected.body.reason).toBe('PC rezervuar');
    expect(rejected.body.decidedByName).toBeTruthy();
    const push = await expectRequestPush('rejected', first.id);
    expect(push.reason).toBe('PC rezervuar');
    await expectAdminEvent('rejected', first.id);

    // Final states stay final.
    expect(
      (await call(owner.token, 'POST', `/session-requests/${first.id}/reject`, {})).status,
    ).toBe(409);
    // The PC can read its own request; another PC cannot.
    const mine = await call<SessionRequest>(
      deviceToken,
      'GET',
      `/client/session-request/${first.id}`,
    );
    expect(mine.body.status).toBe('rejected');
    const foreign = await pairDevice(other, 'MACHINE-REQ-0002');
    expect((await call(foreign.token, 'GET', `/client/session-request/${first.id}`)).status).toBe(
      404,
    );
    expect(
      (await call(foreign.token, 'DELETE', `/client/session-request/${first.id}`)).status,
    ).toBe(404);
  });

  it('the customer can withdraw a pending request from the PC', async () => {
    const session = (await customerLogin('lika', '1998')).body;
    const created = await request(session.customerToken, {
      kind: 'start',
      packageId: hourPackage.id,
    });
    expect(created.status).toBe(201);
    expect(created.body.packageName).toBe('1 orë');
    expect(created.body.durationMinutes).toBe(60);
    await expectRequestPush('pending', created.body.id);
    const cancelled = await call<SessionRequest>(
      deviceToken,
      'DELETE',
      `/client/session-request/${created.body.id}`,
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(cancelled.body.reason).toBe('customer');
    await expectRequestPush('cancelled', created.body.id);
    await expectAdminEvent('cancelled', created.body.id);
  });

  // ─── Approve = start / extend with requestId ────────────────────────────────────

  let approved: SessionRequest;
  let sessionId: string;

  it('approving = POST /sessions with requestId: session starts, request approved in the same transaction, exactly once', async () => {
    const session = (await customerLogin('lika', '1998')).body;
    approved = (await request(session.customerToken, { kind: 'start', minutes: 60 })).body;
    await expectRequestPush('pending', approved.id);

    // Wrong station → nothing happens (the session is not started either).
    const wrongStation = await call(owner.token, 'POST', '/sessions', {
      stationId: other.id,
      billingMode: 'prepaid',
      minutes: 60,
      requestId: approved.id,
      payments: [{ method: 'cash', amountCents: 120 }],
    });
    expect(wrongStation.status).toBe(409);
    expect(
      (await call<StationSummary[]>(owner.token, 'GET', '/stations')).body.find(
        (s) => s.id === other.id,
      )!.activeSession,
    ).toBeNull();

    const started = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
      stationId: station.id,
      billingMode: 'prepaid',
      minutes: 60,
      customerId: lika.id,
      requestId: approved.id,
      payments: [{ method: 'cash', amountCents: 120 }],
    });
    expect(started.status).toBe(201);
    sessionId = started.body.session.id;
    expect(started.body.session.customerId).toBe(lika.id);

    const after = await call<SessionRequest>(
      owner.token,
      'GET',
      `/session-requests/${approved.id}`,
    );
    expect(after.body.status).toBe('approved');
    expect(after.body.sessionId).toBe(sessionId);
    await expectRequestPush('approved', approved.id);
    // The PC also receives the real start command — the only thing that unlocks it.
    await expectMessage(client, 'server.command', (m) => m.command === 'session.start');
    await expectAdminEvent('approved', approved.id);

    // Approving twice is impossible (and does not start a second session either).
    expect((await call(owner.token, 'POST', `/sessions/${sessionId}/end`, {})).status).toBe(200);
    await expectMessage(client, 'server.command', (m) => m.command === 'session.end');
    const again = await call<{ error: { code: string } }>(owner.token, 'POST', '/sessions', {
      stationId: station.id,
      billingMode: 'prepaid',
      minutes: 60,
      requestId: approved.id,
      payments: [{ method: 'cash', amountCents: 120 }],
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('request_not_pending');
    expect(
      (await call<StationSummary[]>(owner.token, 'GET', '/stations')).body.find(
        (s) => s.id === station.id,
      )!.activeSession,
    ).toBeNull();
  });

  it('during a prepaid session the customer asks for more time; approving = extend with requestId', async () => {
    const started = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
      stationId: station.id,
      billingMode: 'prepaid',
      minutes: 30,
      customerId: lika.id,
      payments: [{ method: 'cash', amountCents: 60 }],
    });
    expect(started.status).toBe(201);
    sessionId = started.body.session.id;
    await expectMessage(client, 'server.command', (m) => m.command === 'session.start');

    const options = (
      await call<ClientRequestOptions>(deviceToken, 'GET', '/client/request-options')
    ).body;
    expect(options.kind).toBe('extend');
    expect(options.sessionId).toBe(sessionId);

    const login = (await customerLogin('lika', '1998')).body;
    const startWhileRunning = await request(login.customerToken, { kind: 'start', minutes: 30 });
    expect(startWhileRunning.status).toBe(409);
    expect(startWhileRunning.body.error?.code).toBe('session_active');

    const ext = await request(login.customerToken, { kind: 'extend', minutes: 30 });
    expect(ext.status).toBe(201);
    expect(ext.body.sessionId).toBe(sessionId);
    await expectRequestPush('pending', ext.body.id);

    const extended = await call<SessionMutationResponse>(
      owner.token,
      'POST',
      `/sessions/${sessionId}/extend`,
      { minutes: 30, requestId: ext.body.id, payments: [{ method: 'credit', amountCents: 60 }] },
    );
    expect(extended.status).toBe(200);
    expect(extended.body.session.plannedSeconds).toBe(3600);
    const after = await call<SessionRequest>(
      owner.token,
      'GET',
      `/session-requests/${ext.body.id}`,
    );
    expect(after.body.status).toBe('approved');
    await expectRequestPush('approved', ext.body.id);
    await expectMessage(client, 'server.command', (m) => m.command === 'session.extend');
  });

  it('requests never expire but are cancelled when staff act on the PC directly', async () => {
    // Pending extension + staff extend manually → cancelled (reason session_extended).
    const login = (await customerLogin('lika', '1998')).body;
    const ext = (await request(login.customerToken, { kind: 'extend', packageId: hourPackage.id }))
      .body;
    expect(ext.status).toBe('pending');
    await expectRequestPush('pending', ext.id);
    expect(
      (
        await call(owner.token, 'POST', `/sessions/${sessionId}/extend`, {
          minutes: 30,
          payments: [{ method: 'cash', amountCents: 60 }],
        })
      ).status,
    ).toBe(200);
    const afterExtend = await call<SessionRequest>(
      owner.token,
      'GET',
      `/session-requests/${ext.id}`,
    );
    expect(afterExtend.body.status).toBe('cancelled');
    expect(afterExtend.body.reason).toBe('session_extended');
    await expectRequestPush('cancelled', ext.id);
    await expectMessage(client, 'server.command', (m) => m.command === 'session.extend');

    // Pending extension + session ends → cancelled (session_ended).
    const ext2 = (await request(login.customerToken, { kind: 'extend', minutes: 30 })).body;
    await expectRequestPush('pending', ext2.id);
    expect((await call(owner.token, 'POST', `/sessions/${sessionId}/end`, {})).status).toBe(200);
    // The answer reaches the PC before the end command (announce, then mirror).
    await expectRequestPush('cancelled', ext2.id);
    await expectMessage(client, 'server.command', (m) => m.command === 'session.end');
    expect(
      (await call<SessionRequest>(owner.token, 'GET', `/session-requests/${ext2.id}`)).body.reason,
    ).toBe('session_ended');

    // Pending start + staff start a session manually (no requestId) → cancelled (session_started).
    const login2 = (await customerLogin('lika', '1998')).body;
    const st = (await request(login2.customerToken, { kind: 'start', minutes: 30 })).body;
    await expectRequestPush('pending', st.id);
    const manual = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
      stationId: station.id,
      billingMode: 'postpaid',
    });
    expect(manual.status).toBe(201);
    await expectRequestPush('cancelled', st.id);
    await expectMessage(client, 'server.command', (m) => m.command === 'session.start');
    expect(
      (await call<SessionRequest>(owner.token, 'GET', `/session-requests/${st.id}`)).body.reason,
    ).toBe('session_started');
    // Postpaid sessions cannot be extended → nothing to request.
    expect(
      (await call<ClientRequestOptions>(deviceToken, 'GET', '/client/request-options')).body.kind,
    ).toBe('none');
    expect(
      (
        await call(owner.token, 'POST', `/sessions/${manual.body.session.id}/cancel`, {
          reason: 'test clean-up',
        })
      ).status,
    ).toBe(200);
    await expectMessage(client, 'server.command', (m) => m.command === 'session.end');
  });

  it('switching requests off refuses the login; revoking the PC cancels its waiting request', async () => {
    expect(
      (await call(owner.token, 'PATCH', '/settings', { 'requests.enabled': false })).status,
    ).toBe(200);
    const off = await customerLogin('lika', '1998');
    expect(off.status).toBe(403);
    expect(off.body.error?.code).toBe('requests_disabled');
    // The PCs learn about it through the display push (button hidden).
    await expectMessage(
      client,
      'server.display',
      (m) => (m.display as { customerLogin: boolean }).customerLogin === false,
    );
    await call(owner.token, 'PATCH', '/settings', { 'requests.enabled': true });
    await expectMessage(
      client,
      'server.display',
      (m) => (m.display as { customerLogin: boolean }).customerLogin === true,
    );

    const login = (await customerLogin('lika', '1998')).body;
    const st = (await request(login.customerToken, { kind: 'start', minutes: 30 })).body;
    expect(st.status).toBe('pending');
    expect((await call(owner.token, 'POST', `/devices/${deviceId}/revoke`)).status).toBe(200);
    const after = await call<SessionRequest>(owner.token, 'GET', `/session-requests/${st.id}`);
    expect(after.body.status).toBe('cancelled');
    expect(after.body.reason).toBe('device_revoked');
    const history = await call<SessionRequest[]>(owner.token, 'GET', '/session-requests?limit=100');
    expect(history.body.filter((r) => r.status === 'pending')).toHaveLength(0);
    expect(history.body.filter((r) => r.status === 'approved')).toHaveLength(2);
  });
});
