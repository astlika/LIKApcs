/**
 * 0.41.0 — «Backup file» written as ONE JSON document, and restored from it.
 *
 *  - the document is valid JSON and holds every table (row by row) and every uploaded file;
 *  - values that are hard to carry — an empty text next to an empty (NULL) value, quotes, commas,
 *    line breaks, letters of several bytes, a text of almost two megabytes — come back exactly;
 *  - a fresh installation loads the file from its first screen: every row and every file is back,
 *    the accounts work, the gaming PCs keep their approval;
 *  - the file is known by what it holds, whatever name it arrives under;
 *  - with a password it opens only with that password;
 *  - a file that was cut off or changed is refused before anything is changed;
 *  - a JSON file made by an older version is brought up to this one.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
import { isJsonArchiveFile, readJsonManifestText } from '../../src/services/backup-json.js';
import { BackupService, formatOfName, nameForContents } from '../../src/services/backups.js';
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

/** The whole document, as any JSON reader gives it. */
interface JsonDocument {
  format: string;
  formatVersion: number;
  readme: string;
  manifest: BackupManifest;
  tables: {
    name: string;
    columns?: string[];
    rows?: (string | null)[][];
    csvBase64?: string[];
  }[];
  files: { path: string; bytes: number; sha256: string; base64: string[] }[];
  end: { tables: number; rows: number; files: number; fileBytes: number; manifestSha256: string };
}

// Values that are easy to lose on the way through a text file.
const HARD_NAME = 'Pica "familjare", me\nproshutë 😀';
const HARD_BRAND = 'rreshti 1\r\nrreshti 2';
const HARD_PLACE = '\\.';
/** Almost two megabytes: longer than any piece the file is read in. */
const LONG_TEXT = 'Ë"€,\n😀'.repeat(150_000);

describe('backup file as JSON (0.41.0)', () => {
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

  const uploadFresh = (ctx: TestContext, file: string, name = path.basename(file)) =>
    fsp.readFile(file).then((payload) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/system/restore/upload?fileName=${encodeURIComponent(name)}`,
        headers: { 'content-type': 'application/octet-stream' },
        payload,
      }),
    );

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-backup-json-'));
    ctxOld = await createTestContext(
      {
        backupDir: path.join(root, 'backups-old'),
        dataDir: path.join(root, 'data-old'),
        uploadDir: uploadsOld(),
      },
      { installationId: OLD_INSTALLATION },
    );
    owner = await runSetup(ctxOld.app, 'Lika "Gaming", Mitrovicë');
    ownerHash = (
      await ctxOld.pool.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE username = $1',
        [OWNER.username],
      )
    ).rows[0]!.password_hash;
    for (const name of ['Coca-Cola 0.33l', 'Ujë 0.5l', 'Çokollatë', 'Pica']) {
      const res = await oldCall<{ id: string }>('POST', '/products', {
        name,
        sellingPriceCents: 120,
        purchaseCostCents: 70,
        initialStockMilli: 24_000,
      });
      expect(res.status).toBe(201);
    }
    await oldCall('POST', '/customers', { name: 'Arben Krasniqi', phone: '044 111 222' });
    await oldCall('POST', '/customers', { name: 'Blerta Hoxha' });
    // The hard values go straight into the tables (the API would trim or refuse some of them).
    await ctxOld.pool.query(
      `UPDATE products
          SET name = $1, brand = $2, storage_location = $3, description = $4
        WHERE name = 'Pica'`,
      [HARD_NAME, HARD_BRAND, HARD_PLACE, LONG_TEXT],
    );
    // An empty text is not an empty value: both must come back as what they were.
    await ctxOld.pool.query(
      `UPDATE products SET description = '', brand = NULL WHERE name = 'Çokollatë'`,
    );
    await ctxOld.pool.query(
      `UPDATE customers SET notes = '', email = NULL, phone = ' 044,111 ' WHERE name = 'Blerta Hoxha'`,
    );
    await ctxOld.pool.query(
      `INSERT INTO station_devices (machine_id, status, token_hash, registration_secret_hash)
       VALUES ('pc-old-1', 'approved', 'token-hash-1', 'secret-hash-1')`,
    );
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
    // Exactly one piece, and one byte more than a piece.
    await put('products/piece.bin', crypto.randomBytes(48 * 1024));
    await put('products/piece-plus.bin', crypto.randomBytes(48 * 1024 + 1));
    // An upload that is still arriving is not part of a backup.
    await put('videos/half.part', crypto.randomBytes(5_000));
  }, 60_000);

  afterAll(async () => {
    await ctxOld?.close().catch(() => undefined);
    await ctxNew?.close().catch(() => undefined);
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('writes one JSON document with every table and every uploaded file, checked', async () => {
    before = await fingerprint(ctxOld!.pool);
    filesBefore = await fileHashes(uploadsOld());
    delete filesBefore['videos/half.part'];

    // Something that is not a way to write the file is refused.
    const bad = await oldCall<{ error: { code: string } }>('POST', '/backups/file', {
      format: 'xml',
    });
    expect(bad.status).toBe(400);

    const started = await oldCall<BackupJobStarted>('POST', '/backups/file', { format: 'json' });
    expect(started.status).toBe(202);
    const job = await waitJob(ctxOld!, started.body.jobId);
    expect(job.error).toBeNull();
    expect(job.state).toBe('succeeded');
    const result = job.backup!;
    expect(result.verified).toBe(true);
    expect(result.backup.kind).toBe('manual');
    expect(result.backup.format).toBe('json');
    expect(result.backup.encrypted).toBe(false);
    expect(result.backup.fileName).toMatch(/^likapcs-manual-\d{8}-\d{6}\.likapcs-backup\.json$/);
    expect(result.contents.businessName).toBe('Lika "Gaming", Mitrovicë');
    expect(result.contents.files).toBe(Object.keys(filesBefore).length);
    expect(result.contents.tables).toBeGreaterThan(60);

    const file = path.join(root, 'backups-old', result.backup.fileName!);
    expect(await isJsonArchiveFile(file)).toBe(true);
    // Any program that reads JSON reads the whole file.
    const text = await fsp.readFile(file, 'utf8');
    const doc = JSON.parse(text) as JsonDocument;
    expect(doc.format).toBe('likapcs-backup-json');
    expect(doc.formatVersion).toBe(1);
    expect(doc.readme).toContain('Rikthe nga kopja');
    expect(doc.manifest.installationId).toBe(OLD_INSTALLATION);
    expect(JSON.parse(await readJsonManifestText(file))).toEqual(doc.manifest);

    // Every table of the database is there, as rows (none had to be written as raw bytes).
    const inDatabase = await ctxOld!.pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
    );
    expect(doc.tables.map((t) => t.name).sort()).toEqual(
      inDatabase.rows.map((r) => r.tablename).sort(),
    );
    expect(doc.tables.filter((t) => t.csvBase64 !== undefined)).toEqual([]);
    expect(doc.tables.map((t) => [t.name, t.rows!.length])).toEqual(
      doc.manifest.tables.map((t) => [t.name, t.rows]),
    );
    expect(doc.end.tables).toBe(doc.tables.length);
    expect(doc.end.rows).toBe(doc.tables.reduce((n, t) => n + t.rows!.length, 0));
    expect(doc.end.rows).toBe(doc.manifest.tables.reduce((n, t) => n + t.rows, 0));
    // (What the owner is shown leaves out the tables a restore does not bring back.)
    expect(result.contents.rows).toBeGreaterThan(50);
    expect(result.contents.rows).toBeLessThanOrEqual(doc.end.rows);
    for (const table of doc.tables) {
      for (const row of table.rows!) expect(row).toHaveLength(table.columns!.length);
    }

    // The hard values are in the file as they are in the database.
    const products = doc.tables.find((t) => t.name === 'products')!;
    const column = (name: string) => products.columns!.indexOf(name);
    const pica = products.rows!.find((r) => r[column('name')] === HARD_NAME)!;
    expect(pica).toBeDefined();
    expect(pica[column('brand')]).toBe(HARD_BRAND);
    expect(pica[column('storage_location')]).toBe(HARD_PLACE);
    expect(pica[column('description')]).toBe(LONG_TEXT);
    const chocolate = products.rows!.find((r) => r[column('name')] === 'Çokollatë')!;
    expect(chocolate[column('description')]).toBe('');
    expect(chocolate[column('brand')]).toBeNull();
    const customers = doc.tables.find((t) => t.name === 'customers')!;
    const blerta = customers.rows!.find(
      (r) => r[customers.columns!.indexOf('name')] === 'Blerta Hoxha',
    )!;
    expect(blerta[customers.columns!.indexOf('notes')]).toBe('');
    expect(blerta[customers.columns!.indexOf('email')]).toBeNull();
    expect(blerta[customers.columns!.indexOf('phone')]).toBe(' 044,111 ');
    // The owner's account is in it (the password as its hash, never as text).
    const users = doc.tables.find((t) => t.name === 'users')!;
    expect(
      users.rows!.some(
        (r) =>
          r[users.columns!.indexOf('username')] === OWNER.username &&
          r[users.columns!.indexOf('password_hash')] === ownerHash,
      ),
    ).toBe(true);
    expect(text).not.toContain(OWNER.password);

    // Every uploaded file is there with its bytes.
    expect(Object.fromEntries(doc.files.map((f) => [f.path, f.sha256]))).toEqual(filesBefore);
    for (const item of doc.files) {
      const data = Buffer.concat(item.base64.map((piece) => Buffer.from(piece, 'base64')));
      expect(data.length).toBe(item.bytes);
      expect(crypto.createHash('sha256').update(data).digest('hex')).toBe(item.sha256);
    }
    expect(doc.end.files).toBe(doc.files.length);
    expect(doc.end.fileBytes).toBe(doc.files.reduce((n, f) => n + f.bytes, 0));

    // It is listed like any other backup, and the list says how it is written.
    const list = await oldCall<{ items: BackupSummary[] }>('GET', '/backups');
    const listed = list.body.items.find((b) => b.id === result.backup.id)!;
    expect(listed.format).toBe('json');
    expect(listed.sizeBytes).toBe(Buffer.byteLength(text));
    // The packed archive is still what is made when nothing is asked for.
    const plain = await oldCall<BackupJobStarted>('POST', '/backups/file', {});
    expect(plain.status).toBe(202);
    const packed = await waitJob(ctxOld!, plain.body.jobId);
    expect(packed.backup!.backup.format).toBe('archive');
    expect(packed.backup!.backup.fileName).toMatch(/\.likapcs-backup\.tar\.gz$/);
    // (Making it wrote nothing into the tables that are compared.)
    expect(await fingerprint(ctxOld!.pool)).toEqual(before);
  }, 120_000);

  it('is saved as a .json file through the download link', async () => {
    const list = await oldCall<{ items: BackupSummary[] }>('GET', '/backups');
    const backup = list.body.items.find((b) => b.format === 'json')!;
    const ticket = await oldCall<BackupDownloadTicket>(
      'POST',
      `/backups/${backup.id}/download-ticket`,
    );
    expect(ticket.status).toBe(200);
    const res = await ctxOld!.app.inject({
      method: 'GET',
      url: `/api/v1/backups/${backup.id}/download?ticket=${ticket.body.ticket}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toContain(backup.fileName!);
    expect(Number(res.headers['content-length'])).toBe(backup.sizeBytes);
    expect(crypto.createHash('sha256').update(res.rawPayload).digest('hex')).toBe(backup.sha256);
    // "Saved anywhere": here, a folder that stands for the USB stick.
    savedFile = path.join(root, 'usb', 'LIKApcs-kopje.likapcs-backup.json');
    await fsp.mkdir(path.dirname(savedFile), { recursive: true });
    await fsp.writeFile(savedFile, res.rawPayload);
  });

  it('a fresh installation loads the JSON file: everything is back', async () => {
    await ctxOld!.close();
    ctxOld = null;
    ctxNew = await createTestContext(
      {
        backupDir: path.join(root, 'backups-new'),
        dataDir: path.join(root, 'data-new'),
        uploadDir: uploadsNew(),
      },
      { installationId: NEW_INSTALLATION, adoptInstallationId: (id) => void adopted.push(id) },
    );
    const setup = () =>
      ctxNew!.app
        .inject({ method: 'GET', url: '/api/v1/system/setup-status' })
        .then((r) => r.json<{ needsSetup: boolean; businessName: string }>());
    expect((await setup()).needsSetup).toBe(true);

    const upload = await uploadFresh(ctxNew, savedFile);
    expect(upload.statusCode).toBe(201);
    const uploaded = upload.json<BackupUploadResult>();
    expect(uploaded.backup.format).toBe('json');
    expect(uploaded.backup.fileName).toBe('LIKApcs-kopje.likapcs-backup.json');
    expect(uploaded.contents.businessName).toBe('Lika "Gaming", Mitrovicë');
    expect(uploaded.contents.files).toBe(Object.keys(filesBefore).length);

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
    // Checked against the checksums of the dump: the tables that came out of the JSON file are,
    // byte for byte, the tables PostgreSQL wrote on the old PC.
    expect(result.verified).toBe(true);
    expect(result.upgraded).toBe(false);
    expect(result.identityAdopted).toBe(true);
    expect(result.filesRestored).toBe(Object.keys(filesBefore).length);
    expect(result.tablesRestored).toBe(uploaded.contents.tables);
    expect(result.rowsRestored).toBe(uploaded.contents.rows);
    expect(result.fileBytesRestored).toBe(uploaded.contents.fileBytes);

    // 100 %: every table has the same rows, every file the same bytes.
    expect(await fingerprint(ctxNew.pool)).toEqual(before);
    expect(await fileHashes(uploadsNew())).toEqual(filesBefore);
    // The hard values, read from the new database.
    const pica = await ctxNew.pool.query<{
      brand: string | null;
      storage_location: string | null;
      description: string | null;
    }>(`SELECT brand, storage_location, description FROM products WHERE name = $1`, [HARD_NAME]);
    expect(pica.rows).toEqual([
      { brand: HARD_BRAND, storage_location: HARD_PLACE, description: LONG_TEXT },
    ]);
    const chocolate = await ctxNew.pool.query<{ brand: string | null; description: string | null }>(
      `SELECT brand, description FROM products WHERE name = 'Çokollatë'`,
    );
    expect(chocolate.rows).toEqual([{ brand: null, description: '' }]);
    const blerta = await ctxNew.pool.query<{
      notes: string | null;
      email: string | null;
      phone: string | null;
    }>(`SELECT notes, email, phone FROM customers WHERE name = 'Blerta Hoxha'`);
    expect(blerta.rows).toEqual([{ notes: '', email: null, phone: ' 044,111 ' }]);
    // The accounts of the old PC work.
    expect((await setup()).needsSetup).toBe(false);
    expect((await setup()).businessName).toBe('Lika "Gaming", Mitrovicë');
    const session = await login(ctxNew.app, OWNER.username, OWNER.password);
    expect(session.user.username).toBe(OWNER.username);
    // This server is now the old installation, and the PCs keep their approval.
    expect(adopted).toEqual([OLD_INSTALLATION]);
    const devices = await ctxNew.pool.query<{ status: string; token_hash: string | null }>(
      `SELECT status, token_hash FROM station_devices WHERE machine_id = 'pc-old-1'`,
    );
    expect(devices.rows).toEqual([{ status: 'approved', token_hash: 'token-hash-1' }]);
    // The program works on the data that came back.
    const products = await ctxNew.app.inject({
      method: 'GET',
      url: '/api/v1/products?q=coca',
      headers: authHeader(session.token),
    });
    expect(products.statusCode).toBe(200);
    expect(products.body).toContain('Coca-Cola 0.33l');
    // Nothing is left behind in the backup folder.
    const leftovers = (await fsp.readdir(path.join(root, 'backups-new'))).filter((n) =>
      n.startsWith('.'),
    );
    expect(leftovers).toEqual([]);
  }, 120_000);

  it('is known by what it holds, whatever name it arrives under', async () => {
    const session = await login(ctxNew!.app, OWNER.username, OWNER.password);
    const upload = async (name: string) => {
      const res = await ctxNew!.app.inject({
        method: 'POST',
        url: `/api/v1/backups/upload?fileName=${encodeURIComponent(name)}`,
        headers: { ...authHeader(session.token), 'content-type': 'application/octet-stream' },
        payload: await fsp.readFile(savedFile),
      });
      expect(res.statusCode).toBe(201);
      return res.json<BackupSummary>();
    };
    // Renamed to a plain .json, to the name of the packed kind, to nothing at all.
    const short = await upload('kopja.json');
    expect(short.fileName).toBe('kopja.likapcs-backup.json');
    expect(short.format).toBe('json');
    const wrong = await upload('e-pakuar.likapcs-backup.tar.gz');
    expect(wrong.fileName).toBe('e-pakuar.likapcs-backup.json');
    expect(wrong.format).toBe('json');
    const bare = await upload('pa-emer');
    expect(bare.fileName).toBe('pa-emer.likapcs-backup.json');
    // The same name twice gets a number, in front of the ending.
    const again = await upload('kopja.json');
    expect(again.fileName).toBe('kopja-2.likapcs-backup.json');
    for (const name of [short, wrong, bare, again].map((b) => b.fileName!)) {
      expect(await isJsonArchiveFile(path.join(root, 'backups-new', name))).toBe(true);
    }

    expect(formatOfName('a.likapcs-backup.json')).toBe('json');
    expect(formatOfName('a.likapcs-backup.json.enc')).toBe('json');
    expect(formatOfName('a.likapcs-backup.tar.gz.enc')).toBe('archive');
    expect(formatOfName(null)).toBe('archive');
    expect(nameForContents('a.likapcs-backup.json', 'json', false)).toBe('a.likapcs-backup.json');
    expect(nameForContents('a.likapcs-backup.tar.gz', 'json', true)).toBe(
      'a.likapcs-backup.json.enc',
    );
    expect(nameForContents('a.enc', 'json', true)).toBe('a.likapcs-backup.json.enc');
    // A packed archive keeps the name it always had.
    expect(nameForContents('a.enc', 'archive', true)).toBe('a.enc');
    expect(nameForContents('a.likapcs-backup.tar.gz', 'archive', false)).toBe(
      'a.likapcs-backup.tar.gz',
    );
  }, 60_000);

  it('with a password of its own it opens only with it', async () => {
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

    const filePassword = 'sekret-€-ë-1234';
    const atBackup = await fingerprint(ctxNew!.pool);
    const started = await call<BackupJobStarted>('POST', '/backups/file', {
      format: 'json',
      password: filePassword,
    });
    expect(started.status).toBe(202);
    const job = await waitJob(ctxNew!, started.body.jobId);
    expect(job.error).toBeNull();
    expect(job.state).toBe('succeeded');
    const backup = job.backup!.backup;
    expect(backup.encrypted).toBe(true);
    expect(backup.format).toBe('json');
    expect(backup.fileName).toMatch(/\.likapcs-backup\.json\.enc$/);
    const file = path.join(root, 'backups-new', backup.fileName!);
    expect(await isEncryptedFile(file)).toBe(true);
    // Nothing of the data can be read in the file.
    const bytes = await fsp.readFile(file);
    expect(bytes.includes(Buffer.from('likapcs-backup-json'))).toBe(false);
    expect(bytes.includes(Buffer.from('Coca-Cola'))).toBe(false);

    // Loading it again as another PC would, under a name that says nothing.
    const upload = (passwordHeader: Record<string, string> = {}) =>
      fsp.readFile(file).then((payload) =>
        ctxNew!.app.inject({
          method: 'POST',
          url: '/api/v1/backups/upload?fileName=nga-usb.enc',
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
    const wrong = await upload({ 'x-archive-password': 'gabim-9999' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json<{ error: { code: string } }>().error.code).toBe('ARCHIVE_PASSWORD_WRONG');
    const good = await upload({ 'x-archive-password-utf8': encodeURIComponent(filePassword) });
    expect(good.statusCode).toBe(201);
    const uploaded = good.json<BackupSummary>();
    expect(uploaded.fileName).toBe('nga-usb.likapcs-backup.json.enc');
    expect(uploaded.format).toBe('json');
    expect(uploaded.encrypted).toBe(true);
    const kept = (await fsp.readdir(path.join(root, 'backups-new'))).filter((n) =>
      n.startsWith('nga-usb'),
    );
    expect(kept).toEqual(['nga-usb.likapcs-backup.json.enc']);

    const refuse = await call<{ error: { code: string } }>(
      'POST',
      `/backups/${uploaded.id}/restore-job`,
      { password: OWNER.password, confirm: true, archivePassword: 'gabim-9999' },
    );
    expect(refuse.status).toBe(403);
    expect(refuse.body.error.code).toBe('ARCHIVE_PASSWORD_WRONG');

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
    expect(restored.restore!.identityAdopted).toBe(false);
    expect(await fingerprint(ctxNew!.pool)).toEqual(atBackup);
    expect(await fileHashes(uploadsNew())).toEqual(filesBefore);
    const later = await ctxNew!.pool.query(`SELECT 1 FROM customers WHERE name = 'Erdhi më vonë'`);
    expect(later.rowCount).toBe(0);
  }, 120_000);

  it('refuses a JSON file that was cut off or changed, and changes nothing', async () => {
    const session = await login(ctxNew!.app, OWNER.username, OWNER.password);
    const headers = authHeader(session.token);
    const text = await fsp.readFile(savedFile, 'utf8');
    let counter = 0;
    /** Uploads `content` and tries to restore it; returns where it was refused and why. */
    const tryRestore = async (content: string | Buffer) => {
      counter += 1;
      const upload = await ctxNew!.app.inject({
        method: 'POST',
        url: `/api/v1/backups/upload?fileName=provë-${counter}.likapcs-backup.json`.replace(
          'ë',
          'e',
        ),
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        payload: content,
      });
      if (upload.statusCode !== 201) {
        const error = upload.json<{ error: { code: string; message: string } }>().error;
        return { at: 'upload' as const, status: upload.statusCode, ...error };
      }
      const started = await ctxNew!.app.inject({
        method: 'POST',
        url: `/api/v1/backups/${upload.json<BackupSummary>().id}/restore-job`,
        headers,
        payload: { password: OWNER.password, confirm: true },
      });
      if (started.statusCode !== 202) {
        const error = started.json<{ error: { code: string; message: string } }>().error;
        return { at: 'start' as const, status: started.statusCode, ...error };
      }
      const job = await waitJob(ctxNew!, started.json<BackupJobStarted>().jobId);
      expect(job.state).toBe('failed');
      return { at: 'job' as const, status: 0, ...job.error! };
    };
    const dbBefore = await fingerprint(ctxNew!.pool);
    const filesNow = await fileHashes(uploadsNew());
    const foldersBefore = (await fsp.readdir(path.join(root, 'backups-new'))).filter((n) =>
      n.startsWith('.'),
    );

    // 1. The copy to the USB stick stopped half-way: the file ends inside a picture.
    const half = await tryRestore(text.slice(0, Math.floor(text.length * 0.7)));
    expect(half).toMatchObject({ at: 'job', code: 'ARCHIVE_CORRUPT' });
    expect(half.message).toContain('Asgjë nuk u ndryshua');
    // 2. Only the last line is missing.
    const noEnd = await tryRestore(text.slice(0, text.lastIndexOf('"end"')));
    expect(noEnd).toMatchObject({ at: 'job', code: 'ARCHIVE_CORRUPT' });
    // 3. So little of it arrived that it cannot even say what it holds: refused at once.
    const stub = await tryRestore(text.slice(0, 120));
    expect(stub).toMatchObject({ at: 'upload', status: 409, code: 'ARCHIVE_CORRUPT' });
    // 4. Another program saved it "nicely": it is JSON, but no longer what was written.
    const pretty = await tryRestore(JSON.stringify(JSON.parse(text), null, 2));
    expect(pretty).toMatchObject({ at: 'upload', status: 409, code: 'ARCHIVE_CORRUPT' });
    // 5. One value edited by hand: the table is not the one that was written.
    const edited = await tryRestore(text.replace('"Coca-Cola 0.33l"', '"Coca-Cola 0.50l"'));
    expect(edited).toMatchObject({ at: 'job', code: 'ARCHIVE_INCOMPLETE' });
    expect(edited.message).toContain('products');
    // 6. A row taken out.
    const users = text.indexOf('{"name":"users","columns":');
    const firstRow = text.indexOf('\n', users) + 1;
    const afterRow = text.indexOf('\n', firstRow) + 1;
    const fewer = await tryRestore(text.slice(0, firstRow) + text.slice(afterRow));
    expect(fewer.at).toBe('job');
    expect(['ARCHIVE_CORRUPT', 'ARCHIVE_INCOMPLETE']).toContain(fewer.code);
    // 7. A picture with other bytes of the same length.
    const lines = text.split('\n');
    const at = lines.findIndex((line) => line.startsWith('{"path":"products/bb22.png"')) + 1;
    const piece = lines[at]!;
    lines[at] = `"${piece[1] === 'A' ? 'B' : 'A'}${piece.slice(2)}`;
    const flipped = await tryRestore(lines.join('\n'));
    expect(flipped).toMatchObject({ at: 'job', code: 'ARCHIVE_CORRUPT' });
    expect(flipped.message).toContain('products/bb22.png');
    // 8. A file made by a newer version of the program is refused before any work.
    const manifestLine = text.split('\n')[2]!;
    const manifest = JSON.parse(manifestLine.slice('"manifest":'.length, -1)) as BackupManifest;
    const newerManifest = JSON.stringify({
      ...manifest,
      serverVersion: '99.0.0',
      schemaVersion: manifest.schemaVersion + 1,
    });
    const newer = await tryRestore(text.replace(manifestLine, `"manifest":${newerManifest},`));
    expect(newer).toMatchObject({ at: 'start', code: 'ARCHIVE_NEWER' });
    // 9. Something that is JSON but not a backup, and something that is nothing.
    const other = await tryRestore('{"hello":"world"}\n');
    expect(other).toMatchObject({ at: 'upload', status: 400 });
    const nothing = await tryRestore(crypto.randomBytes(4_000));
    expect(nothing).toMatchObject({ at: 'upload', status: 400 });

    // Nothing was changed by any of them, and no half-read folder is left.
    expect(await fingerprint(ctxNew!.pool)).toEqual(dbBefore);
    expect(await fileHashes(uploadsNew())).toEqual(filesNow);
    const foldersAfter = (await fsp.readdir(path.join(root, 'backups-new'))).filter((n) =>
      n.startsWith('.'),
    );
    expect(foldersAfter).toEqual(foldersBefore);
    // A file saved by Windows tools with a mark in front and other line ends is still taken.
    const windows = await ctxNew!.app.inject({
      method: 'POST',
      url: '/api/v1/backups/upload?fileName=windows.likapcs-backup.json',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: `\uFEFF${text.replace(/\n/g, '\r\n')}`,
    });
    expect(windows.statusCode).toBe(201);
    const started = await ctxNew!.app.inject({
      method: 'POST',
      url: `/api/v1/backups/${windows.json<BackupSummary>().id}/restore-job`,
      headers,
      payload: { password: OWNER.password, confirm: true },
    });
    expect(started.statusCode).toBe(202);
    const job = await waitJob(ctxNew!, started.json<BackupJobStarted>().jobId);
    expect(job.error).toBeNull();
    expect(job.restore!.verified).toBe(true);
    expect(await fileHashes(uploadsNew())).toEqual(filesBefore);
  }, 180_000);
});

describe('JSON backup made by an older version (0.41.0)', () => {
  let root: string;
  let ctx: TestContext | null = null;
  let oldFile = '';
  let ownerHash = '';

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-backup-json-old-'));
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

    // The database as LIKApcs had it at schema version 52, written as JSON by the same code
    // (a JSON file of today, opened by a later version, goes this way).
    const pool = createPool(config.databaseUrl!, { max: 3 });
    try {
      await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await runMigrations(pool, config.migrationsDir, undefined, { upTo: 52 });
      const user = await pool.query<{ id: string }>(
        `INSERT INTO users (username, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
        [OWNER.username, OWNER.fullName, ownerHash],
      );
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'owner'`,
        [user.rows[0]!.id],
      );
      await pool.query(
        `INSERT INTO products (name, sku, selling_price_cents, description)
         VALUES ('Kola "e vjetër", 0.5l', 'OLD-1', 150, '')`,
      );
      await pool.query(`INSERT INTO customers (code, name) VALUES ('C0001', 'Klient i vjetër')`);
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
      const made = await service.create({ kind: 'manual', actor: null, format: 'json' });
      expect(made.format).toBe('json');
      oldFile = path.join(root, 'backups-52', made.fileName!);
      const manifest = JSON.parse(await readJsonManifestText(oldFile)) as BackupManifest;
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
      url: `/api/v1/system/restore/upload?fileName=${path.basename(oldFile)}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: await fsp.readFile(oldFile),
    });
    expect(upload.statusCode).toBe(201);
    const uploaded = upload.json<BackupUploadResult>();
    expect(uploaded.contents.schemaVersion).toBe(52);
    expect(uploaded.backup.format).toBe('json');

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
    expect(result.verified).toBe(true);
    expect(result.filesRestored).toBe(1);

    const version = await ctx.pool.query<{ v: number }>(
      'SELECT max(version)::int AS v FROM schema_migrations',
    );
    expect(version.rows[0]!.v).toBe(ctx.app.schemaVersion);
    // The data of that time is here, in today's shape.
    const product = await ctx.pool.query<{
      name: string;
      description: string | null;
      image_thumb_path: string | null;
    }>(`SELECT name, description, image_thumb_path FROM products WHERE sku = 'OLD-1'`);
    expect(product.rows).toEqual([
      { name: 'Kola "e vjetër", 0.5l', description: '', image_thumb_path: null },
    ]);
    // A migration newer than the file ran over its data.
    const live = await ctx.pool.query(
      `SELECT 1 FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE r.code = 'owner' AND rp.permission_code = 'live.view'`,
    );
    expect(live.rowCount).toBe(1);
    expect(await fsp.readFile(path.join(root, 'uploads-now', 'products', 'old.jpg'), 'utf8')).toBe(
      'OLD-PICTURE',
    );
    const session = await login(ctx.app, OWNER.username, OWNER.password);
    expect(session.user.permissions).toContain('live.view');
    const scratch = await ctx.pool.query(
      `SELECT datname FROM pg_database WHERE datname LIKE 'likapcs_restore_%'`,
    );
    expect(scratch.rows).toEqual([]);
  }, 120_000);
});
