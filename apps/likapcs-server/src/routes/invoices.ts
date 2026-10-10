/**
 * Invoices (A4 documents for completed sales). `invoices.view` reads and prints;
 * `invoices.manage` issues and voids.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  createInvoiceSchema,
  invoiceListQuerySchema,
  uuidSchema,
  voidInvoiceSchema,
} from '@likapcs/shared';

export const invoiceRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });
  const view = { preHandler: app.requirePermission(PERMISSIONS.INVOICES_VIEW) };
  const manage = { preHandler: app.requirePermission(PERMISSIONS.INVOICES_MANAGE) };

  app.get('/invoices', view, async (request) =>
    services.invoices.list(invoiceListQuerySchema.parse(request.query)),
  );
  app.get('/invoices/:id', view, async (request) =>
    services.invoices.getById(idParams.parse(request.params).id),
  );
  app.get('/invoices/:id/document', view, async (request) =>
    services.invoices.document(idParams.parse(request.params).id, actorOf(request)),
  );
  app.post('/invoices', manage, async (request, reply) =>
    reply
      .code(201)
      .send(
        await services.invoices.create(createInvoiceSchema.parse(request.body), actorOf(request)),
      ),
  );
  app.post('/invoices/:id/void', manage, async (request) =>
    services.invoices.void(
      idParams.parse(request.params).id,
      voidInvoiceSchema.parse(request.body).reason,
      actorOf(request),
    ),
  );
};
