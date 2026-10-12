/**
 * Ads — the owner-curated slideshow on the customer screens (Admin › Ads, migration 0016).
 *
 * Two kinds: `product` (a product, optionally with a promo price) and `custom` (a free slide:
 * title, text, picture). The same table drives two things:
 *   * `clientFeed()` — what LIKApcs-Client shows: enabled ads inside their schedule; product ads
 *     only while the product is active (archived ones drop out by themselves — being out of stock
 *     does *not* hide an ad since 0.7.1, the Admin merely flags it). Ordered by hand
 *     (`sort_order`). Each item carries its theme and its own duration (0017).
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
  AdStyle,
  AdSummary,
  AdTheme,
  ClientAdItem,
} from '@likapcs/shared';
import type { DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { recordAudit, type AuditActor } from './audit.js';
import { ProductImageStore } from './product-images.js';
import type { AdVideoStore } from './ad-videos.js';

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
     AND ${SCHEDULE_SQL('a')}
   LIMIT 1)`;

/**
 * Weekly schedule (0.10.0) in SQL — the same rule as `withinSchedule()` below, evaluated at the
 * database session's local time, which `createPool` pins to the server process's time zone so
 * the two never disagree. Bit 0 of `days_mask` = Monday (ISO weekday 1).
 */
export const SCHEDULE_SQL = (a = 'a') => `(
  (${a}.days_mask::int & (1 << (EXTRACT(ISODOW FROM now())::int - 1))) <> 0
  AND (${a}.time_from IS NULL OR ${a}.time_to IS NULL OR
       CASE WHEN ${a}.time_from < ${a}.time_to
            THEN localtime >= ${a}.time_from AND localtime < ${a}.time_to
            ELSE localtime >= ${a}.time_from OR localtime < ${a}.time_to END))`;

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
  theme: AdTheme | null;
  duration_seconds: number | null;
  starts_at: Date | null;
  ends_at: Date | null;
  style: AdStyle | null;
  accent: string | null;
  cta: string | null;
  days_mask: number;
  time_from: string | null;
  time_to: string | null;
  weight: number;
  station_ids: string[] | null;
  video_path: string | null;
  enabled: boolean;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

/** `HH:MM[:SS]` → minutes since midnight. */
function clockMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
/** Local-time weekly schedule check: weekday bit (Mon = 0) and the optional daily window (may wrap midnight). */
export function withinSchedule(
  row: { days_mask: number; time_from: string | null; time_to: string | null },
  now: Date,
): boolean {
  const mondayIndex = (now.getDay() + 6) % 7;
  if (!(row.days_mask & (1 << mondayIndex))) return false;
  if (!row.time_from || !row.time_to) return true;
  const from = clockMinutes(row.time_from);
  const to = clockMinutes(row.time_to);
  const minute = now.getHours() * 60 + now.getMinutes();
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

const AD_SELECT = `
  SELECT a.id, a.kind, a.product_id, p.name AS product_name, p.sku AS product_sku,
         p.selling_price_cents::text AS product_price_cents,
         CASE WHEN p.id IS NULL THEN NULL ELSE (NOT p.track_stock OR p.stock_milli > 0) END AS product_in_stock,
         p.is_active AS product_active, p.image_path AS product_image_path,
         a.promo_price_cents::text, a.title, a.body, a.image_path, a.badge, a.theme,
         a.duration_seconds, a.starts_at, a.ends_at, a.style, a.accent, a.cta, a.days_mask,
         to_char(a.time_from, 'HH24:MI') AS time_from, to_char(a.time_to, 'HH24:MI') AS time_to,
         a.weight, a.station_ids, a.video_path, a.enabled, a.sort_order, a.created_at,
         a.updated_at
    FROM ads a
    LEFT JOIN products p ON p.id = a.product_id`;
const AD_ORDER = 'ORDER BY a.sort_order, a.created_at, a.id';

export class AdsService {
  private listeners: (() => void)[] = [];

  constructor(
    private readonly pool: DbPool,
    readonly images: ProductImageStore,
    readonly videos: AdVideoStore,
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
    // Archived products leave the screens by themselves; out of stock is only flagged in Admin.
    if (row.kind === 'product' && !row.product_active) return 'unavailable';
    if (!withinSchedule(row, now)) return 'off_hours';
    return 'live';
  }

  private videoUrlOf(row: AdRow): string | null {
    if (!row.video_path) return null;
    return /^https?:\/\//i.test(row.video_path)
      ? row.video_path
      : `/api/v1/files/videos/${row.video_path}`;
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
      theme: row.theme,
      durationSeconds: row.duration_seconds,
      startsAt: row.starts_at?.toISOString() ?? null,
      endsAt: row.ends_at?.toISOString() ?? null,
      style: row.style,
      accent: row.accent,
      cta: row.cta,
      daysMask: row.days_mask,
      timeFrom: row.time_from,
      timeTo: row.time_to,
      weight: row.weight,
      stationIds: row.station_ids ?? [],
      videoUrl: this.videoUrlOf(row),
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

  /**
   * What one PC shows, in order. Only `live` ads (enabled, inside their date range *and* weekly
   * schedule, targeted at this station or at all); a promo only counts while below the price.
   * `nextChangeAt` tells the PC when the weekly schedule next flips a slide on/off, so it can
   * refetch at exactly that minute instead of polling.
   */
  async clientFeed(
    stationId: string | null = null,
    limit = 60,
  ): Promise<{ items: ClientAdItem[]; nextChangeAt: string | null }> {
    const now = new Date();
    const r = await this.pool.query<AdRow & { category_name: string | null }>(
      `${AD_SELECT.replace('FROM ads a', ', c.name AS category_name FROM ads a')}
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE a.enabled
         AND (a.starts_at IS NULL OR a.starts_at <= now())
         AND (a.ends_at IS NULL OR a.ends_at > now())
         AND (a.kind = 'custom' OR p.is_active)
         AND (a.station_ids IS NULL OR $2::uuid IS NULL OR $2::uuid = ANY(a.station_ids))
       ${AD_ORDER} LIMIT $1`,
      [limit * 3, stationId],
    );
    const nextChangeAt = this.nextScheduleChange(r.rows, now);
    const items = r.rows.filter((row) => withinSchedule(row, now)).slice(0, limit);
    return { nextChangeAt, items: items.map((row) => this.toClientItem(row)) };
  }

  /** Earliest minute at which some slide's weekly window opens or closes (null = none scheduled). */
  private nextScheduleChange(rows: AdRow[], now: Date): string | null {
    let best: number | null = null;
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    for (const row of rows) {
      const edges: number[] = [];
      if (row.time_from && row.time_to)
        edges.push(clockMinutes(row.time_from), clockMinutes(row.time_to));
      if (row.days_mask !== 127 || edges.length) edges.push(0); // midnight: a new weekday
      for (const minute of edges) {
        for (const dayOffset of [0, 1]) {
          const at = dayStart + dayOffset * 86_400_000 + minute * 60_000;
          if (at > now.getTime() && (best === null || at < best)) best = at;
        }
      }
    }
    return best === null ? null : new Date(best).toISOString();
  }

  private toClientItem(row: AdRow & { category_name: string | null }): ClientAdItem {
    {
      const regular = row.product_price_cents === null ? null : Number(row.product_price_cents);
      const promo = row.promo_price_cents === null ? null : Number(row.promo_price_cents);
      const promoLive =
        row.kind === 'product' && promo !== null && regular !== null && promo < regular;
      return {
        id: row.id,
        kind: row.kind,
        name: row.kind === 'product' ? (row.product_name ?? '') : (row.title ?? ''),
        body: row.body,
        priceCents: row.kind === 'product' ? (promoLive ? promo : regular) : null,
        oldPriceCents: promoLive ? regular : null,
        badge: row.badge,
        imageUrl: ProductImageStore.urlFor(row.image_path ?? row.product_image_path),
        categoryName: row.kind === 'product' ? row.category_name : null,
        theme: row.theme,
        durationSeconds: row.duration_seconds,
        style: row.style,
        accent: row.accent,
        cta: row.cta,
        endsAt: row.ends_at?.toISOString() ?? null,
        weight: row.weight,
        videoUrl: this.videoUrlOf(row),
      };
    }
  }

  // ─── Writes ─────────────────────────────────────────────────────────────────

  /** Station targeting: every id must be a real station (empty / null = every PC). */
  private async assertStations(client: Queryable, ids: string[] | null | undefined): Promise<void> {
    if (!ids?.length) return;
    const unique = [...new Set(ids)];
    const r = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM stations WHERE id = ANY($1::uuid[])',
      [unique],
    );
    if (Number(r.rows[0]?.n ?? 0) !== unique.length)
      throw badRequest('Unknown station', { field: 'stationIds' });
  }

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
      await this.assertStations(client, input.stationIds);
      const next = await client.query<{ n: number }>(
        'SELECT COALESCE(max(sort_order), 0) + 10 AS n FROM ads',
      );
      const r = await client
        .query<{ id: string }>(
          `INSERT INTO ads (kind, product_id, title, body, promo_price_cents, badge, theme,
                            duration_seconds, starts_at, ends_at, enabled, sort_order, created_by,
                            style, accent, cta, days_mask, time_from, time_to, weight, station_ids, video_path)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                   $14, $15, $16, $17, $18, $19, $20, $21, $22) RETURNING id`,
          [
            input.kind,
            input.kind === 'product' ? input.productId : null,
            input.kind === 'custom' ? input.title : (input.title ?? null),
            input.body ?? null,
            input.kind === 'product' ? (input.promoPriceCents ?? null) : null,
            input.badge ?? null,
            input.theme ?? null,
            input.durationSeconds ?? null,
            input.startsAt ?? null,
            input.endsAt ?? null,
            input.enabled,
            next.rows[0]!.n,
            actor.userId,
            input.style ?? null,
            input.accent ?? null,
            input.cta ?? null,
            input.daysMask ?? 127,
            input.timeFrom ?? null,
            input.timeTo ?? null,
            input.weight ?? 1,
            input.stationIds?.length ? input.stationIds : null,
            input.videoUrl ?? null,
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
    let droppedVideo: string | null = null;
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
        theme: 'theme',
        durationSeconds: 'duration_seconds',
        startsAt: 'starts_at',
        endsAt: 'ends_at',
        enabled: 'enabled',
        style: 'style',
        accent: 'accent',
        cta: 'cta',
        daysMask: 'days_mask',
        timeFrom: 'time_from',
        timeTo: 'time_to',
        weight: 'weight',
        stationIds: 'station_ids',
        videoUrl: 'video_path',
      };
      const sets: string[] = [];
      const values: unknown[] = [];
      if (patch.stationIds !== undefined) await this.assertStations(client, patch.stationIds);
      for (const [key, column] of Object.entries(map)) {
        if (key in patch) {
          const value = (patch as Record<string, unknown>)[key] ?? null;
          // Replacing the video by a link drops an uploaded file; `videoUrl: null` clears both.
          if (key === 'videoUrl') {
            const old = await client.query<{ video_path: string | null }>(
              'SELECT video_path FROM ads WHERE id = $1',
              [id],
            );
            const previous = old.rows[0]?.video_path ?? null;
            if (previous && !/^https?:\/\//i.test(previous) && previous !== value)
              droppedVideo = previous;
          }
          values.push(key === 'stationIds' && Array.isArray(value) && !value.length ? null : value);
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
          if (err.code === '23514' && err.constraint === 'ads_time_window')
            throw badRequest('Set both times or neither', { field: 'timeTo' });
          if (err.code === '23514')
            throw badRequest(`Invalid value (${err.constraint ?? 'check'})`);
          throw err;
        });
      await recordAudit(client, actor, {
        action: 'ads.updated',
        entityType: 'ad',
        entityId: id,
        details: { ...patch },
      });
      return this.get(id, client);
    }).then(async (ad) => {
      if (droppedVideo) await this.videos.remove(droppedVideo);
      this.changed();
      return ad;
    });
  }

  /** Duplicate a slide (same product is not allowed twice — product ads copy as custom slides). */
  async duplicate(id: string, actor: AuditActor): Promise<AdSummary> {
    const source = await this.get(id);
    // A product can only have one ad: the copy is always a custom slide with the product's name.
    const input: AdInput = {
      kind: 'custom',
      productId: null,
      title: source.kind === 'product' ? (source.productName ?? source.title) : source.title,
      body: source.body,
      promoPriceCents: null,
      badge: source.badge,
      theme: source.theme,
      style: source.style,
      accent: source.accent,
      cta: source.cta,
      daysMask: source.daysMask,
      timeFrom: source.timeFrom,
      timeTo: source.timeTo,
      weight: source.weight,
      stationIds: source.stationIds,
      videoUrl: source.videoUrl && /^https?:\/\//i.test(source.videoUrl) ? source.videoUrl : null,
      durationSeconds: source.durationSeconds,
      startsAt: source.startsAt,
      endsAt: source.endsAt,
      enabled: false,
    };
    const copy = await this.create(input, actor);
    if (source.imageUrl) {
      const file = await this.pool.query<{
        image_path: string | null;
        product_image: string | null;
      }>(
        `SELECT a.image_path, p.image_path AS product_image FROM ads a LEFT JOIN products p ON p.id = a.product_id WHERE a.id = $1`,
        [id],
      );
      const name = file.rows[0]?.image_path ?? file.rows[0]?.product_image ?? null;
      if (name) {
        const cloned = await this.images.copy(name).catch(() => null);
        if (cloned) return this.setImage(copy.id, cloned, actor);
      }
    }
    return copy;
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    const files = await withTransaction(this.pool, async (client) => {
      const r = await client.query<{ image_path: string | null; video_path: string | null }>(
        'DELETE FROM ads WHERE id = $1 RETURNING image_path, video_path',
        [id],
      );
      if (!r.rowCount) throw notFound('Ad');
      await recordAudit(client, actor, { action: 'ads.deleted', entityType: 'ad', entityId: id });
      return r.rows[0]!;
    });
    await this.images.remove(files.image_path);
    if (files.video_path && !/^https?:\/\//i.test(files.video_path))
      await this.videos.remove(files.video_path);
    this.changed();
  }

  /** Uploaded video (mp4 / webm) replaces whatever the slide had (picture stays as the poster). */
  async setVideo(id: string, fileName: string, actor: AuditActor): Promise<AdSummary> {
    const previous = await withTransaction(this.pool, async (client) => {
      const r = await client.query<{ video_path: string | null }>(
        `UPDATE ads SET video_path = $2 WHERE id = $1
         RETURNING (SELECT video_path FROM ads WHERE id = $1) AS video_path`,
        [id, fileName],
      );
      if (!r.rowCount) throw notFound('Ad');
      await recordAudit(client, actor, {
        action: 'ads.video_set',
        entityType: 'ad',
        entityId: id,
        details: { file: fileName },
      });
      return r.rows[0]!.video_path;
    }).catch(async (err: unknown) => {
      await this.videos.remove(fileName);
      throw err;
    });
    if (previous && previous !== fileName && !/^https?:\/\//i.test(previous))
      await this.videos.remove(previous);
    this.changed();
    return this.get(id);
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

  /**
   * "Add all products": one plain product ad (no promo) per active product that has none yet,
   * alphabetically after the existing slides. `onlyWithPhoto` restricts it to pictured products.
   */
  async addAllProducts(actor: AuditActor, onlyWithPhoto = false): Promise<AdBulkResult> {
    return withTransaction(this.pool, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO ads (kind, product_id, sort_order, created_by)
           SELECT 'product', p.id,
                  (SELECT COALESCE(max(sort_order), 0) FROM ads) + row_number() OVER (ORDER BY lower(p.name)) * 10,
                  $1
             FROM products p
            WHERE p.is_active AND ($2::boolean = false OR p.image_path IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM ads a WHERE a.kind = 'product' AND a.product_id = p.id)
         RETURNING id`,
        [actor.userId, onlyWithPhoto],
      );
      if (r.rowCount) {
        await recordAudit(client, actor, {
          action: 'ads.bulk_products',
          entityType: 'ad',
          entityId: null,
          details: { created: r.rowCount, onlyWithPhoto },
        });
      }
      return { created: r.rowCount ?? 0, items: await this.list(client) };
    }).then((result) => {
      if (result.created > 0) this.changed();
      return result;
    });
  }

  /**
   * Product browser → "Add n products": plain ads for the chosen products in the given order;
   * products that already have an ad (or do not exist / are archived) are skipped, not an error.
   */
  async addProducts(productIds: string[], actor: AuditActor): Promise<AdBulkResult> {
    const ids = [...new Set(productIds)];
    return withTransaction(this.pool, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO ads (kind, product_id, sort_order, created_by)
           SELECT 'product', p.id,
                  (SELECT COALESCE(max(sort_order), 0) FROM ads) + o.pos * 10,
                  $2
             FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, pos)
             JOIN products p ON p.id = o.id AND p.is_active
            WHERE NOT EXISTS (SELECT 1 FROM ads a WHERE a.kind = 'product' AND a.product_id = p.id)
         RETURNING id`,
        [ids, actor.userId],
      );
      if (r.rowCount) {
        await recordAudit(client, actor, {
          action: 'ads.bulk_products',
          entityType: 'ad',
          entityId: null,
          details: { created: r.rowCount, requested: ids.length },
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
