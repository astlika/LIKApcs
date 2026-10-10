import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthenticatedUser, LoginResponse, SetupStatusResponse } from '@likapcs/shared';
import {
  OWNER,
  authHeader,
  createTestContext,
  login,
  runSetup,
  type TestContext,
} from '../helpers.js';

describe('first-run setup and authentication', () => {
  let ctx: TestContext;
  let session: LoginResponse;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('reports that setup is required on a fresh database', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/system/setup-status' });
    expect(res.statusCode).toBe(200);
    expect(res.json<SetupStatusResponse>().needsSetup).toBe(true);
  });

  it('rejects weak owner passwords', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/system/setup',
      payload: { businessName: 'X', owner: { ...OWNER, password: '123' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('creates the owner, stores the business name and returns a session', async () => {
    session = await runSetup(ctx.app, 'Arena Mitrovica');
    expect(session.token).toHaveLength(43);
    expect(session.user.roles).toEqual(['owner']);
    expect(session.user.permissions).toContain('users.manage');

    const status = await ctx.app.inject({ method: 'GET', url: '/api/v1/system/setup-status' });
    expect(status.json<SetupStatusResponse>()).toMatchObject({
      needsSetup: false,
      businessName: 'Arena Mitrovica',
    });

    const hashes = await ctx.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users',
    );
    expect(hashes.rows[0]!.password_hash).not.toContain(OWNER.password);
    expect(hashes.rows[0]!.password_hash.startsWith('scrypt$')).toBe(true);
  });

  it('refuses to run setup twice', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/system/setup',
      payload: {
        businessName: 'Evil',
        owner: { fullName: 'x', username: 'intruder', password: 'Intruder123' },
      },
    });
    expect(res.statusCode).toBe(409);
  });

  it('logs in with correct credentials and rejects wrong ones with the same message', async () => {
    const ok = await login(ctx.app, OWNER.username, OWNER.password);
    expect(ok.user.username).toBe('owner');
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'owner', password: 'nope-123' },
    });
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'ghost', password: 'nope-123' },
    });
    expect(bad.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(bad.json().error.message).toBe(unknown.json().error.message);
  });

  it('issues a long-lived session for "stay signed in" (default sessions are shift-length)', async () => {
    // `session` (from setup) is a regular login: lifetime = LIKAPCS_SESSION_HOURS.
    const hours = (iso: string) => (new Date(iso).getTime() - Date.now()) / 3_600_000;
    const regular = hours(session.expiresAt);
    expect(regular).toBeGreaterThan(ctx.config.sessionHours - 0.1);
    expect(regular).toBeLessThan(ctx.config.sessionHours + 0.1);

    const long = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: OWNER.username, password: OWNER.password, rememberMe: true },
    });
    expect(long.statusCode).toBe(200);
    const remembered = hours(long.json<LoginResponse>().expiresAt);
    expect(remembered).toBeGreaterThan(ctx.config.rememberDays * 24 - 0.1);
    expect(remembered).toBeLessThan(ctx.config.rememberDays * 24 + 0.1);
    expect(remembered).toBeGreaterThan(regular);

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader(long.json<LoginResponse>().token),
    });
    expect(me.statusCode).toBe(200);
  });

  it('protects endpoints and resolves the bearer token', async () => {
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(anon.statusCode).toBe(401);
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader(session.token),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<AuthenticatedUser>().username).toBe('owner');
    const forged = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader('x'.repeat(43)),
    });
    expect(forged.statusCode).toBe(401);
  });

  it('writes audit entries for logins and failures', async () => {
    const rows = await ctx.pool.query<{ action: string; severity: string }>(
      "SELECT action, severity FROM audit_logs WHERE action LIKE 'auth.%' ORDER BY id",
    );
    const actions = rows.rows.map((r) => r.action);
    expect(actions).toContain('auth.login');
    expect(actions).toContain('auth.login_failed');
  });

  it('locks the account after too many failed attempts', async () => {
    await ctx.pool.query(
      "UPDATE settings SET value = '3' WHERE key = 'security.max_failed_logins'",
    );
    ctx.app.services.settings.invalidate();
    for (let i = 0; i < 3; i += 1) {
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'owner', password: 'wrong-1' },
      });
    }
    const locked = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'owner', password: OWNER.password },
    });
    expect(locked.statusCode).toBe(423);
    expect(locked.json().error.code).toBe('account_locked');
    await ctx.pool.query('UPDATE users SET locked_until = NULL, failed_login_attempts = 0');
    const ok = await login(ctx.app, OWNER.username, OWNER.password);
    expect(ok.token).toBeTruthy();
  });

  it('changes the password, keeps the current session and revokes the others', async () => {
    const other = await login(ctx.app, OWNER.username, OWNER.password);
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: authHeader(session.token),
      payload: { currentPassword: 'incorrect-1', newPassword: 'NewOwner123' },
    });
    expect(wrong.statusCode).toBe(400);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: authHeader(session.token),
      payload: { currentPassword: OWNER.password, newPassword: 'NewOwner123' },
    });
    expect(res.statusCode).toBe(204);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers: authHeader(session.token),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers: authHeader(other.token),
        })
      ).statusCode,
    ).toBe(401);
    OWNER.password = 'NewOwner123';
  });

  it('logs out and invalidates the token', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: authHeader(session.token),
    });
    expect(res.statusCode).toBe(204);
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader(session.token),
    });
    expect(me.statusCode).toBe(401);
  });
});
