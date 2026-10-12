/**
 * Customer account statement (0.11.0): one timeline per customer with everything that touched
 * their account — every receipt (POS sale, session bill, order) with how it was paid, every debt
 * repayment with the receipts it settled, wallet top-ups / pay-outs and refunds. A read model
 * over `sales`, `payments`, `customer_debts`, `debt_payments`, `refunds` and `customer_ledger`;
 * nothing is stored twice.
 *
 * Shape: a UNION of the five entry kinds keyed by `(kind, id, at)` is paged in SQL, then each
 * page row is hydrated with kind-specific JSON (tenders, debt state, settled receipts).
 */
import type {
  CustomerStatement,
  StatementEntry,
  StatementEntryKind,
  StatementQuery,
} from '@likapcs/shared';
import type { DbPool } from '../db/pool.js';
import { notFound } from '../errors.js';
import { CUSTOMER_SELECT, toCustomerSummary, type CustomerRow } from './customers.js';

interface EntryRow {
  kind: StatementEntryKind;
  id: string;
  at: Date;
  receipt_no: string | null;
  description: string | null;
  station_code: string | null;
  duration_seconds: number | null;
  amount_cents: number;
  cash_cents: number | null;
  wallet_cents: number | null;
  credit_cents: number | null;
  other_cents: number | null;
  debt: {
    id: string;
    status: 'open' | 'partial' | 'paid' | 'written_off';
    remaining_cents: number;
    due_date: string;
    settled_at: string | null;
  } | null;
  settles: { debt_id: string; receipt_no: string | null; amount_cents: number }[] | null;
  sale_id: string | null;
  session_id: string | null;
  created_by_name: string | null;
  note: string | null;
}

/**
 * The five entry kinds as one relation: `(kind, id, at, filter columns)`. Only what the page
 * ordering / filters need — details are joined per page row below.
 */
const ENTRIES = `
  SELECT 'sale'::text AS kind, s.id::text AS id, s.completed_at AS at,
         EXISTS (SELECT 1 FROM customer_debts d WHERE d.sale_id = s.id AND d.status IN ('open', 'partial')) AS unpaid,
         EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id AND p.kind = 'sale' AND p.method = 'wallet') AS wallet
    FROM sales s
   WHERE s.customer_id = $1 AND s.status IN ('completed', 'partially_refunded', 'refunded')
  UNION ALL
  SELECT 'refund', r.id::text, r.created_at, false,
         EXISTS (SELECT 1 FROM payments p WHERE p.refund_id = r.id AND p.method = 'wallet')
    FROM refunds r JOIN sales s ON s.id = r.sale_id
   WHERE s.customer_id = $1
  UNION ALL
  SELECT 'debt_payment', p.id::text, p.received_at, false, p.method = 'wallet'
    FROM payments p
   WHERE p.customer_id = $1 AND p.kind = 'customer_payment'
  UNION ALL
  SELECT 'wallet_topup', p.id::text, p.received_at, false, true
    FROM payments p
   WHERE p.customer_id = $1 AND p.kind = 'wallet_topup'
  UNION ALL
  SELECT 'wallet_withdrawal', p.id::text, p.received_at, false, true
    FROM payments p
   WHERE p.customer_id = $1 AND p.kind = 'wallet_refund'`;

/** Hydrates one page of `(kind, id)` keys — `$1` = the keys as a jsonb array. */
const HYDRATE = `
  WITH keys AS (
    SELECT (k->>'kind')::text AS kind, (k->>'id')::text AS id, (k->>'n')::int AS n
      FROM jsonb_array_elements($1::jsonb) k
  )
  SELECT k.n, k.kind, k.id,
         CASE k.kind
           WHEN 'sale' THEN s.completed_at
           WHEN 'refund' THEN r.created_at
           ELSE p.received_at END AS at,
         CASE k.kind WHEN 'sale' THEN s.receipt_no WHEN 'refund' THEN r.refund_no ELSE NULL END AS receipt_no,
         CASE k.kind
           WHEN 'sale' THEN (SELECT string_agg(si.description, ', ' ORDER BY si.line_no)
                               FROM (SELECT description, line_no FROM sale_items WHERE sale_id = s.id ORDER BY line_no LIMIT 4) si)
           WHEN 'refund' THEN r.reason
           ELSE l.note END AS description,
         CASE k.kind WHEN 'sale' THEN COALESCE(gs.station_code, gb.station_code) ELSE NULL END AS station_code,
         CASE k.kind WHEN 'sale' THEN COALESCE(gs.billable_seconds, gb.billable_seconds) ELSE NULL END AS duration_seconds,
         CASE k.kind
           WHEN 'sale' THEN s.total_cents
           WHEN 'refund' THEN r.total_cents
           ELSE p.amount_cents END AS amount_cents,
         CASE k.kind
           WHEN 'sale' THEN GREATEST(0, COALESCE(t.cash_cents, 0) - s.change_cents)
           WHEN 'refund' THEN COALESCE(rt.cash_cents, 0)
           WHEN 'debt_payment' THEN CASE WHEN p.method = 'cash' THEN p.amount_cents ELSE 0 END
           ELSE p.amount_cents END AS cash_cents,
         CASE k.kind
           WHEN 'sale' THEN COALESCE(t.wallet_cents, 0)
           WHEN 'refund' THEN COALESCE(rt.wallet_cents, 0)
           WHEN 'debt_payment' THEN CASE WHEN p.method = 'wallet' THEN p.amount_cents ELSE 0 END
           ELSE 0 END AS wallet_cents,
         CASE k.kind WHEN 'sale' THEN COALESCE(t.credit_cents, 0) ELSE 0 END AS credit_cents,
         CASE k.kind
           WHEN 'sale' THEN COALESCE(t.other_cents, 0)
           WHEN 'refund' THEN COALESCE(rt.other_cents, 0)
           WHEN 'debt_payment' THEN CASE WHEN p.method NOT IN ('cash', 'wallet') THEN p.amount_cents ELSE 0 END
           ELSE 0 END AS other_cents,
         CASE k.kind WHEN 'sale' THEN (
           SELECT jsonb_build_object('id', d.id, 'status', d.status, 'remaining_cents', d.amount_cents - d.paid_cents,
                                     'due_date', to_char(d.due_date, 'YYYY-MM-DD'), 'settled_at', d.settled_at)
             FROM customer_debts d WHERE d.sale_id = s.id ORDER BY d.created_at LIMIT 1) END AS debt,
         CASE k.kind WHEN 'debt_payment' THEN (
           SELECT jsonb_agg(jsonb_build_object('debt_id', dp.debt_id, 'receipt_no', ds.receipt_no, 'amount_cents', dp.amount_cents)
                            ORDER BY dp.created_at)
             FROM debt_payments dp
             JOIN customer_debts d ON d.id = dp.debt_id
             LEFT JOIN sales ds ON ds.id = d.sale_id
            WHERE dp.payment_id = p.id) END AS settles,
         CASE k.kind WHEN 'sale' THEN s.id::text WHEN 'refund' THEN r.sale_id::text ELSE NULL END AS sale_id,
         CASE k.kind WHEN 'sale' THEN COALESCE(gs.id, gb.id)::text ELSE NULL END AS session_id,
         COALESCE(us.full_name, ur.full_name, up.full_name) AS created_by_name,
         CASE k.kind WHEN 'sale' THEN s.notes WHEN 'refund' THEN NULL ELSE COALESCE(l.note, p.reference) END AS note
    FROM keys k
    LEFT JOIN sales s ON k.kind = 'sale' AND s.id::text = k.id
    LEFT JOIN refunds r ON k.kind = 'refund' AND r.id::text = k.id
    LEFT JOIN payments p ON k.kind IN ('debt_payment', 'wallet_topup', 'wallet_withdrawal') AND p.id::text = k.id
    LEFT JOIN LATERAL (
      SELECT g.id, st.code AS station_code, g.billable_seconds
        FROM sale_items si JOIN gaming_sessions g ON g.id = si.gaming_session_id JOIN stations st ON st.id = g.station_id
       WHERE si.sale_id = s.id ORDER BY si.line_no LIMIT 1) gs ON k.kind = 'sale'
    LEFT JOIN LATERAL (
      SELECT g.id, st.code AS station_code, g.billable_seconds
        FROM gaming_sessions g JOIN stations st ON st.id = g.station_id
       WHERE g.sale_id = s.id ORDER BY g.started_at LIMIT 1) gb ON k.kind = 'sale'
    LEFT JOIN LATERAL (
      SELECT SUM(CASE WHEN x.method = 'cash' THEN x.amount_cents ELSE 0 END) AS cash_cents,
             SUM(CASE WHEN x.method = 'wallet' THEN x.amount_cents ELSE 0 END) AS wallet_cents,
             SUM(CASE WHEN x.method = 'credit' THEN x.amount_cents ELSE 0 END) AS credit_cents,
             SUM(CASE WHEN x.method NOT IN ('cash', 'wallet', 'credit') THEN x.amount_cents ELSE 0 END) AS other_cents
        FROM payments x WHERE x.sale_id = s.id AND x.kind = 'sale') t ON k.kind = 'sale'
    LEFT JOIN LATERAL (
      SELECT SUM(CASE WHEN x.method = 'cash' THEN x.amount_cents ELSE 0 END) AS cash_cents,
             SUM(CASE WHEN x.method = 'wallet' THEN x.amount_cents ELSE 0 END) AS wallet_cents,
             SUM(CASE WHEN x.method NOT IN ('cash', 'wallet') THEN x.amount_cents ELSE 0 END) AS other_cents
        FROM payments x WHERE x.refund_id = r.id AND x.kind = 'refund') rt ON k.kind = 'refund'
    LEFT JOIN customer_ledger l ON k.kind IN ('wallet_topup', 'wallet_withdrawal')
                               AND l.reference_type = 'payment' AND l.reference_id = p.id::text
    LEFT JOIN users us ON us.id = s.cashier_user_id
    LEFT JOIN users ur ON ur.id = r.created_by
    LEFT JOIN users up ON up.id = p.created_by
   ORDER BY k.n`;

export class StatementService {
  constructor(private readonly pool: DbPool) {}

  async get(customerId: string, query: StatementQuery): Promise<CustomerStatement> {
    const customerRow = await this.pool.query<CustomerRow>(`${CUSTOMER_SELECT} WHERE c.id = $1`, [
      customerId,
    ]);
    if (!customerRow.rows[0]) throw notFound('Customer');
    const customer = toCustomerSummary(customerRow.rows[0]);

    const where: string[] = [];
    const values: unknown[] = [customerId];
    switch (query.filter) {
      case 'receipts':
        where.push(`e.kind IN ('sale', 'refund')`);
        break;
      case 'unpaid':
        where.push(`e.kind = 'sale' AND e.unpaid`);
        break;
      case 'payments':
        where.push(`e.kind = 'debt_payment'`);
        break;
      case 'wallet':
        where.push(`e.wallet`);
        break;
      default:
        break;
    }
    if (query.from) {
      values.push(query.from);
      where.push(`e.at >= $${values.length}::date`);
    }
    if (query.to) {
      values.push(query.to);
      where.push(`e.at < ($${values.length}::date + 1)`);
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [page, count, totals] = await Promise.all([
      this.pool.query<{ kind: StatementEntryKind; id: string }>(
        `SELECT e.kind, e.id FROM (${ENTRIES}) e ${filter}
          ORDER BY e.at DESC, e.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, query.pageSize, (query.page - 1) * query.pageSize],
      ),
      this.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM (${ENTRIES}) e ${filter}`,
        values,
      ),
      this.totals(customerId),
    ]);
    const keys = page.rows.map((r, n) => ({ kind: r.kind, id: r.id, n }));
    const rows = keys.length
      ? await this.pool.query<EntryRow>(HYDRATE, [JSON.stringify(keys)])
      : { rows: [] as EntryRow[] };
    return {
      customer,
      totals: { ...totals, debtOpenCents: customer.balanceDueCents },
      items: rows.rows.map(toEntry),
      total: Number(count.rows[0]?.n ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private async totals(
    customerId: string,
  ): Promise<Omit<CustomerStatement['totals'], 'debtOpenCents'>> {
    const r = await this.pool.query<{
      receipts: string;
      spent: number;
      cash: number;
      wallet: number;
      credit: number;
      debt_paid: number;
      topups: number;
      play_seconds: number;
      first_visit: Date | null;
      last_visit: Date | null;
    }>(
      `SELECT (SELECT count(*)::text FROM sales s WHERE s.customer_id = $1 AND s.status IN ('completed', 'partially_refunded', 'refunded')) AS receipts,
              (SELECT COALESCE(SUM(s.total_cents - s.refunded_cents), 0)::bigint FROM sales s
                WHERE s.customer_id = $1 AND s.status IN ('completed', 'partially_refunded', 'refunded')) AS spent,
              (SELECT COALESCE(SUM(CASE WHEN p.method = 'cash' THEN p.amount_cents ELSE 0 END), 0)::bigint
                      - COALESCE((SELECT SUM(s.change_cents) FROM sales s WHERE s.customer_id = $1 AND s.status <> 'suspended' AND s.status <> 'void'), 0)::bigint
                 FROM payments p JOIN sales s ON s.id = p.sale_id
                WHERE s.customer_id = $1 AND p.kind = 'sale') AS cash,
              (SELECT COALESCE(SUM(p.amount_cents), 0)::bigint FROM payments p JOIN sales s ON s.id = p.sale_id
                WHERE s.customer_id = $1 AND p.kind = 'sale' AND p.method = 'wallet') AS wallet,
              (SELECT COALESCE(SUM(p.amount_cents), 0)::bigint FROM payments p JOIN sales s ON s.id = p.sale_id
                WHERE s.customer_id = $1 AND p.kind = 'sale' AND p.method = 'credit') AS credit,
              (SELECT COALESCE(SUM(p.amount_cents), 0)::bigint FROM payments p
                WHERE p.customer_id = $1 AND p.kind = 'customer_payment') AS debt_paid,
              (SELECT COALESCE(SUM(p.amount_cents), 0)::bigint FROM payments p
                WHERE p.customer_id = $1 AND p.kind = 'wallet_topup') AS topups,
              (SELECT COALESCE(SUM(COALESCE(g.billable_seconds, 0)), 0)::bigint FROM gaming_sessions g WHERE g.customer_id = $1) AS play_seconds,
              LEAST((SELECT MIN(completed_at) FROM sales s WHERE s.customer_id = $1),
                    (SELECT MIN(started_at) FROM gaming_sessions g WHERE g.customer_id = $1)) AS first_visit,
              GREATEST((SELECT MAX(completed_at) FROM sales s WHERE s.customer_id = $1),
                       (SELECT MAX(started_at) FROM gaming_sessions g WHERE g.customer_id = $1)) AS last_visit`,
      [customerId],
    );
    const t = r.rows[0]!;
    return {
      receiptsCount: Number(t.receipts),
      spentCents: Number(t.spent),
      paidCashCents: Math.max(0, Number(t.cash)),
      paidWalletCents: Number(t.wallet),
      onCreditCents: Number(t.credit),
      debtPaidCents: Number(t.debt_paid),
      walletTopUpsCents: Number(t.topups),
      playSeconds: Number(t.play_seconds),
      firstVisitAt: t.first_visit ? t.first_visit.toISOString() : null,
      lastVisitAt: t.last_visit ? t.last_visit.toISOString() : null,
    };
  }
}

function toEntry(r: EntryRow): StatementEntry {
  return {
    key: `${r.kind}:${r.id}`,
    kind: r.kind,
    at: r.at.toISOString(),
    receiptNo: r.receipt_no,
    description: r.description ?? '',
    stationCode: r.station_code,
    durationSeconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
    amountCents: Number(r.amount_cents),
    paid: {
      cashCents: Number(r.cash_cents ?? 0),
      walletCents: Number(r.wallet_cents ?? 0),
      creditCents: Number(r.credit_cents ?? 0),
      otherCents: Number(r.other_cents ?? 0),
    },
    debt: r.debt
      ? {
          id: r.debt.id,
          status: r.debt.status,
          remainingCents: Number(r.debt.remaining_cents),
          dueDate: r.debt.due_date,
          settledAt: r.debt.settled_at,
        }
      : null,
    settles: (r.settles ?? []).map((x) => ({
      debtId: x.debt_id,
      receiptNo: x.receipt_no,
      amountCents: Number(x.amount_cents),
    })),
    saleId: r.sale_id,
    sessionId: r.session_id,
    createdByName: r.created_by_name,
    note: r.note,
  };
}
