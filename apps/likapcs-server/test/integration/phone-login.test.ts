/**
 * 0.28.0 — phone (PWA) login: username + e-mail + password must all match. The normal login is
 * unchanged. Phone sessions are recorded with client_app = 'phone'.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoginResponse } from '@likapcs/shared';
import { createTestContext, OWNER, runSetup, type TestContext } from '../helpers.js';

describe('phone login (0.28.0)', () => {
  let ctx: TestContext;
  const EMAIL = 'pronari@example.com';

  const phone = (payload: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/auth/phone-login', payload });

  beforeAll(async () => {
    ctx = await createTestContext();
    await runSetup(ctx.app);
    await ctx.pool.query(`UPDATE users SET email = $1 WHERE lower(username) = 'owner'`, [EMAIL]);
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('accepts username + e-mail + password and records a phone session', async () => {
    const res = await phone({ username: OWNER.username, email: EMAIL, password: OWNER.password });
    expect(res.statusCode).toBe(200);
    const body = res.json<LoginResponse>();
    expect(body.token).toBeTruthy();
    const { rows } = await ctx.pool.query<{ client_app: string }>(
      'SELECT client_app FROM user_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [body.user.id],
    );
    expect(rows[0]?.client_app).toBe('phone');
  });

  it('e-mail is matched case-insensitively and trimmed', async () => {
    const res = await phone({
      username: OWNER.username,
      email: `  ${EMAIL.toUpperCase()} `,
      password: OWNER.password,
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a wrong e-mail even with the right password, with the same message', async () => {
    const res = await phone({
      username: OWNER.username,
      email: 'tjeter@example.com',
      password: OWNER.password,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { message: string } }>().error.message).toBe(
      'Invalid username or password',
    );
    const audit = await ctx.pool.query(
      `SELECT 1 FROM audit_logs WHERE action = 'auth.login_failed' AND details->>'reason' = 'email_mismatch'`,
    );
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it('refuses a wrong password with the right e-mail', async () => {
    const res = await phone({ username: OWNER.username, email: EMAIL, password: 'nuk-eshte-ky' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an account that has no e-mail', async () => {
    await ctx.pool.query(`UPDATE users SET email = NULL WHERE lower(username) = 'owner'`);
    const res = await phone({ username: OWNER.username, email: EMAIL, password: OWNER.password });
    expect(res.statusCode).toBe(401);
    await ctx.pool.query(`UPDATE users SET email = $1 WHERE lower(username) = 'owner'`, [EMAIL]);
  });

  it('the normal login still works without an e-mail', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: OWNER.username, password: OWNER.password },
    });
    expect(res.statusCode).toBe(200);
  });
  it('answers 423 while the account is locked, even with the right e-mail and password', async () => {
    await ctx.pool.query(
      `UPDATE users SET locked_until = now() + interval '10 minutes' WHERE lower(username) = 'owner'`,
    );
    try {
      const res = await phone({ username: OWNER.username, email: EMAIL, password: OWNER.password });
      expect(res.statusCode).toBe(423);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('account_locked');
    } finally {
      await ctx.pool.query(`UPDATE users SET locked_until = NULL WHERE lower(username) = 'owner'`);
    }
  });
});
