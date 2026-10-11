/**
 * Point of sale: completed sales, suspended (parked) sales, refunds and receipts.
 *
 * Every sale is recomputed on the server from database prices with the shared `computeSale`
 * arithmetic — the POS only sends product ids, quantities, discounts and payments. One transaction
 * writes the sale, its lines, the payments, the stock movements and the audit entry; a retry with
 * the same `clientRequestId` returns the sale that already exists instead of selling twice.
 */
import {
  allocateProportionally,
  computeSale,
  customerDiscountCents,
  refundAmountForQuantity,
  settlePayments,
  SaleMathError,
  type CreateSaleRequest,
  type ReceiptData,
  type RefundRequest,
  type RefundSummary,
  type SaleDetail,
  type SaleItemSummary,
  type SaleListQuery,
  type SalePaymentSummary,
  type SaleSummary,
  type SalesListResponse,
  type SuspendSaleRequest,
} from '@likapcs/shared';
import type { DbClient, DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { recordAudit, type AuditActor } from './audit.js';
import { applyMovement } from './catalog.js';
import { nextDocumentNumber } from './documents.js';
import type { SettingsService } from './settings.js';
import type { CashService } from './cash.js';

export interface SaleActor extends AuditActor {
  userId: string;
  permissions: ReadonlySet<string>;
}

interface SaleRow {
  id: string;
  receipt_no: string | null;
  status: SaleSummary['status'];
  source: SaleSummary['source'];
  customer_id: string | null;
  customer_name: string | null;
  cashier_user_id: string;
  cashier_name: string | null;
  subtotal_cents: string;
  discount_cents: string;
  tax_cents: string;
  total_cents: string;
  paid_cents: string;
  change_cents: string;
  refunded_cents: string;
  item_count: string;
  notes: string | null;
  invoice_id: string | null;
  invoice_no: string | null;
  created_at: Date;
  completed_at: Date | null;
}

const SALE_SELECT = `
  SELECT s.id, s.receipt_no, s.status, s.source, s.customer_id, c.name AS customer_name, s.cashier_user_id,
         u.full_name AS cashier_name, s.subtotal_cents::text, s.discount_cents::text, s.tax_cents::text,
         s.total_cents::text, s.paid_cents::text, s.change_cents::text, s.refunded_cents::text,
         (SELECT count(*) FROM sale_items i WHERE i.sale_id = s.id)::text AS item_count,
         s.notes, inv.id AS invoice_id, inv.invoice_no, s.created_at, s.completed_at
    FROM sales s
    LEFT JOIN LATERAL (
      SELECT id, invoice_no FROM invoices
       WHERE sale_id = s.id AND kind = 'invoice' AND status = 'issued' LIMIT 1
    ) inv ON true
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN users u ON u.id = s.cashier_user_id`;

/** The part of a customer record that influences a sale. */
interface CustomerTerms {
  discountBp: number;
}

interface ProductForSale {
  id: string;
  name: string;
  sku: string;
  selling_price_cents: string | number;
  price_includes_tax: boolean;
  average_cost_cents: string | number;
  purchase_cost_cents: string | number;
  track_stock: boolean;
  allow_negative_stock: boolean;
  is_active: boolean;
  tax_rate_bp: number | null;
}

function mapSale(row: SaleRow): SaleSummary {
  return {
    id: row.id,
    receiptNo: row.receipt_no,
    status: row.status,
    source: row.source,
    customerId: row.customer_id,
    customerName: row.customer_name,
    cashierUserId: row.cashier_user_id,
    cashierName: row.cashier_name,
    subtotalCents: Number(row.subtotal_cents),
    discountCents: Number(row.discount_cents),
    taxCents: Number(row.tax_cents),
    totalCents: Number(row.total_cents),
    paidCents: Number(row.paid_cents),
    changeCents: Number(row.change_cents),
    refundedCents: Number(row.refunded_cents),
    itemCount: Number(row.item_count),
    notes: row.notes,
    invoiceId: row.invoice_id,
    invoiceNo: row.invoice_no,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

export class SalesService {
  constructor(
    private readonly pool: DbPool,
    private readonly settings: SettingsService,
    private readonly cash: CashService,
  ) {}

  // ─── Reads ──────────────────────────────────────────────────────────────────

  async getById(id: string, db: Queryable = this.pool): Promise<SaleDetail> {
    const r = await db.query<SaleRow>(`${SALE_SELECT} WHERE s.id = $1`, [id]);
    if (!r.rows[0]) throw notFound('Sale');
    const [items, payments, refunds] = await Promise.all([
      this.items(id, db),
      this.payments(id, db),
      this.refunds(id, db),
    ]);
    return { ...mapSale(r.rows[0]), items, payments, refunds };
  }

  private async items(saleId: string, db: Queryable): Promise<SaleItemSummary[]> {
    const r = await db.query<{
      id: string;
      line_no: number;
      product_id: string | null;
      gaming_session_id: string | null;
      description: string;
      sku: string | null;
      quantity_milli: string;
      unit_price_cents: string;
      discount_cents: string;
      tax_rate_bp: number;
      tax_cents: string;
      line_total_cents: string;
      refunded_milli: string;
    }>(
      `SELECT i.id::text, i.line_no, i.product_id, i.gaming_session_id, i.description, p.sku, i.quantity_milli::text,
              i.unit_price_cents::text, i.discount_cents::text, i.tax_rate_bp, i.tax_cents::text,
              i.line_total_cents::text, i.refunded_milli::text
         FROM sale_items i LEFT JOIN products p ON p.id = i.product_id
        WHERE i.sale_id = $1 ORDER BY i.line_no`,
      [saleId],
    );
    return r.rows.map((i) => ({
      id: Number(i.id),
      lineNo: i.line_no,
      productId: i.product_id,
      gamingSessionId: i.gaming_session_id,
      description: i.description,
      sku: i.sku,
      quantityMilli: Number(i.quantity_milli),
      unitPriceCents: Number(i.unit_price_cents),
      discountCents: Number(i.discount_cents),
      taxRateBp: i.tax_rate_bp,
      taxCents: Number(i.tax_cents),
      lineTotalCents: Number(i.line_total_cents),
      refundedMilli: Number(i.refunded_milli),
    }));
  }

  private async payments(saleId: string, db: Queryable): Promise<SalePaymentSummary[]> {
    const r = await db.query<{
      id: string;
      kind: 'sale' | 'refund';
      method: string;
      amount_cents: string;
      reference: string | null;
      received_at: Date;
    }>(
      `SELECT id, kind, method, amount_cents::text, reference, received_at FROM payments
        WHERE sale_id = $1 ORDER BY received_at, id`,
      [saleId],
    );
    return r.rows.map((p) => ({
      id: p.id,
      kind: p.kind,
      method: p.method,
      amountCents: Number(p.amount_cents),
      reference: p.reference,
      receivedAt: p.received_at.toISOString(),
    }));
  }

  private async refunds(saleId: string, db: Queryable): Promise<RefundSummary[]> {
    const r = await db.query<{
      id: string;
      refund_no: string | null;
      total_cents: string;
      reason: string;
      restock: boolean;
      method: string | null;
      created_by_name: string | null;
      created_at: Date;
      items: { sale_item_id: string; quantity_milli: string; amount_cents: string }[] | null;
    }>(
      `SELECT r.id, r.refund_no, r.total_cents::text, r.reason, r.restock, u.full_name AS created_by_name, r.created_at,
              (SELECT method FROM payments p WHERE p.refund_id = r.id LIMIT 1) AS method,
              (SELECT json_agg(json_build_object('sale_item_id', ri.sale_item_id, 'quantity_milli', ri.quantity_milli,
                                                 'amount_cents', ri.amount_cents))
                 FROM refund_items ri WHERE ri.refund_id = r.id) AS items
         FROM refunds r LEFT JOIN users u ON u.id = r.created_by
        WHERE r.sale_id = $1 ORDER BY r.created_at`,
      [saleId],
    );
    return r.rows.map((x) => ({
      id: x.id,
      refundNo: x.refund_no,
      totalCents: Number(x.total_cents),
      reason: x.reason,
      restock: x.restock,
      method: x.method ?? 'cash',
      createdByName: x.created_by_name,
      createdAt: x.created_at.toISOString(),
      items: (x.items ?? []).map((i) => ({
        saleItemId: Number(i.sale_item_id),
        quantityMilli: Number(i.quantity_milli),
        amountCents: Number(i.amount_cents),
      })),
    }));
  }

  async list(query: SaleListQuery): Promise<SalesListResponse> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (query.status) {
      values.push(query.status);
      where.push(`s.status = $${values.length}`);
    } else {
      where.push(`s.status <> 'void'`);
    }
    if (query.source) {
      values.push(query.source);
      where.push(`s.source = $${values.length}`);
    }
    if (query.cashierId) {
      values.push(query.cashierId);
      where.push(`s.cashier_user_id = $${values.length}`);
    }
    if (query.customerId) {
      values.push(query.customerId);
      where.push(`s.customer_id = $${values.length}`);
    }
    if (query.q) {
      values.push(`%${query.q.toUpperCase()}%`);
      where.push(`upper(COALESCE(s.receipt_no, '')) LIKE $${values.length}`);
    }
    if (query.from) {
      values.push(query.from);
      where.push(`COALESCE(s.completed_at, s.created_at) >= $${values.length}`);
    }
    if (query.to) {
      values.push(query.to);
      where.push(`COALESCE(s.completed_at, s.created_at) <= $${values.length}`);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const summary = await this.pool.query<{ n: string; total: string; refunded: string }>(
      `SELECT count(*)::text AS n,
              COALESCE(sum(CASE WHEN s.status <> 'suspended' THEN s.total_cents ELSE 0 END), 0)::text AS total,
              COALESCE(sum(s.refunded_cents), 0)::text AS refunded
         FROM sales s ${clause}`,
      values,
    );
    values.push(query.pageSize, (query.page - 1) * query.pageSize);
    const rows = await this.pool.query<SaleRow>(
      `${SALE_SELECT} ${clause} ORDER BY COALESCE(s.completed_at, s.created_at) DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return {
      items: rows.rows.map(mapSale),
      total: Number(summary.rows[0]!.n),
      page: query.page,
      pageSize: query.pageSize,
      summary: {
        count: Number(summary.rows[0]!.n),
        totalCents: Number(summary.rows[0]!.total),
        refundedCents: Number(summary.rows[0]!.refunded),
      },
    };
  }

  async receipt(id: string, actor: AuditActor, reprint: boolean): Promise<ReceiptData> {
    const sale = await this.getById(id);
    if (sale.status === 'suspended' || sale.status === 'void')
      throw conflict('This sale has no receipt');
    const s = await this.settings.getAll();
    if (reprint) {
      await this.pool.query(
        `INSERT INTO print_jobs (document_type, document_id, is_reprint, printed_by, status) VALUES ('receipt', $1, true, $2, 'printed')`,
        [id, actor.userId ?? null],
      );
      await recordAudit(this.pool, actor, {
        action: 'sale.receipt.reprinted',
        entityType: 'sale',
        entityId: id,
        details: { receiptNo: sale.receiptNo },
      });
    }
    return {
      business: {
        name: s['business.name'],
        legalName: s['business.legal_name'],
        address: s['business.address'],
        city: s['business.city'],
        phone: s['business.phone'],
        taxId: s['business.tax_id'],
        footer: s['business.receipt_footer'],
      },
      sale,
      currency: s['locale.currency'],
      widthMm: s['pos.receipt_width_mm'],
      autoPrint: s['pos.auto_print_receipt'],
      autoFinishSeconds: s['pos.auto_finish_seconds'],
      printedAt: new Date().toISOString(),
      isReprint: reprint,
    };
  }

  // ─── Writes ─────────────────────────────────────────────────────────────────

  /** Completes a sale (items + payments) in one transaction. */
  async create(input: CreateSaleRequest, actor: SaleActor): Promise<SaleDetail> {
    if (input.clientRequestId) {
      const existing = await this.pool.query<{ id: string }>(
        'SELECT id FROM sales WHERE client_request_id = $1',
        [input.clientRequestId],
      );
      if (existing.rows[0]) return this.getById(existing.rows[0].id);
    }
    return withTransaction(this.pool, async (client) => {
      const saleId = await this.insertSaleShell(client, input, actor, 'completed');
      await this.fillAndComplete(client, saleId, input, input.payments, actor);
      return this.getById(saleId, client);
    });
  }

  /** Parks a sale (no stock change, no payment, no receipt number) to be completed later. */
  async suspend(input: SuspendSaleRequest, actor: SaleActor): Promise<SaleDetail> {
    if (!actor.permissions.has('pos.suspend')) throw forbidden('Missing permission: pos.suspend');
    return withTransaction(this.pool, async (client) => {
      const saleId = await this.insertSaleShell(client, input, actor, 'suspended');
      const products = await this.loadProducts(
        client,
        input.items.map((i) => i.productId),
        false,
      );
      const totals = this.compute(
        input,
        products,
        actor,
        await this.defaultTaxRate(client),
        await this.customerTerms(client, input.customerId),
      );
      await this.writeLines(client, saleId, input, products, totals);
      await client.query(
        `UPDATE sales SET subtotal_cents = $2, discount_cents = $3, tax_cents = $4, total_cents = $5 WHERE id = $1`,
        [saleId, totals.subtotalCents, totals.discountCents, totals.taxCents, totals.totalCents],
      );
      await recordAudit(client, actor, {
        action: 'sale.suspended',
        entityType: 'sale',
        entityId: saleId,
        details: { items: input.items.length, totalCents: totals.totalCents },
      });
      return this.getById(saleId, client);
    });
  }

  /** Completes a suspended sale, replacing its lines with the submitted ones. */
  async completeSuspended(
    id: string,
    input: CreateSaleRequest,
    actor: SaleActor,
  ): Promise<SaleDetail> {
    return withTransaction(this.pool, async (client) => {
      const s = await client.query<{ status: string }>(
        'SELECT status FROM sales WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!s.rows[0]) throw notFound('Sale');
      if (s.rows[0].status !== 'suspended') throw conflict('Only suspended sales can be completed');
      await client.query('DELETE FROM sale_items WHERE sale_id = $1', [id]);
      await client.query(
        `UPDATE sales SET cashier_user_id = $2, customer_id = $3, notes = $4, client_request_id = COALESCE($5, client_request_id)
          WHERE id = $1`,
        [id, actor.userId, input.customerId, input.notes ?? null, input.clientRequestId ?? null],
      );
      await this.fillAndComplete(client, id, input, input.payments, actor);
      return this.getById(id, client);
    });
  }

  async voidSuspended(id: string, actor: SaleActor): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const r = await client.query(
        `UPDATE sales SET status = 'void' WHERE id = $1 AND status = 'suspended'`,
        [id],
      );
      if (!r.rowCount) throw conflict('Only suspended sales can be voided');
      await recordAudit(client, actor, { action: 'sale.voided', entityType: 'sale', entityId: id });
    });
  }

  async refund(saleId: string, input: RefundRequest, actor: SaleActor): Promise<SaleDetail> {
    if (!actor.permissions.has('pos.refund')) throw forbidden('Missing permission: pos.refund');
    return withTransaction(this.pool, async (client) => {
      const sale = await client.query<{
        status: string;
        discount_cents: string;
        total_cents: string;
        refunded_cents: string;
        receipt_no: string | null;
      }>(
        'SELECT status, discount_cents::text, total_cents::text, refunded_cents::text, receipt_no FROM sales WHERE id = $1 FOR UPDATE',
        [saleId],
      );
      if (!sale.rows[0]) throw notFound('Sale');
      if (sale.rows[0].status !== 'completed' && sale.rows[0].status !== 'partially_refunded') {
        throw conflict('This sale cannot be refunded');
      }
      const lines = await client.query<{
        id: string;
        product_id: string | null;
        quantity_milli: string;
        line_total_cents: string;
        refunded_milli: string;
        refunded_cents: string;
        track_stock: boolean | null;
      }>(
        `SELECT i.id::text, i.product_id, i.quantity_milli::text, i.line_total_cents::text, i.refunded_milli::text,
                COALESCE((SELECT sum(ri.amount_cents) FROM refund_items ri WHERE ri.sale_item_id = i.id), 0)::text AS refunded_cents,
                p.track_stock
           FROM sale_items i LEFT JOIN products p ON p.id = i.product_id
          WHERE i.sale_id = $1 ORDER BY i.line_no FOR UPDATE OF i`,
        [saleId],
      );
      const allocation = allocateProportionally(
        Number(sale.rows[0].discount_cents),
        lines.rows.map((l) => Number(l.line_total_cents)),
      );
      const now = new Date();
      const refundNo = await nextDocumentNumber(client, 'refund', now);
      const refundId = (
        await client.query<{ id: string }>(
          `INSERT INTO refunds (refund_no, sale_id, total_cents, reason, restock, created_by, authorized_by)
           VALUES ($1, $2, 1, $3, $4, $5, $5) RETURNING id`,
          [refundNo, saleId, input.reason, input.restock, actor.userId],
        )
      ).rows[0]!.id;
      let total = 0;
      for (const item of input.items) {
        const idx = lines.rows.findIndex((l) => Number(l.id) === item.saleItemId);
        if (idx < 0) throw badRequest(`Line ${item.saleItemId} does not belong to this sale`);
        const line = lines.rows[idx]!;
        const remainingMilli = Number(line.quantity_milli) - Number(line.refunded_milli);
        if (item.quantityMilli > remainingMilli) {
          throw conflict('Refund quantity exceeds what was sold', {
            saleItemId: item.saleItemId,
            remainingMilli,
          });
        }
        const amount = refundAmountForQuantity(
          {
            lineTotalCents: Number(line.line_total_cents),
            allocatedSaleDiscountCents: allocation[idx]!,
            quantityMilli: Number(line.quantity_milli),
          },
          Number(line.refunded_cents),
          item.quantityMilli,
        );
        await client.query(
          'INSERT INTO refund_items (refund_id, sale_item_id, quantity_milli, amount_cents) VALUES ($1, $2, $3, $4)',
          [refundId, item.saleItemId, item.quantityMilli, amount],
        );
        await client.query(
          'UPDATE sale_items SET refunded_milli = refunded_milli + $2 WHERE id = $1',
          [item.saleItemId, item.quantityMilli],
        );
        if (input.restock && line.product_id && line.track_stock) {
          await applyMovement(client, {
            productId: line.product_id,
            type: 'sale_return',
            delta: item.quantityMilli,
            unitCostCents: null,
            reason: input.reason,
            referenceType: 'refund',
            referenceId: refundId,
            actorUserId: actor.userId,
            allowNegative: true,
          });
        }
        total += amount;
      }
      if (total <= 0) throw badRequest('Nothing left to refund on these lines');
      await client.query('UPDATE refunds SET total_cents = $2 WHERE id = $1', [refundId, total]);
      // Cash refunds leave the drawer of the shift that is open now (not the original sale's).
      const refundShiftId = await this.cash.attachTender(client, {
        method: input.method,
        amountCents: -total,
        type: 'refund',
        referenceType: 'refund',
        referenceId: refundId,
        reason: `${refundNo} · ${input.reason}`,
        actorUserId: actor.userId,
      });
      await client.query(
        `INSERT INTO payments (kind, method, amount_cents, sale_id, refund_id, shift_id, received_at, created_by)
         VALUES ('refund', $1, $2, $3, $4, $5, $6, $7)`,
        [input.method, total, saleId, refundId, refundShiftId, now, actor.userId],
      );
      const refundedCents = Number(sale.rows[0].refunded_cents) + total;
      const fully = await client.query<{ open: string }>(
        `SELECT count(*)::text AS open FROM sale_items WHERE sale_id = $1 AND refunded_milli < quantity_milli`,
        [saleId],
      );
      const status =
        Number(fully.rows[0]!.open) === 0 || refundedCents >= Number(sale.rows[0].total_cents)
          ? 'refunded'
          : 'partially_refunded';
      await client.query('UPDATE sales SET refunded_cents = $2, status = $3 WHERE id = $1', [
        saleId,
        refundedCents,
        status,
      ]);
      await recordAudit(client, actor, {
        action: 'sale.refunded',
        entityType: 'sale',
        entityId: saleId,
        details: {
          refundNo,
          receiptNo: sale.rows[0].receipt_no,
          totalCents: total,
          reason: input.reason,
          restock: input.restock,
        },
        severity: 'warning',
      });
      return this.getById(saleId, client);
    });
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private async defaultTaxRate(db: Queryable): Promise<number> {
    const r = await db.query<{ rate_bp: number }>(
      'SELECT rate_bp FROM tax_categories WHERE is_default LIMIT 1',
    );
    return r.rows[0]?.rate_bp ?? (await this.settings.get('tax.default_rate_bp'));
  }

  private async insertSaleShell(
    client: DbClient,
    input: SuspendSaleRequest,
    actor: SaleActor,
    status: 'completed' | 'suspended',
  ): Promise<string> {
    const r = await client
      .query<{ id: string }>(
        `INSERT INTO sales (status, source, customer_id, cashier_user_id, notes, client_request_id)
         VALUES ($1, 'retail', $2, $3, $4, $5) RETURNING id`,
        [
          status,
          input.customerId,
          actor.userId,
          input.notes ?? null,
          input.clientRequestId ?? null,
        ],
      )
      .catch((err: { code?: string }) => {
        if (err.code === '23505')
          throw conflict('This sale was already submitted', { field: 'clientRequestId' });
        throw err;
      });
    return r.rows[0]!.id;
  }

  /** Locks and loads the products of a sale in a stable order (prevents cashier deadlocks). */
  private async loadProducts(
    client: DbClient,
    ids: string[],
    lock: boolean,
  ): Promise<Map<string, ProductForSale>> {
    const unique = [...new Set(ids)].sort();
    const r = await client.query<ProductForSale>(
      `SELECT p.id, p.name, p.sku, p.selling_price_cents, p.price_includes_tax, p.average_cost_cents, p.purchase_cost_cents,
              p.track_stock, p.allow_negative_stock, p.is_active, tc.rate_bp AS tax_rate_bp
         FROM products p LEFT JOIN tax_categories tc ON tc.id = p.tax_category_id
        WHERE p.id = ANY($1::uuid[]) ORDER BY p.id ${lock ? 'FOR UPDATE OF p' : ''}`,
      [unique],
    );
    const map = new Map(r.rows.map((p) => [p.id, p]));
    for (const id of unique) {
      const p = map.get(id);
      if (!p) throw notFound(`Product ${id}`);
      if (!p.is_active)
        throw conflict(`${p.name} is archived and cannot be sold`, { productId: id });
    }
    return map;
  }

  /**
   * Prices and tax always come from the product rows. Cashier-entered discounts need
   * `pos.discount`; a customer's configured default discount (`customers.discount_bp`) is applied by
   * the server itself when no explicit sale discount was entered — it was authorised when the
   * customer record was set up, so no extra permission is required.
   */
  private compute(
    input: SuspendSaleRequest,
    products: Map<string, ProductForSale>,
    actor: SaleActor,
    defaultRate: number,
    customer: CustomerTerms | null,
  ) {
    const hasDiscount = input.discountCents > 0 || input.items.some((i) => i.discountCents > 0);
    if (hasDiscount && !actor.permissions.has('pos.discount')) {
      throw forbidden('Discounts require the pos.discount permission');
    }
    const lines = input.items.map((i) => {
      const p = products.get(i.productId)!;
      return {
        unitPriceCents: Number(p.selling_price_cents),
        quantityMilli: i.quantityMilli,
        discountCents: i.discountCents,
        taxRateBp: p.tax_rate_bp ?? defaultRate,
        priceIncludesTax: p.price_includes_tax,
      };
    });
    try {
      let totals = computeSale(lines, input.discountCents);
      const memberDiscount = customer
        ? customerDiscountCents(totals.subtotalCents, customer.discountBp, input.discountCents)
        : 0;
      if (memberDiscount > 0) totals = computeSale(lines, memberDiscount);
      return { ...totals, cashierDiscount: hasDiscount };
    } catch (err) {
      if (err instanceof SaleMathError) throw badRequest(err.message, { code: err.code });
      throw err;
    }
  }

  /** Loads the customer attached to a sale; blocked or archived customers cannot buy. */
  private async customerTerms(
    client: DbClient,
    customerId: string | null | undefined,
  ): Promise<CustomerTerms | null> {
    if (!customerId) return null;
    const r = await client.query<{ status: string; discount_bp: number; name: string }>(
      'SELECT status, discount_bp, name FROM customers WHERE id = $1',
      [customerId],
    );
    const c = r.rows[0];
    if (!c) throw notFound('Customer');
    if (c.status !== 'active')
      throw conflict(`Customer ${c.name} is ${c.status} and cannot be attached to a sale`, {
        field: 'customerId',
        code: 'CUSTOMER_NOT_ACTIVE',
      });
    return { discountBp: Number(c.discount_bp) };
  }

  private async writeLines(
    client: DbClient,
    saleId: string,
    input: SuspendSaleRequest,
    products: Map<string, ProductForSale>,
    totals: ReturnType<typeof computeSale>,
  ): Promise<void> {
    for (const [i, line] of totals.lines.entries()) {
      const item = input.items[i]!;
      const p = products.get(item.productId)!;
      const unitCost = Number(p.average_cost_cents) || Number(p.purchase_cost_cents);
      await client.query(
        `INSERT INTO sale_items (sale_id, line_no, product_id, description, quantity_milli, unit_price_cents, discount_cents,
                                 tax_rate_bp, tax_cents, line_total_cents, cost_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          saleId,
          i + 1,
          p.id,
          p.name,
          line.quantityMilli,
          line.unitPriceCents,
          line.discountCents,
          line.taxRateBp,
          line.taxCents,
          line.lineTotalCents,
          Math.round((unitCost * line.quantityMilli) / 1000),
        ],
      );
    }
  }

  private async fillAndComplete(
    client: DbClient,
    saleId: string,
    input: SuspendSaleRequest,
    payments: CreateSaleRequest['payments'],
    actor: SaleActor,
  ): Promise<void> {
    const products = await this.loadProducts(
      client,
      input.items.map((i) => i.productId),
      true,
    );
    const totals = this.compute(
      input,
      products,
      actor,
      await this.defaultTaxRate(client),
      await this.customerTerms(client, input.customerId),
    );
    let settled: { paidCents: number; changeCents: number };
    try {
      settled = settlePayments(totals.totalCents, payments);
    } catch (err) {
      if (err instanceof SaleMathError) throw badRequest(err.message, { code: 'PAYMENT' });
      throw err;
    }
    await this.writeLines(client, saleId, input, products, totals);
    // Stock: aggregate per product (the same product may appear on several lines).
    const perProduct = new Map<string, number>();
    for (const item of input.items)
      perProduct.set(item.productId, (perProduct.get(item.productId) ?? 0) + item.quantityMilli);
    for (const [productId, qty] of [...perProduct.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const p = products.get(productId)!;
      if (!p.track_stock) continue;
      await applyMovement(client, {
        productId,
        type: 'sale',
        delta: -qty,
        unitCostCents: Number(p.average_cost_cents) || Number(p.purchase_cost_cents),
        reason: null,
        referenceType: 'sale',
        referenceId: saleId,
        actorUserId: actor.userId,
        allowNegative: p.allow_negative_stock,
      });
    }
    const now = new Date();
    const receiptNo = await nextDocumentNumber(client, 'receipt', now);
    // Cash register: the net cash that went into the drawer (cash tendered minus change given).
    const cashTendered = payments
      .filter((p) => p.method === 'cash')
      .reduce((acc, p) => acc + p.amountCents, 0);
    const shiftId = await this.cash.attachTender(client, {
      method: cashTendered > 0 ? 'cash' : (payments[0]?.method ?? 'other'),
      amountCents: cashTendered - settled.changeCents,
      type: 'sale',
      referenceType: 'sale',
      referenceId: saleId,
      reason: receiptNo,
      actorUserId: actor.userId,
    });
    // Tenders share the transaction timestamp; offset by 1 ms each so they list in entry order.
    for (const [i, p] of payments.entries()) {
      await client.query(
        `INSERT INTO payments (kind, method, amount_cents, sale_id, customer_id, reference, shift_id, received_at, created_by)
         VALUES ('sale', $1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          p.method,
          p.amountCents,
          saleId,
          input.customerId,
          p.reference ?? null,
          shiftId,
          new Date(now.getTime() + i),
          actor.userId,
        ],
      );
    }
    await client.query(
      `UPDATE sales SET status = 'completed', receipt_no = $2, subtotal_cents = $3, discount_cents = $4, tax_cents = $5,
              total_cents = $6, paid_cents = $7, change_cents = $8, discount_authorized_by = $9, completed_at = $10,
              shift_id = $11
        WHERE id = $1`,
      [
        saleId,
        receiptNo,
        totals.subtotalCents,
        totals.discountCents,
        totals.taxCents,
        totals.totalCents,
        settled.paidCents,
        settled.changeCents,
        totals.cashierDiscount ? actor.userId : null,
        now,
        shiftId,
      ],
    );
    await recordAudit(client, actor, {
      action: 'sale.completed',
      entityType: 'sale',
      entityId: saleId,
      details: {
        receiptNo,
        totalCents: totals.totalCents,
        discountCents: totals.discountCents,
        items: input.items.length,
        methods: [...new Set(payments.map((p) => p.method))],
      },
    });
  }
}
