import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  gamingPackageSchema,
  pricingRuleSchema,
  updateGamingPackageSchema,
  updatePricingRuleSchema,
  uuidSchema,
} from '@likapcs/shared';

/** Pricing rules and prepaid packages. Reading needs stations.view, writing pricing.manage. */
export const pricingRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });
  const view = { preHandler: app.requirePermission(PERMISSIONS.STATIONS_VIEW) };
  const manage = { preHandler: app.requirePermission(PERMISSIONS.PRICING_MANAGE) };

  app.get('/pricing/rules', view, async () => services.pricing.listRules());
  app.post('/pricing/rules', manage, async (request, reply) => {
    const rule = await services.pricing.createRule(
      pricingRuleSchema.parse(request.body),
      actorOf(request),
    );
    return reply.code(201).send(rule);
  });
  app.patch('/pricing/rules/:id', manage, async (request) => {
    const { id } = idParams.parse(request.params);
    return services.pricing.updateRule(
      id,
      updatePricingRuleSchema.parse(request.body),
      actorOf(request),
    );
  });
  app.delete('/pricing/rules/:id', manage, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await services.pricing.deleteRule(id, actorOf(request));
    return reply.code(204).send();
  });

  app.get('/pricing/packages', view, async (request) => {
    const query = z.object({ stationId: uuidSchema.optional() }).parse(request.query);
    return query.stationId
      ? services.pricing.availablePackages(query.stationId)
      : services.pricing.listPackages();
  });
  app.post('/pricing/packages', manage, async (request, reply) => {
    const pkg = await services.pricing.createPackage(
      gamingPackageSchema.parse(request.body),
      actorOf(request),
    );
    return reply.code(201).send(pkg);
  });
  app.patch('/pricing/packages/:id', manage, async (request) => {
    const { id } = idParams.parse(request.params);
    return services.pricing.updatePackage(
      id,
      updateGamingPackageSchema.parse(request.body),
      actorOf(request),
    );
  });
  app.delete('/pricing/packages/:id', manage, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await services.pricing.deletePackage(id, actorOf(request));
    return reply.code(204).send();
  });
};
