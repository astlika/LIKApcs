/**
 * Phase 7 — updates dashboard: release feed check (against a local stand-in for GitHub), version
 * states per client, client self-update progress recorded from WebSocket events, admin/server
 * version events, permissions.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  type LoginResponse,
  type RegisterDeviceResponse,
  type RegistrationPollResponse,
  type StationSummary,
  type UpdateHistoryEntry,
  type UpdatesOverview,
} from '@likapcs/shared';
import { SERVER_VERSION } from '../../src/version.js';
import { versionState } from '../../src/services/updates.js';
import {
  authHeader,
  createTestContext,
  login,
  openSocket,
  runSetup,
  type TestContext,
} from '../helpers.js';

function bump(version: string, part: 'minor' | 'patch'): string {
  const [major, minor, patch] = version.split('.').map((n) => Number(n.split('-')[0]));
  return part === 'minor' ? `${major}.${minor! + 1}.0` : `${major}.${minor}.${patch! + 1}`;
}

describe('updates dashboard', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let feed: http.Server;
  let feedUrl: string;
  let wsUrl: string;
  let station: StationSummary;
  let deviceId: string;
  let deviceToken: string;
  const newer = bump(SERVER_VERSION, 'patch');
  /** An older but still compatible client build (same major; lower patch, else lower minor). */
  const olderParts = SERVER_VERSION.split('-')[0]!.split('.').map(Number) as [
    number,
    number,
    number,
  ];
  const older =
    olderParts[2] > 0
      ? `${olderParts[0]}.${olderParts[1]}.${olderParts[2] - 1}`
      : `${olderParts[0]}.${Math.max(0, olderParts[1] - 1)}.0`;
  let feedVersion = newer;
  let feedFails = false;
  let clientManifestMissing = false;

  const call = <T>(
    token: string,
    method: 'GET' | 'POST',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(token), payload })
      .then((r) => ({ status: r.statusCode, body: r.json() as T }));

  beforeAll(async () => {
    feed = http.createServer((req, res) => {
      if (feedFails || (clientManifestMissing && req.url?.includes('client'))) {
        res.statusCode = feedFails ? 503 : 404;
        return res.end(feedFails ? 'down' : 'Not Found');
      }
      const manifest = {
        version: feedVersion,
        notes: `Release ${feedVersion}`,
        pub_date: '2026-10-01T10:00:00Z',
        platforms: {
          'windows-x86_64': {
            signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHRlc3Q=',
            url: `https://example.invalid/${req.url?.includes('client') ? 'LIKApcs-Client-Setup.exe' : 'LIKApcs-Setup.exe'}`,
          },
        },
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(manifest));
    });
    await new Promise<void>((resolve) => feed.listen(0, '127.0.0.1', resolve));
    const addr = feed.address();
    feedUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

    ctx = await createTestContext();
    // Rebuild the app with the local feed.
    await ctx.app.close();
    const { buildApp } = await import('../../src/app.js');
    ctx.app = await buildApp({
      config: ctx.config,
      pool: ctx.pool,
      logger: false,
      sessionTicker: false,
      backupScheduler: false,
      updateCheckOnStartup: false,
      updateFeedBaseUrl: feedUrl,
    });
    await ctx.app.ready();
    owner = await runSetup(ctx.app);
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    wsUrl = `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    station = (
      await call<StationSummary>(owner.token, 'POST', '/stations', { number: 1, name: 'PC 01' })
    ).body;
    const secret = randomBytes(32).toString('base64url');
    const registered = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: {
        machineId: 'MACHINE-UPD-0001',
        hostname: 'GAMING-PC-01',
        osInfo: 'Windows 11',
        appVersion: SERVER_VERSION,
        registrationSecret: secret,
      },
    });
    deviceId = registered.json<RegisterDeviceResponse>().registrationId;
    await call(owner.token, 'POST', `/devices/${deviceId}/approve`, { stationId: station.id });
    const poll = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/client/registration/${deviceId}?secret=${secret}`,
    });
    deviceToken = poll.json<RegistrationPollResponse>().deviceToken!;
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    await new Promise<void>((resolve) => feed.close(() => resolve()));
  });

  it('records the server version at start-up and reports clients against the server line', async () => {
    const overview = await call<UpdatesOverview>(owner.token, 'GET', '/system/updates');
    expect(overview.status).toBe(200);
    expect(overview.body.server.version).toBe(SERVER_VERSION);
    expect(overview.body.targetVersion).toBe(SERVER_VERSION);
    expect(overview.body.latest.client).toBeNull();
    expect(overview.body.latest.serverUpdateAvailable).toBe(false);
    expect(overview.body.check.checkedAt).toBeNull();
    expect(
      overview.body.history.some((h) => h.component === 'server' && h.toVersion === SERVER_VERSION),
    ).toBe(true);
    expect(overview.body.clients).toHaveLength(1);
    expect(overview.body.clients[0]).toMatchObject({
      deviceId,
      stationCode: 'PC 01',
      appVersion: SERVER_VERSION,
      online: false,
      state: 'current',
    });
    expect(overview.body.counts).toEqual({ clients: 1, online: 0, outdated: 0, updating: 0 });
  });

  it('checks the release feed, caches the manifests and flags clients as outdated', async () => {
    const checked = await call<UpdatesOverview>(owner.token, 'POST', '/system/updates/check', {});
    expect(checked.status).toBe(200);
    expect(checked.body.check.ok).toBe(true);
    expect(checked.body.latest.admin?.version).toBe(newer);
    expect(checked.body.latest.client).toMatchObject({
      version: newer,
      signed: true,
      downloadUrl: 'https://example.invalid/LIKApcs-Client-Setup.exe',
      releaseNotes: `Release ${newer}`,
    });
    // Clients follow the server, so the target stays the server version until the main PC updates.
    expect(checked.body.targetVersion).toBe(SERVER_VERSION);
    expect(checked.body.latest.serverUpdateAvailable).toBe(true);
    expect(checked.body.clients[0]!.state).toBe('current');
    expect(checked.body.counts.outdated).toBe(0);

    // Feed down → previous knowledge is kept, error surfaced.
    feedFails = true;
    const failed = await call<UpdatesOverview>(owner.token, 'POST', '/system/updates/check', {});
    expect(failed.body.check.ok).toBe(false);
    expect(failed.body.check.error).toContain('503');
    expect(failed.body.latest.client?.version).toBe(newer);
    feedFails = false;

    // A newer manifest replaces the "latest" flag, older rows stay for history. A missing client
    // manifest (as on releases that predate the Client app) still records the main-PC release.
    feedVersion = bump(newer, 'patch');
    clientManifestMissing = true;
    const partial = await call<UpdatesOverview>(owner.token, 'POST', '/system/updates/check', {});
    expect(partial.body.check.ok).toBe(false);
    expect(partial.body.check.error).toContain('latest-client.json');
    expect(partial.body.latest.admin?.version).toBe(feedVersion);
    expect(partial.body.latest.client?.version).toBe(newer);
    clientManifestMissing = false;
    const second = await call<UpdatesOverview>(owner.token, 'POST', '/system/updates/check', {});
    expect(second.body.check.ok).toBe(true);
    expect(second.body.latest.client?.version).toBe(feedVersion);
    const rows = await ctx.pool.query<{ version: string; is_latest: boolean }>(
      `SELECT version, is_latest FROM application_versions WHERE component = 'client' ORDER BY version`,
    );
    expect(rows.rows).toEqual([
      { version: newer, is_latest: false },
      { version: feedVersion, is_latest: true },
    ]);
  });

  it('turns client update_status events into one history run per attempt', async () => {
    const client = await openSocket(`${wsUrl}/ws/client`);
    client.send({
      type: 'client.hello',
      token: deviceToken,
      appVersion: older,
      protocolVersion: PROTOCOL_VERSION,
      machineId: 'MACHINE-UPD-0001',
    });
    expect((await client.next()).type).toBe('server.welcome');
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    client.send({
      type: 'client.event',
      event: 'update_status',
      payload: { status: 'checking', trigger: 'command' },
    });
    await wait(150);
    let overview = await call<UpdatesOverview>(owner.token, 'GET', '/system/updates');
    expect(overview.body.clients[0]!.online).toBe(true);
    expect(overview.body.clients[0]!.appVersion).toBe(older);
    expect(overview.body.clients[0]!.state).toBe('outdated');
    expect(overview.body.counts.outdated).toBe(1);
    expect(overview.body.clients[0]!.lastUpdate).toMatchObject({
      status: 'pending',
      toVersion: feedVersion,
    });
    expect(overview.body.counts.updating).toBe(1);

    client.send({
      type: 'client.event',
      event: 'update_status',
      payload: { status: 'failed', error: 'signature mismatch', trigger: 'command' },
    });
    await wait(150);
    overview = await call<UpdatesOverview>(owner.token, 'GET', '/system/updates');
    expect(overview.body.clients[0]!.lastUpdate).toMatchObject({
      status: 'failed',
      errorMessage: 'signature mismatch',
    });
    expect(overview.body.counts.updating).toBe(0);
    const runs = await ctx.pool.query<{ status: string; from_version: string }>(
      `SELECT status, from_version FROM update_history WHERE device_id = $1`,
      [deviceId],
    );
    expect(runs.rows).toEqual([{ status: 'failed', from_version: older }]);

    // A second attempt that succeeds creates a second run.
    client.send({
      type: 'client.event',
      event: 'update_status',
      payload: { status: 'checking', trigger: 'command' },
    });
    await wait(100);
    client.send({
      type: 'client.event',
      event: 'update_status',
      payload: { status: 'installed', version: feedVersion, trigger: 'command' },
    });
    await wait(150);
    const after = await ctx.pool.query<{ status: string; to_version: string }>(
      `SELECT status, to_version FROM update_history WHERE device_id = $1 ORDER BY started_at`,
      [deviceId],
    );
    expect(after.rows).toEqual([
      { status: 'failed', to_version: feedVersion },
      { status: 'succeeded', to_version: feedVersion },
    ]);

    // "Update outdated clients" reaches the online, outdated client with update.apply.
    const pushP = call<{ outdated: number; sent: number }>(
      owner.token,
      'POST',
      '/system/updates/push',
      {},
    );
    const command = await client.next();
    expect(command).toMatchObject({ type: 'server.command', command: 'update.apply' });
    client.send({ type: 'client.ack', commandId: command.commandId, ok: true });
    const push = await pushP;
    expect(push.body).toMatchObject({ outdated: 1, sent: 1 });
    client.socket.close();
  }, 20_000);

  it('accepts admin version events and rejects unknown components; cashiers see nothing', async () => {
    const event = await call<UpdateHistoryEntry>(owner.token, 'POST', '/system/updates/events', {
      component: 'admin',
      fromVersion: '0.1.1',
      toVersion: SERVER_VERSION,
      status: 'succeeded',
    });
    expect(event.status).toBe(201);
    expect(event.body).toMatchObject({
      component: 'admin',
      toVersion: SERVER_VERSION,
      status: 'succeeded',
    });
    expect(
      (
        await call(owner.token, 'POST', '/system/updates/events', {
          component: 'client',
          toVersion: '1.0.0',
          status: 'succeeded',
        })
      ).status,
    ).toBe(400);
    const overview = await call<UpdatesOverview>(owner.token, 'GET', '/system/updates');
    expect(overview.body.history[0]).toMatchObject({
      component: 'admin',
      initiatedByName: 'Shop Owner',
    });

    await call(owner.token, 'POST', '/users', {
      username: 'kasa',
      fullName: 'Kasa Cashier',
      password: 'Cashier123',
      roles: ['cashier'],
      mustChangePassword: false,
    });
    const cashier = await login(ctx.app, 'kasa', 'Cashier123');
    expect((await call(cashier.token, 'GET', '/system/updates')).status).toBe(403);
    expect((await call(cashier.token, 'POST', '/system/updates/check', {})).status).toBe(403);
    // …but may report its own Admin app version.
    expect(
      (
        await call(cashier.token, 'POST', '/system/updates/events', {
          component: 'admin',
          toVersion: SERVER_VERSION,
          status: 'succeeded',
        })
      ).status,
    ).toBe(201);
  });

  it('versionState compares semantic versions', () => {
    expect(versionState('0.2.0', '0.2.0')).toBe('current');
    expect(versionState('0.1.9', '0.2.0')).toBe('outdated');
    expect(versionState('0.3.0', '0.2.0')).toBe('newer');
    expect(versionState(null, '0.2.0')).toBe('unknown');
    expect(versionState('garbage', '0.2.0')).toBe('unknown');
  });
});
