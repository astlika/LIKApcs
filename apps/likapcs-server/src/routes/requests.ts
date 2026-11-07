import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  customerLoginSchema,
  sessionRequestCreateSchema,
  sessionRequestListQuerySchema,
  sessionRequestRejectSchema,
  timeClaimSchema,
  uuidSchema,
} from '@likapcs/shared';
import { unauthorized } from '../errors.js';

/**
 * Customer login on the PCs + session requests (0.9.0).
 *
 * PC side (`/client/*`, device-token authenticated like `/client/staff-unlock`):
 *   POST   /client/customer-login        username + PIN → short-lived customer token (this device only)
 *   GET    /client/request-options       what can be requested right now (quick times, packages, prices)
 *   POST   /client/session-request       create (needs `x-customer-token` from the login)
 *   GET    /client/session-request/:id   state of this PC's request (reconnects / missed pushes)
 *   DELETE /client/session-request/:id   the customer withdraws it
 *
 * Admin side: list / reject here; APPROVING is `POST /sessions {requestId}` or
 * `POST /sessions/:id/extend {requestId}` — the request is marked approved in the same
 * transaction as the session, so an approval can never happen twice and never without a session.
 */
export const requestRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
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
  // Per-PC rate limit against CPU abuse (scrypt); brute force is stopped by the per-customer lockout.
  app.post(
    '/client/customer-login',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const device = await deviceOf(request);
      const body = customerLoginSchema.parse(request.body);
      return services.requests.login(device, body, request.ip);
    },
  );

  /**
   * 0.20.8: prepaid PC time bought without a PC. The customer types the name and the PIN printed
   * on the sale; this PC starts the minutes left. They were paid at the till: nothing is billed here.
   */
  app.post(
    '/client/time-credit/claim',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const device = await deviceOf(request);
      const body = timeClaimSchema.parse(request.body);
      const credit = await services.timeCredits.findByPin(body.name, body.pin);
      await services.sessions.start(
        {
          stationId: device.station.id,
          billingMode: 'prepaid',
          // Not used: a credit is already paid, so no payment is taken here.
          paymentMethod: 'cash',
          minutes: credit.minutesLeft,
          creditId: credit.creditId,
        },
        { userId: null },
      );
      return { ok: true, minutes: credit.minutesLeft };
    },
  );

  app.post(
    '/client/customer-logout',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      await deviceOf(request);
      services.requests.logout(customerTokenOf(request));
      return { ok: true };
    },
  );

  /**
   * 0.11.0: what the PC may show about the customer — the signed-in one (token) or, without a
   * token, the customer of the running session on this PC. `{ customer: null }` when neither.
   */
  app.get(
    '/client/customer',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const device = await deviceOf(request);
      const signedIn = services.requests.customerIdOf(device, customerTokenOf(request));
      const customerId = signedIn ?? (await services.sessions.customerOfStation(device.station.id));
      return { customer: customerId ? await services.wallet.clientInfo(customerId) : null };
    },
  );

  app.get(
    '/client/request-options',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const device = await deviceOf(request);
      return services.requests.options(device);
    },
  );

  app.post(
    '/client/session-request',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const device = await deviceOf(request);
      const body = sessionRequestCreateSchema.parse(request.body);
      const created = await services.requests.create(
        device,
        customerTokenOf(request),
        body,
        request.ip,
      );
      return reply.code(201).send(created);
    },
  );

  app.get(
    '/client/session-request/:id',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) => {
      const device = await deviceOf(request);
      return services.requests.getForDevice(device, idParams.parse(request.params).id);
    },
  );

  app.delete(
    '/client/session-request/:id',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const device = await deviceOf(request);
      return services.requests.cancelFromDevice(device, idParams.parse(request.params).id);
    },
  );

  // ─── Admin ───────────────────────────────────────────────────────────────────
  const view = { preHandler: app.requirePermission(PERMISSIONS.STATIONS_VIEW) };
  const control = { preHandler: app.requirePermission(PERMISSIONS.STATIONS_CONTROL) };

  app.get('/session-requests', view, async (request) =>
    services.requests.list(sessionRequestListQuerySchema.parse(request.query)),
  );
  app.get('/session-requests/:id', view, async (request) =>
    services.requests.getById(idParams.parse(request.params).id),
  );
  app.post('/session-requests/:id/reject', control, async (request) => {
    const { reason } = sessionRequestRejectSchema.parse(request.body ?? {});
    return services.requests.reject(
      idParams.parse(request.params).id,
      actorOf(request),
      reason ?? null,
    );
  });
};
