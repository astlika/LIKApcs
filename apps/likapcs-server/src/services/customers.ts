/**
 * Customers: regulars, members and their visit history. Codes (`C-000001`) come from the shared
 * document sequence so they are unique and stable; a customer with history is archived, never
 * deleted (sales and sessions keep pointing at them).
 */
import type {
  CustomerDetail,
  CustomerListQuery,
  CustomerPatch,
  CustomerRequest,
  CustomerStatus,
  CustomerSummary,
  Paginated,
} from '@likapcs/shared';
import type { DbClient, DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { conflict, notFound } from '../errors.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { SalesService } from './sales.js';
import type { SessionsService } from './sessions.js';

interface CustomerRow {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  email: string | null;
  membership: string | null;
  membership_until: string | null;
  discount_bp: number;
  loyalty_points: number;
  wallet_balance_cents: string;
  balance_due_cents: string;
  notes: string | null;
  status: CustomerStatus;
  created_at: Date;
  updated_at: Date;
}

const SELECT = `
  SELECT c.id, c.code, c.name, c.phone, c.email, c.membership, to_char(c.membership_until, 'YYYY-MM-DD') AS membership_until,
         c.discount_bp, c.loyalty_points, c.wallet_balance_cents, c.balance_due_cents, c.notes, c.status,
         c.created_at, c.updated_at
    FROM customers c`;

function toSummary(r: CustomerRow): CustomerSummary {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    phone: r.phone,
    email: r.email,
    membership: r.membership,
    membershipUntil: r.membership_until,
    discountBp: r.discount_bp,
    loyaltyPoints: r.loyalty_points,
    walletBalanceCents: Number(r.wallet_balance_cents),
    balanceDueCents: Number(r.balance_due_cents),
    notes: r.notes,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

async function nextCustomerCode(client: DbClient): Promise<string> {
  const r = await client.query<{ next_value: string; prefix: string }>(
    `INSERT INTO document_sequences (kind, period, prefix, next_value) VALUES ('customer', '', 'C', 2)
     ON CONFLICT (kind, period) DO UPDATE SET next_value = document_sequences.next_value + 1
     RETURNING next_value, prefix`,
  );
  const row = r.rows[0]!;
  return `${row.prefix || 'C'}-${String(Number(row.next_value) - 1).padStart(6, '0')}`;
}

export class CustomersService {
  constructor(
    private readonly pool: DbPool,
    private readonly sales: SalesService,
    private readonly sessions: SessionsService,
  ) {}

  async list(query: CustomerListQuery): Promise<Paginated<CustomerSummary>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.status) {
      params.push(query.status);
      where.push(`c.status = $${params.length}`);
    } else {
      where.push(`c.status <> 'archived'`);
    }
    if (query.q) {
      params.push(`%${query.q}%`);
      where.push(
        `(c.name ILIKE $${params.length} OR c.code ILIKE $${params.length} OR c.phone ILIKE $${params.length} OR c.email ILIKE $${params.length})`,
      );
    }
    const sql = `WHERE ${where.join(' AND ')}`;
    const total = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM customers c ${sql}`,
      params,
    );
    const rows = await this.pool.query<CustomerRow>(
      `${SELECT} ${sql} ORDER BY c.name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize],
    );
    return {
      items: rows.rows.map(toSummary),
      page: query.page,
      pageSize: query.pageSize,
      total: Number(total.rows[0]!.n),
    };
  }

  async get(id: string, db: Queryable = this.pool): Promise<CustomerSummary | null> {
    const r = await db.query<CustomerRow>(`${SELECT} WHERE c.id = $1`, [id]);
    return r.rows[0] ? toSummary(r.rows[0]) : null;
  }

  async detail(id: string): Promise<CustomerDetail | null> {
    const customer = await this.get(id);
    if (!customer) return null;
    const [stats, sales, sessions] = await Promise.all([
      this.pool.query<{
        sales_count: string;
        sales_total: string;
        sessions_count: string;
        sessions_minutes: string;
        last_visit: Date | null;
      }>(
        `SELECT (SELECT count(*) FROM sales s WHERE s.customer_id = $1 AND s.status IN ('completed', 'partially_refunded', 'refunded'))::text AS sales_count,
                (SELECT COALESCE(SUM(total_cents - refunded_cents), 0) FROM sales s WHERE s.customer_id = $1 AND s.status IN ('completed', 'partially_refunded', 'refunded'))::bigint::text AS sales_total,
                (SELECT count(*) FROM gaming_sessions g WHERE g.customer_id = $1)::text AS sessions_count,
                (SELECT COALESCE(SUM(COALESCE(g.billable_seconds, 0)), 0) / 60 FROM gaming_sessions g WHERE g.customer_id = $1)::bigint::text AS sessions_minutes,
                GREATEST((SELECT MAX(completed_at) FROM sales s WHERE s.customer_id = $1),
                         (SELECT MAX(started_at) FROM gaming_sessions g WHERE g.customer_id = $1)) AS last_visit`,
        [id],
      ),
      this.sales.list({ customerId: id, page: 1, pageSize: 10 }),
      this.sessions.list({ customerId: id, page: 1, pageSize: 10 }),
    ]);
    const s = stats.rows[0]!;
    return {
      ...customer,
      stats: {
        salesCount: Number(s.sales_count),
        salesTotalCents: Number(s.sales_total),
        sessionsCount: Number(s.sessions_count),
        sessionsMinutes: Number(s.sessions_minutes),
        lastVisitAt: s.last_visit ? s.last_visit.toISOString() : null,
      },
      recentSales: sales.items,
      recentSessions: sessions.items,
    };
  }

  async create(input: CustomerRequest, actor: AuditActor): Promise<CustomerSummary> {
    const id = await withTransaction(this.pool, async (client) => {
      const code = input.code?.trim() || (await nextCustomerCode(client));
      const dup = await client.query('SELECT 1 FROM customers WHERE lower(code) = lower($1)', [
        code,
      ]);
      if (dup.rowCount) throw conflict('A customer with this code already exists');
      const r = await client.query<{ id: string }>(
        `INSERT INTO customers (code, name, phone, email, membership, membership_until, discount_bp, notes, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          code,
          input.name,
          input.phone || null,
          input.email || null,
          input.membership || null,
          input.membershipUntil ?? null,
          input.discountBp,
          input.notes || null,
          input.status,
          actor.userId ?? null,
        ],
      );
      await recordAudit(client, actor, {
        action: 'customer.create',
        entityType: 'customer',
        entityId: r.rows[0]!.id,
        details: { code, name: input.name },
      });
      return r.rows[0]!.id;
    });
    return (await this.get(id))!;
  }

  async update(id: string, patch: CustomerPatch, actor: AuditActor): Promise<CustomerSummary> {
    await withTransaction(this.pool, async (client) => {
      const current = await client.query<CustomerRow>(`${SELECT} WHERE c.id = $1 FOR UPDATE`, [id]);
      if (!current.rows[0]) throw notFound('Customer');
      if (patch.code !== undefined && patch.code.trim()) {
        const dup = await client.query(
          'SELECT 1 FROM customers WHERE lower(code) = lower($1) AND id <> $2',
          [patch.code.trim(), id],
        );
        if (dup.rowCount) throw conflict('A customer with this code already exists');
      }
      await client.query(
        `UPDATE customers SET
            code = COALESCE(NULLIF($2, ''), code),
            name = COALESCE($3, name),
            phone = CASE WHEN $4::boolean THEN $5 ELSE phone END,
            email = CASE WHEN $6::boolean THEN $7 ELSE email END,
            membership = CASE WHEN $8::boolean THEN $9 ELSE membership END,
            membership_until = CASE WHEN $10::boolean THEN $11::date ELSE membership_until END,
            discount_bp = COALESCE($12, discount_bp),
            notes = CASE WHEN $13::boolean THEN $14 ELSE notes END,
            status = COALESCE($15, status),
            updated_at = now()
          WHERE id = $1`,
        [
          id,
          patch.code?.trim() ?? '',
          patch.name ?? null,
          patch.phone !== undefined,
          patch.phone || null,
          patch.email !== undefined,
          patch.email || null,
          patch.membership !== undefined,
          patch.membership || null,
          patch.membershipUntil !== undefined,
          patch.membershipUntil ?? null,
          patch.discountBp ?? null,
          patch.notes !== undefined,
          patch.notes || null,
          patch.status ?? null,
        ],
      );
      await recordAudit(client, actor, {
        action: 'customer.update',
        entityType: 'customer',
        entityId: id,
        details: patch,
      });
    });
    return (await this.get(id))!;
  }

  /** Archive (soft delete). Customers are never removed: sales and sessions reference them. */
  async archive(id: string, actor: AuditActor): Promise<CustomerSummary> {
    return this.update(id, { status: 'archived' }, actor);
  }
}
