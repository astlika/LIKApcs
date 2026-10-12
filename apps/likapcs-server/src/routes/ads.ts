/**
 * Ads (customer-screen slideshow + promo prices). `products.view` reads the list; `products.manage`
 * edits it — ads are part of the catalogue (a promo changes what the POS charges).
 */
import type { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_TYPES,
  adInputSchema,
  adPatchSchema,
  adReorderSchema,
  productImageFromUrlSchema,
  uuidSchema,
} from '@likapcs/shared';
import { AppError } from '../errors.js';

export const adsRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  app.addContentTypeParser([...PRODUCT_IMAGE_TYPES], (_request, payload, done) =>
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
  app.post('/ads/products/all', manage, async (request) =>
    services.ads.addAllProducts(actorOf(request)),
  );

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
};
