/**
 * The first part of «Skedar për AI»: the totals. An AI that adds up thousands of rows by itself
 * makes mistakes, so the file opens with the figures the program calculated — the very ones the
 * Reports page shows, read from the same report code — and with the breakdowns an owner asks
 * about: by day, product, category, staff member, PC, payment method and hour.
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
import { DESK_TIME_SQL, type ExportContext } from './sections.js';

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
                ELSE 0 END)), 0))::bigint AS cost
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
      GROUP BY si.product_id, pr.name, pr.sku, c.name, 4, 5, 6
      ORDER BY 8 DESC, 1, 4`,
    [ctx.from, ctx.to, ctx.timeZone],
  );
  return result.rows;
}

interface NowFigures {
  productsActive: number;
  stockCostCents: number;
  stockSaleCents: number;
  outOfStock: number;
  belowMinimum: number;
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
  const p = await one<{
    active: number;
    cost_value: number;
    sale_value: number;
    out_of_stock: number;
    below_min: number;
  }>(
    `SELECT count(*) FILTER (WHERE is_active)::int AS active,
            COALESCE(ROUND(SUM(CASE WHEN track_stock AND stock_milli > 0
                THEN stock_milli::numeric * average_cost_mills / 10000 ELSE 0 END)), 0)::bigint AS cost_value,
            COALESCE(ROUND(SUM(CASE WHEN track_stock AND stock_milli > 0
                THEN stock_milli::numeric * selling_price_mills / 10000 ELSE 0 END)), 0)::bigint AS sale_value,
            count(*) FILTER (WHERE is_active AND track_stock AND stock_milli <= 0)::int AS out_of_stock,
            count(*) FILTER (WHERE is_active AND track_stock AND min_stock_milli > 0
                              AND stock_milli < min_stock_milli)::int AS below_min
       FROM products`,
  );
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
    productsActive: p.active,
    stockCostCents: p.cost_value,
    stockSaleCents: p.sale_value,
    outOfStock: p.out_of_stock,
    belowMinimum: p.below_min,
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
  const byProduct = await productFigures(ctx);
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
  const productSpec: TableSpec<ProductFigure> = {
    title: l('Sipas produktit', 'By product'),
    note: l(
      'Sasia dhe shumat janë pas kthimeve, para zbritjeve mbi gjithë faturën. Fitimi bruto = qarkullimi − TVSH − kosto.',
      'Quantity and amounts are after refunds, before discounts on a whole bill. Gross profit = turnover − VAT − cost.',
    ),
    columns: [
      {
        label: l('Produkti', 'Product'),
        get: (r) =>
          r.product ?? (r.pc_time ? pcTime[lang] : r.desk_time ? deskTime[lang] : r.free_text),
      },
      { label: l('Kategoria', 'Category'), get: (r) => r.category },
      { label: l('Sasia', 'Qty'), kind: 'qty', get: (r) => r.qty },
      { label: l('Qarkullimi', 'Turnover'), kind: 'money', get: (r) => r.amount },
      { label: l('TVSH', 'VAT'), kind: 'money', get: (r) => r.vat },
      { label: l('Kosto', 'Cost'), kind: 'money', get: (r) => r.cost },
      {
        label: l('Fitimi bruto', 'Gross profit'),
        kind: 'money',
        get: (r) => r.amount - r.vat - r.cost,
      },
      { label: l('SKU', 'SKU'), optional: true, get: (r) => r.sku },
    ],
  };
  await doc.table(productSpec, [byProduct]);

  await doc.table<SalesReport['byCategory'][number]>(
    {
      title: l('Sipas kategorisë', 'By category'),
      columns: [
        {
          label: l('Kategoria', 'Category'),
          get: (r) => r.label ?? (lang === 'sq' ? '(pa kategori)' : '(no category)'),
        },
        { label: l('Rreshta shitjesh', 'Sale lines'), kind: 'int', get: (r) => r.count },
        { label: l('Qarkullimi', 'Turnover'), kind: 'money', get: (r) => r.amountCents },
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
    { label: l('Produkte aktive', 'Active products'), kind: 'int', value: now.productsActive },
    {
      label: l('Vlera e stokut me kosto', 'Stock value at cost'),
      kind: 'money',
      value: now.stockCostCents,
    },
    {
      label: l('Vlera e stokut me çmim shitjeje', 'Stock value at selling price'),
      kind: 'money',
      value: now.stockSaleCents,
    },
    { label: l('Produkte pa stok', 'Products out of stock'), kind: 'int', value: now.outOfStock },
    {
      label: l('Produkte nën stokun minimal', 'Products below their minimum stock'),
      kind: 'int',
      value: now.belowMinimum,
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
