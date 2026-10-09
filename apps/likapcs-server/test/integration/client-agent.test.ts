/**
 * End-to-end test of the real LIKApcs-Client agent (apps/likapcs-client/src/lib/agent.ts) against
 * the real server: discovery-less pairing by URL, registration → staff approval → token → realtime
 * connection, staff commands through the HTTP API, replay protection, local session expiry and
 * revocation → automatic re-registration. Browser APIs the agent needs are shimmed for Node.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  LoginResponse,
  SessionEventSummary,
  SessionMutationResponse,
  StationDeviceSummary,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, sleep, type TestContext } from '../helpers.js';
import { SERVER_VERSION } from '../../src/version.js';

// The client package targets the DOM; the server tsconfig does not. The real agent module is
// loaded through a non-literal dynamic import so only this structural view of it is type-checked.
const AGENT_MODULE = fileURLToPath(
  new URL('../../../likapcs-client/src/lib/agent.ts', import.meta.url),
);
type AgentSnapshot = {
  phase: { phase: string };
  state: {
    mode: 'locked' | 'session' | 'free';
    session: { id: string; status: 'active' | 'paused' } | null;
    notice: { text: string } | null;
    station: { code: string; name: string } | null;
    businessName: string | null;
  };
  paired: boolean;
  machineId: string | null;
};
type ClientAgent = { start(): Promise<void>; stop(): void; getSnapshot(): AgentSnapshot };

function installBrowserShims(origin: string): void {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  Object.assign(globalThis, {
    window: { localStorage, location: { origin } },
    document: { documentElement: { dataset: {} as Record<string, string> } },
    WebSocket,
  });
  if (!('navigator' in globalThis))
    Object.assign(globalThis, { navigator: { userAgent: 'node-test' } });
}

async function waitFor<T>(
  read: () => T | null | undefined | false,
  timeoutMs = 10_000,
  label = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('LIKApcs-Client agent ↔ server', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let baseUrl: string;
  let station: StationSummary;
  let agent: ClientAgent;
  const snap = (): AgentSnapshot => agent.getSnapshot();

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    installBrowserShims(baseUrl);
    vi.stubEnv('VITE_APP_VERSION', SERVER_VERSION);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/stations',
      headers: authHeader(owner.token),
      payload: { number: 7, name: 'VIP 7' },
    });
    station = created.json<StationSummary>();
    agent = ((await import(/* @vite-ignore */ AGENT_MODULE)) as { agent: ClientAgent }).agent;
  }, 30_000);

  afterAll(async () => {
    agent.stop();
    await ctx.close();
    vi.unstubAllEnvs();
  });

  it('registers, waits for approval, collects the token once and comes online locked', async () => {
    await agent.start();
    await waitFor(
      () => snap().phase.phase === 'registering' && snap().phase,
      10_000,
      'registering',
    );
    expect(snap().paired).toBe(false);
    expect(snap().machineId).toMatch(/^[0-9a-f]{64}$/);
    expect(
      (
        globalThis as unknown as {
          document: { documentElement: { dataset: Record<string, string> } };
        }
      ).document.documentElement.dataset.mode,
    ).toBe('locked');

    const pending = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/devices?status=pending',
      headers: authHeader(owner.token),
    });
    const device = pending
      .json<StationDeviceSummary[]>()
      .find((d) => d.machineId === snap().machineId);
    expect(device).toBeDefined();
    expect(device!.hostname).toBe('browser-dev');

    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${device!.id}/approve`,
      headers: authHeader(owner.token),
      payload: { stationId: station.id },
    });
    expect(approve.statusCode).toBe(200);

    await waitFor(() => snap().phase.phase === 'online', 15_000, 'online');
    expect(snap().paired).toBe(true);
    expect(snap().state.mode).toBe('locked');
    expect(snap().state.station).toMatchObject({ code: 'PC 07', name: 'VIP 7' });
    expect(snap().state.businessName).toBe('Test Arena');
    await waitFor(() => ctx.app.hub.isDeviceOnline(device!.id), 5000, 'hub presence');
  }, 40_000);

  it('executes staff commands sent through the API and acknowledges exactly once', async () => {
    const message = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/stations/${station.id}/command`,
      headers: authHeader(owner.token),
      payload: { command: 'message.show', text: 'Closing in 15 minutes', durationSeconds: 5 },
    });
    expect(message.statusCode).toBe(200);
    expect(message.json()).toMatchObject({ ok: true });
    expect(snap().state.notice?.text).toBe('Closing in 15 minutes');

    const unlock = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/stations/${station.id}/command`,
      headers: authHeader(owner.token),
      payload: { command: 'unlock' },
    });
    expect(unlock.json()).toMatchObject({ ok: true });
    expect(snap().state.mode).toBe('free');

    const lock = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/stations/${station.id}/command`,
      headers: authHeader(owner.token),
      payload: { command: 'lock' },
    });
    expect(lock.json()).toMatchObject({ ok: true });
    expect(snap().state.mode).toBe('locked');
  });

  it('rejects replayed and expired commands and reports inconsistent ones', async () => {
    const presence = ctx.app.hub.listDevices().find((d) => d.stationId === station.id)!;
    // Replay: same commandId twice → the second is silently ignored (already acked once).
    const commandId = randomUUID();
    const first = await ctx.app.hub.sendCommand(presence.deviceId, 'unlock', {}, { commandId });
    expect(first.ok).toBe(true);
    const replay = await ctx.app.hub.sendCommand(
      presence.deviceId,
      'unlock',
      {},
      { commandId, timeoutMs: 1500 },
    );
    expect(replay.ok).toBe(false);
    expect(replay.error).toBe('acknowledgement timeout');
    // Expired on arrival (negative ttl) → acked with ok=false, error 'expired'.
    const expired = await ctx.app.hub.sendCommand(presence.deviceId, 'lock', {}, { ttlMs: -5000 });
    expect(expired).toMatchObject({ ok: false, error: 'expired' });
    expect(snap().state.mode).toBe('free'); // the expired lock was not applied
    // Inconsistent: pausing a session that does not exist.
    const pause = await ctx.app.hub.sendCommand(presence.deviceId, 'session.pause', {
      sessionId: randomUUID(),
    });
    expect(pause).toMatchObject({ ok: false, error: 'no matching session' });
    const relock = await ctx.app.hub.sendCommand(presence.deviceId, 'lock', {});
    expect(relock.ok).toBe(true);
  });

  it('mirrors sessions started through the API: PC enters session mode, pause/end follow, acks are recorded', async () => {
    const start = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeader(owner.token),
      payload: { stationId: station.id, billingMode: 'postpaid', customerName: 'Walk-in' },
    });
    expect(start.statusCode).toBe(201);
    const { session, client } = start.json<SessionMutationResponse>();
    expect(client).toMatchObject({ ok: true, command: 'session.start' });
    expect(snap().state.mode).toBe('session');
    expect(snap().state.session?.id).toBe(session.id);

    const paused = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/pause`,
      headers: authHeader(owner.token),
    });
    expect(paused.json<SessionMutationResponse>().client).toMatchObject({
      ok: true,
      command: 'session.pause',
    });
    expect(snap().state.session?.status).toBe('paused');

    const ended = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/end`,
      headers: authHeader(owner.token),
      payload: {},
    });
    expect(ended.statusCode).toBe(200);
    expect(ended.json<SessionMutationResponse>().client).toMatchObject({
      ok: true,
      command: 'session.end',
    });
    expect(snap().state.mode).toBe('locked');
    expect(snap().state.session).toBeNull();

    const events = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/events`,
      headers: authHeader(owner.token),
    });
    const acks = events.json<SessionEventSummary[]>().filter((e) => e.eventType === 'client_ack');
    expect(acks.map((e) => e.payload.command)).toEqual([
      'session.start',
      'session.pause',
      'session.end',
    ]);
  });

  it('locks itself locally when a prepaid session runs out before the server confirms it', async () => {
    const presence = ctx.app.hub.listDevices().find((d) => d.stationId === station.id)!;
    const sessionId = randomUUID();
    const start = await ctx.app.hub.sendCommand(presence.deviceId, 'session.start', {
      sessionId,
      startedAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 1500).toISOString(),
    });
    expect(start.ok).toBe(true);
    expect(snap().state.mode).toBe('session');
    await waitFor(() => snap().state.mode === 'locked', 6000, 'local expiry lock');
    expect(snap().state.session).toBeNull();
  });

  it('recovers on its own after staff re-issue the device token', async () => {
    const presence = ctx.app.hub.listDevices().find((d) => d.stationId === station.id)!;
    const reissue = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${presence.deviceId}/reissue-token`,
      headers: authHeader(owner.token),
    });
    expect(reissue.statusCode).toBe(200);
    // Socket closed with 4005 → token dropped → re-registration → the new token is collected once
    // → a fresh connection (locally this takes a few milliseconds, so compare connection times).
    await waitFor(
      () =>
        ctx.app.hub
          .listDevices()
          .find(
            (d) =>
              d.deviceId === presence.deviceId &&
              d.connectedAt.getTime() > presence.connectedAt.getTime(),
          ) ?? null,
      20_000,
      'reconnection with the re-issued token',
    );
    await waitFor(() => snap().phase.phase === 'online' || null, 5000, 'phase online');
    expect(snap().state.mode).toBe('locked');
    expect(snap().state.station?.code).toBe('PC 07');
    const tokenState = await ctx.pool.query<{ collected: boolean }>(
      'SELECT token_collected_at IS NOT NULL AS collected FROM station_devices WHERE id = $1',
      [presence.deviceId],
    );
    expect(tokenState.rows[0]?.collected).toBe(true);
  }, 40_000);

  it('re-registers automatically after staff revoke the device', async () => {
    const presence = ctx.app.hub.listDevices().find((d) => d.stationId === station.id)!;
    const revoke = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/devices/${presence.deviceId}/revoke`,
      headers: authHeader(owner.token),
    });
    expect(revoke.statusCode).toBe(200);
    await waitFor(() => snap().phase.phase === 'registering', 15_000, 're-registration');
    expect(snap().paired).toBe(false);
    expect(snap().state.mode).toBe('locked');
    const pending = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/devices?status=pending',
      headers: authHeader(owner.token),
    });
    expect(
      pending.json<StationDeviceSummary[]>().some((d) => d.machineId === snap().machineId),
    ).toBe(true);
  }, 30_000);
});
