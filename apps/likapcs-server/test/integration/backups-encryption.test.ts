/**
 * 0.26.0 — encrypted backups, the report inside the archive, the copy to an external folder,
 * and restore/upload of encrypted archives (with the local key, and with the password on another PC).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackupEncryptionStatus, BackupSummary, LoginResponse } from '@likapcs/shared';
import { decryptFile, deriveKey, readEncryptedHeader } from '../../src/services/backup-crypto.js';
import { authHeader, createTestContext, OWNER, runSetup, type TestContext } from '../helpers.js';

const ARCHIVE_PASSWORD = 'Arkiv-Kopje-2026';

describe('encrypted backups (0.26.0)', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let root: string;
  let backupDir: string;
  let externalDir: string;
  let dataDir: string;
  let keyFile: string;
  let encrypted: BackupSummary;

  const call = <T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
    ctx.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: authHeader(owner.token),
        payload: payload as object,
      })
      .then((r) => ({ status: r.statusCode, body: r.json() as T }));

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-enc-'));
    backupDir = path.join(root, 'backups');
    externalDir = path.join(root, 'usb');
    dataDir = path.join(root, 'data');
    keyFile = path.join(dataDir, 'backup-keys.json');
    await fsp.mkdir(externalDir, { recursive: true });
    ctx = await createTestContext({ backupDir, dataDir });
    owner = await runSetup(ctx.app);
  });

  afterAll(async () => {
    await ctx.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('sets the backup password only after the account password is re-confirmed', async () => {
    const wrong = await call<{ error: { code: string } }>('PUT', '/backups/encryption', {
      archivePassword: ARCHIVE_PASSWORD,
      password: 'nuk-eshte-ky',
      confirm: true,
    });
    expect(wrong.status).toBe(403);
    expect(fs.existsSync(keyFile)).toBe(false);

    const ok = await call<BackupEncryptionStatus>('PUT', '/backups/encryption', {
      archivePassword: ARCHIVE_PASSWORD,
      password: OWNER.password,
      confirm: true,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.enabled).toBe(true);
    expect(JSON.stringify(ok.body)).not.toContain(ARCHIVE_PASSWORD);
    expect(fs.existsSync(keyFile)).toBe(true);
    // The password itself is never written to the key file; only a derived key and its salt are.
    expect((await fsp.readFile(keyFile, 'utf8')).includes(ARCHIVE_PASSWORD)).toBe(false);
  });

  it('writes an encrypted archive whose report and manifest can be read with the password', async () => {
    const res = await call<BackupSummary>('POST', '/backups', undefined);
    expect(res.status).toBe(201);
    encrypted = res.body;
    expect(encrypted.fileName!.endsWith('.likapcs-backup.tar.gz.enc')).toBe(true);
    expect(encrypted.encrypted).toBe(true);
    expect(encrypted.externalCopy).toBeNull();

    const file = path.join(backupDir, encrypted.fileName!);
    const header = await readEncryptedHeader(file);
    const plain = path.join(root, 'check.tar.gz');
    await decryptFile(file, plain, deriveKey(ARCHIVE_PASSWORD, header.salt));
    const extracted = path.join(root, 'check');
    await fsp.mkdir(extracted);
    await tar.extract({ file: plain, cwd: extracted, strict: true });

    const report = await fsp.readFile(path.join(extracted, 'report.txt'), 'utf8');
    expect(report).toContain('RAPORTI I KOPJES');
    expect(report).toContain('Enkriptimi:         PO');
    expect(report).toContain('NUK PËRFSHIHEN NË KOPJE');
    expect(report).toMatch(/TABELAT \(\d+\)/);
    expect(fs.existsSync(path.join(extracted, 'manifest.json'))).toBe(true);
    // The key file lives outside the archive: it is not inside it.
    expect(fs.existsSync(path.join(extracted, 'backup-keys.json'))).toBe(false);
  });

  it('restores an encrypted backup on this PC without asking for the password', async () => {
    const res = await call<{ sessionKept: boolean }>('POST', `/backups/${encrypted.id}/restore`, {
      password: OWNER.password,
      confirm: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.sessionKept).toBe(true);
  });

  it('on another PC (no key here) asks for the password and refuses a wrong one', async () => {
    await fsp.rm(keyFile, { force: true });
    const asked = await call<{ error: { code: string } }>(
      'POST',
      `/backups/${encrypted.id}/restore`,
      {
        password: OWNER.password,
        confirm: true,
      },
    );
    expect(asked.status).toBe(400);
    expect(asked.body.error.code).toBe('ARCHIVE_PASSWORD_REQUIRED');

    const wrong = await call<{ error: { code: string } }>(
      'POST',
      `/backups/${encrypted.id}/restore`,
      {
        password: OWNER.password,
        confirm: true,
        archivePassword: 'nuk-eshte-ky-fjalekalim',
      },
    );
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('ARCHIVE_PASSWORD_WRONG');

    const right = await call<{ sessionKept: boolean }>('POST', `/backups/${encrypted.id}/restore`, {
      password: OWNER.password,
      confirm: true,
      archivePassword: ARCHIVE_PASSWORD,
    });
    expect(right.status).toBe(200);
  });

  it('copies the encrypted backup to the external folder and checks it by checksum', async () => {
    const set = await call<{ 'backup.external_dir': string }>('PATCH', '/settings', {
      'backup.external_dir': externalDir,
    });
    expect(set.status).toBe(200);
    // The key file was deleted above; set it again so new backups are encrypted.
    await call('PUT', '/backups/encryption', {
      archivePassword: ARCHIVE_PASSWORD,
      password: OWNER.password,
      confirm: true,
    });

    const res = await call<BackupSummary>('POST', '/backups', undefined);
    expect(res.status).toBe(201);
    const copy = res.body.externalCopy!;
    expect(copy.ok).toBe(true);
    expect(copy.error).toBeNull();
    expect(copy.path).toBe(path.join(externalDir, res.body.fileName!));
    expect(await sha256(copy.path!)).toBe(res.body.sha256);
  });

  it('a missing external folder does not fail the backup, and the reason is recorded', async () => {
    const missing = path.join(root, 'nuk-ekziston');
    await call('PATCH', '/settings', { 'backup.external_dir': missing });
    const res = await call<BackupSummary>('POST', '/backups', undefined);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('succeeded');
    expect(res.body.externalCopy?.ok).toBe(false);
    expect(res.body.externalCopy?.error).toContain('nuk u gjet');
  });

  it('uploads an encrypted archive: no password needed where the key is known, a password elsewhere', async () => {
    await call('PATCH', '/settings', { 'backup.external_dir': '' });
    // A fresh backup made with the key this PC has now (the earlier key file was removed on purpose).
    const fresh = await call<BackupSummary>('POST', '/backups', undefined);
    expect(fresh.body.encrypted).toBe(true);
    const bytes = await fsp.readFile(path.join(backupDir, fresh.body.fileName!));

    const upload = (name: string, password?: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/backups/upload?fileName=${encodeURIComponent(name)}`,
        headers: {
          ...authHeader(owner.token),
          'content-type': 'application/octet-stream',
          ...(password ? { 'x-archive-password': password } : {}),
        },
        payload: bytes,
      });

    const known = await upload('kopje-me-celes.likapcs-backup.tar.gz.enc');
    expect(known.statusCode).toBe(201);
    expect(known.json().encrypted).toBe(true);

    // Key file removed: this PC no longer knows the password.
    await fsp.rm(keyFile, { force: true });
    const asked = await upload('kopje-tjeter.likapcs-backup.tar.gz.enc');
    expect(asked.statusCode).toBe(400);
    expect(asked.json().error.code).toBe('ARCHIVE_PASSWORD_REQUIRED');
    // A refused upload leaves no file behind.
    expect(fs.existsSync(path.join(backupDir, 'kopje-tjeter.likapcs-backup.tar.gz.enc'))).toBe(
      false,
    );

    const wrong = await upload('kopje-tjeter.likapcs-backup.tar.gz.enc', 'fjalekalim-gabim-1');
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('ARCHIVE_PASSWORD_WRONG');

    const right = await upload('kopje-tjeter.likapcs-backup.tar.gz.enc', ARCHIVE_PASSWORD);
    expect(right.statusCode).toBe(201);
  });
});

async function sha256(file: string): Promise<string> {
  return crypto
    .createHash('sha256')
    .update(await fsp.readFile(file))
    .digest('hex');
}
