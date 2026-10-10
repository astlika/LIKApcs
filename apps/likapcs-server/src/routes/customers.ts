import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  customerListQuerySchema,
  customerPatchSchema,
  customerSchema,
  uuidSchema,
} from '@likapcs/shared';
import { notFound } from '../errors.js';

export const customerRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });
  const view = { preHandler: app.requirePermission(PERMISSIONS.CUSTOMERS_VIEW) };
  const manage = { preHandler: app.requirePermission(PERMISSIONS.CUSTOMERS_MANAGE) };

  app.get('/customers', view, async (request) =>
    services.customers.list(customerListQuerySchema.parse(request.query)),
  );
  app.get('/customers/:id', view, async (request) => {
    const customer = await services.customers.detail(idParams.parse(request.params).id);
    if (!customer) throw notFound('Customer');
    return customer;
  });
  app.post('/customers', manage, async (request, reply) =>
    reply
      .code(201)
      .send(await services.customers.create(customerSchema.parse(request.body), actorOf(request))),
  );
  app.patch('/customers/:id', manage, async (request) =>
    services.customers.update(
      idParams.parse(request.params).id,
      customerPatchSchema.parse(request.body),
      actorOf(request),
    ),
  );
  app.delete('/customers/:id', manage, async (request) =>
    services.customers.archive(idParams.parse(request.params).id, actorOf(request)),
  );
};
