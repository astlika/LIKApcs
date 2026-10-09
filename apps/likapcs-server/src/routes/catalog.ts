import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  categorySchema,
  inventoryMovementsQuerySchema,
  productBarcodeSchema,
  productListQuerySchema,
  productSchema,
  stockAdjustmentSchema,
  taxCategorySchema,
  updateCategorySchema,
  updateProductSchema,
  uuidSchema,
} from '@likapcs/shared';

/** Catalogue (products, categories, tax categories, barcodes) and inventory movements. */
export const catalogRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
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
