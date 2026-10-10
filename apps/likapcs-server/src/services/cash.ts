/**
 * Cash register: shifts (open → movements → close with a counted amount), manual deposits and
 * withdrawals, and the hook that links every cash tender (sales, session bills, refunds, drawer
 * expenses) to the shift that was open at that moment.
 *
 * Rules
 *  • One open shift per register (unique partial index). The default register is the first active
 *    one; installations get "Main register" from migration 0009.
 *  • `cash_movements` is the authoritative drawer ledger: positive = into the drawer, negative =
 *    out. Expected cash = opening + Σ movements (excluding the 'opening' row itself).
 *  • With `cash.require_open_shift` (default true) a cash tender is refused with
 *    409 `SHIFT_REQUIRED` when no shift is open — the Admin app then offers to open one.
 *  • Closing stores expected/counted/difference permanently; a closed shift is immutable.
 */
import type {
  CashMovementRequest,
  CashMovementSummary,
  CashMovementType,
  CashRegisterSummary,
  CashShiftDetail,
  CashShiftListQuery,
  CashShiftSummary,
  CashShiftTotals,
  CashStatusResponse,
  CloseShiftRequest,
  OpenShiftRequest,
  Paginated,
} from '@likapcs/shared';
import type { DbClient, DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { SettingsService } from './settings.js';

export interface CashActor extends AuditActor {
  userId: string;
}

interface ShiftRow {
  id: string;
  register_id: string;
  register_name: string;
  status: 'open' | 'closed';
  opened_by: string;
  opened_by_name: string;
  opened_at: Date;
  opening_cents: string;
  closed_by: string | null;
  closed_by_name: string | null;
  closed_at: Date | null;
  expected_cash_cents: string | null;
  counted_cash_cents: string | null;
  difference_cents: string | null;
  notes: string | null;
}

interface MovementRow {
  id: string;
  shift_id: string;
  movement_type: CashMovementType;
  amount_cents: string;
  reason: string | null;
  reference_type: string | null;
  reference_id: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
}

const SHIFT_SELECT = `
  SELECT cs.id, cs.register_id, r.name AS register_name, cs.status, cs.opened_by,
         ou.full_name AS opened_by_name, cs.opened_at, cs.opening_cents, cs.closed_by,
         cu.full_name AS closed_by_name, cs.closed_at, cs.expected_cash_cents, cs.counted_cash_cents,
         cs.difference_cents, cs.notes
    FROM cash_shifts cs
    JOIN cash_registers r ON r.id = cs.register_id
    JOIN users ou ON ou.id = cs.opened_by
    LEFT JOIN users cu ON cu.id = cs.closed_by`;

const MOVEMENT_SELECT = `
  SELECT m.id::text, m.shift_id, m.movement_type, m.amount_cents, m.reason, m.reference_type,
         m.reference_id, m.created_by, u.full_name AS created_by_name, m.created_at
    FROM cash_movements m
    LEFT JOIN users u ON u.id = m.created_by`;

function toShift(r: ShiftRow): CashShiftSummary {
  return {
    id: r.id,
    registerId: r.register_id,
    registerName: r.register_name,
    status: r.status,
    openedBy: { id: r.opened_by, name: r.opened_by_name },
    openedAt: r.opened_at.toISOString(),
    openingCents: Number(r.opening_cents),
    closedBy: r.closed_by ? { id: r.closed_by, name: r.closed_by_name ?? '' } : null,
    closedAt: r.closed_at ? r.closed_at.toISOString() : null,
    expectedCashCents: r.expected_cash_cents === null ? null : Number(r.expected_cash_cents),
    countedCashCents: r.counted_cash_cents === null ? null : Number(r.counted_cash_cents),
    differenceCents: r.difference_cents === null ? null : Number(r.difference_cents),
    notes: r.notes,
  };
}

function toMovement(r: MovementRow): CashMovementSummary {
  return {
    id: Number(r.id),
    shiftId: r.shift_id,
    type: r.movement_type,
    amountCents: Number(r.amount_cents),
    reason: r.reason,
    referenceType: r.reference_type,
    referenceId: r.reference_id,
    createdBy: r.created_by ? { id: r.created_by, name: r.created_by_name ?? '' } : null,
    createdAt: r.created_at.toISOString(),
  };
}

/** Thrown (as 409) when a cash tender needs an open shift and there is none. */
export const shiftRequired = () =>
  new AppError(409, 'SHIFT_REQUIRED', 'Open the cash register (start a shift) before taking cash');

export class CashService {
  constructor(
    private readonly pool: DbPool,
    private readonly settings: SettingsService,
  ) {}

  // ── Registers & status ──────────────────────────────────────────────────────

  async registers(db: Queryable = this.pool): Promise<CashRegisterSummary[]> {
    const r = await db.query<{
      id: string;
      name: string;
      is_active: boolean;
      open_shift_id: string | null;
    }>(
      `SELECT r.id, r.name, r.is_active,
              (SELECT id FROM cash_shifts WHERE register_id = r.id AND status = 'open') AS open_shift_id
         FROM cash_registers r ORDER BY r.created_at, r.name`,
    );
    return r.rows.map((x) => ({
      id: x.id,
      name: x.name,
      isActive: x.is_active,
      openShiftId: x.open_shift_id,
    }));
  }

  async status(): Promise<CashStatusResponse> {
    const registers = await this.registers();
    const main = registers.find((r) => r.isActive) ?? registers[0] ?? null;
    const current = main?.openShiftId ? await this.getShift(main.openShiftId) : null;
    return {
      registers,
      current,
      requireOpenShift: await this.settings.get('cash.require_open_shift'),
      differenceWarningCents: await this.settings.get('cash.difference_warning_cents'),
    };
  }

  /** The open shift of the given (or default) register, or null. */
  async openShift(db: Queryable, registerId?: string | null): Promise<CashShiftSummary | null> {
    const r = await db.query<ShiftRow>(
      `${SHIFT_SELECT}
        WHERE cs.status = 'open' AND ($1::uuid IS NULL OR cs.register_id = $1)
        ORDER BY r.is_active DESC, r.created_at
        LIMIT 1`,
      [registerId ?? null],
    );
    return r.rows[0] ? toShift(r.rows[0]) : null;
  }

  // ── Shift lifecycle ─────────────────────────────────────────────────────────

  async open(input: OpenShiftRequest, actor: CashActor): Promise<CashShiftDetail> {
    const shiftId = await withTransaction(this.pool, async (client) => {
      const reg = await client.query<{ id: string; is_active: boolean }>(
        input.registerId
          ? 'SELECT id, is_active FROM cash_registers WHERE id = $1 FOR UPDATE'
          : 'SELECT id, is_active FROM cash_registers WHERE is_active ORDER BY created_at LIMIT 1 FOR UPDATE',
        input.registerId ? [input.registerId] : [],
      );
      const register = reg.rows[0];
      if (!register) throw notFound('Cash register');
      if (!register.is_active) throw conflict('This cash register is inactive');
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM cash_shifts WHERE register_id = $1 AND status = 'open'`,
        [register.id],
      );
      if (existing.rows[0]) throw conflict('A shift is already open on this register');
      const ins = await client.query<{ id: string }>(
        `INSERT INTO cash_shifts (register_id, opened_by, opening_cents, notes)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [register.id, actor.userId, input.openingCents, input.notes ?? null],
      );
      const id = ins.rows[0]!.id;
      await client.query(
        `INSERT INTO cash_movements (shift_id, movement_type, amount_cents, reason, created_by)
         SELECT $1, 'opening', $2::bigint, 'Opening float', $3 WHERE $2::bigint <> 0`,
        [id, input.openingCents, actor.userId],
      );
      await recordAudit(client, actor, {
        action: 'cash.shift.open',
        entityType: 'cash_shift',
        entityId: id,
        details: { registerId: register.id, openingCents: input.openingCents },
      });
      return id;
    });
    return (await this.getShift(shiftId))!;
  }

  async close(
    shiftId: string,
    input: CloseShiftRequest,
    actor: CashActor,
  ): Promise<CashShiftDetail> {
    await withTransaction(this.pool, async (client) => {
      const row = await client.query<{ status: string }>(
        'SELECT status FROM cash_shifts WHERE id = $1 FOR UPDATE',
        [shiftId],
      );
      if (!row.rows[0]) throw notFound('Cash shift');
      if (row.rows[0].status !== 'open') throw conflict('This shift is already closed');
      const expected = await this.expectedCash(client, shiftId);
      const difference = input.countedCashCents - expected;
      await client.query(
        `UPDATE cash_shifts
            SET status = 'closed', closed_by = $2, closed_at = now(), expected_cash_cents = $3,
                counted_cash_cents = $4, difference_cents = $5,
                notes = CASE WHEN $6::text IS NULL THEN notes ELSE concat_ws(chr(10), notes, $6::text) END
          WHERE id = $1`,
        [shiftId, actor.userId, expected, input.countedCashCents, difference, input.notes ?? null],
      );
      const warn = await this.settings.get('cash.difference_warning_cents');
      await recordAudit(client, actor, {
        action: 'cash.shift.close',
        entityType: 'cash_shift',
        entityId: shiftId,
        details: {
          expectedCents: expected,
          countedCents: input.countedCashCents,
          differenceCents: difference,
        },
        severity: Math.abs(difference) > warn ? 'warning' : 'info',
      });
    });
    return (await this.getShift(shiftId))!;
  }

  /** Manual deposit (cash added to the drawer) or withdrawal (cash taken out, e.g. to the safe). */
  async move(
    input: CashMovementRequest,
    actor: CashActor,
    registerId?: string,
  ): Promise<CashShiftDetail> {
    const shiftId = await withTransaction(this.pool, async (client) => {
      const shift = await this.lockOpenShift(client, registerId);
      if (!shift) throw shiftRequired();
      const amount = input.type === 'deposit' ? input.amountCents : -input.amountCents;
      if (input.type === 'withdrawal') {
        const expected = await this.expectedCash(client, shift.id);
        if (input.amountCents > expected)
          throw badRequest('Withdrawal exceeds the cash in the drawer', {
            code: 'INSUFFICIENT_CASH',
            availableCents: expected,
          });
      }
      await client.query(
        `INSERT INTO cash_movements (shift_id, movement_type, amount_cents, reason, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [shift.id, input.type, amount, input.reason, actor.userId],
      );
      await recordAudit(client, actor, {
        action: `cash.${input.type}`,
        entityType: 'cash_shift',
        entityId: shift.id,
        details: { amountCents: input.amountCents, reason: input.reason },
      });
      return shift.id;
    });
    return (await this.getShift(shiftId))!;
  }

  // ── Hook used by sales / sessions / expenses inside their own transaction ──

  /**
   * Records a cash tender in the open shift's ledger and returns the shift id to store on the
   * payment/sale row. Non-cash methods only get the shift id (for shift-level sales reports).
   * Returns null when no shift is open and the setting allows cash outside shifts.
   */
  async attachTender(
    client: DbClient,
    tender: {
      method: string;
      /** Net cash that changed hands: positive into the drawer, negative out (refunds). */
      amountCents: number;
      type: Extract<
        CashMovementType,
        'sale' | 'refund' | 'expense' | 'supplier_payment' | 'correction'
      >;
      referenceType: string;
      referenceId: string;
      reason?: string | null;
      actorUserId: string | null;
    },
  ): Promise<string | null> {
    const shift = await this.lockOpenShift(client);
    if (!shift) {
      if (tender.method === 'cash' && (await this.settings.get('cash.require_open_shift')))
        throw shiftRequired();
      return null;
    }
    if (tender.method === 'cash' && tender.amountCents !== 0) {
      await client.query(
        `INSERT INTO cash_movements (shift_id, movement_type, amount_cents, reason, reference_type, reference_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          shift.id,
          tender.type,
          tender.amountCents,
          tender.reason ?? null,
          tender.referenceType,
          tender.referenceId,
          tender.actorUserId,
        ],
      );
    }
    return shift.id;
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  async getShift(shiftId: string, db: Queryable = this.pool): Promise<CashShiftDetail | null> {
    const r = await db.query<ShiftRow>(`${SHIFT_SELECT} WHERE cs.id = $1`, [shiftId]);
    const row = r.rows[0];
    if (!row) return null;
    const [totals, movements] = await Promise.all([
      this.totals(db, shiftId, Number(row.opening_cents)),
      db.query<MovementRow>(
        `${MOVEMENT_SELECT} WHERE m.shift_id = $1 ORDER BY m.created_at, m.id`,
        [shiftId],
      ),
    ]);
    return { ...toShift(row), totals, movements: movements.rows.map(toMovement) };
  }

  async listShifts(query: CashShiftListQuery): Promise<Paginated<CashShiftSummary>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.registerId) {
      params.push(query.registerId);
      where.push(`cs.register_id = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      where.push(`cs.status = $${params.length}`);
    }
    if (query.from || query.to) {
      // Calendar days in the business time zone.
      params.push(await this.settings.get('locale.timezone'));
      const tz = `$${params.length}`;
      if (query.from) {
        params.push(query.from);
        where.push(`cs.opened_at >= ($${params.length}::date)::timestamp AT TIME ZONE ${tz}`);
      }
      if (query.to) {
        params.push(query.to);
        where.push(`cs.opened_at < ($${params.length}::date + 1)::timestamp AT TIME ZONE ${tz}`);
      }
    }
    const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM cash_shifts cs ${sql}`,
      params,
    );
    const rows = await this.pool.query<ShiftRow>(
      `${SHIFT_SELECT} ${sql} ORDER BY cs.opened_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize],
    );
    return {
      items: rows.rows.map(toShift),
      page: query.page,
      pageSize: query.pageSize,
      total: Number(total.rows[0]!.n),
    };
  }

  /** Shifts overlapping `[fromDate, toDate]` (calendar days in the business time zone). */
  async shiftsBetween(
    fromDate: string,
    toDate: string,
    timeZone: string,
  ): Promise<CashShiftSummary[]> {
    const rows = await this.pool.query<ShiftRow>(
      `${SHIFT_SELECT}
        WHERE cs.opened_at < ($2::date + 1)::timestamp AT TIME ZONE $3
          AND COALESCE(cs.closed_at, now()) >= ($1::date)::timestamp AT TIME ZONE $3
        ORDER BY cs.opened_at`,
      [fromDate, toDate, timeZone],
    );
    return rows.rows.map(toShift);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async lockOpenShift(client: DbClient, registerId?: string | null) {
    const r = await client.query<{ id: string }>(
      `SELECT cs.id FROM cash_shifts cs JOIN cash_registers r ON r.id = cs.register_id
        WHERE cs.status = 'open' AND ($1::uuid IS NULL OR cs.register_id = $1)
        ORDER BY r.is_active DESC, r.created_at LIMIT 1 FOR UPDATE OF cs`,
      [registerId ?? null],
    );
    return r.rows[0] ?? null;
  }

  private async expectedCash(db: Queryable, shiftId: string): Promise<number> {
    const r = await db.query<{ expected: string }>(
      `SELECT (cs.opening_cents + COALESCE((SELECT SUM(amount_cents) FROM cash_movements
                                              WHERE shift_id = cs.id AND movement_type <> 'opening'), 0))::bigint::text AS expected
         FROM cash_shifts cs WHERE cs.id = $1`,
      [shiftId],
    );
    return Number(r.rows[0]?.expected ?? 0);
  }

  private async totals(
    db: Queryable,
    shiftId: string,
    openingCents: number,
  ): Promise<CashShiftTotals> {
    const [byType, byMethod, bySource, refunds] = await Promise.all([
      db.query<{ movement_type: CashMovementType; amount: string; n: string }>(
        `SELECT movement_type, SUM(amount_cents)::bigint::text AS amount, count(*)::text AS n
           FROM cash_movements WHERE shift_id = $1 GROUP BY movement_type`,
        [shiftId],
      ),
      db.query<{ method: string; amount: string; n: string }>(
        `SELECT p.method, SUM(CASE WHEN p.kind = 'refund' THEN -p.amount_cents ELSE p.amount_cents END)::bigint::text AS amount,
                count(*)::text AS n
           FROM payments p WHERE p.shift_id = $1 AND p.kind IN ('sale', 'refund')
          GROUP BY p.method ORDER BY p.method`,
        [shiftId],
      ),
      db.query<{ source: string; amount: string; n: string }>(
        `SELECT s.source, SUM(s.total_cents)::bigint::text AS amount, count(*)::text AS n
           FROM sales s WHERE s.shift_id = $1 AND s.status <> 'suspended' AND s.status <> 'void'
          GROUP BY s.source ORDER BY s.source`,
        [shiftId],
      ),
      db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM payments WHERE shift_id = $1 AND kind = 'refund'`,
        [shiftId],
      ),
    ]);
    const sum = (type: CashMovementType) =>
      Number(byType.rows.find((r) => r.movement_type === type)?.amount ?? 0);
    const other = byType.rows
      .filter(
        (r) =>
          !['opening', 'sale', 'refund', 'deposit', 'withdrawal', 'expense'].includes(
            r.movement_type,
          ),
      )
      .reduce((acc, r) => acc + Number(r.amount), 0);
    const movementsSum = byType.rows
      .filter((r) => r.movement_type !== 'opening')
      .reduce((acc, r) => acc + Number(r.amount), 0);
    return {
      openingCents,
      cashSalesCents: sum('sale'),
      cashRefundsCents: -sum('refund'),
      depositsCents: sum('deposit'),
      withdrawalsCents: -sum('withdrawal'),
      expensesCents: -sum('expense'),
      otherCents: other,
      expectedCashCents: openingCents + movementsSum,
      salesCount: bySource.rows.reduce((acc, r) => acc + Number(r.n), 0),
      refundsCount: Number(refunds.rows[0]?.n ?? 0),
      salesByMethod: byMethod.rows.map((r) => ({
        method: r.method,
        amountCents: Number(r.amount),
        count: Number(r.n),
      })),
      salesBySource: bySource.rows.map((r) => ({
        source: r.source,
        amountCents: Number(r.amount),
        count: Number(r.n),
      })),
    };
  }
}
