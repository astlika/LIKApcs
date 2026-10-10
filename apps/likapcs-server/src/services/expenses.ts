/**
 * Expenses: operating costs (electricity, rent, repairs…) with categories. A cash expense can be
 * paid straight from the open drawer, in which case it becomes a `cash_movements` row of the shift
 * and lowers the expected cash at close. Expenses are never deleted — they are voided with a reason,
 * and a drawer expense can only be voided while its shift is still open (the reversal must land in
 * the same shift so the Z report stays consistent).
 */
import type {
  CreateExpenseRequest,
  ExpenseCategoryRequest,
  ExpenseCategorySummary,
  ExpenseListQuery,
  ExpenseListResponse,
  ExpenseSummary,
  PaymentMethod,
} from '@likapcs/shared';
import type { DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { conflict, notFound } from '../errors.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { CashService } from './cash.js';

export interface ExpenseActor extends AuditActor {
  userId: string;
}

interface ExpenseRow {
  id: string;
  expense_date: string;
  category_code: string;
  name_en: string;
  name_sq: string;
  amount_cents: string;
  payment_method: PaymentMethod;
  description: string;
  supplier_id: string | null;
  supplier_name: string | null;
  shift_id: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
  voided_at: Date | null;
  void_reason: string | null;
}

const SELECT = `
  SELECT e.id, to_char(e.expense_date, 'YYYY-MM-DD') AS expense_date, e.category_code, c.name_en, c.name_sq,
         e.amount_cents, e.payment_method, e.description, e.supplier_id, s.name AS supplier_name, e.shift_id,
         e.created_by, u.full_name AS created_by_name, e.created_at, e.voided_at, e.void_reason
    FROM expenses e
    JOIN expense_categories c ON c.code = e.category_code
    LEFT JOIN suppliers s ON s.id = e.supplier_id
    LEFT JOIN users u ON u.id = e.created_by`;

function toSummary(r: ExpenseRow): ExpenseSummary {
  return {
    id: r.id,
    expenseDate: r.expense_date,
    categoryCode: r.category_code,
    categoryName: { en: r.name_en, sq: r.name_sq },
    amountCents: Number(r.amount_cents),
    paymentMethod: r.payment_method,
    description: r.description,
    supplierId: r.supplier_id,
    supplierName: r.supplier_name,
    shiftId: r.shift_id,
    createdBy: r.created_by ? { id: r.created_by, name: r.created_by_name ?? '' } : null,
    createdAt: r.created_at.toISOString(),
    voidedAt: r.voided_at ? r.voided_at.toISOString() : null,
    voidReason: r.void_reason,
  };
}

export class ExpensesService {
  constructor(
    private readonly pool: DbPool,
    private readonly cash: CashService,
  ) {}

  async categories(includeInactive = false): Promise<ExpenseCategorySummary[]> {
    const r = await this.pool.query<{
      code: string;
      name_en: string;
      name_sq: string;
      is_system: boolean;
      is_active: boolean;
    }>(
      `SELECT code, name_en, name_sq, is_system, is_active FROM expense_categories
        ${includeInactive ? '' : 'WHERE is_active'} ORDER BY is_system DESC, name_en`,
    );
    return r.rows.map((x) => ({
      code: x.code,
      nameEn: x.name_en,
      nameSq: x.name_sq,
      isSystem: x.is_system,
      isActive: x.is_active,
    }));
  }

  async createCategory(
    input: ExpenseCategoryRequest,
    actor: AuditActor,
  ): Promise<ExpenseCategorySummary> {
    const exists = await this.pool.query('SELECT 1 FROM expense_categories WHERE code = $1', [
      input.code,
    ]);
    if (exists.rowCount) throw conflict('An expense category with this code already exists');
    await this.pool.query(
      `INSERT INTO expense_categories (code, name_en, name_sq, is_system) VALUES ($1, $2, $3, false)`,
      [input.code, input.nameEn, input.nameSq],
    );
    await recordAudit(this.pool, actor, {
      action: 'expense_category.create',
      entityType: 'expense_category',
      entityId: input.code,
      details: input,
    });
    return {
      code: input.code,
      nameEn: input.nameEn,
      nameSq: input.nameSq,
      isSystem: false,
      isActive: true,
    };
  }

  async create(input: CreateExpenseRequest, actor: ExpenseActor): Promise<ExpenseSummary> {
    const id = await withTransaction(this.pool, async (client) => {
      const cat = await client.query<{ is_active: boolean }>(
        'SELECT is_active FROM expense_categories WHERE code = $1',
        [input.categoryCode],
      );
      if (!cat.rows[0]) throw notFound('Expense category');
      if (!cat.rows[0].is_active) throw conflict('This expense category is inactive');
      const ins = await client.query<{ id: string }>(
        `INSERT INTO expenses (expense_date, category_code, amount_cents, payment_method, description, supplier_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          input.expenseDate,
          input.categoryCode,
          input.amountCents,
          input.paymentMethod,
          input.description,
          input.supplierId ?? null,
          actor.userId,
        ],
      );
      const expenseId = ins.rows[0]!.id;
      let shiftId: string | null = null;
      if (input.paymentMethod === 'cash' && input.fromDrawer) {
        shiftId = await this.cash.attachTender(client, {
          method: 'cash',
          amountCents: -input.amountCents,
          type: 'expense',
          referenceType: 'expense',
          referenceId: expenseId,
          reason: input.description,
          actorUserId: actor.userId,
        });
        if (shiftId)
          await client.query('UPDATE expenses SET shift_id = $2 WHERE id = $1', [
            expenseId,
            shiftId,
          ]);
      }
      await recordAudit(client, actor, {
        action: 'expense.create',
        entityType: 'expense',
        entityId: expenseId,
        details: {
          amountCents: input.amountCents,
          categoryCode: input.categoryCode,
          paymentMethod: input.paymentMethod,
          fromDrawer: !!shiftId,
        },
      });
      return expenseId;
    });
    return (await this.get(id))!;
  }

  async void(id: string, reason: string, actor: ExpenseActor): Promise<ExpenseSummary> {
    await withTransaction(this.pool, async (client) => {
      const row = await client.query<{
        voided_at: Date | null;
        shift_id: string | null;
        amount_cents: string;
        shift_status: string | null;
      }>(
        `SELECT e.voided_at, e.shift_id, e.amount_cents, cs.status AS shift_status
           FROM expenses e LEFT JOIN cash_shifts cs ON cs.id = e.shift_id
          WHERE e.id = $1 FOR UPDATE OF e`,
        [id],
      );
      const e = row.rows[0];
      if (!e) throw notFound('Expense');
      if (e.voided_at) throw conflict('This expense is already voided');
      if (e.shift_id) {
        if (e.shift_status !== 'open')
          throw conflict(
            'This expense was paid from a cash shift that is already closed; record a correcting deposit in the current shift instead',
          );
        // Put the money back into the same shift's ledger.
        await client.query(
          `INSERT INTO cash_movements (shift_id, movement_type, amount_cents, reason, reference_type, reference_id, created_by)
           VALUES ($1, 'correction', $2, $3, 'expense_void', $4, $5)`,
          [e.shift_id, Number(e.amount_cents), reason, id, actor.userId],
        );
      }
      await client.query(
        `UPDATE expenses SET voided_at = now(), voided_by = $2, void_reason = $3, updated_at = now() WHERE id = $1`,
        [id, actor.userId, reason],
      );
      await recordAudit(client, actor, {
        action: 'expense.void',
        entityType: 'expense',
        entityId: id,
        details: { reason, amountCents: Number(e.amount_cents) },
        severity: 'warning',
      });
    });
    return (await this.get(id))!;
  }

  async get(id: string, db: Queryable = this.pool): Promise<ExpenseSummary | null> {
    const r = await db.query<ExpenseRow>(`${SELECT} WHERE e.id = $1`, [id]);
    return r.rows[0] ? toSummary(r.rows[0]) : null;
  }

  async list(query: ExpenseListQuery): Promise<ExpenseListResponse> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (query.from) add('e.expense_date >= ?::date', query.from);
    if (query.to) add('e.expense_date <= ?::date', query.to);
    if (query.categoryCode) add('e.category_code = ?', query.categoryCode);
    if (query.paymentMethod) add('e.payment_method = ?', query.paymentMethod);
    if (query.q) {
      params.push(`%${query.q}%`);
      where.push(`(e.description ILIKE $${params.length} OR s.name ILIKE $${params.length})`);
    }
    if (!query.includeVoided) where.push('e.voided_at IS NULL');
    const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = `FROM expenses e LEFT JOIN suppliers s ON s.id = e.supplier_id ${sql}`;
    const totals = await this.pool.query<{ n: string; total: string }>(
      `SELECT count(*)::text AS n, COALESCE(SUM(CASE WHEN e.voided_at IS NULL THEN e.amount_cents ELSE 0 END), 0)::bigint::text AS total ${from}`,
      params,
    );
    const rows = await this.pool.query<ExpenseRow>(
      `${SELECT} ${sql} ORDER BY e.expense_date DESC, e.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize],
    );
    return {
      items: rows.rows.map(toSummary),
      page: query.page,
      pageSize: query.pageSize,
      total: Number(totals.rows[0]!.n),
      totalCents: Number(totals.rows[0]!.total),
    };
  }
}
