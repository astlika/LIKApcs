/**
 * Ads — the owner-curated slideshow on the customer screens (Admin › Ads, migration 0016).
 *
 * Two kinds: `product` (a product, optionally with a promo price) and `custom` (a free slide:
 * title, text, picture). The same table drives two things:
 *   * `clientFeed()` — what LIKApcs-Client shows: enabled ads inside their schedule, products only
 *     while active and in stock. Ordered by hand (`sort_order`).
 *   * the **promo price** the POS charges: `ACTIVE_PROMO_SQL` is the single definition of "a
 *     promo is live", used by the catalogue (`ProductSummary.promoPriceCents`) and by
 *     `SalesService.loadProducts`, so the shelf, the screen and the receipt always agree.
 *
 * Every change calls `onChange` so the server can push `server.display` to the PCs — they refetch
 * the feed within a second, no reconnect needed.
 */
import type {
  AdBulkResult,
  AdInput,
  AdPatch,
  AdState,
  AdSummary,
  ClientAdItem,
} from '@likapcs/shared';
import type { DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { recordAudit, type AuditActor } from './audit.js';
import { ProductImageStore } from './product-images.js';

/**
 * Promo price of product `p` (alias of the `products` row) if an enabled product ad with a promo
 * is live right now — NULL otherwise. A promo never goes above the regular price even if the
 * product was repriced later.
 */
export const ACTIVE_PROMO_SQL = (p = 'p') => `(
  SELECT a.promo_price_cents FROM ads a
   WHERE a.kind = 'product' AND a.product_id = ${p}.id AND a.enabled
     AND a.promo_price_cents IS NOT NULL AND a.promo_price_cents < ${p}.selling_price_cents
     AND (a.starts_at IS NULL OR a.starts_at <= now())
     AND (a.ends_at IS NULL OR a.ends_at > now())
   LIMIT 1)`;

interface AdRow {
  id: string;
  kind: 'product' | 'custom';
  product_id: string | null;
  product_name: string | null;
  product_sku: string | null;
  product_price_cents: string | null;
  product_in_stock: boolean | null;
  product_active: boolean | null;
  product_image_path: string | null;
  promo_price_cents: string | null;
  title: string | null;
  body: string | null;
  image_path: string | null;
  badge: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  enabled: boolean;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

const AD_SELECT = `
  SELECT a.id, a.kind, a.product_id, p.name AS product_name, p.sku AS product_sku,
         p.selling_price_cents::text AS product_price_cents,
         CASE WHEN p.id IS NULL THEN NULL ELSE (NOT p.track_stock OR p.stock_milli > 0) END AS product_in_stock,
         p.is_active AS product_active, p.image_path AS product_image_path,
         a.promo_price_cents::text, a.title, a.body, a.image_path, a.badge, a.starts_at, a.ends_at,
         a.enabled, a.sort_order, a.created_at, a.updated_at
    FROM ads a
    LEFT JOIN products p ON p.id = a.product_id`;
const AD_ORDER = 'ORDER BY a.sort_order, a.created_at, a.id';

export class AdsService {
  private listeners: (() => void)[] = [];

  constructor(
    private readonly pool: DbPool,
    readonly images: ProductImageStore,
  ) {}

  /** Called after every change (create/update/delete/reorder/picture); used to push `server.display`. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }
  private changed(): void {
    for (const l of this.listeners) l();
  }

  // ─── Mapping ────────────────────────────────────────────────────────────────

  private stateOf(row: AdRow, now: Date): AdState {
    if (!row.enabled) return 'disabled';
    if (row.starts_at && row.starts_at > now) return 'scheduled';
    if (row.ends_at && row.ends_at <= now) return 'expired';
    if (row.kind === 'product' && !(row.product_active && row.product_in_stock))
      return 'unavailable';
    return 'live';
  }

  private map(row: AdRow, now = new Date()): AdSummary {
    const price = row.product_price_cents === null ? null : Number(row.product_price_cents);
    const promoRaw = row.promo_price_cents === null ? null : Number(row.promo_price_cents);
    return {
      id: row.id,
      kind: row.kind,
      productId: row.product_id,
      productName: row.product_name,
      productSku: row.product_sku,
      productPriceCents: price,
      productInStock: row.product_in_stock,
      productActive: row.product_active,
      promoPriceCents: promoRaw,
      title: row.title,
      body: row.body,
      imageUrl: ProductImageStore.urlFor(row.image_path ?? row.product_image_path),
      badge: row.badge,
      startsAt: row.starts_at?.toISOString() ?? null,
      endsAt: row.ends_at?.toISOString() ?? null,
      enabled: row.enabled,
      sortOrder: row.sort_order,
      state: this.stateOf(row, now),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  // ─── Reads ──────────────────────────────────────────────────────────────────

  async list(db: Queryable = this.pool): Promise<AdSummary[]> {
    const r = await db.query<AdRow>(`${AD_SELECT} ${AD_ORDER}`);
    const now = new Date();
    return r.rows.map((row) => this.map(row, now));
  }

  async get(id: string, db: Queryable = this.pool): Promise<AdSummary> {
    const r = await db.query<AdRow>(`${AD_SELECT} WHERE a.id = $1`, [id]);
    if (!r.rows[0]) throw notFound('Ad');
    return this.map(r.rows[0]);
  }

  /** What the PCs show, in order. Only `live` ads; a promo only counts while below the price. */
  async clientFeed(limit = 60): Promise<ClientAdItem[]> {
    const r = await this.pool.query<AdRow & { category_name: string | null }>(
      `${AD_SELECT.replace('FROM ads a', ', c.name AS category_name FROM ads a')}
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE a.enabled
         AND (a.starts_at IS NULL OR a.starts_at <= now())
         AND (a.ends_at IS NULL OR a.ends_at > now())
         AND (a.kind = 'custom' OR (p.is_active AND (NOT p.track_stock OR p.stock_milli > 0)))
       ${AD_ORDER} LIMIT $1`,
      [limit],
    );
    return r.rows.map((row) => {
      const regular = row.product_price_cents === null ? null : Number(row.product_price_cents);
      const promo = row.promo_price_cents === null ? null : Number(row.promo_price_cents);
      const promoLive =
        row.kind === 'product' && promo !== null && regular !== null && promo < regular;
      return {
        id: row.id,
        kind: row.kind,
        name: row.kind === 'product' ? (row.product_name ?? '') : (row.title ?? ''),
        body: row.kind === 'custom' ? row.body : null,
        priceCents: row.kind === 'product' ? (promoLive ? promo : regular) : null,
        oldPriceCents: promoLive ? regular : null,
        badge: row.badge,
        imageUrl: ProductImageStore.urlFor(row.image_path ?? row.product_image_path),
        categoryName: row.kind === 'product' ? row.category_name : null,
      };
    });
  }

  // ─── Writes ─────────────────────────────────────────────────────────────────

  private async assertPromoBelowPrice(
    db: Queryable,
    productId: string,
    promoPriceCents: number | null | undefined,
  ): Promise<void> {
    if (promoPriceCents == null) return;
    const r = await db.query<{ selling_price_cents: string; name: string }>(
      'SELECT selling_price_cents::text, name FROM products WHERE id = $1',
      [productId],
    );
    if (!r.rows[0]) throw notFound('Product');
    if (promoPriceCents >= Number(r.rows[0].selling_price_cents)) {
      throw badRequest(`The promo price must be below the regular price of ${r.rows[0].name}`, {
        code: 'PROMO_NOT_BELOW_PRICE',
        field: 'promoPriceCents',
      });
    }
  }

  async create(input: AdInput, actor: AuditActor): Promise<AdSummary> {
    return withTransaction(this.pool, async (client) => {
      if (input.kind === 'product') {
        await this.assertPromoBelowPrice(client, input.productId!, input.promoPriceCents);
      }
      const next = await client.query<{ n: number }>(
        'SELECT COALESCE(max(sort_order), 0) + 10 AS n FROM ads',
      );
      const r = await client
        .query<{ id: string }>(
          `INSERT INTO ads (kind, product_id, title, body, promo_price_cents, badge, starts_at, ends_at,
                            enabled, sort_order, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [
            input.kind,
            input.kind === 'product' ? input.productId : null,
            input.kind === 'custom' ? input.title : (input.title ?? null),
            input.body ?? null,
            input.kind === 'product' ? (input.promoPriceCents ?? null) : null,
            input.badge ?? null,
            input.startsAt ?? null,
            input.endsAt ?? null,
            input.enabled,
            next.rows[0]!.n,
            actor.userId,
          ],
        )
        .catch((err: { code?: string; constraint?: string }) => {
          if (err.code === '23505')
            throw conflict('This product already has an ad — edit it instead', {
              code: 'AD_EXISTS',
              field: 'productId',
            });
          if (err.code === '23503') throw notFound('Product');
          throw err;
        });
      const id = r.rows[0]!.id;
      await recordAudit(client, actor, {
        action: 'ads.created',
        entityType: 'ad',
        entityId: id,
        details: { ...input },
      });
      return this.get(id, client);
    }).then((ad) => {
      this.changed(); // after commit — the PCs refetch the feed on the push
      return ad;
    });
  }

  async update(id: string, patch: AdPatch, actor: AuditActor): Promise<AdSummary> {
    return withTransaction(this.pool, async (client) => {
      const cur = await client.query<{ kind: string; product_id: string | null }>(
        'SELECT kind, product_id FROM ads WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!cur.rows[0]) throw notFound('Ad');
      const { kind, product_id } = cur.rows[0];
      if (kind === 'custom' && patch.promoPriceCents != null)
        throw badRequest('Only product ads carry a promo price', { field: 'promoPriceCents' });
      if (kind === 'custom' && patch.title === null)
        throw badRequest('A custom slide needs a title', { field: 'title' });
      if (kind === 'product' && product_id)
        await this.assertPromoBelowPrice(client, product_id, patch.promoPriceCents);
      const map: Record<string, string> = {
        title: 'title',
        body: 'body',
        promoPriceCents: 'promo_price_cents',
        badge: 'badge',
        startsAt: 'starts_at',
        endsAt: 'ends_at',
        enabled: 'enabled',
      };
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [key, column] of Object.entries(map)) {
        if (key in patch) {
          values.push((patch as Record<string, unknown>)[key] ?? null);
          sets.push(`${column} = $${values.length}`);
        }
      }
      if (sets.length === 0) throw badRequest('Nothing to update');
      values.push(id);
      await client
        .query(`UPDATE ads SET ${sets.join(', ')} WHERE id = $${values.length}`, values)
        .catch((err: { code?: string; constraint?: string }) => {
          if (err.code === '23514' && err.constraint === 'ads_window')
            throw badRequest('Must end after it starts', { field: 'endsAt' });
          throw err;
        });
      await recordAudit(client, actor, {
        action: 'ads.updated',
        entityType: 'ad',
        entityId: id,
        details: { ...patch },
      });
      return this.get(id, client);
    }).then((ad) => {
      this.changed();
      return ad;
    });
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    const image = await withTransaction(this.pool, async (client) => {
      const r = await client.query<{ image_path: string | null }>(
        'DELETE FROM ads WHERE id = $1 RETURNING image_path',
        [id],
      );
      if (!r.rowCount) throw notFound('Ad');
      await recordAudit(client, actor, { action: 'ads.deleted', entityType: 'ad', entityId: id });
      return r.rows[0]!.image_path;
    });
    await this.images.remove(image);
    this.changed();
  }

  /** New order = the given ids first (in that order); anything not listed keeps following. */
  async reorder(ids: string[], actor: AuditActor): Promise<AdSummary[]> {
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM ads ${AD_ORDER.replace(/a\./g, '')} FOR UPDATE`,
      );
      const known = new Set(existing.rows.map((r) => r.id));
      const unknown = ids.find((id) => !known.has(id));
      if (unknown) throw notFound(`Ad ${unknown}`);
      const order = [...new Set(ids)];
      for (const row of existing.rows) if (!ids.includes(row.id)) order.push(row.id);
      await client.query(
        `UPDATE ads SET sort_order = o.pos * 10
           FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, pos)
          WHERE ads.id = o.id`,
        [order],
      );
      await recordAudit(client, actor, {
        action: 'ads.reordered',
        entityType: 'ad',
        entityId: null,
        details: { count: order.length },
      });
      return this.list(client);
    }).then((list) => {
      this.changed();
      return list;
    });
  }

  /** "Add all products with photos": one product ad per active product with a picture, no promo. */
  async addAllProducts(actor: AuditActor): Promise<AdBulkResult> {
    return withTransaction(this.pool, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO ads (kind, product_id, sort_order, created_by)
           SELECT 'product', p.id,
                  (SELECT COALESCE(max(sort_order), 0) FROM ads) + row_number() OVER (ORDER BY lower(p.name)) * 10,
                  $1
             FROM products p
            WHERE p.is_active AND p.image_path IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM ads a WHERE a.kind = 'product' AND a.product_id = p.id)
         RETURNING id`,
        [actor.userId],
      );
      if (r.rowCount) {
        await recordAudit(client, actor, {
          action: 'ads.bulk_products',
          entityType: 'ad',
          entityId: null,
          details: { created: r.rowCount },
        });
      }
      return { created: r.rowCount ?? 0, items: await this.list(client) };
    }).then((result) => {
      if (result.created > 0) this.changed();
      return result;
    });
  }

  // ─── Pictures (custom slides) ───────────────────────────────────────────────

  async setImage(id: string, fileName: string, actor: AuditActor): Promise<AdSummary> {
    const previous = await withTransaction(this.pool, async (client) => {
      const r = await client.query<{ image_path: string | null }>(
        `UPDATE ads SET image_path = $2 WHERE id = $1
         RETURNING (SELECT image_path FROM ads WHERE id = $1) AS image_path`,
        [id, fileName],
      );
      if (!r.rowCount) throw notFound('Ad');
      await recordAudit(client, actor, {
        action: 'ads.image_set',
        entityType: 'ad',
        entityId: id,
        details: { file: fileName },
      });
      return r.rows[0]!.image_path;
    }).catch(async (err: unknown) => {
      await this.images.remove(fileName);
      throw err;
    });
    if (previous && previous !== fileName) await this.images.remove(previous);
    this.changed();
    return this.get(id);
  }

  async clearImage(id: string, actor: AuditActor): Promise<AdSummary> {
    const previous = await withTransaction(this.pool, async (client) => {
      const r = await client.query<{ image_path: string | null }>(
        `UPDATE ads SET image_path = NULL WHERE id = $1
         RETURNING (SELECT image_path FROM ads WHERE id = $1) AS image_path`,
        [id],
      );
      if (!r.rowCount) throw notFound('Ad');
      await recordAudit(client, actor, {
        action: 'ads.image_cleared',
        entityType: 'ad',
        entityId: id,
      });
      return r.rows[0]!.image_path;
    });
    await this.images.remove(previous);
    this.changed();
    return this.get(id);
  }
}
