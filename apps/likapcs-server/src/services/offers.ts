/**
 * Offers (0.36.0): products and PC minutes sold together at one price — "Coca-Cola + 60 min".
 *
 * An offer is a recipe kept here (migration 0062). Selling one is done by the sales service: it
 * puts the offer's products and its PC time on the sale as ordinary lines and shares the offer's
 * price among them (`SalesService.expandOffers`), so stock, cost, tax, the time credit and every
 * report work as for any other sale. Nothing here moves stock or money.
 */
import {
  addExclusiveTax,
  multiplyByQuantity,
  type OfferInput,
  type OfferItemSummary,
  type OfferSummary,
} from '@likapcs/shared';
import type { DbClient, DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { badRequest, notFound } from '../errors.js';
import { ACTIVE_PROMO_SQL } from './ads.js';
import { recordAudit, type AuditActor } from './audit.js';
import { ProductImageStore } from './product-images.js';

interface OfferRow {
  id: string;
  name: string;
  price_cents: string;
  minutes: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface OfferItemRow {
  offer_id: string;
  product_id: string;
  quantity_milli: string;
  name: string;
  unit_code: string;
  selling_price_cents: string;
  promo_price_cents: string | null;
  price_includes_tax: boolean;
  tax_rate_bp: number;
  is_active: boolean;
  track_stock: boolean;
  allow_negative_stock: boolean;
  stock_milli: string;
  image_path: string | null;
}

export class OffersService {
  constructor(private readonly pool: DbPool) {}

  /** Every offer (or only the ones on the till), newest first within the same name order. */
  async list(
    opts: { activeOnly?: boolean } = {},
    db: Queryable = this.pool,
  ): Promise<OfferSummary[]> {
    const offers = await db.query<OfferRow>(
      `SELECT id, name, price_cents::text, minutes, is_active, created_at, updated_at
         FROM offers
        WHERE ($1::boolean IS NOT TRUE OR is_active)
        ORDER BY is_active DESC, lower(name), created_at`,
      [opts.activeOnly === true],
    );
    return this.withItems(offers.rows, db);
  }

  async getById(id: string, db: Queryable = this.pool): Promise<OfferSummary> {
    const offers = await db.query<OfferRow>(
      `SELECT id, name, price_cents::text, minutes, is_active, created_at, updated_at
         FROM offers WHERE id = $1`,
      [id],
    );
    const [offer] = await this.withItems(offers.rows, db);
    if (!offer) throw notFound('Offer');
    return offer;
  }

  async create(input: OfferInput, actor: AuditActor): Promise<OfferSummary> {
    return withTransaction(this.pool, async (client) => {
      await this.assertProducts(client, input);
      const created = await client.query<{ id: string }>(
        `INSERT INTO offers (name, price_cents, minutes, is_active, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [input.name, input.priceCents, input.minutes, input.isActive, actor.userId ?? null],
      );
      const id = created.rows[0]!.id;
      await this.writeItems(client, id, input);
      await recordAudit(client, actor, {
        action: 'offer.created',
        entityType: 'offer',
        entityId: id,
        details: auditDetails(input),
      });
      return this.getById(id, client);
    });
  }

  /** Replaces the whole offer: name, price, minutes and its products. */
  async update(id: string, input: OfferInput, actor: AuditActor): Promise<OfferSummary> {
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query('SELECT 1 FROM offers WHERE id = $1 FOR UPDATE', [id]);
      if (!existing.rowCount) throw notFound('Offer');
      await this.assertProducts(client, input);
      await client.query(
        'UPDATE offers SET name = $2, price_cents = $3, minutes = $4, is_active = $5 WHERE id = $1',
        [id, input.name, input.priceCents, input.minutes, input.isActive],
      );
      await client.query('DELETE FROM offer_items WHERE offer_id = $1', [id]);
      await this.writeItems(client, id, input);
      await recordAudit(client, actor, {
        action: 'offer.updated',
        entityType: 'offer',
        entityId: id,
        details: auditDetails(input),
      });
      return this.getById(id, client);
    });
  }

  /** On or off the till; an offer that is off keeps everything else. */
  async setActive(id: string, isActive: boolean, actor: AuditActor): Promise<OfferSummary> {
    const r = await this.pool.query('UPDATE offers SET is_active = $2 WHERE id = $1', [
      id,
      isActive,
    ]);
    if (!r.rowCount) throw notFound('Offer');
    await recordAudit(this.pool, actor, {
      action: isActive ? 'offer.enabled' : 'offer.disabled',
      entityType: 'offer',
      entityId: id,
    });
    return this.getById(id);
  }

  /** Deletes the offer. Sales made with it keep its name on their lines (migration 0062). */
  async remove(id: string, actor: AuditActor): Promise<void> {
    const r = await this.pool.query<{ name: string }>(
      'DELETE FROM offers WHERE id = $1 RETURNING name',
      [id],
    );
    if (!r.rows[0]) throw notFound('Offer');
    await recordAudit(this.pool, actor, {
      action: 'offer.deleted',
      entityType: 'offer',
      entityId: id,
      details: { name: r.rows[0].name },
    });
  }

  /**
   * Only ordinary products go into an offer: an internet access package hands out a code per
   * unit and is sold on its own.
   */
  private async assertProducts(client: DbClient, input: OfferInput): Promise<void> {
    if (input.items.length === 0) return;
    const ids = input.items.map((i) => i.productId);
    const found = await client.query<{ id: string; name: string; kind: string }>(
      'SELECT id, name, kind FROM products WHERE id = ANY($1::uuid[])',
      [ids],
    );
    const byId = new Map(found.rows.map((p) => [p.id, p]));
    for (const id of ids) {
      const p = byId.get(id);
      if (!p) throw notFound(`Product ${id}`);
      if (p.kind !== 'standard')
        throw badRequest(`${p.name} cannot be part of an offer`, {
          code: 'OFFER_PRODUCT_KIND',
          productId: id,
        });
    }
  }

  private async writeItems(client: DbClient, offerId: string, input: OfferInput): Promise<void> {
    for (const [i, item] of input.items.entries()) {
      await client.query(
        `INSERT INTO offer_items (offer_id, product_id, quantity_milli, sort_order)
         VALUES ($1, $2, $3, $4)`,
        [offerId, item.productId, item.quantityMilli, i],
      );
    }
  }

  private async withItems(offers: OfferRow[], db: Queryable): Promise<OfferSummary[]> {
    if (offers.length === 0) return [];
    const items = await db.query<OfferItemRow>(
      `SELECT oi.offer_id, oi.product_id, oi.quantity_milli::text, p.name, p.unit_code,
              p.selling_price_cents::text, ${ACTIVE_PROMO_SQL('p')}::text AS promo_price_cents,
              p.price_includes_tax,
              COALESCE(tc.rate_bp, (SELECT rate_bp FROM tax_categories WHERE is_default LIMIT 1), 0) AS tax_rate_bp,
              p.is_active, p.track_stock, p.allow_negative_stock, p.stock_milli::text, p.image_path
         FROM offer_items oi
         JOIN products p ON p.id = oi.product_id
         LEFT JOIN tax_categories tc ON tc.id = p.tax_category_id
        WHERE oi.offer_id = ANY($1::uuid[])
        ORDER BY oi.sort_order, p.name`,
      [offers.map((o) => o.id)],
    );
    const byOffer = new Map<string, OfferItemSummary[]>();
    for (const row of items.rows) {
      const quantityMilli = Number(row.quantity_milli);
      const price = Number(row.promo_price_cents ?? row.selling_price_cents);
      const list = byOffer.get(row.offer_id) ?? [];
      list.push({
        productId: row.product_id,
        name: row.name,
        quantityMilli,
        unitCode: row.unit_code,
        unitPriceCents: row.price_includes_tax
          ? price
          : addExclusiveTax(price, row.tax_rate_bp).gross,
        available:
          row.is_active &&
          (!row.track_stock ||
            row.allow_negative_stock ||
            Number(row.stock_milli) >= quantityMilli),
        imageUrl: ProductImageStore.urlFor(row.image_path),
      });
      byOffer.set(row.offer_id, list);
    }
    return offers.map((o) => {
      const own = byOffer.get(o.id) ?? [];
      return {
        id: o.id,
        name: o.name,
        priceCents: Number(o.price_cents),
        minutes: o.minutes,
        isActive: o.is_active,
        items: own,
        productsCents: own.reduce(
          (sum, i) => sum + multiplyByQuantity(i.unitPriceCents, i.quantityMilli),
          0,
        ),
        available: own.every((i) => i.available),
        createdAt: o.created_at.toISOString(),
        updatedAt: o.updated_at.toISOString(),
      };
    });
  }
}

function auditDetails(input: OfferInput) {
  return {
    name: input.name,
    priceCents: input.priceCents,
    minutes: input.minutes,
    products: input.items.length,
    isActive: input.isActive,
  };
}
