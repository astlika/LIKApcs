/**
 * Import from another program — LIKApos Pro (JSON backup) → LIKApcs.
 *
 * Flow: `analyze(file)` recognises the format and previews what it contains; `run(file, options)`
 * imports the chosen entities in ONE transaction (dry run = same work, rolled back at the end)
 * after an automatic `pre_import` backup. Every imported record is linked to its external id in
 * `import_links`, so running the same file again only adds what is new.
 *
 * Mapping (LIKApos Pro → LIKApcs):
 *   products[]   → categories (by name), products (+ primary barcode, opening stock as an
 *                  `initial` movement, picture link downloaded afterwards in the background).
 *                  Variants are flattened to the base product; PC-time "products" become
 *                  non-stock items.
 *   customers[]  → customers (name, phone, e-mail, address → notes, card barcode → code,
 *                  PC login username + PIN when the PIN is at least 4 characters).
 *   customers[].debts[] (unpaid) → customer_debts (remaining amount, due date, note), linked to the
 *                  imported sale when that sale is imported too; balances recomputed.
 *   sales[]      → completed sales with items (linked to products when known), payments
 *                  (cash / credit) and refund status. Receipt numbers are NOT assigned (LIKApcs
 *                  numbering stays gap-free); the old TXN number is kept in the notes.
 *   expenses[]   → expenses with the old category names as (new) expense categories.
 *   Never imported: staff, cash drawer log, audit/portal logs, loyalty points, supplier orders,
 *                  investments, held carts, settings.
 *
 * Money in the file is floating point euros → `Math.round(x * 100)` cents; quantities → milli.
 */
import type {
  ImportAnalysis,
  ImportEntity,
  ImportEntityPreview,
  ImportEntityResult,
  ImportReport,
  ImportRunOptions,
  ImportSource,
  ImportStatus,
} from '@likapcs/shared';
import { IMPORT_ENTITIES } from '@likapcs/shared';
import type { DbClient, DbPool } from '../db/pool.js';
import { badRequest, conflict } from '../errors.js';
import { hashPassword } from '../security/password.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { BackupService } from './backups.js';
import { applyMovement, nextSku } from './catalog.js';
import { nextCustomerCode } from './customers.js';
import type { ProductImageStore } from './product-images.js';

const SOURCE: ImportSource = 'likapos_pro';
const MAX_WARNINGS = 300;
const BARCODE_RE = /^[A-Za-z0-9._-]{3,64}$/;
const USERNAME_RE = /^[A-Za-z0-9._-]{2,32}$/;
const CODE_RE = /^[A-Za-z0-9._-]{3,32}$/;
const MIN_PIN = 4;

// ─── Loose view of the LIKApos Pro file ───────────────────────────────────────────

interface LpProduct {
  id: number | string;
  name?: string;
  description?: string;
  barcode?: string;
  category?: string;
  productType?: string; // physical | noStock | service
  trackStock?: boolean;
  price?: number;
  cost?: number;
  stock?: number;
  minStock?: number;
  image?: string;
  hasVariants?: boolean;
  variantGroups?: { name?: string; options?: { label?: string }[] }[];
  createdAt?: string;
}
interface LpDebt {
  id: number | string;
  amount?: number;
  originalAmount?: number;
  dueDate?: string;
  note?: string;
  type?: string;
  paid?: boolean;
  saleId?: number | string;
  createdAt?: string;
}
interface LpCustomer {
  id: number | string;
  first?: string;
  last?: string;
  phone?: string;
  email?: string;
  address?: string;
  clientUsername?: string;
  clientPin?: string;
  barcode?: string;
  debts?: LpDebt[];
}
interface LpSaleItem {
  id?: number | string;
  name?: string;
  price?: number;
  cost?: number;
  qty?: number;
  refundedQty?: number;
  variantLabel?: string;
}
interface LpSale {
  id: number | string;
  txn?: string;
  date?: string;
  staff?: string;
  items?: LpSaleItem[];
  rawTotal?: number;
  total?: number;
  paymentType?: string; // Cash | Credit | Staff | Installment
  customerId?: string | number | null;
  refunded?: boolean;
  discount?: { amt?: number } | null;
  note?: string;
  cashPaid?: number;
  debtAmount?: number;
  staffPurchase?: boolean;
  externalSale?: boolean;
}
interface LpExpense {
  id: number | string;
  date?: string;
  category?: string;
  amount?: number;
  note?: string;
  staff?: string;
}
interface LpFile {
  products?: LpProduct[];
  customers?: LpCustomer[];
  sales?: LpSale[];
  expenses?: LpExpense[];
  settings?: { storeName?: string };
  _cloudSavedAt?: string;
  [key: string]: unknown;
}

const NOT_IMPORTED_KEYS = [
  'staff',
  'cashDrawer',
  'auditLogs',
  'portalLogs',
  'sessions',
  'mobileSessions',
  'pointSales',
  'orders',
  'investments',
  'heldCarts',
  'incomes',
  'settings',
];

// ─── Helpers ────────────────────────────────────────────────────────────────────

const cents = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const milli = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
};
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const isoDate = (v: unknown): Date | null => {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const dayOf = (d: Date): string => d.toISOString().slice(0, 10);
const slug = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30) || 'other';

/** Shape check: a LIKApos Pro cloud/local backup has these arrays with these fields. */
export function detectSource(data: unknown): ImportSource | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const file = data as LpFile;
  const products = Array.isArray(file.products) ? file.products : null;
  const customers = Array.isArray(file.customers) ? file.customers : null;
  const sales = Array.isArray(file.sales) ? file.sales : null;
  if (!products && !customers && !sales) return null;
  const p = products?.[0];
  const c = customers?.[0];
  const s = sales?.[0];
  const looksProduct = !p || (typeof p === 'object' && 'name' in p && 'price' in p);
  const looksCustomer = !c || (typeof c === 'object' && ('first' in c || 'clientUsername' in c));
  const looksSale = !s || (typeof s === 'object' && 'items' in s && 'paymentType' in s);
  if (!looksProduct || !looksCustomer || !looksSale) return null;
  if (!p && !c && !s && !('_cloudSavedAt' in file)) return null;
  return SOURCE;
}

class Warnings {
  readonly list: string[] = [];
  private dropped = 0;
  add(message: string): void {
    if (this.list.length < MAX_WARNINGS) this.list.push(message);
    else this.dropped += 1;
  }
  finish(): string[] {
    return this.dropped ? [...this.list, `… and ${this.dropped} more`] : this.list;
  }
}

interface ImageJob {
  productId: string;
  url: string;
}

export class ImportService {
  private images: { pending: number; done: number; failed: number } = {
    pending: 0,
    done: 0,
    failed: 0,
  };
  private busy = false;

  constructor(
    private readonly pool: DbPool,
    private readonly backups: BackupService,
    private readonly imageStore: ProductImageStore,
  ) {}

  // ─── Analyze ───────────────────────────────────────────────────────────────

  async analyze(data: unknown): Promise<ImportAnalysis> {
    const source = detectSource(data);
    if (!source) throw badRequest('This file is not a LIKApos Pro backup', { field: 'file' });
    const file = data as LpFile;
    const warnings = new Warnings();
    const linked = await this.linkedIds();
    const products = (file.products ?? []).filter((p) => p && typeof p === 'object');
    const customers = (file.customers ?? []).filter((c) => c && typeof c === 'object');
    const sales = (file.sales ?? []).filter((s) => s && typeof s === 'object');
    const allExpenses = (file.expenses ?? []).filter((e) => e && typeof e === 'object');
    const expenses = allExpenses.filter((e) => cents(e.amount) > 0);
    if (allExpenses.length !== expenses.length) {
      warnings.add(
        `${allExpenses.length - expenses.length} expense(s) have no amount — not imported.`,
      );
    }
    const debts = customers.flatMap((c) =>
      (Array.isArray(c.debts) ? c.debts : [])
        .filter((d) => d && typeof d === 'object' && d.paid === false && cents(d.amount) > 0)
        .map((d) => ({ ...d, customerName: customerName(c) })),
    );

    const variants = products.filter((p) => p.hasVariants && p.variantGroups?.length);
    if (variants.length) {
      warnings.add(
        `${variants.length} product(s) have variants (${variants
          .slice(0, 5)
          .map((p) => text(p.name))
          .join(
            ', ',
          )}${variants.length > 5 ? ', …' : ''}) — imported as one product each; the variant price list is not kept.`,
      );
    }
    const badBarcodes = products.filter(
      (p) => text(p.barcode) && !BARCODE_RE.test(text(p.barcode)),
    );
    if (badBarcodes.length) {
      warnings.add(
        `${badBarcodes.length} barcode(s) are too short or contain spaces (${badBarcodes
          .slice(0, 5)
          .map((p) => `"${text(p.barcode)}"`)
          .join(', ')}) — the product is imported without that barcode.`,
      );
    }
    const shortPins = customers.filter(
      (c) => text(c.clientUsername) && text(c.clientPin).length < MIN_PIN,
    );
    if (shortPins.length) {
      warnings.add(
        `${shortPins.length} customer(s) have a PC username but no PIN of at least ${MIN_PIN} characters — imported without a PC login; set one in Customers.`,
      );
    }
    const unknownCustomer = sales.filter(
      (s) => s.customerId && !customers.some((c) => String(c.id) === String(s.customerId)),
    ).length;
    if (unknownCustomer) {
      warnings.add(
        `${unknownCustomer} sale(s) refer to a customer that is not in the file — imported as walk-in sales.`,
      );
    }
    const refunded = sales.filter((s) => s.refunded).length;
    if (refunded) {
      warnings.add(
        `${refunded} sale(s) were refunded in LIKApos Pro — imported with the refunded status; no separate refund documents are created.`,
      );
    }
    warnings.add(
      'Sales history keeps the old TXN number in the notes; LIKApcs receipt numbers (R-…) are not assigned to imported sales and stock is not changed by them.',
    );

    const preview = (
      total: number,
      already: number,
      amountCents: number | null,
      sample: string[],
      dates: Date[] = [],
    ): ImportEntityPreview => {
      const sorted = dates.map((d) => d.getTime()).sort((a, b) => a - b);
      return {
        total,
        alreadyImported: already,
        amountCents,
        sample: sample.filter(Boolean).slice(0, 6),
        from: sorted.length ? new Date(sorted[0]!).toISOString() : null,
        to: sorted.length ? new Date(sorted[sorted.length - 1]!).toISOString() : null,
      };
    };
    const count = (entity: string, ids: (string | number)[]) =>
      ids.filter((id) => linked.get(entity)?.has(String(id))).length;

    const entities: Record<ImportEntity, ImportEntityPreview> = {
      products: preview(
        products.length,
        count(
          'product',
          products.map((p) => p.id),
        ),
        null,
        products.map((p) => text(p.name)),
      ),
      customers: preview(
        customers.length,
        count(
          'customer',
          customers.map((c) => c.id),
        ),
        null,
        customers.map((c) => customerName(c)),
      ),
      debts: preview(
        debts.length,
        count(
          'debt',
          debts.map((d) => d.id),
        ),
        debts.reduce((sum, d) => sum + cents(d.amount), 0),
        debts.map((d) => `${d.customerName} · ${(cents(d.amount) / 100).toFixed(2)}`),
        debts.map((d) => isoDate(d.dueDate)).filter((d): d is Date => d !== null),
      ),
      sales: preview(
        sales.length,
        count(
          'sale',
          sales.map((s) => s.id),
        ),
        sales.reduce((sum, s) => sum + cents(s.total), 0),
        sales.slice(0, 6).map((s) => text(s.txn)),
        sales.map((s) => isoDate(s.date)).filter((d): d is Date => d !== null),
      ),
      expenses: preview(
        expenses.length,
        count(
          'expense',
          expenses.map((e) => e.id),
        ),
        expenses.reduce((sum, e) => sum + cents(e.amount), 0),
        [...new Set(expenses.map((e) => text(e.category)))],
        expenses.map((e) => isoDate(e.date)).filter((d): d is Date => d !== null),
      ),
    };
    const notImported = NOT_IMPORTED_KEYS.filter((k) => k in file).map((key) => {
      const v = file[key];
      const n = Array.isArray(v) ? v.length : v && typeof v === 'object' ? 1 : 0;
      return { key, count: n };
    });
    return {
      source,
      storeName: text(file.settings?.storeName) || null,
      exportedAt: isoDate(file._cloudSavedAt)?.toISOString() ?? null,
      entities,
      warnings: warnings.finish(),
      notImported,
    };
  }

  private async linkedIds(): Promise<Map<string, Set<string>>> {
    const r = await this.pool.query<{ entity: string; external_id: string }>(
      'SELECT entity, external_id FROM import_links WHERE source = $1',
      [SOURCE],
    );
    const map = new Map<string, Set<string>>();
    for (const row of r.rows) {
      if (!map.has(row.entity)) map.set(row.entity, new Set());
      map.get(row.entity)!.add(row.external_id);
    }
    return map;
  }

  // ─── Run ───────────────────────────────────────────────────────────────────

  async run(data: unknown, options: ImportRunOptions, actor: AuditActor): Promise<ImportReport> {
    const source = detectSource(data);
    if (!source) throw badRequest('This file is not a LIKApos Pro backup', { field: 'file' });
    if (this.busy) throw conflict('An import is already running');
    if (!actor.userId) throw badRequest('Imports need a signed-in user');
    this.busy = true;
    const startedAt = Date.now();
    try {
      const file = data as LpFile;
      const wanted = new Set<ImportEntity>(options.entities);
      // Debts and sales need their customers; sales history needs the products to link lines.
      // We do not force-import them — unlinked rows simply stay unlinked — but we say so.
      const warnings = new Warnings();
      if (wanted.has('debts') && !wanted.has('customers')) {
        warnings.add(
          'Debts were selected without customers — only debts of customers imported earlier can be created.',
        );
      }

      let backupId: string | null = null;
      if (!options.dryRun) {
        const backup = await this.backups.create({ kind: 'pre_import', actor });
        backupId = backup.id;
      }

      const client = await this.pool.connect();
      let runId: string | null = null;
      try {
        await client.query('BEGIN');
        if (!options.dryRun) {
          const r = await client.query<{ id: string }>(
            `INSERT INTO import_runs (source, file_name, backup_id, started_by)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [SOURCE, options.fileName ?? null, backupId, actor.userId ?? null],
          );
          runId = r.rows[0]!.id;
        }
        const ctx = new RunContext(client, runId, actor, warnings, options.dryRun);
        await ctx.loadLinks();
        const results = emptyResults();
        const imageJobs: ImageJob[] = [];
        if (wanted.has('products')) {
          results.products = await this.importProducts(ctx, file.products ?? [], imageJobs);
        }
        if (wanted.has('customers')) {
          results.customers = await this.importCustomers(ctx, file.customers ?? []);
        }
        if (wanted.has('sales')) {
          results.sales = await this.importSales(ctx, file.sales ?? []);
        }
        if (wanted.has('debts')) {
          results.debts = await this.importDebts(ctx, file.customers ?? []);
        }
        if (wanted.has('expenses')) {
          results.expenses = await this.importExpenses(ctx, file.expenses ?? []);
        }
        const report: ImportReport = {
          dryRun: options.dryRun,
          runId,
          backupId,
          results,
          imagesQueued: imageJobs.length,
          warnings: warnings.finish(),
          durationMs: Date.now() - startedAt,
        };
        if (options.dryRun) {
          await client.query('ROLLBACK');
          return report;
        }
        await client.query(
          `UPDATE import_runs SET status = 'succeeded', finished_at = now(), report = $2::jsonb WHERE id = $1`,
          [runId, JSON.stringify(report)],
        );
        await recordAudit(client, actor, {
          action: 'import.completed',
          entityType: 'import_run',
          entityId: runId,
          details: {
            source: SOURCE,
            fileName: options.fileName ?? null,
            backupId,
            results,
            imagesQueued: imageJobs.length,
          },
        });
        await client.query('COMMIT');
        this.downloadImages(imageJobs, actor);
        return report;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (runId) {
          await this.pool
            .query(
              `INSERT INTO import_runs (id, source, file_name, backup_id, started_by, status, finished_at, report)
               VALUES ($1, $2, $3, $4, $5, 'failed', now(), $6::jsonb)`,
              [
                runId,
                SOURCE,
                options.fileName ?? null,
                backupId,
                actor.userId ?? null,
                JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
              ],
            )
            .catch(() => undefined);
        }
        throw err;
      } finally {
        client.release();
      }
    } finally {
      this.busy = false;
    }
  }

  // ─── Products ──────────────────────────────────────────────────────────────

  private async importProducts(
    ctx: RunContext,
    rows: LpProduct[],
    imageJobs: ImageJob[],
  ): Promise<ImportEntityResult> {
    const result = { created: 0, skipped: 0, failed: 0 };
    const categoryIds = new Map<string, string>();
    const resolveCategory = async (name: string): Promise<string | null> => {
      const key = name.toLowerCase();
      if (!key) return null;
      if (categoryIds.has(key)) return categoryIds.get(key)!;
      const linked = ctx.link('category', key);
      if (linked) {
        categoryIds.set(key, linked);
        return linked;
      }
      const existing = await ctx.client.query<{ id: string }>(
        'SELECT id FROM categories WHERE lower(name) = $1 LIMIT 1',
        [key],
      );
      let id = existing.rows[0]?.id;
      if (!id) {
        const created = await ctx.client.query<{ id: string }>(
          `INSERT INTO categories (name, sort_order) VALUES ($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories)) RETURNING id`,
          [name],
        );
        id = created.rows[0]!.id;
      }
      await ctx.remember('category', key, id);
      categoryIds.set(key, id);
      return id;
    };

    for (const p of rows) {
      if (!p || typeof p !== 'object' || p.id === undefined || p.id === null) {
        result.failed += 1;
        continue;
      }
      const extId = String(p.id);
      if (ctx.link('product', extId)) {
        result.skipped += 1;
        continue;
      }
      const name = text(p.name);
      if (!name) {
        result.failed += 1;
        ctx.warn(`Product ${extId} has no name — not imported.`);
        continue;
      }
      try {
        await ctx.client.query('SAVEPOINT product');
        const categoryId = await resolveCategory(text(p.category));
        const trackStock = (p.productType ?? 'physical') === 'physical' && p.trackStock !== false;
        const sku = await nextSku(ctx.client);
        const inserted = await ctx.client.query<{ id: string }>(
          `INSERT INTO products (name, sku, category_id, unit_code, purchase_cost_cents, average_cost_cents,
                                 selling_price_cents, price_includes_tax, min_stock_milli, allow_negative_stock,
                                 track_stock, description, is_active, created_by, client_menu)
           VALUES ($1, $2, $3, 'pc', $4, $4, $5, true, $6, false, $7, $8, true, $9, false)
           RETURNING id`,
          [
            name,
            sku,
            categoryId,
            Math.max(0, cents(p.cost)),
            Math.max(0, cents(p.price)),
            Math.max(0, milli(p.minStock)),
            trackStock,
            text(p.description) || null,
            ctx.actor.userId ?? null,
          ],
        );
        const id = inserted.rows[0]!.id;
        const barcode = text(p.barcode);
        if (barcode) {
          if (!BARCODE_RE.test(barcode)) {
            ctx.warn(`"${name}": barcode "${barcode}" is not valid — product imported without it.`);
          } else {
            const taken = await ctx.client.query<{ name: string }>(
              `SELECT pr.name FROM product_barcodes b JOIN products pr ON pr.id = b.product_id WHERE b.barcode = $1`,
              [barcode],
            );
            if (taken.rows[0]) {
              ctx.warn(
                `"${name}": barcode ${barcode} already belongs to "${taken.rows[0].name}" — product imported without it.`,
              );
            } else {
              await ctx.client.query(
                `INSERT INTO product_barcodes (product_id, barcode, is_primary) VALUES ($1, $2, true)`,
                [id, barcode],
              );
            }
          }
        }
        const stock = milli(p.stock);
        if (trackStock && stock > 0) {
          await applyMovement(ctx.client, {
            productId: id,
            type: 'initial',
            delta: stock,
            unitCostCents: Math.max(0, cents(p.cost)),
            reason: 'Opening stock (imported from LIKApos Pro)',
            referenceType: 'import',
            referenceId: extId,
            actorUserId: ctx.actor.userId ?? null,
            allowNegative: false,
          });
        } else if (trackStock && stock < 0) {
          ctx.warn(`"${name}": negative stock (${stock / 1000}) in the file — imported with 0.`);
        }
        if (p.hasVariants && p.variantGroups?.length) {
          const labels = p.variantGroups
            .flatMap((g) => g.options ?? [])
            .map((o) => text(o.label))
            .filter(Boolean);
          if (labels.length) {
            await ctx.client.query(
              `UPDATE products SET description = COALESCE(NULLIF(description, ''), '') || CASE WHEN COALESCE(description, '') = '' THEN '' ELSE E'\\n' END || $2 WHERE id = $1`,
              [id, `Variants (LIKApos Pro): ${labels.join(', ')}`],
            );
          }
        }
        const image = text(p.image);
        if (/^https?:\/\//i.test(image)) imageJobs.push({ productId: id, url: image });
        await ctx.remember('product', extId, id);
        await ctx.client.query('RELEASE SAVEPOINT product');
        result.created += 1;
      } catch (err) {
        await ctx.client.query('ROLLBACK TO SAVEPOINT product');
        result.failed += 1;
        ctx.warn(`"${name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  }

  // ─── Customers ─────────────────────────────────────────────────────────────

  private async importCustomers(ctx: RunContext, rows: LpCustomer[]): Promise<ImportEntityResult> {
    const result = { created: 0, skipped: 0, failed: 0 };
    const usernamesInFile = new Map<string, number>();
    for (const c of rows) {
      const u = text(c?.clientUsername).toLowerCase();
      if (u) usernamesInFile.set(u, (usernamesInFile.get(u) ?? 0) + 1);
    }
    for (const c of rows) {
      if (!c || typeof c !== 'object' || c.id === undefined || c.id === null) {
        result.failed += 1;
        continue;
      }
      const extId = String(c.id);
      if (ctx.link('customer', extId)) {
        result.skipped += 1;
        continue;
      }
      const name = customerName(c);
      try {
        await ctx.client.query('SAVEPOINT customer');
        // Card barcode → customer code when free; otherwise the normal C-000001 sequence.
        let code: string | null = null;
        const card = text(c.barcode);
        if (card && CODE_RE.test(card)) {
          const taken = await ctx.client.query(
            'SELECT 1 FROM customers WHERE lower(code) = lower($1)',
            [card],
          );
          if (!taken.rows[0]) code = card;
        }
        code ??= await nextCustomerCode(ctx.client);

        // PC login: username must be valid and unique (in the file and in LIKApcs), PIN ≥ 4.
        let loginUsername: string | null = null;
        let loginHash: string | null = null;
        const username = text(c.clientUsername);
        const pin = text(c.clientPin);
        if (username) {
          if (!USERNAME_RE.test(username)) {
            ctx.warn(
              `${name}: PC username "${username}" is not valid — imported without a PC login.`,
            );
          } else if ((usernamesInFile.get(username.toLowerCase()) ?? 0) > 1) {
            ctx.warn(
              `${name}: PC username "${username}" appears twice in the file — imported without it.`,
            );
          } else if (pin.length < MIN_PIN) {
            ctx.warn(`${name}: PIN shorter than ${MIN_PIN} — imported without a PC login.`);
          } else {
            const taken = await ctx.client.query<{ name: string }>(
              'SELECT name FROM customers WHERE lower(login_username) = lower($1)',
              [username],
            );
            if (taken.rows[0]) {
              ctx.warn(
                `${name}: PC username "${username}" is already used by "${taken.rows[0].name}" — imported without it.`,
              );
            } else {
              loginUsername = username;
              loginHash = await hashPassword(pin);
            }
          }
        }
        const notesParts = [
          text(c.address) ? `Address: ${text(c.address)}` : '',
          'Imported from LIKApos Pro',
        ];
        const inserted = await ctx.client.query<{ id: string }>(
          `INSERT INTO customers (code, name, phone, email, notes, status, created_by,
                                  login_username, login_password_hash, login_enabled)
           VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9) RETURNING id`,
          [
            code,
            name,
            text(c.phone) || null,
            text(c.email) || null,
            notesParts.filter(Boolean).join('\n'),
            ctx.actor.userId ?? null,
            loginUsername,
            loginHash,
            loginUsername !== null,
          ],
        );
        await ctx.remember('customer', extId, inserted.rows[0]!.id);
        await ctx.client.query('RELEASE SAVEPOINT customer');
        result.created += 1;
      } catch (err) {
        await ctx.client.query('ROLLBACK TO SAVEPOINT customer');
        result.failed += 1;
        ctx.warn(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  }

  // ─── Sales history ─────────────────────────────────────────────────────────

  private async importSales(ctx: RunContext, rows: LpSale[]): Promise<ImportEntityResult> {
    const result = { created: 0, skipped: 0, failed: 0 };
    let unknownCustomers = 0;
    for (const s of rows) {
      if (!s || typeof s !== 'object' || s.id === undefined || s.id === null) {
        result.failed += 1;
        continue;
      }
      const extId = String(s.id);
      if (ctx.link('sale', extId)) {
        result.skipped += 1;
        continue;
      }
      const items = Array.isArray(s.items) ? s.items.filter((i) => i && typeof i === 'object') : [];
      const when = isoDate(s.date) ?? new Date();
      const txn = text(s.txn) || `#${extId}`;
      try {
        await ctx.client.query('SAVEPOINT sale');
        let customerId: string | null = null;
        if (s.customerId !== null && s.customerId !== undefined && s.customerId !== '') {
          customerId = ctx.link('customer', String(s.customerId));
          if (!customerId) unknownCustomers += 1;
        }
        const lines = items.map((it, i) => {
          const qtyMilli = Math.max(1, milli(it.qty ?? 1));
          const unitCents = Math.max(0, cents(it.price));
          const lineTotal = Math.round((unitCents * qtyMilli) / 1000);
          const refundedMilli = Math.min(qtyMilli, Math.max(0, milli(it.refundedQty ?? 0)));
          return {
            lineNo: i + 1,
            productId:
              it.id !== undefined && it.id !== null ? ctx.link('product', String(it.id)) : null,
            description: [text(it.name) || 'Item', text(it.variantLabel)]
              .filter(Boolean)
              .join(' · '),
            qtyMilli,
            unitCents,
            lineTotal,
            costCents: Math.max(0, Math.round((cents(it.cost) * qtyMilli) / 1000)),
            refundedMilli,
            refundedCents: Math.round((unitCents * refundedMilli) / 1000),
          };
        });
        const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
        const total = Math.max(0, cents(s.total ?? s.rawTotal ?? subtotal / 100));
        const discount = Math.max(0, subtotal - total);
        let refunded = lines.reduce((sum, l) => sum + l.refundedCents, 0);
        if (s.refunded && refunded === 0) refunded = total;
        refunded = Math.min(refunded, total);
        const status =
          refunded > 0 && refunded >= total && total > 0
            ? 'refunded'
            : refunded > 0
              ? 'partially_refunded'
              : 'completed';
        const note = [
          `${txn} · LIKApos Pro`,
          text(s.staff) ? `staff: ${text(s.staff)}` : '',
          s.staffPurchase ? 'staff purchase' : '',
          s.externalSale ? 'sale outside the POS' : '',
          text(s.note),
        ]
          .filter(Boolean)
          .join(' · ');
        const inserted = await ctx.client.query<{ id: string }>(
          `INSERT INTO sales (status, source, customer_id, cashier_user_id, subtotal_cents, discount_cents, tax_cents,
                              total_cents, paid_cents, change_cents, refunded_cents, notes, created_at, completed_at)
           VALUES ($1, 'retail', $2, $3, $4, $5, 0, $6, $6, 0, $7, $8, $9, $9) RETURNING id`,
          [status, customerId, ctx.actor.userId, subtotal, discount, total, refunded, note, when],
        );
        const saleId = inserted.rows[0]!.id;
        for (const l of lines) {
          await ctx.client.query(
            `INSERT INTO sale_items (sale_id, line_no, product_id, description, quantity_milli, unit_price_cents,
                                     discount_cents, tax_rate_bp, tax_cents, line_total_cents, cost_cents, refunded_milli)
             VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, $7, $8, $9)`,
            [
              saleId,
              l.lineNo,
              l.productId,
              l.description,
              l.qtyMilli,
              l.unitCents,
              l.lineTotal,
              l.costCents,
              l.refundedMilli,
            ],
          );
        }
        // Payments: Cash / Staff → cash; Credit → the cash part (if any) + the rest on credit;
        // Installment → credit. Zero-total sales have no payment rows.
        const type = text(s.paymentType).toLowerCase();
        const payments: { method: 'cash' | 'credit'; amount: number }[] = [];
        if (total > 0) {
          if (type === 'credit' || type === 'installment') {
            const cashPart = Math.min(total, Math.max(0, cents(s.cashPaid)));
            if (cashPart > 0) payments.push({ method: 'cash', amount: cashPart });
            if (total - cashPart > 0) payments.push({ method: 'credit', amount: total - cashPart });
          } else {
            payments.push({ method: 'cash', amount: total });
          }
        }
        for (const p of payments) {
          await ctx.client.query(
            `INSERT INTO payments (kind, method, amount_cents, sale_id, customer_id, reference, received_at, created_by)
             VALUES ('sale', $1, $2, $3, $4, $5, $6, $7)`,
            [p.method, p.amount, saleId, customerId, txn, when, ctx.actor.userId ?? null],
          );
        }
        await ctx.remember('sale', extId, saleId);
        await ctx.client.query('RELEASE SAVEPOINT sale');
        result.created += 1;
      } catch (err) {
        await ctx.client.query('ROLLBACK TO SAVEPOINT sale');
        result.failed += 1;
        ctx.warn(`Sale ${txn}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (unknownCustomers) {
      ctx.warn(
        `${unknownCustomers} sale(s) refer to a customer that was not imported — saved as walk-in sales.`,
      );
    }
    return result;
  }

  // ─── Open debts ────────────────────────────────────────────────────────────

  private async importDebts(ctx: RunContext, customers: LpCustomer[]): Promise<ImportEntityResult> {
    const result = { created: 0, skipped: 0, failed: 0 };
    const touched = new Set<string>();
    let withoutCustomer = 0;
    for (const c of customers) {
      if (!c || typeof c !== 'object' || !Array.isArray(c.debts)) continue;
      const customerId = ctx.link('customer', String(c.id));
      for (const d of c.debts) {
        if (!d || typeof d !== 'object' || d.paid !== false) continue;
        const remaining = cents(d.amount);
        if (remaining <= 0) continue;
        const extId = String(d.id ?? `${c.id}-${d.saleId ?? ''}-${d.dueDate ?? ''}`);
        if (ctx.link('debt', extId)) {
          result.skipped += 1;
          continue;
        }
        if (!customerId) {
          withoutCustomer += 1;
          result.failed += 1;
          continue;
        }
        try {
          await ctx.client.query('SAVEPOINT debt');
          const saleId =
            d.saleId !== undefined && d.saleId !== null ? ctx.link('sale', String(d.saleId)) : null;
          const createdAt = isoDate(d.createdAt) ?? new Date();
          const due = isoDate(d.dueDate) ?? new Date();
          const original = cents(d.originalAmount);
          const notes = [
            text(d.type),
            text(d.note),
            `Imported from LIKApos Pro${original > remaining ? ` (originally ${(original / 100).toFixed(2)}, ${((original - remaining) / 100).toFixed(2)} already paid there)` : ''}`,
          ]
            .filter(Boolean)
            .join(' · ');
          const inserted = await ctx.client.query<{ id: string }>(
            `INSERT INTO customer_debts (customer_id, sale_id, amount_cents, paid_cents, status, due_date, notes, created_by, created_at)
             VALUES ($1, $2, $3, 0, 'open', $4, $5, $6, $7) RETURNING id`,
            [customerId, saleId, remaining, dayOf(due), notes, ctx.actor.userId ?? null, createdAt],
          );
          await ctx.remember('debt', extId, inserted.rows[0]!.id);
          await ctx.client.query('RELEASE SAVEPOINT debt');
          touched.add(customerId);
          result.created += 1;
        } catch (err) {
          await ctx.client.query('ROLLBACK TO SAVEPOINT debt');
          result.failed += 1;
          ctx.warn(
            `Debt of ${customerName(c)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    for (const customerId of touched) {
      await ctx.client.query(
        `UPDATE customers SET balance_due_cents = COALESCE((SELECT SUM(amount_cents - paid_cents) FROM customer_debts
                                                           WHERE customer_id = $1 AND status IN ('open', 'partial')), 0)
         WHERE id = $1`,
        [customerId],
      );
    }
    if (withoutCustomer) {
      ctx.warn(
        `${withoutCustomer} open debt(s) belong to customers that are not imported — not created.`,
      );
    }
    return result;
  }

  // ─── Expenses ──────────────────────────────────────────────────────────────

  private async importExpenses(ctx: RunContext, rows: LpExpense[]): Promise<ImportEntityResult> {
    const result = { created: 0, skipped: 0, failed: 0 };
    const categoryCodes = new Map<string, string>();
    const resolveCategory = async (name: string): Promise<string> => {
      const label = name || 'Other';
      const key = label.toLowerCase();
      if (categoryCodes.has(key)) return categoryCodes.get(key)!;
      const linked = ctx.link('expense_category', key);
      if (linked) {
        categoryCodes.set(key, linked);
        return linked;
      }
      const existing = await ctx.client.query<{ code: string }>(
        'SELECT code FROM expense_categories WHERE lower(name_en) = $1 OR lower(name_sq) = $1 LIMIT 1',
        [key],
      );
      let code = existing.rows[0]?.code;
      if (!code) {
        const base = `imp_${slug(label)}`;
        code = base;
        for (let n = 2; ; n += 1) {
          const clash = await ctx.client.query('SELECT 1 FROM expense_categories WHERE code = $1', [
            code,
          ]);
          if (!clash.rows[0]) break;
          code = `${base}_${n}`;
        }
        await ctx.client.query(
          `INSERT INTO expense_categories (code, name_en, name_sq, is_system) VALUES ($1, $2, $2, false)`,
          [code, label.slice(0, 80)],
        );
      }
      await ctx.remember('expense_category', key, code);
      categoryCodes.set(key, code);
      return code;
    };
    for (const e of rows) {
      if (!e || typeof e !== 'object' || e.id === undefined || e.id === null) {
        result.failed += 1;
        continue;
      }
      const extId = String(e.id);
      if (ctx.link('expense', extId)) {
        result.skipped += 1;
        continue;
      }
      const amount = cents(e.amount);
      if (amount <= 0) {
        result.failed += 1;
        continue;
      }
      try {
        await ctx.client.query('SAVEPOINT expense');
        const code = await resolveCategory(text(e.category));
        const when = isoDate(e.date) ?? new Date();
        const description = [
          text(e.note) || text(e.category) || 'Expense',
          text(e.staff) ? `(${text(e.staff)})` : '',
        ]
          .filter(Boolean)
          .join(' ');
        const inserted = await ctx.client.query<{ id: string }>(
          `INSERT INTO expenses (expense_date, category_code, amount_cents, payment_method, description, created_by, created_at)
           VALUES ($1, $2, $3, 'cash', $4, $5, $6) RETURNING id`,
          [dayOf(when), code, amount, description.slice(0, 500), ctx.actor.userId ?? null, when],
        );
        await ctx.remember('expense', extId, inserted.rows[0]!.id);
        await ctx.client.query('RELEASE SAVEPOINT expense');
        result.created += 1;
      } catch (err) {
        await ctx.client.query('ROLLBACK TO SAVEPOINT expense');
        result.failed += 1;
        ctx.warn(`Expense ${extId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  }

  // ─── Pictures (after commit, best effort) ──────────────────────────────────

  private downloadImages(jobs: ImageJob[], actor: AuditActor): void {
    if (!jobs.length) return;
    this.images = { pending: jobs.length, done: 0, failed: 0 };
    const queue = [...jobs];
    const worker = async () => {
      for (;;) {
        const job = queue.shift();
        if (!job) return;
        try {
          const fileName = await this.imageStore.saveFromUrl(job.url);
          const r = await this.pool.query(
            'UPDATE products SET image_path = $2 WHERE id = $1 AND image_path IS NULL',
            [job.productId, fileName],
          );
          if (r.rowCount === 0) await this.imageStore.remove(fileName);
          this.images.done += 1;
        } catch {
          this.images.failed += 1;
        } finally {
          this.images.pending -= 1;
        }
      }
    };
    void Promise.all([worker(), worker(), worker()]).then(() =>
      recordAudit(this.pool, actor, {
        action: 'import.images',
        entityType: 'import_run',
        entityId: null,
        details: { done: this.images.done, failed: this.images.failed, total: jobs.length },
      }).catch(() => undefined),
    );
  }

  async status(): Promise<ImportStatus> {
    const r = await this.pool.query<{
      id: string;
      source: ImportSource;
      file_name: string | null;
      started_at: Date;
      finished_at: Date | null;
      status: 'running' | 'succeeded' | 'failed';
      report: ImportReport | Record<string, never>;
    }>(
      `SELECT id, source, file_name, started_at, finished_at, status, report
         FROM import_runs ORDER BY started_at DESC LIMIT 1`,
    );
    const row = r.rows[0];
    return {
      images: { ...this.images },
      lastRun: row
        ? {
            id: row.id,
            source: row.source,
            fileName: row.file_name,
            startedAt: row.started_at.toISOString(),
            finishedAt: row.finished_at?.toISOString() ?? null,
            status: row.status,
            report: row.report && 'results' in row.report ? (row.report as ImportReport) : null,
          }
        : null,
    };
  }
}

// ─── Run context: links + warnings bound to one transaction ───────────────────

class RunContext {
  private links = new Map<string, string>();
  constructor(
    readonly client: DbClient,
    readonly runId: string | null,
    readonly actor: AuditActor,
    private readonly warnings: Warnings,
    readonly dryRun: boolean,
  ) {}

  async loadLinks(): Promise<void> {
    const r = await this.client.query<{ entity: string; external_id: string; internal_id: string }>(
      'SELECT entity, external_id, internal_id FROM import_links WHERE source = $1',
      [SOURCE],
    );
    for (const row of r.rows) this.links.set(`${row.entity}:${row.external_id}`, row.internal_id);
  }

  link(entity: string, externalId: string): string | null {
    return this.links.get(`${entity}:${externalId}`) ?? null;
  }

  async remember(entity: string, externalId: string, internalId: string): Promise<void> {
    this.links.set(`${entity}:${externalId}`, internalId);
    await this.client.query(
      `INSERT INTO import_links (source, entity, external_id, internal_id, run_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source, entity, external_id) DO NOTHING`,
      [SOURCE, entity, externalId, internalId, this.runId],
    );
  }

  warn(message: string): void {
    this.warnings.add(message);
  }
}

function customerName(c: LpCustomer): string {
  const full = `${text(c.first)} ${text(c.last)}`.trim();
  return full || text(c.clientUsername) || text(c.phone) || `Customer ${String(c.id)}`;
}

function emptyResults(): Record<ImportEntity, ImportEntityResult> {
  return Object.fromEntries(
    IMPORT_ENTITIES.map((e) => [e, { created: 0, skipped: 0, failed: 0 }]),
  ) as Record<ImportEntity, ImportEntityResult>;
}
