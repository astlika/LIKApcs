/**
 * Every table of the database is in the backup archive, and nothing else is missing from it
 * (a table added by a future migration must not be silently left out of backups).
 * Files outside the database (uploaded pictures and videos) are covered by backups-files.test.ts.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackupSummary, LoginResponse } from '@likapcs/shared';
import { readManifest } from '../../src/services/backups.js';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

describe('backup archive covers the whole database', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let backupDir: string;

  beforeAll(async () => {
    backupDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-complete-'));
    ctx = await createTestContext({ backupDir });
    owner = await runSetup(ctx.app);
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    await fsp.rm(backupDir, { recursive: true, force: true });
  });

  it('lists exactly the database tables in the manifest and writes a CSV for each', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/backups',
      headers: authHeader(owner.token),
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const backup = created.json<BackupSummary>();
    expect(backup.status).toBe('succeeded');

    const dbTables = (
      await ctx.pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      )
    ).rows.map((r) => r.tablename);

    const manifest = await readManifest(path.join(backupDir, backup.fileName!));
    const archived = manifest.tables.map((t) => t.name).sort();

    // Nothing in the database is missing from the archive …
    const missing = dbTables.filter((t) => !archived.includes(t));
    expect(missing).toEqual([]);
    // … and the archive has nothing that is not in the database.
    const extra = archived.filter((t) => !dbTables.includes(t));
    expect(extra).toEqual([]);
  });
});
