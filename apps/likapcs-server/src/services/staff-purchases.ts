/**
 * Staff purchase (0.28.0): staff take stock items at their purchase cost. This is not a sale:
 * no receipt, no money through the drawer, not revenue. The stock goes out (`staff_out`), the
 * purchase is stored with its items, and an expense of category `staff_purchase` is booked
 * automatically (payment method `other`, no drawer). Only actors with `pos.staff_purchase` may
 * record one. Staff purchases are never voided here; the expense cannot be voided either.
 */
import type { StaffPurchaseRequest, StaffPurchaseSummary } from '@likapcs/shared';
import { millsToCents } from '@likapcs/shared';
import type { DbPool } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { forbidden, notFound } from '../errors.js';
import { recordAudit, type AuditActor } from './audit.js';
import { applyMovement } from './catalog.js';

export interface StaffPurchaseActor extends AuditActor {
  userId: string;
  permissions: ReadonlySet<string>;
}

interface ProductRow {
  id: string;
  name: string;
  track_stock: boolean;
  allow_negative_stock: boolean;
  purchase_cost_cents: string;
  purchase_cost_mills: string | number;
  average_cost_mills: string | number | null;
}

export class StaffPurchasesService {
  constructor(private readonly pool: DbPool) {}

  async create(
    input: StaffPurchaseRequest,
    actor: StaffPurchaseActor,
    timeZone: string,
  ): Promise<StaffPurchaseSummary> {
    if (!actor.permissions.has('pos.staff_purchase')) {
      throw forbidden('Missing permission: pos.staff_purchase');
    }
    // One line per product: the same product may be listed twice.
    const perProduct = new Map<string, number>();
    for (const item of input.items) {
      perProduct.set(item.productId, (perProduct.get(item.productId) ?? 0) + item.quantityMilli);
    }
    const result = await withTransaction(this.pool, async (client) => {
      const ids = [...perProduct.keys()].sort();
      const found = await client.query<ProductRow>(
        `SELECT id, name, track_stock, allow_negative_stock, purchase_cost_cents,
                purchase_cost_mills, average_cost_mills
           FROM products WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [ids],
      );
      const products = new Map(found.rows.map((p) => [p.id, p]));
      for (const id of ids) if (!products.has(id)) throw notFound('Product');

      let totalCostCents = 0;
      const lines: { product: ProductRow; quantityMilli: number; lineCostCents: number }[] = [];
      for (const id of ids) {
        const product = products.get(id)!;
        const quantityMilli = perProduct.get(id)!;
        const unitCost = Number(product.purchase_cost_cents);
        const lineCostCents = Math.round((unitCost * quantityMilli) / 1000);
        totalCostCents += lineCostCents;
        lines.push({ product, quantityMilli, lineCostCents });
      }

      const sp = await client.query<{ id: string }>(
        `INSERT INTO staff_purchases (total_cost_cents, created_by) VALUES ($1, $2) RETURNING id`,
        [totalCostCents, actor.userId],
      );
      const purchaseId = sp.rows[0]!.id;

      for (const line of lines) {
        const p = line.product;
        await client.query(
          `INSERT INTO staff_purchase_items (staff_purchase_id, product_id, description, quantity_milli,
                                             unit_cost_cents, line_cost_cents)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            purchaseId,
            p.id,
            p.name,
            line.quantityMilli,
            Number(p.purchase_cost_cents),
            line.lineCostCents,
          ],
        );
        if (!p.track_stock) continue;
        const mills = Number(p.average_cost_mills) || Number(p.purchase_cost_mills);
        await applyMovement(client, {
          productId: p.id,
          type: 'staff_out',
          delta: -line.quantityMilli,
          unitCostCents: millsToCents(mills),
          unitCostMills: mills,
          reason: null,
          referenceType: 'staff_purchase',
          referenceId: purchaseId,
          actorUserId: actor.userId,
          allowNegative: p.allow_negative_stock,
        });
      }

      // The expense is booked only when there is a cost (an expense must be above zero).
      let expenseId = '';
      if (totalCostCents > 0) {
        const description = `Staff purchase: ${lines.map((l) => l.product.name).join(', ')}`.slice(
          0,
          300,
        );
        const ex = await client.query<{ id: string }>(
          `INSERT INTO expenses (expense_date, category_code, amount_cents, payment_method, description,
                                 created_by, staff_purchase_id)
           VALUES ((now() AT TIME ZONE $1)::date, 'staff_purchase', $2, 'other', $3, $4, $5)
           RETURNING id`,
          [timeZone, totalCostCents, description, actor.userId, purchaseId],
        );
        expenseId = ex.rows[0]!.id;
      }
      return { id: purchaseId, totalCostCents, expenseId };
    });
    await recordAudit(this.pool, actor, {
      action: 'staff_purchase.create',
      entityType: 'staff_purchase',
      entityId: result.id,
      details: { totalCostCents: result.totalCostCents, items: input.items.length },
    });
    return result;
  }
}
