import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  PERMISSIONS,
  checkInReservationSchema,
  createReservationSchema,
  reservationListQuerySchema,
  updateReservationSchema,
  uuidSchema,
} from '@likapcs/shared';
import { z } from 'zod';

/**
 * PC reservations (0.32.0): book PCs for a time, see them, cancel. 0.33.4: change a booking (time,
 * PCs, name, tolerance, reminder) and mark the PCs whose booked customer already sits there.
 */
export const reservationRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const view = { preHandler: app.requirePermission(PERMISSIONS.STATIONS_VIEW) };
  const control = { preHandler: app.requirePermission(PERMISSIONS.STATIONS_CONTROL) };
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });

  app.get('/reservations', view, async (request) => ({
    items: await services.reservations.list(reservationListQuerySchema.parse(request.query)),
  }));

  app.post('/reservations', control, async (request, reply) => {
    const body = createReservationSchema.parse(request.body);
    return reply.code(201).send(await services.reservations.create(body, actorOf(request)));
  });

  app.post('/reservations/:id/cancel', control, async (request) => {
    const { id } = idParams.parse(request.params);
    return services.reservations.cancel(id, actorOf(request));
  });

  app.patch('/reservations/:id', control, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = updateReservationSchema.parse(request.body);
    return services.reservations.update(id, body, actorOf(request));
  });

  app.post('/reservations/:id/check-in', control, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = checkInReservationSchema.parse(request.body ?? {});
    return services.reservations.markArrived(id, body.stationIds, actorOf(request));
  });
};
