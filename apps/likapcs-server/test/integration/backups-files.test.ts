/**
 * A backup is complete: the uploaded files (product pictures, wallpapers, ad videos) travel with
 * the database, and a restore brings the files back exactly as they were at the backup.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackupSummary, LoginResponse, RestoreResult } from '@likapcs/shared';
import { readManifest } from '../../src/services/backups.js';
import { authHeader, createTestContext, OWNER, runSetup, type TestContext } from '../helpers.js';

describe('backup includes the uploaded files', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let backupDir: string;
  let uploadDir: string;

  const call = <T>(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({ method, url: `/api/v1${url}`, headers: authHeader(owner.token), payload })
      .then((r) => ({
        status: r.statusCode,
        body: (r.statusCode === 204 ? null : r.json()) as T,
      }));

  beforeAll(async () => {
    backupDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-bk-files-'));
    uploadDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-uploads-'));
    ctx = await createTestContext({ backupDir, uploadDir });
    owner = await runSetup(ctx.app);
    await fsp.mkdir(path.join(uploadDir, 'products'), { recursive: true });
    await fsp.mkdir(path.join(uploadDir, 'wallpapers'), { recursive: true });
    await fsp.writeFile(path.join(uploadDir, 'products', 'cola.jpg'), 'COLA-PICTURE');
    await fsp.writeFile(path.join(uploadDir, 'wallpapers', 'pc1.png'), 'PC1-WALLPAPER');
  });

  afterAll(async () => {
    await ctx.close();
    await fsp.rm(backupDir, { recursive: true, force: true });
    await fsp.rm(uploadDir, { recursive: true, force: true });
  });

  it('archives the uploads and counts them in the manifest', async () => {
    const created = await call<BackupSummary>('POST', '/backups', { kind: 'manual' });
    expect(created.status).toBe(201);
    const row = await ctx.pool.query<{ file_path: string }>(
      'SELECT file_path FROM backup_history WHERE id = $1',
      [created.body.id],
    );
    const manifest = await readManifest(row.rows[0]!.file_path);
    expect(manifest.uploads).toEqual({
      files: 2,
      bytes: 'COLA-PICTURE'.length + 'PC1-WALLPAPER'.length,
    });
  });

  it('a restore brings back the archived files and removes the ones added later', async () => {
    const backupId = (
      await ctx.pool.query<{ id: string }>(
        "SELECT id FROM backup_history WHERE status = 'succeeded' ORDER BY started_at LIMIT 1",
      )
    ).rows[0]!.id;
    // After the backup: one picture is deleted, a stray one appears.
    await fsp.rm(path.join(uploadDir, 'products', 'cola.jpg'));
    await fsp.writeFile(path.join(uploadDir, 'products', 'stray.jpg'), 'STRAY');

    const restored = await call<RestoreResult>('POST', `/backups/${backupId}/restore`, {
      password: OWNER.password,
      confirm: true,
    });
    expect(restored.status).toBe(200);
    expect(fs.readFileSync(path.join(uploadDir, 'products', 'cola.jpg'), 'utf8')).toBe(
      'COLA-PICTURE',
    );
    expect(fs.readFileSync(path.join(uploadDir, 'wallpapers', 'pc1.png'), 'utf8')).toBe(
      'PC1-WALLPAPER',
    );
    expect(fs.existsSync(path.join(uploadDir, 'products', 'stray.jpg'))).toBe(false);
  });
});
