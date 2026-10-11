import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoginResponse, Paginated, RoleSummary, UserSummary } from '@likapcs/shared';
import { authHeader, createTestContext, login, runSetup, type TestContext } from '../helpers.js';

describe('employees, roles and permission enforcement', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let manager: LoginResponse;
  let cashier: LoginResponse;
  let cashierId: string;

  const createUser = (token: string, payload: Record<string, unknown>) =>
    ctx.app.inject({ method: 'POST', url: '/api/v1/users', headers: authHeader(token), payload });

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('lists the six system roles with their permissions', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/roles',
      headers: authHeader(owner.token),
    });
    expect(res.statusCode).toBe(200);
    const roles = res.json<RoleSummary[]>();
    expect(roles.map((r) => r.code)).toEqual([
      'owner',
      'admin',
      'manager',
      'accountant',
      'cashier',
      'inventory',
    ]);
    expect(roles.find((r) => r.code === 'cashier')!.permissions).toContain('pos.sell');
  });

  it('owner creates a manager and a cashier', async () => {
    const m = await createUser(owner.token, {
      username: 'manager',
      fullName: 'Mira Manager',
      password: 'Manager123',
      roles: ['manager'],
      mustChangePassword: false,
    });
    expect(m.statusCode).toBe(201);
    const c = await createUser(owner.token, {
      username: 'cashier',
      fullName: 'Kai Cashier',
      password: 'Cashier123',
      roles: ['cashier'],
      mustChangePassword: false,
    });
    expect(c.statusCode).toBe(201);
    cashierId = c.json<UserSummary>().id;
    manager = await login(ctx.app, 'manager', 'Manager123');
    cashier = await login(ctx.app, 'cashier', 'Cashier123');
    expect(cashier.user.permissions).not.toContain('users.view');
  });

  it('rejects duplicate usernames (case-insensitive) and unknown roles', async () => {
    const dup = await createUser(owner.token, {
      username: 'CASHIER',
      fullName: 'Dup',
      password: 'Dup12345',
      roles: ['cashier'],
    });
    expect(dup.statusCode).toBe(409);
    const bad = await createUser(owner.token, {
      username: 'weird',
      fullName: 'W',
      password: 'Weird1234',
      roles: ['superuser'],
    });
    expect(bad.statusCode).toBe(400);
  });

  it('a cashier can neither list nor create employees', async () => {
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: authHeader(cashier.token),
    });
    expect(list.statusCode).toBe(403);
    const create = await createUser(cashier.token, {
      username: 'x1',
      fullName: 'X',
      password: 'Xpass1234',
      roles: ['cashier'],
    });
    expect(create.statusCode).toBe(403);
  });

  it('a manager can view employees but has no users.manage permission', async () => {
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/users',
      headers: authHeader(manager.token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<Paginated<UserSummary>>().total).toBe(3);
    const create = await createUser(manager.token, {
      username: 'x2',
      fullName: 'X',
      password: 'Xpass1234',
      roles: ['cashier'],
    });
    expect(create.statusCode).toBe(403);
  });

  it('an admin cannot create or edit owners (privilege escalation guard)', async () => {
    await createUser(owner.token, {
      username: 'admin1',
      fullName: 'Ada Admin',
      password: 'Admin1234',
      roles: ['admin'],
      mustChangePassword: false,
    });
    const admin = await login(ctx.app, 'admin1', 'Admin1234');
    const asOwner = await createUser(admin.token, {
      username: 'owner2',
      fullName: 'O2',
      password: 'Owner2345',
      roles: ['owner'],
    });
    expect(asOwner.statusCode).toBe(403);
    const asAdmin = await createUser(admin.token, {
      username: 'admin2',
      fullName: 'A2',
      password: 'Admin2345',
      roles: ['admin'],
    });
    expect(asAdmin.statusCode).toBe(403);
    const asManager = await createUser(admin.token, {
      username: 'manager2',
      fullName: 'M2',
      password: 'Manag2345',
      roles: ['manager'],
    });
    expect(asManager.statusCode).toBe(201);
    const editOwner = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${owner.user.id}`,
      headers: authHeader(admin.token),
      payload: { isActive: false },
    });
    expect(editOwner.statusCode).toBe(403);
  });

  it('nobody can deactivate themselves or remove the last owner', async () => {
    const self = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${owner.user.id}`,
      headers: authHeader(owner.token),
      payload: { isActive: false },
    });
    expect(self.statusCode).toBe(403);
    const demote = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${owner.user.id}`,
      headers: authHeader(owner.token),
      payload: { roles: ['admin'] },
    });
    expect(demote.statusCode).toBe(403); // own roles cannot be changed at all
  });

  it('deactivating a user revokes their sessions immediately', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${cashierId}`,
      headers: authHeader(owner.token),
      payload: { isActive: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<UserSummary>().isActive).toBe(false);
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader(cashier.token),
    });
    expect(me.statusCode).toBe(401);
    const relogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'cashier', password: 'Cashier123' },
    });
    expect(relogin.statusCode).toBe(401);
  });

  it('password reset by an administrator forces a new password and kills sessions', async () => {
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${cashierId}`,
      headers: authHeader(owner.token),
      payload: { isActive: true },
    });
    const s1 = await login(ctx.app, 'cashier', 'Cashier123');
    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/users/${cashierId}/reset-password`,
      headers: authHeader(owner.token),
      payload: { newPassword: 'Temp12345', mustChangePassword: true },
    });
    expect(reset.statusCode).toBe(204);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers: authHeader(s1.token),
        })
      ).statusCode,
    ).toBe(401);
    const s2 = await login(ctx.app, 'cashier', 'Temp12345');
    expect(s2.user.mustChangePassword).toBe(true);
  });

  it('owner can hide the dashboard from cashiers by editing the role permissions', async () => {
    const perms = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/permissions',
      headers: authHeader(owner.token),
    });
    expect(perms.statusCode).toBe(200);
    expect(perms.json<{ code: string }[]>().map((p) => p.code)).toContain('dashboard.view');

    const roles = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/roles',
        headers: authHeader(owner.token),
      })
    ).json<RoleSummary[]>();
    const cashierRole = roles.find((r) => r.code === 'cashier')!;
    expect(cashierRole.permissions).toContain('dashboard.view');

    // The cashier currently sees the dashboard summary.
    const kai = await login(ctx.app, 'cashier', 'Temp12345');
    const before = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/summary',
      headers: authHeader(kai.token),
    });
    expect(before.statusCode).toBe(200);

    const updated = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/roles/${cashierRole.id}/permissions`,
      headers: authHeader(owner.token),
      payload: { permissions: cashierRole.permissions.filter((p) => p !== 'dashboard.view') },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<RoleSummary>().permissions).not.toContain('dashboard.view');

    // Takes effect immediately for the signed-in cashier (permissions are resolved per request).
    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/summary',
      headers: authHeader(kai.token),
    });
    expect(after.statusCode).toBe(403);
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeader(kai.token),
    });
    expect(me.json<{ permissions: string[] }>().permissions).not.toContain('dashboard.view');

    // Unknown codes are rejected; the change was audited.
    const bad = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/roles/${cashierRole.id}/permissions`,
      headers: authHeader(owner.token),
      payload: { permissions: ['pos.sell', 'does.not.exist'] },
    });
    expect(bad.statusCode).toBe(400);
    const audit = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs?action=role.permissions_update',
      headers: authHeader(owner.token),
    });
    const entries = audit.json<Paginated<{ action: string; details: Record<string, unknown> }>>();
    expect(entries.items[0]?.details).toMatchObject({
      role: 'cashier',
      removed: ['dashboard.view'],
    });
  });

  it('role permissions cannot be escalated or edited for the owner role', async () => {
    const roles = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/roles',
        headers: authHeader(owner.token),
      })
    ).json<RoleSummary[]>();
    const byCode = (code: string) => roles.find((r) => r.code === code)!;
    const admin = await login(ctx.app, 'admin1', 'Admin1234');
    const put = (token: string, roleId: string, permissions: string[]) =>
      ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/roles/${roleId}/permissions`,
        headers: authHeader(token),
        payload: { permissions },
      });
    // Owner role is immutable (recovery path).
    expect((await put(owner.token, byCode('owner').id, ['pos.sell'])).statusCode).toBe(403);
    // An admin cannot edit a role of equal power (admin) …
    expect((await put(admin.token, byCode('admin').id, ['pos.sell'])).statusCode).toBe(403);
    // … but may edit the manager role, as long as they only grant what they hold themselves.
    expect(
      (await put(admin.token, byCode('manager').id, byCode('manager').permissions)).statusCode,
    ).toBe(200);
    // A manager has users.view but not users.manage → cannot touch roles at all.
    expect((await put(manager.token, byCode('cashier').id, ['pos.sell'])).statusCode).toBe(403);
    // A cashier cannot even list permissions.
    const kai = await login(ctx.app, 'cashier', 'Temp12345');
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/permissions',
          headers: authHeader(kai.token),
        })
      ).statusCode,
    ).toBe(403);
    // Restore the cashier dashboard for the remaining tests.
    expect(
      (
        await put(owner.token, byCode('cashier').id, [
          ...byCode('cashier').permissions,
          'dashboard.view',
        ])
      ).statusCode,
    ).toBe(200);
  });

  it('records every staff change in the audit log', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs?action=user.',
      headers: authHeader(owner.token),
    });
    expect(res.statusCode).toBe(200);
    const actions = res.json<Paginated<{ action: string }>>().items.map((i) => i.action);
    expect(actions).toEqual(
      expect.arrayContaining(['user.create', 'user.update', 'user.password_reset']),
    );
    const denied = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs',
      headers: authHeader(manager.token),
    });
    expect(denied.statusCode).toBe(200); // manager has audit.view
    const cashierDenied = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs',
      headers: authHeader((await login(ctx.app, 'cashier', 'Temp12345')).token),
    });
    expect(cashierDenied.statusCode).toBe(403);
  });
});
