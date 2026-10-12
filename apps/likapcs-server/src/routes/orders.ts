/**
 * Orders from the PC + customer pause / resume (0.10.0).
 *
 * PC side (device-token authenticated, like the other `/client/*` routes):
 *   GET    /client/menu                 what can be ordered right now (needs a running session)
 *   POST   /client/orders               send an order            → 201 StationOrder
 *   GET    /client/orders               open / recent orders of the running session
 *   GET    /client/orders/:id           one order (reconnects / missed pushes)
 *   DELETE /client/orders/:id           the customer takes a pending order back
 *   POST   /client/session-pause        the customer pauses their own session (screen covered)
 *   POST   /client/session-resume       "Resume" on the paused screen
 *
 * Admin side:
 *   GET    /orders?open=true            the desk's list (pending first)
 *   GET    /orders/:id
 *   POST   /orders/:id/accept           {settlement, payments?, customerId?}   stations.control (+ pos.sell for pay now)
 *   POST   /orders/:id/pay              {payments, customerId?}                pos.sell
 *   POST   /orders/:id/reject           {reason?}                              stations.control
 *   POST   /orders/:id/void             {reason}                               stations.control
 *   GET    /catalog/menu                products on the PC menu                products.view
 *   PUT    /catalog/menu                {productIds} — replaces the menu       products.manage
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  clientMenuSetSchema,
  orderAcceptSchema,
  orderCreateSchema,
  orderListQuerySchema,
  orderPaySchema,
  orderRejectSchema,
  orderVoidSchema,
  productListQuerySchema,
  uuidSchema,
} from '@likapcs/shared';
import { notFound, unauthorized } from '../errors.js';

export const orderRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
  });
  const saleActorOf = (request: FastifyRequest) => ({
    ...actorOf(request),
    permissions: request.auth!.permissions,
  });
  const deviceOf = async (request: FastifyRequest) => {
    const header = request.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    const device =
      scheme?.toLowerCase() === 'bearer' && token
        ? await services.devices.authenticate(token.trim())
        : null;
    if (!device) throw unauthorized('Device token required');
    return device;
  };
  const customerTokenOf = (request: FastifyRequest): string | undefined => {
    const raw = request.headers['x-customer-token'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value?.trim() || undefined;
  };

  // ─── PC ──────────────────────────────────────────────────────────────────────
  app.get(
    '/client/menu',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => services.orders.menu(await deviceOf(request)),
  );

  app.post(
    '/client/orders',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const device = await deviceOf(request);
      const body = orderCreateSchema.parse(request.body);
      // A signed-in customer (0.9.0 login) is attached when the token is still valid; an order
      // never requires one — the person at the PC is the paying customer.
      const customerId = services.requests.customerIdOf(device, customerTokenOf(request));
      const created = await services.orders.create(device, body, customerId, request.ip);
      return reply.code(201).send(created);
    },
  );

  app.get(
    '/client/orders',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) => ({ items: await services.orders.listForDevice(await deviceOf(request)) }),
  );

  app.get(
    '/client/orders/:id',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) =>
      services.orders.getForDevice(await deviceOf(request), idParams.parse(request.params).id),
  );

  app.delete(
    '/client/orders/:id',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) =>
      services.orders.cancelFromDevice(await deviceOf(request), idParams.parse(request.params).id),
  );

  app.post(
    '/client/session-pause',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const device = await deviceOf(request);
      return services.sessions.pauseFromDevice(device.station.id, device.id);
    },
  );

  app.post(
    '/client/session-resume',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const device = await deviceOf(request);
      return services.sessions.resumeFromDevice(device.station.id, device.id);
    },
  );

  // ─── Admin ───────────────────────────────────────────────────────────────────
  const view = { preHandler: app.requirePermission(PERMISSIONS.STATIONS_VIEW) };
  const control = { preHandler: app.requirePermission(PERMISSIONS.STATIONS_CONTROL) };
  const sell = { preHandler: app.requirePermission(PERMISSIONS.POS_SELL) };
  const catalogView = { preHandler: app.requirePermission(PERMISSIONS.PRODUCTS_VIEW) };
  const catalogManage = { preHandler: app.requirePermission(PERMISSIONS.PRODUCTS_MANAGE) };

  app.get('/orders', view, async (request) => ({
    items: await services.orders.list(orderListQuerySchema.parse(request.query)),
  }));
  app.get('/orders/:id', view, async (request) =>
    services.orders.getById(idParams.parse(request.params).id),
  );
  /** Receipt of the sale an order produced (pay now / paid at the desk / billed with the session). */
  app.get('/orders/:id/receipt', control, async (request) => {
    const order = await services.orders.getById(idParams.parse(request.params).id);
    if (!order.saleId) throw notFound('Order has no receipt');
    return services.sales.receipt(order.saleId, actorOf(request), false);
  });
  app.post('/orders/:id/accept', control, async (request) =>
    services.orders.accept(
      idParams.parse(request.params).id,
      orderAcceptSchema.parse(request.body),
      saleActorOf(request),
    ),
  );
  app.post('/orders/:id/pay', sell, async (request) =>
    services.orders.pay(
      idParams.parse(request.params).id,
      orderPaySchema.parse(request.body),
      saleActorOf(request),
    ),
  );
  app.post('/orders/:id/reject', control, async (request) =>
    services.orders.reject(
      idParams.parse(request.params).id,
      actorOf(request),
      orderRejectSchema.parse(request.body ?? {}).reason?.trim() || null,
    ),
  );
  app.post('/orders/:id/void', control, async (request) =>
    services.orders.void(
      idParams.parse(request.params).id,
      actorOf(request),
      orderVoidSchema.parse(request.body).reason,
    ),
  );

  app.get('/catalog/menu', catalogView, async () => ({
    items: (
      await services.catalog.listProducts(
        productListQuerySchema.parse({ menu: true, active: 'active', pageSize: 500 }),
      )
    ).items.sort((a, b) => a.clientMenuOrder - b.clientMenuOrder),
  }));
  app.put('/catalog/menu', catalogManage, async (request) => ({
    items: await services.catalog.setClientMenu(
      clientMenuSetSchema.parse(request.body).productIds,
      actorOf(request),
    ),
  }));
};
