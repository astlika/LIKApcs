import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoginResponse, UserPreferences } from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

describe('phone display preferences (per account)', () => {
  let ctx: TestContext;
  let owner: LoginResponse;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app, 'Preferenca Test');
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('returns the defaults until the account saves something', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/preferences', headers: authHeader(owner.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json<UserPreferences>()).toEqual({ theme: 'dark', textSize: 'normal', language: 'sq', stationsView: 'grid' });
  });

  it('saves a partial change and keeps the other fields', async () => {
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/auth/preferences',
      headers: authHeader(owner.token),
      payload: { theme: 'light' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<UserPreferences>()).toEqual({ theme: 'light', textSize: 'normal', language: 'sq', stationsView: 'grid' });

    const again = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/preferences', headers: authHeader(owner.token) });
    expect(again.json<UserPreferences>()).toEqual({ theme: 'light', textSize: 'normal', language: 'sq', stationsView: 'grid' });
  });

  it('refuses unknown values', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/auth/preferences',
      headers: authHeader(owner.token),
      payload: { theme: 'neon' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('needs a signed-in user', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/preferences' });
    expect(res.statusCode).toBe(401);
  });
});
