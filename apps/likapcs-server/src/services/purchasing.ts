/**
 * Suppliers and purchases (Phase 7).
 *
 * A purchase is the supplier invoice / delivery: lines of product × quantity × unit cost. Receiving
 * goods books an inventory movement per line (`purchase_receipt`) and moves the product's cost
 * prices: `purchase_cost_cents` = last unit cost, `average_cost_cents` = weighted average of the
 * stock on hand and the received lot. Everything that changes stock or money happens in one
 * transaction with the product rows locked (same `applyMovement` as sales and adjustments).
 *
 * Supplier payments in cash leave the drawer of the open shift (`supplier_payment` movement);
 * card / bank payments only update the purchase. Purchases are never deleted: a purchase with no
 * receipts and no payments may be cancelled, everything else stays as history.
 *
 * Money: integer cents; quantities: milli-units; VAT on purchases is informational (cost prices are
 * net of VAT; the shop's resale VAT is handled by the sales side).
 */
import type {
  CreatePurchaseRequest,
  PaymentMethod,
  PurchaseDetail,
  PurchaseItemSummary,
  PurchaseListQuery,
  PurchaseListResponse,
  PurchasePaymentInput,
  PurchasePaymentStatus,
  PurchasePaymentSummary,
  PurchaseReceiptSummary,
  PurchaseStatus,
  PurchaseSummary,
  ReceivePurchaseRequest,
  SupplierListQuery,
  SupplierPatch,
  SupplierRequest,
  SupplierSummary,
} from '@likapcs/shared';
import { multiplyByQuantity, percentOf } from '@likapcs/shared';
import type { DbClient, DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { recordAudit, type AuditActor } from './audit.js';
import type { CashService } from './cash.js';
import { applyMovement } from './catalog.js';
import { nextDocumentNumber } from './documents.js';

// ─── Row types ───────────────────────────────────────────────────────────────

interface SupplierRow {
  id: string;
  name: string;
  business_name: string | null;
  tax_id: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  contact_person: string | null;
  notes: string | null;
  is_active: boolean;
  purchases_count: string;
  purchased_cents: string;
  balance_due_cents: string;
  last_purchase_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface PurchaseRow {
  id: string;
  reference_no: string;
  supplier_id: string;
  supplier_name: string;
  supplier_invoice_no: string | null;
  status: PurchaseStatus;
  payment_status: PurchasePaymentStatus;
  order_date: string;
  expected_date: string | null;
  subtotal_cents: string;
  additional_costs_cents: string;
  tax_cents: string;
  total_cents: string;
  paid_cents: string;
  items_count: string;
  notes: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ItemRow {
  id: string;
  line_no: number;
  product_id: string;
  product_name: string;
  sku: string | null;
  description: string;
  quantity_ordered_milli: string;
  quantity_received_milli: string;
  quantity_returned_milli: string;
  unit_cost_cents: string;
  tax_rate_bp: number;
  line_total_cents: string;
}

const SUPPLIER_SELECT = `
  SELECT s.id, s.name, s.business_name, s.tax_id, s.phone, s.email, s.address, s.contact_person, s.notes,
         s.is_active, s.created_at, s.updated_at,
         COALESCE(p.n, 0)::text AS purchases_count, COALESCE(p.total, 0)::text AS purchased_cents,
         COALESCE(p.due, 0)::text AS balance_due_cents, p.last_at AS last_purchase_at
    FROM suppliers s
    LEFT JOIN (
      SELECT supplier_id, count(*) AS n, SUM(total_cents) AS total, SUM(total_cents - paid_cents) AS due,
             MAX(created_at) AS last_at
        FROM purchases WHERE status <> 'cancelled' GROUP BY supplier_id
    ) p ON p.supplier_id = s.id`;

const PURCHASE_SELECT = `
  SELECT p.id, p.reference_no, p.supplier_id, s.name AS supplier_name, p.supplier_invoice_no, p.status,
         p.payment_status, to_char(p.order_date, 'YYYY-MM-DD') AS order_date,
         to_char(p.expected_date, 'YYYY-MM-DD') AS expected_date,
         p.subtotal_cents::text, p.additional_costs_cents::text, p.tax_cents::text, p.total_cents::text,
         p.paid_cents::text, p.notes, p.created_by, u.full_name AS created_by_name, p.created_at, p.updated_at,
         (SELECT count(*) FROM purchase_items pi WHERE pi.purchase_id = p.id)::text AS items_count
    FROM purchases p
    JOIN suppliers s ON s.id = p.supplier_id
    LEFT JOIN users u ON u.id = p.created_by`;

const toSupplier = (r: SupplierRow): SupplierSummary => ({
  id: r.id,
  name: r.name,
  businessName: r.business_name,
  taxId: r.tax_id,
  phone: r.phone,
  email: r.email,
  address: r.address,
  contactPerson: r.contact_person,
  notes: r.notes,
  isActive: r.is_active,
  purchasesCount: Number(r.purchases_count),
  purchasedCents: Number(r.purchased_cents),
  balanceDueCents: Number(r.balance_due_cents),
  lastPurchaseAt: r.last_purchase_at ? r.last_purchase_at.toISOString() : null,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const toPurchase = (r: PurchaseRow): PurchaseSummary => ({
  id: r.id,
  referenceNo: r.reference_no,
  supplierId: r.supplier_id,
  supplierName: r.supplier_name,
  supplierInvoiceNo: r.supplier_invoice_no,
  status: r.status,
  paymentStatus: r.payment_status,
  orderDate: r.order_date,
  expectedDate: r.expected_date,
  subtotalCents: Number(r.subtotal_cents),
  additionalCostsCents: Number(r.additional_costs_cents),
  taxCents: Number(r.tax_cents),
  totalCents: Number(r.total_cents),
  paidCents: Number(r.paid_cents),
  itemsCount: Number(r.items_count),
  notes: r.notes,
  createdBy: r.created_by,
  createdByName: r.created_by_name,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const toItem = (r: ItemRow): PurchaseItemSummary => ({
  id: Number(r.id),
  lineNo: r.line_no,
  productId: r.product_id,
  productName: r.product_name,
  sku: r.sku,
  description: r.description,
  quantityOrderedMilli: Number(r.quantity_ordered_milli),
  quantityReceivedMilli: Number(r.quantity_received_milli),
  quantityReturnedMilli: Number(r.quantity_returned_milli),
  unitCostCents: Number(r.unit_cost_cents),
  taxRateBp: r.tax_rate_bp,
  lineTotalCents: Number(r.line_total_cents),
});

/** Weighted average cost after receiving `qty` at `unitCost` on top of `stock` at `avg`. */
export function weightedAverageCost(
  stockMilli: number,
  averageCostCents: number,
  receivedMilli: number,
  unitCostCents: number,
): number {
  const onHand = Math.max(0, stockMilli); // negative stock carries no cost
  const total = onHand + receivedMilli;
  if (total <= 0) return unitCostCents;
  // Σ(qty × cost) / Σ qty, in integer arithmetic (milli × cents fits comfortably in 2^53).
  return Math.round((onHand * averageCostCents + receivedMilli * unitCostCents) / total);
}

export function paymentStatusFor(totalCents: number, paidCents: number): PurchasePaymentStatus {
  if (paidCents <= 0) return totalCents === 0 ? 'paid' : 'unpaid';
  return paidCents >= totalCents ? 'paid' : 'partial';
}

export class PurchasingService {
  constructor(
    private readonly pool: DbPool,
    private readonly cash: CashService,
  ) {}

  // ─── Suppliers ────────────────────────────────────────────────────────────

  async listSuppliers(query: SupplierListQuery): Promise<SupplierSummary[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!query.includeInactive) where.push('s.is_active');
    if (query.q) {
      params.push(`%${query.q}%`);
      where.push(
        `(s.name ILIKE $${params.length} OR s.business_name ILIKE $${params.length} OR s.phone ILIKE $${params.length} OR s.email ILIKE $${params.length})`,
      );
    }
    const r = await this.pool.query<SupplierRow>(
      `${SUPPLIER_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY lower(s.name)`,
      params,
    );
    return r.rows.map(toSupplier);
  }

  async getSupplier(id: string, db: Queryable = this.pool): Promise<SupplierSummary | null> {
    const r = await db.query<SupplierRow>(`${SUPPLIER_SELECT} WHERE s.id = $1`, [id]);
    return r.rows[0] ? toSupplier(r.rows[0]) : null;
  }

  async createSupplier(input: SupplierRequest, actor: AuditActor): Promise<SupplierSummary> {
    return withTransaction(this.pool, async (client) => {
      const dup = await client.query('SELECT 1 FROM suppliers WHERE lower(name) = lower($1)', [
        input.name,
      ]);
      if (dup.rowCount)
        throw conflict('A supplier with this name already exists', { field: 'name' });
      const r = await client.query<{ id: string }>(
        `INSERT INTO suppliers (name, business_name, tax_id, phone, email, address, contact_person, notes, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          input.name,
          input.businessName ?? null,
          input.taxId ?? null,
          input.phone ?? null,
          input.email || null,
          input.address ?? null,
          input.contactPerson ?? null,
          input.notes ?? null,
          input.isActive ?? true,
        ],
      );
      const id = r.rows[0]!.id;
      await recordAudit(client, actor, {
        action: 'supplier.create',
        entityType: 'supplier',
        entityId: id,
        details: { name: input.name },
      });
      return (await this.getSupplier(id, client))!;
    });
  }

  async updateSupplier(
    id: string,
    patch: SupplierPatch,
    actor: AuditActor,
  ): Promise<SupplierSummary> {
    return withTransaction(this.pool, async (client) => {
      const existing = await client.query('SELECT id FROM suppliers WHERE id = $1 FOR UPDATE', [
        id,
      ]);
      if (!existing.rowCount) throw notFound('Supplier');
      if (patch.name !== undefined) {
        const dup = await client.query(
          'SELECT 1 FROM suppliers WHERE lower(name) = lower($1) AND id <> $2',
          [patch.name, id],
        );
        if (dup.rowCount)
          throw conflict('A supplier with this name already exists', { field: 'name' });
      }
      const sets: string[] = [];
      const params: unknown[] = [id];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (patch.name !== undefined) set('name', patch.name);
      if (patch.businessName !== undefined) set('business_name', patch.businessName);
      if (patch.taxId !== undefined) set('tax_id', patch.taxId);
      if (patch.phone !== undefined) set('phone', patch.phone);
      if (patch.email !== undefined) set('email', patch.email || null);
      if (patch.address !== undefined) set('address', patch.address);
      if (patch.contactPerson !== undefined) set('contact_person', patch.contactPerson);
      if (patch.notes !== undefined) set('notes', patch.notes);
      if (patch.isActive !== undefined) set('is_active', patch.isActive);
      if (sets.length)
        await client.query(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = $1`, params);
      await recordAudit(client, actor, {
        action: 'supplier.update',
        entityType: 'supplier',
        entityId: id,
        details: { fields: Object.keys(patch) },
      });
      return (await this.getSupplier(id, client))!;
    });
  }

  /** Suppliers are deactivated, never deleted: purchases and expenses keep their link. */
  async deactivateSupplier(id: string, actor: AuditActor): Promise<SupplierSummary> {
    return this.updateSupplier(id, { isActive: false }, actor);
  }

  // ─── Purchases ────────────────────────────────────────────────────────────

  async list(query: PurchaseListQuery): Promise<PurchaseListResponse> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (query.supplierId) add('p.supplier_id = ?', query.supplierId);
    if (query.status) add('p.status = ?', query.status);
    if (query.paymentStatus) add('p.payment_status = ?', query.paymentStatus);
    if (query.from) add('p.order_date >= ?::date', query.from);
    if (query.to) add('p.order_date <= ?::date', query.to);
    if (query.q) {
      params.push(`%${query.q}%`);
      where.push(
        `(p.reference_no ILIKE $${params.length} OR p.supplier_invoice_no ILIKE $${params.length} OR s.name ILIKE $${params.length})`,
      );
    }
    const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = `FROM purchases p JOIN suppliers s ON s.id = p.supplier_id ${sql}`;
    const [summary, rows] = await Promise.all([
      this.pool.query<{ n: string; total: string; paid: string; due: string }>(
        `SELECT count(*)::text AS n,
                COALESCE(SUM(p.total_cents) FILTER (WHERE p.status <> 'cancelled'), 0)::text AS total,
                COALESCE(SUM(p.paid_cents) FILTER (WHERE p.status <> 'cancelled'), 0)::text AS paid,
                COALESCE(SUM(p.total_cents - p.paid_cents) FILTER (WHERE p.status <> 'cancelled'), 0)::text AS due
           ${from}`,
        params,
      ),
      this.pool.query<PurchaseRow>(
        `${PURCHASE_SELECT} ${sql} ORDER BY p.order_date DESC, p.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, query.pageSize, (query.page - 1) * query.pageSize],
      ),
    ]);
    const s = summary.rows[0]!;
    return {
      items: rows.rows.map(toPurchase),
      page: query.page,
      pageSize: query.pageSize,
      total: Number(s.n),
      summary: {
        count: Number(s.n),
        totalCents: Number(s.total),
        paidCents: Number(s.paid),
        dueCents: Number(s.due),
      },
    };
  }

  async get(id: string, db: Queryable = this.pool): Promise<PurchaseDetail | null> {
    const r = await db.query<PurchaseRow>(`${PURCHASE_SELECT} WHERE p.id = $1`, [id]);
    const row = r.rows[0];
    if (!row) return null;
    const [items, receipts, receiptItems, payments] = await Promise.all([
      db.query<ItemRow>(
        `SELECT pi.id::text, pi.line_no, pi.product_id, pr.name AS product_name, pr.sku, pi.description,
                pi.quantity_ordered_milli::text, pi.quantity_received_milli::text, pi.quantity_returned_milli::text,
                pi.unit_cost_cents::text, pi.tax_rate_bp, pi.line_total_cents::text
           FROM purchase_items pi JOIN products pr ON pr.id = pi.product_id
          WHERE pi.purchase_id = $1 ORDER BY pi.line_no`,
        [id],
      ),
      db.query<{
        id: string;
        received_at: Date;
        received_by_name: string | null;
        delivery_note_no: string | null;
        notes: string | null;
      }>(
        `SELECT r.id, r.received_at, u.full_name AS received_by_name, r.delivery_note_no, r.notes
           FROM purchase_receipts r LEFT JOIN users u ON u.id = r.received_by
          WHERE r.purchase_id = $1 ORDER BY r.received_at`,
        [id],
      ),
      db.query<{
        receipt_id: string;
        purchase_item_id: string;
        quantity_milli: string;
        unit_cost_cents: string;
      }>(
        `SELECT ri.receipt_id, ri.purchase_item_id::text, ri.quantity_milli::text, ri.unit_cost_cents::text
           FROM purchase_receipt_items ri JOIN purchase_receipts r ON r.id = ri.receipt_id
          WHERE r.purchase_id = $1 ORDER BY ri.id`,
        [id],
      ),
      db.query<{
        id: string;
        method: PaymentMethod;
        amount_cents: string;
        paid_at: Date;
        reference: string | null;
        shift_id: string | null;
        created_by_name: string | null;
      }>(
        `SELECT pp.id, pp.method, pp.amount_cents::text, pp.paid_at, pp.reference, pp.shift_id, u.full_name AS created_by_name
           FROM purchase_payments pp LEFT JOIN users u ON u.id = pp.created_by
          WHERE pp.purchase_id = $1 ORDER BY pp.paid_at, pp.created_at`,
        [id],
      ),
    ]);
    const receiptList: PurchaseReceiptSummary[] = receipts.rows.map((rc) => ({
      id: rc.id,
      receivedAt: rc.received_at.toISOString(),
      receivedByName: rc.received_by_name,
      deliveryNoteNo: rc.delivery_note_no,
      notes: rc.notes,
      items: receiptItems.rows
        .filter((ri) => ri.receipt_id === rc.id)
        .map((ri) => ({
          purchaseItemId: Number(ri.purchase_item_id),
          quantityMilli: Number(ri.quantity_milli),
          unitCostCents: Number(ri.unit_cost_cents),
        })),
    }));
    const paymentList: PurchasePaymentSummary[] = payments.rows.map((p) => ({
      id: p.id,
      method: p.method,
      amountCents: Number(p.amount_cents),
      paidAt: p.paid_at.toISOString(),
      reference: p.reference,
      shiftId: p.shift_id,
      createdByName: p.created_by_name,
    }));
    return {
      ...toPurchase(row),
      items: items.rows.map(toItem),
      receipts: receiptList,
      payments: paymentList,
    };
  }

  /**
   * Records a purchase. With `receiveNow` the goods enter stock in the same transaction; with a
   * `payment` the money leaves (the drawer, for cash) in the same transaction too.
   */
  async create(input: CreatePurchaseRequest, actor: AuditActor): Promise<PurchaseDetail> {
    return withTransaction(this.pool, async (client) => {
      const supplier = await client.query<{ is_active: boolean; name: string }>(
        'SELECT is_active, name FROM suppliers WHERE id = $1',
        [input.supplierId],
      );
      if (!supplier.rows[0]) throw notFound('Supplier');
      if (!supplier.rows[0].is_active)
        throw conflict('This supplier is inactive', { field: 'supplierId' });

      // Products: validate and build the lines (prices are what the supplier charged — user input).
      const productIds = [...new Set(input.items.map((i) => i.productId))];
      const products = await client.query<{
        id: string;
        name: string;
        is_active: boolean;
        track_stock: boolean;
      }>('SELECT id, name, is_active, track_stock FROM products WHERE id = ANY($1::uuid[])', [
        productIds,
      ]);
      const byId = new Map(products.rows.map((p) => [p.id, p]));
      for (const id of productIds) {
        const p = byId.get(id);
        if (!p) throw notFound(`Product ${id}`);
        if (!p.is_active) throw conflict(`${p.name} is archived`, { productId: id });
      }
      let subtotal = 0;
      let tax = 0;
      const lines = input.items.map((item, i) => {
        const lineTotal = multiplyByQuantity(item.unitCostCents, item.quantityMilli);
        subtotal += lineTotal;
        tax += percentOf(lineTotal, item.taxRateBp);
        return { ...item, lineNo: i + 1, lineTotal, name: byId.get(item.productId)!.name };
      });
      const total = subtotal + tax + input.additionalCostsCents;
      if (input.payment && input.payment.amountCents > total)
        throw badRequest('Payment exceeds the purchase total', { field: 'payment' });

      const now = new Date();
      const referenceNo = await nextDocumentNumber(client, 'purchase', now);
      const r = await client.query<{ id: string }>(
        `INSERT INTO purchases (reference_no, supplier_id, supplier_invoice_no, status, order_date, expected_date,
                                subtotal_cents, additional_costs_cents, tax_cents, total_cents, paid_cents,
                                payment_status, notes, created_by)
         VALUES ($1, $2, $3, 'ordered', COALESCE($4::date, CURRENT_DATE), $5, $6, $7, $8, $9, 0, $10, $11, $12)
         RETURNING id`,
        [
          referenceNo,
          input.supplierId,
          input.supplierInvoiceNo ?? null,
          input.orderDate ?? null,
          input.expectedDate ?? null,
          subtotal,
          input.additionalCostsCents,
          tax,
          total,
          paymentStatusFor(total, 0),
          input.notes ?? null,
          actor.userId ?? null,
        ],
      );
      const purchaseId = r.rows[0]!.id;
      for (const line of lines) {
        await client.query(
          `INSERT INTO purchase_items (purchase_id, line_no, product_id, description, quantity_ordered_milli,
                                       unit_cost_cents, tax_rate_bp, line_total_cents)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            purchaseId,
            line.lineNo,
            line.productId,
            line.name,
            line.quantityMilli,
            line.unitCostCents,
            line.taxRateBp,
            line.lineTotal,
          ],
        );
      }
      await recordAudit(client, actor, {
        action: 'purchase.create',
        entityType: 'purchase',
        entityId: purchaseId,
        details: {
          referenceNo,
          supplier: supplier.rows[0].name,
          totalCents: total,
          lines: lines.length,
        },
      });
      if (input.receiveNow) await this.receiveWithin(client, purchaseId, {}, actor);
      if (input.payment) await this.payWithin(client, purchaseId, input.payment, actor);
      return (await this.get(purchaseId, client))!;
    });
  }

  async receive(
    id: string,
    input: ReceivePurchaseRequest,
    actor: AuditActor,
  ): Promise<PurchaseDetail> {
    return withTransaction(this.pool, async (client) => {
      await this.receiveWithin(client, id, input, actor);
      return (await this.get(id, client))!;
    });
  }

  async pay(id: string, input: PurchasePaymentInput, actor: AuditActor): Promise<PurchaseDetail> {
    return withTransaction(this.pool, async (client) => {
      await this.payWithin(client, id, input, actor);
      return (await this.get(id, client))!;
    });
  }

  /** Only a purchase with nothing received and nothing paid can be cancelled. */
  async cancel(id: string, actor: AuditActor): Promise<PurchaseDetail> {
    return withTransaction(this.pool, async (client) => {
      const r = await client.query<{ status: PurchaseStatus; paid_cents: string }>(
        'SELECT status, paid_cents FROM purchases WHERE id = $1 FOR UPDATE',
        [id],
      );
      const p = r.rows[0];
      if (!p) throw notFound('Purchase');
      if (p.status === 'cancelled') throw conflict('This purchase is already cancelled');
      if (p.status !== 'ordered' && p.status !== 'draft')
        throw conflict('Goods were already received; a received purchase cannot be cancelled');
      if (Number(p.paid_cents) > 0)
        throw conflict('Payments were recorded; a paid purchase cannot be cancelled');
      await client.query(`UPDATE purchases SET status = 'cancelled' WHERE id = $1`, [id]);
      await recordAudit(client, actor, {
        action: 'purchase.cancel',
        entityType: 'purchase',
        entityId: id,
      });
      return (await this.get(id, client))!;
    });
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async receiveWithin(
    client: DbClient,
    purchaseId: string,
    input: ReceivePurchaseRequest,
    actor: AuditActor,
  ): Promise<void> {
    const p = await client.query<{ status: PurchaseStatus; reference_no: string }>(
      'SELECT status, reference_no FROM purchases WHERE id = $1 FOR UPDATE',
      [purchaseId],
    );
    if (!p.rows[0]) throw notFound('Purchase');
    if (p.rows[0].status === 'cancelled') throw conflict('This purchase is cancelled');
    if (p.rows[0].status === 'received') throw conflict('Everything was already received');
    const items = await client.query<{
      id: string;
      product_id: string;
      quantity_ordered_milli: string;
      quantity_received_milli: string;
      unit_cost_cents: string;
      description: string;
    }>(
      `SELECT id::text, product_id, quantity_ordered_milli::text, quantity_received_milli::text, unit_cost_cents::text, description
         FROM purchase_items WHERE purchase_id = $1 ORDER BY line_no FOR UPDATE`,
      [purchaseId],
    );
    const byId = new Map(items.rows.map((i) => [Number(i.id), i]));
    const wanted: { purchaseItemId: number; quantityMilli: number }[] = input.items
      ? input.items
      : items.rows
          .map((i) => ({
            purchaseItemId: Number(i.id),
            quantityMilli: Number(i.quantity_ordered_milli) - Number(i.quantity_received_milli),
          }))
          .filter((i) => i.quantityMilli > 0);
    if (!wanted.length) throw conflict('Nothing left to receive');

    const receipt = await client.query<{ id: string }>(
      `INSERT INTO purchase_receipts (purchase_id, received_by, delivery_note_no, notes)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [purchaseId, actor.userId ?? null, input.deliveryNoteNo ?? null, input.notes ?? null],
    );
    const receiptId = receipt.rows[0]!.id;
    // Lock products in id order (same discipline as sales) to avoid deadlocks with the POS.
    const ordered = [...wanted].sort((a, b) =>
      byId.get(a.purchaseItemId)!.product_id < byId.get(b.purchaseItemId)!.product_id ? -1 : 1,
    );
    for (const w of ordered) {
      const item = byId.get(w.purchaseItemId);
      if (!item) throw badRequest(`Line ${w.purchaseItemId} does not belong to this purchase`);
      const outstanding =
        Number(item.quantity_ordered_milli) - Number(item.quantity_received_milli);
      if (w.quantityMilli > outstanding)
        throw conflict(`Only ${outstanding / 1000} of ${item.description} is still outstanding`, {
          purchaseItemId: w.purchaseItemId,
          outstandingMilli: outstanding,
        });
      const unitCost = Number(item.unit_cost_cents);
      const product = await client.query<{
        stock_milli: string;
        average_cost_cents: string;
        allow_negative_stock: boolean;
      }>(
        'SELECT stock_milli::text, average_cost_cents::text, allow_negative_stock FROM products WHERE id = $1 FOR UPDATE',
        [item.product_id],
      );
      const pr = product.rows[0]!;
      const newAverage = weightedAverageCost(
        Number(pr.stock_milli),
        Number(pr.average_cost_cents),
        w.quantityMilli,
        unitCost,
      );
      const movement = await applyMovement(client, {
        productId: item.product_id,
        type: 'purchase_receipt',
        delta: w.quantityMilli,
        unitCostCents: unitCost,
        reason: p.rows[0].reference_no,
        referenceType: 'purchase',
        referenceId: purchaseId,
        actorUserId: actor.userId ?? null,
        allowNegative: pr.allow_negative_stock,
      });
      await client.query(
        `UPDATE products SET purchase_cost_cents = $2, average_cost_cents = $3 WHERE id = $1`,
        [item.product_id, unitCost, newAverage],
      );
      await client.query(
        `INSERT INTO purchase_receipt_items (receipt_id, purchase_item_id, quantity_milli, unit_cost_cents, inventory_movement_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [receiptId, w.purchaseItemId, w.quantityMilli, unitCost, movement.movementId],
      );
      await client.query(
        `UPDATE purchase_items SET quantity_received_milli = quantity_received_milli + $2 WHERE id = $1`,
        [w.purchaseItemId, w.quantityMilli],
      );
    }
    const done = await client.query<{ all_received: boolean }>(
      `SELECT bool_and(quantity_received_milli >= quantity_ordered_milli) AS all_received
         FROM purchase_items WHERE purchase_id = $1`,
      [purchaseId],
    );
    await client.query(`UPDATE purchases SET status = $2 WHERE id = $1`, [
      purchaseId,
      done.rows[0]!.all_received ? 'received' : 'partially_received',
    ]);
    await recordAudit(client, actor, {
      action: 'purchase.receive',
      entityType: 'purchase',
      entityId: purchaseId,
      details: { receiptId, lines: wanted.length },
    });
  }

  private async payWithin(
    client: DbClient,
    purchaseId: string,
    input: PurchasePaymentInput,
    actor: AuditActor,
  ): Promise<void> {
    const p = await client.query<{
      status: PurchaseStatus;
      total_cents: string;
      paid_cents: string;
      reference_no: string;
    }>(
      'SELECT status, total_cents::text, paid_cents::text, reference_no FROM purchases WHERE id = $1 FOR UPDATE',
      [purchaseId],
    );
    const row = p.rows[0];
    if (!row) throw notFound('Purchase');
    if (row.status === 'cancelled') throw conflict('This purchase is cancelled');
    const due = Number(row.total_cents) - Number(row.paid_cents);
    if (input.amountCents > due)
      throw badRequest(`Only ${(due / 100).toFixed(2)} is still due on this purchase`, {
        field: 'amountCents',
        dueCents: due,
      });
    const paymentId = await client
      .query<{ id: string }>(
        `INSERT INTO purchase_payments (purchase_id, amount_cents, method, reference, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          purchaseId,
          input.amountCents,
          input.method,
          input.reference ?? null,
          actor.userId ?? null,
        ],
      )
      .then((r) => r.rows[0]!.id);
    // Cash leaves the drawer of the open shift (requires one, like any cash tender).
    const shiftId = await this.cash.attachTender(client, {
      method: input.method,
      amountCents: -input.amountCents,
      type: 'supplier_payment',
      referenceType: 'purchase_payment',
      referenceId: paymentId,
      reason: row.reference_no,
      actorUserId: actor.userId ?? null,
    });
    if (shiftId)
      await client.query('UPDATE purchase_payments SET shift_id = $2 WHERE id = $1', [
        paymentId,
        shiftId,
      ]);
    const paid = Number(row.paid_cents) + input.amountCents;
    await client.query(`UPDATE purchases SET paid_cents = $2, payment_status = $3 WHERE id = $1`, [
      purchaseId,
      paid,
      paymentStatusFor(Number(row.total_cents), paid),
    ]);
    await recordAudit(client, actor, {
      action: 'purchase.pay',
      entityType: 'purchase',
      entityId: purchaseId,
      details: { paymentId, amountCents: input.amountCents, method: input.method },
    });
  }
}
