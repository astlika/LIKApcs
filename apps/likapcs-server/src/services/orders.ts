/**
 * Orders from the PC (0.10.0) — drinks / snacks a customer orders from their seat.
 *
 * Shape of the feature:
 *   • The owner curates the menu (`products.client_menu`, Admin › PC menu). The PC fetches it
 *     with its device token; prices are the ones the POS charges right now (promo-aware).
 *   • Ordering needs a running session on that PC — the order is bound to it. No customer login
 *     is required (the person at the PC is the paying customer); a signed-in customer is attached
 *     when there is one.
 *   • Staff answer in LIKApcs: accept **pay now** (a real POS sale is recorded through the sales
 *     service — stock, receipt, drawer, exactly as at the counter), accept **on the bill** (the
 *     order waits; when the session ends its lines join the session's receipt — see
 *     `SessionsService.end`), or **reject** with a short reason the PC shows.
 *   • An order on the bill can still be paid at the desk before the session ends (`pay`), or be
 *     written off (`void`) with a reason. Nothing here ever moves money by itself: every cent
 *     goes through `sales` / `payments`.
 *   • Snapshots: name, unit price and line total are frozen on the order so a later price change
 *     cannot alter what the customer agreed to.
 */
import {
  type ClientMenu,
  type ClientMenuItem,
  type OrderAccept,
  type OrderCreate,
  type OrderListQuery,
  type OrderPay,
  type OrderPrepare,
  type StationOrder,
  type OrderItemSummary,
  ORDER_MAX_QUANTITY,
} from '@likapcs/shared';
import type { ServerOrderUpdate } from '@likapcs/shared';
import type { DbClient, DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { RealtimeHub } from '../realtime/hub.js';
import { recordAudit, type AuditActor } from './audit.js';
import { ACTIVE_PROMO_SQL } from './ads.js';
import type { AuthenticatedDevice } from './devices.js';
import { ProductImageStore } from './product-images.js';
import type { SaleActor, SalesService } from './sales.js';
import type { OrderLineForSale, SessionOrdersHook } from './sessions.js';
import type { SettingsService } from './settings.js';
import type { StationsService } from './stations.js';

interface OrderRow {
  id: string;
  number: string | number;
  station_id: string;
  station_code: string;
  station_name: string;
  session_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  status: StationOrder['status'];
  settlement: StationOrder['settlement'];
  note: string | null;
  total_cents: string | number;
  reason: string | null;
  sale_id: string | null;
  receipt_no: string | null;
  requested_at: Date;
  decided_at: Date | null;
  decided_by_name: string | null;
  settled_at: Date | null;
  prepared_at: Date | null;
  items: {
    id: number;
    product_id: string;
    name: string;
    quantity_milli: string | number;
    unit_price_cents: string | number;
    line_total_cents: string | number;
    image_path: string | null;
    verified_milli: string | number;
    verification: 'scan' | 'manual' | null;
  }[];
}

const ORDER_SELECT = `
  SELECT o.id, o.number, o.station_id, s.code AS station_code, s.name AS station_name, o.session_id,
         o.customer_id, c.name AS customer_name, o.status, o.settlement, o.note, o.total_cents, o.reason,
         o.sale_id, sa.receipt_no, o.requested_at, o.decided_at, u.full_name AS decided_by_name, o.settled_at,
         o.prepared_at,
         COALESCE((SELECT json_agg(json_build_object('id', i.id, 'product_id', i.product_id, 'name', i.name,
                            'quantity_milli', i.quantity_milli, 'unit_price_cents', i.unit_price_cents,
                            'line_total_cents', i.line_total_cents, 'image_path', p.image_path,
                            'verified_milli', i.verified_milli, 'verification', i.verification) ORDER BY i.id)
                     FROM station_order_items i LEFT JOIN products p ON p.id = i.product_id
                    WHERE i.order_id = o.id), '[]'::json) AS items
    FROM station_orders o
    JOIN stations s ON s.id = o.station_id
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN sales sa ON sa.id = o.sale_id
    LEFT JOIN users u ON u.id = o.decided_by`;

function mapRow(row: OrderRow): StationOrder {
  const items: OrderItemSummary[] = row.items.map((i) => ({
    id: i.id,
    productId: i.product_id,
    name: i.name,
    quantityMilli: Number(i.quantity_milli),
    unitPriceCents: Number(i.unit_price_cents),
    lineTotalCents: Number(i.line_total_cents),
    imageUrl: ProductImageStore.urlFor(i.image_path),
    verifiedMilli: Number(i.verified_milli ?? 0),
    verification: i.verification ?? null,
  }));
  return {
    id: row.id,
    number: Number(row.number),
    stationId: row.station_id,
    stationCode: row.station_code,
    stationName: row.station_name,
    sessionId: row.session_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    status: row.status,
    settlement: row.settlement,
    note: row.note,
    totalCents: Number(row.total_cents),
    reason: row.reason,
    saleId: row.sale_id,
    receiptNo: row.receipt_no,
    items,
    requestedAt: row.requested_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
    decidedByName: row.decided_by_name,
    settledAt: row.settled_at?.toISOString() ?? null,
    preparedAt: row.prepared_at?.toISOString() ?? null,
  };
}

/** The slice of an order the PC shows (never the staff-side details). */
export function toPush(order: StationOrder): ServerOrderUpdate['order'] {
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    settlement: order.settlement,
    totalCents: order.totalCents,
    reason: order.reason,
    items: order.items.map((i) => ({
      name: i.name,
      quantity: Math.round(i.quantityMilli / 1000),
      lineTotalCents: i.lineTotalCents,
    })),
    requestedAt: order.requestedAt,
    decidedAt: order.decidedAt,
    preparedAt: order.preparedAt,
  };
}

interface MenuProductRow {
  id: string;
  name: string;
  category_id: string | null;
  category_name: string | null;
  category_color: string | null;
  selling_price_cents: string | number;
  promo_price_cents: string | number | null;
  image_path: string | null;
  stock_milli: string | number;
  track_stock: boolean;
  allow_negative_stock: boolean;
  average_cost_cents: string | number;
  purchase_cost_cents: string | number;
  is_active: boolean;
  client_menu: boolean;
}

const MENU_SELECT = `
  SELECT p.id, p.name, p.category_id, c.name AS category_name, c.color AS category_color, p.selling_price_cents,
         ${ACTIVE_PROMO_SQL('p')} AS promo_price_cents, p.image_path, p.stock_milli, p.track_stock,
         p.allow_negative_stock, p.average_cost_cents, p.purchase_cost_cents, p.is_active, p.client_menu
    FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

const available = (p: MenuProductRow) =>
  p.is_active && (!p.track_stock || p.allow_negative_stock || Number(p.stock_milli) > 0);

export class OrdersService implements SessionOrdersHook {
  constructor(
    private readonly pool: DbPool,
    private readonly hub: RealtimeHub,
    private readonly settings: SettingsService,
    private readonly stations: StationsService,
    private readonly sales: SalesService,
  ) {}

  // ─── PC side ─────────────────────────────────────────────────────────────────

  /** What the customer at this PC can order right now. */
  async menu(device: AuthenticatedDevice): Promise<ClientMenu> {
    const [enabled, allowNote, currency] = await Promise.all([
      this.settings.get('orders.enabled'),
      this.settings.get('orders.allow_note'),
      this.settings.get('locale.currency'),
    ]);
    const base: ClientMenu = {
      enabled,
      reason: 'ok',
      allowNote,
      currency,
      categories: [],
      items: [],
      staffOnline: this.hub.adminCount() > 0,
    };
    if (!enabled) return { ...base, reason: 'disabled' };
    const station = await this.stations.getById(device.station.id);
    if (!station.activeSession || !station.isEnabled) return { ...base, reason: 'no_session' };
    const rows = await this.pool.query<MenuProductRow>(
      `${MENU_SELECT} WHERE p.client_menu AND p.is_active
        ORDER BY c.sort_order NULLS LAST, c.name NULLS LAST, p.client_menu_order, lower(p.name)`,
    );
    if (!rows.rows.length) return { ...base, reason: 'empty' };
    const categories = new Map<string, ClientMenu['categories'][number]>();
    const items: ClientMenuItem[] = rows.rows.map((p) => {
      const key = p.category_id ?? '';
      if (!categories.has(key))
        categories.set(key, {
          id: p.category_id,
          name: p.category_name ?? '',
          color: p.category_color,
        });
      const promo = p.promo_price_cents === null ? null : Number(p.promo_price_cents);
      return {
        productId: p.id,
        name: p.name,
        categoryId: p.category_id,
        priceCents: promo ?? Number(p.selling_price_cents),
        oldPriceCents: promo === null ? null : Number(p.selling_price_cents),
        imageUrl: ProductImageStore.urlFor(p.image_path),
        available: available(p),
      };
    });
    return { ...base, categories: [...categories.values()], items };
  }

  /** The customer sends an order (device token; bound to the running session on that PC). */
  async create(
    device: AuthenticatedDevice,
    input: OrderCreate,
    customerId: string | null,
    ip: string | null,
  ): Promise<StationOrder> {
    if (!(await this.settings.get('orders.enabled')))
      throw new AppError(403, 'orders_disabled', 'Orders from the PC are switched off');
    const station = await this.stations.getById(device.station.id);
    if (!station.isEnabled) throw conflict('Station is disabled');
    const live = station.activeSession;
    if (!live) throw new AppError(409, 'no_session', 'There is no running session on this PC');
    const allowNote = await this.settings.get('orders.allow_note');
    const note = allowNote && input.note?.trim() ? input.note.trim() : null;

    const id = await withTransaction(this.pool, async (client) => {
      // One open order at a time per product line is not required, but the menu must still
      // offer every product asked for (and have it in stock) at the moment of ordering.
      const ids = [...new Set(input.items.map((i) => i.productId))];
      const rows = await client.query<MenuProductRow>(
        `${MENU_SELECT} WHERE p.id = ANY($1::uuid[]) ORDER BY p.id FOR UPDATE OF p`,
        [ids],
      );
      const byId = new Map(rows.rows.map((p) => [p.id, p]));
      const lines: { product: MenuProductRow; quantityMilli: number }[] = [];
      for (const item of input.items) {
        const product = byId.get(item.productId);
        if (!product || !product.client_menu || !product.is_active)
          throw new AppError(409, 'not_on_menu', 'This product is no longer on the menu', {
            productId: item.productId,
          });
        if (!available(product))
          throw new AppError(409, 'out_of_stock', `${product.name} is out of stock`, {
            productId: item.productId,
          });
        const existing = lines.find((l) => l.product.id === product.id);
        const quantityMilli = Math.min(item.quantity, ORDER_MAX_QUANTITY) * 1000;
        if (existing) existing.quantityMilli += quantityMilli;
        else lines.push({ product, quantityMilli });
      }
      const priced = lines.map((l) => {
        const unit =
          l.product.promo_price_cents === null
            ? Number(l.product.selling_price_cents)
            : Number(l.product.promo_price_cents);
        return { ...l, unit, total: Math.round((unit * l.quantityMilli) / 1000) };
      });
      const total = priced.reduce((acc, l) => acc + l.total, 0);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO station_orders (station_id, device_id, session_id, customer_id, note, total_cents)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [station.id, device.id, live.id, customerId, note, total],
      );
      const orderId = inserted.rows[0]!.id;
      for (const l of priced) {
        await client.query(
          `INSERT INTO station_order_items (order_id, product_id, name, quantity_milli, unit_price_cents, line_total_cents)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [orderId, l.product.id, l.product.name, l.quantityMilli, l.unit, l.total],
        );
      }
      await recordAudit(
        client,
        { deviceId: device.id, label: 'customer', ip },
        {
          action: 'order.create',
          entityType: 'station_order',
          entityId: orderId,
          details: {
            stationId: station.id,
            sessionId: live.id,
            lines: priced.length,
            totalCents: total,
          },
        },
      );
      return orderId;
    });
    const order = await this.getById(id);
    await this.announceOne(order);
    return order;
  }

  /** The open orders of the session running on this PC (newest first) — what the PC lists. */
  async listForDevice(device: AuthenticatedDevice): Promise<StationOrder[]> {
    const station = await this.stations.getById(device.station.id);
    if (!station.activeSession) return [];
    const r = await this.pool.query<OrderRow>(
      `${ORDER_SELECT} WHERE o.session_id = $1 ORDER BY o.requested_at DESC LIMIT 30`,
      [station.activeSession.id],
    );
    return r.rows.map(mapRow);
  }

  async getForDevice(device: AuthenticatedDevice, id: string): Promise<StationOrder> {
    const order = await this.getById(id);
    if (order.stationId !== device.station.id) throw notFound('Order');
    return order;
  }

  /** The customer takes a pending order back. */
  async cancelFromDevice(device: AuthenticatedDevice, id: string): Promise<StationOrder> {
    const changed = await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      if (row.station_id !== device.station.id) throw notFound('Order');
      if (row.status !== 'pending') return false;
      await client.query(
        `UPDATE station_orders SET status = 'cancelled', decided_at = now() WHERE id = $1`,
        [id],
      );
      await recordAudit(
        client,
        { deviceId: device.id, label: 'customer' },
        {
          action: 'order.cancel',
          entityType: 'station_order',
          entityId: id,
          details: { by: 'customer' },
        },
      );
      return true;
    });
    const order = await this.getById(id);
    if (changed) await this.announceOne(order);
    return order;
  }

  // ─── Reads ───────────────────────────────────────────────────────────────────

  async getById(id: string, db: Queryable = this.pool): Promise<StationOrder> {
    const r = await db.query<OrderRow>(`${ORDER_SELECT} WHERE o.id = $1`, [id]);
    if (!r.rows[0]) throw notFound('Order');
    return mapRow(r.rows[0]);
  }

  async list(query: OrderListQuery): Promise<StationOrder[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (query.status) {
      values.push(query.status);
      where.push(`o.status = $${values.length}`);
    } else if (query.open) where.push(`o.status IN ('pending', 'accepted')`);
    if (query.stationId) {
      values.push(query.stationId);
      where.push(`o.station_id = $${values.length}`);
    }
    if (query.sessionId) {
      values.push(query.sessionId);
      where.push(`o.session_id = $${values.length}`);
    }
    values.push(query.limit);
    const r = await this.pool.query<OrderRow>(
      `${ORDER_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY (o.status = 'pending') DESC, o.requested_at DESC LIMIT $${values.length}`,
      values,
    );
    return r.rows.map(mapRow);
  }

  // ─── Staff decisions ─────────────────────────────────────────────────────────

  /**
   * Accept. `pay_now` records a POS sale at once (tenders required unless the order is free);
   * `on_bill` parks it on the running session's bill.
   */
  async accept(id: string, input: OrderAccept, actor: SaleActor): Promise<StationOrder> {
    await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      if (row.status !== 'pending') throw conflict(`Order is already ${row.status}`);
      const customerId = input.customerId === undefined ? row.customer_id : input.customerId;
      if (input.settlement === 'on_bill') {
        const live = row.session_id
          ? await client.query<{ status: string }>(
              `SELECT status FROM gaming_sessions WHERE id = $1 AND status IN ('active', 'paused')`,
              [row.session_id],
            )
          : null;
        if (!live?.rows[0])
          throw conflict('The session has ended — take the payment now instead', {
            code: 'session_ended',
          });
        await client.query(
          `UPDATE station_orders SET status = 'accepted', settlement = 'on_bill', customer_id = $2,
                  decided_at = now(), decided_by = $3 WHERE id = $1`,
          [id, customerId, actor.userId],
        );
        await recordAudit(client, actor, {
          action: 'order.accept',
          entityType: 'station_order',
          entityId: id,
          details: { settlement: 'on_bill', totalCents: Number(row.total_cents) },
        });
        return;
      }
      await this.sellInTransaction(client, row, input.payments ?? [], customerId, actor, 'accept');
    });
    const order = await this.getById(id);
    await this.announceOne(order);
    return order;
  }

  /** An accepted "on the bill" order is paid at the desk before the session ends. */
  async pay(id: string, input: OrderPay, actor: SaleActor): Promise<StationOrder> {
    await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      if (row.status !== 'accepted') throw conflict(`Order is ${row.status}, not on the bill`);
      const customerId = input.customerId === undefined ? row.customer_id : input.customerId;
      await this.sellInTransaction(client, row, input.payments, customerId, actor, 'pay');
    });
    const order = await this.getById(id);
    await this.announceOne(order);
    return order;
  }

  /**
   * The preparation check (0.13.0): after accepting, the desk scans every line (exact quantity,
   * right product) or confirms it by hand. Stored per line for the audit trail; the PC is told the
   * order is on its way. Repeating it overwrites the previous check (a second pass after a fix).
   */
  async prepare(id: string, input: OrderPrepare, actor: AuditActor): Promise<StationOrder> {
    await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      if (!['accepted', 'paid', 'billed'].includes(row.status))
        throw conflict(`Order is ${row.status} — only accepted orders are prepared`, {
          code: 'not_accepted',
        });
      // Exactly once: the verification record and the "on its way" push are not repeatable.
      if (row.prepared_at)
        throw conflict('Order was already prepared', { code: 'already_prepared' });
      const known = new Map(row.items.map((i) => [i.id, i]));
      for (const line of input.items) {
        if (!known.has(line.itemId)) throw notFound('Order line');
      }
      const seen = new Set<number>();
      for (const line of input.items) {
        if (seen.has(line.itemId)) throw badRequest('Duplicate order line', { code: 'DUPLICATE' });
        seen.add(line.itemId);
        await client.query(
          `UPDATE station_order_items SET verified_milli = $2, verification = $3 WHERE id = $1 AND order_id = $4`,
          [line.itemId, line.verifiedMilli, line.verification, id],
        );
      }
      await client.query(
        `UPDATE station_orders SET prepared_at = now(), prepared_by = $2 WHERE id = $1`,
        [id, actor.userId ?? null],
      );
      const scanned = input.items.filter((i) => i.verification === 'scan').length;
      await recordAudit(client, actor, {
        action: 'order.prepare',
        entityType: 'station_order',
        entityId: id,
        details: {
          lines: input.items.length,
          scanned,
          manual: input.items.length - scanned,
          short: input.items.filter(
            (i) => i.verifiedMilli < Number(known.get(i.itemId)?.quantity_milli ?? 0),
          ).length,
        },
      });
    });
    const order = await this.getById(id);
    await this.announceOne(order);
    return order;
  }

  async reject(id: string, actor: AuditActor, reason: string | null): Promise<StationOrder> {
    await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      if (row.status !== 'pending') throw conflict(`Order is already ${row.status}`);
      await client.query(
        `UPDATE station_orders SET status = 'rejected', reason = $2, decided_at = now(), decided_by = $3 WHERE id = $1`,
        [id, reason, actor.userId ?? null],
      );
      await recordAudit(client, actor, {
        action: 'order.reject',
        entityType: 'station_order',
        entityId: id,
        details: { reason },
      });
    });
    const order = await this.getById(id);
    await this.announceOne(order);
    return order;
  }

  /** Write off an accepted order that will not be paid (nothing was sold, nothing moves). */
  async void(id: string, actor: AuditActor, reason: string): Promise<StationOrder> {
    await withTransaction(this.pool, async (client) => {
      const row = await this.lock(client, id);
      if (row.status !== 'accepted') throw conflict(`Order is ${row.status}, not on the bill`);
      await client.query(
        `UPDATE station_orders SET status = 'void', reason = $2, settled_at = now() WHERE id = $1`,
        [id, reason],
      );
      await recordAudit(client, actor, {
        action: 'order.void',
        entityType: 'station_order',
        entityId: id,
        details: { reason, totalCents: Number(row.total_cents) },
      });
    });
    const order = await this.getById(id);
    await this.announceOne(order);
    return order;
  }

  // ─── Session end hook (SessionOrdersHook) ───────────────────────────────────

  async openLinesForSession(client: DbClient, sessionId: string): Promise<OrderLineForSale[]> {
    const r = await client.query<{
      order_id: string;
      product_id: string;
      name: string;
      quantity_milli: string | number;
      unit_price_cents: string | number;
      line_total_cents: string | number;
      track_stock: boolean;
      allow_negative_stock: boolean;
      average_cost_cents: string | number;
      purchase_cost_cents: string | number;
    }>(
      `SELECT i.order_id, i.product_id, i.name, i.quantity_milli, i.unit_price_cents, i.line_total_cents,
              p.track_stock, p.allow_negative_stock, p.average_cost_cents, p.purchase_cost_cents
         FROM station_orders o
         JOIN station_order_items i ON i.order_id = o.id
         JOIN products p ON p.id = i.product_id
        WHERE o.session_id = $1 AND o.status = 'accepted'
        ORDER BY o.requested_at, i.id
        FOR UPDATE OF o`,
      [sessionId],
    );
    return r.rows.map((l) => ({
      orderId: l.order_id,
      productId: l.product_id,
      name: l.name,
      quantityMilli: Number(l.quantity_milli),
      unitPriceCents: Number(l.unit_price_cents),
      lineTotalCents: Number(l.line_total_cents),
      trackStock: l.track_stock,
      allowNegative: l.allow_negative_stock,
      unitCostCents: Number(l.average_cost_cents) || Number(l.purchase_cost_cents),
    }));
  }

  async markBilled(
    client: DbClient,
    orderIds: string[],
    saleId: string,
    actor: AuditActor,
  ): Promise<void> {
    const r = await client.query(
      `UPDATE station_orders SET status = 'billed', sale_id = $2, settled_at = now()
        WHERE id = ANY($1::uuid[]) AND status = 'accepted'`,
      [orderIds, saleId],
    );
    if (r.rowCount !== orderIds.length)
      throw conflict('An order changed while the bill was settled');
    for (const id of orderIds) {
      await recordAudit(client, actor, {
        action: 'order.bill',
        entityType: 'station_order',
        entityId: id,
        details: { saleId },
      });
    }
  }

  async announce(orderIds: string[]): Promise<void> {
    for (const id of orderIds) {
      const order = await this.getById(id).catch(() => null);
      if (order) await this.announceOne(order);
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private async lock(client: DbClient, id: string): Promise<OrderRow> {
    const r = await client.query<OrderRow>(`${ORDER_SELECT} WHERE o.id = $1 FOR UPDATE OF o`, [id]);
    if (!r.rows[0]) throw notFound('Order');
    return r.rows[0];
  }

  /** Records the POS sale for an order and marks it paid — inside the caller's transaction. */
  private async sellInTransaction(
    client: DbClient,
    row: OrderRow,
    payments: OrderAccept['payments'] & {},
    customerId: string | null,
    actor: SaleActor,
    action: 'accept' | 'pay',
  ): Promise<void> {
    if (!actor.permissions.has('pos.sell')) throw forbidden('Missing permission: pos.sell');
    const total = Number(row.total_cents);
    if (total > 0 && !payments.length)
      throw badRequest('A payment is required to record the sale', { code: 'PAYMENT' });
    const sale = await this.sales.createInTransaction(
      client,
      {
        items: row.items.map((i) => ({
          productId: i.product_id,
          quantityMilli: Number(i.quantity_milli),
          discountCents: 0,
        })),
        discountCents: 0,
        customerId,
        notes: `${row.station_code} · order #${row.number}`,
        clientRequestId: `order:${row.id}`,
        payments: total > 0 ? payments : [],
      },
      actor,
      { fixedPrices: new Map(row.items.map((i) => [i.product_id, Number(i.unit_price_cents)])) },
    );
    await client.query(
      `UPDATE station_orders SET status = 'paid', settlement = COALESCE(settlement, 'pay_now'), sale_id = $2, customer_id = $3,
              decided_at = COALESCE(decided_at, now()), decided_by = COALESCE(decided_by, $4), settled_at = now()
        WHERE id = $1`,
      [row.id, sale.id, customerId, actor.userId],
    );
    await recordAudit(client, actor, {
      action: action === 'accept' ? 'order.accept' : 'order.pay',
      entityType: 'station_order',
      entityId: row.id,
      details: { settlement: 'pay_now', saleId: sale.id, totalCents: total },
    });
  }

  private async announceOne(order: StationOrder): Promise<void> {
    this.hub.broadcastToAdmins('order.changed', order);
    const presence = this.hub.listDevices().find((d) => d.stationId === order.stationId);
    if (presence && presence.socket.readyState === presence.socket.OPEN) {
      const message: ServerOrderUpdate = { type: 'server.order', order: toPush(order) };
      presence.socket.send(JSON.stringify(message));
    }
    await this.stations.broadcastStation(order.stationId);
  }
}
