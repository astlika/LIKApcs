/**
 * The tables of «Skedar për AI»: for each one, which rows belong to the period, what is read
 * from the database and what the file shows of it.
 *
 * Rules that hold for every table:
 *  • columns are named one by one — nothing is ever selected with `*`, so a password hash, a PIN,
 *    an access code or a key cannot slip into the file when a table gains a column;
 *  • a row is known by what a person calls it (receipt number, product name, PC code), never by
 *    an internal id;
 *  • times are local to the business time zone, to the minute;
 *  • with «hide customers» a customer is the customer code and nothing else, and a name typed by
 *    hand (on a session, a reservation, paid time) is left out.
 */
import type { QueryResult, QueryResultRow } from 'pg';
import type { DataExportPart, DataExportSection } from '@likapcs/shared';
import { child, l, type Column, type Label, type Lang, type TableSpec } from './document.js';
import { valueOf, type ValueDomain } from './labels.js';

/** One query at a time on the connection that holds the snapshot. */
export interface SerialDb {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export interface ExportContext {
  db: SerialDb;
  /** `$1` first day, `$2` last day, `$3` time zone of every query over the period. */
  from: string;
  to: string;
  timeZone: string;
  lang: Lang;
  hideCustomers: boolean;
}

// ─── SQL fragments ($1 = from, $2 = to, $3 = time zone) ────────────────────────

const START = `($1::date)::timestamp AT TIME ZONE $3`;
const END = `($2::date + 1)::timestamp AT TIME ZONE $3`;
/** `[from 00:00, to + 1 day 00:00)` in the business time zone — as the reports count a day. */
const inRange = (col: string) => `(${col} >= ${START} AND ${col} < ${END})`;
const inDates = (col: string) => `(${col} >= $1::date AND ${col} <= $2::date)`;
/** A timestamp as local `YYYY-MM-DD HH:MM`; `zone` is the placeholder of the time zone. */
const ts = (col: string, zone = '$3') =>
  `to_char(${col} AT TIME ZONE ${zone}, 'YYYY-MM-DD HH24:MI')`;
const day = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;
const hhmm = (col: string) => `to_char(${col}, 'HH24:MI')`;
/** What a person calls a sale: the receipt number, else the number a phone gave it offline. */
const saleNo = (alias: string) =>
  `COALESCE(${alias}.receipt_no, ${alias}.local_number, '#' || left(${alias}.id::text, 8))`;

// ─── Small helpers shared by the tables ────────────────────────────────────────

const word =
  (ctx: ExportContext) =>
  (domain: ValueDomain, code: string | null | undefined): string =>
    valueOf(domain, code, ctx.lang);

/** A customer as the file shows them: the code, and the name unless customers are hidden. */
export function customerLabel(
  ctx: ExportContext,
  code: string | null | undefined,
  name: string | null | undefined,
): string | null {
  if (!code && !name) return null;
  if (ctx.hideCustomers) return code ?? null;
  return [code, name].filter(Boolean).join(' ');
}

/** A name somebody typed by hand next to a session or a reservation. */
const typedName = (ctx: ExportContext, name: string | null | undefined): string | null =>
  ctx.hideCustomers ? null : name?.trim() || null;

/** A note somebody typed about a customer's sale, session or debt: left out with the names. */
const typedNote = (ctx: ExportContext, note: string | null | undefined): string | null =>
  ctx.hideCustomers ? null : note?.trim() || null;

/**
 * How the program words a line of PC time sold at the desk: "60 min PC" (inside an offer) or
 * "PC time · 60 min", each followed by " · <the name it was bought for>" when one was given.
 * Also used in SQL (`DESK_TIME_SQL`), so keep the two in step.
 */
const DESK_TIME_TEXT = /^(\d+ min PC|PC time · \d+ min)(?: · .*)?$/;
export const DESK_TIME_SQL = `'^([0-9]+ min PC|PC time · [0-9]+ min)( · .*)?$'`;

/**
 * The text of a sale line. PC time sold at the desk carries the name it was bought for at its
 * end ("PC time · 60 min · Arben"): with customers hidden that name is cut off — the name the
 * paid time holds, and, on a line that is neither a product nor a session, whatever follows
 * the minutes.
 */
export function lineText(
  ctx: ExportContext,
  description: string,
  holder: string | null | undefined,
  freeText = false,
): string {
  if (!ctx.hideCustomers) return description;
  const suffix = holder ? ` · ${holder}` : '';
  if (suffix && description.endsWith(suffix)) return description.slice(0, -suffix.length);
  if (freeText) {
    const match = DESK_TIME_TEXT.exec(description);
    if (match) return match[1]!;
  }
  return description;
}

const positive = (n: number | null | undefined): number | null => (n && n > 0 ? n : null);
const nonZero = (n: number | null | undefined): number | null => (n ? n : null);
const onlyTrue = (b: boolean | null | undefined): boolean | null => (b ? true : null);
const minutesOf = (seconds: number | null | undefined): number | null =>
  seconds === null || seconds === undefined ? null : Math.round(seconds / 60);

const weekdays = (ctx: ExportContext, days: number[] | null | undefined): string | null => {
  if (!days || days.length === 0 || days.length >= 7) return null;
  return [...days]
    .sort((a, b) => a - b)
    .map((d) => valueOf('weekday', String(d), ctx.lang))
    .join(', ');
};

/** Rows that belong to the rows of a batch, grouped by the parent's id (`$1` = the ids). */
async function childrenOf<C extends { parent: string }>(
  ctx: ExportContext,
  sql: string,
  ids: readonly string[],
  withZone = false,
): Promise<Map<string, C[]>> {
  const map = new Map<string, C[]>();
  if (ids.length === 0) return map;
  const result = await ctx.db.query<C>(sql, withZone ? [ids, ctx.timeZone] : [ids]);
  for (const row of result.rows) {
    const list = map.get(row.parent);
    if (list) list.push(row);
    else map.set(row.parent, [row]);
  }
  return map;
}

// ─── What a table is ───────────────────────────────────────────────────────────

export interface SectionDef<R = unknown> {
  id: DataExportSection;
  part: DataExportPart;
  /** `FROM … WHERE …`, shared by the count and the rows so the two can never disagree. */
  source: string;
  select: string;
  order: string;
  /** `period`: uses $1–$3. `now`: a list as it is today, `$1` = the time zone. */
  params: 'period' | 'now';
  /** How much work one row is next to a plain one (a sale brings its lines and payments). */
  weight: number;
  spec: (ctx: ExportContext) => TableSpec<R>;
  /** Loads what belongs to the rows of one batch (lines, payments, events). */
  attach?: (ctx: ExportContext, rows: R[]) => Promise<void>;
}

/** Keeps the row type inside one definition while the list holds them all. */
const define = <R>(section: SectionDef<R>): SectionDef => section as unknown as SectionDef;

const paramsOf = (ctx: ExportContext, section: SectionDef): unknown[] =>
  section.params === 'period' ? [ctx.from, ctx.to, ctx.timeZone] : [ctx.timeZone];

export async function countRows(ctx: ExportContext, section: SectionDef): Promise<number> {
  // The time zone placeholder may not occur in the source of a list: name its type.
  const zone = section.params === 'period' ? '$3' : '$1';
  const result = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n ${section.source} AND ${zone}::text IS NOT NULL`,
    paramsOf(ctx, section),
  );
  return result.rows[0]?.n ?? 0;
}

let cursorSeq = 0;

/** Reads a table in batches through a cursor of the snapshot transaction. */
export async function* readRows(
  ctx: ExportContext,
  section: SectionDef,
  batchSize = 1000,
): AsyncGenerator<unknown[]> {
  const zone = section.params === 'period' ? '$3' : '$1';
  cursorSeq += 1;
  const name = `likapcs_export_${cursorSeq}`;
  await ctx.db.query(
    `DECLARE ${name} NO SCROLL CURSOR FOR
       SELECT ${section.select} ${section.source} AND ${zone}::text IS NOT NULL
        ORDER BY ${section.order}`,
    paramsOf(ctx, section),
  );
  try {
    for (;;) {
      const result = await ctx.db.query(`FETCH ${batchSize} FROM ${name}`);
      if (result.rows.length === 0) break;
      if (section.attach) await section.attach(ctx, result.rows);
      yield result.rows;
      if (result.rows.length < batchSize) break;
    }
  } finally {
    await ctx.db.query(`CLOSE ${name}`).catch(() => undefined);
  }
}

// ─── Sales ─────────────────────────────────────────────────────────────────────

interface SaleLine {
  parent: string;
  item_id: string;
  holder?: string | null;
  /** Neither a product nor the time of a session: text the program or the cashier wrote. */
  free_text: boolean;
  description: string;
  quantity_milli: number;
  unit_price_cents: number;
  discount_cents: number;
  line_total_cents: number;
  cost_cents: number;
  refunded_milli: number;
  offer_name: string | null;
  station: string | null;
  addons: { name?: string }[] | null;
}
interface SaleTender {
  parent: string;
  method: string;
  amount_cents: number;
}
interface SaleRow {
  id: string;
  no: string;
  at: string;
  status: string;
  source: string;
  cashier: string;
  customer_code: string | null;
  customer_name: string | null;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;
  change_cents: number;
  refunded_cents: number;
  notes: string | null;
  price_changed: boolean;
  lines?: SaleLine[];
  tenders?: SaleTender[];
}

/**
 * How a sale was paid, in words. Cash tenders are stored as the amount handed over, so the
 * change is taken off the cash; one method alone is just its name.
 */
export function paymentText(
  tenders: readonly { method: string; amount_cents: number }[],
  changeCents: number,
  lang: Lang,
): string | null {
  if (tenders.length === 0) return null;
  const byMethod = new Map<string, number>();
  for (const t of tenders) byMethod.set(t.method, (byMethod.get(t.method) ?? 0) + t.amount_cents);
  if (changeCents > 0 && byMethod.has('cash')) {
    byMethod.set('cash', byMethod.get('cash')! - changeCents);
  }
  const parts = [...byMethod.entries()];
  if (parts.length === 1) return valueOf('method', parts[0]![0], lang);
  return parts
    .map(([method, cents]) => `${valueOf('method', method, lang)} ${(cents / 100).toFixed(2)}`)
    .join(' + ');
}

const sales = define<SaleRow>({
  id: 'sales',
  part: 'sales',
  params: 'period',
  weight: 3,
  source: `FROM sales s
            JOIN users u ON u.id = s.cashier_user_id
            LEFT JOIN customers c ON c.id = s.customer_id
           WHERE s.status <> 'suspended' AND ${inRange('COALESCE(s.completed_at, s.created_at)')}`,
  select: `s.id::text AS id, ${saleNo('s')} AS no, ${ts('COALESCE(s.completed_at, s.created_at)')} AS at,
           s.status, s.source, u.full_name AS cashier, c.code AS customer_code, c.name AS customer_name,
           s.discount_cents, s.tax_cents, s.total_cents, s.change_cents, s.refunded_cents, s.notes,
           s.price_changed`,
  order: 'COALESCE(s.completed_at, s.created_at), s.id',
  attach: async (ctx, rows) => {
    const ids = rows.map((r) => r.id);
    const lines = await childrenOf<SaleLine>(
      ctx,
      `SELECT i.sale_id::text AS parent, i.id::text AS item_id,
              (i.product_id IS NULL AND i.gaming_session_id IS NULL) AS free_text,
              i.description, i.quantity_milli,
              i.unit_price_cents, i.discount_cents, i.line_total_cents, i.cost_cents,
              i.refunded_milli, i.offer_name, st.code AS station, i.addons
         FROM sale_items i
         LEFT JOIN gaming_sessions g ON g.id = i.gaming_session_id
         LEFT JOIN stations st ON st.id = g.station_id
        WHERE i.sale_id = ANY($1::uuid[]) ORDER BY i.sale_id, i.line_no`,
      ids,
    );
    const tenders = await childrenOf<SaleTender>(
      ctx,
      `SELECT p.sale_id::text AS parent, p.method, p.amount_cents
         FROM payments p WHERE p.kind = 'sale' AND p.sale_id = ANY($1::uuid[])
        ORDER BY p.received_at, p.id`,
      ids,
    );
    // PC time sold at the desk: the name it was bought for stands at the end of the line's text.
    if (ctx.hideCustomers) {
      const holders = await ctx.db.query<{ item_id: string; holder_name: string }>(
        `SELECT t.sale_item_id::text AS item_id, t.holder_name FROM time_credits t
          WHERE t.sale_id = ANY($1::uuid[]) AND t.holder_name IS NOT NULL`,
        [ids],
      );
      const holderOf = new Map(holders.rows.map((h) => [h.item_id, h.holder_name] as const));
      for (const list of lines.values()) {
        for (const line of list) line.holder = holderOf.get(line.item_id) ?? null;
      }
    }
    for (const row of rows) {
      row.lines = lines.get(row.id) ?? [];
      row.tenders = tenders.get(row.id) ?? [];
    }
  },
  spec: (ctx) => {
    const w = word(ctx);
    return {
      title: l('Shitjet', 'Sales'),
      note: l(
        'Çdo faturë e periudhës me rreshtat e saj. «Kosto» është kostoja e mallit të atij rreshti.',
        'Every bill of the period with its lines. "Cost" is the cost of the goods of that line.',
      ),
      columns: [
        { label: l('Nr', 'No'), get: (r) => r.no },
        { label: l('Koha', 'Time'), get: (r) => r.at },
        { label: l('Statusi', 'Status'), get: (r) => w('saleStatus', r.status) },
        { label: l('Burimi', 'Source'), get: (r) => w('saleSource', r.source) },
        { label: l('Arkëtari', 'Cashier'), get: (r) => r.cashier },
        { label: l('Totali', 'Total'), kind: 'money', get: (r) => r.total_cents },
        {
          label: l('Pagesa', 'Payment'),
          get: (r) => paymentText(r.tenders ?? [], r.change_cents, ctx.lang),
        },
        {
          label: l('Klienti', 'Customer'),
          optional: true,
          get: (r) => customerLabel(ctx, r.customer_code, r.customer_name),
        },
        {
          label: l('Zbritja', 'Discount'),
          kind: 'money',
          optional: true,
          get: (r) => positive(r.discount_cents),
        },
        {
          label: l('TVSH', 'VAT'),
          kind: 'money',
          optional: true,
          get: (r) => positive(r.tax_cents),
        },
        {
          label: l('Kthyer', 'Refunded'),
          kind: 'money',
          optional: true,
          get: (r) => positive(r.refunded_cents),
        },
        {
          label: l('Çmimi u ndryshua pas pagesës', 'Price changed after payment'),
          kind: 'bool',
          optional: true,
          get: (r) => onlyTrue(r.price_changed),
        },
        { label: l('Shënim', 'Note'), optional: true, get: (r) => typedNote(ctx, r.notes) },
      ],
      children: [
        child<SaleRow, SaleLine>({
          title: l('Artikujt', 'Lines'),
          tag: l('artikull', 'line'),
          rows: (r) => r.lines ?? [],
          columns: [
            {
              label: l('Artikulli', 'Item'),
              get: (i) => lineText(ctx, i.description, i.holder, i.free_text),
            },
            { label: l('Sasia', 'Qty'), kind: 'qty', get: (i) => i.quantity_milli },
            { label: l('Çmimi', 'Price'), kind: 'money', get: (i) => i.unit_price_cents },
            { label: l('Totali', 'Total'), kind: 'money', get: (i) => i.line_total_cents },
            { label: l('Kosto', 'Cost'), kind: 'money', get: (i) => i.cost_cents },
            {
              label: l('Zbritja', 'Discount'),
              kind: 'money',
              optional: true,
              get: (i) => positive(i.discount_cents),
            },
            {
              label: l('Sasia e kthyer', 'Qty refunded'),
              kind: 'qty',
              optional: true,
              get: (i) => positive(i.refunded_milli),
            },
            { label: l('Oferta', 'Offer'), optional: true, get: (i) => i.offer_name },
            { label: l('PC', 'PC'), optional: true, get: (i) => i.station },
            {
              label: l('Shtesa', 'Extras'),
              optional: true,
              get: (i) =>
                (i.addons ?? [])
                  .map((a) => a.name)
                  .filter(Boolean)
                  .join(', ') || null,
            },
          ],
        }),
      ],
    };
  },
});

// ─── Refunds ───────────────────────────────────────────────────────────────────

interface RefundLine {
  parent: string;
  holder: string | null;
  free_text: boolean;
  description: string;
  quantity_milli: number;
  amount_cents: number;
}
interface RefundRow {
  id: string;
  no: string | null;
  at: string;
  sale_no: string;
  kind: string;
  total_cents: number;
  reason: string;
  restock: boolean;
  by_name: string;
  authorized_by: string | null;
  methods: string | null;
  lines?: RefundLine[];
}

const refunds = define<RefundRow>({
  id: 'refunds',
  part: 'sales',
  params: 'period',
  weight: 2,
  source: `FROM refunds r
            JOIN sales s ON s.id = r.sale_id
            JOIN users u ON u.id = r.created_by
            LEFT JOIN users a ON a.id = r.authorized_by
           WHERE ${inRange('r.created_at')}`,
  select: `r.id::text AS id, r.refund_no AS no, ${ts('r.created_at')} AS at, ${saleNo('s')} AS sale_no,
           r.kind, r.total_cents, r.reason, r.restock, u.full_name AS by_name,
           a.full_name AS authorized_by,
           (SELECT string_agg(DISTINCT p.method, ',') FROM payments p WHERE p.refund_id = r.id) AS methods`,
  order: 'r.created_at, r.id',
  attach: async (ctx, rows) => {
    const lines = await childrenOf<RefundLine>(
      ctx,
      `SELECT ri.refund_id::text AS parent, si.description, ri.quantity_milli, ri.amount_cents,
              (si.product_id IS NULL AND si.gaming_session_id IS NULL) AS free_text,
              (SELECT t.holder_name FROM time_credits t
                WHERE t.sale_id = si.sale_id AND t.sale_item_id = si.id LIMIT 1) AS holder
         FROM refund_items ri JOIN sale_items si ON si.id = ri.sale_item_id
        WHERE ri.refund_id = ANY($1::uuid[]) ORDER BY ri.refund_id, ri.id`,
      rows.map((r) => r.id),
    );
    for (const row of rows) row.lines = lines.get(row.id) ?? [];
  },
  spec: (ctx) => {
    const w = word(ctx);
    return {
      title: l('Kthimet', 'Refunds'),
      note: l(
        'Para të kthyera klientit ose çmim i ulur pas pagesës. «Fatura» është shitja që u kthye.',
        'Money given back to a customer, or a price lowered after payment. "Receipt" is the sale it belongs to.',
      ),
      columns: [
        { label: l('Nr', 'No'), get: (r) => r.no },
        { label: l('Koha', 'Time'), get: (r) => r.at },
        { label: l('Fatura', 'Receipt'), get: (r) => r.sale_no },
        { label: l('Lloji', 'Kind'), get: (r) => w('refundKind', r.kind) },
        { label: l('Shuma', 'Amount'), kind: 'money', get: (r) => r.total_cents },
        { label: l('Arsyeja', 'Reason'), get: (r) => r.reason },
        { label: l('Nga', 'By'), get: (r) => r.by_name },
        {
          label: l('Malli u kthye në stok', 'Goods put back in stock'),
          kind: 'bool',
          optional: true,
          get: (r) => (r.kind === 'refund' ? r.restock : null),
        },
        {
          label: l('Kthyer me', 'Paid back by'),
          optional: true,
          get: (r) =>
            r.methods
              ?.split(',')
              .map((m) => w('method', m))
              .join(' + ') ?? null,
        },
        {
          label: l('Miratuar nga', 'Authorised by'),
          optional: true,
          get: (r) => (r.authorized_by === r.by_name ? null : r.authorized_by),
        },
      ],
      children: [
        child<RefundRow, RefundLine>({
          title: l('Artikujt', 'Lines'),
          tag: l('artikull', 'line'),
          rows: (r) => r.lines ?? [],
          columns: [
            {
              label: l('Artikulli', 'Item'),
              get: (i) => lineText(ctx, i.description, i.holder, i.free_text),
            },
            { label: l('Sasia', 'Qty'), kind: 'qty', get: (i) => i.quantity_milli },
            { label: l('Shuma', 'Amount'), kind: 'money', get: (i) => i.amount_cents },
          ],
        }),
      ],
    };
  },
});

// ─── PC sessions ───────────────────────────────────────────────────────────────

interface SessionEvent {
  parent: string;
  event_type: string;
  at: string;
  by_name: string | null;
  payload: Record<string, unknown> | null;
}
interface SessionRow {
  id: string;
  station: string;
  pc_label: string | null;
  started: string;
  ended: string | null;
  status: string;
  billing_mode: string;
  end_reason: string | null;
  planned_seconds: number | null;
  billable_seconds: number | null;
  total_paused_seconds: number;
  rate_cents_per_hour: number;
  quoted_price_cents: number | null;
  final_price_cents: number | null;
  discount_cents: number;
  paid_cents: number;
  unpaid_cents: number;
  sale_no: string | null;
  billed: string | null;
  customer_code: string | null;
  customer_name: string | null;
  typed_name: string | null;
  started_by: string | null;
  package_name: string | null;
  from_credit: boolean;
  notes: string | null;
  events?: SessionEvent[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

const sessions = define<SessionRow>({
  id: 'sessions',
  part: 'gaming',
  params: 'period',
  weight: 2,
  // A session belongs to the period when it ran in it, or when its bill was settled in it.
  source: `FROM gaming_sessions g
            JOIN stations st ON st.id = g.station_id
            LEFT JOIN sales s ON s.id = g.sale_id
            LEFT JOIN customers c ON c.id = g.customer_id
            LEFT JOIN users u ON u.id = g.created_by
            LEFT JOIN gaming_packages pk ON pk.id = g.package_id
           WHERE ((g.started_at < ${END} AND COALESCE(g.ended_at, now()) >= ${START})
                  OR ${inRange('g.billed_at')})`,
  select: `g.id::text AS id, st.code AS station, g.pc_label, ${ts('g.started_at')} AS started,
           ${ts('g.ended_at')} AS ended, g.status, g.billing_mode, g.end_reason, g.planned_seconds,
           g.billable_seconds, g.total_paused_seconds, g.rate_cents_per_hour, g.quoted_price_cents,
           g.final_price_cents, g.discount_cents, g.paid_cents, g.unpaid_cents,
           CASE WHEN s.id IS NULL THEN NULL ELSE ${saleNo('s')} END AS sale_no,
           ${ts('g.billed_at')} AS billed, c.code AS customer_code, c.name AS customer_name,
           g.customer_name AS typed_name, u.full_name AS started_by, pk.name AS package_name,
           (g.time_credit_id IS NOT NULL) AS from_credit, g.notes`,
  order: 'g.started_at, g.id',
  attach: async (ctx, rows) => {
    const events = await childrenOf<SessionEvent>(
      ctx,
      `SELECT e.session_id::text AS parent, e.event_type, ${ts('e.occurred_at', '$2')} AS at,
              u.full_name AS by_name, e.payload
         FROM session_events e LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.session_id = ANY($1::uuid[])
          AND e.event_type IN ('paused', 'resumed', 'extended', 'discount_applied', 'correction',
                               'transferred_out', 'transferred_in', 'cancelled')
        ORDER BY e.occurred_at, e.id`,
      rows.map((r) => r.id),
      true,
    );
    for (const row of rows) row.events = events.get(row.id) ?? [];
  },
  spec: (ctx) => {
    const w = word(ctx);
    const detail = (e: SessionEvent): string | null => {
      const p = e.payload ?? {};
      const parts: string[] = [];
      if (e.event_type === 'correction') {
        const kind = str(p.kind);
        if (kind) parts.push(w('correctionKind', kind));
      }
      if (e.event_type === 'paused') {
        const by = str(p.reason);
        if (by) parts.push(w('pausedBy', by));
      } else {
        const reason = str(p.reason);
        if (reason) parts.push(reason);
      }
      if (p.later === true || p.deferred === true) {
        parts.push(ctx.lang === 'sq' ? 'për t’u paguar në fund' : 'to pay at the end');
      }
      return parts.join(', ') || null;
    };
    return {
      title: l('Seancat e PC-ve', 'PC sessions'),
      note: l(
        'Çdo përdorim i një PC-je. «Minuta» janë minutat e faturuara; «Çmimi» është çmimi i kohës.',
        'Every use of a PC. "Minutes" are the minutes charged; "Price" is the price of the time.',
      ),
      columns: [
        { label: l('PC', 'PC'), get: (r) => r.station },
        { label: l('Fillimi', 'Start'), get: (r) => r.started },
        { label: l('Mbarimi', 'End'), get: (r) => r.ended },
        { label: l('Statusi', 'Status'), get: (r) => w('sessionStatus', r.status) },
        { label: l('Mënyra', 'Mode'), get: (r) => w('billingMode', r.billing_mode) },
        { label: l('Minuta', 'Minutes'), kind: 'int', get: (r) => minutesOf(r.billable_seconds) },
        {
          label: l('Çmimi', 'Price'),
          kind: 'money',
          get: (r) => r.final_price_cents ?? r.quoted_price_cents,
        },
        { label: l('Fatura', 'Receipt'), optional: true, get: (r) => r.sale_no },
        { label: l('Paguar më', 'Paid at'), optional: true, get: (r) => r.billed },
        {
          label: l('Minuta të planifikuara', 'Minutes planned'),
          kind: 'int',
          optional: true,
          get: (r) => minutesOf(r.planned_seconds),
        },
        {
          label: l('Minuta në pauzë', 'Minutes paused'),
          kind: 'int',
          optional: true,
          get: (r) => positive(minutesOf(r.total_paused_seconds)),
        },
        {
          label: l('Çmimi për orë', 'Price per hour'),
          kind: 'money',
          optional: true,
          get: (r) => positive(r.rate_cents_per_hour),
        },
        {
          label: l('Zbritja', 'Discount'),
          kind: 'money',
          optional: true,
          get: (r) => positive(r.discount_cents),
        },
        {
          label: l('Paguar gjatë seancës', 'Paid while running'),
          kind: 'money',
          optional: true,
          get: (r) => positive(r.paid_cents),
        },
        {
          label: l('Ende pa paguar', 'Still to pay'),
          kind: 'money',
          optional: true,
          get: (r) => positive(r.unpaid_cents),
        },
        {
          label: l('Klienti', 'Customer'),
          optional: true,
          get: (r) =>
            customerLabel(ctx, r.customer_code, r.customer_name) ?? typedName(ctx, r.typed_name),
        },
        { label: l('Nisur nga', 'Started by'), optional: true, get: (r) => r.started_by },
        { label: l('Paketa', 'Package'), optional: true, get: (r) => r.package_name },
        {
          label: l('Me kohë të blerë më parë', 'Used time bought earlier'),
          kind: 'bool',
          optional: true,
          get: (r) => onlyTrue(r.from_credit),
        },
        {
          label: l('Si mbaroi', 'How it ended'),
          optional: true,
          get: (r) => w('endReason', r.end_reason),
        },
        {
          // The name a PC shows during one session is often the player's.
          label: l('Emri i PC-së në seancë', 'PC name in the session'),
          optional: true,
          get: (r) => typedName(ctx, r.pc_label),
        },
        { label: l('Shënim', 'Note'), optional: true, get: (r) => typedNote(ctx, r.notes) },
      ],
      children: [
        child<SessionRow, SessionEvent>({
          title: l('Ngjarjet', 'Events'),
          tag: l('ngjarje', 'event'),
          rows: (r) => r.events ?? [],
          columns: [
            { label: l('Koha', 'Time'), get: (e) => e.at },
            { label: l('Ngjarja', 'Event'), get: (e) => w('sessionEvent', e.event_type) },
            { label: l('Nga', 'By'), get: (e) => e.by_name },
            {
              label: l('Minuta', 'Minutes'),
              kind: 'int',
              optional: true,
              get: (e) => num(e.payload?.minutes),
            },
            {
              label: l('Shuma', 'Amount'),
              kind: 'money',
              optional: true,
              get: (e) =>
                positive(
                  num(e.payload?.priceCents) ??
                    num(e.payload?.discountCents) ??
                    num(e.payload?.amountCents),
                ),
            },
            {
              label: l('Falas', 'Free'),
              kind: 'bool',
              optional: true,
              get: (e) => onlyTrue(e.payload?.gift === true),
            },
            { label: l('Hollësi', 'Detail'), optional: true, get: detail },
          ],
        }),
      ],
    };
  },
});

// ─── Paid time waiting to be used ──────────────────────────────────────────────

interface CreditRow {
  at: string;
  sale_no: string;
  minutes_total: number;
  minutes_remaining: number;
  price_cents: number;
  station: string | null;
  holder_name: string | null;
  customer_code: string | null;
  customer_name: string | null;
  cancelled: string | null;
  by_name: string | null;
}

const timeCredits = define<CreditRow>({
  id: 'timeCredits',
  part: 'gaming',
  params: 'period',
  weight: 1,
  // Bought in the period, or still holding minutes today.
  source: `FROM time_credits t
            JOIN sales s ON s.id = t.sale_id
            LEFT JOIN stations st ON st.id = t.station_id
            LEFT JOIN customers c ON c.id = t.customer_id
            LEFT JOIN users u ON u.id = t.created_by
           WHERE (${inRange('t.created_at')} OR (t.minutes_remaining > 0 AND t.cancelled_at IS NULL))`,
  select: `${ts('t.created_at')} AS at, ${saleNo('s')} AS sale_no, t.minutes_total, t.minutes_remaining,
           t.price_cents, st.code AS station, t.holder_name, c.code AS customer_code,
           c.name AS customer_name, ${ts('t.cancelled_at')} AS cancelled, u.full_name AS by_name`,
  order: 't.created_at, t.id',
  spec: (ctx) => ({
    title: l('Koha e paguar në banak', 'PC time sold at the desk'),
    note: l(
      'Minuta të blera në banak (edhe brenda një oferte) për t’u përdorur në një PC. «Të mbetura» janë ende të papërdorura.',
      'Minutes bought at the desk (also inside an offer) to be used on a PC. "Left" are not used yet.',
    ),
    columns: [
      { label: l('Blerë më', 'Bought at'), get: (r) => r.at },
      { label: l('Fatura', 'Receipt'), get: (r) => r.sale_no },
      { label: l('Minuta', 'Minutes'), kind: 'int', get: (r) => r.minutes_total },
      { label: l('Të mbetura', 'Left'), kind: 'int', get: (r) => r.minutes_remaining },
      { label: l('Çmimi', 'Price'), kind: 'money', get: (r) => r.price_cents },
      { label: l('PC', 'PC'), optional: true, get: (r) => r.station },
      {
        label: l('Klienti', 'Customer'),
        optional: true,
        get: (r) =>
          customerLabel(ctx, r.customer_code, r.customer_name) ?? typedName(ctx, r.holder_name),
      },
      { label: l('Anuluar më', 'Cancelled at'), optional: true, get: (r) => r.cancelled },
      { label: l('Shitur nga', 'Sold by'), optional: true, get: (r) => r.by_name },
    ],
  }),
});

// ─── Reservations ──────────────────────────────────────────────────────────────

interface ReservationRow {
  starts: string;
  status: string;
  stations: string | null;
  customer_code: string | null;
  customer_name: string | null;
  typed_name: string | null;
  notes: string | null;
  by_name: string | null;
  created: string;
  cancelled: string | null;
}

const reservations = define<ReservationRow>({
  id: 'reservations',
  part: 'gaming',
  params: 'period',
  weight: 1,
  source: `FROM reservations r
            LEFT JOIN customers c ON c.id = r.customer_id
            LEFT JOIN users u ON u.id = r.created_by
           WHERE ${inRange('r.starts_at')}`,
  select: `${ts('r.starts_at')} AS starts, r.status,
           (SELECT string_agg(st.code, ', ' ORDER BY st.number)
              FROM reservation_stations rs JOIN stations st ON st.id = rs.station_id
             WHERE rs.reservation_id = r.id) AS stations,
           c.code AS customer_code, c.name AS customer_name, r.customer_name AS typed_name, r.notes,
           COALESCE(u.full_name, r.created_by_name) AS by_name, ${ts('r.created_at')} AS created,
           ${ts('r.cancelled_at')} AS cancelled`,
  order: 'r.starts_at, r.id',
  spec: (ctx) => {
    const w = word(ctx);
    return {
      title: l('Rezervimet', 'Reservations'),
      columns: [
        { label: l('Fillon', 'Starts'), get: (r) => r.starts },
        { label: l('Statusi', 'Status'), get: (r) => w('reservationStatus', r.status) },
        { label: l('PC-të', 'PCs'), get: (r) => r.stations },
        {
          label: l('Klienti', 'Customer'),
          optional: true,
          get: (r) =>
            customerLabel(ctx, r.customer_code, r.customer_name) ?? typedName(ctx, r.typed_name),
        },
        { label: l('Krijuar nga', 'Made by'), optional: true, get: (r) => r.by_name },
        { label: l('Krijuar më', 'Made at'), optional: true, get: (r) => r.created },
        { label: l('Anuluar më', 'Cancelled at'), optional: true, get: (r) => r.cancelled },
        { label: l('Shënim', 'Note'), optional: true, get: (r) => typedNote(ctx, r.notes) },
      ],
    };
  },
});

// ─── Orders sent from the PCs ──────────────────────────────────────────────────

interface OrderLine {
  parent: string;
  name: string;
  quantity_milli: number;
  unit_price_cents: number;
  line_total_cents: number;
}
interface OrderRow {
  id: string;
  number: number;
  at: string;
  station: string;
  status: string;
  settlement: string | null;
  total_cents: number;
  sale_no: string | null;
  customer_code: string | null;
  customer_name: string | null;
  by_name: string | null;
  reason: string | null;
  note: string | null;
  lines?: OrderLine[];
}

const orders = define<OrderRow>({
  id: 'orders',
  part: 'gaming',
  params: 'period',
  weight: 2,
  source: `FROM station_orders o
            JOIN stations st ON st.id = o.station_id
            LEFT JOIN sales s ON s.id = o.sale_id
            LEFT JOIN customers c ON c.id = o.customer_id
            LEFT JOIN users u ON u.id = o.decided_by
           WHERE ${inRange('o.requested_at')}`,
  select: `o.id::text AS id, o.number, ${ts('o.requested_at')} AS at, st.code AS station, o.status,
           o.settlement, o.total_cents,
           CASE WHEN s.id IS NULL THEN NULL ELSE ${saleNo('s')} END AS sale_no,
           c.code AS customer_code, c.name AS customer_name, u.full_name AS by_name, o.reason, o.note`,
  order: 'o.requested_at, o.id',
  attach: async (ctx, rows) => {
    const lines = await childrenOf<OrderLine>(
      ctx,
      `SELECT i.order_id::text AS parent, i.name, i.quantity_milli, i.unit_price_cents, i.line_total_cents
         FROM station_order_items i WHERE i.order_id = ANY($1::uuid[]) ORDER BY i.order_id, i.id`,
      rows.map((r) => r.id),
    );
    for (const row of rows) row.lines = lines.get(row.id) ?? [];
  },
  spec: (ctx) => {
    const w = word(ctx);
    return {
      title: l('Porositë nga PC-të', 'Orders from the PCs'),
      note: l(
        'Produkte që klienti i kërkoi nga PC-ja. Një porosi e paguar ose e faturuar është edhe te «Shitjet» me numrin e faturës.',
        'Products a customer asked for from the PC. A paid or billed order is also under "Sales" with its receipt number.',
      ),
      columns: [
        { label: l('Nr', 'No'), kind: 'int', get: (r) => r.number },
        { label: l('Koha', 'Time'), get: (r) => r.at },
        { label: l('PC', 'PC'), get: (r) => r.station },
        { label: l('Statusi', 'Status'), get: (r) => w('orderStatus', r.status) },
        { label: l('Totali', 'Total'), kind: 'money', get: (r) => r.total_cents },
        {
          label: l('Si paguhet', 'Settled'),
          optional: true,
          get: (r) => w('orderSettlement', r.settlement),
        },
        { label: l('Fatura', 'Receipt'), optional: true, get: (r) => r.sale_no },
        {
          label: l('Klienti', 'Customer'),
          optional: true,
          get: (r) => customerLabel(ctx, r.customer_code, r.customer_name),
        },
        { label: l('Vendosur nga', 'Decided by'), optional: true, get: (r) => r.by_name },
        { label: l('Arsyeja', 'Reason'), optional: true, get: (r) => r.reason },
        { label: l('Shënim', 'Note'), optional: true, get: (r) => typedNote(ctx, r.note) },
      ],
      children: [
        child<OrderRow, OrderLine>({
          title: l('Artikujt', 'Lines'),
          tag: l('artikull', 'line'),
          rows: (r) => r.lines ?? [],
          columns: [
            { label: l('Artikulli', 'Item'), get: (i) => i.name },
            { label: l('Sasia', 'Qty'), kind: 'qty', get: (i) => i.quantity_milli },
            { label: l('Çmimi', 'Price'), kind: 'money', get: (i) => i.unit_price_cents },
            { label: l('Totali', 'Total'), kind: 'money', get: (i) => i.line_total_cents },
          ],
        }),
      ],
    };
  },
});

// ─── The till: shifts and drawer movements ─────────────────────────────────────

/** A shift belongs to the period when any part of it lies inside (as the cash book counts). */
const SHIFT_IN_PERIOD = `(cs.opened_at < ${END} AND COALESCE(cs.closed_at, now()) >= ${START})`;

interface ShiftRow {
  register: string;
  opened: string;
  opened_by: string;
  status: string;
  opening_cents: number;
  cash_in: number;
  cash_out: number;
  expected_cash_cents: number | null;
  counted_cash_cents: number | null;
  difference_cents: number | null;
  closed: string | null;
  closed_by: string | null;
  notes: string | null;
}

const shifts = define<ShiftRow>({
  id: 'shifts',
  part: 'cash',
  params: 'period',
  weight: 2,
  source: `FROM cash_shifts cs
            JOIN cash_registers r ON r.id = cs.register_id
            JOIN users ou ON ou.id = cs.opened_by
            LEFT JOIN users cu ON cu.id = cs.closed_by
            LEFT JOIN LATERAL (
              SELECT COALESCE(SUM(m.amount_cents) FILTER (WHERE m.amount_cents > 0), 0)::bigint AS cash_in,
                     COALESCE(-SUM(m.amount_cents) FILTER (WHERE m.amount_cents < 0), 0)::bigint AS cash_out
                FROM cash_movements m WHERE m.shift_id = cs.id AND m.movement_type <> 'opening'
            ) flow ON true
           WHERE ${SHIFT_IN_PERIOD}`,
  select: `r.name AS register, ${ts('cs.opened_at')} AS opened, ou.full_name AS opened_by, cs.status,
           cs.opening_cents, flow.cash_in, flow.cash_out, cs.expected_cash_cents,
           cs.counted_cash_cents, cs.difference_cents, ${ts('cs.closed_at')} AS closed,
           cu.full_name AS closed_by, cs.notes`,
  order: 'cs.opened_at, cs.id',
  spec: (ctx) => {
    const w = word(ctx);
    return {
      title: l('Turnet e arkës', 'Till shifts'),
      note: l(
        'Çdo turn që prek periudhën. Pritej = gjendja fillestare + para të hyra − para të dala. Diferenca = u numërua − pritej (minus = mungesë).',
        'Every shift that touches the period. Expected = opening float + cash in − cash out. Difference = counted − expected (minus = short).',
      ),
      columns: [
        { label: l('Arka', 'Till'), get: (r) => r.register },
        { label: l('Hapur më', 'Opened at'), get: (r) => r.opened },
        { label: l('Hapur nga', 'Opened by'), get: (r) => r.opened_by },
        { label: l('Statusi', 'Status'), get: (r) => w('shiftStatus', r.status) },
        {
          label: l('Gjendja fillestare', 'Opening float'),
          kind: 'money',
          get: (r) => r.opening_cents,
        },
        { label: l('Para të hyra', 'Cash in'), kind: 'money', get: (r) => r.cash_in },
        { label: l('Para të dala', 'Cash out'), kind: 'money', get: (r) => r.cash_out },
        {
          label: l('Pritej', 'Expected'),
          kind: 'money',
          get: (r) => r.expected_cash_cents ?? r.opening_cents + r.cash_in - r.cash_out,
        },
        { label: l('U numërua', 'Counted'), kind: 'money', get: (r) => r.counted_cash_cents },
        { label: l('Diferenca', 'Difference'), kind: 'money', get: (r) => r.difference_cents },
        { label: l('Mbyllur më', 'Closed at'), optional: true, get: (r) => r.closed },
        { label: l('Mbyllur nga', 'Closed by'), optional: true, get: (r) => r.closed_by },
        { label: l('Shënim', 'Note'), optional: true, get: (r) => r.notes },
      ],
    };
  },
});

interface CashRow {
  at: string;
  shift: string;
  movement_type: string;
  amount_cents: number;
  by_name: string | null;
  reason: string | null;
  sale_no: string | null;
  customer_code: string | null;
  customer_name: string | null;
}

/** `m.reference_id` as a uuid when the movement points at a row of that kind, else NULL. */
const referenceOf = (kind: string) =>
  `CASE WHEN m.reference_type = '${kind}' AND m.reference_id ~ '^[0-9a-fA-F-]{36}$'
        THEN m.reference_id::uuid END`;
/** Movements whose reason the program wrote itself: it repeats the receipt, or names the customer. */
const CASH_REASON_BY_PROGRAM = new Set(['opening', 'sale', 'refund']);
const CASH_REASON_NAMES_CUSTOMER = new Set(['customer_payment', 'wallet_topup', 'wallet_refund']);

const cashMovements = define<CashRow>({
  id: 'cashMovements',
  part: 'cash',
  params: 'period',
  weight: 1,
  // Every movement of the shifts listed above, so a shift and its movements always add up.
  source: `FROM cash_movements m
            JOIN cash_shifts cs ON cs.id = m.shift_id
            LEFT JOIN users u ON u.id = m.created_by
            LEFT JOIN refunds rf ON rf.id = ${referenceOf('refund')}
            LEFT JOIN sales s ON s.id = COALESCE(${referenceOf('sale')}, rf.sale_id)
            LEFT JOIN customers c ON c.id = ${referenceOf('customer')}
           WHERE ${SHIFT_IN_PERIOD}`,
  select: `${ts('m.created_at')} AS at, ${ts('cs.opened_at')} AS shift, m.movement_type,
           m.amount_cents, u.full_name AS by_name, m.reason,
           CASE WHEN s.id IS NULL THEN NULL ELSE ${saleNo('s')} END AS sale_no,
           c.code AS customer_code, c.name AS customer_name`,
  order: 'm.created_at, m.id',
  spec: (ctx) => {
    const w = word(ctx);
    return {
      title: l('Lëvizjet e arkës (hyrjet dhe daljet)', 'Drawer movements (cash in and out)'),
      note: l(
        'Çdo hyrje (+) dhe dalje (−) e parave në dorë. «Turni» është ora kur u hap turni i saj.',
        'Every cash movement into (+) and out of (−) the drawer. "Shift" is the time its shift was opened.',
      ),
      columns: [
        { label: l('Koha', 'Time'), get: (r) => r.at },
        { label: l('Turni', 'Shift'), get: (r) => r.shift },
        { label: l('Lloji', 'Kind'), get: (r) => w('cashMovement', r.movement_type) },
        { label: l('Shuma', 'Amount'), kind: 'money', get: (r) => r.amount_cents },
        { label: l('Nga', 'By'), get: (r) => r.by_name },
        { label: l('Fatura', 'Receipt'), optional: true, get: (r) => r.sale_no },
        {
          label: l('Klienti', 'Customer'),
          optional: true,
          get: (r) => customerLabel(ctx, r.customer_code, r.customer_name),
        },
        {
          label: l('Arsyeja', 'Reason'),
          optional: true,
          get: (r) => {
            if (CASH_REASON_BY_PROGRAM.has(r.movement_type)) return null;
            if (ctx.hideCustomers && CASH_REASON_NAMES_CUSTOMER.has(r.movement_type)) return null;
            return r.reason;
          },
        },
      ],
    };
  },
});

// ─── Expenses ──────────────────────────────────────────────────────────────────

interface ExpenseRow {
  date: string;
  category_sq: string;
  category_en: string;
  description: string;
  amount_cents: number;
  payment_method: string;
  from_drawer: boolean;
  supplier: string | null;
  by_name: string | null;
  voided: boolean;
  void_reason: string | null;
  staff_purchase: boolean;
}

const expenses = define<ExpenseRow>({
  id: 'expenses',
  part: 'cash',
  params: 'period',
  weight: 1,
  source: `FROM expenses e
            JOIN expense_categories ec ON ec.code = e.category_code
            LEFT JOIN suppliers s ON s.id = e.supplier_id
            LEFT JOIN users u ON u.id = e.created_by
           WHERE ${inDates('e.expense_date')}`,
  select: `${day('e.expense_date')} AS date, ec.name_sq AS category_sq, ec.name_en AS category_en,
           e.description, e.amount_cents, e.payment_method, (e.shift_id IS NOT NULL) AS from_drawer,
           s.name AS supplier, u.full_name AS by_name, (e.voided_at IS NOT NULL) AS voided,
           e.void_reason, (e.staff_purchase_id IS NOT NULL) AS staff_purchase`,
  order: 'e.expense_date, e.created_at, e.id',
  spec: (ctx) => {
    const w = word(ctx);
    return {
      title: l('Shpenzimet', 'Expenses'),
      note: l(
        'Një shpenzim i anuluar është në listë, por nuk numërohet te totalet.',
        'A voided expense is listed but does not count in the totals.',
      ),
      columns: [
        { label: l('Data', 'Date'), get: (r) => r.date },
        {
          label: l('Kategoria', 'Category'),
          get: (r) => (ctx.lang === 'sq' ? r.category_sq : r.category_en),
        },
        { label: l('Përshkrimi', 'Description'), get: (r) => r.description },
        { label: l('Shuma', 'Amount'), kind: 'money', get: (r) => r.amount_cents },
        { label: l('Pagesa', 'Payment'), get: (r) => w('method', r.payment_method) },
        {
          label: l('Paguar nga arka', 'Paid from the drawer'),
          kind: 'bool',
          optional: true,
          get: (r) => onlyTrue(r.from_drawer),
        },
        { label: l('Furnitori', 'Supplier'), optional: true, get: (r) => r.supplier },
        { label: l('Regjistruar nga', 'Entered by'), optional: true, get: (r) => r.by_name },
        {
          label: l('Blerje stafi', 'Staff purchase'),
          kind: 'bool',
          optional: true,
          get: (r) => onlyTrue(r.staff_purchase),
        },
        {
          label: l('Anuluar', 'Voided'),
          kind: 'bool',
          optional: true,
          get: (r) => onlyTrue(r.voided),
        },
        {
          label: l('Arsyeja e anulimit', 'Void reason'),
          optional: true,
          get: (r) => r.void_reason,
        },
      ],
    };
  },
});

// ─── Stock ─────────────────────────────────────────────────────────────────────

interface StockRow {
  at: string;
  product: string;
  movement_type: string;
  quantity_milli_delta: number;
  stock_after_milli: number;
  unit_cost_mills: number | null;
  reason: string | null;
  by_name: string | null;
}

const stockMovements = define<StockRow>({
  id: 'stockMovements',
  part: 'stock',
  params: 'period',
  weight: 1,
  source: `FROM inventory_movements m
            JOIN products p ON p.id = m.product_id
            LEFT JOIN users u ON u.id = m.created_by
           WHERE ${inRange('m.created_at')}`,
  select: `${ts('m.created_at')} AS at, p.name AS product, m.movement_type, m.quantity_milli_delta,
           m.stock_after_milli, m.unit_cost_mills, m.reason, u.full_name AS by_name`,
  order: 'm.created_at, m.id',
  spec: (ctx) => {
    const w = word(ctx);
    return {
      title: l(
        'Lëvizjet e stokut (hyrjet dhe daljet e mallit)',
        'Stock movements (goods in and out)',
      ),
      columns: [
        { label: l('Koha', 'Time'), get: (r) => r.at },
        { label: l('Produkti', 'Product'), get: (r) => r.product },
        { label: l('Lloji', 'Kind'), get: (r) => w('stockMovement', r.movement_type) },
        { label: l('Sasia', 'Qty'), kind: 'qty', get: (r) => r.quantity_milli_delta },
        { label: l('Stoku pas', 'Stock after'), kind: 'qty', get: (r) => r.stock_after_milli },
        {
          label: l('Kosto për njësi', 'Unit cost'),
          kind: 'mills',
          optional: true,
          get: (r) => positive(r.unit_cost_mills),
        },
        { label: l('Nga', 'By'), optional: true, get: (r) => r.by_name },
        { label: l('Arsyeja', 'Reason'), optional: true, get: (r) => r.reason },
      ],
    };
  },
});

interface CountLine {
  parent: string;
  product: string;
  expected_milli: number;
  counted_milli: number | null;
  note: string | null;
}
interface CountRow {
  id: string;
  started: string;
  status: string;
  by_name: string | null;
  completed: string | null;
  notes: string | null;
  lines?: CountLine[];
}

const stockCounts = define<CountRow>({
  id: 'stockCounts',
  part: 'stock',
  params: 'period',
  weight: 5,
  source: `FROM stock_counts sc LEFT JOIN users u ON u.id = sc.started_by
           WHERE ${inRange('sc.started_at')}`,
  select: `sc.id::text AS id, ${ts('sc.started_at')} AS started, sc.status, u.full_name AS by_name,
           ${ts('sc.completed_at')} AS completed, sc.notes`,
  order: 'sc.started_at, sc.id',
  attach: async (ctx, rows) => {
    const lines = await childrenOf<CountLine>(
      ctx,
      `SELECT i.stock_count_id::text AS parent, p.name AS product, i.expected_milli, i.counted_milli, i.note
         FROM stock_count_items i JOIN products p ON p.id = i.product_id
        WHERE i.stock_count_id = ANY($1::uuid[]) ORDER BY i.stock_count_id, p.name`,
      rows.map((r) => r.id),
    );
    for (const row of rows) row.lines = lines.get(row.id) ?? [];
  },
  spec: (ctx) => {
    const w = word(ctx);
    return {
      title: l('Numërimet e stokut', 'Stock counts'),
      columns: [
        { label: l('Filluar më', 'Started at'), get: (r) => r.started },
        { label: l('Statusi', 'Status'), get: (r) => w('stockCountStatus', r.status) },
        { label: l('Nga', 'By'), get: (r) => r.by_name },
        { label: l('Përfunduar më', 'Completed at'), optional: true, get: (r) => r.completed },
        { label: l('Shënim', 'Note'), optional: true, get: (r) => r.notes },
      ],
      children: [
        child<CountRow, CountLine>({
          title: l('Produktet', 'Products'),
          tag: l('produkt', 'product'),
          rows: (r) => r.lines ?? [],
          columns: [
            { label: l('Produkti', 'Product'), get: (i) => i.product },
            { label: l('Pritej', 'Expected'), kind: 'qty', get: (i) => i.expected_milli },
            { label: l('U numërua', 'Counted'), kind: 'qty', get: (i) => i.counted_milli },
            {
              label: l('Diferenca', 'Difference'),
              kind: 'qty',
              optional: true,
              get: (i) =>
                i.counted_milli === null ? null : nonZero(i.counted_milli - i.expected_milli),
            },
            { label: l('Shënim', 'Note'), optional: true, get: (i) => i.note },
          ],
        }),
      ],
    };
  },
});

// ─── Purchases from suppliers ──────────────────────────────────────────────────

interface PurchaseLine {
  parent: string;
  description: string;
  quantity_ordered_milli: number;
  quantity_received_milli: number;
  quantity_returned_milli: number;
  unit_cost_mills: number;
  line_total_cents: number;
}
interface PurchaseReceipt {
  parent: string;
  at: string;
  by_name: string | null;
  delivery_note_no: string | null;
  notes: string | null;
}
interface PurchasePayment {
  parent: string;
  at: string;
  amount_cents: number;
  method: string;
  from_drawer: boolean;
}
interface PurchaseReturn {
  parent: string;
  no: string;
  at: string;
  total_cents: number;
  reason: string;
  status: string;
}
interface PurchaseRow {
  id: string;
  no: string;
  date: string;
  supplier: string;
  status: string;
  total_cents: number;
  paid_cents: number;
  payment_status: string;
  supplier_invoice_no: string | null;
  additional_costs_cents: number;
  tax_cents: number;
  notes: string | null;
  by_name: string | null;
  lines?: PurchaseLine[];
  receipts?: PurchaseReceipt[];
  payments?: PurchasePayment[];
  returns?: PurchaseReturn[];
}

const purchases = define<PurchaseRow>({
  id: 'purchases',
  part: 'purchases',
  params: 'period',
  weight: 4,
  // Ordered in the period, or goods received / money paid for it in the period.
  source: `FROM purchases pu
            JOIN suppliers s ON s.id = pu.supplier_id
            LEFT JOIN users u ON u.id = pu.created_by
           WHERE (${inDates('pu.order_date')}
              OR EXISTS (SELECT 1 FROM purchase_receipts pr
                          WHERE pr.purchase_id = pu.id AND ${inRange('pr.received_at')})
              OR EXISTS (SELECT 1 FROM purchase_payments pp
                          WHERE pp.purchase_id = pu.id AND ${inRange('pp.paid_at')}))`,
  select: `pu.id::text AS id, pu.reference_no AS no, ${day('pu.order_date')} AS date, s.name AS supplier,
           pu.status, pu.total_cents, pu.paid_cents, pu.payment_status, pu.supplier_invoice_no,
           pu.additional_costs_cents, pu.tax_cents, pu.notes, u.full_name AS by_name`,
  order: 'pu.order_date, pu.created_at, pu.id',
  attach: async (ctx, rows) => {
    const ids = rows.map((r) => r.id);
    const lines = await childrenOf<PurchaseLine>(
      ctx,
      `SELECT i.purchase_id::text AS parent, i.description, i.quantity_ordered_milli,
              i.quantity_received_milli, i.quantity_returned_milli, i.unit_cost_mills, i.line_total_cents
         FROM purchase_items i WHERE i.purchase_id = ANY($1::uuid[]) ORDER BY i.purchase_id, i.line_no`,
      ids,
    );
    const receipts = await childrenOf<PurchaseReceipt>(
      ctx,
      `SELECT r.purchase_id::text AS parent, ${ts('r.received_at', '$2')} AS at, u.full_name AS by_name,
              r.delivery_note_no, r.notes
         FROM purchase_receipts r LEFT JOIN users u ON u.id = r.received_by
        WHERE r.purchase_id = ANY($1::uuid[]) ORDER BY r.received_at, r.id`,
      ids,
      true,
    );
    const payments = await childrenOf<PurchasePayment>(
      ctx,
      `SELECT p.purchase_id::text AS parent, ${ts('p.paid_at', '$2')} AS at, p.amount_cents, p.method,
              (p.shift_id IS NOT NULL) AS from_drawer
         FROM purchase_payments p WHERE p.purchase_id = ANY($1::uuid[]) ORDER BY p.paid_at, p.id`,
      ids,
      true,
    );
    const returns = await childrenOf<PurchaseReturn>(
      ctx,
      `SELECT r.purchase_id::text AS parent, r.return_no AS no, ${ts('r.created_at', '$2')} AS at,
              r.total_cents, r.reason, r.status
         FROM purchase_returns r WHERE r.purchase_id = ANY($1::uuid[]) ORDER BY r.created_at, r.id`,
      ids,
      true,
    );
    for (const row of rows) {
      row.lines = lines.get(row.id) ?? [];
      row.receipts = receipts.get(row.id) ?? [];
      row.payments = payments.get(row.id) ?? [];
      row.returns = returns.get(row.id) ?? [];
    }
  },
  spec: (ctx) => {
    const w = word(ctx);
    return {
      title: l('Blerjet nga furnitorët', 'Purchases from suppliers'),
      note: l(
        'Blerje e porositur në periudhë, ose me mall të pranuar a pagesë të bërë në periudhë.',
        'A purchase ordered in the period, or with goods received or money paid in the period.',
      ),
      columns: [
        { label: l('Nr', 'No'), get: (r) => r.no },
        { label: l('Data', 'Date'), get: (r) => r.date },
        { label: l('Furnitori', 'Supplier'), get: (r) => r.supplier },
        { label: l('Statusi', 'Status'), get: (r) => w('purchaseStatus', r.status) },
        { label: l('Totali', 'Total'), kind: 'money', get: (r) => r.total_cents },
        { label: l('Paguar', 'Paid'), kind: 'money', get: (r) => r.paid_cents },
        { label: l('Pagesa', 'Payment'), get: (r) => w('paymentStatus', r.payment_status) },
        {
          label: l('Fatura e furnitorit', 'Supplier invoice'),
          optional: true,
          get: (r) => r.supplier_invoice_no,
        },
        {
          label: l('Kosto shtesë', 'Extra costs'),
          kind: 'money',
          optional: true,
          get: (r) => positive(r.additional_costs_cents),
        },
        {
          label: l('TVSH', 'VAT'),
          kind: 'money',
          optional: true,
          get: (r) => positive(r.tax_cents),
        },
        { label: l('Nga', 'By'), optional: true, get: (r) => r.by_name },
        { label: l('Shënim', 'Note'), optional: true, get: (r) => r.notes },
      ],
      children: [
        child<PurchaseRow, PurchaseLine>({
          title: l('Artikujt', 'Lines'),
          tag: l('artikull', 'line'),
          rows: (r) => r.lines ?? [],
          columns: [
            { label: l('Artikulli', 'Item'), get: (i) => i.description },
            { label: l('Porositur', 'Ordered'), kind: 'qty', get: (i) => i.quantity_ordered_milli },
            { label: l('Pranuar', 'Received'), kind: 'qty', get: (i) => i.quantity_received_milli },
            {
              label: l('Kosto për njësi', 'Unit cost'),
              kind: 'mills',
              get: (i) => i.unit_cost_mills,
            },
            { label: l('Totali', 'Total'), kind: 'money', get: (i) => i.line_total_cents },
            {
              label: l('Kthyer', 'Returned'),
              kind: 'qty',
              optional: true,
              get: (i) => positive(i.quantity_returned_milli),
            },
          ],
        }),
        child<PurchaseRow, PurchaseReceipt>({
          title: l('Pranimet', 'Receipts of goods'),
          tag: l('pranim', 'goods received'),
          rows: (r) => r.receipts ?? [],
          columns: [
            { label: l('Koha', 'Time'), get: (i) => i.at },
            { label: l('Nga', 'By'), get: (i) => i.by_name },
            {
              label: l('Fletëdërgesa', 'Delivery note'),
              optional: true,
              get: (i) => i.delivery_note_no,
            },
            { label: l('Shënim', 'Note'), optional: true, get: (i) => i.notes },
          ],
        }),
        child<PurchaseRow, PurchasePayment>({
          title: l('Pagesat', 'Payments'),
          tag: l('pagesë', 'payment'),
          rows: (r) => r.payments ?? [],
          columns: [
            { label: l('Koha', 'Time'), get: (i) => i.at },
            { label: l('Shuma', 'Amount'), kind: 'money', get: (i) => i.amount_cents },
            { label: l('Mënyra', 'Method'), get: (i) => w('method', i.method) },
            {
              label: l('Paguar nga arka', 'Paid from the drawer'),
              kind: 'bool',
              optional: true,
              get: (i) => onlyTrue(i.from_drawer),
            },
          ],
        }),
        child<PurchaseRow, PurchaseReturn>({
          title: l('Kthimet te furnitori', 'Returns to the supplier'),
          tag: l('kthim', 'return'),
          rows: (r) => r.returns ?? [],
          columns: [
            { label: l('Nr', 'No'), get: (i) => i.no },
            { label: l('Koha', 'Time'), get: (i) => i.at },
            { label: l('Shuma', 'Amount'), kind: 'money', get: (i) => i.total_cents },
            { label: l('Arsyeja', 'Reason'), get: (i) => i.reason },
            { label: l('Statusi', 'Status'), get: (i) => w('returnStatus', i.status) },
          ],
        }),
      ],
    };
  },
});

interface StaffLine {
  parent: string;
  description: string;
  quantity_milli: number;
  unit_cost_cents: number;
  line_cost_cents: number;
}
interface StaffPurchaseRow {
  id: string;
  at: string;
  by_name: string | null;
  total_cost_cents: number;
  source_receipt_no: string | null;
  lines?: StaffLine[];
}

const staffPurchases = define<StaffPurchaseRow>({
  id: 'staffPurchases',
  part: 'purchases',
  params: 'period',
  weight: 2,
  source: `FROM staff_purchases sp LEFT JOIN users u ON u.id = sp.created_by
           WHERE ${inRange('sp.created_at')}`,
  select: `sp.id::text AS id, ${ts('sp.created_at')} AS at, u.full_name AS by_name,
           sp.total_cost_cents, sp.source_receipt_no`,
  order: 'sp.created_at, sp.id',
  attach: async (ctx, rows) => {
    const lines = await childrenOf<StaffLine>(
      ctx,
      `SELECT i.staff_purchase_id::text AS parent, i.description, i.quantity_milli, i.unit_cost_cents,
              i.line_cost_cents
         FROM staff_purchase_items i WHERE i.staff_purchase_id = ANY($1::uuid[])
        ORDER BY i.staff_purchase_id, i.description`,
      rows.map((r) => r.id),
    );
    for (const row of rows) row.lines = lines.get(row.id) ?? [];
  },
  spec: () => ({
    title: l('Blerjet e stafit', 'Staff purchases'),
    note: l(
      'Mall që e mori stafi me çmim kostoje: del nga stoku dhe shkruhet si shpenzim, pa para në arkë.',
      'Goods the staff took at cost: they leave the stock and are booked as an expense, with no money in the drawer.',
    ),
    columns: [
      { label: l('Koha', 'Time'), get: (r) => r.at },
      { label: l('Regjistruar nga', 'Entered by'), get: (r) => r.by_name },
      { label: l('Kosto', 'Cost'), kind: 'money', get: (r) => r.total_cost_cents },
      { label: l('Nga fatura', 'From receipt'), optional: true, get: (r) => r.source_receipt_no },
    ],
    children: [
      child<StaffPurchaseRow, StaffLine>({
        title: l('Artikujt', 'Lines'),
        tag: l('artikull', 'line'),
        rows: (r) => r.lines ?? [],
        columns: [
          { label: l('Artikulli', 'Item'), get: (i) => i.description },
          { label: l('Sasia', 'Qty'), kind: 'qty', get: (i) => i.quantity_milli },
          {
            label: l('Kosto për njësi', 'Unit cost'),
            kind: 'money',
            get: (i) => i.unit_cost_cents,
          },
          { label: l('Kosto', 'Cost'), kind: 'money', get: (i) => i.line_cost_cents },
        ],
      }),
    ],
  }),
});

// ─── Customers' debts, balance movements, invoices ─────────────────────────────

interface DebtPayment {
  parent: string;
  at: string;
  amount_cents: number;
  method: string | null;
}
interface DebtInstallment {
  parent: string;
  seq: number;
  amount_cents: number;
  paid_cents: number;
  due: string;
}
interface DebtRow {
  id: string;
  created: string;
  customer_code: string;
  customer_name: string;
  amount_cents: number;
  paid_cents: number;
  status: string;
  due: string;
  sale_no: string | null;
  installment_count: number | null;
  notes: string | null;
  written_off_reason: string | null;
  settled: string | null;
  payments?: DebtPayment[];
  installments?: DebtInstallment[];
}

const debts = define<DebtRow>({
  id: 'debts',
  part: 'customers',
  params: 'period',
  weight: 3,
  // Given in the period, paid towards in the period, or still open today.
  source: `FROM customer_debts d
            JOIN customers c ON c.id = d.customer_id
            LEFT JOIN sales s ON s.id = d.sale_id
           WHERE (${inRange('d.created_at')} OR d.status IN ('open', 'partial')
              OR EXISTS (SELECT 1 FROM debt_payments dp
                          WHERE dp.debt_id = d.id AND ${inRange('dp.created_at')}))`,
  select: `d.id::text AS id, ${ts('d.created_at')} AS created, c.code AS customer_code,
           c.name AS customer_name, d.amount_cents, d.paid_cents, d.status, ${day('d.due_date')} AS due,
           CASE WHEN s.id IS NULL THEN NULL ELSE ${saleNo('s')} END AS sale_no, d.installment_count,
           d.notes, d.written_off_reason, ${ts('d.settled_at')} AS settled`,
  order: 'd.created_at, d.id',
  attach: async (ctx, rows) => {
    const ids = rows.map((r) => r.id);
    const payments = await childrenOf<DebtPayment>(
      ctx,
      `SELECT dp.debt_id::text AS parent, ${ts('dp.created_at', '$2')} AS at, dp.amount_cents, p.method
         FROM debt_payments dp LEFT JOIN payments p ON p.id = dp.payment_id
        WHERE dp.debt_id = ANY($1::uuid[]) ORDER BY dp.created_at, dp.id`,
      ids,
      true,
    );
    const installments = await childrenOf<DebtInstallment>(
      ctx,
      `SELECT i.debt_id::text AS parent, i.seq, i.amount_cents, i.paid_cents, ${day('i.due_date')} AS due
         FROM debt_installments i WHERE i.debt_id = ANY($1::uuid[]) ORDER BY i.debt_id, i.seq`,
      ids,
    );
    for (const row of rows) {
      row.payments = payments.get(row.id) ?? [];
      row.installments = installments.get(row.id) ?? [];
    }
  },
  spec: (ctx) => {
    const w = word(ctx);
    return {
      title: l('Borxhet e klientëve', 'Customer debts'),
      note: l(
        'Borxhe të dhëna në periudhë, me pagesë në periudhë, ose ende të hapura sot.',
        'Debts given in the period, paid towards in the period, or still open today.',
      ),
      columns: [
        { label: l('Dhënë më', 'Given at'), get: (r) => r.created },
        {
          label: l('Klienti', 'Customer'),
          get: (r) => customerLabel(ctx, r.customer_code, r.customer_name),
        },
        { label: l('Shuma', 'Amount'), kind: 'money', get: (r) => r.amount_cents },
        { label: l('Paguar', 'Paid'), kind: 'money', get: (r) => r.paid_cents },
        {
          label: l('Mbetja', 'Left to pay'),
          kind: 'money',
          get: (r) =>
            r.status === 'written_off' || r.status === 'paid' ? 0 : r.amount_cents - r.paid_cents,
        },
        { label: l('Statusi', 'Status'), get: (r) => w('debtStatus', r.status) },
        { label: l('Afati', 'Due'), get: (r) => r.due },
        { label: l('Fatura', 'Receipt'), optional: true, get: (r) => r.sale_no },
        {
          label: l('Këste', 'Instalments'),
          kind: 'int',
          optional: true,
          get: (r) => positive(r.installment_count),
        },
        { label: l('Mbyllur më', 'Settled at'), optional: true, get: (r) => r.settled },
        {
          label: l('Arsyeja e faljes', 'Write-off reason'),
          optional: true,
          get: (r) => r.written_off_reason,
        },
        { label: l('Shënim', 'Note'), optional: true, get: (r) => typedNote(ctx, r.notes) },
      ],
      children: [
        child<DebtRow, DebtPayment>({
          title: l('Pagesat', 'Payments'),
          tag: l('pagesë', 'payment'),
          rows: (r) => r.payments ?? [],
          columns: [
            { label: l('Koha', 'Time'), get: (i) => i.at },
            { label: l('Shuma', 'Amount'), kind: 'money', get: (i) => i.amount_cents },
            { label: l('Mënyra', 'Method'), get: (i) => w('method', i.method) },
          ],
        }),
        child<DebtRow, DebtInstallment>({
          title: l('Këstet', 'Instalments'),
          tag: l('këst', 'instalment'),
          rows: (r) => r.installments ?? [],
          columns: [
            { label: l('Nr', 'No'), kind: 'int', get: (i) => i.seq },
            { label: l('Shuma', 'Amount'), kind: 'money', get: (i) => i.amount_cents },
            { label: l('Paguar', 'Paid'), kind: 'money', get: (i) => i.paid_cents },
            { label: l('Afati', 'Due'), get: (i) => i.due },
          ],
        }),
      ],
    };
  },
});

interface LedgerRow {
  at: string;
  customer_code: string;
  customer_name: string;
  entry_type: string;
  amount_cents: number;
  points_delta: number;
  balance_after_cents: number | null;
  note: string | null;
  by_name: string | null;
}

const customerLedger = define<LedgerRow>({
  id: 'customerLedger',
  part: 'customers',
  params: 'period',
  weight: 1,
  source: `FROM customer_ledger g
            JOIN customers c ON c.id = g.customer_id
            LEFT JOIN users u ON u.id = g.created_by
           WHERE ${inRange('g.created_at')}`,
  select: `${ts('g.created_at')} AS at, c.code AS customer_code, c.name AS customer_name, g.entry_type,
           g.amount_cents, g.points_delta, g.balance_after_cents, g.note, u.full_name AS by_name`,
  order: 'g.created_at, g.id',
  spec: (ctx) => {
    const w = word(ctx);
    return {
      title: l('Lëvizjet e balancës së klientëve', 'Customer balance movements'),
      note: l(
        'Paratë që klientët i lanë në balancë, i shpenzuan prej saj ose iu kthyen, dhe pikët.',
        'Money customers put on their balance, spent from it or got back, and their points.',
      ),
      columns: [
        { label: l('Koha', 'Time'), get: (r) => r.at },
        {
          label: l('Klienti', 'Customer'),
          get: (r) => customerLabel(ctx, r.customer_code, r.customer_name),
        },
        { label: l('Lloji', 'Kind'), get: (r) => w('ledgerEntry', r.entry_type) },
        { label: l('Shuma', 'Amount'), kind: 'money', get: (r) => r.amount_cents },
        {
          label: l('Balanca pas', 'Balance after'),
          kind: 'money',
          optional: true,
          get: (r) => r.balance_after_cents,
        },
        {
          label: l('Pikë', 'Points'),
          kind: 'int',
          optional: true,
          get: (r) => nonZero(r.points_delta),
        },
        { label: l('Nga', 'By'), optional: true, get: (r) => r.by_name },
        { label: l('Shënim', 'Note'), optional: true, get: (r) => typedNote(ctx, r.note) },
      ],
    };
  },
});

interface InvoiceRow {
  no: string;
  kind: string;
  at: string;
  sale_no: string;
  total_cents: number;
  status: string;
  customer_code: string | null;
  customer_name: string | null;
  billing_name: string | null;
  due: string | null;
  void_reason: string | null;
}

const invoices = define<InvoiceRow>({
  id: 'invoices',
  part: 'customers',
  params: 'period',
  weight: 1,
  source: `FROM invoices i
            JOIN sales s ON s.id = i.sale_id
            LEFT JOIN customers c ON c.id = i.customer_id
           WHERE ${inRange('i.issued_at')}`,
  select: `i.invoice_no AS no, i.kind, ${ts('i.issued_at')} AS at, ${saleNo('s')} AS sale_no,
           s.total_cents, i.status, c.code AS customer_code, c.name AS customer_name, i.billing_name,
           ${day('i.due_at')} AS due, i.void_reason`,
  order: 'i.issued_at, i.id',
  spec: (ctx) => {
    const w = word(ctx);
    return {
      title: l('Faturat e lëshuara', 'Invoices issued'),
      columns: [
        { label: l('Nr', 'No'), get: (r) => r.no },
        { label: l('Lloji', 'Kind'), get: (r) => w('invoiceKind', r.kind) },
        { label: l('Lëshuar më', 'Issued at'), get: (r) => r.at },
        { label: l('Shitja', 'Sale'), get: (r) => r.sale_no },
        { label: l('Totali', 'Total'), kind: 'money', get: (r) => r.total_cents },
        { label: l('Statusi', 'Status'), get: (r) => w('invoiceStatus', r.status) },
        {
          label: l('Klienti', 'Customer'),
          optional: true,
          get: (r) =>
            customerLabel(ctx, r.customer_code, r.customer_name) ?? typedName(ctx, r.billing_name),
        },
        { label: l('Afati', 'Due'), optional: true, get: (r) => r.due },
        {
          label: l('Arsyeja e anulimit', 'Void reason'),
          optional: true,
          get: (r) => r.void_reason,
        },
      ],
    };
  },
});

// ─── Lists as they are now ($1 = time zone) ────────────────────────────────────

interface ProductRow {
  name: string;
  variant_label: string | null;
  sku: string;
  category: string | null;
  kind: string;
  selling_price_mills: number;
  average_cost_mills: number;
  purchase_cost_mills: number;
  stock_milli: number;
  min_stock_milli: number;
  track_stock: boolean;
  is_active: boolean;
  unit_code: string;
  barcode: string | null;
  supplier: string | null;
  codes_available: number | null;
  codes_sold: number | null;
}

const products = define<ProductRow>({
  id: 'products',
  part: 'lists',
  params: 'now',
  weight: 1,
  source: `FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            LEFT JOIN suppliers s ON s.id = p.supplier_id
           WHERE true`,
  select: `p.name, p.variant_label, p.sku, c.name AS category, p.kind, p.selling_price_mills,
           p.average_cost_mills, p.purchase_cost_mills, p.stock_milli, p.min_stock_milli,
           p.track_stock, p.is_active, p.unit_code,
           (SELECT b.barcode FROM product_barcodes b WHERE b.product_id = p.id
             ORDER BY b.is_primary DESC, b.created_at LIMIT 1) AS barcode,
           s.name AS supplier,
           CASE WHEN p.kind = 'internet_access' THEN
             (SELECT count(*)::int FROM internet_access_codes k
               WHERE k.product_id = p.id AND k.status = 'available') END AS codes_available,
           CASE WHEN p.kind = 'internet_access' THEN
             (SELECT count(*)::int FROM internet_access_codes k
               WHERE k.product_id = p.id AND k.status = 'sold') END AS codes_sold`,
  order: 'p.is_active DESC, p.name, p.id',
  spec: (ctx) => {
    const w = word(ctx);
    return {
      title: l('Produktet (gjendja tani)', 'Products (as they are now)'),
      note: l(
        'Çmimi i shitjes, kostoja dhe stoku i sotëm. Vlera e stokut = stoku × kostoja mesatare.',
        "Today's selling price, cost and stock. Stock value = stock × average cost.",
      ),
      columns: [
        { label: l('Produkti', 'Product'), get: (r) => r.name },
        { label: l('SKU', 'SKU'), get: (r) => r.sku },
        { label: l('Kategoria', 'Category'), get: (r) => r.category },
        { label: l('Çmimi', 'Price'), kind: 'mills', get: (r) => r.selling_price_mills },
        {
          label: l('Kosto mesatare', 'Average cost'),
          kind: 'mills',
          get: (r) => r.average_cost_mills,
        },
        {
          label: l('Stoku', 'Stock'),
          kind: 'qty',
          get: (r) => (r.track_stock ? r.stock_milli : null),
        },
        {
          label: l('Vlera e stokut', 'Stock value'),
          kind: 'money',
          optional: true,
          get: (r) =>
            r.track_stock && r.stock_milli > 0
              ? Math.round((r.stock_milli * r.average_cost_mills) / 10_000)
              : null,
        },
        {
          label: l('Stoku minimal', 'Minimum stock'),
          kind: 'qty',
          optional: true,
          get: (r) => positive(r.min_stock_milli),
        },
        {
          label: l('Kosto e blerjes së fundit', 'Last purchase cost'),
          kind: 'mills',
          optional: true,
          get: (r) =>
            r.purchase_cost_mills > 0 && r.purchase_cost_mills !== r.average_cost_mills
              ? r.purchase_cost_mills
              : null,
        },
        { label: l('Varianti', 'Variant'), optional: true, get: (r) => r.variant_label },
        { label: l('Barkodi', 'Barcode'), optional: true, get: (r) => r.barcode },
        {
          label: l('Lloji', 'Kind'),
          optional: true,
          get: (r) => (r.kind === 'standard' ? null : w('productKind', r.kind)),
        },
        {
          label: l('Kode të lira', 'Codes available'),
          kind: 'int',
          optional: true,
          get: (r) => r.codes_available,
        },
        {
          label: l('Kode të shitura', 'Codes sold'),
          kind: 'int',
          optional: true,
          get: (r) => r.codes_sold,
        },
        {
          label: l('Njësia', 'Unit'),
          optional: true,
          get: (r) => (r.unit_code === 'pc' ? null : r.unit_code),
        },
        { label: l('Furnitori', 'Supplier'), optional: true, get: (r) => r.supplier },
        {
          label: l('Stoku nuk ndiqet', 'Stock not tracked'),
          kind: 'bool',
          optional: true,
          get: (r) => onlyTrue(!r.track_stock),
        },
        {
          label: l('Joaktiv', 'Inactive'),
          kind: 'bool',
          optional: true,
          get: (r) => onlyTrue(!r.is_active),
        },
      ],
    };
  },
});

interface OfferLine {
  parent: string;
  product: string;
  quantity_milli: number;
}
interface OfferRow {
  id: string;
  name: string;
  price_cents: number;
  minutes: number;
  is_active: boolean;
  lines?: OfferLine[];
}

const offers = define<OfferRow>({
  id: 'offers',
  part: 'lists',
  params: 'now',
  weight: 2,
  source: 'FROM offers o WHERE true',
  select: 'o.id::text AS id, o.name, o.price_cents, o.minutes, o.is_active',
  order: 'o.is_active DESC, o.name, o.id',
  attach: async (ctx, rows) => {
    const lines = await childrenOf<OfferLine>(
      ctx,
      `SELECT i.offer_id::text AS parent, p.name AS product, i.quantity_milli
         FROM offer_items i JOIN products p ON p.id = i.product_id
        WHERE i.offer_id = ANY($1::uuid[]) ORDER BY i.offer_id, i.sort_order`,
      rows.map((r) => r.id),
    );
    for (const row of rows) row.lines = lines.get(row.id) ?? [];
  },
  spec: () => ({
    title: l('Ofertat', 'Offers'),
    note: l(
      'Produkte dhe minuta PC-je me një çmim të vetëm.',
      'Products and PC minutes at one price.',
    ),
    columns: [
      { label: l('Oferta', 'Offer'), get: (r) => r.name },
      { label: l('Çmimi', 'Price'), kind: 'money', get: (r) => r.price_cents },
      { label: l('Minuta PC', 'PC minutes'), kind: 'int', get: (r) => r.minutes },
      { label: l('Aktive', 'Active'), kind: 'bool', get: (r) => r.is_active },
    ],
    children: [
      child<OfferRow, OfferLine>({
        title: l('Produktet', 'Products'),
        tag: l('produkt', 'product'),
        rows: (r) => r.lines ?? [],
        columns: [
          { label: l('Produkti', 'Product'), get: (i) => i.product },
          { label: l('Sasia', 'Qty'), kind: 'qty', get: (i) => i.quantity_milli },
        ],
      }),
    ],
  }),
});

interface PricingRow {
  name: string;
  rate_cents_per_hour: number;
  is_active: boolean;
  station: string | null;
  days_of_week: number[] | null;
  start_time: string | null;
  end_time: string | null;
  billing_increment_minutes: number;
  minimum_charge_cents: number;
  minimum_minutes: number;
  free_minutes: number;
  is_happy_hour: boolean;
  priority: number;
  valid_from: string | null;
  valid_to: string | null;
}

const pricing = define<PricingRow>({
  id: 'pricing',
  part: 'lists',
  params: 'now',
  weight: 1,
  source: 'FROM pricing_rules r LEFT JOIN stations st ON st.id = r.station_id WHERE true',
  select: `r.name, r.rate_cents_per_hour, r.is_active, st.code AS station, r.days_of_week,
           ${hhmm('r.start_time')} AS start_time, ${hhmm('r.end_time')} AS end_time,
           r.billing_increment_minutes, r.minimum_charge_cents, r.minimum_minutes, r.free_minutes,
           r.is_happy_hour, r.priority, ${day('r.valid_from')} AS valid_from,
           ${day('r.valid_to')} AS valid_to`,
  order: 'r.is_active DESC, r.priority DESC, r.name, r.id',
  spec: (ctx) => ({
    title: l('Çmimet e kohës në PC', 'Prices of PC time'),
    columns: [
      { label: l('Rregulla', 'Rule'), get: (r) => r.name },
      {
        label: l('Çmimi për orë', 'Price per hour'),
        kind: 'money',
        get: (r) => r.rate_cents_per_hour,
      },
      { label: l('Aktive', 'Active'), kind: 'bool', get: (r) => r.is_active },
      { label: l('Vetëm për PC', 'Only for PC'), optional: true, get: (r) => r.station },
      { label: l('Ditët', 'Days'), optional: true, get: (r) => weekdays(ctx, r.days_of_week) },
      { label: l('Nga ora', 'From'), optional: true, get: (r) => r.start_time },
      { label: l('Deri në orën', 'Until'), optional: true, get: (r) => r.end_time },
      {
        label: l('Minuta falas', 'Free minutes'),
        kind: 'int',
        optional: true,
        get: (r) => positive(r.free_minutes),
      },
      {
        label: l('Pagesa më e vogël', 'Minimum charge'),
        kind: 'money',
        optional: true,
        get: (r) => positive(r.minimum_charge_cents),
      },
      {
        label: l('Minutat më të pakta', 'Minimum minutes'),
        kind: 'int',
        optional: true,
        get: (r) => positive(r.minimum_minutes),
      },
      {
        label: l('Faturohet çdo (minuta)', 'Charged every (minutes)'),
        kind: 'int',
        optional: true,
        get: (r) => (r.billing_increment_minutes > 1 ? r.billing_increment_minutes : null),
      },
      {
        label: l('Happy hour', 'Happy hour'),
        kind: 'bool',
        optional: true,
        get: (r) => onlyTrue(r.is_happy_hour),
      },
      { label: l('Vlen nga', 'Valid from'), optional: true, get: (r) => r.valid_from },
      { label: l('Vlen deri', 'Valid to'), optional: true, get: (r) => r.valid_to },
    ],
  }),
});

interface PackageRow {
  name: string;
  duration_minutes: number;
  price_cents: number;
  is_active: boolean;
  days_of_week: number[] | null;
  start_time: string | null;
  end_time: string | null;
  is_promotional: boolean;
  valid_from: string | null;
  valid_to: string | null;
}

const packages = define<PackageRow>({
  id: 'packages',
  part: 'lists',
  params: 'now',
  weight: 1,
  source: 'FROM gaming_packages k WHERE true',
  select: `k.name, k.duration_minutes, k.price_cents, k.is_active, k.days_of_week,
           ${hhmm('k.start_time')} AS start_time, ${hhmm('k.end_time')} AS end_time, k.is_promotional,
           ${day('k.valid_from')} AS valid_from, ${day('k.valid_to')} AS valid_to`,
  order: 'k.is_active DESC, k.sort_order, k.name, k.id',
  spec: (ctx) => ({
    title: l('Paketat e kohës', 'Time packages'),
    columns: [
      { label: l('Paketa', 'Package'), get: (r) => r.name },
      { label: l('Minuta', 'Minutes'), kind: 'int', get: (r) => r.duration_minutes },
      { label: l('Çmimi', 'Price'), kind: 'money', get: (r) => r.price_cents },
      { label: l('Aktive', 'Active'), kind: 'bool', get: (r) => r.is_active },
      { label: l('Ditët', 'Days'), optional: true, get: (r) => weekdays(ctx, r.days_of_week) },
      { label: l('Nga ora', 'From'), optional: true, get: (r) => r.start_time },
      { label: l('Deri në orën', 'Until'), optional: true, get: (r) => r.end_time },
      {
        label: l('Promocionale', 'Promotional'),
        kind: 'bool',
        optional: true,
        get: (r) => onlyTrue(r.is_promotional),
      },
      { label: l('Vlen nga', 'Valid from'), optional: true, get: (r) => r.valid_from },
      { label: l('Vlen deri', 'Valid to'), optional: true, get: (r) => r.valid_to },
    ],
  }),
});

interface StationRow {
  number: number;
  code: string;
  name: string;
  zone: string | null;
  is_enabled: boolean;
  archived: boolean;
}

const stations = define<StationRow>({
  id: 'stations',
  part: 'lists',
  params: 'now',
  weight: 1,
  source: 'FROM stations st WHERE true',
  select: `st.number, st.code, st.name, st.zone, st.is_enabled, (st.archived_at IS NOT NULL) AS archived`,
  order: 'st.number, st.id',
  spec: () => ({
    title: l('PC-të', 'PCs'),
    columns: [
      { label: l('Nr', 'No'), kind: 'int', get: (r) => r.number },
      { label: l('Kodi', 'Code'), get: (r) => r.code },
      { label: l('Emri', 'Name'), get: (r) => r.name },
      { label: l('Zona', 'Zone'), optional: true, get: (r) => r.zone },
      {
        label: l('E çaktivizuar', 'Disabled'),
        kind: 'bool',
        optional: true,
        get: (r) => onlyTrue(!r.is_enabled),
      },
      {
        label: l('E arkivuar', 'Archived'),
        kind: 'bool',
        optional: true,
        get: (r) => onlyTrue(r.archived),
      },
    ],
  }),
});

interface CustomerRow {
  code: string;
  name: string;
  phone: string | null;
  email: string | null;
  wallet_balance_cents: number;
  balance_due_cents: number;
  status: string;
  membership: string | null;
  membership_until: string | null;
  loyalty_points: number;
  discount_bp: number;
  credit_enabled: boolean;
  credit_limit_cents: number;
  created: string;
  notes: string | null;
}

const customers = define<CustomerRow>({
  id: 'customers',
  part: 'lists',
  params: 'now',
  weight: 1,
  source: 'FROM customers c WHERE true',
  select: `c.code, c.name, c.phone, c.email, c.wallet_balance_cents, c.balance_due_cents, c.status,
           c.membership, ${day('c.membership_until')} AS membership_until, c.loyalty_points,
           c.discount_bp, c.credit_enabled, c.credit_limit_cents, ${ts('c.created_at', '$1')} AS created,
           c.notes`,
  order: 'c.code, c.id',
  spec: (ctx) => {
    const w = word(ctx);
    const personal: Column<CustomerRow>[] = ctx.hideCustomers
      ? []
      : [
          { label: l('Emri', 'Name'), get: (r) => r.name },
          { label: l('Telefoni', 'Phone'), optional: true, get: (r) => r.phone },
          { label: l('Email', 'E-mail'), optional: true, get: (r) => r.email },
          { label: l('Shënim', 'Note'), optional: true, get: (r) => r.notes },
        ];
    return {
      title: l('Klientët (gjendja tani)', 'Customers (as they are now)'),
      note: l(
        'Balanca = para që klienti i ka lënë te ne. Borxhi = sa na ka borxh klienti.',
        'Balance = money the customer left with us. Debt = what the customer owes us.',
      ),
      columns: [
        { label: l('Kodi', 'Code'), get: (r) => r.code },
        ...personal.filter((c) => !c.optional),
        { label: l('Balanca', 'Balance'), kind: 'money', get: (r) => r.wallet_balance_cents },
        { label: l('Borxhi', 'Debt'), kind: 'money', get: (r) => r.balance_due_cents },
        { label: l('Statusi', 'Status'), get: (r) => w('customerStatus', r.status) },
        ...personal.filter((c) => c.optional),
        {
          label: l('Pikë', 'Points'),
          kind: 'int',
          optional: true,
          get: (r) => positive(r.loyalty_points),
        },
        {
          label: l('Zbritja e përhershme', 'Standing discount'),
          kind: 'percent',
          optional: true,
          get: (r) => positive(r.discount_bp),
        },
        {
          label: l('Kufiri i borxhit', 'Credit limit'),
          kind: 'money',
          optional: true,
          get: (r) => (r.credit_enabled ? positive(r.credit_limit_cents) : null),
        },
        { label: l('Anëtarësia', 'Membership'), optional: true, get: (r) => r.membership },
        {
          label: l('Anëtarësia deri', 'Membership until'),
          optional: true,
          get: (r) => r.membership_until,
        },
        { label: l('Regjistruar më', 'Registered at'), optional: true, get: (r) => r.created },
      ],
    };
  },
});

interface SupplierRow {
  name: string;
  is_active: boolean;
  business_name: string | null;
  phone: string | null;
  owed_cents: number;
}

const suppliers = define<SupplierRow>({
  id: 'suppliers',
  part: 'lists',
  params: 'now',
  weight: 1,
  source: 'FROM suppliers s WHERE true',
  select: `s.name, s.is_active, s.business_name, s.phone,
           COALESCE((SELECT SUM(pu.total_cents - pu.paid_cents) FROM purchases pu
                      WHERE pu.supplier_id = s.id
                        AND pu.status IN ('ordered', 'partially_received', 'received')), 0)::bigint AS owed_cents`,
  order: 's.name, s.id',
  spec: () => ({
    title: l('Furnitorët', 'Suppliers'),
    columns: [
      { label: l('Furnitori', 'Supplier'), get: (r) => r.name },
      { label: l('Ia kemi borxh', 'We owe'), kind: 'money', get: (r) => r.owed_cents },
      { label: l('Aktiv', 'Active'), kind: 'bool', get: (r) => r.is_active },
      { label: l('Emri i biznesit', 'Business name'), optional: true, get: (r) => r.business_name },
      { label: l('Telefoni', 'Phone'), optional: true, get: (r) => r.phone },
    ],
  }),
});

interface UserRow {
  full_name: string;
  username: string;
  roles: string | null;
  is_active: boolean;
  last_login: string | null;
}

const users = define<UserRow>({
  id: 'users',
  part: 'lists',
  params: 'now',
  weight: 1,
  source: 'FROM users u WHERE true',
  select: `u.full_name, u.username,
           (SELECT string_agg(r.code, ',' ORDER BY r.rank)
              FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS roles,
           u.is_active, ${ts('u.last_login_at', '$1')} AS last_login`,
  order: 'u.full_name, u.id',
  spec: (ctx) => {
    const w = word(ctx);
    return {
      title: l('Punonjësit', 'Staff'),
      columns: [
        { label: l('Emri', 'Name'), get: (r) => r.full_name },
        { label: l('Përdoruesi', 'User name'), get: (r) => r.username },
        {
          label: l('Roli', 'Role'),
          get: (r) =>
            r.roles
              ?.split(',')
              .map((code) => w('role', code))
              .join(', ') ?? null,
        },
        { label: l('Aktiv', 'Active'), kind: 'bool', get: (r) => r.is_active },
        { label: l('Hyrja e fundit', 'Last sign-in'), optional: true, get: (r) => r.last_login },
      ],
    };
  },
});

// ─── The action log (only when asked for) ──────────────────────────────────────

/**
 * The only details of an action that go into the file: amounts, minutes, reasons and the numbers
 * a person knows a document by. Everything else an action recorded (ids, device names, network
 * addresses, file names, customer names) stays out.
 */
const AUDIT_DETAIL_KEYS: readonly [key: string, label: Label, money: boolean][] = [
  ['receiptNo', l('fatura', 'receipt'), false],
  ['refundNo', l('kthimi', 'refund'), false],
  ['totalCents', l('totali', 'total'), true],
  ['amountCents', l('shuma', 'amount'), true],
  ['priceCents', l('çmimi', 'price'), true],
  ['discountCents', l('zbritja', 'discount'), true],
  ['openingCents', l('gjendja fillestare', 'opening float'), true],
  ['differenceCents', l('diferenca', 'difference'), true],
  ['minutes', l('minuta', 'minutes'), false],
  ['stationCode', l('PC', 'PC'), false],
  ['stations', l('PC-të', 'PCs'), false],
  ['billingMode', l('mënyra', 'mode'), false],
  ['paymentMethod', l('pagesa', 'payment'), false],
  ['categoryCode', l('kategoria', 'category'), false],
  ['reason', l('arsyeja', 'reason'), false],
];

export function auditDetail(details: unknown, lang: Lang): string | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const d = details as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, label, money] of AUDIT_DETAIL_KEYS) {
    const v = d[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (money && v === 0) continue;
      parts.push(`${label[lang]} ${money ? (v / 100).toFixed(2) : v}`);
    } else if (typeof v === 'string' && v.trim()) {
      parts.push(`${label[lang]} ${v.trim().slice(0, 200)}`);
    }
  }
  return parts.join(', ') || null;
}

interface AuditRow {
  at: string;
  actor: string | null;
  action: string;
  entity_type: string | null;
  severity: string;
  details: unknown;
}

const audit = define<AuditRow>({
  id: 'audit',
  part: 'audit',
  params: 'period',
  weight: 1,
  source: `FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
           WHERE ${inRange('a.occurred_at')}`,
  // A PC acts under its machine name: only a staff member is named.
  select: `${ts('a.occurred_at')} AS at, u.full_name AS actor, a.action, a.entity_type, a.severity,
           a.details`,
  order: 'a.occurred_at, a.id',
  spec: (ctx) => {
    const w = word(ctx);
    return {
      title: l('Regjistri i veprimeve', 'Action log'),
      note: l(
        'Kush bëri çfarë dhe kur. «Veprimi» është emri që i jep programi (p.sh. sale.refunded = kthim i një shitjeje).',
        'Who did what and when. "Action" is the name the program gives it (e.g. sale.refunded = a sale was refunded).',
      ),
      columns: [
        { label: l('Koha', 'Time'), get: (r) => r.at },
        { label: l('Kush', 'Who'), get: (r) => r.actor },
        { label: l('Veprimi', 'Action'), get: (r) => r.action },
        {
          label: l('Rëndësia', 'Severity'),
          optional: true,
          get: (r) => (r.severity === 'info' ? null : w('severity', r.severity)),
        },
        {
          label: l('Hollësi', 'Detail'),
          optional: true,
          get: (r) => auditDetail(r.details, ctx.lang),
        },
      ],
    };
  },
});

/** Every table, in the order the file holds them: the period first, then the lists. */
export const SECTIONS: readonly SectionDef[] = [
  sales,
  refunds,
  sessions,
  timeCredits,
  reservations,
  orders,
  shifts,
  cashMovements,
  expenses,
  stockMovements,
  stockCounts,
  purchases,
  staffPurchases,
  debts,
  customerLedger,
  invoices,
  products,
  offers,
  pricing,
  packages,
  stations,
  customers,
  suppliers,
  users,
  audit,
];
