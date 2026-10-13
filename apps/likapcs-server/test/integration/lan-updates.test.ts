/**
 * 0.17.1 — LAN updates: the desk publishes the signed client installer to the server once and
 * every offline PC updates over the local network. The manifest must be exactly the Tauri
 * updater shape, the file must round-trip byte-for-byte, and publishing must be permissioned.
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoginResponse } from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

describe('LAN updates', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let dataDir: string;

  const call = <T>(
    token: string | null,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: token ? authHeader(token) : {},
        payload,
      })
      .then((r) => ({ status: r.statusCode, body: r.json() as T, raw: r }));

  // A fake installer is fine: the server only stores/serves bytes; the client verifies the
  // minisign signature, which never changes here.
  const exe = Buffer.concat([Buffer.from('MZ-fake-installer'), Buffer.alloc(2048, 7)]);
  const sha256 = createHash('sha256').update(exe).digest('hex');
  const signature = 'dW50cnVzdGVkIGNvbW1lbnQ6IGZha2Ugc2lnbmF0dXJlIGZvciB0ZXN0cw==';

  beforeAll(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-updates-'));
    ctx = await createTestContext({ dataDir });
    owner = await runSetup(ctx.app);
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('refuses anonymous access to the manifest when nothing is published', async () => {
    const res = await call<unknown>(null, 'GET', '/updates/client-manifest');
    expect(res.status).toBe(404);
  });

  it('publishes an installer and serves the Tauri-shaped manifest + file', async () => {
    const pub = await call<{ version: string; file: string }>(owner.token, 'POST', '/updates/lan', {
      version: '9.9.9',
      signature,
      sha256,
      exeBase64: exe.toString('base64'),
    });
    expect(pub.status).toBe(200);
    expect(pub.body.file).toBe('LIKApcs-Client-Setup-9.9.9.exe');

    const manifest = await call<{
      version: string;
      platforms: Record<string, { signature: string; url: string }>;
    }>(null, 'GET', '/updates/client-manifest');
    expect(manifest.status).toBe(200);
    expect(manifest.body.version).toBe('9.9.9');
    const platform = manifest.body.platforms['windows-x86_64']!;
    expect(platform.signature).toBe(signature);
    expect(platform.url).toContain('/api/v1/updates/file/LIKApcs-Client-Setup-9.9.9.exe');

    const file = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/updates/file/${pub.body.file}`,
    });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(exe)).toBe(true);

    // Only the published file is served; traversal and strangers get 404.
    const stranger = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/updates/file/LIKApcs-Client-Setup-1.2.3.exe',
    });
    expect(stranger.statusCode).toBe(404);
  });

  it('rejects a checksum mismatch and keeps the old publish', async () => {
    const bad = await call<{ error: { code: string } }>(owner.token, 'POST', '/updates/lan', {
      version: '9.9.10',
      signature,
      sha256: 'a'.repeat(64),
      exeBase64: exe.toString('base64'),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('checksum_mismatch');
    const manifest = await call<{ version: string }>(null, 'GET', '/updates/client-manifest');
    expect(manifest.body.version).toBe('9.9.9');
  });

  it('requires permissions for status and unpublishes cleanly', async () => {
    const anonStatus = await call<unknown>(null, 'GET', '/updates/lan');
    expect(anonStatus.status).toBe(401);

    const del = await call<{ ok: true }>(owner.token, 'DELETE', '/updates/lan');
    expect(del.status).toBe(200);
    const manifest = await call<unknown>(null, 'GET', '/updates/client-manifest');
    expect(manifest.status).toBe(404);
    const status = await call<{ update: null }>(owner.token, 'GET', '/updates/lan');
    expect(status.body.update).toBeNull();
  });
});
