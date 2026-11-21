import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  cashMovementSchema,
  cashShiftListQuerySchema,
  closeShiftSchema,
  openShiftSchema,
  uuidSchema,
} from '@likapcs/shared';
import { notFound } from '../errors.js';

/** Cash register: shifts, drawer movements and shift reports. */
export const cashRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });
  const view = { preHandler: app.requirePermission(PERMISSIONS.CASH_VIEW) };
  const openClose = { preHandler: app.requirePermission(PERMISSIONS.CASH_OPEN_CLOSE) };
  const move = { preHandler: app.requirePermission(PERMISSIONS.CASH_MOVE) };

  /** 0.37.0 `?brief=true`: only whether a shift is open (no totals, no movements). */
  app.get('/cash/status', view, async (request) => {
    const { brief } = z
      .object({ brief: z.enum(['true', 'false']).optional() })
      .parse(request.query);
    return brief === 'true' ? services.cash.statusBrief() : services.cash.status();
  });
  app.get('/cash/shifts', view, async (request) =>
    services.cash.listShifts(cashShiftListQuerySchema.parse(request.query)),
  );
  app.get('/cash/shifts/:id', view, async (request) => {
    const shift = await services.cash.getShift(idParams.parse(request.params).id);
    if (!shift) throw notFound('Cash shift');
    return shift;
  });
  app.post('/cash/shifts/open', openClose, async (request, reply) =>
    reply
      .code(201)
      .send(await services.cash.open(openShiftSchema.parse(request.body), actorOf(request))),
  );
  app.post('/cash/shifts/:id/close', openClose, async (request) =>
    services.cash.close(
      idParams.parse(request.params).id,
      closeShiftSchema.parse(request.body),
      actorOf(request),
    ),
  );
  app.post('/cash/movements', move, async (request, reply) =>
    reply
      .code(201)
      .send(await services.cash.move(cashMovementSchema.parse(request.body), actorOf(request))),
  );
};
