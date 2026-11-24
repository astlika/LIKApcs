/**
 * 0.38.0 — «Backup file»: one file with everything, loaded on any PC.
 *
 *  - the file holds every table and every uploaded file, each with its checksum, and is read back
 *    before it counts as written;
 *  - a fresh installation loads it from its first screen: every row and every file is back, the
 *    accounts work, and the server takes the place of the old installation (same id, the gaming
 *    PCs keep their approval);
 *  - a file made by an older version is brought up to this one (its migrations run over the data);
 *  - a damaged or incomplete file is refused before anything is changed;
 *  - both operations report their progress in percent to a caller that is not signed in.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BackupDownloadTicket,
  BackupJobStarted,
  BackupJobStatus,
  BackupManifest,
  BackupSummary,
  BackupUploadResult,
  LoginResponse,
} from '@likapcs/shared';
import { runMigrations } from '../../src/db/migrate.js';
import { createPool, type DbPool } from '../../src/db/pool.js';
import { isEncryptedFile } from '../../src/services/backup-crypto.js';
import { BackupService, readManifest, verifyArchive } from '../../src/services/backups.js';
import { SettingsService } from '../../src/services/settings.js';
import {
  authHeader,
  createTestContext,
  login,
  OWNER,
  runSetup,
  sleep,
  type TestContext,
} from '../helpers.js';

const OLD_INSTALLATION = '0b6f2c1e-5a7d-4f39-9c44-1a2b3c4d5e6f';
const NEW_INSTALLATION = '9d8c7b6a-1f2e-4d3c-8b7a-6f5e4d3c2b1a';

/** Tables a restore writes to itself, or deliberately leaves out. */
const NOT_COMPARED = new Set([
  'schema_migrations',
  'backup_history',
  'audit_logs',
  'station_heartbeats',
  'user_sessions',
]);

async function fingerprint(pool: DbPool): Promise<Record<string, string>> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
  );
  const out: Record<string, string> = {};
  for (const { tablename } of rows) {
    if (NOT_COMPARED.has(tablename)) continue;
    const r = await pool.query<{ n: number; h: string }>(
      `SELECT count(*)::int AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS h
         FROM "${tablename}" t`,
    );
    out[tablename] = `${r.rows[0]!.n}:${r.rows[0]!.h}`;
  }
  return out;
}

/** Every file under `root` → sha256, by path relative to it. */
async function fileHashes(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else {
        out[rel] = crypto
          .createHash('sha256')
          .update(await fsp.readFile(path.join(dir, entry.name)))
          .digest('hex');
      }
    }
  };
  if (fs.existsSync(root)) await walk(root, '');
  return out;
}

/** Follows a job to its end WITHOUT signing in, and checks the percentage never goes back. */
async function waitJob(ctx: TestContext, jobId: string): Promise<BackupJobStatus> {
  const seen: number[] = [];
  for (let i = 0; i < 2400; i += 1) {
    const res = await ctx.app.inject({ method: 'GET', url: `/api/v1/backups/jobs/${jobId}` });
    expect(res.statusCode).toBe(200);
    const job = res.json<BackupJobStatus>();
    seen.push(job.percent);
    if (job.state !== 'running') {
      expect([...seen].sort((a, b) => a - b)).toEqual(seen);
      if (job.state === 'succeeded') expect(job.percent).toBe(100);
      else expect(job.percent).toBeLessThan(100);
      expect(job.finishedAt).not.toBeNull();
      return job;
    }
    await sleep(15);
  }
  throw new Error('the job did not finish');
}

/** Unpacks an archive, lets `change` alter it, and packs it again under `target`. */
async function repack(
  source: string,
  target: string,
  change: (dir: string, manifest: BackupManifest) => Promise<BackupManifest | void>,
): Promise<void> {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-repack-'));
  try {
    await tar.extract({ file: source, cwd: tmp });
    const manifestFile = path.join(tmp, 'manifest.json');
    const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8')) as BackupManifest;
    const next = (await change(tmp, manifest)) ?? manifest;
    await fsp.writeFile(manifestFile, JSON.stringify(next, null, 2));
    const entries = ['manifest.json', 'report.txt', 'tables', 'uploads'].filter((e) =>
      fs.existsSync(path.join(tmp, e)),
    );
    await tar.create({ gzip: true, file: target, cwd: tmp, portable: true }, entries);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

describe('backup file (0.38.0)', () => {
  let root: string;
  let ctxOld: TestContext | null = null;
  let ctxNew: TestContext | null = null;
  let owner: LoginResponse;
  let ownerHash = '';
  let savedFile = '';
  let before: Record<string, string> = {};
  let filesBefore: Record<string, string> = {};
  const adopted: string[] = [];

  const uploadsOld = () => path.join(root, 'uploads-old');
  const uploadsNew = () => path.join(root, 'uploads-new');

  const oldCall = <T>(method: 'GET' | 'POST', url: string, payload?: unknown) =>
    ctxOld!.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: authHeader(owner.token),
        payload: payload as Record<string, unknown> | undefined,
      })
      .then((r) => ({ status: r.statusCode, body: r.json() as T }));

  const uploadFresh = (ctx: TestContext, file: string, password?: string) =>
    fsp.readFile(file).then((payload) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/system/restore/upload?fileName=${encodeURIComponent(path.basename(file))}`,
        headers: {
          'content-type': 'application/octet-stream',
          ...(password ? { 'x-archive-password': password } : {}),
        },
        payload,
      }),
    );

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-backup-file-'));
    ctxOld = await createTestContext(
      {
        backupDir: path.join(root, 'backups-old'),
        dataDir: path.join(root, 'data-old'),
        uploadDir: uploadsOld(),
      },
      { installationId: OLD_INSTALLATION },
    );
    owner = await runSetup(ctxOld.app, 'Lika Gaming');
    ownerHash = (
      await ctxOld.pool.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE username = $1',
        [OWNER.username],
      )
    ).rows[0]!.password_hash;
    // Business data.
    for (const name of ['Coca-Cola 0.33l', 'Ujë 0.5l', 'Çokollatë']) {
      const res = await oldCall<{ id: string }>('POST', '/products', {
        name,
        sellingPriceCents: 120,
        purchaseCostCents: 70,
        initialStockMilli: 24_000,
      });
      expect(res.status).toBe(201);
    }
    await oldCall('POST', '/customers', { name: 'Arben Krasniqi', phone: '044 111 222' });
    await ctxOld.pool.query(
      `INSERT INTO station_devices (machine_id, status, token_hash, registration_secret_hash)
       VALUES ('pc-old-1', 'approved', 'token-hash-1', 'secret-hash-1')`,
    );
    // Files outside the database: pictures, their small copies, wallpapers, videos, voice clips.
    const put = async (rel: string, data: Buffer | string) => {
      const file = path.join(uploadsOld(), ...rel.split('/'));
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, data);
    };
    await put('products/aa11.jpg', crypto.randomBytes(180_000));
    await put('products/aa11.thumb.webp', crypto.randomBytes(9_000));
    await put('products/bb22.png', crypto.randomBytes(64_000));
    await put('wallpapers/pc-01.jpg', crypto.randomBytes(300_000));
    await put('videos/reklama.mp4', crypto.randomBytes(1_500_000));
    await put('voice/pesë-minuta.mp3', crypto.randomBytes(20_000));
    await put('products/empty.bin', '');
    // An upload that is still arriving is not part of a backup.
    await put('videos/half.part', crypto.randomBytes(5_000));
  }, 60_000);

  afterAll(async () => {
    await ctxOld?.close().catch(() => undefined);
    await ctxNew?.close().catch(() => undefined);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('makes one file with every table and every uploaded file, checked', async () => {
    before = await fingerprint(ctxOld!.pool);
    filesBefore = await fileHashes(uploadsOld());
    delete filesBefore['videos/half.part'];

    const started = await oldCall<BackupJobStarted>('POST', '/backups/file', {});
    expect(started.status).toBe(202);
    // Only one backup or restore at a time.
    const second = await oldCall<{ error: { code: string } }>('POST', '/backups/file', {});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('BACKUP_BUSY');

    const job = await waitJob(ctxOld!, started.body.jobId);
    expect(job.error).toBeNull();
    expect(job.state).toBe('succeeded');
    expect(job.kind).toBe('backup');
    const result = job.backup!;
    expect(result.verified).toBe(true);
    expect(result.backup.kind).toBe('manual');
    expect(result.backup.status).toBe('succeeded');
    expect(result.backup.encrypted).toBe(false);
    expect(result.directory).toBe(path.join(root, 'backups-old'));
    expect(result.contents.businessName).toBe('Lika Gaming');
    expect(result.contents.files).toBe(Object.keys(filesBefore).length);
    expect(result.contents.tables).toBeGreaterThan(60);
    expect(result.contents.rows).toBeGreaterThan(50);

    const archive = path.join(root, 'backups-old', result.backup.fileName!);
    const manifest = await readManifest(archive);
    expect(manifest.installationId).toBe(OLD_INSTALLATION);
    expect(manifest.tables.every((t) => /^[0-9a-f]{64}$/.test(t.sha256 ?? ''))).toBe(true);
    // The list in the file is exactly what is on disk, checksum by checksum.
    expect(Object.fromEntries(manifest.files!.map((f) => [f.path, f.sha256]))).toEqual(filesBefore);
    expect(manifest.uploads).toEqual({
      files: manifest.files!.length,
      bytes: manifest.files!.reduce((n, f) => n + f.bytes, 0),
    });
    // It is listed like any other backup.
    const list = await oldCall<{ items: BackupSummary[] }>('GET', '/backups');
    expect(list.body.items.some((b) => b.id === result.backup.id)).toBe(true);
  }, 60_000);

  it('is saved through a link that needs no sign-in, for a short time, for that file only', async () => {
    const list = await oldCall<{ items: BackupSummary[] }>('GET', '/backups');
    const backup = list.body.items.find((b) => b.kind === 'manual')!;
    const noAuth = await ctxOld!.app.inject({
      method: 'GET',
      url: `/api/v1/backups/${backup.id}/download`,
    });
    expect(noAuth.statusCode).toBe(401);
    const wrong = await ctxOld!.app.inject({
      method: 'GET',
      url: `/api/v1/backups/${backup.id}/download?ticket=not-a-ticket`,
    });
    expect(wrong.statusCode).toBe(403);

    const ticket = await oldCall<BackupDownloadTicket>(
      'POST',
      `/backups/${backup.id}/download-ticket`,
    );
    expect(ticket.status).toBe(200);
    const other = await ctxOld!.app.inject({
      method: 'GET',
      url: `/api/v1/backups/${crypto.randomUUID()}/download?ticket=${ticket.body.ticket}`,
    });
    expect(other.statusCode).toBe(403);
    const res = await ctxOld!.app.inject({
      method: 'GET',
      url: `/api/v1/backups/${backup.id}/download?ticket=${ticket.body.ticket}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain(backup.fileName!);
    expect(Number(res.headers['content-length'])).toBe(backup.sizeBytes);
    expect(crypto.createHash('sha256').update(res.rawPayload).digest('hex')).toBe(backup.sha256);
    // "Saved anywhere": here, a folder that stands for the USB stick.
    savedFile = path.join(root, 'usb', 'LIKApcs-kopje.likapcs-backup.tar.gz');
    await fsp.mkdir(path.dirname(savedFile), { recursive: true });
    await fsp.writeFile(savedFile, res.rawPayload);
  });

  it('a fresh installation loads the file: everything is back and it takes the old PC’s place', async () => {
    await ctxOld!.close();
    ctxOld = null;
    // A new laptop: an empty database, no user, its own identity, empty folders.
    ctxNew = await createTestContext(
      {
        backupDir: path.join(root, 'backups-new'),
        dataDir: path.join(root, 'data-new'),
        uploadDir: uploadsNew(),
      },
      { installationId: NEW_INSTALLATION, adoptInstallationId: (id) => void adopted.push(id) },
    );
    const health = () =>
      ctxNew!.app
        .inject({ method: 'GET', url: '/api/v1/system/health' })
        .then((r) => r.json<{ installationId: string }>());
    expect((await health()).installationId).toBe(NEW_INSTALLATION);
    const setup = () =>
      ctxNew!.app
        .inject({ method: 'GET', url: '/api/v1/system/setup-status' })
        .then((r) => r.json<{ needsSetup: boolean; businessName: string }>());
    expect((await setup()).needsSetup).toBe(true);

    const upload = await uploadFresh(ctxNew, savedFile);
    expect(upload.statusCode).toBe(201);
    const uploaded = upload.json<BackupUploadResult>();
    expect(uploaded.contents.businessName).toBe('Lika Gaming');
    expect(uploaded.contents.files).toBe(Object.keys(filesBefore).length);
    // The same file loaded twice gets a number, not an error.
    const again = await uploadFresh(ctxNew, savedFile);
    expect(again.statusCode).toBe(201);
    expect(again.json<BackupUploadResult>().backup.fileName).toBe(
      'LIKApcs-kopje-2.likapcs-backup.tar.gz',
    );

    const started = await ctxNew.app.inject({
      method: 'POST',
      url: '/api/v1/system/restore',
      payload: { backupId: uploaded.backup.id },
    });
    expect(started.statusCode).toBe(202);
    const job = await waitJob(ctxNew, started.json<BackupJobStarted>().jobId);
    expect(job.error).toBeNull();
    expect(job.state).toBe('succeeded');
    const result = job.restore!;
    expect(result.verified).toBe(true);
    expect(result.upgraded).toBe(false);
    expect(result.identityAdopted).toBe(true);
    expect(result.filesRestored).toBe(Object.keys(filesBefore).length);
    expect(result.archiveSchemaVersion).toBe(ctxNew.app.schemaVersion);
    // What the file said it holds is exactly what came back.
    expect(result.tablesRestored).toBe(uploaded.contents.tables);
    expect(result.rowsRestored).toBe(uploaded.contents.rows);
    expect(result.fileBytesRestored).toBe(uploaded.contents.fileBytes);

    // 100 %: every table has the same rows, every file the same bytes.
    expect(await fingerprint(ctxNew.pool)).toEqual(before);
    expect(await fileHashes(uploadsNew())).toEqual(filesBefore);
    // The accounts of the old PC work.
    expect((await setup()).needsSetup).toBe(false);
    expect((await setup()).businessName).toBe('Lika Gaming');
    const session = await login(ctxNew.app, OWNER.username, OWNER.password);
    expect(session.user.username).toBe(OWNER.username);
    const account = await ctxNew.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE username = $1',
      [OWNER.username],
    );
    expect(account.rows[0]!.password_hash).toBe(ownerHash);
    // This server is now the old installation: its id, and the PCs keep their approval.
    expect(adopted).toEqual([OLD_INSTALLATION]);
    expect((await health()).installationId).toBe(OLD_INSTALLATION);
    const devices = await ctxNew.pool.query<{ status: string; token_hash: string | null }>(
      `SELECT status, token_hash FROM station_devices WHERE machine_id = 'pc-old-1'`,
    );
    expect(devices.rows).toEqual([{ status: 'approved', token_hash: 'token-hash-1' }]);
    // The first-screen door is closed once the system has users.
    const late = await uploadFresh(ctxNew, savedFile);
    expect(late.statusCode).toBe(409);
    expect(late.json<{ error: { code: string } }>().error.code).toBe('NOT_FRESH_INSTALL');
    const lateRestore = await ctxNew.app.inject({
      method: 'POST',
      url: '/api/v1/system/restore',
      payload: { backupId: uploaded.backup.id },
    });
    expect(lateRestore.statusCode).toBe(409);
    expect(lateRestore.json<{ error: { code: string } }>().error.code).toBe('NOT_FRESH_INSTALL');
    // Nothing is left behind in the backup folder.
    const leftovers = (await fsp.readdir(path.join(root, 'backups-new'))).filter((n) =>
      n.startsWith('.'),
    );
    expect(leftovers).toEqual([]);
  }, 90_000);

  it('a file with a password of its own opens only with it', async () => {
    const session = await login(ctxNew!.app, OWNER.username, OWNER.password);
    const call = <T>(method: 'GET' | 'POST', url: string, payload?: unknown) =>
      ctxNew!.app
        .inject({
          method,
          url: `/api/v1${url}`,
          headers: authHeader(session.token),
          payload: payload as Record<string, unknown> | undefined,
        })
        .then((r) => ({ status: r.statusCode, body: r.json() as T }));

    // Letters a header cannot carry as they are (€ is outside Latin-1): the Admin sends the
    // password percent-encoded in `x-archive-password-utf8`.
    const filePassword = 'sekret-€-ë-1234';
    // (Signing in wrote the time of the last login, so the state is read again here.)
    const atBackup = await fingerprint(ctxNew!.pool);
    const started = await call<BackupJobStarted>('POST', '/backups/file', {
      password: filePassword,
    });
    expect(started.status).toBe(202);
    const job = await waitJob(ctxNew!, started.body.jobId);
    expect(job.state).toBe('succeeded');
    const backup = job.backup!.backup;
    expect(backup.encrypted).toBe(true);
    expect(backup.fileName).toMatch(/\.likapcs-backup\.tar\.gz\.enc$/);
    const file = path.join(root, 'backups-new', backup.fileName!);
    expect(await isEncryptedFile(file)).toBe(true);

    // Loading it again (as another PC would): no password, a wrong one, the right one.
    const upload = (passwordHeader: Record<string, string> = {}) =>
      fsp.readFile(file).then((payload) =>
        ctxNew!.app.inject({
          method: 'POST',
          url: '/api/v1/backups/upload?fileName=nga-usb.likapcs-backup.tar.gz.enc',
          headers: {
            ...authHeader(session.token),
            'content-type': 'application/octet-stream',
            ...passwordHeader,
          },
          payload,
        }),
      );
    const none = await upload();
    expect(none.statusCode).toBe(400);
    expect(none.json<{ error: { code: string } }>().error.code).toBe('ARCHIVE_PASSWORD_REQUIRED');
    // The older header (plain text) still works for a password it can carry.
    const wrong = await upload({ 'x-archive-password': 'gabim-9999' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json<{ error: { code: string } }>().error.code).toBe('ARCHIVE_PASSWORD_WRONG');
    const wrongEncoded = await upload({
      'x-archive-password-utf8': encodeURIComponent('sekret-€-e-1234'),
    });
    expect(wrongEncoded.statusCode).toBe(403);
    const good = await upload({ 'x-archive-password-utf8': encodeURIComponent(filePassword) });
    expect(good.statusCode).toBe(201);
    const uploaded = good.json<BackupSummary>();
    // A refused upload leaves no file behind; the accepted one is the only new archive.
    const kept = (await fsp.readdir(path.join(root, 'backups-new'))).filter((n) =>
      n.startsWith('nga-usb'),
    );
    expect(kept).toEqual(['nga-usb.likapcs-backup.tar.gz.enc']);

    const refuse = await call<{ error: { code: string } }>(
      'POST',
      `/backups/${uploaded.id}/restore-job`,
      { password: OWNER.password, confirm: true, archivePassword: 'gabim-9999' },
    );
    expect(refuse.status).toBe(403);
    expect(refuse.body.error.code).toBe('ARCHIVE_PASSWORD_WRONG');
    const badAccount = await call<{ error: { code: string } }>(
      'POST',
      `/backups/${uploaded.id}/restore-job`,
      { password: 'not-my-password', confirm: true, archivePassword: filePassword },
    );
    expect(badAccount.status).toBe(403);
    expect(badAccount.body.error.code).toBe('PASSWORD_MISMATCH');

    // Something changes after the backup; the restore takes it back.
    await call('POST', '/customers', { name: 'Erdhi më vonë' });
    await fsp.writeFile(path.join(uploadsNew(), 'products', 'later.jpg'), 'LATER');
    const restore = await call<BackupJobStarted>('POST', `/backups/${uploaded.id}/restore-job`, {
      password: OWNER.password,
      confirm: true,
      archivePassword: filePassword,
    });
    expect(restore.status).toBe(202);
    const restored = await waitJob(ctxNew!, restore.body.jobId);
    expect(restored.error).toBeNull();
    expect(restored.restore!.verified).toBe(true);
    expect(restored.restore!.sessionKept).toBe(true);
    // Same installation: nothing to take over.
    expect(restored.restore!.identityAdopted).toBe(false);
    expect(await fingerprint(ctxNew!.pool)).toEqual(atBackup);
    expect(await fileHashes(uploadsNew())).toEqual(filesBefore);
    const later = await ctxNew!.pool.query(`SELECT 1 FROM customers WHERE name = 'Erdhi më vonë'`);
    expect(later.rowCount).toBe(0);
  }, 90_000);

  it('refuses a damaged or incomplete file and changes nothing', async () => {
    const session = await login(ctxNew!.app, OWNER.username, OWNER.password);
    const headers = authHeader(session.token);
    const tryRestore = async (file: string) => {
      const upload = await ctxNew!.app.inject({
        method: 'POST',
        url: `/api/v1/backups/upload?fileName=${path.basename(file)}`,
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        payload: await fsp.readFile(file),
      });
      expect(upload.statusCode).toBe(201);
      const started = await ctxNew!.app.inject({
        method: 'POST',
        url: `/api/v1/backups/${upload.json<BackupSummary>().id}/restore-job`,
        headers,
        payload: { password: OWNER.password, confirm: true },
      });
      if (started.statusCode !== 202) {
        return { code: started.json<{ error: { code: string } }>().error.code, message: '' };
      }
      const job = await waitJob(ctxNew!, started.json<BackupJobStarted>().jobId);
      expect(job.state).toBe('failed');
      return job.error!;
    };
    const dbBefore = await fingerprint(ctxNew!.pool);

    // 1. One picture has other bytes of the same length.
    const flipped = path.join(root, 'flipped.likapcs-backup.tar.gz');
    await repack(savedFile, flipped, async (dir) => {
      const victim = path.join(dir, 'uploads', 'products', 'bb22.png');
      await fsp.writeFile(victim, crypto.randomBytes((await fsp.stat(victim)).size));
    });
    const e1 = await tryRestore(flipped);
    expect(e1.code).toBe('ARCHIVE_INCOMPLETE');
    expect(e1.message).toContain('products/bb22.png');

    // 2. A file is missing.
    const missing = path.join(root, 'missing.likapcs-backup.tar.gz');
    await repack(savedFile, missing, async (dir) => {
      await fsp.rm(path.join(dir, 'uploads', 'videos', 'reklama.mp4'));
    });
    expect((await tryRestore(missing)).code).toBe('ARCHIVE_INCOMPLETE');

    // 3. A table is missing.
    const noTable = path.join(root, 'no-table.likapcs-backup.tar.gz');
    await repack(savedFile, noTable, async (dir) => {
      await fsp.rm(path.join(dir, 'tables', 'products.csv'));
    });
    const e3 = await tryRestore(noTable);
    expect(e3.code).toBe('ARCHIVE_INCOMPLETE');
    expect(e3.message).toContain('products');

    // 4. An archive of the old kind (no checksums) that lost rows: caught by the row count,
    //    inside the transaction, which is rolled back.
    const fewer = path.join(root, 'fewer-rows.likapcs-backup.tar.gz');
    await repack(savedFile, fewer, async (dir, manifest) => {
      const file = path.join(dir, 'tables', 'products.csv');
      const lines = (await fsp.readFile(file, 'utf8')).trimEnd().split('\n');
      await fsp.writeFile(file, `${lines.slice(0, -1).join('\n')}\n`);
      const size = (await fsp.stat(file)).size;
      return {
        ...manifest,
        files: undefined,
        installationId: undefined,
        tables: manifest.tables.map((t) => ({
          name: t.name,
          rows: t.rows,
          bytes: t.name === 'products' ? size : t.bytes,
        })),
      };
    });
    const e4 = await tryRestore(fewer);
    expect(e4.code).toBe('ARCHIVE_INCOMPLETE');
    expect(e4.message).toContain('products');

    // 5. A file made by a newer version of the program is refused at once.
    const newer = path.join(root, 'newer.likapcs-backup.tar.gz');
    await repack(savedFile, newer, async (_dir, manifest) => ({
      ...manifest,
      serverVersion: '99.0.0',
      schemaVersion: manifest.schemaVersion + 1,
    }));
    expect((await tryRestore(newer)).code).toBe('ARCHIVE_NEWER');

    // Nothing was changed by any of them.
    expect(await fingerprint(ctxNew!.pool)).toEqual(dbBefore);
    expect(await fileHashes(uploadsNew())).toEqual(filesBefore);
    const jobs = await ctxNew!.app.inject({
      method: 'GET',
      url: `/api/v1/backups/jobs/${crypto.randomUUID()}`,
    });
    expect(jobs.statusCode).toBe(404);
  }, 120_000);

  it('the check of a finished archive finds a file that is not in it', async () => {
    const broken = path.join(root, 'broken.tar.gz');
    let manifest: BackupManifest | null = null;
    await repack(savedFile, broken, async (dir, m) => {
      manifest = m;
      await fsp.rm(path.join(dir, 'uploads', 'wallpapers', 'pc-01.jpg'));
    });
    await expect(verifyArchive(broken, manifest!)).rejects.toThrow(/wallpapers\/pc-01\.jpg/);
    await expect(verifyArchive(savedFile, manifest!)).resolves.toBeUndefined();
  });
});

describe('backup file made by an older version (0.38.0)', () => {
  let root: string;
  let ctx: TestContext | null = null;
  let oldArchive = '';
  let ownerHash = '';

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-backup-old-'));
    // A password hash this server accepts, to give the old installation an owner.
    const probe = await createTestContext({
      backupDir: path.join(root, 'probe-backups'),
      dataDir: path.join(root, 'probe-data'),
    });
    await runSetup(probe.app);
    ownerHash = (
      await probe.pool.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE username = $1',
        [OWNER.username],
      )
    ).rows[0]!.password_hash;
    const config = probe.config;
    await probe.close();

    // The database as LIKApcs had it at schema version 52 (before `live.view`, internet codes,
    // offers and the speed release), with some data of that time.
    const pool = createPool(config.databaseUrl!, { max: 3 });
    try {
      await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await runMigrations(pool, config.migrationsDir, undefined, { upTo: 52 });
      const version = await pool.query<{ v: number }>(
        'SELECT max(version)::int AS v FROM schema_migrations',
      );
      expect(version.rows[0]!.v).toBe(52);
      const user = await pool.query<{ id: string }>(
        `INSERT INTO users (username, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
        [OWNER.username, OWNER.fullName, ownerHash],
      );
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'owner'`,
        [user.rows[0]!.id],
      );
      await pool.query(
        `INSERT INTO products (name, sku, selling_price_cents) VALUES ('Kola e vjetër', 'OLD-1', 150)`,
      );
      await pool.query(`INSERT INTO customers (code, name) VALUES ('C0001', 'Klient i vjetër')`);
      const station = await pool.query<{ id: string }>(
        `INSERT INTO stations (number, code, name) VALUES (1, 'PC-01', 'PC 01') RETURNING id`,
      );
      const device = await pool.query<{ id: string }>(
        `INSERT INTO station_devices (machine_id, status, token_hash, registration_secret_hash, station_id)
         VALUES ('pc-52', 'approved', 'token-52', 'secret-52', $1) RETURNING id`,
        [station.rows[0]!.id],
      );
      // Load samples: an old archive can hold millions of them; they are not brought back.
      await pool.query(
        `INSERT INTO station_heartbeats (device_id, station_id) SELECT $1, $2 FROM generate_series(1, 50)`,
        [device.rows[0]!.id, station.rows[0]!.id],
      );
      const uploads = path.join(root, 'uploads-52');
      await fsp.mkdir(path.join(uploads, 'products'), { recursive: true });
      await fsp.writeFile(path.join(uploads, 'products', 'old.jpg'), 'OLD-PICTURE');
      const service = new BackupService(
        pool,
        path.join(root, 'backups-52'),
        new SettingsService(pool),
        {
          schemaVersion: () => 52,
          uploadDir: uploads,
          keyFile: path.join(root, 'keys-52.json'),
        },
      );
      const made = await service.create({ kind: 'manual', actor: null });
      // What a file of that time looked like: no checksums, no file list, no installation id.
      oldArchive = path.join(root, 'likapcs-manual-20260301-040000.likapcs-backup.tar.gz');
      await repack(path.join(root, 'backups-52', made.fileName!), oldArchive, async (_d, m) => ({
        ...m,
        serverVersion: '0.31.0',
        files: undefined,
        installationId: undefined,
        tables: m.tables.map((t) => ({ name: t.name, rows: t.rows, bytes: t.bytes })),
      }));
      const manifest = await readManifest(oldArchive);
      expect(manifest.schemaVersion).toBe(52);
      expect(manifest.tables.some((t) => t.name === 'offers')).toBe(false);
    } finally {
      await pool.end();
    }
  }, 120_000);

  afterAll(async () => {
    await ctx?.close().catch(() => undefined);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('is brought up to this version: its data, with the newer migrations run over it', async () => {
    ctx = await createTestContext({
      backupDir: path.join(root, 'backups-now'),
      dataDir: path.join(root, 'data-now'),
      uploadDir: path.join(root, 'uploads-now'),
    });
    expect(ctx.app.schemaVersion).toBeGreaterThan(52);
    const upload = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/system/restore/upload?fileName=${path.basename(oldArchive)}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: await fsp.readFile(oldArchive),
    });
    expect(upload.statusCode).toBe(201);
    const uploaded = upload.json<BackupUploadResult>();
    expect(uploaded.contents.schemaVersion).toBe(52);
    expect(uploaded.contents.serverVersion).toBe('0.31.0');

    const started = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/system/restore',
      payload: { backupId: uploaded.backup.id },
    });
    expect(started.statusCode).toBe(202);
    const job = await waitJob(ctx, started.json<BackupJobStarted>().jobId);
    expect(job.error).toBeNull();
    expect(job.state).toBe('succeeded');
    const result = job.restore!;
    expect(result.upgraded).toBe(true);
    expect(result.archiveSchemaVersion).toBe(52);
    expect(result.archiveVersion).toBe('0.31.0');
    // No checksums in a file of that time: restored all the same, the proof is the row counts.
    expect(result.verified).toBe(false);
    expect(result.identityAdopted).toBe(false);
    expect(result.filesRestored).toBe(1);

    // The schema is still today's.
    const version = await ctx.pool.query<{ v: number }>(
      'SELECT max(version)::int AS v FROM schema_migrations',
    );
    expect(version.rows[0]!.v).toBe(ctx.app.schemaVersion);
    // The data of that time is here, in today's shape (a column added by a later migration).
    const product = await ctx.pool.query<{ name: string; image_thumb_path: string | null }>(
      `SELECT name, image_thumb_path FROM products WHERE sku = 'OLD-1'`,
    );
    expect(product.rows).toEqual([{ name: 'Kola e vjetër', image_thumb_path: null }]);
    const customer = await ctx.pool.query(`SELECT 1 FROM customers WHERE code = 'C0001'`);
    expect(customer.rowCount).toBe(1);
    // A migration newer than the file ran over its data: the permission added by 0053 is there
    // and the owner role has it. Loading the old rows as they were would have lost it.
    const live = await ctx.pool.query(
      `SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE r.code = 'owner' AND rp.permission_code = 'live.view'`,
    );
    expect(live.rowCount).toBe(1);
    // Tables that did not exist then exist now, empty.
    const offers = await ctx.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM offers');
    expect(offers.rows[0]!.n).toBe(0);
    const beats = await ctx.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM station_heartbeats',
    );
    expect(beats.rows[0]!.n).toBe(0);
    const device = await ctx.pool.query<{ status: string; token_hash: string }>(
      `SELECT status, token_hash FROM station_devices WHERE machine_id = 'pc-52'`,
    );
    expect(device.rows).toEqual([{ status: 'approved', token_hash: 'token-52' }]);
    expect(await fsp.readFile(path.join(root, 'uploads-now', 'products', 'old.jpg'), 'utf8')).toBe(
      'OLD-PICTURE',
    );
    // The owner of that time signs in, and the program works on the data.
    const session = await login(ctx.app, OWNER.username, OWNER.password);
    expect(session.user.permissions).toContain('live.view');
    const products = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/products?q=kola',
      headers: authHeader(session.token),
    });
    expect(products.statusCode).toBe(200);
    expect(products.body).toContain('Kola e vjetër');
    // The scratch database used for the upgrade is gone.
    const scratch = await ctx.pool.query(
      `SELECT datname FROM pg_database WHERE datname LIKE 'likapcs_restore_%'`,
    );
    expect(scratch.rows).toEqual([]);
  }, 120_000);

  it('a file that only claims to be old is refused, and nothing changes', async () => {
    const session = await login(ctx!.app, OWNER.username, OWNER.password);
    const headers = authHeader(session.token);
    const made = await ctx!.app.inject({ method: 'POST', url: '/api/v1/backups', headers });
    expect(made.statusCode).toBe(201);
    const current = path.join(root, 'backups-now', made.json<BackupSummary>().fileName!);
    // Today's tables under the label of schema version 1: they do not fit that schema.
    const doctored = path.join(root, 'claims-v1.likapcs-backup.tar.gz');
    await repack(current, doctored, async (_dir, manifest) => ({ ...manifest, schemaVersion: 1 }));
    const upload = await ctx!.app.inject({
      method: 'POST',
      url: '/api/v1/backups/upload?fileName=claims-v1',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: await fsp.readFile(doctored),
    });
    expect(upload.statusCode).toBe(201);
    const dbBefore = await fingerprint(ctx!.pool);
    const started = await ctx!.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${upload.json<BackupSummary>().id}/restore-job`,
      headers,
      payload: { password: OWNER.password, confirm: true },
    });
    expect(started.statusCode).toBe(202);
    const job = await waitJob(ctx!, started.json<BackupJobStarted>().jobId);
    expect(job.state).toBe('failed');
    expect(job.error!.code).toBe('ARCHIVE_UPGRADE_FAILED');
    expect(await fingerprint(ctx!.pool)).toEqual(dbBefore);
    const scratch = await ctx!.pool.query(
      `SELECT datname FROM pg_database WHERE datname LIKE 'likapcs_restore_%'`,
    );
    expect(scratch.rows).toEqual([]);
  }, 120_000);
});
