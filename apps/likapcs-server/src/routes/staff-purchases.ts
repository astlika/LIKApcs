import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { staffPurchaseSchema } from '@likapcs/shared';
import { PERMISSIONS } from '@likapcs/shared';

/** Staff purchase (0.28.0): POST /staff-purchases, checked against pos.staff_purchase in the service. */
export const staffPurchaseRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
    permissions: request.auth!.permissions,
  });
  const record = { preHandler: app.requirePermission(PERMISSIONS.POS_STAFF_PURCHASE) };

  app.post('/staff-purchases', record, async (request, reply) =>
    reply
      .code(201)
      .send(
        await services.staffPurchases.create(
          staffPurchaseSchema.parse(request.body),
          actorOf(request),
          await services.settings.get('locale.timezone'),
        ),
      ),
  );
};
