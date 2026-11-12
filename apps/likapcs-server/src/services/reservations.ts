/**
 * PC reservations (0.32.0). A reservation books one or more PCs for a start time. Each PC gets a
 * "hold": it stays held until the booked customer sits down (checked_in) or the tolerance passes
 * after the start time (released). The sweep (every few seconds, from app.ts) expires holds on its
 * own, so a forgotten reservation never blocks a PC for good.
 *
 * 0.33.4 — a booking for later no longer touches its PCs:
 *  - a hold matters only inside its window: from the reminder time (`starts_at - remind_minutes`)
 *    until the tolerance ends. Before that the PC is free for anyone, nothing asks, and a session
 *    started on it does not use up the booking;
 *  - inside the window `sessions.start` asks who sits down: the booked customer (the same customer
 *    record, or `reservationId` sent by the desk) uses up the hold; anyone else needs
 *    `ignoreReservation` and the booking KEEPS its PC (before 0.33.4 that start used it up);
 *  - `reservationId` also checks in an early arrival, at any time before the window ends.
 */
import type {
  CreateReservationRequest,
  ReservationStatus,
  ReservationSummary,
  UpdateReservationRequest,
} from '@likapcs/shared';
import type { DbClient, DbPool, Queryable } from '../db/pool.js';
import { afterCommit, withTransaction } from '../db/pool.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { SettingsService } from './settings.js';
import type { StationsService } from './stations.js';

interface ReservationRow {
  id: string;
  starts_at: Date;
  tolerance_minutes: number;
  remind_minutes: number;
  customer_id: string | null;
  customer_name: string;
  phone: string | null;
  notes: string | null;
  status: ReservationStatus;
  created_by_name: string | null;
  created_at: Date;
  finished_at: Date | null;
  cancelled_at: Date | null;
}

interface StationHoldRow {
  reservation_id: string;
  station_id: string;
  code: string;
  number: number;
  state: 'held' | 'checked_in' | 'released';
}

/** The hold that blocks a PC right now (see holdFor). */
export interface ActiveHold {
  reservationId: string;
  customerId: string | null;
  customerName: string;
  startsAt: Date;
  windowEndsAt: Date;
  toleranceMinutes: number;
}

const WINDOW_END = `(rv.starts_at + rv.tolerance_minutes * interval '1 minute')`;
/** 0.33.4: the moment a booking starts to matter for its PCs (the reminder time). */
const WINDOW_START = `(rv.starts_at - rv.remind_minutes * interval '1 minute')`;

interface HoldRow {
  reservation_id: string;
  customer_id: string | null;
  customer_name: string;
  starts_at: Date;
  tolerance_minutes: number;
  window_end: Date;
}

const toHold = (row: HoldRow): ActiveHold => ({
  reservationId: row.reservation_id,
  customerId: row.customer_id,
  customerName: row.customer_name,
  startsAt: row.starts_at,
  windowEndsAt: row.window_end,
  toleranceMinutes: row.tolerance_minutes,
});

export class ReservationsService {
  constructor(
    private readonly pool: DbPool,
    private readonly hub: RealtimeHub,
    private readonly settings: SettingsService,
    private readonly stations: StationsService,
  ) {}

  /**
   * The reservation that keeps `stationId` at `now`: inside its window (reminder time → end of the
   * tolerance), or null. Pass the transaction client so the check and the session insert see the
   * same state.
   */
  async holdFor(db: Queryable, stationId: string, now: Date): Promise<ActiveHold | null> {
    const result = await db.query<HoldRow>(
      `SELECT rs.reservation_id, rv.customer_id, rv.customer_name, rv.starts_at, rv.tolerance_minutes,
              ${WINDOW_END} AS window_end
         FROM reservation_stations rs
         JOIN reservations rv ON rv.id = rs.reservation_id
        WHERE rs.station_id = $1 AND rs.state = 'held'
          AND rv.status IN ('scheduled', 'active')
          AND $2::timestamptz >= ${WINDOW_START} AND $2::timestamptz < ${WINDOW_END}
        ORDER BY rv.starts_at
        LIMIT 1`,
      [stationId, now],
    );
    return result.rows[0] ? toHold(result.rows[0]) : null;
  }

  /**
   * 0.33.4: the hold of one given reservation on `stationId`, at any time before its window ends
   * (the desk checks in an early arrival), or null when that reservation does not keep this PC.
   */
  async holdOf(
    db: Queryable,
    stationId: string,
    reservationId: string,
    now: Date,
  ): Promise<ActiveHold | null> {
    const result = await db.query<HoldRow>(
      `SELECT rs.reservation_id, rv.customer_id, rv.customer_name, rv.starts_at, rv.tolerance_minutes,
              ${WINDOW_END} AS window_end
         FROM reservation_stations rs
         JOIN reservations rv ON rv.id = rs.reservation_id
        WHERE rs.station_id = $1 AND rs.reservation_id = $2 AND rs.state = 'held'
          AND rv.status IN ('scheduled', 'active') AND $3::timestamptz < ${WINDOW_END}`,
      [stationId, reservationId, now],
    );
    return result.rows[0] ? toHold(result.rows[0]) : null;
  }

  /** The booked customer sat down at a held PC: the hold is used up by that session (same transaction). */
  async checkIn(
    db: DbClient,
    stationId: string,
    reservationId: string,
    sessionId: string,
  ): Promise<void> {
    await db.query(
      `UPDATE reservation_stations SET state = 'checked_in', checked_in_session_id = $3
        WHERE reservation_id = $1 AND station_id = $2`,
      [reservationId, stationId, sessionId],
    );
    await db.query(
      `UPDATE reservations SET status = 'completed', finished_at = now()
        WHERE id = $1 AND status IN ('scheduled', 'active')
          AND NOT EXISTS (SELECT 1 FROM reservation_stations
                           WHERE reservation_id = $1 AND state = 'held')`,
      [reservationId],
    );
    afterCommit(db, () => this.announce());
  }

  async list(
    query: { from?: string; to?: string },
    now: Date = new Date(),
  ): Promise<ReservationSummary[]> {
    const from = query.from ? new Date(query.from) : new Date(now.getTime() - 3 * 3600_000);
    const to = query.to ? new Date(query.to) : new Date(now.getTime() + 36 * 3600_000);
    const rows = await this.pool.query<ReservationRow>(
      `SELECT * FROM reservations
        WHERE (status IN ('scheduled', 'active') OR starts_at >= $1)
          AND starts_at <= $2
        ORDER BY starts_at, customer_name`,
      [from, to],
    );
    return this.withStations(rows.rows);
  }

  async getById(id: string, db: Queryable = this.pool): Promise<ReservationSummary> {
    const rows = await db.query<ReservationRow>('SELECT * FROM reservations WHERE id = $1', [id]);
    const row = rows.rows[0];
    if (!row) throw notFound('Reservation');
    return (await this.withStations([row], db))[0]!;
  }

  async create(input: CreateReservationRequest, actor: AuditActor): Promise<ReservationSummary> {
    const now = new Date();
    const startsAt = new Date(input.startsAt);
    const toleranceMinutes =
      input.toleranceMinutes ?? (await this.settings.get('reservations.tolerance_minutes'));
    const remindMinutes =
      input.remindMinutes ?? (await this.settings.get('reservations.reminder_minutes'));
    const windowEnd = new Date(startsAt.getTime() + toleranceMinutes * 60_000);
    if (windowEnd.getTime() <= now.getTime()) throw badRequest('Reservation time has passed');

    const stationIds = [...new Set(input.stationIds)];
    await this.assertBookable(this.pool, stationIds);
    await this.assertNoOverlap(this.pool, stationIds, startsAt, windowEnd, null);

    let customerName = input.customerName;
    if (input.customerId) {
      const customer = await this.pool.query<{ name: string }>(
        'SELECT name FROM customers WHERE id = $1',
        [input.customerId],
      );
      if (!customer.rows[0]) throw notFound('Customer');
      customerName = customer.rows[0].name || customerName;
    }

    const id = await withTransaction(this.pool, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO reservations (starts_at, tolerance_minutes, remind_minutes, customer_id, customer_name,
                                   phone, notes, created_by, created_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          startsAt,
          toleranceMinutes,
          remindMinutes,
          input.customerId ?? null,
          customerName,
          input.phone || null,
          input.notes || null,
          actor.userId ?? null,
          actor.label ?? null,
        ],
      );
      const reservationId = inserted.rows[0]!.id;
      for (const stationId of stationIds) {
        await client.query(
          'INSERT INTO reservation_stations (reservation_id, station_id) VALUES ($1, $2)',
          [reservationId, stationId],
        );
      }
      await recordAudit(client, actor, {
        action: 'reservation.create',
        entityType: 'reservation',
        entityId: reservationId,
        details: {
          startsAt: startsAt.toISOString(),
          toleranceMinutes,
          remindMinutes,
          stations: stationIds.length,
        },
      });
      afterCommit(client, () => this.announce(stationIds));
      return reservationId;
    });
    return this.getById(id);
  }

  async cancel(id: string, actor: AuditActor): Promise<ReservationSummary> {
    await withTransaction(this.pool, async (client) => {
      const current = await client.query<{ status: ReservationStatus }>(
        'SELECT status FROM reservations WHERE id = $1 FOR UPDATE',
        [id],
      );
      const row = current.rows[0];
      if (!row) throw notFound('Reservation');
      if (row.status !== 'scheduled' && row.status !== 'active') {
        throw conflict('Reservation already finished');
      }
      await client.query(
        `UPDATE reservations SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
        [id],
      );
      const released = await client.query<{ station_id: string }>(
        `UPDATE reservation_stations SET state = 'released'
          WHERE reservation_id = $1 AND state = 'held' RETURNING station_id`,
        [id],
      );
      await recordAudit(client, actor, {
        action: 'reservation.cancel',
        entityType: 'reservation',
        entityId: id,
        details: {},
      });
      const stationIds = released.rows.map((r) => r.station_id);
      afterCommit(client, () => this.announce(stationIds));
    });
    return this.getById(id);
  }

  /**
   * Changes an open reservation (0.33.4; the tolerance alone since 0.32.0): time, PCs, name, phone,
   * notes, tolerance, reminder. The PCs still waiting are replaced by `stationIds`; a PC whose
   * customer already sat down stays. A shorter tolerance can release the PCs at once.
   */
  async update(
    id: string,
    patch: UpdateReservationRequest,
    actor: AuditActor,
  ): Promise<ReservationSummary> {
    const now = new Date();
    let customerName = patch.customerName;
    if (patch.customerId) {
      const customer = await this.pool.query<{ name: string }>(
        'SELECT name FROM customers WHERE id = $1',
        [patch.customerId],
      );
      if (!customer.rows[0]) throw notFound('Customer');
      customerName = customer.rows[0].name || customerName;
    }
    await withTransaction(this.pool, async (client) => {
      const current = await client.query<ReservationRow>(
        'SELECT * FROM reservations WHERE id = $1 FOR UPDATE',
        [id],
      );
      const row = current.rows[0];
      if (!row) throw notFound('Reservation');
      if (row.status !== 'scheduled' && row.status !== 'active') {
        throw conflict('Reservation already finished');
      }
      const startsAt = patch.startsAt ? new Date(patch.startsAt) : row.starts_at;
      const toleranceMinutes = patch.toleranceMinutes ?? row.tolerance_minutes;
      const remindMinutes = patch.remindMinutes ?? row.remind_minutes;
      const windowEnd = new Date(startsAt.getTime() + toleranceMinutes * 60_000);
      const moved = startsAt.getTime() !== row.starts_at.getTime();
      if (moved && windowEnd.getTime() <= now.getTime()) {
        throw badRequest('Reservation time has passed');
      }

      const holds = await client.query<{ station_id: string; state: StationHoldRow['state'] }>(
        'SELECT station_id, state FROM reservation_stations WHERE reservation_id = $1 FOR UPDATE',
        [id],
      );
      const stateOf = new Map(holds.rows.map((h) => [h.station_id, h.state]));
      const wanted = patch.stationIds ? [...new Set(patch.stationIds)] : null;
      // The PCs that wait for the customer after this change.
      const waiting = wanted
        ? wanted.filter((stationId) => stateOf.get(stationId) !== 'checked_in')
        : holds.rows.filter((h) => h.state === 'held').map((h) => h.station_id);
      const added = waiting.filter((stationId) => stateOf.get(stationId) !== 'held');
      const removed = wanted
        ? holds.rows
            .filter((h) => h.state !== 'checked_in' && !wanted.includes(h.station_id))
            .map((h) => h.station_id)
        : [];
      if (added.length > 0) await this.assertBookable(client, added);
      if (waiting.length > 0 && (moved || added.length > 0 || patch.toleranceMinutes !== undefined)) {
        await this.assertNoOverlap(client, waiting, startsAt, windowEnd, id);
      }

      await client.query(
        `UPDATE reservations
            SET starts_at = $2, tolerance_minutes = $3, remind_minutes = $4,
                customer_id = $5, customer_name = $6, phone = $7, notes = $8,
                status = CASE WHEN $2::timestamptz > $9::timestamptz THEN 'scheduled' ELSE 'active' END
          WHERE id = $1`,
        [
          id,
          startsAt,
          toleranceMinutes,
          remindMinutes,
          patch.customerId === undefined ? row.customer_id : patch.customerId,
          customerName ?? row.customer_name,
          patch.phone === undefined ? row.phone : patch.phone || null,
          patch.notes === undefined ? row.notes : patch.notes || null,
          now,
        ],
      );
      if (removed.length > 0) {
        await client.query(
          'DELETE FROM reservation_stations WHERE reservation_id = $1 AND station_id = ANY($2::uuid[])',
          [id, removed],
        );
      }
      for (const stationId of added) {
        await client.query(
          `INSERT INTO reservation_stations (reservation_id, station_id) VALUES ($1, $2)
           ON CONFLICT (reservation_id, station_id)
           DO UPDATE SET state = 'held', checked_in_session_id = NULL`,
          [id, stationId],
        );
      }
      const changed = Object.keys(patch).filter(
        (key) => (patch as Record<string, unknown>)[key] !== undefined,
      );
      await recordAudit(client, actor, {
        // The tolerance alone keeps its own action name (as before 0.33.4).
        action:
          changed.length === 1 && changed[0] === 'toleranceMinutes'
            ? 'reservation.tolerance'
            : 'reservation.update',
        entityType: 'reservation',
        entityId: id,
        details: {
          changed,
          startsAt: startsAt.toISOString(),
          toleranceMinutes,
          remindMinutes,
          stations: waiting.length,
        },
      });
      afterCommit(client, () => this.announce([...new Set([...waiting, ...removed])]));
    });
    await this.sweep();
    return this.getById(id);
  }

  /**
   * 0.33.4: the booked customer already sits at PCs of the booking (their sessions run): those
   * holds are marked as arrived. PCs with no running session are left waiting (they are started
   * with `reservationId`). Returns the reservation and the PCs marked.
   */
  async markArrived(
    id: string,
    stationIds: string[] | undefined,
    actor: AuditActor,
  ): Promise<{ reservation: ReservationSummary; checkedIn: string[] }> {
    const checkedIn = await withTransaction(this.pool, async (client) => {
      const current = await client.query<{ status: ReservationStatus }>(
        'SELECT status FROM reservations WHERE id = $1 FOR UPDATE',
        [id],
      );
      const row = current.rows[0];
      if (!row) throw notFound('Reservation');
      if (row.status !== 'scheduled' && row.status !== 'active') {
        throw conflict('Reservation already finished');
      }
      const live = await client.query<{ station_id: string; session_id: string }>(
        `SELECT rs.station_id, g.id AS session_id
           FROM reservation_stations rs
           JOIN gaming_sessions g ON g.station_id = rs.station_id AND g.status IN ('active', 'paused')
          WHERE rs.reservation_id = $1 AND rs.state = 'held'
            AND ($2::uuid[] IS NULL OR rs.station_id = ANY($2::uuid[]))
          ORDER BY rs.station_id`,
        [id, stationIds ?? null],
      );
      for (const hold of live.rows) {
        await this.checkIn(client, hold.station_id, id, hold.session_id);
      }
      if (live.rows.length > 0) {
        await recordAudit(client, actor, {
          action: 'reservation.check_in',
          entityType: 'reservation',
          entityId: id,
          details: { stations: live.rows.length },
        });
        const marked = live.rows.map((h) => h.station_id);
        afterCommit(client, () => this.announce(marked));
      }
      return live.rows.map((h) => h.station_id);
    });
    return { reservation: await this.getById(id), checkedIn };
  }

  /**
   * Expires what the clock has passed: scheduled reservations become active at their start; holds
   * past their window are released; a reservation with no held PC left is completed (everyone came)
   * or expired (someone did not). Announces what changed; quiet otherwise.
   */
  async sweep(now: Date = new Date()): Promise<void> {
    const released = await this.pool.query<{ station_id: string }>(
      `UPDATE reservation_stations rs SET state = 'released'
         FROM reservations rv
        WHERE rv.id = rs.reservation_id AND rs.state = 'held'
          AND rv.status IN ('scheduled', 'active') AND $1::timestamptz >= ${WINDOW_END}
       RETURNING rs.station_id`,
      [now],
    );
    const activated = await this.pool.query(
      `UPDATE reservations SET status = 'active'
        WHERE status = 'scheduled' AND starts_at <= $1::timestamptz`,
      [now],
    );
    const finished = await this.pool.query(
      `UPDATE reservations rv SET
          status = CASE WHEN EXISTS (SELECT 1 FROM reservation_stations
                                      WHERE reservation_id = rv.id AND state = 'released')
                        THEN 'expired' ELSE 'completed' END,
          finished_at = $1::timestamptz
        WHERE rv.status IN ('scheduled', 'active')
          AND NOT EXISTS (SELECT 1 FROM reservation_stations
                           WHERE reservation_id = rv.id AND state = 'held')`,
      [now],
    );
    const changed = (activated.rowCount ?? 0) + (finished.rowCount ?? 0) + released.rowCount!;
    if (changed > 0) await this.announce(released.rows.map((r) => r.station_id));
  }

  /** Every PC must exist, be enabled and not archived. */
  private async assertBookable(db: Queryable, stationIds: string[]): Promise<void> {
    const stationRows = await db.query<{
      id: string;
      is_enabled: boolean;
      archived_at: Date | null;
    }>('SELECT id, is_enabled, archived_at FROM stations WHERE id = ANY($1::uuid[])', [stationIds]);
    if (stationRows.rowCount !== stationIds.length) throw notFound('Station');
    if (stationRows.rows.some((s) => !s.is_enabled || s.archived_at)) {
      throw conflict('Station is disabled');
    }
  }

  /** No other open booking may keep one of these PCs in [startsAt, windowEnd). */
  private async assertNoOverlap(
    db: Queryable,
    stationIds: string[],
    startsAt: Date,
    windowEnd: Date,
    exceptReservationId: string | null,
  ): Promise<void> {
    const overlaps = await db.query<{ station_id: string; code: string }>(
      `SELECT rs.station_id, s.code
         FROM reservation_stations rs
         JOIN reservations rv ON rv.id = rs.reservation_id
         JOIN stations s ON s.id = rs.station_id
        WHERE rs.station_id = ANY($1::uuid[]) AND rs.state = 'held'
          AND rv.status IN ('scheduled', 'active')
          AND ($4::uuid IS NULL OR rv.id <> $4)
          AND rv.starts_at < $3::timestamptz AND ${WINDOW_END} > $2::timestamptz`,
      [stationIds, startsAt, windowEnd, exceptReservationId],
    );
    if (overlaps.rows.length > 0) {
      throw new AppError(409, 'reservation_overlap', 'A PC is already reserved at this time', {
        codes: overlaps.rows.map((o) => o.code),
      });
    }
  }

  /** Tells the admins: the reservation list changed, and these PC cards must refetch. */
  private async announce(stationIds: string[] = []): Promise<void> {
    this.hub.broadcastToAdmins('reservation.changed', { at: new Date().toISOString() });
    for (const stationId of stationIds) await this.stations.broadcastStation(stationId);
  }

  private async withStations(rows: ReservationRow[], db: Queryable = this.pool): Promise<ReservationSummary[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const holds = await db.query<StationHoldRow>(
      `SELECT rs.reservation_id, rs.station_id, s.code, s.number, rs.state
         FROM reservation_stations rs JOIN stations s ON s.id = rs.station_id
        WHERE rs.reservation_id = ANY($1::uuid[])
        ORDER BY s.sort_order, s.number`,
      [ids],
    );
    return rows.map((row) => {
      const windowEnd = new Date(row.starts_at.getTime() + row.tolerance_minutes * 60_000);
      return {
        id: row.id,
        startsAt: row.starts_at.toISOString(),
        toleranceMinutes: row.tolerance_minutes,
        windowEndsAt: windowEnd.toISOString(),
        remindMinutes: row.remind_minutes,
        remindAt: new Date(row.starts_at.getTime() - row.remind_minutes * 60_000).toISOString(),
        status: row.status,
        customerId: row.customer_id,
        customerName: row.customer_name,
        phone: row.phone,
        notes: row.notes,
        stations: holds.rows
          .filter((h) => h.reservation_id === row.id)
          .map((h) => ({
            stationId: h.station_id,
            code: h.code,
            number: h.number,
            state: h.state,
          })),
        createdByName: row.created_by_name,
        createdAt: row.created_at.toISOString(),
        finishedAt: row.finished_at?.toISOString() ?? null,
        cancelledAt: row.cancelled_at?.toISOString() ?? null,
      };
    });
  }
}
