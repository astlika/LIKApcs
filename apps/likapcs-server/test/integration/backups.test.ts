/**
 * Phase 7 — backups & restore: consistent archive, download, upload, password-confirmed restore
 * that brings the data back while keeping the acting session and the backup history, scheduler.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BackupSummary,
  BackupsResponse,
  LoginResponse,
  ProductSummary,
  RestoreResult,
} from '@likapcs/shared';
import { readManifest } from '../../src/services/backups.js';
import {
  authHeader,
  createTestContext,
  login,
  OWNER,
  runSetup,
  type TestContext,
} from '../helpers.js';

describe('backups & restore', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let backupDir: string;
  let first: BackupSummary;
  let cola: ProductSummary;

  const call = <T>(
    token: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(token), payload })
      .then((r) => ({
        status: r.statusCode,
        body: (r.statusCode === 204 ? null : r.json()) as T,
        raw: r,
      }));

  beforeAll(async () => {
    backupDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-backups-'));
    ctx = await createTestContext({ backupDir });
    owner = await runSetup(ctx.app);
    cola = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Coca-Cola 0.5L',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 12_000,
      })
    ).body;
    await call(owner.token, 'POST', '/customers', { name: 'Arben Krasniqi', phone: '044' });
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    await fsp.rm(backupDir, { recursive: true, force: true });
  });

  it('writes a consistent archive with a manifest and records it', async () => {
    const created = await call<BackupSummary>(owner.token, 'POST', '/backups', {});
    expect(created.status).toBe(201);
    first = created.body;
    expect(first.kind).toBe('manual');
    expect(first.status).toBe('succeeded');
    expect(first.fileExists).toBe(true);
    expect(first.fileName).toMatch(/^likapcs-manual-\d{8}-\d{6}\.likapcs-backup\.tar\.gz$/);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.schemaVersion).toBe(ctx.app.schemaVersion);
    expect(first.sizeBytes).toBeGreaterThan(1000);
    const file = path.join(backupDir, first.fileName!);
    expect(fs.existsSync(file)).toBe(true);
    const manifest = await readManifest(file);
    expect(manifest.format).toBe('likapcs-backup');
    expect(manifest.schemaVersion).toBe(ctx.app.schemaVersion);
    const products = manifest.tables.find((t) => t.name === 'products');
    expect(products?.rows).toBe(1);
    expect(manifest.tables.find((t) => t.name === 'customers')?.rows).toBe(1);
    expect(manifest.tables.length).toBeGreaterThan(30);

    const list = await call<BackupsResponse>(owner.token, 'GET', '/backups');
    expect(list.body.directory).toBe(backupDir);
    expect(list.body.items.map((b) => b.id)).toEqual([first.id]);
    expect(list.body.schedule.enabled).toBe(true);
    expect(list.body.schedule.time).toBe('04:00');
    expect(list.body.schedule.nextRunAt).not.toBeNull();
  });

  it('downloads the archive and re-imports it under a new name', async () => {
    const download = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/backups/${first.id}/download`,
      headers: authHeader(owner.token),
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/gzip');
    expect(download.headers['content-disposition']).toContain(first.fileName);
    expect(download.rawPayload.length).toBe(first.sizeBytes);

    const upload = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backups/upload?fileName=from-usb-stick',
      headers: { ...authHeader(owner.token), 'content-type': 'application/octet-stream' },
      payload: download.rawPayload,
    });
    expect(upload.statusCode).toBe(201);
    const imported = upload.json() as BackupSummary;
    expect(imported.fileName).toBe('from-usb-stick.likapcs-backup.tar.gz');
    expect(imported.sha256).toBe(first.sha256);
    expect(imported.schemaVersion).toBe(ctx.app.schemaVersion);

    const garbage = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backups/upload?fileName=not-a-backup',
      headers: { ...authHeader(owner.token), 'content-type': 'application/octet-stream' },
      payload: Buffer.from('definitely not a tarball'),
    });
    expect(garbage.statusCode).toBe(400);
    expect(fs.existsSync(path.join(backupDir, 'not-a-backup.likapcs-backup.tar.gz'))).toBe(false);
  });

  it('restores only after the password is re-confirmed, keeps the session and the history', async () => {
    // Changes made after the backup — these must disappear.
    const late = await call<ProductSummary>(owner.token, 'POST', '/products', {
      name: 'Added after backup',
      sellingPriceCents: 100,
    });
    expect(late.status).toBe(201);
    await call(owner.token, 'PATCH', `/products/${cola.id}`, { sellingPriceCents: 999 });
    await call(owner.token, 'PATCH', '/settings', { 'business.name': 'Renamed Later' });
    expect(
      (await call<{ 'business.name': string }>(owner.token, 'GET', '/settings')).body[
        'business.name'
      ],
    ).toBe('Renamed Later');

    const noConfirm = await call(owner.token, 'POST', `/backups/${first.id}/restore`, {
      password: OWNER.password,
      confirm: false,
    });
    expect(noConfirm.status).toBe(400);
    const wrongPassword = await call<{ error: { code: string } }>(
      owner.token,
      'POST',
      `/backups/${first.id}/restore`,
      { password: 'nope-nope-nope', confirm: true },
    );
    expect(wrongPassword.status).toBe(403);
    expect(wrongPassword.body.error.code).toBe('PASSWORD_MISMATCH');
    // Nothing happened yet.
    expect((await call(owner.token, 'GET', `/products/${late.body.id}`)).status).toBe(200);

    const restored = await call<RestoreResult>(
      owner.token,
      'POST',
      `/backups/${first.id}/restore`,
      {
        password: OWNER.password,
        confirm: true,
      },
    );
    expect(restored.status).toBe(200);
    expect(restored.body.tablesRestored).toBeGreaterThan(30);
    expect(restored.body.rowsRestored).toBeGreaterThan(50); // permissions, roles, settings, …
    expect(restored.body.sessionKept).toBe(true);
    expect(restored.body.preRestoreBackupId).toBeTruthy();

    // The caller is still signed in and sees the data as it was.
    expect((await call(owner.token, 'GET', '/auth/me')).status).toBe(200);
    expect((await call(owner.token, 'GET', `/products/${late.body.id}`)).status).toBe(404);
    const colaNow = await call<ProductSummary>(owner.token, 'GET', `/products/${cola.id}`);
    expect(colaNow.body.sellingPriceCents).toBe(150);
    expect(colaNow.body.stockMilli).toBe(12_000);
    expect(
      (await call<{ 'business.name': string }>(owner.token, 'GET', '/settings')).body[
        'business.name'
      ],
    ).not.toBe('Renamed Later');
    // Sequences continue after the restored rows (serial ids must not collide).
    const movement = await call(owner.token, 'POST', `/products/${cola.id}/stock`, {
      type: 'adjustment',
      quantityMilliDelta: 1_000,
      reason: 'post-restore check',
    });
    expect([200, 201]).toContain(movement.status);

    // History survived: manual, imported copy and the pre-restore safety copy.
    const list = await call<BackupsResponse>(owner.token, 'GET', '/backups');
    expect(list.body.items.map((b) => b.kind).sort()).toEqual(['manual', 'manual', 'pre_restore']);
    expect(list.body.items.every((b) => b.fileExists)).toBe(true);
    const audit = await call<{ items: { action: string }[] }>(
      owner.token,
      'GET',
      '/audit-logs?pageSize=10',
    );
    expect(audit.body.items.some((a) => a.action === 'backup.restore')).toBe(true);
  }, 60_000);

  it('refuses archives from a different schema version', async () => {
    const file = path.join(backupDir, 'wrong-schema.likapcs-backup.tar.gz');
    // Build an archive with a doctored manifest from the first backup.
    const tar = await import('tar');
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-doctor-'));
    await tar.extract({ file: path.join(backupDir, first.fileName!), cwd: tmp });
    const manifest = JSON.parse(await fsp.readFile(path.join(tmp, 'manifest.json'), 'utf8'));
    manifest.schemaVersion = 1;
    await fsp.writeFile(path.join(tmp, 'manifest.json'), JSON.stringify(manifest));
    await tar.create({ gzip: true, file, cwd: tmp }, ['manifest.json', 'tables']);
    await fsp.rm(tmp, { recursive: true, force: true });
    const upload = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backups/upload?fileName=old-version',
      headers: { ...authHeader(owner.token), 'content-type': 'application/octet-stream' },
      payload: await fsp.readFile(file),
    });
    expect(upload.statusCode).toBe(201);
    const uploaded = upload.json() as BackupSummary;
    expect(uploaded.schemaVersion).toBe(1);
    const restore = await call<{ error: { code: string } }>(
      owner.token,
      'POST',
      `/backups/${uploaded.id}/restore`,
      { password: OWNER.password, confirm: true },
    );
    expect(restore.status).toBe(409);
    expect(restore.body.error.code).toBe('SCHEMA_MISMATCH');
  });

  it('deletes archives and enforces permissions', async () => {
    const list = await call<BackupsResponse>(owner.token, 'GET', '/backups');
    const victim = list.body.items.find((b) => b.fileName?.startsWith('from-usb-stick'))!;
    const deleted = await call<BackupSummary>(owner.token, 'DELETE', `/backups/${victim.id}`);
    expect(deleted.body.status).toBe('deleted');
    expect(fs.existsSync(path.join(backupDir, victim.fileName!))).toBe(false);
    expect((await call(owner.token, 'GET', `/backups/${victim.id}/download`)).status).toBe(404);

    await call(owner.token, 'POST', '/users', {
      username: 'kasa',
      fullName: 'Kasa Cashier',
      password: 'Cashier123',
      roles: ['cashier'],
      mustChangePassword: false,
    });
    const cashier = await login(ctx.app, 'kasa', 'Cashier123');
    expect((await call(cashier.token, 'GET', '/backups')).status).toBe(403);
    expect((await call(cashier.token, 'POST', '/backups', {})).status).toBe(403);
  });

  it('the scheduler runs once per business day after backup.time and applies retention', async () => {
    const svc = ctx.app.services.backups;
    await call(owner.token, 'PATCH', '/settings', {
      'backup.time': '04:00',
      'backup.keep_count': 1,
    });
    // 03:59 Belgrade time → nothing yet.
    const tz = 'Europe/Belgrade';
    const at = (iso: string) => new Date(iso);
    expect(await svc.tick(at('2026-10-10T01:59:00Z'))).toBeNull(); // 03:59 local (CEST)
    const ran = await svc.tick(at('2026-10-10T02:00:30Z')); // 04:00:30 local
    expect(ran?.kind).toBe('scheduled');
    expect(await svc.tick(at('2026-10-10T05:00:00Z'))).toBeNull(); // same day: no repeat
    const again = await svc.tick(at('2026-10-11T02:01:00Z')); // next day
    expect(again?.kind).toBe('scheduled');
    const list = await call<BackupsResponse>(owner.token, 'GET', '/backups?includeDeleted=true');
    const scheduled = list.body.items.filter((b) => b.kind === 'scheduled');
    expect(scheduled).toHaveLength(2);
    expect(scheduled.filter((b) => b.status === 'succeeded')).toHaveLength(1); // keep_count = 1
    expect(scheduled.filter((b) => b.status === 'deleted')).toHaveLength(1);
    void tz;
  }, 30_000);
});
