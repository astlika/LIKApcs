import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { forbidden } from '../errors.js';
import {
  PERMISSIONS,
  createSaleSchema,
  refundSchema,
  saleListQuerySchema,
  suspendSaleSchema,
  uuidSchema,
} from '@likapcs/shared';

/**
 * Point of sale. Selling needs pos.sell; discounts, suspending and refunds are checked inside the
 * service against the actor's permission set (pos.discount / pos.suspend / pos.refund).
 */
export const salesRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
    permissions: request.auth!.permissions,
  });
  const sell = { preHandler: app.requirePermission(PERMISSIONS.POS_SELL) };

  app.get('/sales', sell, async (request) =>
    services.sales.list(saleListQuerySchema.parse(request.query)),
  );
  app.get('/sales/:id', sell, async (request) =>
    services.sales.getById(idParams.parse(request.params).id),
  );
  app.get('/sales/:id/receipt', sell, async (request) => {
    const { reprint } = z
      .object({ reprint: z.coerce.boolean().default(false) })
      .parse(request.query);
    if (reprint && !request.auth!.permissions.has(PERMISSIONS.POS_REPRINT)) {
      throw forbidden('Missing permission: pos.reprint');
    }
    return services.sales.receipt(idParams.parse(request.params).id, actorOf(request), reprint);
  });
  app.post('/sales', sell, async (request, reply) =>
    reply
      .code(201)
      .send(await services.sales.create(createSaleSchema.parse(request.body), actorOf(request))),
  );
  app.post('/sales/suspend', sell, async (request, reply) =>
    reply
      .code(201)
      .send(await services.sales.suspend(suspendSaleSchema.parse(request.body), actorOf(request))),
  );
  app.post('/sales/:id/complete', sell, async (request) =>
    services.sales.completeSuspended(
      idParams.parse(request.params).id,
      createSaleSchema.parse(request.body),
      actorOf(request),
    ),
  );
  app.post('/sales/:id/void', sell, async (request, reply) => {
    await services.sales.voidSuspended(idParams.parse(request.params).id, actorOf(request));
    return reply.code(204).send();
  });
  app.post('/sales/:id/refund', sell, async (request) =>
    services.sales.refund(
      idParams.parse(request.params).id,
      refundSchema.parse(request.body),
      actorOf(request),
    ),
  );
};
