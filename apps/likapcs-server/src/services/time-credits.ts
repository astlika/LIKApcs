/**
 * 0.19.0: prepaid time sold at the till (see migrations 0031, 0043). Selling creates a credit
 * inside the sale's transaction. A credit is used in one of two ways:
 *  - at the desk: a session is started or extended on the PC it was sold for (old credits), or
 *    on any PC (0.20.8: no PC chosen at the till);
 *  - at a PC (0.20.8): the customer types the name and the PIN printed on the sale, and the PC
 *    starts with the minutes left.
 * Nothing here moves money: the sale already did.
 */
import { randomInt } from 'node:crypto';
import type { TimeCreditSummary } from '@likapcs/shared';
import type { DbClient, DbPool, Queryable } from '../db/pool.js';
import { badRequest, conflict, notFound, tooManyRequests } from '../errors.js';
import { hashPassword, verifyPassword } from '../security/password.js';
import { recordAudit, type AuditActor } from './audit.js';

/** Wrong PINs in a row on one credit before it is locked for a while. */
const PIN_TRIES = 5;
const PIN_LOCK_MINUTES = 10;

export class TimeCreditsService {
  constructor(private readonly pool: DbPool) {}

  /**
   * Open credits (minutes left, not cancelled) — for one PC (its own credits and the ones usable
   * at any PC), or every credit.
   */
  async open(stationId?: string, db: Queryable = this.pool): Promise<TimeCreditSummary[]> {
    const r = await db.query<{
      id: string;
      station_id: string | null;
      station_code: string | null;
      holder_name: string | null;
      minutes_total: number;
      minutes_remaining: number;
      sale_id: string;
      created_at: Date;
    }>(
      `SELECT c.id, c.station_id, s.code AS station_code, c.holder_name, c.minutes_total,
              c.minutes_remaining, c.sale_id, c.created_at
         FROM time_credits c LEFT JOIN stations s ON s.id = c.station_id
        WHERE c.cancelled_at IS NULL AND c.minutes_remaining > 0
          AND ($1::uuid IS NULL OR c.station_id IS NULL OR c.station_id = $1)
        ORDER BY c.created_at, c.id`,
      [stationId ?? null],
    );
    return r.rows.map((x) => ({
      id: x.id,
      stationId: x.station_id,
      stationCode: x.station_code,
      holderName: x.holder_name,
      minutesTotal: x.minutes_total,
      minutesRemaining: x.minutes_remaining,
      saleId: x.sale_id,
      createdAt: x.created_at.toISOString(),
    }));
  }

  /**
   * Written inside the sale transaction, one credit per time line. Without a PC (`stationId`
   * null) the credit carries a PIN: its plain value is returned once, only the hash is stored.
   */
  async create(
    client: DbClient,
    input: {
      saleId: string;
      saleItemId: number;
      stationId: string | null;
      holderName: string | null;
      customerId: string | null;
      minutes: number;
      priceCents: number;
      actor: AuditActor;
    },
  ): Promise<{ creditId: string; pin: string | null }> {
    const pin = input.stationId === null ? generatePin() : null;
    const pinHash = pin === null ? null : await hashPassword(pin);
    const r = await client.query<{ id: string }>(
      `INSERT INTO time_credits (sale_id, sale_item_id, station_id, minutes_total, minutes_remaining,
                                 price_cents, created_by, holder_name, customer_id, pin_hash)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        input.saleId,
        input.saleItemId,
        input.stationId,
        input.minutes,
        input.priceCents,
        input.actor.userId ?? null,
        input.holderName,
        input.customerId,
        pinHash,
      ],
    );
    return { creditId: r.rows[0]!.id, pin };
  }

  /**
   * Takes `minutes` from a credit for the given PC, inside the caller's transaction. The row is
   * locked; the credit must be for that PC (or for any PC) and hold at least the minutes asked.
   */
  async redeem(
    client: DbClient,
    input: { creditId: string; stationId: string; minutes: number },
  ): Promise<{ creditId: string; minutesLeft: number }> {
    const r = await client.query<{
      station_id: string | null;
      minutes_remaining: number;
      cancelled_at: Date | null;
    }>(
      'SELECT station_id, minutes_remaining, cancelled_at FROM time_credits WHERE id = $1 FOR UPDATE',
      [input.creditId],
    );
    const row = r.rows[0];
    if (!row) throw notFound('Time credit');
    if (row.cancelled_at) throw conflict('This time credit was refunded');
    if (row.station_id !== null && row.station_id !== input.stationId)
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
   * The PC side (0.20.8): the credit that matches the name and the PIN. The same answer for an
   * unknown name and a wrong PIN, so nothing is revealed; wrong PINs lock the credits for a while.
   */
  async findByPin(name: string, pin: string): Promise<{ creditId: string; minutesLeft: number }> {
    const wrong = () => badRequest('The name or the PIN is wrong');
    const rows = await this.pool.query<{
      id: string;
      pin_hash: string;
      minutes_remaining: number;
      pin_locked_until: Date | null;
    }>(
      `SELECT id, pin_hash, minutes_remaining, pin_locked_until FROM time_credits
        WHERE cancelled_at IS NULL AND minutes_remaining > 0 AND pin_hash IS NOT NULL
          AND lower(holder_name) = lower($1)
        ORDER BY created_at, id`,
      [name.trim()],
    );
    if (rows.rows.length === 0) throw wrong();
    const now = Date.now();
    const open = rows.rows.filter(
      (r) => !r.pin_locked_until || r.pin_locked_until.getTime() <= now,
    );
    if (open.length === 0) throw tooManyRequests('Too many wrong PINs. Ask the desk for help.');
    for (const row of open) {
      if (await verifyPassword(pin, row.pin_hash)) {
        return { creditId: row.id, minutesLeft: row.minutes_remaining };
      }
    }
    await this.pool.query(
      `UPDATE time_credits
          SET pin_failed_count = pin_failed_count + 1,
              pin_locked_until = CASE WHEN pin_failed_count + 1 >= $2
                                      THEN now() + make_interval(mins => $3) ELSE pin_locked_until END
        WHERE id = ANY($1::uuid[])`,
      [open.map((r) => r.id), PIN_TRIES, PIN_LOCK_MINUTES],
    );
    throw wrong();
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

/** A 4-digit PIN, leading zeros kept. */
export function generatePin(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0');
}
