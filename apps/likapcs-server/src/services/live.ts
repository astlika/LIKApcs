/**
 * 0.31.0 — live tracking: what is happening in the shop today, and one sale as it is announced.
 * Profit is net of VAT, like the profit report: price without tax minus the purchase cost.
 * Every money figure comes from the same reports the admin already trusts (summary, staff,
 * cash status); this file only adds the feed, the top products and the debt movements.
 */
import type { LiveSale, LiveSnapshot, ReportRange } from '@likapcs/shared';
import type { DbPool } from '../db/pool.js';
import type { CashService } from './cash.js';
import type { ReportsService } from './reports.js';
import type { SettingsService } from './settings.js';

const COMPLETED = `s.status IN ('completed', 'partially_refunded', 'refunded')`;
const FEED_LIMIT = 30;
const TOP_LIMIT = 10;

type SaleRow = {
  id: string;
  receipt_no: string | null;
  completed_at: Date;
  total_cents: string;
  cashier: string;
  customer: string | null;
  on_credit: boolean;
  profit_cents: string;
  missing_cost: boolean;
};

export class LiveService {
  constructor(
    private readonly pool: DbPool,
    private readonly settings: SettingsService,
    private readonly cash: CashService,
    private readonly reports: ReportsService,
  ) {}

  /** Today's date in the business time zone, as YYYY-MM-DD. */
  private async today(): Promise<{ date: string; timeZone: string }> {
    const timeZone = await this.settings.get('locale.timezone');
    const r = await this.pool.query<{ d: string }>(
      `SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS d`,
      [timeZone],
    );
    return { date: r.rows[0]!.d, timeZone };
  }

  async snapshot(): Promise<LiveSnapshot> {
    const { date, timeZone } = await this.today();
    const range: ReportRange = { from: date, to: date };
    const p: [string, string, string] = [date, date, timeZone];
    const inDay = (col: string) =>
      `${col} >= ($1::date)::timestamp AT TIME ZONE $3 AND ${col} < ($2::date + 1)::timestamp AT TIME ZONE $3`;

    const [summary, staff, cash, debts, lastSales, top, feedRows] = await Promise.all([
      this.reports.summary(range),
      this.reports.staff(range),
      this.cash.status(),
      this.pool.query<{ given: string; collected: string }>(
        `SELECT COALESCE(SUM(CASE WHEN p.kind = 'sale' AND p.method = 'credit' THEN p.amount_cents END), 0)::bigint::text AS given,
                COALESCE(SUM(CASE WHEN p.kind = 'customer_payment' THEN p.amount_cents END), 0)::bigint::text AS collected
           FROM payments p WHERE ${inDay('p.received_at')}`,
        p,
      ),
      this.pool.query<{ user_id: string; last_at: Date }>(
        `SELECT s.cashier_user_id::text AS user_id, MAX(s.completed_at) AS last_at
           FROM sales s WHERE ${COMPLETED} AND ${inDay('s.completed_at')}
          GROUP BY s.cashier_user_id`,
        p,
      ),
      this.pool.query<{ name: string; qty: string; amount: string; profit: string }>(
        `SELECT si.description AS name, SUM(si.quantity_milli)::bigint::text AS qty,
                SUM(si.line_total_cents)::bigint::text AS amount,
                SUM(si.line_total_cents - si.tax_cents - si.cost_cents)::bigint::text AS profit
           FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE ${COMPLETED} AND ${inDay('s.completed_at')}
          GROUP BY si.description
          ORDER BY SUM(si.line_total_cents) DESC, si.description
          LIMIT ${TOP_LIMIT}`,
        p,
      ),
      this.pool.query<SaleRow>(
        `${this.saleSelect()}
          WHERE ${COMPLETED} AND ${inDay('s.completed_at')}
          ORDER BY s.completed_at DESC
          LIMIT ${FEED_LIMIT}`,
        p,
      ),
    ]);

    const feed = await this.withItems(feedRows.rows);
    const lastByUser = new Map(lastSales.rows.map((r) => [r.user_id, r.last_at.toISOString()]));
    const cur = cash.current;
    const d = debts.rows[0];
    const checks = summary.checks;

    return {
      generatedAt: new Date().toISOString(),
      date,
      drawer: {
        open: cur?.status === 'open',
        registerName: cur?.registerName ?? null,
        openedBy: cur?.openedBy?.name ?? null,
        openedAt: cur?.openedAt ?? null,
        openingCents: cur?.openingCents ?? null,
        expectedCents: cur?.totals.expectedCashCents ?? null,
      },
      totals: {
        turnoverCents: summary.turnoverCents,
        salesCount: summary.salesCount,
        averageSaleCents: summary.averageSaleCents,
        grossProfitCents: summary.grossProfitCents,
        netProfitCents: summary.netProfitCents,
        expensesCents: summary.expensesCents,
        lossCents: summary.refundedCents + summary.stockLossCents,
        refundedCents: summary.refundedCents,
        stockLossCents: summary.stockLossCents,
        debtGivenCents: Number(d?.given ?? 0),
        debtCollectedCents: Number(d?.collected ?? 0),
        incomplete:
          checks.productsWithoutCost + checks.saleLinesWithoutCost + checks.lossesWithoutCost > 0,
      },
      staff: staff.staff.map((s) => ({
        userId: s.userId,
        name: s.name,
        onDuty: s.onDutyNow,
        salesCount: s.salesCount,
        salesCents: s.salesCents,
        lastSaleAt: lastByUser.get(s.userId) ?? null,
        workedMinutes: s.workedMinutes,
      })),
      topProducts: top.rows.map((r) => ({
        name: r.name,
        quantityMilli: Number(r.qty),
        amountCents: Number(r.amount),
        profitCents: Number(r.profit),
      })),
      feed,
    };
  }

  /** One completed sale, as the notification shows it. Null when the sale is not completed. */
  async saleEvent(saleId: string): Promise<LiveSale | null> {
    const r = await this.pool.query<SaleRow>(
      `${this.saleSelect()} WHERE s.id = $1 AND ${COMPLETED}`,
      [saleId],
    );
    if (r.rows.length === 0) return null;
    const [sale] = await this.withItems(r.rows);
    return sale ?? null;
  }

  private saleSelect(): string {
    return `SELECT s.id::text AS id, s.receipt_no, s.completed_at, s.total_cents::text AS total_cents,
                   u.full_name AS cashier, c.name AS customer,
                   EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id AND p.kind = 'sale' AND p.method = 'credit') AS on_credit,
                   (SELECT COALESCE(SUM(si.line_total_cents - si.tax_cents - si.cost_cents), 0)::bigint::text FROM sale_items si WHERE si.sale_id = s.id) AS profit_cents,
                   EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id AND si.product_id IS NOT NULL AND si.cost_cents = 0) AS missing_cost
              FROM sales s
              JOIN users u ON u.id = s.cashier_user_id
              LEFT JOIN customers c ON c.id = s.customer_id`;
  }

  private async withItems(rows: SaleRow[]): Promise<LiveSale[]> {
    if (rows.length === 0) return [];
    const items = await this.pool.query<{
      sale_id: string;
      description: string;
      quantity_milli: string;
      line_total_cents: string;
      profit: string;
      is_time: boolean;
    }>(
      `SELECT si.sale_id::text AS sale_id, si.description, si.quantity_milli::text AS quantity_milli,
              si.line_total_cents::text AS line_total_cents, si.product_id IS NULL AS is_time,
              (si.line_total_cents - si.tax_cents - si.cost_cents)::text AS profit
         FROM sale_items si WHERE si.sale_id = ANY($1::uuid[]) ORDER BY si.sale_id, si.line_no`,
      [rows.map((r) => r.id)],
    );
    const bySale = new Map<string, LiveSale['items']>();
    for (const i of items.rows) {
      const list = bySale.get(i.sale_id) ?? [];
      list.push({
        name: i.description,
        quantityMilli: Number(i.quantity_milli),
        lineTotalCents: Number(i.line_total_cents),
        profitCents: Number(i.profit),
        isTime: i.is_time,
      });
      bySale.set(i.sale_id, list);
    }
    return rows.map((r) => ({
      saleId: r.id,
      receiptNo: r.receipt_no ?? '',
      cashierName: r.cashier,
      completedAt: r.completed_at.toISOString(),
      totalCents: Number(r.total_cents),
      profitCents: Number(r.profit_cents),
      missingCost: r.missing_cost,
      onCredit: r.on_credit,
      customerName: r.customer,
      items: bySale.get(r.id) ?? [],
    }));
  }
}
