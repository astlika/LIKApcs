import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  PERMISSIONS,
  internetAccessCheckSchema,
  internetAccessCodesQuerySchema,
  internetAccessLoadSchema,
  internetAccessRemoveSchema,
} from '@likapcs/shared';

/**
 * Internet access (0.34.0): Wi-Fi packages and their codes. The packages (name, price, how many
 * codes are left) are visible to whoever sees the products; the codes themselves are worth money,
 * so loading, listing and removing them needs products.manage. Selling one is a normal POS sale.
 */
export const internetAccessRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });
  const view = { preHandler: app.requirePermission(PERMISSIONS.PRODUCTS_VIEW) };
  const manage = { preHandler: app.requirePermission(PERMISSIONS.PRODUCTS_MANAGE) };

  app.get('/internet-access/packages', view, async () => ({
    items: await services.internetAccess.listPackages(),
  }));
  /** What a paste would do, before anything is saved. */
  app.post('/internet-access/check', manage, async (request) =>
    services.internetAccess.check(internetAccessCheckSchema.parse(request.body).codes),
  );
  app.post('/internet-access/load', manage, async (request, reply) => {
    const result = await services.internetAccess.load(
      internetAccessLoadSchema.parse(request.body),
      actorOf(request),
    );
    return reply.code(result.created ? 201 : 200).send(result);
  });
  app.get('/internet-access/codes', manage, async (request) =>
    services.internetAccess.listCodes(internetAccessCodesQuerySchema.parse(request.query)),
  );
  app.post('/internet-access/remove', manage, async (request) =>
    services.internetAccess.remove(
      internetAccessRemoveSchema.parse(request.body),
      actorOf(request),
    ),
  );
};
