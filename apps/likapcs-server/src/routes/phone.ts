import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * The phone PWA (`apps/likapcs-phone/dist`) is served by this server at `/phone/`.
 * Same origin as the API, so no CORS entry and no second port. Only files inside
 * `root` are ever read; anything without a file extension falls back to index.html.
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  // 0.35.0: the built-in voices of the Admin (Settings › Client screen › "Try").
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serves a built browser app from `root` under `mount` (`/phone` for the phone PWA, `/desktop` for
 * the Admin desktop UI in the browser). Same origin as the API.
 */
export function registerPhoneRoutes(app: FastifyInstance, root: string, mount = '/phone'): void {
  const base = path.resolve(root);

  const send = async (rel: string, reply: FastifyReply) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      return reply.code(400).send('bad path');
    }
    let file = path.resolve(base, '.' + path.sep + decoded);
    if (file !== base && !file.startsWith(base + path.sep)) {
      return reply.code(404).send('not found');
    }
    let stat = await fs.stat(file).catch(() => null);
    if (stat?.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = await fs.stat(file).catch(() => null);
    }
    if (!stat) {
      // Client-side route (no extension) → the app shell; a missing asset is a real 404.
      if (path.extname(decoded)) return reply.code(404).send('not found');
      file = path.join(base, 'index.html');
      stat = await fs.stat(file).catch(() => null);
      if (!stat) return reply.code(404).send('app not built');
    }
    const name = path.basename(file);
    const ext = path.extname(file).toLowerCase();
    const hashed = file.includes(`${path.sep}assets${path.sep}`);
    const cache = hashed
      ? 'public, max-age=31536000, immutable'
      : name === 'index.html' || name === 'sw.js' || ext === '.webmanifest'
        ? 'no-cache'
        : 'public, max-age=86400';
    reply.header('content-type', TYPES[ext] ?? 'application/octet-stream');
    reply.header('cache-control', cache);
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(await fs.readFile(file));
  };

  app.get(mount, async (_req, reply) => reply.redirect(`${mount}/`, 308));
  app.get(`${mount}/`, async (_req, reply) => send('index.html', reply));
  app.get(`${mount}/*`, async (req, reply) => {
    const rel = (req.params as { '*': string })['*'] ?? '';
    return send(rel || 'index.html', reply);
  });
}
