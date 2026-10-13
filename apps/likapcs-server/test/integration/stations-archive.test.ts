import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  type LoginResponse,
  type RegisterDeviceResponse,
  type RegistrationPollResponse,
  type SessionMutationResponse,
  type StationDeviceSummary,
  type StationSummary,
} from '@likapcs/shared';
import { SERVER_VERSION } from '../../src/version.js';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

/**
 * Archive PC (0.17.0): a station can leave the floor without losing its money history. Archiving
 * revokes the PC (so it must be paired again — as new, or under another name) and keeps the
 * reason; deleting stays honest (only while nothing was ever billed on it) and also needs one.
 */
describe('Archive PC / delete with a reason', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let pc1: StationSummary;
  let pc2: StationSummary;
  let device1: StationDeviceSummary;

  type Err = { error?: { code: string; message: string } };
  const call = <T>(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    ctx.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: authHeader(owner.token),
        payload: payload === undefined ? undefined : (payload as Record<string, unknown>),
      })
      .then((r) => ({ status: r.statusCode, body: r.body ? (r.json<T>() as T) : (null as T) }));

  const list = (includeArchived = false) =>
    call<StationSummary[]>(
      'GET',
      `/stations${includeArchived ? '?includeArchived=true' : ''}`,
    ).then((r) => r.body);

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    pc1 = (await call<StationSummary>('POST', '/stations', { number: 1, name: 'PC 1' })).body;
    pc2 = (await call<StationSummary>('POST', '/stations', { number: 2, name: 'PC 2' })).body;
    expect(
      (
        await call('POST', '/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 150,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);

    // A paired PC on station 1 (no socket needed: revoke is about the token, not the socket).
    const registrationSecret = randomBytes(32).toString('base64url');
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: {
        machineId: 'MACHINE-ARCHIVE-1',
        hostname: 'pc1',
        appVersion: SERVER_VERSION,
        registrationSecret,
      },
    });
    const { registrationId } = reg.json<RegisterDeviceResponse>();
    expect(
      (await call('POST', `/devices/${registrationId}/approve`, { stationId: pc1.id })).status,
    ).toBe(200);
    const poll = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/client/registration/${registrationId}?secret=${registrationSecret}`,
    });
    expect(poll.json<RegistrationPollResponse>().deviceToken).toBeTruthy();
    device1 = (await list()).find((s) => s.id === pc1.id)!.device!;
    expect(device1.status).toBe('approved');
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('needs a reason, then takes the station off the floor and revokes its PC', async () => {
    const noReason = await call('POST', `/stations/${pc1.id}/archive`, {});
    expect(noReason.status).toBe(400);

    const archived = await call<StationSummary & Err>('POST', `/stations/${pc1.id}/archive`, {
      reason: 'PC moved to the new hall — re-register as PC 07',
    });
    expect(archived.status).toBe(200);
    expect(archived.body.archived).toMatchObject({
      reason: 'PC moved to the new hall — re-register as PC 07',
    });

    // Off the floor by default, visible with the toggle, PC revoked and pairable again.
    expect((await list()).map((s) => s.id)).not.toContain(pc1.id);
    // The Admin sends includeArchived=false as a string: Boolean('false') is true, so the flag
    // must be parsed by hand or archived stations leak back onto the floor.
    expect(
      (await call<StationSummary[]>('GET', '/stations?includeArchived=false')).body.map(
        (s) => s.id,
      ),
    ).not.toContain(pc1.id);
    const withArchived = await list(true);
    expect(withArchived.map((s) => s.id)).toContain(pc1.id);
    expect(withArchived.find((s) => s.id === pc1.id)?.archived?.at).toBeTruthy();
    const devices = await call<StationDeviceSummary[]>('GET', '/devices?status=revoked');
    expect(devices.body.map((d) => d.id)).toContain(device1.id);

    const twice = await call<Err>('POST', `/stations/${pc1.id}/archive`, { reason: 'again' });
    expect(twice.status).toBe(409);
  });

  it('puts the station back on the floor with unarchive', async () => {
    const back = await call<StationSummary>('POST', `/stations/${pc1.id}/unarchive`, {});
    expect(back.status).toBe(200);
    expect(back.body.archived).toBeNull();
    expect((await list()).map((s) => s.id)).toContain(pc1.id);
    const notArchived = await call<Err>('POST', `/stations/${pc1.id}/unarchive`, {});
    expect(notArchived.status).toBe(409);
  });

  it('refuses to archive a PC with a running session', async () => {
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: pc2.id,
      billingMode: 'postpaid',
    });
    expect(started.status).toBe(201);
    const refused = await call<Err>('POST', `/stations/${pc2.id}/archive`, { reason: 'broken PC' });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.message).toMatch(/session/i);
    // …but the history it leaves behind is exactly why delete stays closed for it.
    const cancelled = await call<SessionMutationResponse>(
      'POST',
      `/sessions/${started.body.session.id}/cancel`,
      { reason: 'archive test' },
    );
    expect(cancelled.status).toBe(200);
  });

  it('deletes only with a reason and only without session history', async () => {
    const noReason = await call<Err>('DELETE', `/stations/${pc2.id}`, {});
    expect(noReason.status).toBe(400);

    const withHistory = await call<Err>('DELETE', `/stations/${pc2.id}`, {
      reason: 'taken out of service',
    });
    expect(withHistory.status).toBe(409);
    expect(withHistory.body.error?.message).toMatch(/Archive/);

    const fresh = (await call<StationSummary>('POST', '/stations', { number: 9, name: 'Spare' }))
      .body;
    expect((await call('DELETE', `/stations/${fresh.id}`, { reason: 'never used' })).status).toBe(
      204,
    );
    expect((await list(true)).map((s) => s.id)).not.toContain(fresh.id);
  });

  it('keeps every reason in the audit log', async () => {
    const rows = await ctx.pool.query<{ action: string; details: { reason?: string } }>(
      `SELECT action, details FROM audit_logs
        WHERE action IN ('station.archive', 'station.unarchive', 'station.delete') ORDER BY id`,
    );
    const actions = rows.rows.map((r) => r.action);
    expect(actions).toEqual(['station.archive', 'station.unarchive', 'station.delete']);
    expect(rows.rows[0]!.details.reason).toMatch(/re-register as PC 07/);
    expect(rows.rows[2]!.details.reason).toBe('never used');
  });
});
