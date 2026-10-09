import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import type { LoginResponse } from '@likapcs/shared';
import { buildApp } from '../src/app.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool, type DbPool } from '../src/db/pool.js';

export interface TestContext {
  app: FastifyInstance;
  pool: DbPool;
  config: ServerConfig;
  close: () => Promise<void>;
}

/** Drops and recreates the public schema, applies all migrations, builds a non-listening app. */
export async function createTestContext(): Promise<TestContext> {
  const config = loadConfig();
  if (!config.databaseUrl || !/likapcs_test/.test(config.databaseUrl)) {
    throw new Error('Refusing to run tests against a database that is not named *likapcs_test*');
  }
  const pool = createPool(config.databaseUrl, { max: 5 });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool, config.migrationsDir);
  const app = await buildApp({ config, pool, logger: false, sessionTicker: false });
  await app.ready();
  return {
    app,
    pool,
    config,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export const OWNER = { username: 'owner', password: 'Owner12345', fullName: 'Shop Owner' };

export async function runSetup(
  app: FastifyInstance,
  businessName = 'Test Arena',
): Promise<LoginResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/system/setup',
    payload: { businessName, language: 'en', owner: OWNER },
  });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  return res.json<LoginResponse>();
}

export async function login(
  app: FastifyInstance,
  username: string,
  password: string,
): Promise<LoginResponse> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return res.json<LoginResponse>();
}

export function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Opens a WebSocket to a listening app and returns a helper that collects JSON messages. */
export async function openSocket(url: string): Promise<{
  socket: WebSocket;
  send: (msg: unknown) => void;
  next: (timeoutMs?: number) => Promise<Record<string, unknown>>;
  closed: () => Promise<{ code: number; reason: string }>;
}> {
  const socket = new WebSocket(url);
  const queue: Record<string, unknown>[] = [];
  const waiters: ((m: Record<string, unknown>) => void)[] = [];
  let closeInfo: { code: number; reason: string } | null = null;
  const closeWaiters: ((c: { code: number; reason: string }) => void)[] = [];
  socket.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  socket.on('close', (code, reason) => {
    closeInfo = { code, reason: reason.toString() };
    for (const w of closeWaiters.splice(0)) w(closeInfo);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return {
    socket,
    send: (msg) => socket.send(JSON.stringify(msg)),
    next: (timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        const queued = queue.shift();
        if (queued) return resolve(queued);
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for message')),
          timeoutMs,
        );
        waiters.push((m) => {
          clearTimeout(timer);
          resolve(m);
        });
      }),
    closed: () =>
      new Promise((resolve) => {
        if (closeInfo) return resolve(closeInfo);
        closeWaiters.push(resolve);
      }),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
