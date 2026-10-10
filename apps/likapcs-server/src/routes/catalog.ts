import fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_TYPES,
  categorySchema,
  inventoryMovementsQuerySchema,
  productBarcodeSchema,
  productImageFromUrlSchema,
  productListQuerySchema,
  productSchema,
  stockAdjustmentSchema,
  taxCategorySchema,
  updateCategorySchema,
  updateProductSchema,
  uuidSchema,
} from '@likapcs/shared';
import { AppError } from '../errors.js';

/** Catalogue (products, categories, tax categories, barcodes), pictures and inventory movements. */
export const catalogRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  // Raw bodies for picture uploads (scoped to this plugin).
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
  const adjust = { preHandler: app.requirePermission(PERMISSIONS.INVENTORY_ADJUST) };

  app.get('/catalog/tax-categories', view, async () => services.catalog.listTaxCategories());
  app.post('/catalog/tax-categories', manage, async (request, reply) =>
    reply
      .code(201)
      .send(
        await services.catalog.createTaxCategory(
          taxCategorySchema.parse(request.body),
          actorOf(request),
        ),
      ),
  );

  app.get('/catalog/categories', view, async () => services.catalog.listCategories());
  app.post('/catalog/categories', manage, async (request, reply) =>
    reply
      .code(201)
      .send(
        await services.catalog.createCategory(categorySchema.parse(request.body), actorOf(request)),
      ),
  );
  app.patch('/catalog/categories/:id', manage, async (request) =>
    services.catalog.updateCategory(
      idParams.parse(request.params).id,
      updateCategorySchema.parse(request.body),
      actorOf(request),
    ),
  );
  app.delete('/catalog/categories/:id', manage, async (request, reply) => {
    await services.catalog.deleteCategory(idParams.parse(request.params).id, actorOf(request));
    return reply.code(204).send();
  });

  app.get('/products', view, async (request) =>
    services.catalog.listProducts(productListQuerySchema.parse(request.query)),
  );
  app.get('/products/lookup', view, async (request) => {
    const { code } = z.object({ code: z.string().trim().min(1).max(64) }).parse(request.query);
    return services.catalog.lookup(code);
  });
  app.get('/products/:id', view, async (request) =>
    services.catalog.getProduct(idParams.parse(request.params).id),
  );
  app.post('/products', manage, async (request, reply) =>
    reply
      .code(201)
      .send(
        await services.catalog.createProduct(productSchema.parse(request.body), actorOf(request)),
      ),
  );
  app.patch('/products/:id', manage, async (request) =>
    services.catalog.updateProduct(
      idParams.parse(request.params).id,
      updateProductSchema.parse(request.body),
      actorOf(request),
    ),
  );
  app.delete('/products/:id', manage, async (request) =>
    services.catalog.deleteProduct(idParams.parse(request.params).id, actorOf(request)),
  );
  app.post('/products/:id/barcodes', manage, async (request, reply) =>
    reply
      .code(201)
      .send(
        await services.catalog.addBarcode(
          idParams.parse(request.params).id,
          productBarcodeSchema.parse(request.body),
          actorOf(request),
        ),
      ),
  );
  app.delete('/products/:id/barcodes/:barcodeId', manage, async (request) => {
    const { id, barcodeId } = z
      .object({ id: uuidSchema, barcodeId: uuidSchema })
      .parse(request.params);
    return services.catalog.removeBarcode(id, barcodeId, actorOf(request));
  });
  // ─── Product pictures ───────────────────────────────────────────────────────
  app.put(
    '/products/:id/image',
    { ...manage, bodyLimit: PRODUCT_IMAGE_MAX_BYTES },
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
      await services.catalog.getProduct(id); // 404 before accepting the upload
      const fileName = await services.catalog.images.saveStream(body as unknown as Readable);
      return services.catalog.setProductImage(id, fileName, actorOf(request));
    },
  );

  app.post('/products/:id/image/from-url', manage, async (request) => {
    const { id } = idParams.parse(request.params);
    const { url } = productImageFromUrlSchema.parse(request.body);
    await services.catalog.getProduct(id);
    const fileName = await services.catalog.images.saveFromUrl(url);
    return services.catalog.setProductImage(id, fileName, actorOf(request));
  });

  app.delete('/products/:id/image', manage, async (request) =>
    services.catalog.clearProductImage(idParams.parse(request.params).id, actorOf(request)),
  );

  /**
   * Public, read-only: pictures are shown in `<img>` tags (POS tiles, product list) where no
   * Authorization header can be attached. File names are random and unguessable; nothing but our
   * own files can be addressed (see ProductImageStore.resolve).
   */
  app.get('/files/products/:name', async (request, reply) => {
    const { name } = z.object({ name: z.string().min(1).max(64) }).parse(request.params);
    const file = services.catalog.images.resolve(name);
    if (!file || !services.catalog.images.exists(name)) {
      throw new AppError(404, 'not_found', 'File not found');
    }
    return reply
      .header('content-type', file.contentType)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(fs.createReadStream(file.path));
  });

  app.post('/products/:id/stock', adjust, async (request) =>
    services.catalog.adjustStock(
      idParams.parse(request.params).id,
      stockAdjustmentSchema.parse(request.body),
      actorOf(request),
    ),
  );
  app.get('/inventory/movements', view, async (request) =>
    services.catalog.listMovements(inventoryMovementsQuerySchema.parse(request.query)),
  );
};
