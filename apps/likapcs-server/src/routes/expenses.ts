import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  createExpenseSchema,
  expenseCategorySchema,
  expenseListQuerySchema,
  uuidSchema,
  voidExpenseSchema,
} from '@likapcs/shared';
import { notFound } from '../errors.js';

export const expenseRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });
  const view = { preHandler: app.requirePermission(PERMISSIONS.EXPENSES_VIEW) };
  const manage = { preHandler: app.requirePermission(PERMISSIONS.EXPENSES_MANAGE) };

  app.get('/expenses/categories', view, async (request) => {
    const { includeInactive } = z
      .object({ includeInactive: z.coerce.boolean().default(false) })
      .parse(request.query);
    return services.expenses.categories(includeInactive);
  });
  app.post('/expenses/categories', manage, async (request, reply) =>
    reply
      .code(201)
      .send(
        await services.expenses.createCategory(
          expenseCategorySchema.parse(request.body),
          actorOf(request),
        ),
      ),
  );
  app.get('/expenses', view, async (request) =>
    services.expenses.list(expenseListQuerySchema.parse(request.query)),
  );
  app.get('/expenses/:id', view, async (request) => {
    const expense = await services.expenses.get(idParams.parse(request.params).id);
    if (!expense) throw notFound('Expense');
    return expense;
  });
  app.post('/expenses', manage, async (request, reply) =>
    reply
      .code(201)
      .send(
        await services.expenses.create(createExpenseSchema.parse(request.body), actorOf(request)),
      ),
  );
  app.post('/expenses/:id/void', manage, async (request) =>
    services.expenses.void(
      idParams.parse(request.params).id,
      voidExpenseSchema.parse(request.body).reason,
      actorOf(request),
    ),
  );
};
