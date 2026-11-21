import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  offerActiveSchema,
  offerInputSchema,
  offerPreviewSchema,
  uuidSchema,
} from '@likapcs/shared';
import { forbidden, unauthorized } from '../errors.js';

/**
 * Offers (0.36.0): products and PC minutes sold together at one price. Whoever sells at the till
 * or sees the products sees the offers; making, changing and deleting one needs products.manage.
 * Selling an offer is a normal POS sale (`POST /sales` with an `offerId` item).
 *
 * 0.36.1: what an offer earns and what it has sold (`profit`, `sold`) go only to who may manage
 * the products or see the reports; everyone else gets them as null.
 */
export const offerRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });
  const view = {
    preHandler: async (request: FastifyRequest) => {
      if (!request.auth) throw unauthorized();
      const { permissions } = request.auth;
      if (!permissions.has(PERMISSIONS.POS_SELL) && !permissions.has(PERMISSIONS.PRODUCTS_VIEW))
        throw forbidden(`Missing permission: ${PERMISSIONS.POS_SELL}`);
    },
  };
  const manage = { preHandler: app.requirePermission(PERMISSIONS.PRODUCTS_MANAGE) };

  const seesMoney = (request: FastifyRequest): boolean => {
    const { permissions } = request.auth!;
    return (
      permissions.has(PERMISSIONS.PRODUCTS_MANAGE) || permissions.has(PERMISSIONS.REPORTS_VIEW)
    );
  };

  /**
   * `?active=true`: only the offers on the till (what the POS shows).
   * 0.37.0 `?money=false`: without `profit` and `sold` (both null). The till and the Stations page
   * ask this way — they show neither, and working out what every offer has sold reads all of its
   * sale lines, every minute, on the screens that stay open all day.
   */
  app.get('/offers', view, async (request) => {
    const { active, money } = z
      .object({
        active: z.coerce.boolean().optional(),
        money: z.enum(['true', 'false']).optional(),
      })
      .parse(request.query);
    return {
      items: await services.offers.list({
        activeOnly: active === true,
        money: money !== 'false' && seesMoney(request),
      }),
    };
  });
  /** 0.36.1: the offer in the form — its stock, what its parts cost and what one sale earns. */
  app.post('/offers/preview', manage, async (request) =>
    services.offers.preview(offerPreviewSchema.parse(request.body)),
  );
  app.post('/offers', manage, async (request, reply) =>
    reply
      .code(201)
      .send(await services.offers.create(offerInputSchema.parse(request.body), actorOf(request))),
  );
  app.put('/offers/:id', manage, async (request) =>
    services.offers.update(
      idParams.parse(request.params).id,
      offerInputSchema.parse(request.body),
      actorOf(request),
    ),
  );
  app.patch('/offers/:id', manage, async (request) =>
    services.offers.setActive(
      idParams.parse(request.params).id,
      offerActiveSchema.parse(request.body).isActive,
      actorOf(request),
    ),
  );
  app.delete('/offers/:id', manage, async (request, reply) => {
    await services.offers.remove(idParams.parse(request.params).id, actorOf(request));
    return reply.code(204).send();
  });
};
