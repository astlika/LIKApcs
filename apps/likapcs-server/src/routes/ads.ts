/**
 * Ads (customer-screen slideshow + promo prices). `products.view` reads the list; `products.manage`
 * edits it — ads are part of the catalogue (a promo changes what the POS charges).
 */
import type { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AD_VIDEO_MAX_BYTES,
  PERMISSIONS,
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_TYPES,
  adAddAllSchema,
  adAlbumInputSchema,
  adAlbumPatchSchema,
  adAlbumReorderSchema,
  adBulkProductsSchema,
  adInputSchema,
  adMoveToAlbumSchema,
  adPatchSchema,
  adReorderSchema,
  clientDisplayFromSettings,
  productImageFromUrlSchema,
  uuidSchema,
  type CustomerDisplayFeed,
} from '@likapcs/shared';
import fs from 'node:fs';
import { AppError } from '../errors.js';
import { AD_VIDEO_TYPES } from '../services/ad-videos.js';

export const adsRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  app.addContentTypeParser([...PRODUCT_IMAGE_TYPES, ...AD_VIDEO_TYPES], (_request, payload, done) =>
    done(null, payload),
  );
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });
  const view = { preHandler: app.requirePermission(PERMISSIONS.PRODUCTS_VIEW) };
  const manage = { preHandler: app.requirePermission(PERMISSIONS.PRODUCTS_MANAGE) };

  app.get('/ads', view, async () => ({ items: await services.ads.list() }));
  // Counter customer display (0.16.0): the live program + the owner's default look. Any staff
  // member may read it — it is exactly what the customers see.
  app.get('/ads/feed', { preHandler: app.requireAuth }, async (): Promise<CustomerDisplayFeed> => {
    const [feed, all] = await Promise.all([
      services.ads.clientFeed(null),
      services.settings.getAll(),
    ]);
    return {
      feed,
      ads: clientDisplayFromSettings(all).ads,
      businessName: all['business.name'],
      language: all['locale.default_language'],
      currency: all['locale.currency'],
    };
  });
  app.get('/ads/:id', view, async (request) => services.ads.get(idParams.parse(request.params).id));
  app.post('/ads', manage, async (request, reply) => {
    const ad = await services.ads.create(adInputSchema.parse(request.body), actorOf(request));
    return reply.code(201).send(ad);
  });
  app.patch('/ads/:id', manage, async (request) =>
    services.ads.update(
      idParams.parse(request.params).id,
      adPatchSchema.parse(request.body),
      actorOf(request),
    ),
  );
  app.delete('/ads/:id', manage, async (request, reply) => {
    await services.ads.remove(idParams.parse(request.params).id, actorOf(request));
    return reply.code(204).send();
  });
  app.put('/ads/order', manage, async (request) => ({
    items: await services.ads.reorder(adReorderSchema.parse(request.body).ids, actorOf(request)),
  }));
  app.post('/ads/products/all', manage, async (request) => {
    const body = adAddAllSchema.parse(request.body ?? {});
    return services.ads.addAllProducts(actorOf(request), body.onlyWithPhoto, body.albumId ?? null);
  });
  app.post('/ads/products/bulk', manage, async (request) => {
    const body = adBulkProductsSchema.parse(request.body);
    return services.ads.addProducts(body.productIds, actorOf(request), body.albumId ?? null);
  });

  // Albums (0.12.0): named groups of slides with their own look, played one after another.
  app.get('/ads/albums', view, async () => ({ items: await services.ads.listAlbums() }));
  app.post('/ads/albums', manage, async (request, reply) => {
    const album = await services.ads.createAlbum(
      adAlbumInputSchema.parse(request.body),
      actorOf(request),
    );
    return reply.code(201).send(album);
  });
  app.put('/ads/albums/order', manage, async (request) => ({
    items: await services.ads.reorderAlbums(
      adAlbumReorderSchema.parse(request.body).ids,
      actorOf(request),
    ),
  }));
  app.patch('/ads/albums/:id', manage, async (request) =>
    services.ads.updateAlbum(
      idParams.parse(request.params).id,
      adAlbumPatchSchema.parse(request.body),
      actorOf(request),
    ),
  );
  app.delete('/ads/albums/:id', manage, async (request, reply) => {
    await services.ads.deleteAlbum(idParams.parse(request.params).id, actorOf(request));
    return reply.code(204).send();
  });
  /** Move slides into / out of an album. */
  app.put('/ads/album', manage, async (request) => {
    const body = adMoveToAlbumSchema.parse(request.body);
    return { items: await services.ads.moveToAlbum(body.ids, body.albumId, actorOf(request)) };
  });

  // Pictures for custom slides (same store and limits as product photos).
  app.put('/ads/:id/image', { ...manage, bodyLimit: PRODUCT_IMAGE_MAX_BYTES }, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = request.body as NodeJS.ReadableStream | undefined;
    if (!body || typeof (body as { pipe?: unknown }).pipe !== 'function') {
      throw new AppError(
        415,
        'unsupported_media_type',
        `Send the picture as one of: ${PRODUCT_IMAGE_TYPES.join(', ')}`,
      );
    }
    await services.ads.get(id); // 404 before accepting the upload
    const fileName = await services.ads.images.saveStream(body as unknown as Readable);
    return services.ads.setImage(id, fileName, actorOf(request));
  });
  app.post('/ads/:id/image/from-url', manage, async (request) => {
    const { id } = idParams.parse(request.params);
    const { url } = productImageFromUrlSchema.parse(request.body);
    await services.ads.get(id);
    const fileName = await services.ads.images.saveFromUrl(url);
    return services.ads.setImage(id, fileName, actorOf(request));
  });
  app.delete('/ads/:id/image', manage, async (request) =>
    services.ads.clearImage(idParams.parse(request.params).id, actorOf(request)),
  );

  // ─── 0.10.0: video slides, duplicate ──────────────────────────────────────────
  app.put('/ads/:id/video', { ...manage, bodyLimit: AD_VIDEO_MAX_BYTES }, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = request.body as NodeJS.ReadableStream | undefined;
    const type = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (
      !body ||
      typeof (body as { pipe?: unknown }).pipe !== 'function' ||
      !(AD_VIDEO_TYPES as readonly string[]).includes(type)
    ) {
      throw new AppError(
        415,
        'unsupported_media_type',
        `Send the video as one of: ${AD_VIDEO_TYPES.join(', ')}`,
      );
    }
    await services.ads.get(id);
    const fileName = await services.ads.videos.saveStream(body as unknown as Readable);
    return services.ads.setVideo(id, fileName, actorOf(request));
  });
  app.post('/ads/:id/duplicate', manage, async (request, reply) =>
    reply
      .code(201)
      .send(await services.ads.duplicate(idParams.parse(request.params).id, actorOf(request))),
  );
  /** Videos for the PCs (no auth, like product pictures: random unguessable names). */
  app.get('/files/videos/:name', async (request, reply) => {
    const { name } = z.object({ name: z.string().min(1).max(64) }).parse(request.params);
    const file = services.ads.videos.resolve(name);
    if (!file || !services.ads.videos.exists(name))
      throw new AppError(404, 'not_found', 'File not found');
    const stat = fs.statSync(file.path);
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    reply
      .header('content-type', file.contentType)
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'public, max-age=31536000, immutable');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start >= stat.size || start > end)
        return reply.code(416).header('content-range', `bytes */${stat.size}`).send();
      return reply
        .code(206)
        .header('content-range', `bytes ${start}-${end}/${stat.size}`)
        .header('content-length', end - start + 1)
        .send(fs.createReadStream(file.path, { start, end }));
    }
    return reply.header('content-length', stat.size).send(fs.createReadStream(file.path));
  });
};
