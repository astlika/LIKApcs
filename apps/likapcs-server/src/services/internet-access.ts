/**
 * Internet access (0.34.0): Wi-Fi access codes sold at the till as products.
 *
 * A package ("Internet 1h") is a product of the kind `internet_access`; its codes are pasted in
 * bulk and each unit sold hands out the oldest unused one. The package's stock is the number of
 * its unused codes — always: every change here moves the stock and the codes in one transaction,
 * and the database refuses a transaction that would leave the two apart (migration 0057).
 *
 * Everything about one package is serialised on its product row (the sale locks it too), so two
 * tills can never be given the same code.
 */
import { randomUUID } from 'node:crypto';
import {
  productSchema,
  type InternetAccessCheckResult,
  type InternetAccessCodeStatus,
  type InternetAccessCodeSummary,
  type InternetAccessCodesQuery,
  type InternetAccessKnownCode,
  type InternetAccessLoadRequest,
  type InternetAccessLoadResult,
  type InternetAccessPackageSummary,
  type InternetAccessRemoveRequest,
  type InternetAccessRemoveResult,
  type Paginated,
  type ProductKind,
  type ProductSummary,
} from '@likapcs/shared';
import type { DbClient, DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { conflict, notFound } from '../errors.js';
import { recordAudit, type AuditActor } from './audit.js';
import { applyMovement, type CatalogService } from './catalog.js';

/** How many codes one statement carries (a load of 5,000 goes in a few round trips). */
const CHUNK = 1000;

function chunks<T>(list: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export class InternetAccessService {
  constructor(
    private readonly pool: DbPool,
    private readonly catalog: CatalogService,
  ) {}

  // ─── Reads ─────────────────────────────────────────────────────────────────

  /** Every package, cheapest first (1h before 2h before a day), with its code counts. */
  async listPackages(db: Queryable = this.pool): Promise<InternetAccessPackageSummary[]> {
    const products = await db.query<{ id: string }>(
      `SELECT id FROM products WHERE kind = 'internet_access'
        ORDER BY is_active DESC, selling_price_cents, lower(name)`,
    );
    const out: InternetAccessPackageSummary[] = [];
    const counts = await this.counts(
      db,
      products.rows.map((p) => p.id),
    );
    for (const row of products.rows) {
      out.push(this.summary(await this.catalog.getProduct(row.id, db), counts.get(row.id)));
    }
    return out;
  }

  async getPackage(
    productId: string,
    db: Queryable = this.pool,
  ): Promise<InternetAccessPackageSummary> {
    const product = await this.catalog.getProduct(productId, db);
    if (product.kind !== 'internet_access') throw notInternetAccess(product.name);
    return this.summary(product, (await this.counts(db, [productId])).get(productId));
  }

  private summary(product: ProductSummary, counts?: PackageCounts): InternetAccessPackageSummary {
    return {
      product,
      availableCodes: counts?.available ?? 0,
      soldCodes: counts?.sold ?? 0,
      lastLoadedAt: counts?.lastLoadedAt ?? null,
      lastSoldAt: counts?.lastSoldAt ?? null,
    };
  }

  private async counts(db: Queryable, productIds: string[]): Promise<Map<string, PackageCounts>> {
    if (productIds.length === 0) return new Map();
    const r = await db.query<{
      product_id: string;
      available: string;
      sold: string;
      last_loaded_at: Date | null;
      last_sold_at: Date | null;
    }>(
      `SELECT product_id,
              count(*) FILTER (WHERE status = 'available')::text AS available,
              count(*) FILTER (WHERE status = 'sold')::text AS sold,
              max(created_at) AS last_loaded_at, max(sold_at) AS last_sold_at
         FROM internet_access_codes WHERE product_id = ANY($1::uuid[]) GROUP BY product_id`,
      [productIds],
    );
    return new Map(
      r.rows.map((c) => [
        c.product_id,
        {
          available: Number(c.available),
          sold: Number(c.sold),
          lastLoadedAt: c.last_loaded_at?.toISOString() ?? null,
          lastSoldAt: c.last_sold_at?.toISOString() ?? null,
        },
      ]),
    );
  }

  /** What a paste would do: which codes already wait to be sold, which were sold before. */
  async check(
    codes: readonly string[],
    db: Queryable = this.pool,
  ): Promise<InternetAccessCheckResult> {
    const unique = [...new Set(codes)];
    const waiting: InternetAccessKnownCode[] = [];
    const soldBefore: InternetAccessKnownCode[] = [];
    for (const part of chunks(unique)) {
      // One row per known code: the one that waits to be sold wins over an older sale of it.
      const r = await db.query<{
        code: string;
        status: InternetAccessCodeStatus;
        product_id: string;
        product_name: string;
        sold_at: Date | null;
      }>(
        `SELECT DISTINCT ON (c.code) c.code, c.status, c.product_id, p.name AS product_name, c.sold_at
           FROM internet_access_codes c JOIN products p ON p.id = c.product_id
          WHERE c.code = ANY($1::text[])
          ORDER BY c.code, (c.status = 'available') DESC, c.sold_at DESC NULLS LAST, c.id DESC`,
        [part],
      );
      for (const k of r.rows) {
        const known: InternetAccessKnownCode = {
          code: k.code,
          productId: k.product_id,
          productName: k.product_name,
          soldAt: k.status === 'sold' ? (k.sold_at?.toISOString() ?? null) : null,
        };
        (k.status === 'available' ? waiting : soldBefore).push(known);
      }
    }
    // In the order of the paste, so the owner finds them in the list they copied from.
    const order = new Map(unique.map((code, i) => [code, i]));
    const byPaste = (a: InternetAccessKnownCode, b: InternetAccessKnownCode) =>
      order.get(a.code)! - order.get(b.code)!;
    waiting.sort(byPaste);
    soldBefore.sort(byPaste);
    return { fresh: unique.length - waiting.length - soldBefore.length, waiting, soldBefore };
  }

  async listCodes(query: InternetAccessCodesQuery): Promise<Paginated<InternetAccessCodeSummary>> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (query.productId) {
      values.push(query.productId);
      where.push(`c.product_id = $${values.length}`);
    }
    if (query.status) {
      values.push(query.status);
      where.push(`c.status = $${values.length}`);
    }
    if (query.q) {
      // A part of a code, matched as typed (codes are case-sensitive); `%` and `_` are literal.
      values.push(`%${query.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
      where.push(`c.code LIKE $${values.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM internet_access_codes c ${clause}`,
      values,
    );
    values.push(query.pageSize, (query.page - 1) * query.pageSize);
    const r = await this.pool.query<{
      id: string;
      code: string;
      status: InternetAccessCodeStatus;
      product_id: string;
      product_name: string;
      batch_id: string;
      created_at: Date;
      loaded_by: string | null;
      sale_id: string | null;
      receipt_no: string | null;
      sold_at: Date | null;
      sold_by: string | null;
    }>(
      // Unused codes in the order they will be sold; sold ones newest first.
      `SELECT c.id::text, c.code, c.status, c.product_id, p.name AS product_name, c.batch_id, c.created_at,
              lu.full_name AS loaded_by, c.sale_id, s.receipt_no, c.sold_at, su.full_name AS sold_by
         FROM internet_access_codes c
         JOIN products p ON p.id = c.product_id
         LEFT JOIN users lu ON lu.id = c.created_by
         LEFT JOIN users su ON su.id = c.sold_by
         LEFT JOIN sales s ON s.id = c.sale_id
         ${clause}
        ORDER BY (c.status = 'available') DESC,
                 CASE WHEN c.status = 'available' THEN c.id END ASC,
                 c.sold_at DESC NULLS LAST, c.id DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return {
      items: r.rows.map((c) => ({
        id: Number(c.id),
        code: c.code,
        status: c.status,
        productId: c.product_id,
        productName: c.product_name,
        batchId: c.batch_id,
        loadedAt: c.created_at.toISOString(),
        loadedByName: c.loaded_by,
        saleId: c.sale_id,
        receiptNo: c.receipt_no,
        soldAt: c.sold_at?.toISOString() ?? null,
        soldByName: c.sold_by,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: Number(total.rows[0]!.n),
    };
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  /**
   * Adds pasted codes to a package, creating the package first when asked. A code that already
   * waits to be sold (in any package) is never added again, so pasting a list twice is harmless;
   * a code that was sold before is added only with `allowSoldBefore`.
   */
  async load(
    input: InternetAccessLoadRequest,
    actor: AuditActor,
  ): Promise<InternetAccessLoadResult> {
    return withTransaction(this.pool, async (client) => {
      // One load at a time: "is this code already waiting?" must not race with another paste.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('likapcs.internet_access.load'))`);

      let productId: string;
      let created = false;
      if (input.package) {
        // Two packages with one name could not be told apart on the till.
        const twin = await client.query<{ id: string }>(
          `SELECT id FROM products
            WHERE kind = 'internet_access' AND is_active AND lower(name) = lower($1) LIMIT 1`,
          [input.package.name],
        );
        if (twin.rows[0]) {
          throw conflict(`There is already a package called ${input.package.name}`, {
            code: 'ACCESS_PACKAGE_EXISTS',
            field: 'name',
            productId: twin.rows[0].id,
          });
        }
        const product = await this.catalog.createProductIn(
          client,
          productSchema.parse({
            name: input.package.name,
            sellingPriceCents: input.package.sellingPriceCents,
            categoryId: input.package.categoryId,
            minStockMilli: input.package.lowAtCodes * 1000,
            unitCode: 'pc',
            trackStock: true,
            allowNegativeStock: false,
            clientMenu: false,
          }),
          actor,
          'internet_access',
        );
        productId = product.id;
        created = true;
      } else {
        const found = await lockPackage(client, input.productId!);
        productId = found.id;
      }

      const codes = [...new Set(input.codes)];
      const known =
        codes.length > 0
          ? await this.check(codes, client)
          : { fresh: 0, waiting: [], soldBefore: [] };
      const skip = new Set(known.waiting.map((k) => k.code));
      if (!input.allowSoldBefore) for (const k of known.soldBefore) skip.add(k.code);
      const toAdd = codes.filter((code) => !skip.has(code));

      let batchId: string | null = null;
      if (toAdd.length > 0) {
        batchId = randomUUID();
        // The stock first, then exactly as many codes: the database checks the two agree.
        await applyMovement(client, {
          productId,
          type: 'codes_loaded',
          delta: toAdd.length * 1000,
          unitCostCents: null,
          reason: null,
          referenceType: 'internet_access_load',
          referenceId: batchId,
          actorUserId: actor.userId ?? null,
          allowNegative: false,
          accessCodes: true,
        });
        // One statement, in the order of the paste: the codes are sold in that order later.
        await client.query(
          `INSERT INTO internet_access_codes (product_id, code, batch_id, created_by)
           SELECT $1, t.code, $3, $4
             FROM unnest($2::text[]) WITH ORDINALITY AS t(code, ord)
            ORDER BY t.ord`,
          [productId, toAdd, batchId, actor.userId ?? null],
        );
      }
      await recordAudit(client, actor, {
        action: 'internet_access.codes.loaded',
        entityType: 'product',
        entityId: productId,
        details: {
          batchId,
          added: toAdd.length,
          pasted: codes.length,
          alreadyWaiting: known.waiting.length,
          soldBefore: known.soldBefore.length,
          soldBeforeAdded: input.allowSoldBefore ? known.soldBefore.length : 0,
          packageCreated: created,
        },
      });
      return {
        ...known,
        package: await this.getPackage(productId, client),
        added: toAdd.length,
        batchId,
        created,
      };
    });
  }

  /** Takes unused codes out of a package; the stock goes down by the same number. */
  async remove(
    input: InternetAccessRemoveRequest,
    actor: AuditActor,
  ): Promise<InternetAccessRemoveResult> {
    return withTransaction(this.pool, async (client) => {
      const pkg = await lockPackage(client, input.productId);
      const filter =
        input.ids !== undefined
          ? { sql: 'AND id = ANY($2::bigint[])', value: input.ids as unknown }
          : input.batchId !== undefined
            ? { sql: 'AND batch_id = $2::uuid', value: input.batchId as unknown }
            : { sql: 'AND $2::boolean', value: true as unknown };
      // Only codes that are still unused (a sold one stays for good), locked until the commit.
      const picked = await client.query<{ id: string }>(
        `SELECT id::text FROM internet_access_codes
          WHERE product_id = $1 AND status = 'available' ${filter.sql}
          ORDER BY id FOR UPDATE`,
        [pkg.id, filter.value],
      );
      const ids = picked.rows.map((r) => r.id);
      if (ids.length === 0) {
        throw conflict('None of these codes is unused any more — nothing was removed', {
          code: 'ACCESS_CODES_NONE_UNUSED',
        });
      }
      await applyMovement(client, {
        productId: pkg.id,
        type: 'codes_removed',
        delta: -ids.length * 1000,
        unitCostCents: null,
        reason: input.reason,
        referenceType: 'internet_access_remove',
        referenceId: input.batchId ?? null,
        actorUserId: actor.userId ?? null,
        allowNegative: false,
        accessCodes: true,
      });
      await client.query('DELETE FROM internet_access_codes WHERE id = ANY($1::bigint[])', [ids]);
      await recordAudit(client, actor, {
        action: 'internet_access.codes.removed',
        entityType: 'product',
        entityId: pkg.id,
        details: {
          removed: ids.length,
          reason: input.reason,
          scope: input.ids !== undefined ? 'chosen' : input.batchId !== undefined ? 'load' : 'all',
          ...(input.batchId ? { batchId: input.batchId } : {}),
        },
        severity: 'warning',
      });
      return { removed: ids.length, package: await this.getPackage(pkg.id, client) };
    });
  }
}

interface PackageCounts {
  available: number;
  sold: number;
  lastLoadedAt: string | null;
  lastSoldAt: string | null;
}

function notInternetAccess(name: string) {
  return conflict(`${name} is not an internet access package`, { code: 'NOT_INTERNET_ACCESS' });
}

/** Locks the package's product row: loads, removals and sales of one package never interleave. */
async function lockPackage(
  client: DbClient,
  productId: string,
): Promise<{ id: string; name: string }> {
  const r = await client.query<{ id: string; name: string; kind: ProductKind }>(
    'SELECT id, name, kind FROM products WHERE id = $1 FOR UPDATE',
    [productId],
  );
  const row = r.rows[0];
  if (!row) throw notFound('Product');
  if (row.kind !== 'internet_access') throw notInternetAccess(row.name);
  return { id: row.id, name: row.name };
}

/**
 * The sale's side (called by `SalesService` right after the stock went down, with the product row
 * locked): marks the oldest unused codes of a package sold, one per entry of `saleItemIds` — the
 * line each unit was sold on. One statement, so the stock and the codes agree again at once.
 */
export async function takeAccessCodes(
  client: DbClient,
  input: {
    productId: string;
    productName: string;
    saleId: string;
    saleItemIds: number[];
    soldBy: string | null | undefined;
  },
): Promise<void> {
  const wanted = input.saleItemIds.length;
  if (wanted === 0) return;
  const r = await client.query(
    `WITH picked AS (
       SELECT next.id, row_number() OVER (ORDER BY next.id) AS rn
         FROM (SELECT id FROM internet_access_codes
                WHERE product_id = $1 AND status = 'available'
                ORDER BY id LIMIT $2 FOR UPDATE) next
     )
     UPDATE internet_access_codes c
        SET status = 'sold', sale_id = $3, sale_item_id = ($4::bigint[])[picked.rn::int],
            sold_by = $5, sold_at = now()
       FROM picked WHERE c.id = picked.id`,
    [input.productId, wanted, input.saleId, input.saleItemIds, input.soldBy ?? null],
  );
  if (r.rowCount !== wanted) {
    // The stock said there were enough: only a stock that drifted from the codes gets here, and
    // the database refuses that too. The sale is rolled back; no customer leaves without a code.
    throw conflict(`Insufficient stock for ${input.productName}`, {
      code: 'INSUFFICIENT_STOCK',
      productId: input.productId,
      productName: input.productName,
      availableMilli: (r.rowCount ?? 0) * 1000,
      requestedMilli: wanted * 1000,
    });
  }
}
