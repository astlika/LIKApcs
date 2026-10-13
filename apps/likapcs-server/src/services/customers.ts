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
import { badRequest, conflict, notFound } from '../errors.js';
import { hashPassword } from '../security/password.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { SalesService } from './sales.js';
import type { SessionsService } from './sessions.js';

export interface CustomerRow {
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
  credit_limit_cents: string;
  notes: string | null;
  status: CustomerStatus;
  login_username: string | null;
  login_enabled: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** The `CustomerSummary` projection — shared with the wallet / statement services. */
export const CUSTOMER_SELECT = `
  SELECT c.id, c.code, c.name, c.phone, c.email, c.membership, to_char(c.membership_until, 'YYYY-MM-DD') AS membership_until,
         c.discount_bp, c.loyalty_points, c.wallet_balance_cents, c.balance_due_cents, c.credit_limit_cents, c.notes,
         c.status, c.login_username, c.login_enabled, c.last_login_at, c.created_at, c.updated_at
    FROM customers c`;
const SELECT = CUSTOMER_SELECT;

export function toCustomerSummary(r: CustomerRow): CustomerSummary {
  return toSummary(r);
}

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
    creditLimitCents: Number(r.credit_limit_cents),
    notes: r.notes,
    status: r.status,
    loginUsername: r.login_username,
    loginEnabled: r.login_enabled,
    lastLoginAt: r.last_login_at ? r.last_login_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Audit details never carry the PIN — only the fact that it was set. */
function auditable<T extends { loginPassword?: string }>(
  input: T,
): Omit<T, 'loginPassword'> & {
  loginPasswordSet?: boolean;
} {
  const { loginPassword, ...rest } = input;
  return loginPassword === undefined ? rest : { ...rest, loginPasswordSet: true };
}

/**
 * Login fields of a create / update: `loginUsername` '' or null removes the login (and its PIN);
 * a new username needs a PIN unless the customer already has one. Uniqueness is case-insensitive
 * (the partial unique index backs it up against races).
 */
async function applyLogin(
  client: DbClient,
  id: string,
  input: Pick<CustomerPatch, 'loginUsername' | 'loginPassword' | 'loginEnabled'>,
  current: { login_username: string | null; has_hash: boolean },
): Promise<void> {
  const hash = input.loginPassword ? await hashPassword(input.loginPassword) : null;
  if (input.loginUsername !== undefined) {
    const username = input.loginUsername?.trim() || null;
    if (!username) {
      await client.query(
        `UPDATE customers SET login_username = NULL, login_password_hash = NULL, login_enabled = false,
                login_failed_count = 0, login_locked_until = NULL WHERE id = $1`,
        [id],
      );
      return;
    }
    const dup = await client.query(
      'SELECT 1 FROM customers WHERE lower(login_username) = lower($1) AND id <> $2',
      [username, id],
    );
    if (dup.rowCount)
      throw conflict('Another customer already uses this username', { field: 'loginUsername' });
    if (!current.has_hash && !hash)
      throw badRequest('A PIN/password is required for the customer login', {
        field: 'loginPassword',
      });
    // Username and hash land together: the table forbids a username without a hash.
    await client.query(
      `UPDATE customers SET login_username = $2, login_enabled = $3,
              login_password_hash = COALESCE($4, login_password_hash),
              login_failed_count = 0, login_locked_until = NULL
        WHERE id = $1`,
      [id, username, input.loginEnabled ?? true, hash],
    );
    return;
  }
  if (input.loginEnabled !== undefined && current.login_username) {
    await client.query('UPDATE customers SET login_enabled = $2 WHERE id = $1', [
      id,
      input.loginEnabled,
    ]);
  }
  if (hash) {
    if (!current.login_username) throw badRequest('Set a username for the customer login first');
    await client.query(
      `UPDATE customers SET login_password_hash = $2, login_failed_count = 0, login_locked_until = NULL WHERE id = $1`,
      [id, hash],
    );
  }
}

export async function nextCustomerCode(client: DbClient): Promise<string> {
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
        `INSERT INTO customers (code, name, phone, email, membership, membership_until, discount_bp, notes, status, created_by,
           credit_limit_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
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
          input.creditLimitCents,
        ],
      );
      await applyLogin(client, r.rows[0]!.id, input, { login_username: null, has_hash: false });
      await recordAudit(client, actor, {
        action: 'customer.create',
        entityType: 'customer',
        entityId: r.rows[0]!.id,
        details: { code, name: input.name, loginUsername: input.loginUsername?.trim() || null },
      });
      return r.rows[0]!.id;
    });
    return (await this.get(id))!;
  }

  async update(id: string, patch: CustomerPatch, actor: AuditActor): Promise<CustomerSummary> {
    await withTransaction(this.pool, async (client) => {
      const current = await client.query<CustomerRow & { has_hash: boolean }>(
        `${SELECT.replace('c.last_login_at,', 'c.last_login_at, (c.login_password_hash IS NOT NULL) AS has_hash,')} WHERE c.id = $1 FOR UPDATE`,
        [id],
      );
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
            credit_limit_cents = COALESCE($16, credit_limit_cents),
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
          patch.creditLimitCents ?? null,
        ],
      );
      // Archiving frees the username: an archived customer cannot sign in anyway, and the name
      // may be reused by the next registration.
      const login =
        patch.status === 'archived' && patch.loginUsername === undefined
          ? { ...patch, loginUsername: null }
          : patch;
      await applyLogin(client, id, login, current.rows[0]);
      await recordAudit(client, actor, {
        action: 'customer.update',
        entityType: 'customer',
        entityId: id,
        details: auditable(patch),
      });
    });
    return (await this.get(id))!;
  }

  /** Archive (soft delete). Customers are never removed: sales and sessions reference them. */
  async archive(id: string, actor: AuditActor): Promise<CustomerSummary> {
    return this.update(id, { status: 'archived' }, actor);
  }
}
