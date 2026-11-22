/**
 * The first part of «Skedar për AI»: the totals. An AI that adds up thousands of rows by itself
 * makes mistakes, so the file opens with the figures the program calculated — the very ones the
 * Reports page shows, read from the same report code — and with the breakdowns an owner asks
 * about: by day, product, category, staff member, PC, payment method and hour.
 *
 * Products get two tables (0.39.1): what every product sold and earned in the period — also the
 * ones that did not sell, with zeros — and the stock of every product now, with its state in
 * words (in stock, low stock, out of stock). They are in the summary, so they are in the file
 * whatever parts were chosen, and near the top, where an AI reads first.
 *
 * The totals come from `ReportsService` (sales and profit reports); the breakdowns by day and by
 * product, which the reports do not have in full, use the same definitions:
 *   revenue = turnover − VAT; gross profit = revenue − cost of the goods sold (less the cost of
 *   refunded goods that went back on the shelf); net profit = gross profit − expenses − stock
 *   losses.
 */
import type { ProfitReport, SalesReport, StaffReport } from '@likapcs/shared';
import type { ReportsService } from '../reports.js';
import { l, type ExportDocument, type Fact, type TableSpec } from './document.js';
import { valueOf } from './labels.js';
import { DESK_TIME_SQL, stockStatus, type ExportContext, type StockStatus } from './sections.js';

const START = `($1::date)::timestamp AT TIME ZONE $3`;
const END = `($2::date + 1)::timestamp AT TIME ZONE $3`;
const inRange = (col: string) => `(${col} >= ${START} AND ${col} < ${END})`;
const COMPLETED = `s.status IN ('completed', 'partially_refunded', 'refunded')`;
/** Stock that left without a sale — the movement kinds the profit report counts as a loss. */
const LOSS_TYPES = `('damaged', 'expired', 'missing', 'stock_count', 'adjustment')`;

export interface DayRow {
  d: string;
  n: number;
  net: number;
  vat: number;
  gaming: number;
  cost: number;
  expenses: number;
  loss: number;
}

/** Turnover, cost and profit of every day that had a sale, an expense or a stock loss. */
export async function dailyFigures(ctx: ExportContext): Promise<DayRow[]> {
  const result = await ctx.db.query<DayRow>(
    `WITH s AS (
       SELECT s.id, to_char(s.completed_at AT TIME ZONE $3, 'YYYY-MM-DD') AS d,
              s.total_cents, s.refunded_cents, s.tax_cents, s.source
         FROM sales s WHERE ${COMPLETED} AND ${inRange('s.completed_at')}
     ), rev AS (
       SELECT d, count(*)::int AS n, SUM(total_cents - refunded_cents)::bigint AS net,
              COALESCE(ROUND(SUM(CASE WHEN total_cents > 0
                  THEN tax_cents::numeric * (total_cents - refunded_cents) / total_cents
                  ELSE 0 END)), 0)::bigint AS vat,
              SUM(CASE WHEN source = 'gaming' THEN total_cents - refunded_cents ELSE 0 END)::bigint AS gaming
         FROM s GROUP BY d
     ), back AS (
       SELECT ri.sale_item_id, SUM(ri.quantity_milli) AS back_milli
         FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
        WHERE r.restock GROUP BY ri.sale_item_id
     ), cogs AS (
       SELECT s.d, (SUM(si.cost_cents) - COALESCE(ROUND(SUM(CASE WHEN si.quantity_milli > 0
                  THEN si.cost_cents::numeric * COALESCE(b.back_milli, 0) / si.quantity_milli
                  ELSE 0 END)), 0))::bigint AS cost
         FROM sale_items si JOIN s ON s.id = si.sale_id
         LEFT JOIN back b ON b.sale_item_id = si.id
        GROUP BY s.d
     ), exp AS (
       SELECT to_char(e.expense_date, 'YYYY-MM-DD') AS d, SUM(e.amount_cents)::bigint AS amount
         FROM expenses e
        WHERE e.voided_at IS NULL AND e.expense_date >= $1::date AND e.expense_date <= $2::date
        GROUP BY 1
     ), loss AS (
       SELECT to_char(m.created_at AT TIME ZONE $3, 'YYYY-MM-DD') AS d,
              COALESCE(ROUND(SUM(ABS(m.quantity_milli_delta)::numeric
                  * COALESCE(m.unit_cost_mills, 0) / 10000)), 0)::bigint AS amount
         FROM inventory_movements m
        WHERE m.quantity_milli_delta < 0 AND m.movement_type IN ${LOSS_TYPES}
          AND ${inRange('m.created_at')}
        GROUP BY 1
     ), days AS (
       SELECT d FROM rev UNION SELECT d FROM exp UNION SELECT d FROM loss
     )
     SELECT days.d, COALESCE(rev.n, 0)::int AS n, COALESCE(rev.net, 0)::bigint AS net,
            COALESCE(rev.vat, 0)::bigint AS vat, COALESCE(rev.gaming, 0)::bigint AS gaming,
            COALESCE(cogs.cost, 0)::bigint AS cost, COALESCE(exp.amount, 0)::bigint AS expenses,
            COALESCE(loss.amount, 0)::bigint AS loss
       FROM days
       LEFT JOIN rev ON rev.d = days.d
       LEFT JOIN cogs ON cogs.d = days.d
       LEFT JOIN exp ON exp.d = days.d
       LEFT JOIN loss ON loss.d = days.d
      ORDER BY days.d`,
    [ctx.from, ctx.to, ctx.timeZone],
  );
  return result.rows;
}

export interface ProductFigure {
  product: string | null;
  sku: string | null;
  category: string | null;
  free_text: string | null;
  pc_time: boolean;
  desk_time: boolean;
  qty: number;
  amount: number;
  vat: number;
  cost: number;
  /** Null for a line without a product (PC time, typed text). */
  product_id: string | null;
  /** The product's category, as the sales report keys it. */
  category_id: string | null;
  /** Bills the product stands on. */
  bills: number;
  /** Quantity that came back (already taken off `qty`). */
  refunded_qty: number;
  /** Sale lines of a product that carry no cost: its profit comes out too high. */
  no_cost_lines: number;
  /** The last sale inside the period, local time. */
  last_sold: string | null;
}

/**
 * What was sold of every product: quantity and amounts after refunds, cost after the goods that
 * went back on the shelf. Lines without a product are PC time (one row) or the text of the line.
 */
export async function productFigures(ctx: ExportContext): Promise<ProductFigure[]> {
  const result = await ctx.db.query<ProductFigure>(
    `SELECT pr.name AS product, pr.sku, c.name AS category,
            CASE WHEN si.product_id IS NULL AND si.gaming_session_id IS NULL
                      AND NOT (tc.sale_item_id IS NOT NULL OR si.description ~ ${DESK_TIME_SQL})
                 THEN si.description END AS free_text,
            (si.product_id IS NULL AND si.gaming_session_id IS NOT NULL) AS pc_time,
            (si.product_id IS NULL AND si.gaming_session_id IS NULL
               AND (tc.sale_item_id IS NOT NULL OR si.description ~ ${DESK_TIME_SQL})) AS desk_time,
            SUM(si.quantity_milli - si.refunded_milli)::bigint AS qty,
            SUM(si.line_total_cents - COALESCE(rf.refunded, 0))::bigint AS amount,
            COALESCE(ROUND(SUM(CASE WHEN si.line_total_cents > 0
                THEN si.tax_cents::numeric * (si.line_total_cents - COALESCE(rf.refunded, 0))
                     / si.line_total_cents
                ELSE 0 END)), 0)::bigint AS vat,
            (SUM(si.cost_cents) - COALESCE(ROUND(SUM(CASE WHEN si.quantity_milli > 0
                THEN si.cost_cents::numeric * COALESCE(rf.back_milli, 0) / si.quantity_milli
                ELSE 0 END)), 0))::bigint AS cost,
            si.product_id::text AS product_id,
            pr.category_id::text AS category_id,
            COUNT(DISTINCT si.sale_id)::int AS bills,
            SUM(si.refunded_milli)::bigint AS refunded_qty,
            (COUNT(*) FILTER (WHERE si.product_id IS NOT NULL AND si.cost_cents = 0))::int
              AS no_cost_lines,
            to_char(MAX(s.completed_at) AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') AS last_sold
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       LEFT JOIN products pr ON pr.id = si.product_id
       LEFT JOIN categories c ON c.id = pr.category_id
       LEFT JOIN (SELECT DISTINCT sale_item_id FROM time_credits) tc ON tc.sale_item_id = si.id
       LEFT JOIN (
         SELECT ri.sale_item_id, SUM(ri.amount_cents) AS refunded,
                SUM(CASE WHEN r.restock THEN ri.quantity_milli ELSE 0 END) AS back_milli
           FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
          GROUP BY ri.sale_item_id
       ) rf ON rf.sale_item_id = si.id
      WHERE ${COMPLETED} AND ${inRange('s.completed_at')}
      GROUP BY si.product_id, pr.name, pr.sku, pr.category_id, c.name, 4, 5, 6
      ORDER BY 8 DESC, 1, 4`,
    [ctx.from, ctx.to, ctx.timeZone],
  );
  return result.rows;
}

/** A product as it is now: its price, its cost and what is on the shelf. */
export interface ProductState {
  id: string;
  name: string;
  variant: string | null;
  sku: string | null;
  category: string | null;
  price_mills: number;
  /** Average cost of a unit. */
  cost_mills: number;
  stock_milli: number;
  min_stock_milli: number;
  track_stock: boolean;
  is_active: boolean;
  unit_code: string;
}

export async function productStates(ctx: ExportContext): Promise<ProductState[]> {
  const result = await ctx.db.query<ProductState>(
    `SELECT p.id::text AS id, p.name, p.variant_label AS variant, p.sku, c.name AS category,
            p.selling_price_mills AS price_mills, p.average_cost_mills AS cost_mills,
            p.stock_milli, p.min_stock_milli, p.track_stock, p.is_active, p.unit_code
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
      ORDER BY p.name, p.id`,
  );
  // The database orders by byte ("Çips" after "Ujë"); a reader looks for it after "Coca-Cola".
  const collator = new Intl.Collator(ctx.lang === 'sq' ? 'sq' : 'en', {
    sensitivity: 'base',
    numeric: true,
  });
  return result.rows.sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1));
}

/** One row of «Sipas produktit»: what was sold in the period, and the product as it is now. */
export interface ProductLine extends ProductFigure {
  state: ProductState | null;
}

/**
 * Every product gets its row: the ones sold in the period first (as the figures are ordered,
 * most turnover first), then every active product that did not sell, with zeros, by name — so
 * "what did X sell?" always has an answer, and so has "what does not sell?". Lines without a
 * product (PC time, typed text) stay as they are.
 */
export function productLines(figures: ProductFigure[], states: ProductState[]): ProductLine[] {
  const byId = new Map(states.map((state) => [state.id, state] as const));
  const sold = new Set<string>();
  const lines: ProductLine[] = figures.map((figure) => {
    if (figure.product_id) sold.add(figure.product_id);
    return { ...figure, state: figure.product_id ? (byId.get(figure.product_id) ?? null) : null };
  });
  for (const state of states) {
    if (!state.is_active || sold.has(state.id)) continue;
    lines.push({
      product: state.name,
      sku: state.sku,
      category: state.category,
      free_text: null,
      pc_time: false,
      desk_time: false,
      qty: 0,
      amount: 0,
      vat: 0,
      cost: 0,
      product_id: state.id,
      category_id: null,
      bills: 0,
      refunded_qty: 0,
      no_cost_lines: 0,
      last_sold: null,
      state,
    });
  }
  return lines;
}

/** One row of «Stoku tani sipas produktit». */
export interface StockLine {
  state: ProductState;
  status: StockStatus;
  /** Sold in the period, after refunds. */
  soldQty: number;
  /** Stock × average cost and stock × selling price, in cents; null when stock is not counted. */
  costValue: number | null;
  saleValue: number | null;
}

const STATUS_ORDER: readonly StockStatus[] = ['out', 'low', 'in', 'untracked'];

/**
 * The stock of every product now: every active product, and the inactive ones that still have
 * goods on the shelf (they count in the stock value). What is out of stock comes first, then
 * low stock, then the rest, then the products whose stock is not counted; by name inside each.
 */
export function stockLines(states: ProductState[], figures: ProductFigure[]): StockLine[] {
  const soldById = new Map<string, number>();
  for (const figure of figures) {
    if (!figure.product_id) continue;
    soldById.set(figure.product_id, (soldById.get(figure.product_id) ?? 0) + figure.qty);
  }
  const valueOfStock = (state: ProductState, mills: number): number | null => {
    if (!state.track_stock) return null;
    // Stock below zero (sold before it was received) is worth nothing, not a negative amount.
    return state.stock_milli > 0 ? Math.round((state.stock_milli * mills) / 10_000) : 0;
  };
  return (
    states
      .filter((state) => state.is_active || (state.track_stock && state.stock_milli > 0))
      .map((state) => ({
        state,
        status: stockStatus(state),
        soldQty: soldById.get(state.id) ?? 0,
        costValue: valueOfStock(state, state.cost_mills),
        saleValue: valueOfStock(state, state.price_mills),
      }))
      // The states come ordered by name and the sort is stable: by name inside each state.
      .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
  );
}

/**
 * The products of «Gjendja tani», counted from the rows of the stock table. The states are of
 * the active products and add up to them (in stock + out of stock + not tracked = active); the
 * inactive ones that still have goods are counted apart. The values are of every row.
 */
export interface StockCounts {
  active: number;
  /** Active, with something on the shelf: `low` is part of it. */
  inStock: number;
  low: number;
  out: number;
  untracked: number;
  inactiveWithStock: number;
  costCents: number;
  saleCents: number;
}

export function stockCounts(lines: StockLine[]): StockCounts {
  const active = lines.filter((line) => line.state.is_active);
  const of = (status: StockStatus) => active.filter((line) => line.status === status).length;
  return {
    active: active.length,
    inStock: of('in') + of('low'),
    low: of('low'),
    out: of('out'),
    untracked: of('untracked'),
    inactiveWithStock: lines.length - active.length,
    costCents: lines.reduce((sum, line) => sum + (line.costValue ?? 0), 0),
    saleCents: lines.reduce((sum, line) => sum + (line.saleValue ?? 0), 0),
  };
}

/** Share of `whole` in basis points, as the profit report gives its margins. */
const bps = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part * 10_000) / whole) : null;

interface NowFigures {
  customers: number;
  walletCents: number;
  openDebts: number;
  openDebtCents: number;
  creditMinutes: number;
  runningSessions: number;
  openShifts: number;
  drawerCents: number;
}

async function nowFigures(ctx: ExportContext): Promise<NowFigures> {
  const one = async <R extends object>(sql: string): Promise<R> =>
    (await ctx.db.query<R>(sql)).rows[0]!;
  const c = await one<{ n: number; wallet: number }>(
    `SELECT count(*)::int AS n, COALESCE(SUM(wallet_balance_cents), 0)::bigint AS wallet
       FROM customers WHERE status <> 'archived'`,
  );
  const d = await one<{ n: number; open: number }>(
    `SELECT count(*)::int AS n, COALESCE(SUM(amount_cents - paid_cents), 0)::bigint AS open
       FROM customer_debts WHERE status IN ('open', 'partial')`,
  );
  const t = await one<{ minutes: number }>(
    `SELECT COALESCE(SUM(minutes_remaining), 0)::int AS minutes
       FROM time_credits WHERE cancelled_at IS NULL AND minutes_remaining > 0`,
  );
  const g = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM gaming_sessions WHERE status IN ('active', 'paused')`,
  );
  const s = await one<{ n: number; expected: number }>(
    `SELECT count(*)::int AS n,
            COALESCE(SUM(cs.opening_cents + COALESCE((SELECT SUM(m.amount_cents) FROM cash_movements m
                WHERE m.shift_id = cs.id AND m.movement_type <> 'opening'), 0)), 0)::bigint AS expected
       FROM cash_shifts cs WHERE cs.status = 'open'`,
  );
  return {
    customers: c.n,
    walletCents: c.wallet,
    openDebts: d.n,
    openDebtCents: d.open,
    creditMinutes: t.minutes,
    runningSessions: g.n,
    openShifts: s.n,
    drawerCents: s.expected,
  };
}

/** The figures of the period as the file states them (also what the tests compare with the reports). */
export function totalFacts(sales: SalesReport, profit: ProfitReport): Fact[] {
  return [
    {
      label: l('Fatura (numri i shitjeve)', 'Bills (number of sales)'),
      kind: 'int',
      value: sales.sales.count,
    },
    {
      label: l('Qarkullimi para kthimeve (me TVSH)', 'Turnover before refunds (VAT included)'),
      kind: 'money',
      value: sales.sales.grossCents,
    },
    {
      label: l('Kthime (shuma)', 'Refunds (amount)'),
      kind: 'money',
      value: sales.sales.refundedCents,
    },
    {
      label: l('Kthime (numri)', 'Refunds (number)'),
      kind: 'int',
      value: sales.sales.refundsCount,
    },
    {
      label: l('Qarkullimi (me TVSH, pas kthimeve)', 'Turnover (VAT included, after refunds)'),
      kind: 'money',
      value: profit.revenue.netSalesCents,
    },
    {
      label: l('TVSH brenda qarkullimit', 'VAT inside the turnover'),
      kind: 'money',
      value: profit.revenue.vatCents,
    },
    {
      label: l('Të ardhura (pa TVSH)', 'Revenue (without VAT)'),
      kind: 'money',
      value: profit.revenue.revenueCents,
    },
    {
      label: l('Kosto e mallit të shitur', 'Cost of the goods sold'),
      kind: 'money',
      value: profit.costOfSalesCents,
    },
    { label: l('Fitimi bruto', 'Gross profit'), kind: 'money', value: profit.grossProfitCents },
    { label: l('Marzhi bruto', 'Gross margin'), kind: 'percent', value: profit.grossMarginBp },
    {
      label: l('Shpenzimet operative', 'Operating expenses'),
      kind: 'money',
      value: profit.operatingExpensesCents,
    },
    { label: l('Humbjet e stokut', 'Stock losses'), kind: 'money', value: profit.stockLossCents },
    { label: l('Fitimi neto', 'Net profit'), kind: 'money', value: profit.netProfitCents },
    { label: l('Marzhi neto', 'Net margin'), kind: 'percent', value: profit.netMarginBp },
    {
      label: l('Zbritje të dhëna mbi fatura', 'Discounts given on whole bills'),
      kind: 'money',
      value: sales.sales.discountCents,
    },
    {
      label: l('Mesatarja e shitjes', 'Average sale'),
      kind: 'money',
      value: sales.sales.averageCents,
    },
    {
      label: l('Seanca PC të paguara', 'PC sessions paid'),
      kind: 'int',
      value: sales.gaming.sessionsCount,
    },
    {
      label: l('Minuta PC të faturuara', 'PC minutes charged'),
      kind: 'int',
      value: sales.gaming.billedMinutes,
    },
    {
      label: l('Të ardhura nga koha në PC (seancat)', 'Income from PC time (sessions)'),
      kind: 'money',
      value: sales.gaming.amountCents,
    },
    {
      label: l('Hyrje në arkë (para në dorë)', 'Cash into the drawer'),
      kind: 'money',
      value: profit.cash.drawerInCents,
    },
    {
      label: l('Dalje nga arka (para në dorë)', 'Cash out of the drawer'),
      kind: 'money',
      value: profit.cash.drawerOutCents,
    },
    {
      label: l('Turne të arkës në periudhë', 'Till shifts in the period'),
      kind: 'int',
      value: sales.cash.shiftsCount,
    },
    {
      label: l(
        'Diferenca e numërimit të arkës (minus = mungesë)',
        'Till count difference (minus = short)',
      ),
      kind: 'money',
      value: sales.cash.differenceCents,
    },
    {
      label: l('Mall i pranuar nga furnitorët (vlera)', 'Goods received from suppliers (value)'),
      kind: 'money',
      value: profit.stock.receivedCents,
    },
    {
      label: l('Paguar furnitorëve', 'Paid to suppliers'),
      kind: 'money',
      value: profit.cash.supplierPaidCents,
    },
    {
      label: l(
        'Borxhi ndaj furnitorëve në fund të periudhës',
        'Owed to suppliers at the end of the period',
      ),
      kind: 'money',
      value: profit.payables.supplierBalanceCents,
    },
    {
      label: l(
        'Kujdes: produkte me stok por pa kosto (fitimi del më i lartë se i vërteti)',
        'Warning: products in stock without a cost (profit comes out higher than it is)',
      ),
      kind: 'int',
      value: profit.checks.productsWithoutCost || null,
    },
    {
      label: l('Kujdes: artikuj të shitur pa kosto', 'Warning: sale lines without a cost'),
      kind: 'int',
      value: profit.checks.saleLinesWithoutCost || null,
    },
    {
      label: l('Kujdes: humbje stoku pa kosto', 'Warning: stock losses without a cost'),
      kind: 'int',
      value: profit.checks.lossesWithoutCost || null,
    },
  ];
}

/** Writes the whole summary. `reports` must read through the same snapshot as `ctx.db`. */
export async function writeSummary(
  ctx: ExportContext,
  doc: ExportDocument,
  reports: ReportsService,
): Promise<{ sales: SalesReport; profit: ProfitReport }> {
  const { lang } = ctx;
  const range = { from: ctx.from, to: ctx.to };
  const sales = await reports.sales(range);
  const profit = await reports.profit(range);
  const staff: StaffReport = await reports.staff(range);
  const days = await dailyFigures(ctx);
  const figures = await productFigures(ctx);
  const states = await productStates(ctx);
  const byProduct = productLines(figures, states);
  const stock = stockLines(states, figures);
  const counts = stockCounts(stock);
  const now = await nowFigures(ctx);
  const categories = await ctx.db.query<{ code: string; name_sq: string; name_en: string }>(
    'SELECT code, name_sq, name_en FROM expense_categories',
  );
  const expenseName = new Map(
    categories.rows.map((c) => [c.code, lang === 'sq' ? c.name_sq : c.name_en] as const),
  );

  await doc.beginGroup(l('Përmbledhje', 'Summary'));
  await doc.facts(l('Totalet e periudhës', 'Totals of the period'), totalFacts(sales, profit));

  const daySpec: TableSpec<DayRow> = {
    title: l('Sipas ditës', 'By day'),
    note: l(
      'Fitimi bruto = qarkullimi − TVSH − kosto. Fitimi neto = fitimi bruto − shpenzime − humbje stoku. «Vetëm PC» janë faturat që kanë vetëm kohë në PC.',
      'Gross profit = turnover − VAT − cost. Net profit = gross profit − expenses − stock losses. "PC only" are the bills that hold PC time only.',
    ),
    columns: [
      { label: l('Data', 'Date'), get: (r) => r.d },
      { label: l('Fatura', 'Bills'), kind: 'int', get: (r) => r.n },
      { label: l('Qarkullimi', 'Turnover'), kind: 'money', get: (r) => r.net },
      { label: l('Vetëm PC', 'PC only'), kind: 'money', get: (r) => r.gaming },
      {
        label: l('Dyqan dhe të përziera', 'Shop and mixed'),
        kind: 'money',
        get: (r) => r.net - r.gaming,
      },
      { label: l('TVSH', 'VAT'), kind: 'money', get: (r) => r.vat },
      { label: l('Kosto', 'Cost'), kind: 'money', get: (r) => r.cost },
      {
        label: l('Fitimi bruto', 'Gross profit'),
        kind: 'money',
        get: (r) => r.net - r.vat - r.cost,
      },
      { label: l('Shpenzime', 'Expenses'), kind: 'money', get: (r) => r.expenses },
      { label: l('Humbje stoku', 'Stock losses'), kind: 'money', get: (r) => r.loss },
      {
        label: l('Fitimi neto', 'Net profit'),
        kind: 'money',
        get: (r) => r.net - r.vat - r.cost - r.expenses - r.loss,
      },
    ],
  };
  await doc.table(daySpec, [days]);

  // Lines without a product: PC time of a session, PC time sold at the desk (its text can end
  // with the buyer's name, so the rows are one), or whatever the line says.
  const pcTime = l('Kohë në PC (seanca)', 'PC time (sessions)');
  const deskTime = l('Kohë PC e shitur në banak', 'PC time sold at the desk');
  const grossProfit = (r: ProductLine): number => r.amount - r.vat - r.cost;
  const productSpec: TableSpec<ProductLine> = {
    title: l('Sipas produktit', 'By product'),
    note: l(
      'Shitja dhe fitimi i çdo produkti në periudhë. Çdo produkt aktiv është në listë: ai që nuk u shit ka sasinë 0. Sasia dhe shumat janë pas kthimeve, para zbritjeve mbi gjithë faturën. Fitimi bruto = qarkullimi − TVSH − kosto; marzhi bruto = fitimi bruto ÷ (qarkullimi − TVSH). «Stoku tani» është i çastit kur u bë skedari, jo i fundit të periudhës.',
      'The sales and the profit of every product in the period. Every active product is listed: one that did not sell has the quantity 0. Quantity and amounts are after refunds, before discounts on a whole bill. Gross profit = turnover − VAT − cost; gross margin = gross profit ÷ (turnover − VAT). "Stock now" is that of the moment the file was made, not of the end of the period.',
    ),
    columns: [
      {
        label: l('Produkti', 'Product'),
        get: (r) =>
          r.product ?? (r.pc_time ? pcTime[lang] : r.desk_time ? deskTime[lang] : r.free_text),
      },
      { label: l('Kategoria', 'Category'), get: (r) => r.category },
      { label: l('Sasia', 'Qty'), kind: 'qty', get: (r) => r.qty },
      { label: l('Fatura', 'Bills'), kind: 'int', get: (r) => r.bills },
      { label: l('Qarkullimi', 'Turnover'), kind: 'money', get: (r) => r.amount },
      { label: l('TVSH', 'VAT'), kind: 'money', get: (r) => r.vat },
      { label: l('Kosto', 'Cost'), kind: 'money', get: (r) => r.cost },
      { label: l('Fitimi bruto', 'Gross profit'), kind: 'money', get: grossProfit },
      {
        label: l('Marzhi bruto', 'Gross margin'),
        kind: 'percent',
        get: (r) => bps(grossProfit(r), r.amount - r.vat),
      },
      {
        label: l('Stoku tani', 'Stock now'),
        kind: 'qty',
        get: (r) => (r.state?.track_stock ? r.state.stock_milli : null),
      },
      {
        label: l('Gjendja e stokut', 'Stock state'),
        optional: true,
        get: (r) => (r.state ? valueOf('stockStatus', stockStatus(r.state), lang) : null),
      },
      {
        label: l('Fitimi për njësi', 'Profit per unit'),
        kind: 'money',
        optional: true,
        // Of a product only: a "unit" of PC time is a bill, not something with a profit each.
        get: (r) => (r.state && r.qty > 0 ? Math.round(grossProfit(r) / (r.qty / 1000)) : null),
      },
      {
        label: l('Sasia e kthyer', 'Qty returned'),
        kind: 'qty',
        optional: true,
        get: (r) => (r.refunded_qty > 0 ? r.refunded_qty : null),
      },
      {
        label: l('Shitja e fundit në periudhë', 'Last sale in the period'),
        optional: true,
        get: (r) => r.last_sold,
      },
      {
        label: l(
          'Kujdes: rreshta shitjesh pa kosto (fitimi del më i lartë)',
          'Warning: sale lines without a cost (the profit comes out too high)',
        ),
        kind: 'int',
        optional: true,
        get: (r) => (r.no_cost_lines > 0 ? r.no_cost_lines : null),
      },
      { label: l('Varianti', 'Variant'), optional: true, get: (r) => r.state?.variant },
      { label: l('SKU', 'SKU'), optional: true, get: (r) => r.sku },
      {
        label: l('Joaktiv', 'Inactive'),
        kind: 'bool',
        optional: true,
        get: (r) => (r.state && !r.state.is_active ? true : null),
      },
    ],
  };
  await doc.table(productSpec, [byProduct]);

  const stockSpec: TableSpec<StockLine> = {
    title: l('Stoku tani sipas produktit', 'Stock now by product'),
    note: l(
      'Gjendja e çdo produkti aktiv në çastin kur u bë skedari (dhe e atyre joaktive që kanë ende mall). Së pari produktet pa stok, pastaj me stok të ulët, pastaj ato me stok, në fund ato ku stoku nuk ndiqet. «Pa stok» = s’ka mbetur asgjë; «Stok i ulët» = ka, por jo më shumë se stoku minimal i produktit (faqja Produktet i numëron të dyja si stok të ulët); «Stoku nuk ndiqet» = te produkti është fikur «Ndiq stokun», prandaj programi nuk e di sa ka. Vlera = stoku × kostoja mesatare, ose × çmimi i shitjes.',
      'Every active product at the moment the file was made (and the inactive ones that still have goods). First the products out of stock, then low stock, then those in stock, last those whose stock is not tracked. "Out of stock" = nothing left; "Low stock" = some left, but not more than the product\'s minimum stock (the Products page counts both as low stock); "Stock not tracked" = "Track stock" is switched off on the product, so the program does not know how much there is. Value = stock × average cost, or × selling price.',
    ),
    columns: [
      { label: l('Produkti', 'Product'), get: (r) => r.state.name },
      { label: l('Kategoria', 'Category'), get: (r) => r.state.category },
      {
        label: l('Gjendja e stokut', 'Stock state'),
        get: (r) => valueOf('stockStatus', r.status, lang),
      },
      {
        label: l('Stoku', 'Stock'),
        kind: 'qty',
        get: (r) => (r.state.track_stock ? r.state.stock_milli : null),
      },
      {
        label: l('Stoku minimal', 'Minimum stock'),
        kind: 'qty',
        get: (r) => (r.state.track_stock ? r.state.min_stock_milli : null),
      },
      { label: l('Shitur në periudhë', 'Sold in the period'), kind: 'qty', get: (r) => r.soldQty },
      { label: l('Kosto mesatare', 'Average cost'), kind: 'mills', get: (r) => r.state.cost_mills },
      {
        label: l('Vlera e stokut me kosto', 'Stock value at cost'),
        kind: 'money',
        get: (r) => r.costValue,
      },
      { label: l('Çmimi', 'Price'), kind: 'mills', get: (r) => r.state.price_mills },
      {
        label: l('Vlera e stokut me çmim shitjeje', 'Stock value at selling price'),
        kind: 'money',
        get: (r) => r.saleValue,
      },
      { label: l('Varianti', 'Variant'), optional: true, get: (r) => r.state.variant },
      { label: l('SKU', 'SKU'), optional: true, get: (r) => r.state.sku },
      {
        label: l('Njësia', 'Unit'),
        optional: true,
        get: (r) => (r.state.unit_code === 'pc' ? null : r.state.unit_code),
      },
      {
        label: l('Joaktiv', 'Inactive'),
        kind: 'bool',
        optional: true,
        get: (r) => (r.state.is_active ? null : true),
      },
    ],
  };
  await doc.table(stockSpec, [stock]);

  // By category: the rows of the sales report, and next to each what its products cost and
  // earned — the sums of «Sipas produktit», so the two tables agree to the cent.
  const categoryParts = new Map<string, { vat: number; cost: number }>();
  for (const figure of figures) {
    if (!figure.product_id) continue;
    const key = figure.category_id ?? 'none';
    const part = categoryParts.get(key) ?? { vat: 0, cost: 0 };
    part.vat += figure.vat;
    part.cost += figure.cost;
    categoryParts.set(key, part);
  }
  type CategoryRow = SalesReport['byCategory'][number];
  const categoryProfit = (r: CategoryRow): number | null => {
    const part = categoryParts.get(r.key);
    return part ? r.amountCents - part.vat - part.cost : null;
  };
  await doc.table<CategoryRow>(
    {
      title: l('Sipas kategorisë', 'By category'),
      note: l(
        'Vetëm produktet (koha në PC nuk ka kategori). Shifrat janë shuma e produkteve të kategorisë te «Sipas produktit».',
        'Products only (PC time has no category). The figures are the sum of the category\'s products in "By product".',
      ),
      columns: [
        {
          label: l('Kategoria', 'Category'),
          get: (r) => r.label ?? (lang === 'sq' ? '(pa kategori)' : '(no category)'),
        },
        { label: l('Rreshta shitjesh', 'Sale lines'), kind: 'int', get: (r) => r.count },
        { label: l('Qarkullimi', 'Turnover'), kind: 'money', get: (r) => r.amountCents },
        { label: l('TVSH', 'VAT'), kind: 'money', get: (r) => categoryParts.get(r.key)?.vat },
        { label: l('Kosto', 'Cost'), kind: 'money', get: (r) => categoryParts.get(r.key)?.cost },
        { label: l('Fitimi bruto', 'Gross profit'), kind: 'money', get: categoryProfit },
        {
          label: l('Marzhi bruto', 'Gross margin'),
          kind: 'percent',
          get: (r) => {
            const part = categoryParts.get(r.key);
            const profit = categoryProfit(r);
            return part && profit !== null ? bps(profit, r.amountCents - part.vat) : null;
          },
        },
      ],
    },
    [sales.byCategory],
  );

  // Staff: what each one sold (sales report) next to the hours and shifts (staff report).
  const staffById = new Map(staff.staff.map((s) => [s.userId, s] as const));
  const seen = new Set<string>();
  const staffRows = sales.byEmployee.map((e) => {
    seen.add(e.key);
    const s = staffById.get(e.key);
    return {
      name: e.label ?? s?.name ?? e.key,
      sales: e.count,
      amount: e.amountCents,
      minutes: s?.workedMinutes ?? null,
      shifts: s?.shiftsCount ?? null,
      refunds: s?.refundsCount ?? null,
      difference: s?.cashDifferenceCents ?? null,
    };
  });
  for (const s of staff.staff) {
    if (seen.has(s.userId)) continue;
    staffRows.push({
      name: s.name,
      sales: s.salesCount,
      amount: s.salesCents,
      minutes: s.workedMinutes,
      shifts: s.shiftsCount,
      refunds: s.refundsCount,
      difference: s.cashDifferenceCents,
    });
  }
  await doc.table<(typeof staffRows)[number]>(
    {
      title: l('Sipas punonjësit', 'By staff member'),
      note: l(
        'Orët e punës llogariten nga turnet e arkës. Diferenca e arkës është e turneve që i hapi vetë.',
        'Hours worked come from the till shifts. The till difference is of the shifts the person opened.',
      ),
      columns: [
        { label: l('Punonjësi', 'Staff member'), get: (r) => r.name },
        { label: l('Fatura', 'Bills'), kind: 'int', get: (r) => r.sales },
        { label: l('Qarkullimi', 'Turnover'), kind: 'money', get: (r) => r.amount },
        {
          label: l('Orë pune', 'Hours worked'),
          get: (r) => (r.minutes === null ? null : (r.minutes / 60).toFixed(1)),
        },
        { label: l('Turne', 'Shifts'), kind: 'int', get: (r) => r.shifts },
        {
          label: l('Fatura me kthim', 'Bills with a refund'),
          kind: 'int',
          optional: true,
          get: (r) => r.refunds || null,
        },
        {
          label: l('Diferenca e arkës', 'Till difference'),
          kind: 'money',
          optional: true,
          get: (r) => r.difference || null,
        },
      ],
    },
    [staffRows],
  );

  await doc.table<SalesReport['gaming']['byStation'][number]>(
    {
      title: l('Sipas PC-së', 'By PC'),
      note: l(
        'Seancat e paguara në periudhë: sa herë u përdor PC-ja, sa minuta dhe sa para solli koha.',
        'Sessions paid in the period: how often the PC was used, for how many minutes, and what the time brought in.',
      ),
      columns: [
        { label: l('PC', 'PC'), get: (r) => r.code },
        { label: l('Seanca', 'Sessions'), kind: 'int', get: (r) => r.sessions },
        { label: l('Minuta', 'Minutes'), kind: 'int', get: (r) => r.minutes },
        { label: l('Të ardhura', 'Income'), kind: 'money', get: (r) => r.amountCents },
      ],
    },
    [sales.gaming.byStation],
  );

  await doc.table<SalesReport['byMethod'][number]>(
    {
      title: l('Sipas mënyrës së pagesës', 'By payment method'),
      note: l(
        'Para të marra, pas kthimeve. Paratë në dorë janë pa kusurin.',
        'Money taken, after refunds. Cash is without the change given back.',
      ),
      columns: [
        { label: l('Mënyra', 'Method'), get: (r) => valueOf('method', r.key, lang) },
        { label: l('Pagesa', 'Payments'), kind: 'int', get: (r) => r.count },
        { label: l('Shuma', 'Amount'), kind: 'money', get: (r) => r.amountCents },
      ],
    },
    [sales.byMethod],
  );

  await doc.table<SalesReport['bySource'][number]>(
    {
      title: l('Sipas burimit', 'By source'),
      note: l(
        'Dyqan = vetëm produkte; Lojëra = vetëm kohë në PC; Përzier = të dyja në një faturë.',
        'Shop = products only; Gaming = PC time only; Mixed = both on one bill.',
      ),
      columns: [
        { label: l('Burimi', 'Source'), get: (r) => valueOf('saleSource', r.key, lang) },
        { label: l('Fatura', 'Bills'), kind: 'int', get: (r) => r.count },
        { label: l('Qarkullimi', 'Turnover'), kind: 'money', get: (r) => r.amountCents },
      ],
    },
    [sales.bySource],
  );

  await doc.table<SalesReport['byHour'][number]>(
    {
      title: l('Sipas orës së ditës', 'By hour of the day'),
      columns: [
        { label: l('Ora', 'Hour'), get: (r) => `${String(r.hour).padStart(2, '0')}:00` },
        { label: l('Fatura', 'Bills'), kind: 'int', get: (r) => r.count },
        { label: l('Qarkullimi', 'Turnover'), kind: 'money', get: (r) => r.amountCents },
      ],
    },
    [sales.byHour],
  );

  await doc.table<ProfitReport['expensesByCategory'][number]>(
    {
      title: l('Shpenzimet sipas kategorisë', 'Expenses by category'),
      columns: [
        {
          label: l('Kategoria', 'Category'),
          get: (r) => expenseName.get(r.key) ?? r.label ?? r.key,
        },
        { label: l('Shpenzime', 'Expenses'), kind: 'int', get: (r) => r.count },
        { label: l('Shuma', 'Amount'), kind: 'money', get: (r) => r.amountCents },
      ],
    },
    [profit.expensesByCategory],
  );

  await doc.table<ProfitReport['stockLossByType'][number]>(
    {
      title: l('Humbjet e stokut sipas llojit', 'Stock losses by kind'),
      columns: [
        { label: l('Lloji', 'Kind'), get: (r) => valueOf('stockMovement', r.key, lang) },
        { label: l('Lëvizje', 'Movements'), kind: 'int', get: (r) => r.count },
        { label: l('Vlera', 'Value'), kind: 'money', get: (r) => r.amountCents },
      ],
    },
    [profit.stockLossByType],
  );

  await doc.table<ProfitReport['cash']['drawerByType'][number]>(
    {
      title: l('Arka sipas llojit të lëvizjes', 'The drawer by kind of movement'),
      columns: [
        { label: l('Lloji', 'Kind'), get: (r) => valueOf('cashMovement', r.type, lang) },
        { label: l('Hyrje', 'In'), kind: 'money', get: (r) => r.inCents },
        { label: l('Dalje', 'Out'), kind: 'money', get: (r) => r.outCents },
      ],
    },
    [profit.cash.drawerByType],
  );

  await doc.facts(l('Gjendja tani', 'Now'), [
    { label: l('Produkte aktive', 'Active products'), kind: 'int', value: counts.active },
    {
      label: l(
        'Aktive me stok (bashkë me ato me stok të ulët)',
        'Active, in stock (with those low on stock)',
      ),
      kind: 'int',
      value: counts.inStock,
    },
    {
      label: l('Aktive me stok të ulët', 'Active, low on stock'),
      kind: 'int',
      value: counts.low,
    },
    { label: l('Aktive pa stok', 'Active, out of stock'), kind: 'int', value: counts.out },
    {
      label: l('Aktive ku stoku nuk ndiqet', 'Active, stock not tracked'),
      kind: 'int',
      value: counts.untracked,
    },
    {
      label: l('Joaktive që kanë ende stok', 'Inactive, still with stock'),
      kind: 'int',
      value: counts.inactiveWithStock || null,
    },
    {
      label: l('Vlera e stokut me kosto', 'Stock value at cost'),
      kind: 'money',
      value: counts.costCents,
    },
    {
      label: l('Vlera e stokut me çmim shitjeje', 'Stock value at selling price'),
      kind: 'money',
      value: counts.saleCents,
    },
    {
      label: l('Klientë të regjistruar', 'Registered customers'),
      kind: 'int',
      value: now.customers,
    },
    {
      label: l(
        'Para të klientëve në balancë (ua kemi borxh)',
        "Customers' money on balance (we owe it)",
      ),
      kind: 'money',
      value: now.walletCents,
    },
    {
      label: l('Borxhe të hapura të klientëve (numri)', 'Open customer debts (number)'),
      kind: 'int',
      value: now.openDebts,
    },
    {
      label: l('Borxhe të hapura të klientëve (shuma)', 'Open customer debts (amount)'),
      kind: 'money',
      value: now.openDebtCents,
    },
    {
      label: l(
        'Minuta PC të paguara e ende të papërdorura',
        'PC minutes paid for and not used yet',
      ),
      kind: 'int',
      value: now.creditMinutes,
    },
    {
      label: l('Seanca që po ecin tani', 'Sessions running now'),
      kind: 'int',
      value: now.runningSessions,
    },
    {
      label: l('Turne të hapura të arkës', 'Open till shifts'),
      kind: 'int',
      value: now.openShifts,
    },
    {
      label: l('Para që duhet të jenë në arkë tani', 'Cash that should be in the drawer now'),
      kind: 'money',
      value: now.openShifts > 0 ? now.drawerCents : null,
    },
  ]);
  await doc.endGroup();
  return { sales, profit };
}
