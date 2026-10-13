/**
 * Customer debts ("pay later"). Permissions reuse the existing ones on purpose — no new role
 * setup is needed to use the feature:
 *   customers.view    see the ledger and the overview
 *   pos.sell          take a repayment at the counter (it is a cash-drawer operation)
 *   customers.manage  agree a new due date
 *   debts.write_off   forgive a debt (owner / admin / manager by default)
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  debtListQuerySchema,
  debtPaymentSchema,
  debtRescheduleSchema,
  debtWriteOffSchema,
  uuidSchema,
} from '@likapcs/shared';
import { notFound } from '../errors.js';

export const debtRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });
  const view = { preHandler: app.requirePermission(PERMISSIONS.CUSTOMERS_VIEW) };
  const collect = { preHandler: app.requirePermission(PERMISSIONS.POS_SELL) };
  const manage = { preHandler: app.requirePermission(PERMISSIONS.CUSTOMERS_MANAGE) };
  const writeOff = { preHandler: app.requirePermission(PERMISSIONS.DEBTS_WRITE_OFF) };

  app.get('/debts', view, async (request) =>
    services.debts.list(debtListQuerySchema.parse(request.query)),
  );
  app.get('/debts/overview', view, async () => services.debts.overview());
  app.get('/debts/:id', view, async (request) => {
    const debt = await services.debts.get(idParams.parse(request.params).id);
    if (!debt) throw notFound('Debt');
    return debt;
  });
  app.post('/debts/:id/pay', collect, async (request) =>
    services.debts.pay(
      idParams.parse(request.params).id,
      debtPaymentSchema.parse(request.body),
      actorOf(request),
    ),
  );
  app.post('/customers/:id/debts/pay', collect, async (request) =>
    services.debts.payCustomer(
      idParams.parse(request.params).id,
      debtPaymentSchema.parse(request.body),
      actorOf(request),
    ),
  );
  app.post('/debts/:id/reschedule', manage, async (request) =>
    services.debts.reschedule(
      idParams.parse(request.params).id,
      debtRescheduleSchema.parse(request.body),
      actorOf(request),
    ),
  );
  app.post('/customers/:id/debts/reschedule', manage, async (request) =>
    services.debts.rescheduleCustomer(
      idParams.parse(request.params).id,
      debtRescheduleSchema.parse(request.body),
      actorOf(request),
    ),
  );
  app.post('/debts/:id/write-off', writeOff, async (request) =>
    services.debts.writeOff(
      idParams.parse(request.params).id,
      debtWriteOffSchema.parse(request.body),
      actorOf(request),
    ),
  );
};
