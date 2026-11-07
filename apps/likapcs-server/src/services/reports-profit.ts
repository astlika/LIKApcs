/**
 * Profit & loss and the spending register for a date range (business time zone, both ends
 * inclusive). Read-only: everything is aggregated from the authoritative tables.
 *
 * Accrual profit
 *  • revenue          = net sales (total − refunded, as on the sales report) minus the VAT inside it
 *  • cost of sales    = cost snapshot of every line sold, minus the cost of refunded goods that went
 *                       back on the shelf (refund with restock). Refunded goods NOT restocked stay in
 *                       the cost of sales: they were paid for and are gone.
 *  • operating costs  = expenses (not voided) by expense_date
 *  • stock losses     = stock that left without a sale (damaged, expired, missing, counted short,
 *                       adjusted down), at the unit cost recorded on the movement
 *  • net profit       = revenue − cost of sales − operating costs − stock losses
 *
 * Stock bought is not a cost when it arrives; it becomes one when it is sold. Supplier payments are
 * cash, not cost. The cash view (drawer movements, supplier payments) is kept apart from profit.
 */
import {
  SPENDING_ROW_LIMIT,
  type ProfitReport,
  type ReportBucket,
  type ReportRange,
  type SpendingEffect,
  type SpendingKind,
  type SpendingReport,
  type SpendingRow,
} from '@likapcs/shared';
import type { DbPool } from '../db/pool.js';

type Params = [string, string, string];

/** `[from 00:00, to + 1 day 00:00)` in the business time zone ($3). */
const inRange = (col: string) =>
  `${col} >= ($1::date)::timestamp AT TIME ZONE $3 AND ${col} < ($2::date + 1)::timestamp AT TIME ZONE $3`;
const COMPLETED = `s.status IN ('completed', 'partially_refunded', 'refunded')`;

/** Basis points of `part` over `whole`, null when there is nothing to divide by. */
const bps = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part * 10_000) / whole) : null;

const toBuckets = (
  rows: { key: string; label?: string | null; n: string; amount: string }[],
): ReportBucket[] =>
  rows.map((r) => ({
    key: r.key,
    label: r.label ?? null,
    count: Number(r.n),
    amountCents: Number(r.amount),
  }));

/**
 * Every spending row as one CTE named `rows`: expenses, stock received, opening stock, stock added,
 * stock losses and supplier payments. Amounts are positive; `effect` says where each one lands.
 */
const SPENDING_CTE = `
rows AS (
  SELECT (e.expense_date::timestamp AT TIME ZONE $3) AS at,
         'expense'::text AS kind, 'profit'::text AS effect,
         e.description::text AS description, c.name_en::text AS category,
         e.payment_method::text AS method, e.amount_cents AS amount, e.id::text AS reference
    FROM expenses e JOIN expense_categories c ON c.code = e.category_code
   WHERE e.voided_at IS NULL AND e.expense_date >= $1::date AND e.expense_date <= $2::date
  UNION ALL
  SELECT pr.received_at, 'stock_received', 'stock',
         pd.name::text, sup.name::text, NULL::text,
         ROUND(pri.quantity_milli::numeric * pri.unit_cost_mills / 10000)::bigint, pu.id::text
    FROM purchase_receipt_items pri
    JOIN purchase_receipts pr ON pr.id = pri.receipt_id
    JOIN purchase_items pi ON pi.id = pri.purchase_item_id
    JOIN purchases pu ON pu.id = pi.purchase_id
    JOIN suppliers sup ON sup.id = pu.supplier_id
    JOIN products pd ON pd.id = pi.product_id
   WHERE pri.inventory_movement_id IS NOT NULL AND ${inRange('pr.received_at')}
  UNION ALL
  SELECT m.created_at,
         CASE WHEN m.movement_type = 'initial' THEN 'stock_opening' ELSE 'stock_added' END, 'stock',
         pd.name::text, m.reason::text, NULL::text,
         ROUND(m.quantity_milli_delta::numeric * COALESCE(m.unit_cost_mills, 0) / 10000)::bigint, m.id::text
    FROM inventory_movements m JOIN products pd ON pd.id = m.product_id
   WHERE m.quantity_milli_delta > 0 AND m.movement_type IN ('initial', 'adjustment', 'stock_count')
     AND ${inRange('m.created_at')}
  UNION ALL
  SELECT m.created_at, 'stock_loss', 'profit',
         pd.name::text, m.reason::text, m.movement_type::text,
         ROUND(ABS(m.quantity_milli_delta)::numeric * COALESCE(m.unit_cost_mills, 0) / 10000)::bigint, m.id::text
    FROM inventory_movements m JOIN products pd ON pd.id = m.product_id
   WHERE m.quantity_milli_delta < 0
     AND m.movement_type IN ('damaged', 'expired', 'missing', 'stock_count', 'adjustment')
     AND ${inRange('m.created_at')}
  UNION ALL
  SELECT pp.paid_at, 'supplier_payment', 'cash',
         COALESCE(pu.supplier_invoice_no, 'Purchase')::text, sup.name::text, pp.method::text,
         pp.amount_cents, pp.id::text
    FROM purchase_payments pp
    JOIN purchases pu ON pu.id = pp.purchase_id
    JOIN suppliers sup ON sup.id = pu.supplier_id
   WHERE ${inRange('pp.paid_at')}
)`;

interface SpendingDbRow {
  date: string;
  kind: SpendingKind;
  effect: SpendingEffect;
  description: string;
  category: string | null;
  method: string | null;
  amount: string;
  reference: string | null;
}

const toSpendingRow = (r: SpendingDbRow): SpendingRow => ({
  date: r.date,
  kind: r.kind,
  effect: r.effect,
  description: r.description,
  category: r.category,
  method: r.method,
  amountCents: Number(r.amount),
  reference: r.reference,
});

const SPENDING_SELECT = `
  SELECT to_char(at AT TIME ZONE $3, 'YYYY-MM-DD') AS date, kind, effect, description, category,
         method, amount::text AS amount, reference`;

export async function profitReport(
  pool: DbPool,
  timeZone: string,
  range: ReportRange,
): Promise<ProfitReport> {
  const p: Params = [range.from, range.to, timeZone];
  const dates = [range.from, range.to];
  const q = <T extends object>(sql: string, params: unknown[] = p) => pool.query<T>(sql, params);

  const [rev, cogs, exp, loss, received, invIn, drawer, supplierPaid, payables, productChecks] =
    await Promise.all([
      q<{ net: string; vat: string }>(
        `SELECT COALESCE(SUM(s.total_cents - s.refunded_cents), 0)::bigint::text AS net,
                COALESCE(ROUND(SUM(CASE WHEN s.total_cents > 0
                    THEN s.tax_cents::numeric * (s.total_cents - s.refunded_cents) / s.total_cents
                    ELSE 0 END)), 0)::bigint::text AS vat
           FROM sales s WHERE ${COMPLETED} AND ${inRange('s.completed_at')}`,
      ),
      q<{ sold: string; back: string; lost: string; no_cost: string }>(
        `WITH items AS (
           SELECT si.id, si.cost_cents, si.quantity_milli, si.product_id
             FROM sale_items si JOIN sales s ON s.id = si.sale_id
            WHERE ${COMPLETED} AND ${inRange('s.completed_at')}
         ), ref AS (
           SELECT ri.sale_item_id,
                  SUM(CASE WHEN r.restock THEN ri.quantity_milli ELSE 0 END) AS back_milli,
                  SUM(CASE WHEN r.restock THEN 0 ELSE ri.quantity_milli END) AS lost_milli
             FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
            GROUP BY ri.sale_item_id
         )
         SELECT COALESCE(SUM(i.cost_cents), 0)::bigint::text AS sold,
                COALESCE(ROUND(SUM(CASE WHEN i.quantity_milli > 0
                    THEN i.cost_cents::numeric * COALESCE(rf.back_milli, 0) / i.quantity_milli ELSE 0 END)), 0)::bigint::text AS back,
                COALESCE(ROUND(SUM(CASE WHEN i.quantity_milli > 0
                    THEN i.cost_cents::numeric * COALESCE(rf.lost_milli, 0) / i.quantity_milli ELSE 0 END)), 0)::bigint::text AS lost,
                COUNT(*) FILTER (WHERE i.product_id IS NOT NULL AND i.cost_cents = 0)::text AS no_cost
           FROM items i LEFT JOIN ref rf ON rf.sale_item_id = i.id`,
      ),
      q<{ key: string; label: string; n: string; amount: string }>(
        `SELECT e.category_code AS key, c.name_en AS label, count(*)::text AS n, SUM(e.amount_cents)::text AS amount
           FROM expenses e JOIN expense_categories c ON c.code = e.category_code
          WHERE e.voided_at IS NULL AND e.expense_date >= $1::date AND e.expense_date <= $2::date
          GROUP BY e.category_code, c.name_en ORDER BY SUM(e.amount_cents) DESC`,
        dates,
      ),
      q<{ key: string; n: string; amount: string; no_cost: string }>(
        `SELECT m.movement_type AS key, count(*)::text AS n,
                COALESCE(ROUND(SUM(ABS(m.quantity_milli_delta)::numeric * COALESCE(m.unit_cost_mills, 0) / 10000)), 0)::bigint::text AS amount,
                COUNT(*) FILTER (WHERE m.unit_cost_mills IS NULL)::text AS no_cost
           FROM inventory_movements m
          WHERE m.quantity_milli_delta < 0
            AND m.movement_type IN ('damaged', 'expired', 'missing', 'stock_count', 'adjustment')
            AND ${inRange('m.created_at')}
          GROUP BY m.movement_type
          ORDER BY SUM(ABS(m.quantity_milli_delta)::numeric * COALESCE(m.unit_cost_mills, 0)) DESC`,
      ),
      q<{ amount: string }>(
        `SELECT COALESCE(ROUND(SUM(pri.quantity_milli::numeric * pri.unit_cost_mills / 10000)), 0)::bigint::text AS amount
           FROM purchase_receipt_items pri JOIN purchase_receipts pr ON pr.id = pri.receipt_id
          WHERE ${inRange('pr.received_at')}`,
      ),
      q<{ key: string; amount: string }>(
        `SELECT m.movement_type AS key,
                COALESCE(ROUND(SUM(m.quantity_milli_delta::numeric * COALESCE(m.unit_cost_mills, 0) / 10000)), 0)::bigint::text AS amount
           FROM inventory_movements m
          WHERE m.quantity_milli_delta > 0 AND m.movement_type IN ('initial', 'adjustment', 'stock_count')
            AND ${inRange('m.created_at')}
          GROUP BY m.movement_type`,
      ),
      q<{ key: string; cin: string; cout: string }>(
        `SELECT cm.movement_type AS key,
                COALESCE(SUM(CASE WHEN cm.amount_cents > 0 THEN cm.amount_cents ELSE 0 END), 0)::bigint::text AS cin,
                COALESCE(SUM(CASE WHEN cm.amount_cents < 0 THEN -cm.amount_cents ELSE 0 END), 0)::bigint::text AS cout
           FROM cash_movements cm
          WHERE cm.movement_type <> 'opening' AND ${inRange('cm.created_at')}
          GROUP BY cm.movement_type ORDER BY cm.movement_type`,
      ),
      q<{ amount: string }>(
        `SELECT COALESCE(SUM(pp.amount_cents), 0)::bigint::text AS amount
           FROM purchase_payments pp WHERE ${inRange('pp.paid_at')}`,
      ),
      q<{ amount: string }>(
        `SELECT COALESCE(SUM(pu.total_cents - pu.paid_cents), 0)::bigint::text AS amount
           FROM purchases pu
          WHERE pu.status IN ('ordered', 'partially_received', 'received')
            AND pu.created_at < ($1::date + 1)::timestamp AT TIME ZONE $2`,
        [range.to, timeZone],
      ),
      q<{ n: string }>(
        `SELECT count(*)::text AS n FROM products pr
          WHERE pr.track_stock AND pr.stock_milli > 0
            AND pr.average_cost_mills = 0 AND pr.purchase_cost_mills = 0`,
        [],
      ),
    ]);

  const r = rev.rows[0]!;
  const c = cogs.rows[0]!;
  const netSalesCents = Number(r.net);
  const vatCents = Number(r.vat);
  const revenueCents = netSalesCents - vatCents;
  const costOfSalesCents = Number(c.sold) - Number(c.back);
  const grossProfitCents = revenueCents - costOfSalesCents;

  const operatingExpensesCents = exp.rows.reduce((sum, x) => sum + Number(x.amount), 0);
  const stockLossCents = loss.rows.reduce((sum, x) => sum + Number(x.amount), 0);
  const netProfitCents = grossProfitCents - operatingExpensesCents - stockLossCents;

  const invAmount = (key: string) => Number(invIn.rows.find((x) => x.key === key)?.amount ?? 0);
  const openingCents = invAmount('initial');
  const addedCents = invAmount('adjustment') + invAmount('stock_count');

  const drawerByType = drawer.rows.map((x) => ({
    type: x.key,
    inCents: Number(x.cin),
    outCents: Number(x.cout),
  }));

  return {
    range,
    revenue: { netSalesCents, vatCents, revenueCents },
    costOfSalesCents,
    refundedNotRestockedCents: Number(c.lost),
    grossProfitCents,
    grossMarginBp: bps(grossProfitCents, revenueCents),
    operatingExpensesCents,
    expensesByCategory: toBuckets(exp.rows),
    stockLossCents,
    stockLossByType: toBuckets(
      loss.rows.map((x) => ({ key: x.key, n: x.n, amount: x.amount, label: null })),
    ),
    netProfitCents,
    netMarginBp: bps(netProfitCents, revenueCents),
    stock: {
      receivedCents: Number(received.rows[0]!.amount),
      openingCents,
      addedCents,
    },
    cash: {
      drawerInCents: drawerByType.reduce((sum, x) => sum + x.inCents, 0),
      drawerOutCents: drawerByType.reduce((sum, x) => sum + x.outCents, 0),
      drawerByType,
      supplierPaidCents: Number(supplierPaid.rows[0]!.amount),
    },
    payables: { supplierBalanceCents: Number(payables.rows[0]!.amount) },
    checks: {
      productsWithoutCost: Number(productChecks.rows[0]!.n),
      saleLinesWithoutCost: Number(c.no_cost),
      lossesWithoutCost: loss.rows.reduce((sum, x) => sum + Number(x.no_cost), 0),
    },
    generatedAt: new Date().toISOString(),
  };
}

export async function spendingReport(
  pool: DbPool,
  timeZone: string,
  range: ReportRange,
): Promise<SpendingReport> {
  const p: Params = [range.from, range.to, timeZone];
  const [totals, rows] = await Promise.all([
    pool.query<{ kind: SpendingKind; n: string; amount: string }>(
      `WITH ${SPENDING_CTE} SELECT kind, count(*)::text AS n, COALESCE(SUM(amount), 0)::bigint::text AS amount
         FROM rows GROUP BY kind`,
      p,
    ),
    pool.query<SpendingDbRow & { total: string }>(
      `WITH ${SPENDING_CTE} ${SPENDING_SELECT}, (count(*) OVER ())::text AS total
         FROM rows ORDER BY at DESC, kind, reference LIMIT ${SPENDING_ROW_LIMIT}`,
      p,
    ),
  ]);
  const rowCount = rows.rows.length ? Number(rows.rows[0]!.total) : 0;
  return {
    range,
    totals: totals.rows.map((x) => ({
      kind: x.kind,
      count: Number(x.n),
      amountCents: Number(x.amount),
    })),
    rows: rows.rows.map(toSpendingRow),
    rowCount,
    truncated: rowCount > SPENDING_ROW_LIMIT,
    generatedAt: new Date().toISOString(),
  };
}

/** Every spending row in the range, for the CSV export (no row cap). */
export async function spendingRowsAll(
  pool: DbPool,
  timeZone: string,
  range: ReportRange,
): Promise<SpendingRow[]> {
  const res = await pool.query<SpendingDbRow>(
    `WITH ${SPENDING_CTE} ${SPENDING_SELECT} FROM rows ORDER BY at, kind, reference`,
    [range.from, range.to, timeZone],
  );
  return res.rows.map(toSpendingRow);
}
