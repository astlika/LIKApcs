import fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_TYPES,
  stationLookSchema,
  uuidSchema,
} from '@likapcs/shared';
import { AppError } from '../errors.js';

/**
 * 0.20.0: per-PC looks (widget size/position/style/theme, ads on or off), per-PC wallpapers, and
 * the client-screen layout presets.
 */
export const looksRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });
  const manageStations = { preHandler: app.requirePermission(PERMISSIONS.STATIONS_MANAGE) };
  const viewSettings = { preHandler: app.requirePermission(PERMISSIONS.SETTINGS_VIEW) };
  const manageSettings = { preHandler: app.requirePermission(PERMISSIONS.SETTINGS_MANAGE) };
  // Raw bodies for wallpaper uploads (scoped to this plugin, like product pictures).
  app.addContentTypeParser([...PRODUCT_IMAGE_TYPES], (_request, payload, done) =>
    done(null, payload),
  );

  // ─── Per-PC look ──────────────────────────────────────────────────────────────
  app.patch('/stations/:id/look', manageStations, async (request) => {
    const { id } = idParams.parse(request.params);
    const look = stationLookSchema.parse(request.body);
    return services.looks.setLook(id, look, actorOf(request));
  });

  // ─── Per-PC wallpaper ─────────────────────────────────────────────────────────
  app.put(
    '/stations/:id/wallpaper',
    { ...manageStations, bodyLimit: PRODUCT_IMAGE_MAX_BYTES },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const body = request.body as NodeJS.ReadableStream | undefined;
      if (!body || typeof (body as { pipe?: unknown }).pipe !== 'function') {
        throw new AppError(
          415,
          'unsupported_media_type',
          `Send the picture as one of: ${PRODUCT_IMAGE_TYPES.join(', ')}`,
        );
      }
      await services.stations.getById(id); // 404 before accepting the upload
      const fileName = await services.looks.wallpapers.saveStream(body as unknown as Readable);
      return services.looks.setWallpaper(id, fileName, actorOf(request));
    },
  );

  app.delete('/stations/:id/wallpaper', manageStations, async (request) =>
    services.looks.clearWallpaper(idParams.parse(request.params).id, actorOf(request)),
  );

  /**
   * Public, read-only: a PC fetches its wallpaper with a plain image request. Names are random
   * and unguessable; only our own files can be addressed (see ProductImageStore.resolve).
   */
  app.get('/files/wallpapers/:name', async (request, reply) => {
    const { name } = z.object({ name: z.string().min(1).max(64) }).parse(request.params);
    const file = services.looks.wallpapers.resolve(name);
    if (!file || !services.looks.wallpapers.exists(name)) {
      throw new AppError(404, 'not_found', 'File not found');
    }
    return reply
      .header('content-type', file.contentType)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(fs.createReadStream(file.path));
  });

  // ─── Layout presets ───────────────────────────────────────────────────────────
  app.get('/client/layout-presets', viewSettings, async () => services.looks.listPresets());
  app.post('/client/layout-presets', manageSettings, async (request, reply) => {
    const preset = await services.looks.createPreset(request.body, actorOf(request));
    return reply.code(201).send(preset);
  });
  app.patch('/client/layout-presets/:id', manageSettings, async (request) =>
    services.looks.updatePreset(idParams.parse(request.params).id, request.body, actorOf(request)),
  );
  app.delete('/client/layout-presets/:id', manageSettings, async (request, reply) => {
    await services.looks.deletePreset(idParams.parse(request.params).id, actorOf(request));
    return reply.code(204).send();
  });
};
