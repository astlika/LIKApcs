import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerPhoneRoutes } from '../../src/routes/phone.js';

/** The phone (/phone) and the desktop UI (/desktop) are the same static server, with different mounts. */
describe('browser apps served by the server', () => {
  let root: string;
  const app = Fastify();

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'likapcs-desktop-'));
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'index.html'), '<html>desktop shell</html>');
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1);');
    registerPhoneRoutes(app, root, '/desktop');
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('serves the shell and hashed assets under /desktop', async () => {
    const home = await app.inject({ method: 'GET', url: '/desktop/' });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('desktop shell');
    const asset = await app.inject({ method: 'GET', url: '/desktop/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('javascript');
  });

  it('redirects /desktop to /desktop/ and falls back to the shell for client routes', async () => {
    const redirect = await app.inject({ method: 'GET', url: '/desktop' });
    expect(redirect.statusCode).toBe(308);
    expect(redirect.headers.location).toBe('/desktop/');
    const route = await app.inject({ method: 'GET', url: '/desktop/pos/sales' });
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain('desktop shell');
  });

  it('returns 404 for missing assets and never reads outside the folder', async () => {
    const missing = await app.inject({ method: 'GET', url: '/desktop/assets/none.js' });
    expect(missing.statusCode).toBe(404);
    const escape = await app.inject({ method: 'GET', url: '/desktop/..%2F..%2Fpackage.json' });
    expect(escape.statusCode).toBe(404);
  });
});
