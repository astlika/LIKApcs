/**
 * Management reports for a date range (inclusive, business time zone of the server). Everything
 * is aggregated straight from the authoritative tables — nothing is pre-computed or cached — and
 * every amount is integer cents.
 *
 * Definitions (see docs/architecture.md § financial definitions)
 *  • gross   = Σ sales.total_cents of completed/refunded sales (what customers were charged)
 *  • net     = gross − refunded
 *  • byMethod uses tenders (payments) so split payments are attributed correctly; change handed
 *    back is deducted from the cash bucket (tenders store the amount handed over)
 *  • gaming  = sessions billed in the range (billed_at), minutes = billable_seconds / 60
 */
import type {
  CashShiftSummary,
  ReportBucket,
  ReportExportKind,
  ReportRange,
  SalesReport,
} from '@likapcs/shared';
import type { DbPool } from '../db/pool.js';
import type { CashService } from './cash.js';
import type { SettingsService } from './settings.js';

interface RangeParams {
  from: string;
  to: string;
}

/**
 * `[from 00:00, to + 1 day 00:00)` as instants, where midnight is taken in the business time
 * zone ($3, the `locale.timezone` setting) — a sale at 00:30 local on the 10th belongs to the
 * 10th even though it is still the 9th in UTC.
 */
const inRange = (col: string) =>
  `${col} >= ($1::date)::timestamp AT TIME ZONE $3 AND ${col} < ($2::date + 1)::timestamp AT TIME ZONE $3`;
/** A timestamptz rendered in the business time zone for grouping / CSV output. */
const local = (col: string) => `(${col} AT TIME ZONE $3)`;
const COMPLETED = `s.status IN ('completed', 'partially_refunded', 'refunded')`;

function bucket(
  rows: { key: string; label?: string | null; n: string; amount: string }[],
): ReportBucket[] {
  return rows.map((r) => ({
    key: r.key,
    label: r.label ?? null,
    count: Number(r.n),
    amountCents: Number(r.amount),
  }));
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export class ReportsService {
  constructor(
    private readonly pool: DbPool,
    private readonly cash: CashService,
    private readonly settings: SettingsService,
  ) {}

  async sales(range: ReportRange): Promise<SalesReport> {
    const timeZone = await this.settings.get('locale.timezone');
    const p: [string, string, string] = [range.from, range.to, timeZone];
    const q = <T extends object>(sql: string) => this.pool.query<T>(sql, p);
    // expense_date is a plain calendar date: no time-zone parameter needed.
    const qDate = <T extends object>(sql: string) =>
      this.pool.query<T>(sql, [range.from, range.to]);
    const [
      totals,
      byMethod,
      bySource,
      byDay,
      byHour,
      topProducts,
      byCategory,
      gaming,
      byStation,
      expenses,
      expByCat,
      byEmployee,
      shifts,
    ] = await Promise.all([
      q<{
        n: string;
        gross: string;
        discount: string;
        tax: string;
        refunded: string;
        refunds_n: string;
      }>(
        `SELECT count(*)::text AS n,
                  COALESCE(SUM(s.total_cents), 0)::bigint::text AS gross,
                  COALESCE(SUM(s.discount_cents), 0)::bigint::text AS discount,
                  COALESCE(SUM(s.tax_cents), 0)::bigint::text AS tax,
                  COALESCE(SUM(s.refunded_cents), 0)::bigint::text AS refunded,
                  (SELECT count(*) FROM refunds r JOIN sales s2 ON s2.id = r.sale_id WHERE ${inRange('r.created_at')})::text AS refunds_n
             FROM sales s WHERE ${COMPLETED} AND ${inRange('s.completed_at')}`,
      ),
      q<{ key: string; n: string; amount: string }>(
        `SELECT p.method AS key, count(*)::text AS n,
                  (SUM(CASE WHEN p.kind = 'refund' THEN -p.amount_cents ELSE p.amount_cents END)
                   - CASE WHEN p.method = 'cash'
                          THEN COALESCE((SELECT SUM(s.change_cents) FROM sales s WHERE ${COMPLETED} AND ${inRange('s.completed_at')}), 0)
                          ELSE 0 END)::bigint::text AS amount
             FROM payments p WHERE p.kind IN ('sale', 'refund') AND ${inRange('p.received_at')}
            GROUP BY p.method ORDER BY amount DESC`,
      ),
      q<{ key: string; n: string; amount: string }>(
        `SELECT s.source AS key, count(*)::text AS n, SUM(s.total_cents - s.refunded_cents)::bigint::text AS amount
             FROM sales s WHERE ${COMPLETED} AND ${inRange('s.completed_at')} GROUP BY s.source ORDER BY s.source`,
      ),
      q<{ date: string; n: string; amount: string; gaming: string; retail: string }>(
        `SELECT to_char(${local('s.completed_at')}, 'YYYY-MM-DD') AS date, count(*)::text AS n,
                  SUM(s.total_cents - s.refunded_cents)::bigint::text AS amount,
                  SUM(CASE WHEN s.source = 'gaming' THEN s.total_cents - s.refunded_cents ELSE 0 END)::bigint::text AS gaming,
                  SUM(CASE WHEN s.source <> 'gaming' THEN s.total_cents - s.refunded_cents ELSE 0 END)::bigint::text AS retail
             FROM sales s WHERE ${COMPLETED} AND ${inRange('s.completed_at')}
            GROUP BY 1 ORDER BY 1`,
      ),
      q<{ hour: number; n: string; amount: string }>(
        `SELECT EXTRACT(HOUR FROM ${local('s.completed_at')})::int AS hour, count(*)::text AS n,
                  SUM(s.total_cents - s.refunded_cents)::bigint::text AS amount
             FROM sales s WHERE ${COMPLETED} AND ${inRange('s.completed_at')}
            GROUP BY 1 ORDER BY 1`,
      ),
      q<{ product_id: string; name: string; qty: string; amount: string }>(
        `SELECT si.product_id, COALESCE(pr.name, si.description) AS name,
                  SUM(si.quantity_milli - si.refunded_milli)::bigint::text AS qty,
                  SUM(si.line_total_cents - COALESCE(ri.refunded, 0))::bigint::text AS amount
             FROM sale_items si JOIN sales s ON s.id = si.sale_id LEFT JOIN products pr ON pr.id = si.product_id
             LEFT JOIN LATERAL (SELECT SUM(amount_cents) AS refunded FROM refund_items WHERE sale_item_id = si.id) ri ON true
            WHERE si.product_id IS NOT NULL AND ${COMPLETED} AND ${inRange('s.completed_at')}
            GROUP BY si.product_id, pr.name, si.description ORDER BY amount DESC LIMIT 15`,
      ),
      q<{ key: string; label: string | null; n: string; amount: string }>(
        `SELECT COALESCE(c.id::text, 'none') AS key, c.name AS label, count(*)::text AS n,
                  SUM(si.line_total_cents - COALESCE(ri.refunded, 0))::bigint::text AS amount
             FROM sale_items si JOIN sales s ON s.id = si.sale_id
             LEFT JOIN products pr ON pr.id = si.product_id LEFT JOIN categories c ON c.id = pr.category_id
             LEFT JOIN LATERAL (SELECT SUM(amount_cents) AS refunded FROM refund_items WHERE sale_item_id = si.id) ri ON true
            WHERE si.product_id IS NOT NULL AND ${COMPLETED} AND ${inRange('s.completed_at')}
            GROUP BY c.id, c.name ORDER BY amount DESC`,
      ),
      q<{ n: string; minutes: string; amount: string }>(
        `SELECT count(*)::text AS n, (COALESCE(SUM(g.billable_seconds), 0) / 60)::bigint::text AS minutes,
                  COALESCE(SUM(g.final_price_cents), 0)::bigint::text AS amount
             FROM gaming_sessions g WHERE g.billed_at IS NOT NULL AND ${inRange('g.billed_at')}`,
      ),
      q<{
        station_id: string;
        code: string;
        name: string;
        n: string;
        minutes: string;
        amount: string;
      }>(
        `SELECT g.station_id, st.code, st.name, count(*)::text AS n,
                  (COALESCE(SUM(g.billable_seconds), 0) / 60)::bigint::text AS minutes,
                  COALESCE(SUM(g.final_price_cents), 0)::bigint::text AS amount
             FROM gaming_sessions g JOIN stations st ON st.id = g.station_id
            WHERE g.billed_at IS NOT NULL AND ${inRange('g.billed_at')}
            GROUP BY g.station_id, st.code, st.name, st.number ORDER BY st.number`,
      ),
      qDate<{ n: string; total: string }>(
        `SELECT count(*)::text AS n, COALESCE(SUM(e.amount_cents), 0)::bigint::text AS total
             FROM expenses e WHERE e.voided_at IS NULL AND e.expense_date >= $1::date AND e.expense_date <= $2::date`,
      ),
      qDate<{ key: string; label: string; n: string; amount: string }>(
        `SELECT e.category_code AS key, c.name_en AS label, count(*)::text AS n, SUM(e.amount_cents)::bigint::text AS amount
             FROM expenses e JOIN expense_categories c ON c.code = e.category_code
            WHERE e.voided_at IS NULL AND e.expense_date >= $1::date AND e.expense_date <= $2::date
            GROUP BY e.category_code, c.name_en ORDER BY amount DESC`,
      ),
      q<{ key: string; label: string; n: string; amount: string }>(
        `SELECT s.cashier_user_id::text AS key, u.full_name AS label, count(*)::text AS n,
                  SUM(s.total_cents - s.refunded_cents)::bigint::text AS amount
             FROM sales s JOIN users u ON u.id = s.cashier_user_id
            WHERE ${COMPLETED} AND ${inRange('s.completed_at')}
            GROUP BY s.cashier_user_id, u.full_name ORDER BY amount DESC`,
      ),
      this.cash.shiftsBetween(range.from, range.to, timeZone),
    ]);

    const t = totals.rows[0]!;
    const gross = Number(t.gross);
    const refunded = Number(t.refunded);
    const count = Number(t.n);
    const g = gaming.rows[0]!;
    const e = expenses.rows[0]!;
    const closedShifts: CashShiftSummary[] = shifts;
    return {
      range,
      sales: {
        count,
        grossCents: gross,
        discountCents: Number(t.discount),
        taxCents: Number(t.tax),
        netCents: gross - refunded,
        refundedCents: refunded,
        refundsCount: Number(t.refunds_n),
        averageCents: count ? Math.round(gross / count) : 0,
      },
      byMethod: bucket(byMethod.rows),
      bySource: bucket(bySource.rows),
      byDay: byDay.rows.map((r) => ({
        date: r.date,
        count: Number(r.n),
        amountCents: Number(r.amount),
        gamingCents: Number(r.gaming),
        retailCents: Number(r.retail),
      })),
      byHour: byHour.rows.map((r) => ({
        hour: Number(r.hour),
        count: Number(r.n),
        amountCents: Number(r.amount),
      })),
      topProducts: topProducts.rows.map((r) => ({
        productId: r.product_id,
        name: r.name,
        quantityMilli: Number(r.qty),
        amountCents: Number(r.amount),
      })),
      byCategory: bucket(byCategory.rows),
      gaming: {
        sessionsCount: Number(g.n),
        billedMinutes: Number(g.minutes),
        amountCents: Number(g.amount),
        byStation: byStation.rows.map((r) => ({
          stationId: r.station_id,
          code: r.code,
          name: r.name,
          sessions: Number(r.n),
          minutes: Number(r.minutes),
          amountCents: Number(r.amount),
        })),
      },
      expenses: {
        count: Number(e.n),
        totalCents: Number(e.total),
        byCategory: bucket(expByCat.rows),
      },
      cash: {
        shiftsCount: closedShifts.length,
        differenceCents: closedShifts.reduce((acc, s) => acc + (s.differenceCents ?? 0), 0),
        shifts: closedShifts,
      },
      byEmployee: bucket(byEmployee.rows),
      generatedAt: new Date().toISOString(),
    };
  }

  /** CSV export (UTF-8 with BOM so Excel opens it correctly; `;` separator for EU locales). */
  async exportCsv(
    kind: ReportExportKind,
    range: RangeParams,
  ): Promise<{ filename: string; csv: string }> {
    const timeZone = await this.settings.get('locale.timezone');
    const p = [range.from, range.to, timeZone];
    const ts = (col: string) => `to_char(${local(col)}, 'YYYY-MM-DD HH24:MI:SS')`;
    let header: string[] = [];
    let rows: unknown[][] = [];
    if (kind === 'sales') {
      const r = await this.pool.query(
        `SELECT s.receipt_no, ${ts('s.completed_at')} AS completed_at, s.status, s.source, u.full_name AS cashier, c.name AS customer,
                s.subtotal_cents, s.discount_cents, s.tax_cents, s.total_cents, s.refunded_cents,
                (SELECT string_agg(p.method || ':' || p.amount_cents, ' ') FROM payments p WHERE p.sale_id = s.id AND p.kind = 'sale') AS tenders
           FROM sales s JOIN users u ON u.id = s.cashier_user_id LEFT JOIN customers c ON c.id = s.customer_id
          WHERE s.status <> 'suspended' AND ${inRange('s.completed_at')} ORDER BY s.completed_at`,
        p,
      );
      header = [
        'receipt_no',
        'completed_at',
        'status',
        'source',
        'cashier',
        'customer',
        'subtotal_cents',
        'discount_cents',
        'tax_cents',
        'total_cents',
        'refunded_cents',
        'tenders',
      ];
      rows = r.rows.map((x) => header.map((h) => x[h]));
    } else if (kind === 'sale_items') {
      const r = await this.pool.query(
        `SELECT s.receipt_no, ${ts('s.completed_at')} AS completed_at, si.line_no, si.description, pr.sku, si.quantity_milli, si.unit_price_cents,
                si.discount_cents, si.tax_rate_bp, si.tax_cents, si.line_total_cents, si.refunded_milli
           FROM sale_items si JOIN sales s ON s.id = si.sale_id LEFT JOIN products pr ON pr.id = si.product_id
          WHERE s.status <> 'suspended' AND ${inRange('s.completed_at')} ORDER BY s.completed_at, si.line_no`,
        p,
      );
      header = [
        'receipt_no',
        'completed_at',
        'line_no',
        'description',
        'sku',
        'quantity_milli',
        'unit_price_cents',
        'discount_cents',
        'tax_rate_bp',
        'tax_cents',
        'line_total_cents',
        'refunded_milli',
      ];
      rows = r.rows.map((x) => header.map((h) => x[h]));
    } else if (kind === 'expenses') {
      const r = await this.pool.query(
        `SELECT to_char(e.expense_date, 'YYYY-MM-DD') AS expense_date, e.category_code, e.description, e.amount_cents,
                e.payment_method, s.name AS supplier, u.full_name AS created_by, e.voided_at, e.void_reason
           FROM expenses e LEFT JOIN suppliers s ON s.id = e.supplier_id LEFT JOIN users u ON u.id = e.created_by
          WHERE e.expense_date >= $1::date AND e.expense_date <= $2::date ORDER BY e.expense_date, e.created_at`,
        [range.from, range.to],
      );
      header = [
        'expense_date',
        'category_code',
        'description',
        'amount_cents',
        'payment_method',
        'supplier',
        'created_by',
        'voided_at',
        'void_reason',
      ];
      rows = r.rows.map((x) => header.map((h) => x[h]));
    } else if (kind === 'sessions') {
      const r = await this.pool.query(
        `SELECT st.code AS station, g.billing_mode, g.status, ${ts('g.started_at')} AS started_at, ${ts('g.ended_at')} AS ended_at, g.billable_seconds,
                g.rate_cents_per_hour, g.discount_cents, g.final_price_cents,
                (SELECT string_agg(p.method, '+') FROM payments p WHERE p.sale_id = g.sale_id AND p.kind = 'sale') AS payment_method,
                COALESCE(g.customer_name, c.name) AS customer_name, s.receipt_no
           FROM gaming_sessions g JOIN stations st ON st.id = g.station_id LEFT JOIN sales s ON s.id = g.sale_id
           LEFT JOIN customers c ON c.id = g.customer_id
          WHERE ${inRange('g.started_at')} ORDER BY g.started_at`,
        p,
      );
      header = [
        'station',
        'billing_mode',
        'status',
        'started_at',
        'ended_at',
        'billable_seconds',
        'rate_cents_per_hour',
        'discount_cents',
        'final_price_cents',
        'payment_method',
        'customer_name',
        'receipt_no',
      ];
      rows = r.rows.map((x) => header.map((h) => x[h]));
    } else {
      const r = await this.pool.query(
        `SELECT r.name AS register, cs.status, ou.full_name AS opened_by, ${ts('cs.opened_at')} AS opened_at, cu.full_name AS closed_by, ${ts('cs.closed_at')} AS closed_at,
                cs.opening_cents, cs.expected_cash_cents, cs.counted_cash_cents, cs.difference_cents, cs.notes
           FROM cash_shifts cs JOIN cash_registers r ON r.id = cs.register_id JOIN users ou ON ou.id = cs.opened_by
           LEFT JOIN users cu ON cu.id = cs.closed_by
          WHERE ${inRange('cs.opened_at')} ORDER BY cs.opened_at`,
        p,
      );
      header = [
        'register',
        'status',
        'opened_by',
        'opened_at',
        'closed_by',
        'closed_at',
        'opening_cents',
        'expected_cash_cents',
        'counted_cash_cents',
        'difference_cents',
        'notes',
      ];
      rows = r.rows.map((x) => header.map((h) => x[h]));
    }
    const csv =
      '\uFEFF' + [header, ...rows].map((r) => r.map(csvEscape).join(';')).join('\r\n') + '\r\n';
    return { filename: `likapcs-${kind}-${range.from}_${range.to}.csv`, csv };
  }
}
