import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  bulkEndSessionsSchema,
  bulkMinutesSchema,
  collectSessionSchema,
  collectStationSchema,
  endSessionSchema,
  extendSessionSchema,
  sessionGiftSchema,
  sessionListQuerySchema,
  sessionQuoteSchema,
  startSessionSchema,
  uuidSchema,
} from '@likapcs/shared';
import { notFound } from '../errors.js';

/**
 * Gaming sessions. Starting/pausing/extending/ending needs stations.control; a discount on a
 * postpaid bill additionally needs pos.discount (checked in the service).
 */
export const sessionRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
    permissions: request.auth!.permissions,
  });
  const view = { preHandler: app.requirePermission(PERMISSIONS.STATIONS_VIEW) };
  const control = { preHandler: app.requirePermission(PERMISSIONS.STATIONS_CONTROL) };

  app.get('/sessions', view, async (request) =>
    services.sessions.list(sessionListQuerySchema.parse(request.query)),
  );
  // 0.19.0: open prepaid-time credits (sold at the till) — optionally for one PC.
  app.get('/time-credits', view, async (request) => {
    const q = z.object({ stationId: uuidSchema.optional() }).parse(request.query);
    return { credits: await services.timeCredits.open(q.stationId) };
  });

  app.get('/sessions/:id', view, async (request) =>
    services.sessions.getById(idParams.parse(request.params).id),
  );
  app.get('/sessions/:id/events', view, async (request) =>
    services.sessions.events(idParams.parse(request.params).id),
  );
  app.post('/sessions/quote', view, async (request) =>
    services.sessions.quote(sessionQuoteSchema.parse(request.body)),
  );
  app.post('/sessions', control, async (request, reply) => {
    const result = await services.sessions.start(
      startSessionSchema.parse(request.body),
      actorOf(request),
    );
    return reply.code(201).send(result);
  });
  app.post('/sessions/:id/pause', control, async (request) =>
    services.sessions.pause(idParams.parse(request.params).id, actorOf(request)),
  );
  app.post('/sessions/:id/resume', control, async (request) =>
    services.sessions.resume(idParams.parse(request.params).id, actorOf(request)),
  );
  app.post('/sessions/:id/extend', control, async (request) =>
    services.sessions.extend(
      idParams.parse(request.params).id,
      extendSessionSchema.parse(request.body),
      actorOf(request),
    ),
  );
  /** 0.18.0: free minutes (`stations.gift`, 0.18.1) — the PC celebrates, the audit log remembers who gave them. */
  app.post(
    '/sessions/:id/gift',
    {
      preHandler: [
        app.requirePermission(PERMISSIONS.STATIONS_CONTROL),
        app.requirePermission(PERMISSIONS.STATIONS_GIFT),
      ],
    },
    async (request) =>
      services.sessions.gift(
        idParams.parse(request.params).id,
        sessionGiftSchema.parse(request.body),
        actorOf(request),
      ),
  );
  /** 0.18.0: "+ minutes" for every selected PC in one click (gift mode also needs stations.gift). */
  app.post('/sessions/bulk-minutes', control, async (request) =>
    services.sessions.bulkMinutes(bulkMinutesSchema.parse(request.body), actorOf(request)),
  );
  /** 0.19.4: "Ndalo" for several PCs at once — nothing is charged now; bills wait at the desk. */
  app.post('/sessions/bulk-end', control, async (request) =>
    services.sessions.bulkEnd(bulkEndSessionsSchema.parse(request.body), actorOf(request)),
  );
  app.post('/sessions/:id/end', control, async (request) =>
    services.sessions.end(
      idParams.parse(request.params).id,
      endSessionSchema.parse(request.body ?? {}),
      actorOf(request),
    ),
  );
  /** End pay (0.14.0): "Collect" in the awaiting-payment strip — takes the money for an ended
   * pay-at-the-end session (time + open orders on the bill), exactly once. */
  app.post('/sessions/:id/collect', control, async (request) =>
    services.sessions.collect(
      idParams.parse(request.params).id,
      collectSessionSchema.parse(request.body ?? {}),
      actorOf(request),
    ),
  );
  /**
   * 0.21.0 — pay all: the bills waiting at one PC, paid in one tender step (one transaction; each
   * bill keeps its own receipt). Same permission as collecting a single bill.
   */
  app.post('/stations/:stationId/collect-all', control, async (request) =>
    services.sessions.collectStation(
      z.object({ stationId: uuidSchema }).parse(request.params).stationId,
      collectStationSchema.parse(request.body ?? {}),
      actorOf(request),
    ),
  );
  /**
   * 0.19.5 — collect all PCs: every bill waiting at any PC, in one tender step (one transaction).
   * Same permission as collecting a single bill; a tender that does not cover them refuses all.
   */
  app.post('/sessions/collect-all', control, async (request) =>
    services.sessions.collectAllPcs(
      collectStationSchema.parse(request.body ?? {}),
      actorOf(request),
    ),
  );
  /** Receipt of the session's bill — for the "paid" dialog after a prepaid start / extension or a
   * postpaid end. Needs stations.control only: whoever may take the money may print its receipt. */
  app.get('/sessions/:id/receipt', control, async (request) => {
    const session = await services.sessions.getById(idParams.parse(request.params).id);
    if (!session.saleId) throw notFound('Session has no bill');
    return services.sales.receipt(session.saleId, actorOf(request), false);
  });
  app.post('/sessions/:id/cancel', control, async (request) => {
    const { reason } = z.object({ reason: z.string().trim().min(2).max(200) }).parse(request.body);
    return services.sessions.cancel(idParams.parse(request.params).id, actorOf(request), reason);
  });
};
