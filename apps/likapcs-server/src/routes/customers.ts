/**
 * Customers (`customers.view` / `customers.manage`) and, since 0.11.0, their account:
 *
 *   GET  /customers/:id/statement   every receipt / repayment / wallet entry, newest first
 *   GET  /customers/:id/wallet      balance ledger (running balance after each entry)
 *   POST /customers/:id/wallet/topup     cash in → balance up          (`wallet.topup`)
 *   POST /customers/:id/wallet/withdraw  balance down → cash out       (`wallet.refund`)
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  customerListQuerySchema,
  customerPatchSchema,
  customerSchema,
  paginationQuerySchema,
  statementQuerySchema,
  uuidSchema,
  walletTopUpSchema,
  walletWithdrawSchema,
} from '@likapcs/shared';
import { notFound } from '../errors.js';

export const customerRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });
  const walletActorOf = (request: FastifyRequest) => ({
    ...actorOf(request),
    permissions: request.auth!.permissions,
  });
  const view = { preHandler: app.requirePermission(PERMISSIONS.CUSTOMERS_VIEW) };
  const manage = { preHandler: app.requirePermission(PERMISSIONS.CUSTOMERS_MANAGE) };
  const topUp = { preHandler: app.requirePermission(PERMISSIONS.WALLET_TOPUP) };
  const refund = { preHandler: app.requirePermission(PERMISSIONS.WALLET_REFUND) };

  app.get('/customers', view, async (request) =>
    services.customers.list(customerListQuerySchema.parse(request.query)),
  );
  app.get('/customers/:id', view, async (request) => {
    const customer = await services.customers.detail(idParams.parse(request.params).id);
    if (!customer) throw notFound('Customer');
    return customer;
  });
  app.post('/customers', manage, async (request, reply) =>
    reply
      .code(201)
      .send(await services.customers.create(customerSchema.parse(request.body), actorOf(request))),
  );
  app.patch('/customers/:id', manage, async (request) =>
    services.customers.update(
      idParams.parse(request.params).id,
      customerPatchSchema.parse(request.body),
      actorOf(request),
    ),
  );
  app.delete('/customers/:id', manage, async (request) =>
    services.customers.archive(idParams.parse(request.params).id, actorOf(request)),
  );

  // ─── Account (0.11.0) ────────────────────────────────────────────────────────
  app.get('/customers/:id/statement', view, async (request) =>
    services.statements.get(
      idParams.parse(request.params).id,
      statementQuerySchema.parse(request.query),
    ),
  );
  app.get('/customers/:id/wallet', view, async (request) => {
    const id = idParams.parse(request.params).id;
    const customer = await services.customers.get(id);
    if (!customer) throw notFound('Customer');
    const query = paginationQuerySchema.parse(request.query);
    const { items, total } = await services.wallet.entries(id, query);
    return { customer, items, total, page: query.page, pageSize: query.pageSize };
  });
  app.post('/customers/:id/wallet/topup', topUp, async (request, reply) =>
    reply
      .code(201)
      .send(
        await services.wallet.topUp(
          idParams.parse(request.params).id,
          walletTopUpSchema.parse(request.body),
          walletActorOf(request),
        ),
      ),
  );
  app.post('/customers/:id/wallet/withdraw', refund, async (request, reply) =>
    reply
      .code(201)
      .send(
        await services.wallet.withdraw(
          idParams.parse(request.params).id,
          walletWithdrawSchema.parse(request.body),
          walletActorOf(request),
        ),
      ),
  );
};
