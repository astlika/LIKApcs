/**
 * Suppliers and purchases.
 *   purchases.view   — read suppliers and purchases
 *   suppliers.manage — create / edit / deactivate suppliers
 *   purchases.manage — record purchases, receive goods, cancel
 *   purchases.pay    — record supplier payments (cash payments also need an open shift)
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  createPurchaseSchema,
  purchaseListQuerySchema,
  purchasePaymentInputSchema,
  receivePurchaseSchema,
  supplierListQuerySchema,
  supplierPatchSchema,
  supplierSchema,
  uuidSchema,
} from '@likapcs/shared';
import { notFound } from '../errors.js';

export const purchasingRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });
  const view = { preHandler: app.requirePermission(PERMISSIONS.PURCHASES_VIEW) };
  const suppliers = { preHandler: app.requirePermission(PERMISSIONS.SUPPLIERS_MANAGE) };
  const manage = { preHandler: app.requirePermission(PERMISSIONS.PURCHASES_MANAGE) };
  const pay = { preHandler: app.requirePermission(PERMISSIONS.PURCHASES_PAY) };

  // ── Suppliers ──
  app.get('/suppliers', view, async (request) =>
    services.purchasing.listSuppliers(supplierListQuerySchema.parse(request.query)),
  );
  app.get('/suppliers/:id', view, async (request) => {
    const supplier = await services.purchasing.getSupplier(idParams.parse(request.params).id);
    if (!supplier) throw notFound('Supplier');
    return supplier;
  });
  app.post('/suppliers', suppliers, async (request, reply) =>
    reply
      .code(201)
      .send(
        await services.purchasing.createSupplier(
          supplierSchema.parse(request.body),
          actorOf(request),
        ),
      ),
  );
  app.patch('/suppliers/:id', suppliers, async (request) =>
    services.purchasing.updateSupplier(
      idParams.parse(request.params).id,
      supplierPatchSchema.parse(request.body),
      actorOf(request),
    ),
  );
  app.delete('/suppliers/:id', suppliers, async (request) =>
    services.purchasing.deactivateSupplier(idParams.parse(request.params).id, actorOf(request)),
  );

  // ── Purchases ──
  app.get('/purchases', view, async (request) =>
    services.purchasing.list(purchaseListQuerySchema.parse(request.query)),
  );
  app.get('/purchases/:id', view, async (request) => {
    const purchase = await services.purchasing.get(idParams.parse(request.params).id);
    if (!purchase) throw notFound('Purchase');
    return purchase;
  });
  app.post('/purchases', manage, async (request, reply) =>
    reply
      .code(201)
      .send(
        await services.purchasing.create(
          createPurchaseSchema.parse(request.body),
          actorOf(request),
        ),
      ),
  );
  app.post('/purchases/:id/receive', manage, async (request) =>
    services.purchasing.receive(
      idParams.parse(request.params).id,
      receivePurchaseSchema.parse(request.body ?? {}),
      actorOf(request),
    ),
  );
  app.post('/purchases/:id/payments', pay, async (request, reply) =>
    reply
      .code(201)
      .send(
        await services.purchasing.pay(
          idParams.parse(request.params).id,
          purchasePaymentInputSchema.parse(request.body),
          actorOf(request),
        ),
      ),
  );
  app.post('/purchases/:id/cancel', manage, async (request) =>
    services.purchasing.cancel(idParams.parse(request.params).id, actorOf(request)),
  );
};
