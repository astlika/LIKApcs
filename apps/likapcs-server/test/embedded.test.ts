import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { EmbeddedPostgres } from '../src/embedded/postgres.js';
import { findPostgresBinDir, resolveDataDir } from '../src/embedded/paths.js';
import { loadOrCreateRuntimeConfig } from '../src/embedded/runtime-config.js';
import { DiscoveryResponder, discoverServers } from '../src/discovery.js';

const binDir = findPostgresBinDir(process.env.LIKAPCS_PG_BIN);

describe('runtime config', () => {
  it('generates secrets once and reuses them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'likapcs-cfg-'));
    const file = path.join(dir, 'config.json');
    const first = loadOrCreateRuntimeConfig(file);
    const second = loadOrCreateRuntimeConfig(file);
    expect(first.embeddedPostgres.password).toHaveLength(32);
    expect(first.controlToken.length).toBeGreaterThanOrEqual(40);
    expect(second).toEqual(first);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a per-user data directory outside any install dir', () => {
    expect(resolveDataDir('/explicit/dir')).toBe(path.resolve('/explicit/dir'));
    expect(resolveDataDir()).toContain(process.platform === 'win32' ? 'LIKApcs-Data' : 'likapcs');
  });
});

describe.skipIf(!binDir)('embedded PostgreSQL lifecycle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'likapcs-pg-'));
  const port = 55000 + Math.floor(Math.random() * 2000);
  const pg = new EmbeddedPostgres({
    binDir: binDir!,
    dataDir: path.join(root, 'pgdata'),
    port,
    user: 'likapcs',
    password: 'test-password-123',
    database: 'likapcs',
    logFile: path.join(root, 'logs', 'postgres.log'),
  });

  afterAll(async () => {
    await pg.stop().catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('initialises, starts, creates the database, serves queries and stops', async () => {
    expect(pg.isInitialized()).toBe(false);
    expect(await pg.ensureInitialized()).toBe(true);
    expect(await pg.ensureInitialized()).toBe(false);
    await pg.start();
    expect(await pg.status()).toBe('running');
    expect(await pg.ensureDatabase()).toBe(true);
    expect(await pg.ensureDatabase()).toBe(false);

    const client = new Client({ connectionString: pg.connectionString() });
    await client.connect();
    const res = await client.query<{ n: string; enc: string }>(
      'SELECT 21*2 AS n, pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = current_database()',
    );
    await client.end();
    expect(res.rows[0]?.n).toBe(42);
    expect(res.rows[0]?.enc).toBe('UTF8');

    // password auth is enforced
    const bad = new Client({
      connectionString: pg.connectionString().replace('test-password-123', 'wrong'),
    });
    await expect(bad.connect()).rejects.toThrow(/password/i);

    await pg.start(); // idempotent while running
    await pg.stop();
    expect(await pg.status()).toBe('stopped');
    await pg.stop(); // idempotent while stopped
  }, 120_000);
});

describe('LAN discovery', () => {
  const port = 47000 + Math.floor(Math.random() * 1000);
  const responder = new DiscoveryResponder(
    { installationId: 'inst-1', httpPort: 4700, getName: async () => 'Test Center' },
    port,
  );
  beforeAll(() => responder.start());
  afterAll(() => responder.close());

  it('answers a discovery datagram with the server address', async () => {
    const found = await discoverServers(1500, port, ['127.0.0.1']);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      service: 'likapcs',
      installationId: 'inst-1',
      name: 'Test Center',
      port: 4700,
    });
    expect(found[0]?.urls.every((u) => /^http:\/\/\d+\.\d+\.\d+\.\d+:4700$/.test(u))).toBe(true);
  });
});
