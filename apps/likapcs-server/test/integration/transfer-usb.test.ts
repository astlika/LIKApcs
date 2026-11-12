/**
 * 0.27.5 — transfer to another PC with a USB stick.
 * The whole system goes into ONE encrypted file whose key comes from a 4-digit code. On a fresh
 * installation the file is uploaded and restored (no user yet). Devices of the old PC are revoked
 * and every old login session ends. Running gaming sessions block the export.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackupSummary, LoginResponse, RestoreResult } from '@likapcs/shared';
import {
  decryptFile,
  deriveKey,
  isEncryptedFile,
  readEncryptedHeader,
} from '../../src/services/backup-crypto.js';
import { isNewerVersion } from '../../src/services/backups.js';
import {
  authHeader,
  createTestContext,
  login,
  OWNER,
  runSetup,
  type TestContext,
} from '../helpers.js';

const CODE = '4821';

describe('isNewerVersion', () => {
  it('compares dotted versions numerically', () => {
    expect(isNewerVersion('0.27.5', '0.27.4')).toBe(true);
    expect(isNewerVersion('0.27.4', '0.27.4')).toBe(false);
    expect(isNewerVersion('0.27.3', '0.27.4')).toBe(false);
    expect(isNewerVersion('0.28.0', '0.27.9')).toBe(true);
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(false);
  });
});

describe('USB transfer (0.27.5)', () => {
  let root: string;
  let usbDir: string;
  let ctxOld: TestContext | null = null;
  let ctxNew: TestContext | null = null;
  let owner: LoginResponse;
  let transferFile: string;

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-transfer-'));
    usbDir = path.join(root, 'usb');
    await fsp.mkdir(usbDir, { recursive: true });
  });

  afterAll(async () => {
    await ctxOld?.close().catch(() => undefined);
    await ctxNew?.close().catch(() => undefined);
    await fsp.rm(root, { recursive: true, force: true });
  });

  const oldCall = <T>(method: 'GET' | 'POST', url: string, payload?: unknown) =>
    ctxOld!.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: authHeader(owner.token),
        payload: payload as object,
      })
      .then((r) => ({ status: r.statusCode, body: r.json() as T }));

  it('refuses a wrong password, a bad code and a missing USB folder', async () => {
    ctxOld = await createTestContext({
      backupDir: path.join(root, 'backups-old'),
      dataDir: path.join(root, 'data-old'),
    });
    owner = await runSetup(ctxOld.app);

    const wrongPassword = await oldCall<{ error: { code: string } }>('POST', '/backups/transfer', {
      password: 'nuk-eshte-ky',
      code: CODE,
      targetDir: usbDir,
    });
    expect(wrongPassword.status).toBe(403);

    const badCode = await oldCall('POST', '/backups/transfer', {
      password: OWNER.password,
      code: '12a4',
      targetDir: usbDir,
    });
    expect(badCode.status).toBe(400);

    const missing = await oldCall<{ error: { code: string } }>('POST', '/backups/transfer', {
      password: OWNER.password,
      code: CODE,
      targetDir: path.join(root, 'ska-usb'),
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('TRANSFER_TARGET_MISSING');
  }, 30_000);

  it('refuses the export while a gaming session is running', async () => {
    const station = await ctxOld!.pool.query<{ id: string }>(
      `INSERT INTO stations (number, code, name) VALUES (1, 'PC 01', 'PC 01') RETURNING id`,
    );
    const session = await ctxOld!.pool.query<{ id: string }>(
      `INSERT INTO gaming_sessions (station_id, billing_mode, status, rate_cents_per_hour, started_at)
       VALUES ($1, 'postpaid', 'active', 0, now()) RETURNING id`,
      [station.rows[0]!.id],
    );
    const blocked = await oldCall<{ error: { code: string } }>('POST', '/backups/transfer', {
      password: OWNER.password,
      code: CODE,
      targetDir: usbDir,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('TRANSFER_SESSIONS_RUNNING');

    await ctxOld!.pool.query(
      `UPDATE gaming_sessions SET status = 'cancelled', ended_at = now(), end_reason = 'cancelled'
        WHERE id = $1`,
      [session.rows[0]!.id],
    );
  });

  it('writes one encrypted file to the USB folder, not into the local backup list', async () => {
    await ctxOld!.pool.query(
      `INSERT INTO station_devices (machine_id, status, token_hash, registration_secret_hash)
       VALUES ('pc-old-1', 'approved', 'token-hash-1', 'secret-hash-1')`,
    );
    const listBefore = await oldCall<{ items: unknown[] }>('GET', '/backups');
    const before = listBefore.body.items.length;

    const res = await oldCall<{ fileName: string; path: string; sizeBytes: number }>(
      'POST',
      '/backups/transfer',
      { password: OWNER.password, code: CODE, targetDir: usbDir },
    );
    expect(res.status).toBe(200);
    expect(res.body.fileName).toMatch(/^LIKApcs-transfer-.*\.tar\.gz\.enc$/);
    transferFile = res.body.path;
    expect(path.dirname(transferFile)).toBe(usbDir);
    expect((await fsp.stat(transferFile)).size).toBe(res.body.sizeBytes);
    expect(await isEncryptedFile(transferFile)).toBe(true);

    const listAfter = await oldCall<{ items: unknown[] }>('GET', '/backups');
    expect(listAfter.body.items.length).toBe(before);
  });

  it('opens only with the 4-digit code', async () => {
    const { salt } = await readEncryptedHeader(transferFile);
    const wrong = path.join(root, 'wrong.tar.gz');
    await expect(decryptFile(transferFile, wrong, deriveKey('0000', salt))).rejects.toMatchObject({
      reason: 'wrong_password',
    });
    const plain = path.join(root, 'right.tar.gz');
    await decryptFile(transferFile, plain, deriveKey(CODE, salt));
    expect((await fsp.stat(plain)).size).toBeGreaterThan(0);
  });

  it('imports on a fresh installation: wrong code refused, right code restored', async () => {
    await ctxOld!.close();
    ctxOld = null;
    // A new PC: an empty database, no user yet.
    ctxNew = await createTestContext({
      backupDir: path.join(root, 'backups-new'),
      dataDir: path.join(root, 'data-new'),
    });
    const fileName = path.basename(transferFile);
    const fileBytes = await fsp.readFile(transferFile);
    const upload = (code: string) =>
      ctxNew!.app.inject({
        method: 'POST',
        url: `/api/v1/system/transfer/upload?fileName=${encodeURIComponent(fileName)}`,
        headers: {
          'content-type': 'application/octet-stream',
          'x-archive-password': code,
        },
        payload: fileBytes,
      });

    const badUpload = await upload('0000');
    expect(badUpload.statusCode).toBe(403);
    expect((await fsp.readdir(path.join(root, 'backups-new'))).some((n) => n === fileName)).toBe(
      false,
    );

    const good = await upload(CODE);
    expect(good.statusCode).toBe(201);
    const backup = good.json<BackupSummary>();

    const badRestore = await ctxNew!.app.inject({
      method: 'POST',
      url: '/api/v1/system/transfer/restore',
      payload: { backupId: backup.id, code: '0000' },
    });
    expect(badRestore.statusCode).toBe(403);

    const restore = await ctxNew!.app.inject({
      method: 'POST',
      url: '/api/v1/system/transfer/restore',
      payload: { backupId: backup.id, code: CODE },
    });
    expect(restore.statusCode).toBe(200);
    const result = restore.json<RestoreResult>();
    expect(result.tablesRestored).toBeGreaterThan(0);

    // Old owner account and settings are back; the old PC's devices are revoked.
    const setup = await ctxNew!.app.inject({ method: 'GET', url: '/api/v1/system/setup-status' });
    expect(setup.json<{ needsSetup: boolean }>().needsSetup).toBe(false);
    const name = await ctxNew!.pool.query<{ value: string }>(
      `SELECT value::text AS value FROM settings WHERE key = 'business.name'`,
    );
    expect(name.rows[0]?.value).toContain('Test Arena');
    const devices = await ctxNew!.pool.query<{ status: string; token_hash: string | null }>(
      `SELECT status, token_hash FROM station_devices WHERE machine_id = 'pc-old-1'`,
    );
    expect(devices.rows).toEqual([{ status: 'revoked', token_hash: null }]);

    const signedIn = await login(ctxNew!.app, OWNER.username, OWNER.password);
    expect(signedIn.token).toBeTruthy();

    // Once the system has a user, the transfer endpoints are closed.
    const again = await ctxNew!.app.inject({
      method: 'POST',
      url: '/api/v1/system/transfer/restore',
      payload: { backupId: backup.id, code: CODE },
    });
    expect(again.statusCode).toBe(409);
  }, 60_000);
});
