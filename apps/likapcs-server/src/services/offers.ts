/**
 * Offers (0.36.0): products and PC minutes sold together at one price — "Coca-Cola + 60 min".
 *
 * An offer is a recipe kept here (migration 0062). Selling one is done by the sales service: it
 * puts the offer's products and its PC time on the sale as ordinary lines and shares the offer's
 * price among them (`SalesService.expandOffers`), so stock, cost, tax, the time credit and every
 * report work as for any other sale. Nothing here moves stock or money.
 *
 * 0.36.1: an offer also says what the owner asks of it — how many of it the stock covers, what
 * one sale of it earns (its price without VAT, less what its products cost to buy) and what it
 * has sold so far. The money figures go only to who may see costs (`money`).
 */
import {
  addExclusiveTax,
  multiplyByQuantity,
  multiplyMillsByQuantity,
  offerProfit,
  offerStockUnits,
  type OfferInput,
  type OfferItemSummary,
  type OfferPreview,
  type OfferPreviewInput,
  type OfferProfit,
  type OfferProfitPart,
  type OfferSold,
  type OfferSummary,
} from '@likapcs/shared';
import type { DbClient, DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { badRequest, notFound } from '../errors.js';
import { ACTIVE_PROMO_SQL } from './ads.js';
import { recordAudit, type AuditActor } from './audit.js';
import { ProductImageStore } from './product-images.js';
import type { SettingsService } from './settings.js';

interface OfferRow {
  id: string;
  name: string;
  price_cents: string;
  minutes: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface ProductPartRow {
  product_id: string;
  name: string;
  unit_code: string;
  selling_price_cents: string;
  promo_price_cents: string | null;
  price_includes_tax: boolean;
  /** The rate of the product's own tax category; null: the business default applies. */
  tax_rate_bp: number | null;
  is_active: boolean;
  track_stock: boolean;
  allow_negative_stock: boolean;
  stock_milli: string;
  average_cost_mills: string;
  purchase_cost_mills: string;
  image_path: string | null;
}

interface OfferItemRow extends ProductPartRow {
  offer_id: string;
  quantity_milli: string;
}

/** The product columns an offer item is described by (`p` = products, `tc` = its tax category). */
const PRODUCT_PART_SQL = `p.id AS product_id, p.name, p.unit_code,
              p.selling_price_cents::text, ${ACTIVE_PROMO_SQL('p')}::text AS promo_price_cents,
              p.price_includes_tax, tc.rate_bp AS tax_rate_bp,
              p.is_active, p.track_stock, p.allow_negative_stock, p.stock_milli::text,
              p.average_cost_mills::text, p.purchase_cost_mills::text, p.image_path`;

/**
 * One product of an offer as the till and the form see it. `defaultTaxBp`: the business default
 * VAT rate, for a product without a tax category of its own (as the catalogue and a sale do).
 */
function itemOf(
  row: ProductPartRow,
  quantityMilli: number,
  defaultTaxBp: number,
): OfferItemSummary {
  const price = Number(row.promo_price_cents ?? row.selling_price_cents);
  const stockMilli = Number(row.stock_milli);
  const stockLimited = row.track_stock && !row.allow_negative_stock;
  const taxRateBp = row.tax_rate_bp ?? defaultTaxBp;
  return {
    productId: row.product_id,
    name: row.name,
    quantityMilli,
    unitCode: row.unit_code,
    unitPriceCents: row.price_includes_tax ? price : addExclusiveTax(price, taxRateBp).gross,
    available: row.is_active && (!stockLimited || stockMilli >= quantityMilli),
    imageUrl: ProductImageStore.urlFor(row.image_path),
    stockMilli: row.track_stock ? stockMilli : null,
    stockLimited,
    taxRateBp,
    // What a sale books as the cost of a line (`SalesService.writeLines`).
    unitCostMills: Number(row.average_cost_mills) || Number(row.purchase_cost_mills),
  };
}

/** What `minutes` of PC time cost outside an offer right now, tax included (it may throw). */
export type OfferTimeQuote = (minutes: number) => Promise<number>;

export class OffersService {
  /**
   * `quoteTime`: the price of PC minutes sold without a PC, as the sale itself asks it
   * (`SalesService.priceTimeLines`). It decides how an offer's price is shared between its
   * products and its time, and so the VAT inside it.
   */
  constructor(
    private readonly pool: DbPool,
    private readonly settings: SettingsService,
    private readonly quoteTime: OfferTimeQuote = async () => 0,
  ) {}

  /**
   * Every offer (or only the ones on the till), newest first within the same name order.
   * `money`: with what one sale earns and what the offer has sold so far.
   */
  async list(
    opts: { activeOnly?: boolean; money?: boolean } = {},
    db: Queryable = this.pool,
  ): Promise<OfferSummary[]> {
    const offers = await db.query<OfferRow>(
      `SELECT id, name, price_cents::text, minutes, is_active, created_at, updated_at
         FROM offers
        WHERE ($1::boolean IS NOT TRUE OR is_active)
        ORDER BY is_active DESC, lower(name), created_at`,
      [opts.activeOnly === true],
    );
    return this.withItems(offers.rows, db, opts.money === true);
  }

  async getById(id: string, db: Queryable = this.pool, money = true): Promise<OfferSummary> {
    const offers = await db.query<OfferRow>(
      `SELECT id, name, price_cents::text, minutes, is_active, created_at, updated_at
         FROM offers WHERE id = $1`,
      [id],
    );
    const [offer] = await this.withItems(offers.rows, db, money);
    if (!offer) throw notFound('Offer');
    return offer;
  }

  /**
   * 0.36.1: the offer as it stands in the form — its products with their stock, what the parts
   * cost outside it and what one sale would earn. Nothing is saved.
   */
  async preview(input: OfferPreviewInput): Promise<OfferPreview> {
    const ids = input.items.map((i) => i.productId);
    const rows =
      ids.length === 0
        ? []
        : (
            await this.pool.query<ProductPartRow>(
              `SELECT ${PRODUCT_PART_SQL}
                 FROM products p LEFT JOIN tax_categories tc ON tc.id = p.tax_category_id
                WHERE p.id = ANY($1::uuid[])`,
              [ids],
            )
          ).rows;
    const byId = new Map(rows.map((r) => [r.product_id, r]));
    const defaultTax = await this.defaultTax();
    const items = input.items.map((i) => {
      const row = byId.get(i.productId);
      if (!row) throw notFound(`Product ${i.productId}`);
      return itemOf(row, i.quantityMilli, defaultTax);
    });
    const timeCents = await this.timeCents(input.minutes, new Map());
    return {
      items,
      productsCents: productsCents(items),
      timeCents,
      stockUnits: offerStockUnits(items),
      profit: profitOf(input.priceCents, items, input.minutes, timeCents, defaultTax),
    };
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

  private async withItems(
    offers: OfferRow[],
    db: Queryable,
    money: boolean,
  ): Promise<OfferSummary[]> {
    if (offers.length === 0) return [];
    const ids = offers.map((o) => o.id);
    const items = await db.query<OfferItemRow>(
      `SELECT oi.offer_id, oi.quantity_milli::text, ${PRODUCT_PART_SQL}
         FROM offer_items oi
         JOIN products p ON p.id = oi.product_id
         LEFT JOIN tax_categories tc ON tc.id = p.tax_category_id
        WHERE oi.offer_id = ANY($1::uuid[])
        ORDER BY oi.sort_order, p.name`,
      [ids],
    );
    const defaultTax = await this.defaultTax(db);
    const byOffer = new Map<string, OfferItemSummary[]>();
    for (const row of items.rows) {
      const list = byOffer.get(row.offer_id) ?? [];
      list.push(itemOf(row, Number(row.quantity_milli), defaultTax));
      byOffer.set(row.offer_id, list);
    }
    // The money figures are worked out only for who may see them (the till asks without).
    const sold = money ? await this.sold(ids, db) : null;
    const quotes = new Map<number, number>();
    const out: OfferSummary[] = [];
    for (const o of offers) {
      const own = byOffer.get(o.id) ?? [];
      const priceCents = Number(o.price_cents);
      out.push({
        id: o.id,
        name: o.name,
        priceCents,
        minutes: o.minutes,
        isActive: o.is_active,
        items: own,
        productsCents: productsCents(own),
        available: own.every((i) => i.available),
        stockUnits: offerStockUnits(own),
        profit: money
          ? profitOf(
              priceCents,
              own,
              o.minutes,
              await this.timeCents(o.minutes, quotes),
              defaultTax,
            )
          : null,
        sold: sold ? (sold.get(o.id) ?? { count: 0, revenueCents: 0, profitCents: 0 }) : null,
        createdAt: o.created_at.toISOString(),
        updatedAt: o.updated_at.toISOString(),
      });
    }
    return out;
  }

  /**
   * What `minutes` of PC time cost outside an offer right now; 0 without minutes, and 0 when no
   * price rule applies (such an offer cannot be sold until one does — the share of the time is
   * then unknown, and the whole price is counted on the products).
   */
  private async timeCents(minutes: number, known: Map<number, number>): Promise<number> {
    if (minutes <= 0) return 0;
    const cached = known.get(minutes);
    if (cached !== undefined) return cached;
    let cents = 0;
    try {
      cents = Math.max(0, await this.quoteTime(minutes));
    } catch {
      cents = 0;
    }
    known.set(minutes, cents);
    return cents;
  }

  /**
   * The business default VAT rate — the default tax category, else the setting — as the
   * catalogue and a sale resolve it. PC time is taxed at it, and so is a product without a tax
   * category of its own.
   */
  private async defaultTax(db: Queryable = this.pool): Promise<number> {
    const r = await db.query<{ rate_bp: number }>(
      'SELECT rate_bp FROM tax_categories WHERE is_default LIMIT 1',
    );
    return r.rows[0]?.rate_bp ?? (await this.settings.get('tax.default_rate_bp'));
  }

  /**
   * What each offer has sold so far, from the lines it was sold as (migration 0062), in the
   * terms of the profit report: revenue is what the customers paid — each line's total less its
   * share of a sale discount, less what was refunded; the VAT inside it is taken off; the cost
   * is the cost booked on each line, less the goods a refund put back on the shelf.
   */
  private async sold(ids: string[], db: Queryable): Promise<Map<string, OfferSold>> {
    const r = await db.query<{
      offer_id: string;
      sold: string;
      revenue: string;
      vat: string;
      cost: string;
    }>(
      `WITH lines AS (
         SELECT si.id, si.offer_id, si.sale_id, si.offer_group, si.quantity_milli, si.refunded_milli,
                si.tax_cents, si.cost_cents,
                CASE WHEN s.subtotal_cents > 0
                     THEN si.line_total_cents::numeric * s.total_cents / s.subtotal_cents
                     ELSE 0 END AS charged
           FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE si.offer_id = ANY($1::uuid[])
            AND s.status IN ('completed', 'partially_refunded', 'refunded')
       ), ref AS (
         SELECT ri.sale_item_id,
                SUM(ri.amount_cents) AS amount,
                SUM(CASE WHEN r.restock THEN ri.quantity_milli ELSE 0 END) AS back_milli
           FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
          WHERE ri.sale_item_id IN (SELECT id FROM lines)
          GROUP BY ri.sale_item_id
       ), kept AS (
         SELECT l.offer_id, l.sale_id, l.offer_group, l.refunded_milli < l.quantity_milli AS live,
                GREATEST(l.charged - COALESCE(rf.amount, 0), 0) AS revenue,
                CASE WHEN l.charged > 0
                     THEN l.tax_cents * GREATEST(l.charged - COALESCE(rf.amount, 0), 0) / l.charged
                     ELSE 0 END AS vat,
                l.cost_cents - l.cost_cents::numeric * LEAST(COALESCE(rf.back_milli, 0), l.quantity_milli) / l.quantity_milli AS cost
           FROM lines l LEFT JOIN ref rf ON rf.sale_item_id = l.id
       )
       SELECT offer_id,
              COUNT(DISTINCT (sale_id, offer_group)) FILTER (WHERE live)::text AS sold,
              ROUND(SUM(revenue))::bigint::text AS revenue,
              ROUND(SUM(vat))::bigint::text AS vat,
              ROUND(SUM(cost))::bigint::text AS cost
         FROM kept
        GROUP BY offer_id`,
      [ids],
    );
    return new Map(
      r.rows.map((x) => {
        const revenueCents = Number(x.revenue);
        return [
          x.offer_id,
          {
            count: Number(x.sold),
            revenueCents,
            profitCents: revenueCents - Number(x.vat) - Number(x.cost),
          },
        ];
      }),
    );
  }
}

const productsCents = (items: readonly OfferItemSummary[]): number =>
  items.reduce((sum, i) => sum + multiplyByQuantity(i.unitPriceCents, i.quantityMilli), 0);

/**
 * What one sale of an offer earns: the price shared among its products and its PC time as a sale
 * shares it, each share without its VAT, less what the products cost to buy.
 */
function profitOf(
  priceCents: number,
  items: readonly OfferItemSummary[],
  minutes: number,
  timeCents: number,
  defaultTaxBp: number,
): OfferProfit {
  const parts: OfferProfitPart[] = items.map((i) => ({
    normalCents: multiplyByQuantity(i.unitPriceCents, i.quantityMilli),
    taxRateBp: i.taxRateBp,
    costCents: multiplyMillsByQuantity(i.unitCostMills, i.quantityMilli),
  }));
  if (minutes > 0) parts.push({ normalCents: timeCents, taxRateBp: defaultTaxBp, costCents: 0 });
  return {
    ...offerProfit(priceCents, parts),
    missingCost: items.filter((i) => i.unitCostMills === 0).map((i) => i.name),
  };
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
