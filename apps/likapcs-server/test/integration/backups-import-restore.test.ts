/**
 * 0.41.1 — a shop that has imported its data from another program can restore its backups.
 *
 * «Importo nga program tjetër» first takes a safety backup and writes its id on the import
 * (`import_runs.backup_id` → `backup_history`). The backup history is the one table a restore
 * does not bring back from the file: it lists the files on THIS disk. So after the tables were
 * loaded, the import pointed at a backup that is not there, the check of the references failed
 * and the whole restore with it — on every PC, for every backup of such a shop:
 *
 *   insert or update on table "import_runs" violates foreign key constraint
 *   "import_runs_backup_id_fkey"
 *
 * Now the history of this PC is put back first, and a reference into it that finds nothing is
 * emptied — exactly what the database itself does when a backup row is removed (ON DELETE SET
 * NULL). Both kinds of file, on the same PC, on a new PC and on a PC that already has an owner.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BackupFileFormat,
  BackupJobStarted,
  BackupJobStatus,
  BackupUploadResult,
  ImportReport,
  ImportStatus,
  LoginResponse,
} from '@likapcs/shared';
import {
  authHeader,
  createTestContext,
  login,
  OWNER,
  runSetup,
  sleep,
  type TestContext,
} from '../helpers.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'likapos-pro-sample.json',
);
const OLD_INSTALLATION = '0b6f2c1e-5a7d-4f39-9c44-1a2b3c4d5e6f';
const NEW_INSTALLATION = '9d8c7b6a-1f2e-4d3c-8b7a-6f5e4d3c2b1a';
const FORMATS: BackupFileFormat[] = ['archive', 'json'];

async function waitJob(ctx: TestContext, jobId: string): Promise<BackupJobStatus> {
  for (let i = 0; i < 2400; i += 1) {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/backups/jobs/${jobId}` });
    expect(res.statusCode).toBe(200);
    const job = res.json<BackupJobStatus>();
    if (job.state !== 'running') return job;
    await sleep(15);
  }
  throw new Error('the job did not finish');
}

describe('restore of a shop that imported from another program (0.41.1)', () => {
  let root: string;
  let ctx: TestContext | null = null;
  let owner: LoginResponse;
  let runId = '';
  let preImportBackupId = '';
  const saved: Record<string, string> = {};
  const counts: Record<string, number> = {};
  let dirs = 0;

  const call = <T>(token: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    ctx!.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: authHeader(token),
        payload: payload as Record<string, unknown> | undefined,
      })
      .then((r) => ({ status: r.statusCode, body: r.json() as T }));
  const count = async (sql: string) =>
    Number((await ctx!.pool.query<{ n: string }>(sql)).rows[0]!.n);
  const importRuns = () =>
    ctx!.pool
      .query<{
        id: string;
        backup_id: string | null;
        status: string;
      }>('SELECT id, backup_id, status FROM import_runs ORDER BY started_at')
      .then((r) => r.rows);
  const what = async () => ({
    products: await count('SELECT count(*) AS n FROM products'),
    customers: await count('SELECT count(*) AS n FROM customers'),
    sales: await count('SELECT count(*) AS n FROM sales'),
    links: await count('SELECT count(*) AS n FROM import_links'),
    runs: await count('SELECT count(*) AS n FROM import_runs'),
  });
  /** Another PC: an empty database and folders of its own. */
  const otherPc = async (): Promise<TestContext> => {
    await ctx?.close();
    dirs += 1;
    ctx = await createTestContext(
      {
        backupDir: path.join(root, `backups-new-${dirs}`),
        dataDir: path.join(root, `data-new-${dirs}`),
        uploadDir: path.join(root, `uploads-new-${dirs}`),
      },
      { installationId: NEW_INSTALLATION, adoptInstallationId: () => undefined },
    );
    return ctx;
  };
  /** Every reference of the database is checked at once again, as before the restore. */
  const referencesAreEnforced = async () => {
    expect(
      await count(
        `SELECT count(*) AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE c.contype = 'f' AND n.nspname = 'public' AND c.condeferrable`,
      ),
    ).toBe(0);
    await expect(
      ctx!.pool.query(
        `INSERT INTO import_runs (source, backup_id) VALUES ('likapos_pro', gen_random_uuid())`,
      ),
    ).rejects.toThrow(/import_runs_backup_id_fkey/);
  };

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-import-restore-'));
    ctx = await createTestContext(
      {
        backupDir: path.join(root, 'backups-old'),
        dataDir: path.join(root, 'data-old'),
        uploadDir: path.join(root, 'uploads-old'),
      },
      { installationId: OLD_INSTALLATION },
    );
    owner = await runSetup(ctx.app, 'Lika Gaming');
    const file = JSON.parse(await fsp.readFile(FIXTURE, 'utf8')) as Record<string, unknown>;
    const res = await call<ImportReport>(owner.token, 'POST', '/imports/run', {
      data: file,
      entities: ['products', 'customers', 'debts', 'sales', 'expenses'],
      fileName: 'LIKApos_Pro_backup.json',
    });
    expect(res.status).toBe(200);
    runId = res.body.runId!;
    preImportBackupId = res.body.backupId!;
    expect(runId).toBeTruthy();
    expect(preImportBackupId).toBeTruthy();
    // The state every shop is in after an import: the run points at its safety backup.
    expect(await importRuns()).toEqual([
      { id: runId, backup_id: preImportBackupId, status: 'succeeded' },
    ]);
    Object.assign(counts, await what());
    expect(counts.products).toBeGreaterThan(3);
    expect(counts.links).toBeGreaterThan(5);
    // A picture, as a shop has them.
    await fsp.mkdir(path.join(root, 'uploads-old', 'products'), { recursive: true });
    await fsp.writeFile(path.join(root, 'uploads-old', 'products', 'aa11.jpg'), 'JPEG-BYTES');

    for (const format of FORMATS) {
      const started = await call<BackupJobStarted>(owner.token, 'POST', '/backups/file', {
        format,
      });
      expect(started.status).toBe(202);
      const job = await waitJob(ctx, started.body.jobId);
      expect(job.error).toBeNull();
      expect(job.backup!.verified).toBe(true);
      const name = job.backup!.backup.fileName!;
      saved[format] = path.join(root, `saved-${format}${path.extname(name)}`);
      await fsp.copyFile(path.join(root, 'backups-old', name), saved[format]!);
      saved[`${format}:id`] = job.backup!.backup.id;
    }
  }, 60_000);

  afterAll(async () => {
    await ctx?.close().catch(() => undefined);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('no column that cannot be emptied points into a table a restore does not bring back', async () => {
    // The rule the restore relies on. A new reference into the backup history has to be one
    // that may be empty (as this one is), or the restore has to learn what to do with it.
    const { rows } = await ctx!.pool.query<{ name: string; child: string; nullable: boolean }>(
      `SELECT c.conname AS name, c.conrelid::regclass::text AS child,
              (SELECT bool_and(NOT a.attnotnull) FROM pg_attribute a
                WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) AS nullable
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.confrelid::regclass::text IN ('backup_history', 'station_heartbeats', 'schema_migrations')
          AND c.conrelid <> c.confrelid
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.name)).toContain('import_runs_backup_id_fkey');
    expect(rows.filter((r) => !r.nullable)).toEqual([]);
  });

  it.each(FORMATS)(
    'on the same PC (%s): everything comes back and the import keeps its safety backup',
    async (format) => {
      // Something recorded after the backup: gone again after the restore.
      await ctx!.pool.query(`UPDATE products SET name = name || ' (pas)'`);
      const started = await call<BackupJobStarted>(
        owner.token,
        'POST',
        `/backups/${saved[`${format}:id`]}/restore-job`,
        { password: OWNER.password, confirm: true },
      );
      expect(started.status).toBe(202);
      const job = await waitJob(ctx!, started.body.jobId);
      expect(job.error).toBeNull();
      expect(job.state).toBe('succeeded');
      expect(job.restore!.verified).toBe(true);
      expect(await what()).toEqual(counts);
      expect(await count(`SELECT count(*) AS n FROM products WHERE name LIKE '% (pas)'`)).toBe(0);
      // The safety backup of the import is still on this PC: the import still points at it.
      expect(await importRuns()).toEqual([
        { id: runId, backup_id: preImportBackupId, status: 'succeeded' },
      ]);
      expect(
        await count(`SELECT count(*) AS n FROM backup_history WHERE kind = 'pre_import'`),
      ).toBe(1);
      await referencesAreEnforced();
    },
    60_000,
  );

  it.each(FORMATS)(
    'on a new PC, from the first screen (%s): everything comes back, without that safety backup',
    async (format) => {
      const fresh = await otherPc();
      const upload = await fresh.app.inject({
        method: 'POST',
        url: `/api/v1/system/restore/upload?fileName=${path.basename(saved[format]!)}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload: await fsp.readFile(saved[format]!),
      });
      expect(upload.statusCode).toBe(201);
      const uploaded = upload.json<BackupUploadResult>();
      expect(uploaded.backup.format).toBe(format);
      const started = await fresh.app.inject({
        method: 'POST',
        url: '/api/v1/system/restore',
        payload: { backupId: uploaded.backup.id },
      });
      expect(started.statusCode).toBe(202);
      const job = await waitJob(fresh, started.json<BackupJobStarted>().jobId);
      expect(job.error).toBeNull();
      expect(job.state).toBe('succeeded');
      expect(job.restore!.verified).toBe(true);
      expect(await what()).toEqual(counts);
      // The safety backup of the import is a file of the old PC: here the import points nowhere.
      expect(await importRuns()).toEqual([{ id: runId, backup_id: null, status: 'succeeded' }]);
      expect(
        await count(`SELECT count(*) AS n FROM backup_history WHERE kind = 'pre_import'`),
      ).toBe(0);
      await referencesAreEnforced();
      // The program works on the restored data: the owner signs in and the import page answers.
      const signedIn = await login(fresh.app, OWNER.username, OWNER.password);
      const status = await call<ImportStatus>(signedIn.token, 'GET', '/imports/status');
      expect(status.status).toBe(200);
      expect(status.body.lastRun).toMatchObject({ id: runId, status: 'succeeded' });
      // And a backup of the restored shop restores again (the import no longer stands in the way).
      const again = await call<BackupJobStarted>(signedIn.token, 'POST', '/backups/file', {
        format,
      });
      const made = await waitJob(fresh, again.body.jobId);
      expect(made.error).toBeNull();
      const back = await call<BackupJobStarted>(
        signedIn.token,
        'POST',
        `/backups/${made.backup!.backup.id}/restore-job`,
        { password: OWNER.password, confirm: true },
      );
      expect(back.status).toBe(202);
      expect((await waitJob(fresh, back.body.jobId)).error).toBeNull();
      expect(await what()).toEqual(counts);
    },
    60_000,
  );

  it.each(FORMATS)(
    'on a PC that already has an owner, from the login screen (%s)',
    async (format) => {
      const other = await otherPc();
      // This PC was set up on its own: another shop, its own account and its own data.
      const local = await runSetup(other.app, 'Dyqani tjetër');
      expect(
        (
          await call(local.token, 'POST', '/products', {
            name: 'I këtushëm',
            sellingPriceCents: 100,
          })
        ).status,
      ).toBe(201);
      const upload = await other.app.inject({
        method: 'POST',
        url: `/api/v1/backups/upload?fileName=LIKApcs-backup-backup${path.extname(saved[format]!)}`,
        headers: { ...authHeader(local.token), 'content-type': 'application/octet-stream' },
        payload: await fsp.readFile(saved[format]!),
      });
      expect(upload.statusCode).toBe(201);
      const uploaded = upload.json<{ id: string }>();
      const started = await call<BackupJobStarted>(
        local.token,
        'POST',
        `/backups/${uploaded.id}/restore-job`,
        { password: OWNER.password, confirm: true },
      );
      expect(started.status).toBe(202);
      const job = await waitJob(other, started.body.jobId);
      expect(job.error).toBeNull();
      expect(job.state).toBe('succeeded');
      expect(await what()).toEqual(counts);
      expect(await count(`SELECT count(*) AS n FROM products WHERE name = 'I këtushëm'`)).toBe(0);
      expect(await importRuns()).toEqual([{ id: runId, backup_id: null, status: 'succeeded' }]);
      // What this PC held is kept as a safety copy, listed in its history.
      expect(
        await count(`SELECT count(*) AS n FROM backup_history WHERE kind = 'pre_restore'`),
      ).toBe(1);
      await referencesAreEnforced();
    },
    60_000,
  );
  it('a backup with a reference that really finds nothing is refused in words, and nothing changes', async () => {
    const pc = await otherPc();
    const local = await runSetup(pc.app, 'Dyqan me një rresht të prishur');
    expect(
      (await call(local.token, 'POST', '/products', { name: 'Para', sellingPriceCents: 100 }))
        .status,
    ).toBe(201);
    // A row that points at an import which does not exist. The database never lets one in: it
    // takes switching its checks off for a moment to make it.
    const client = await pc.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(
        `INSERT INTO import_links (source, entity, external_id, internal_id, run_id)
         VALUES ('likapos_pro', 'product', 'x-1', 'y-1', gen_random_uuid())`,
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const made = await call<BackupJobStarted>(local.token, 'POST', '/backups/file', {
      format: 'json',
    });
    const backup = await waitJob(pc, made.body.jobId);
    expect(backup.error).toBeNull();
    await pc.pool.query(`UPDATE products SET name = 'Pas'`);

    const started = await call<BackupJobStarted>(
      local.token,
      'POST',
      `/backups/${backup.backup!.backup.id}/restore-job`,
      { password: OWNER.password, confirm: true },
    );
    expect(started.status).toBe(202);
    const job = await waitJob(pc, started.body.jobId);
    expect(job.state).toBe('failed');
    expect(job.error!.code).toBe('ARCHIVE_REFERENCES_BROKEN');
    expect(job.error!.message).toContain('import_links');
    expect(job.error!.message).toContain('Asgjë nuk u ndryshua');
    // Not the database's own sentence.
    expect(job.error!.message).not.toContain('violates foreign key');
    // Nothing changed: what was recorded after the backup is still there, and the session works.
    expect(await count(`SELECT count(*) AS n FROM products WHERE name = 'Pas'`)).toBe(1);
    expect((await call(local.token, 'GET', '/products')).status).toBe(200);
    await referencesAreEnforced();
  }, 60_000);
});
