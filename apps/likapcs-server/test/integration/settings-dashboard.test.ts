import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DashboardSummary, LoginResponse, SettingsMap } from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

describe('settings and dashboard', () => {
  let ctx: TestContext;
  let owner: LoginResponse;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app, 'Neon Arena');
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('exposes only whitelisted settings publicly', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/settings/public' });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body['business.name']).toBe('Neon Arena');
    expect(body['locale.currency']).toBe('EUR');
    expect(body).not.toHaveProperty('security.session_hours');
  });

  it('returns the full settings map to authorised users and defaults to EUR / DD.MM.YYYY', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: authHeader(owner.token),
    });
    expect(res.statusCode).toBe(200);
    const settings = res.json<SettingsMap>();
    expect(settings['locale.currency']).toBe('EUR');
    expect(settings['locale.date_format']).toBe('DD.MM.YYYY');
    expect(settings['tax.default_rate_bp']).toBe(1800);
  });

  it('validates patches, persists them and audits the change', async () => {
    const bad = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: authHeader(owner.token),
      payload: { 'tax.default_rate_bp': 'eighteen' },
    });
    expect(bad.statusCode).toBe(400);
    const unknown = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: authHeader(owner.token),
      payload: { 'hack.me': true },
    });
    expect(unknown.statusCode).toBe(400);

    const ok = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: authHeader(owner.token),
      payload: {
        'business.phone': '+383 44 000 000',
        'locale.default_language': 'sq',
        'tax.default_rate_bp': 800,
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<SettingsMap>()['locale.default_language']).toBe('sq');

    const stored = await ctx.pool.query<{ value: unknown }>(
      "SELECT value FROM settings WHERE key = 'tax.default_rate_bp'",
    );
    expect(stored.rows[0]!.value).toBe(800);
    const audit = await ctx.pool.query<{ details: { changed: Record<string, unknown> } }>(
      "SELECT details FROM audit_logs WHERE action = 'settings.update' ORDER BY id DESC LIMIT 1",
    );
    expect(Object.keys(audit.rows[0]!.details.changed).sort()).toEqual([
      'business.phone',
      'locale.default_language',
      'tax.default_rate_bp',
    ]);
  });

  it('computes the dashboard from real tables (zero money, live station counts)', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/stations',
      headers: authHeader(owner.token),
      payload: { number: 1, name: 'PC 01' },
    });
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/stations',
      headers: authHeader(owner.token),
      payload: { number: 2, name: 'PC 02', isEnabled: false },
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/summary?date=2026-10-09',
      headers: authHeader(owner.token),
    });
    expect(res.statusCode).toBe(200);
    const s = res.json<DashboardSummary>();
    expect(s.date).toBe('2026-10-09');
    expect(s.revenue.totalCents).toBe(0);
    expect(s.grossProfitCents).toBe(0);
    expect(s.operatingProfitCents).toBe(0);
    expect(s.cashRegisterBalanceCents).toBeNull();
    expect(s.stations).toMatchObject({
      total: 2,
      enabled: 1,
      online: 0,
      offline: 1,
      available: 0,
      activeSessions: 0,
    });
    expect(s.recentAudit.length).toBeGreaterThan(0);
    const badDate = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/summary?date=09.10.2026',
      headers: authHeader(owner.token),
    });
    expect(badDate.statusCode).toBe(400);
  });

  it('health endpoint is public and reports schema version', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/system/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', database: 'ok', schemaVersion: 8 });
  });
});
