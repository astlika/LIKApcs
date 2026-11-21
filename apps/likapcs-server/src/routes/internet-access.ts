import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  INTERNET_BAR_MAX,
  PERMISSIONS,
  internetBarIds,
  uuidSchema,
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

  app.get('/internet-access/packages', view, async () => {
    const items = await services.internetAccess.listPackages();
    // 0.36.0: which of them are on the quick bar (the owner's choice, or the first ones).
    const bar = internetBarIds(
      items.map((p) => ({ id: p.product.id, isActive: p.product.isActive })),
      await services.settings.get('pos.internet_bar'),
    );
    return { items: items.map((p) => ({ ...p, inBar: bar.includes(p.product.id) })) };
  });
  /**
   * 0.36.0: the packages on the quick bar of the POS and of the Stations page, in this order
   * (at most `INTERNET_BAR_MAX`; an empty list = the first packages by themselves).
   */
  app.put('/internet-access/bar', manage, async (request) => {
    const { productIds } = z
      .object({ productIds: z.array(uuidSchema).max(INTERNET_BAR_MAX) })
      .parse(request.body);
    await services.settings.update({ 'pos.internet_bar': productIds }, actorOf(request));
    return { productIds };
  });
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
