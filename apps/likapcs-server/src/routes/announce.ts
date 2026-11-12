import type { FastifyInstance } from 'fastify';
import { PERMISSIONS } from '@likapcs/shared';

/**
 * 0.31.0 / 0.34.0: a completed sale is announced to the admins who may see live tracking: the
 * sale itself and any product it pushed under its minimum stock. The sale is already committed;
 * a failed announcement must never fail the sale.
 */
export async function announceSale(app: FastifyInstance, saleId: string): Promise<void> {
  try {
    const live = await app.services.live.saleEvent(saleId);
    if (live) app.hub.broadcastToAdminsWith(PERMISSIONS.LIVE_VIEW, 'live.sale', live);
    for (const alert of await app.services.live.stockAlerts(saleId)) {
      app.hub.broadcastToAdminsWith(PERMISSIONS.LIVE_VIEW, 'stock.low', alert);
    }
  } catch (err) {
    app.log.warn({ err, saleId }, 'sale announcement failed');
  }
}

/** Announces every sale found in a session answer: `payment` of one session, or of each item. */
export function announcePayments(app: FastifyInstance, body: unknown): void {
  if (!body || typeof body !== 'object') return;
  const saleIds: string[] = [];
  const take = (o: unknown) => {
    const id = (o as { payment?: { saleId?: unknown } } | null)?.payment?.saleId;
    if (typeof id === 'string') saleIds.push(id);
  };
  take(body);
  for (const value of Object.values(body)) {
    if (Array.isArray(value)) value.forEach(take);
  }
  for (const id of new Set(saleIds)) void announceSale(app, id);
}
