import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { PERMISSIONS } from '@likapcs/shared';
import { recordAudit } from '../services/audit.js';

/**
 * LAN updates (0.17.1): cafe PCs often have no internet, so the GitHub updater feed never
 * reaches them. The desk (which does have internet) publishes the signed client installer to
 * the server once; every PC then updates from `http://<server>/api/v1/updates/…` — the same
 * minisign signature as on GitHub, verified by the client before installing.
 */
export const lanUpdateRoutes: FastifyPluginAsync = async (app) => {
  const dir = join(app.config.dataDir, 'updates');
  const metaPath = () => join(dir, 'meta.json');
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });

  interface LanMeta {
    version: string;
    signature: string;
    sha256: string;
    file: string;
    publishedAt: string;
    publishedBy: string;
  }
  const readMeta = async (): Promise<LanMeta | null> => {
    try {
      return JSON.parse(await readFile(metaPath(), 'utf8')) as LanMeta;
    } catch {
      return null;
    }
  };

  // The manifest in exactly the shape the Tauri updater expects, so the client needs no special
  // parsing — only a different endpoint (see `update_check_server` / `update_from_server`).
  app.get('/updates/client-manifest', async (request, reply) => {
    const meta = await readMeta();
    if (!meta)
      return reply
        .status(404)
        .send({ error: { code: 'not_found', message: 'No LAN update published.' } });
    return {
      version: meta.version,
      notes: `LIKApcs Client ${meta.version} — LAN update`,
      pub_date: meta.publishedAt,
      platforms: {
        'windows-x86_64': {
          signature: meta.signature,
          url: `${request.protocol}://${request.host}/api/v1/updates/file/${meta.file}`,
        },
      },
    };
  });

  app.get('/updates/file/:name', async (request, reply) => {
    const { name } = z
      .object({ name: z.string().regex(/^LIKApcs-Client-Setup-[\w.-]+\.exe$/) })
      .parse(request.params);
    const meta = await readMeta();
    if (!meta || meta.file !== name) return reply.status(404).send();
    return reply
      .header('content-type', 'application/octet-stream')
      .header('cache-control', 'no-store')
      .send(createReadStream(join(dir, name)));
  });

  // One-click publish: the server itself downloads the newest signed client release (same feed
  // the updates dashboard checks) and stores it locally — the desk needs internet once, then
  // every LAN client can update without it. Integrity comes from the minisign signature inside
  // the manifest; the sha256 is stored so the desk can eyeball what was published.
  app.post(
    '/updates/lan/publish-remote',
    { preHandler: app.requirePermission(PERMISSIONS.UPDATES_MANAGE) },
    async (request, reply) => {
      const base = app.services.updates.feedBaseUrl.replace(/\/$/, '');
      const feedUrl = `${base}/latest-client.json`;
      let manifest: { version?: string; download_url?: string; signature?: string };
      try {
        const res = await fetch(feedUrl, {
          signal: AbortSignal.timeout(15_000),
          headers: { accept: 'application/json' },
          redirect: 'follow',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        manifest = (await res.json()) as typeof manifest;
      } catch (err) {
        return reply.status(502).send({
          error: {
            code: 'feed_unreachable',
            message: `Could not read the release feed (${feedUrl}): ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      }
      const { version, download_url: downloadUrl, signature } = manifest;
      if (!version || !downloadUrl || !signature) {
        return reply.status(502).send({
          error: { code: 'feed_invalid', message: 'The release feed entry is incomplete.' },
        });
      }
      let bytes: Buffer;
      try {
        const res = await fetch(downloadUrl, {
          signal: AbortSignal.timeout(180_000),
          redirect: 'follow',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bytes = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        return reply.status(502).send({
          error: {
            code: 'download_failed',
            message: `Could not download the installer: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      }
      const sum = createHash('sha256').update(bytes).digest('hex');
      const meta = await savePublished(version, signature, sum, bytes, request.auth!.user.username);
      await recordAudit(app.pool, actorOf(request), {
        action: 'updates.lan_publish',
        entityType: 'update',
        entityId: version,
        details: { version, sha256: sum, source: 'feed' },
      });
      return meta;
    },
  );

  app.get(
    '/updates/lan',
    { preHandler: app.requirePermission(PERMISSIONS.SETTINGS_VIEW) },
    async () => ({ update: await readMeta() }),
  );

  const publishSchema = z.object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    signature: z.string().min(32).max(4096),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    exeBase64: z.string().min(1024),
  });
  const savePublished = async (
    version: string,
    signature: string,
    sum: string,
    bytes: Buffer,
    username: string,
  ): Promise<LanMeta> => {
    await mkdir(dir, { recursive: true });
    const file = `LIKApcs-Client-Setup-${version}.exe`;
    await writeFile(join(dir, file), bytes);
    const meta: LanMeta = {
      version,
      signature,
      sha256: sum,
      file,
      publishedAt: new Date().toISOString(),
      publishedBy: username,
    };
    await writeFile(metaPath(), JSON.stringify(meta, null, 2));
    return meta;
  };

  app.post(
    '/updates/lan',
    { preHandler: app.requirePermission(PERMISSIONS.DEVICES_MANAGE) },
    async (request, reply) => {
      const body = publishSchema.parse(request.body ?? {});
      const bytes = Buffer.from(body.exeBase64, 'base64');
      const sum = createHash('sha256').update(bytes).digest('hex');
      if (sum !== body.sha256) {
        return reply.status(400).send({
          error: {
            code: 'checksum_mismatch',
            message: 'The downloaded installer does not match its checksum.',
          },
        });
      }
      const meta = await savePublished(
        body.version,
        body.signature,
        sum,
        bytes,
        request.auth!.user.username,
      );
      await recordAudit(app.pool, actorOf(request), {
        action: 'updates.lan_publish',
        entityType: 'update',
        entityId: body.version,
        details: { version: body.version, sha256: sum },
      });
      return meta;
    },
  );

  app.delete(
    '/updates/lan',
    { preHandler: app.requirePermission(PERMISSIONS.DEVICES_MANAGE) },
    async (request) => {
      const meta = await readMeta();
      if (meta) {
        await rm(join(dir, meta.file), { force: true });
        await rm(metaPath(), { force: true });
        await recordAudit(app.pool, actorOf(request), {
          action: 'updates.lan_unpublish',
          entityType: 'update',
          entityId: meta.version,
          details: { version: meta.version },
        });
      }
      return { ok: true };
    },
  );
};
