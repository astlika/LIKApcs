import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { forbidden } from '../errors.js';
import { announceSale } from './announce.js';
import {
  PERMISSIONS,
  createSaleSchema,
  extendSessionSchema,
  startSessionSchema,
  syncSalesEnvelopeSchema,
  type OfferStartResult,
  type SaleDetail,
  type SyncSalesResponse,
  refundSchema,
  saleListQuerySchema,
  suspendSaleSchema,
  uuidSchema,
} from '@likapcs/shared';

/**
 * Point of sale. Selling needs pos.sell; discounts, suspending and refunds are checked inside the
 * service against the actor's permission set (pos.discount / pos.suspend / pos.refund).
 */
export const salesRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  const idParams = z.object({ id: uuidSchema });
  const actorOf = (request: FastifyRequest) => ({
    userId: request.auth!.user.id,
    label: request.auth!.user.username,
    ip: request.ip,
    permissions: request.auth!.permissions,
  });
  const sell = { preHandler: app.requirePermission(PERMISSIONS.POS_SELL) };

  /** 0.20.8: the price of PC time sold without a PC (the cashier's line preview). */
  app.get('/sales/time-quote', sell, async (request) => {
    const q = z
      .object({
        minutes: z.coerce
          .number()
          .int()
          .min(1)
          .max(24 * 60),
      })
      .parse(request.query);
    return services.sales.quoteTime(q.minutes);
  });
  app.get('/sales', sell, async (request) =>
    services.sales.list(saleListQuerySchema.parse(request.query)),
  );
  app.get('/sales/:id', sell, async (request) =>
    services.sales.getById(idParams.parse(request.params).id),
  );
  app.get('/sales/:id/receipt', sell, async (request) => {
    const { reprint } = z
      .object({ reprint: z.coerce.boolean().default(false) })
      .parse(request.query);
    if (reprint && !request.auth!.permissions.has(PERMISSIONS.POS_REPRINT)) {
      throw forbidden('Missing permission: pos.reprint');
    }
    return services.sales.receipt(idParams.parse(request.params).id, actorOf(request), reprint);
  });
  // Punkt 4 (0.28.0): the offline sales of one PC, synced in order. Each sale is its own
  // transaction; the answer says per sale whether it was created, a duplicate, or failed.
  app.post('/sales/sync', sell, async (request): Promise<SyncSalesResponse> => {
    const body = syncSalesEnvelopeSchema.parse(request.body);
    return { results: await services.sales.syncOffline(body.sales, actorOf(request)) };
  });
  // 0.31.0: a completed sale is announced to the admins who may see live tracking. The sale is
  // already committed; a failed announcement must never fail the sale.
  const announce = (saleId: string) => announceSale(app, saleId);
  /**
   * 0.36.0: the PC minutes of an offer go to their PC the moment the sale is paid — a free PC
   * starts with them, a running session gets them added. The sale is already committed and the
   * minutes are a paid credit of that PC (0.19.0), so nothing is lost when they cannot be given
   * at once (the PC is reserved, runs on open time, or the cashier may not control the PCs): they
   * stay paid for that PC and the desk starts them at Stations. The answer says which it was.
   */
  const giveOfferMinutes = async (
    sale: SaleDetail,
    request: FastifyRequest,
  ): Promise<SaleDetail> => {
    const waiting = await services.sales.offerCredits(sale.id);
    if (waiting.length === 0) return sale;
    const actor = actorOf(request);
    const mayControl = actor.permissions.has(PERMISSIONS.STATIONS_CONTROL);
    const offerStarts: OfferStartResult[] = [];
    for (const credit of waiting) {
      const pc = {
        stationId: credit.stationId,
        stationCode: credit.stationCode,
        minutes: credit.minutes,
      };
      if (!mayControl) {
        offerStarts.push({ ...pc, result: 'kept', reason: 'permission' });
        continue;
      }
      try {
        const live = await services.sessions.liveForStation(credit.stationId);
        if (live) {
          await services.sessions.extend(
            live.id,
            extendSessionSchema.parse({ minutes: credit.minutes, creditId: credit.creditId }),
            actor,
          );
          offerStarts.push({ ...pc, result: 'extended', reason: null });
        } else {
          await services.sessions.start(
            startSessionSchema.parse({
              stationId: credit.stationId,
              billingMode: 'prepaid',
              minutes: credit.minutes,
              creditId: credit.creditId,
              ...(sale.customerId ? { customerId: sale.customerId } : {}),
            }),
            actor,
          );
          offerStarts.push({ ...pc, result: 'started', reason: null });
        }
      } catch (err) {
        request.log.warn(
          { err, saleId: sale.id, stationId: credit.stationId },
          'offer minutes stay as a paid credit of the PC',
        );
        offerStarts.push({
          ...pc,
          result: 'kept',
          reason: err instanceof Error ? err.message : 'failed',
        });
      }
    }
    return { ...sale, offerStarts };
  };
  app.post('/sales', sell, async (request, reply) => {
    const sale = await services.sales.create(
      createSaleSchema.parse(request.body),
      actorOf(request),
    );
    await announce(sale.id);
    return reply.code(201).send(await giveOfferMinutes(sale, request));
  });
  app.post('/sales/suspend', sell, async (request, reply) =>
    reply
      .code(201)
      .send(await services.sales.suspend(suspendSaleSchema.parse(request.body), actorOf(request))),
  );
  app.post('/sales/:id/complete', sell, async (request) => {
    const sale = await services.sales.completeSuspended(
      idParams.parse(request.params).id,
      createSaleSchema.parse(request.body),
      actorOf(request),
    );
    await announce(sale.id);
    return giveOfferMinutes(sale, request);
  });
  app.post('/sales/:id/void', sell, async (request, reply) => {
    await services.sales.voidSuspended(idParams.parse(request.params).id, actorOf(request));
    return reply.code(204).send();
  });
  app.post('/sales/:id/refund', sell, async (request) =>
    services.sales.refund(
      idParams.parse(request.params).id,
      refundSchema.parse(request.body),
      actorOf(request),
    ),
  );
};
