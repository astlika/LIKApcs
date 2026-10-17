/**
 * Customer debts — "pay later" at the counter.
 *
 * A sale (POS or a session bill) settled with a `credit` tender opens one row in
 * `customer_debts` for the customer on the sale, with a due date. Repayments (full or partial,
 * one debt or the customer's oldest debts first) are `payments` rows of kind `customer_payment`
 * linked through `debt_payments`; cash goes into the open shift as a `customer_payment`
 * movement so the drawer stays right. `customers.balance_due_cents` always equals the sum of
 * the open remainders and is maintained here, inside the same transaction as the ledger rows.
 *
 * Rules: the seller needs `debts.give`; only active customers get credit;
 * a non-zero `credit_limit_cents` caps the outstanding balance; nothing is ever deleted — a debt
 * that will not be paid is written off with a reason (audited).
 */
import type {
  DebtCustomerGroup,
  DebtDetail,
  DebtInstallment,
  DebtListQuery,
  DebtPaymentRequest,
  DebtPaymentResult,
  DebtPaymentSummary,
  DebtRescheduleAllResult,
  DebtRescheduleRequest,
  DebtStatus,
  DebtSummary,
  DebtWriteOffRequest,
  DebtsOverview,
  Paginated,
  PaymentMethod,
} from '@likapcs/shared';
import { installmentDueDate, PERMISSIONS, splitInstallments } from '@likapcs/shared';
import type { DbClient, DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { CashService } from './cash.js';
import type { SettingsService } from './settings.js';
import type { WalletService } from './wallet.js';
import { lockCustomers } from '../db/locks.js';

interface DebtRow {
  id: string;
  customer_id: string;
  customer_code: string;
  customer_name: string;
  customer_phone: string | null;
  sale_id: string | null;
  receipt_no: string | null;
  amount_cents: string;
  paid_cents: string;
  status: DebtStatus;
  due_date: string;
  overdue_days: number;
  notes: string | null;
  created_by_name: string | null;
  created_at: Date;
  settled_at: Date | null;
  written_off_reason: string | null;
  installment_count: number | null;
  payments_count: string;
  items_text: string | null;
  sched_count: number;
  sched_paid: number;
  next_part_cents: string | null;
}

const SELECT = `
  SELECT d.id, d.customer_id, c.code AS customer_code, c.name AS customer_name, c.phone AS customer_phone,
         d.sale_id, s.receipt_no, d.amount_cents::text, d.paid_cents::text, d.status,
         to_char(d.due_date, 'YYYY-MM-DD') AS due_date,
         CASE WHEN d.status IN ('open', 'partial') AND d.due_date < CURRENT_DATE
              THEN (CURRENT_DATE - d.due_date)::int ELSE 0 END AS overdue_days,
         d.notes, u.full_name AS created_by_name, d.created_at, d.settled_at, d.written_off_reason,
         d.installment_count, (SELECT count(*) FROM debt_payments dp WHERE dp.debt_id = d.id)::text AS payments_count,
         (SELECT string_agg(si.description, ', ' ORDER BY si.line_no) FROM sale_items si WHERE si.sale_id = d.sale_id) AS items_text,
         (SELECT count(*)::int FROM debt_installments i WHERE i.debt_id = d.id) AS sched_count,
         (SELECT count(*)::int FROM debt_installments i WHERE i.debt_id = d.id AND i.paid_cents >= i.amount_cents) AS sched_paid,
         (SELECT (i.amount_cents - i.paid_cents)::text FROM debt_installments i
            WHERE i.debt_id = d.id AND i.paid_cents < i.amount_cents ORDER BY i.seq LIMIT 1) AS next_part_cents
    FROM customer_debts d
    JOIN customers c ON c.id = d.customer_id
    LEFT JOIN sales s ON s.id = d.sale_id
    LEFT JOIN users u ON u.id = d.created_by`;

/**
 * The next part of an installment plan: what is left, split over the parts not yet paid (at
 * least one), rounded up to the cent. Null for a plain debt or a settled one.
 */
export function installmentPart(
  count: number | null,
  remainingCents: number,
  paidParts: number,
): number | null {
  if (!count || remainingCents <= 0) return null;
  return Math.ceil(remainingCents / Math.max(1, count - paidParts));
}

function toSummary(r: DebtRow): DebtSummary {
  const amount = Number(r.amount_cents);
  const paid = Number(r.paid_cents);
  const remaining = r.status === 'open' || r.status === 'partial' ? amount - paid : 0;
  return {
    id: r.id,
    customerId: r.customer_id,
    customerCode: r.customer_code,
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    saleId: r.sale_id,
    receiptNo: r.receipt_no,
    amountCents: amount,
    paidCents: paid,
    remainingCents: remaining,
    status: r.status,
    dueDate: r.due_date,
    overdueDays: Number(r.overdue_days),
    itemsText: r.items_text,
    installmentCount: r.installment_count,
    // 0.19.8: with a schedule, the parts are counted from the schedule; older plans keep the rule below.
    installmentsPaid: r.sched_count > 0 ? r.sched_paid : Number(r.payments_count),
    installmentCents:
      r.sched_count > 0
        ? r.next_part_cents === null
          ? null
          : Number(r.next_part_cents)
        : installmentPart(r.installment_count, remaining, Number(r.payments_count)),
    notes: r.notes,
    createdByName: r.created_by_name,
    createdAt: r.created_at.toISOString(),
    settledAt: r.settled_at ? r.settled_at.toISOString() : null,
  };
}

/** `YYYY-MM-DD` for today plus `days` (server local date — same basis as `CURRENT_DATE`). */
export function dueDateFromToday(days: number, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export class DebtsService {
  constructor(
    private readonly pool: DbPool,
    private readonly settings: SettingsService,
    private readonly cash: CashService,
    private readonly wallet: WalletService,
  ) {}

  // ─── Opening a debt (called inside the sale / session transaction) ──────────

  /**
   * Validates that `customerId` may take `amountCents` more credit and opens the debt. Throws
   * the user-facing error when the feature is off, the customer is missing/blocked, or the limit
   * would be exceeded. Must run inside the caller's transaction (the customer row is locked).
   */
  async open(
    client: DbClient,
    input: {
      customerId: string | null | undefined;
      saleId: string | null;
      amountCents: number;
      dueDate?: string | null;
      notes?: string | null;
      /** 0.19.0: planned parts (2–24) or null for a plain debt. */
      installmentCount?: number | null;
      /** Whoever sells; `permissions` decides whether credit may be given at all. */
      actor: AuditActor & { permissions?: ReadonlySet<string> };
    },
  ): Promise<string> {
    if (!input.actor.permissions?.has(PERMISSIONS.DEBTS_GIVE))
      throw forbidden('Selling on credit needs the "Give debt" permission (Employees → Roles)', {
        code: 'CREDIT_FORBIDDEN',
      });
    if (!input.customerId)
      throw badRequest('Pay later needs a customer on the sale', {
        field: 'customerId',
        code: 'CUSTOMER_REQUIRED',
      });
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0)
      throw badRequest('Debt amount must be positive');
    const c = await client.query<{
      name: string;
      status: string;
      balance_due_cents: string;
      credit_limit_cents: string;
    }>(
      'SELECT name, status, balance_due_cents, credit_limit_cents FROM customers WHERE id = $1 FOR UPDATE',
      [input.customerId],
    );
    const customer = c.rows[0];
    if (!customer) throw notFound('Customer');
    if (customer.status !== 'active')
      throw conflict(`Customer ${customer.name} is ${customer.status} and cannot buy on credit`, {
        field: 'customerId',
        code: 'CUSTOMER_NOT_ACTIVE',
      });
    const limit = Number(customer.credit_limit_cents);
    const balance = Number(customer.balance_due_cents);
    if (limit > 0 && balance + input.amountCents > limit)
      throw conflict(
        `Credit limit exceeded: ${customer.name} owes ${(balance / 100).toFixed(2)} of a ${(limit / 100).toFixed(2)} limit`,
        {
          code: 'CREDIT_LIMIT',
          balanceDueCents: balance,
          creditLimitCents: limit,
          requestedCents: input.amountCents,
        },
      );
    const dueDate =
      input.dueDate ?? dueDateFromToday(await this.settings.get('pos.credit_default_days'));
    const r = await client.query<{ id: string }>(
      `INSERT INTO customer_debts (customer_id, sale_id, amount_cents, due_date, notes, created_by, installment_count)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7) RETURNING id`,
      [
        input.customerId,
        input.saleId,
        input.amountCents,
        dueDate,
        input.notes ?? null,
        input.actor.userId ?? null,
        input.installmentCount ?? null,
      ],
    );
    const debtId = r.rows[0]!.id;
    if (input.installmentCount) {
      // 0.19.8: the parts are scheduled now: amount split in cents, due monthly from the debt's date.
      const parts = splitInstallments(input.amountCents, input.installmentCount);
      for (const [i, part] of parts.entries()) {
        await client.query(
          `INSERT INTO debt_installments (debt_id, seq, amount_cents, due_date) VALUES ($1, $2, $3, $4::date)`,
          [debtId, i + 1, part, installmentDueDate(dueDate, i)],
        );
      }
    }
    await client.query(
      'UPDATE customers SET balance_due_cents = balance_due_cents + $2, updated_at = now() WHERE id = $1',
      [input.customerId, input.amountCents],
    );
    await recordAudit(client, input.actor, {
      action: 'debt.opened',
      entityType: 'customer_debt',
      entityId: r.rows[0]!.id,
      details: {
        customerId: input.customerId,
        saleId: input.saleId,
        amountCents: input.amountCents,
        dueDate,
        installmentCount: input.installmentCount ?? null,
      },
    });
    this.wallet.announce(client, input.customerId);
    return r.rows[0]!.id;
  }

  // ─── Queries ────────────────────────────────────────────────────────────────

  async list(query: DebtListQuery): Promise<Paginated<DebtSummary>> {
    const where: string[] = [];
    const params: unknown[] = [];
    switch (query.filter) {
      case 'open':
        where.push(`d.status IN ('open', 'partial')`);
        break;
      case 'overdue':
        where.push(`d.status IN ('open', 'partial') AND d.due_date < CURRENT_DATE`);
        break;
      case 'due_today':
        where.push(`d.status IN ('open', 'partial') AND d.due_date = CURRENT_DATE`);
        break;
      case 'paid':
        where.push(`d.status = 'paid'`);
        break;
      case 'written_off':
        where.push(`d.status = 'written_off'`);
        break;
      case 'all':
        break;
    }
    if (query.customerId) {
      params.push(query.customerId);
      where.push(`d.customer_id = $${params.length}`);
    }
    if (query.q) {
      params.push(`%${query.q}%`);
      where.push(
        `(c.name ILIKE $${params.length} OR c.code ILIKE $${params.length} OR c.phone ILIKE $${params.length} OR s.receipt_no ILIKE $${params.length})`,
      );
    }
    const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM customer_debts d JOIN customers c ON c.id = d.customer_id LEFT JOIN sales s ON s.id = d.sale_id ${sql}`,
      params,
    );
    // Open debts: most overdue first; settled ones: newest first.
    const rows = await this.pool.query<DebtRow>(
      `${SELECT} ${sql}
       ORDER BY CASE WHEN d.status IN ('open', 'partial') THEN 0 ELSE 1 END, d.due_date ASC, d.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize],
    );
    return {
      items: rows.rows.map(toSummary),
      page: query.page,
      pageSize: query.pageSize,
      total: Number(total.rows[0]!.n),
    };
  }

  /**
   * 0.18.0: the debts page groups by customer — one row per name with the open total, the number
   * of open invoices and the oldest due date. Clicking a name opens that customer's invoices
   * (the existing `list` with `customerId`, which also shows settled ones).
   */
  async byCustomer(q?: string): Promise<DebtCustomerGroup[]> {
    const params: unknown[] = [];
    let where = `WHERE d.status IN ('open', 'partial')`;
    if (q && q.trim()) {
      params.push(`%${q.trim()}%`);
      where += ` AND (c.name ILIKE $1 OR c.code ILIKE $1 OR c.phone ILIKE $1)`;
    }
    const rows = await this.pool.query<{
      customer_id: string;
      name: string;
      code: string | null;
      phone: string | null;
      total_cents: string;
      n: number;
      oldest_due: Date | string | null;
    }>(
      `SELECT c.id AS customer_id, c.name, c.code, c.phone,
              COALESCE(SUM(d.amount_cents - d.paid_cents), 0)::bigint::text AS total_cents,
              count(*)::int AS n,
              min(d.due_date) AS oldest_due
         FROM customer_debts d
         JOIN customers c ON c.id = d.customer_id
         ${where}
        GROUP BY c.id, c.name, c.code, c.phone
        ORDER BY SUM(d.amount_cents - d.paid_cents) DESC, c.name ASC`,
      params,
    );
    return rows.rows.map((r) => ({
      customerId: r.customer_id,
      name: r.name,
      code: r.code,
      phone: r.phone,
      totalCents: Number(r.total_cents),
      count: r.n,
      oldestDue:
        r.oldest_due instanceof Date
          ? r.oldest_due.toISOString().slice(0, 10)
          : (r.oldest_due ?? null),
    }));
  }

  async overview(): Promise<DebtsOverview> {
    const r = await this.pool.query<{
      open_cents: string;
      overdue_cents: string;
      due_today_cents: string;
      open_count: string;
      overdue_count: string;
      debtors: string;
    }>(
      `SELECT COALESCE(SUM(amount_cents - paid_cents), 0)::bigint::text AS open_cents,
              COALESCE(SUM(CASE WHEN due_date < CURRENT_DATE THEN amount_cents - paid_cents ELSE 0 END), 0)::bigint::text AS overdue_cents,
              COALESCE(SUM(CASE WHEN due_date = CURRENT_DATE THEN amount_cents - paid_cents ELSE 0 END), 0)::bigint::text AS due_today_cents,
              count(*)::text AS open_count,
              count(*) FILTER (WHERE due_date < CURRENT_DATE)::text AS overdue_count,
              count(DISTINCT customer_id)::text AS debtors
         FROM customer_debts WHERE status IN ('open', 'partial')`,
    );
    const x = r.rows[0]!;
    return {
      openCents: Number(x.open_cents),
      overdueCents: Number(x.overdue_cents),
      dueTodayCents: Number(x.due_today_cents),
      openCount: Number(x.open_count),
      overdueCount: Number(x.overdue_count),
      debtors: Number(x.debtors),
    };
  }

  async get(id: string, db: Queryable = this.pool): Promise<DebtDetail | null> {
    const r = await db.query<DebtRow>(`${SELECT} WHERE d.id = $1`, [id]);
    const row = r.rows[0];
    if (!row) return null;
    const [payments, items, parts] = await Promise.all([
      db.query<{
        id: string;
        amount_cents: string;
        method: PaymentMethod;
        reference: string | null;
        received_at: Date;
        received_by_name: string | null;
      }>(
        `SELECT dp.id, dp.amount_cents::text, p.method, p.reference, p.received_at, u.full_name AS received_by_name
           FROM debt_payments dp
           JOIN payments p ON p.id = dp.payment_id
           LEFT JOIN users u ON u.id = p.created_by
          WHERE dp.debt_id = $1 ORDER BY p.received_at ASC, dp.created_at ASC`,
        [id],
      ),
      row.sale_id
        ? db.query<{ description: string; quantity_milli: string; line_total_cents: string }>(
            `SELECT description, quantity_milli::text, line_total_cents::text FROM sale_items WHERE sale_id = $1 ORDER BY line_no`,
            [row.sale_id],
          )
        : Promise.resolve({
            rows: [] as { description: string; quantity_milli: string; line_total_cents: string }[],
          }),
      db.query<{
        seq: number;
        amount_cents: string;
        paid_cents: string;
        due_date: string;
        overdue_days: number;
      }>(
        `SELECT seq, amount_cents::text, paid_cents::text, to_char(due_date, 'YYYY-MM-DD') AS due_date,
                CASE WHEN paid_cents < amount_cents AND due_date < CURRENT_DATE
                     THEN (CURRENT_DATE - due_date)::int ELSE 0 END AS overdue_days
           FROM debt_installments WHERE debt_id = $1 ORDER BY seq`,
        [id],
      ),
    ]);
    return {
      ...toSummary(row),
      writtenOffReason: row.written_off_reason,
      payments: payments.rows.map((p): DebtPaymentSummary => ({
        id: p.id,
        amountCents: Number(p.amount_cents),
        method: p.method,
        reference: p.reference,
        receivedAt: p.received_at.toISOString(),
        receivedByName: p.received_by_name,
      })),
      items: items.rows.map((i) => ({
        description: i.description,
        quantityMilli: Number(i.quantity_milli),
        lineTotalCents: Number(i.line_total_cents),
      })),
      installments: parts.rows.map((p): DebtInstallment => ({
        seq: p.seq,
        amountCents: Number(p.amount_cents),
        paidCents: Number(p.paid_cents),
        remainingCents: Number(p.amount_cents) - Number(p.paid_cents),
        dueDate: p.due_date,
        status:
          Number(p.paid_cents) >= Number(p.amount_cents)
            ? 'paid'
            : Number(p.paid_cents) > 0
              ? 'partial'
              : 'open',
        overdueDays: Number(p.overdue_days),
      })),
    };
  }

  // ─── Repayments ─────────────────────────────────────────────────────────────

  /** Pays one debt (fully or partially). Cash: `tenderedCents` ≥ amount, change is reported. */
  async pay(id: string, input: DebtPaymentRequest, actor: AuditActor): Promise<DebtPaymentResult> {
    return withTransaction(this.pool, async (client) => {
      const debt = await this.lock(client, id);
      if (debt.status !== 'open' && debt.status !== 'partial')
        throw conflict(`This debt is already ${debt.status.replace('_', ' ')}`);
      const remaining = Number(debt.amount_cents) - Number(debt.paid_cents);
      if (input.amountCents > remaining)
        throw badRequest(`Payment exceeds the remaining ${(remaining / 100).toFixed(2)}`, {
          field: 'amountCents',
          code: 'OVERPAY',
          remainingCents: remaining,
        });
      const change = this.changeFor(input);
      const paymentId = await this.recordPayment(client, {
        customerId: debt.customer_id,
        method: input.method,
        amountCents: input.amountCents,
        reference: input.reference ?? null,
        reason: `${debt.customer_name} · ${debt.receipt_no ?? 'debt'}`,
        actor,
      });
      await this.applyToDebt(
        client,
        debt,
        paymentId,
        input.amountCents,
        input.notes,
        actor,
        input.installmentSeq ?? null,
      );
      const customer = await this.customerBalance(client, debt.customer_id);
      return {
        debts: [(await this.get(id, client))!],
        paidCents: input.amountCents,
        changeCents: change,
        customer,
      };
    });
  }

  /**
   * Customer-level payment: settles the customer's open debts oldest due date first until the
   * amount is used up (the last touched debt may stay partial). The usual case at the counter:
   * "Here is 20 €" without discussing which receipt it belongs to.
   */
  async payCustomer(
    customerId: string,
    input: DebtPaymentRequest,
    actor: AuditActor,
  ): Promise<DebtPaymentResult> {
    return withTransaction(this.pool, async (client) => {
      if (input.installmentSeq !== undefined)
        throw badRequest('Pick one debt to pay a specific installment', {
          field: 'installmentSeq',
          code: 'INSTALLMENT_NEEDS_DEBT',
        });
      await lockCustomers(client, customerId);
      const open = await client.query<DebtRow>(
        `${SELECT} WHERE d.customer_id = $1 AND d.status IN ('open', 'partial')
         ORDER BY d.due_date ASC, d.created_at ASC FOR UPDATE OF d`,
        [customerId],
      );
      if (!open.rows.length) throw conflict('This customer has no open debt');
      const outstanding = open.rows.reduce(
        (acc, d) => acc + Number(d.amount_cents) - Number(d.paid_cents),
        0,
      );
      if (input.amountCents > outstanding)
        throw badRequest(`Payment exceeds the outstanding ${(outstanding / 100).toFixed(2)}`, {
          field: 'amountCents',
          code: 'OVERPAY',
          remainingCents: outstanding,
        });
      const change = this.changeFor(input);
      const first = open.rows[0]!;
      const paymentId = await this.recordPayment(client, {
        customerId,
        method: input.method,
        amountCents: input.amountCents,
        reference: input.reference ?? null,
        reason: `${first.customer_name} · ${open.rows.length} debt(s)`,
        actor,
      });
      let left = input.amountCents;
      const touched: string[] = [];
      for (const debt of open.rows) {
        if (left <= 0) break;
        const remaining = Number(debt.amount_cents) - Number(debt.paid_cents);
        const part = Math.min(left, remaining);
        await this.applyToDebt(client, debt, paymentId, part, input.notes, actor);
        touched.push(debt.id);
        left -= part;
      }
      const customer = await this.customerBalance(client, customerId);
      const debts: DebtDetail[] = [];
      for (const id of touched) debts.push((await this.get(id, client))!);
      return { debts, paidCents: input.amountCents, changeCents: change, customer };
    });
  }

  async reschedule(
    id: string,
    input: DebtRescheduleRequest,
    actor: AuditActor,
  ): Promise<DebtDetail> {
    return withTransaction(this.pool, async (client) => {
      const debt = await this.lock(client, id);
      if (debt.status !== 'open' && debt.status !== 'partial')
        throw conflict(`This debt is already ${debt.status.replace('_', ' ')}`);
      await this.shiftSchedule(client, id, input.dueDate);
      await client.query(
        `UPDATE customer_debts SET due_date = $2::date, notes = COALESCE($3, notes) WHERE id = $1`,
        [id, input.dueDate, input.notes ?? null],
      );
      await recordAudit(client, actor, {
        action: 'debt.rescheduled',
        entityType: 'customer_debt',
        entityId: id,
        details: { from: debt.due_date, to: input.dueDate },
      });
      return (await this.get(id, client))!;
    });
  }

  /** One new due date for every open / partial debt of a customer (Customers › "extend all"). */
  async rescheduleCustomer(
    customerId: string,
    input: DebtRescheduleRequest,
    actor: AuditActor,
  ): Promise<DebtRescheduleAllResult> {
    return withTransaction(this.pool, async (client) => {
      await lockCustomers(client, customerId);
      const open = await client.query<DebtRow>(
        `${SELECT} WHERE d.customer_id = $1 AND d.status IN ('open', 'partial')
         ORDER BY d.due_date ASC, d.created_at ASC FOR UPDATE OF d`,
        [customerId],
      );
      if (!open.rows.length) throw conflict('This customer has no open debt');
      for (const debt of open.rows) await this.shiftSchedule(client, debt.id, input.dueDate);
      await client.query(
        `UPDATE customer_debts SET due_date = $2::date, notes = COALESCE($3, notes)
         WHERE customer_id = $1 AND status IN ('open', 'partial')`,
        [customerId, input.dueDate, input.notes ?? null],
      );
      for (const debt of open.rows) {
        await recordAudit(client, actor, {
          action: 'debt.rescheduled',
          entityType: 'customer_debt',
          entityId: debt.id,
          details: { from: debt.due_date, to: input.dueDate, all: true },
        });
      }
      const debts: DebtDetail[] = [];
      for (const debt of open.rows) debts.push((await this.get(debt.id, client))!);
      return { debts, count: debts.length };
    });
  }

  async writeOff(id: string, input: DebtWriteOffRequest, actor: AuditActor): Promise<DebtDetail> {
    return withTransaction(this.pool, async (client) => {
      const debt = await this.lock(client, id);
      if (debt.status !== 'open' && debt.status !== 'partial')
        throw conflict(`This debt is already ${debt.status.replace('_', ' ')}`);
      const remaining = Number(debt.amount_cents) - Number(debt.paid_cents);
      await client.query(
        `UPDATE customer_debts SET status = 'written_off', settled_at = now(), written_off_by = $2, written_off_reason = $3
          WHERE id = $1`,
        [id, actor.userId ?? null, input.reason],
      );
      await client.query(
        'UPDATE customers SET balance_due_cents = GREATEST(0, balance_due_cents - $2), updated_at = now() WHERE id = $1',
        [debt.customer_id, remaining],
      );
      await recordAudit(client, actor, {
        action: 'debt.written_off',
        entityType: 'customer_debt',
        entityId: id,
        details: { customerId: debt.customer_id, remainingCents: remaining, reason: input.reason },
      });
      this.wallet.announce(client, debt.customer_id);
      return (await this.get(id, client))!;
    });
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  /** Locks the debt row — after its customer (see db/locks.ts for the ordering rule). */
  private async lock(client: DbClient, id: string): Promise<DebtRow> {
    const owner = await client.query<{ customer_id: string }>(
      'SELECT customer_id FROM customer_debts WHERE id = $1',
      [id],
    );
    if (!owner.rows[0]) throw notFound('Debt');
    await lockCustomers(client, owner.rows[0].customer_id);
    const r = await client.query<DebtRow>(`${SELECT} WHERE d.id = $1 FOR UPDATE OF d`, [id]);
    if (!r.rows[0]) throw notFound('Debt');
    return r.rows[0];
  }

  private changeFor(input: DebtPaymentRequest): number {
    if (input.method !== 'cash' || input.tenderedCents === undefined) return 0;
    if (input.tenderedCents < input.amountCents)
      throw badRequest('Cash received is less than the amount paid', {
        field: 'tenderedCents',
        code: 'PAYMENT',
      });
    return input.tenderedCents - input.amountCents;
  }

  private async recordPayment(
    client: DbClient,
    input: {
      customerId: string;
      method: DebtPaymentRequest['method'];
      amountCents: number;
      reference: string | null;
      reason: string;
      actor: AuditActor;
    },
  ): Promise<string> {
    const shiftId = await this.cash.attachTender(client, {
      method: input.method,
      amountCents: input.amountCents,
      type: 'customer_payment',
      referenceType: 'customer',
      referenceId: input.customerId,
      reason: input.reason,
      actorUserId: input.actor.userId ?? null,
    });
    const r = await client.query<{ id: string }>(
      `INSERT INTO payments (kind, method, amount_cents, customer_id, reference, shift_id, received_at, created_by)
       VALUES ('customer_payment', $1, $2, $3, $4, $5, now(), $6) RETURNING id`,
      [
        input.method,
        input.amountCents,
        input.customerId,
        input.reference,
        shiftId,
        input.actor.userId ?? null,
      ],
    );
    // Paid from the customer's own prepaid balance (0.11.0): no cash moves, the wallet does.
    if (input.method === 'wallet')
      await this.wallet.spend(client, {
        customerId: input.customerId,
        amountCents: input.amountCents,
        referenceType: 'debt_payment',
        referenceId: r.rows[0]!.id,
        note: input.reason,
        actor: input.actor,
      });
    return r.rows[0]!.id;
  }

  /**
   * A new due date for a plan: the unpaid parts are dated again from `newDue`, monthly, in order
   * (paid parts keep their dates). A plain debt has no parts: nothing happens.
   */
  private async shiftSchedule(client: DbClient, debtId: string, newDue: string): Promise<void> {
    const unpaid = await client.query<{ id: string }>(
      `SELECT id FROM debt_installments WHERE debt_id = $1 AND paid_cents < amount_cents ORDER BY seq`,
      [debtId],
    );
    for (const [k, part] of unpaid.rows.entries()) {
      await client.query('UPDATE debt_installments SET due_date = $2::date WHERE id = $1', [
        part.id,
        installmentDueDate(newDue, k),
      ]);
    }
  }

  /**
   * Books `amountCents` of a payment against one debt. With a schedule, the money goes to the
   * part `installmentSeq` (it must not exceed what that part still owes), or else to the oldest
   * unpaid parts first. Each part touched gets its own repayment row.
   */
  private async applyToDebt(
    client: DbClient,
    debt: DebtRow,
    paymentId: string,
    amountCents: number,
    notes: string | undefined,
    actor: AuditActor,
    installmentSeq: number | null = null,
  ): Promise<void> {
    const parts = await client.query<{
      id: string;
      seq: number;
      amount_cents: string;
      paid_cents: string;
    }>(
      `SELECT id, seq, amount_cents::text, paid_cents::text FROM debt_installments
        WHERE debt_id = $1 ORDER BY seq FOR UPDATE`,
      [debt.id],
    );
    const slices: { installmentId: string | null; amount: number }[] = [];
    if (!parts.rows.length) {
      if (installmentSeq !== null)
        throw badRequest('This debt has no installment plan', {
          field: 'installmentSeq',
          code: 'NO_INSTALLMENTS',
        });
      slices.push({ installmentId: null, amount: amountCents });
    } else if (installmentSeq !== null) {
      const part = parts.rows.find((p) => p.seq === installmentSeq);
      if (!part) throw notFound('Installment');
      const left = Number(part.amount_cents) - Number(part.paid_cents);
      if (left <= 0) throw conflict(`Installment ${installmentSeq} is already paid`);
      if (amountCents > left)
        throw badRequest(
          `Payment exceeds installment ${installmentSeq}, which owes ${(left / 100).toFixed(2)}`,
          { field: 'amountCents', code: 'OVERPAY_INSTALLMENT', remainingCents: left },
        );
      slices.push({ installmentId: part.id, amount: amountCents });
    } else {
      let left = amountCents;
      for (const part of parts.rows) {
        if (left <= 0) break;
        const owed = Number(part.amount_cents) - Number(part.paid_cents);
        if (owed <= 0) continue;
        const take = Math.min(left, owed);
        slices.push({ installmentId: part.id, amount: take });
        left -= take;
      }
    }
    for (const slice of slices) {
      await client.query(
        `INSERT INTO debt_payments (debt_id, payment_id, amount_cents, installment_id) VALUES ($1, $2, $3, $4)`,
        [debt.id, paymentId, slice.amount, slice.installmentId],
      );
      if (slice.installmentId)
        await client.query(
          'UPDATE debt_installments SET paid_cents = paid_cents + $2 WHERE id = $1',
          [slice.installmentId, slice.amount],
        );
    }
    if (parts.rows.length) {
      // The debt's due date follows its next unpaid part (unchanged once everything is paid).
      await client.query(
        `UPDATE customer_debts SET due_date = COALESCE(
           (SELECT min(due_date) FROM debt_installments WHERE debt_id = $1 AND paid_cents < amount_cents),
           due_date)
         WHERE id = $1`,
        [debt.id],
      );
    }
    const paid = Number(debt.paid_cents) + amountCents;
    const settled = paid >= Number(debt.amount_cents);
    await client.query(
      `UPDATE customer_debts
          SET paid_cents = $2, status = $3, settled_at = CASE WHEN $3 = 'paid' THEN now() ELSE settled_at END,
              notes = COALESCE($4, notes)
        WHERE id = $1`,
      [debt.id, paid, settled ? 'paid' : 'partial', notes ?? null],
    );
    await client.query(
      'UPDATE customers SET balance_due_cents = GREATEST(0, balance_due_cents - $2), updated_at = now() WHERE id = $1',
      [debt.customer_id, amountCents],
    );
    await recordAudit(client, actor, {
      action: 'debt.paid',
      entityType: 'customer_debt',
      entityId: debt.id,
      details: { amountCents, paymentId, settled },
    });
    this.wallet.announce(client, debt.customer_id);
  }

  private async customerBalance(
    client: DbClient,
    customerId: string,
  ): Promise<{ id: string; name: string; balanceDueCents: number }> {
    const r = await client.query<{ id: string; name: string; balance_due_cents: string }>(
      'SELECT id, name, balance_due_cents FROM customers WHERE id = $1',
      [customerId],
    );
    const c = r.rows[0]!;
    return { id: c.id, name: c.name, balanceDueCents: Number(c.balance_due_cents) };
  }
}
