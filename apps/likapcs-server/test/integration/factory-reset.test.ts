/**
 * Factory reset (Settings → Security, `POST /system/factory-reset`). Owner only, re-checks the
 * signed-in account's username and password, needs `confirm: true`, and takes a safety backup
 * before anything is erased. Afterwards every business record, user and uploaded picture is gone,
 * the backup folder keeps the safety copy, and the system asks for first-run setup again.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoginResponse, StationSummary } from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

describe('factory reset', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let root: string;
  const H = () => authHeader(owner.token);

  const count = async (table: string) => {
    const { rows } = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table}`,
    );
    return Number(rows[0]!.n);
  };
  const reset = (payload: Record<string, unknown>, token = owner.token) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/v1/system/factory-reset',
      headers: authHeader(token),
      payload,
    });

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'likapcs-reset-'));
    ctx = await createTestContext({
      uploadDir: path.join(root, 'uploads'),
      backupDir: path.join(root, 'backups'),
    });
    owner = await runSetup(ctx.app);
    const station = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/stations',
      headers: H(),
      payload: { number: 1, name: 'PC 1' },
    });
    expect(station.statusCode).toBe(201);
    expect(station.json<StationSummary>().code).toBe('PC 01');
    const products = path.join(root, 'uploads', 'products');
    fs.mkdirSync(products, { recursive: true });
    fs.writeFileSync(path.join(products, 'item.jpg'), 'not really a picture');
    // A unit the shop added itself (built-in units have is_system = true).
    await ctx.pool.query(
      `INSERT INTO units_of_measure (code, name_en, name_sq, is_decimal, is_system)
       VALUES ('box', 'Box', 'Kuti', false, false)`,
    );
  });

  afterAll(async () => {
    await ctx.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses a wrong password and keeps everything', async () => {
    const res = await reset({ username: 'owner', password: 'Wrong12345', confirm: true });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('PASSWORD_MISMATCH');
    expect(await count('stations')).toBe(1);
    expect(await count('users')).toBe(1);
  });

  it('refuses a username that is not the signed-in account', async () => {
    const res = await reset({ username: 'someone', password: 'Owner12345', confirm: true });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('USERNAME_MISMATCH');
    expect(await count('stations')).toBe(1);
  });

  it('needs the explicit confirmation', async () => {
    const res = await reset({ username: 'owner', password: 'Owner12345' });
    expect(res.statusCode).toBe(400);
    expect(await count('stations')).toBe(1);
  });

  it('needs a signed-in session', async () => {
    const res = await reset({ username: 'owner', password: 'Owner12345', confirm: true }, 'bogus');
    expect(res.statusCode).toBe(401);
    expect(await count('stations')).toBe(1);
  });

  it('erases everything after a safety backup, and asks for first-run setup again', async () => {
    const res = await reset({ username: 'owner', password: 'Owner12345', confirm: true });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ preResetBackupId: string; tablesErased: number }>();
    expect(body.tablesErased).toBeGreaterThan(10);

    // Business data and accounts are gone.
    expect(await count('stations')).toBe(0);
    expect(await count('users')).toBe(0);
    expect(await count('sales')).toBe(0);
    expect(await count('user_sessions')).toBe(0);
    expect(await count('audit_logs')).toBe(0);

    // System configuration stays so that first-run setup works again: roles, permissions,
    // built-in units; user-made units are gone. A fresh install's register and settings return.
    expect(await count('roles')).toBeGreaterThan(0);
    expect(await count('role_permissions')).toBeGreaterThan(0);
    expect(await count('units_of_measure')).toBeGreaterThan(0);
    const { rows: userUnits } = await ctx.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM units_of_measure WHERE is_system IS NOT TRUE',
    );
    expect(Number(userUnits[0]!.n)).toBe(0);
    expect(await count('cash_registers')).toBe(1);
    expect(await count('settings')).toBeGreaterThan(0);

    // The safety backup survives: listed as `pre_reset`, succeeded, and its archive is on disk.
    const { rows } = await ctx.pool.query<{ kind: string; status: string; file_path: string }>(
      'SELECT kind, status, file_path FROM backup_history WHERE id = $1',
      [body.preResetBackupId],
    );
    expect(rows[0]?.kind).toBe('pre_reset');
    expect(rows[0]?.status).toBe('succeeded');
    expect(fs.existsSync(rows[0]!.file_path)).toBe(true);

    // Uploaded pictures are erased; the folders themselves remain for the next uploads.
    expect(fs.existsSync(path.join(root, 'uploads', 'products', 'item.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'uploads', 'products'))).toBe(true);

    // The old session no longer works, and the system needs setup.
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: H() });
    expect(me.statusCode).toBe(401);
    const status = await ctx.app.inject({ method: 'GET', url: '/api/v1/system/setup-status' });
    expect(status.json<{ needsSetup: boolean }>().needsSetup).toBe(true);
  });

  it('works again after first-run setup on the empty system', async () => {
    const fresh = await runSetup(ctx.app, 'Second Start');
    expect(fresh.user.roles).toContain('owner');
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader(fresh.token),
    });
    expect(me.statusCode).toBe(200);
    expect(await count('stations')).toBe(0);
    const status = await ctx.app.inject({ method: 'GET', url: '/api/v1/system/setup-status' });
    expect(status.json<{ needsSetup: boolean }>().needsSetup).toBe(false);
  });
});
