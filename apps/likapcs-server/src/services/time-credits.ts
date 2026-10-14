/**
 * 0.19.0: prepaid time sold at the till (see migration 0031). Selling creates a credit inside the
 * sale's transaction; starting or extending a session on the same PC redeems minutes from it, in
 * the session's transaction. Nothing here moves money: the sale already did.
 */
import type { TimeCreditSummary } from '@likapcs/shared';
import type { DbClient, DbPool, Queryable } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { recordAudit, type AuditActor } from './audit.js';

export class TimeCreditsService {
  constructor(private readonly pool: DbPool) {}

  /** Open credits (minutes left, not cancelled) — for one PC, or every PC. */
  async open(stationId?: string, db: Queryable = this.pool): Promise<TimeCreditSummary[]> {
    const r = await db.query<{
      id: string;
      station_id: string;
      station_code: string;
      minutes_total: number;
      minutes_remaining: number;
      sale_id: string;
      created_at: Date;
    }>(
      `SELECT c.id, c.station_id, s.code AS station_code, c.minutes_total, c.minutes_remaining,
              c.sale_id, c.created_at
         FROM time_credits c JOIN stations s ON s.id = c.station_id
        WHERE c.cancelled_at IS NULL AND c.minutes_remaining > 0
          AND ($1::uuid IS NULL OR c.station_id = $1)
        ORDER BY c.created_at, c.id`,
      [stationId ?? null],
    );
    return r.rows.map((x) => ({
      id: x.id,
      stationId: x.station_id,
      stationCode: x.station_code,
      minutesTotal: x.minutes_total,
      minutesRemaining: x.minutes_remaining,
      saleId: x.sale_id,
      createdAt: x.created_at.toISOString(),
    }));
  }

  /** Written inside the sale transaction, one credit per time line. */
  async create(
    client: DbClient,
    input: {
      saleId: string;
      saleItemId: number;
      stationId: string;
      minutes: number;
      priceCents: number;
      actor: AuditActor;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO time_credits (sale_id, sale_item_id, station_id, minutes_total, minutes_remaining,
                                 price_cents, created_by)
       VALUES ($1, $2, $3, $4, $4, $5, $6)`,
      [
        input.saleId,
        input.saleItemId,
        input.stationId,
        input.minutes,
        input.priceCents,
        input.actor.userId ?? null,
      ],
    );
  }

  /**
   * Takes `minutes` from a credit for the given PC, inside the caller's transaction. The row is
   * locked; the credit must belong to that PC and hold at least the minutes asked for.
   */
  async redeem(
    client: DbClient,
    input: { creditId: string; stationId: string; minutes: number },
  ): Promise<{ creditId: string; minutesLeft: number }> {
    const r = await client.query<{
      station_id: string;
      minutes_remaining: number;
      cancelled_at: Date | null;
    }>(
      'SELECT station_id, minutes_remaining, cancelled_at FROM time_credits WHERE id = $1 FOR UPDATE',
      [input.creditId],
    );
    const row = r.rows[0];
    if (!row) throw notFound('Time credit');
    if (row.cancelled_at) throw conflict('This time credit was refunded');
    if (row.station_id !== input.stationId)
      throw badRequest('This time credit belongs to another PC');
    if (input.minutes > row.minutes_remaining)
      throw conflict(`Only ${row.minutes_remaining} minutes are left on this credit`, {
        code: 'CREDIT_INSUFFICIENT',
        minutesRemaining: row.minutes_remaining,
      });
    const left = row.minutes_remaining - input.minutes;
    await client.query('UPDATE time_credits SET minutes_remaining = $2 WHERE id = $1', [
      input.creditId,
      left,
    ]);
    return { creditId: input.creditId, minutesLeft: left };
  }

  /**
   * Refund of the sale line that sold the time: allowed only while none of the minutes were used;
   * then the credit is cancelled. Returns false when the line sold no time.
   */
  async cancelForSaleItem(
    client: DbClient,
    saleItemId: number,
    actor: AuditActor,
  ): Promise<boolean> {
    const r = await client.query<{
      id: string;
      minutes_total: number;
      minutes_remaining: number;
      cancelled_at: Date | null;
    }>(
      'SELECT id, minutes_total, minutes_remaining, cancelled_at FROM time_credits WHERE sale_item_id = $1 FOR UPDATE',
      [saleItemId],
    );
    const row = r.rows[0];
    if (!row) return false;
    if (row.cancelled_at) throw conflict('This prepaid time was already refunded');
    if (row.minutes_remaining < row.minutes_total)
      throw conflict('This prepaid time was already used — it cannot be refunded', {
        code: 'CREDIT_USED',
      });
    await client.query(
      'UPDATE time_credits SET minutes_remaining = 0, cancelled_at = now() WHERE id = $1',
      [row.id],
    );
    await recordAudit(client, actor, {
      action: 'time_credit.cancelled',
      entityType: 'time_credit',
      entityId: row.id,
      details: { minutes: row.minutes_total },
    });
    return true;
  }
}
