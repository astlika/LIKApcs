/**
 * Catalogue & inventory: tax categories, product categories, products with barcodes, and stock.
 *
 * Stock is never written directly — every change is an `inventory_movements` row inserted in the
 * same transaction that updates `products.stock_milli` (row locked FOR UPDATE), so the ledger and
 * the cached quantity cannot drift apart.
 */
import type {
  CategoryInput,
  CategorySummary,
  InventoryMovementSummary,
  ProductInput,
  ProductListQuery,
  ProductLookupResponse,
  ProductSummary,
  StockAdjustmentInput,
  TaxCategoryInput,
  TaxCategorySummary,
  UpdateProductInput,
} from '@likapcs/shared';
import type { DbClient, DbPool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { recordAudit, type AuditActor } from './audit.js';
import { ProductImageStore } from './product-images.js';
import type { SettingsService } from './settings.js';

interface ProductRow {
  id: string;
  name: string;
  sku: string;
  category_id: string | null;
  category_name: string | null;
  category_color: string | null;
  brand: string | null;
  supplier_id: string | null;
  tax_category_id: string | null;
  tax_rate_bp: number | null;
  unit_code: string;
  unit_is_decimal: boolean;
  purchase_cost_cents: string | number;
  average_cost_cents: string | number;
  selling_price_cents: string | number;
  price_includes_tax: boolean;
  stock_milli: string | number;
  min_stock_milli: string | number;
  allow_negative_stock: boolean;
  track_stock: boolean;
  description: string | null;
  storage_location: string | null;
  image_path: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  barcodes:
    { id: string; barcode: string; is_primary: boolean; quantity_milli: string | number }[] | null;
}

const PRODUCT_SELECT = `
  SELECT p.id, p.name, p.sku, p.category_id, c.name AS category_name, c.color AS category_color, p.brand,
         p.supplier_id, p.tax_category_id, tc.rate_bp AS tax_rate_bp, p.unit_code,
         COALESCE(u.is_decimal, false) AS unit_is_decimal,
         p.purchase_cost_cents, p.average_cost_cents, p.selling_price_cents, p.price_includes_tax,
         p.stock_milli, p.min_stock_milli, p.allow_negative_stock, p.track_stock, p.description,
         p.storage_location, p.image_path, p.is_active, p.created_at, p.updated_at,
         (SELECT json_agg(json_build_object('id', b.id, 'barcode', b.barcode, 'is_primary', b.is_primary,
                                            'quantity_milli', b.quantity_milli) ORDER BY b.is_primary DESC, b.barcode)
            FROM product_barcodes b WHERE b.product_id = p.id) AS barcodes
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN tax_categories tc ON tc.id = p.tax_category_id
    LEFT JOIN units_of_measure u ON u.code = p.unit_code`;

export class CatalogService {
  constructor(
    private readonly pool: DbPool,
    private readonly settings: SettingsService,
    readonly images: ProductImageStore,
  ) {}

  // ─── Tax categories ─────────────────────────────────────────────────────────

  async listTaxCategories(): Promise<TaxCategorySummary[]> {
    const r = await this.pool.query<{
      id: string;
      name: string;
      rate_bp: number;
      is_default: boolean;
      is_active: boolean;
    }>(
      'SELECT id, name, rate_bp, is_default, is_active FROM tax_categories ORDER BY is_default DESC, rate_bp, name',
    );
    return r.rows.map((t) => ({
      id: t.id,
      name: t.name,
      rateBp: t.rate_bp,
      isDefault: t.is_default,
      isActive: t.is_active,
    }));
  }

  async createTaxCategory(input: TaxCategoryInput, actor: AuditActor): Promise<TaxCategorySummary> {
    return withTransaction(this.pool, async (client) => {
      if (input.isDefault)
        await client.query('UPDATE tax_categories SET is_default = false WHERE is_default');
      const r = await client.query<{ id: string }>(
        `INSERT INTO tax_categories (name, rate_bp, is_default, is_active) VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.name, input.rateBp, input.isDefault, input.isActive],
      );
      await recordAudit(client, actor, {
        action: 'catalog.tax_category.created',
        entityType: 'tax_category',
        entityId: r.rows[0]!.id,
        details: { name: input.name, rateBp: input.rateBp },
      });
      return { id: r.rows[0]!.id, ...input };
    });
  }

  // ─── Categories ─────────────────────────────────────────────────────────────

  async listCategories(): Promise<CategorySummary[]> {
    const r = await this.pool.query<{
      id: string;
      name: string;
      parent_id: string | null;
      color: string | null;
      sort_order: number;
      is_active: boolean;
      product_count: string;
    }>(
      `SELECT c.*, (SELECT count(*) FROM products p WHERE p.category_id = c.id AND p.is_active)::text AS product_count
         FROM categories c ORDER BY c.sort_order, lower(c.name)`,
    );
    return r.rows.map((c) => ({
      id: c.id,
      name: c.name,
      parentId: c.parent_id,
      color: c.color,
      sortOrder: c.sort_order,
      isActive: c.is_active,
      productCount: Number(c.product_count),
    }));
  }

  async createCategory(input: CategoryInput, actor: AuditActor): Promise<CategorySummary> {
    return withTransaction(this.pool, async (client) => {
      const r = await client
        .query<{ id: string }>(
          `INSERT INTO categories (name, parent_id, color, sort_order, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [input.name, input.parentId, input.color, input.sortOrder, input.isActive],
        )
        .catch((err: { code?: string }) => {
          if (err.code === '23505')
            throw conflict('A category with this name already exists', { field: 'name' });
          throw err;
        });
      await recordAudit(client, actor, {
        action: 'catalog.category.created',
        entityType: 'category',
        entityId: r.rows[0]!.id,
        details: { name: input.name },
      });
      return { id: r.rows[0]!.id, ...input, productCount: 0 };
    });
  }

  async updateCategory(
    id: string,
    patch: Partial<CategoryInput>,
    actor: AuditActor,
  ): Promise<CategorySummary> {
    if (patch.parentId === id) throw badRequest('A category cannot be its own parent');
    return withTransaction(this.pool, async (client) => {
      const sets: string[] = [];
      const values: unknown[] = [];
      const map: Record<string, string> = {
        name: 'name',
        parentId: 'parent_id',
        color: 'color',
        sortOrder: 'sort_order',
        isActive: 'is_active',
      };
      for (const [key, column] of Object.entries(map)) {
        if (key in patch) {
          values.push((patch as Record<string, unknown>)[key]);
          sets.push(`${column} = $${values.length}`);
        }
      }
      if (sets.length === 0) throw badRequest('Nothing to update');
      values.push(id);
      const r = await client
        .query(`UPDATE categories SET ${sets.join(', ')} WHERE id = $${values.length}`, values)
        .catch((err: { code?: string }) => {
          if (err.code === '23505')
            throw conflict('A category with this name already exists', { field: 'name' });
          throw err;
        });
      if (!r.rowCount) throw notFound('Category');
      await recordAudit(client, actor, {
        action: 'catalog.category.updated',
        entityType: 'category',
        entityId: id,
        details: patch as Record<string, unknown>,
      });
      const list = await this.listCategories();
      return list.find((c) => c.id === id)!;
    });
  }

  async deleteCategory(id: string, actor: AuditActor): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const r = await client.query('DELETE FROM categories WHERE id = $1', [id]);
      if (!r.rowCount) throw notFound('Category');
      await recordAudit(client, actor, {
        action: 'catalog.category.deleted',
        entityType: 'category',
        entityId: id,
      });
    });
  }

  // ─── Products ───────────────────────────────────────────────────────────────

  private async defaultTaxRate(db: Queryable = this.pool): Promise<number> {
    const r = await db.query<{ rate_bp: number }>(
      'SELECT rate_bp FROM tax_categories WHERE is_default LIMIT 1',
    );
    return r.rows[0]?.rate_bp ?? (await this.settings.get('tax.default_rate_bp'));
  }

  private mapProduct(row: ProductRow, defaultRateBp: number): ProductSummary {
    const stock = Number(row.stock_milli);
    const min = Number(row.min_stock_milli);
    return {
      id: row.id,
      name: row.name,
      sku: row.sku,
      categoryId: row.category_id,
      categoryName: row.category_name,
      categoryColor: row.category_color,
      brand: row.brand,
      supplierId: row.supplier_id,
      taxCategoryId: row.tax_category_id,
      taxRateBp: row.tax_rate_bp ?? defaultRateBp,
      unitCode: row.unit_code,
      unitIsDecimal: row.unit_is_decimal,
      purchaseCostCents: Number(row.purchase_cost_cents),
      averageCostCents: Number(row.average_cost_cents),
      sellingPriceCents: Number(row.selling_price_cents),
      priceIncludesTax: row.price_includes_tax,
      stockMilli: stock,
      minStockMilli: min,
      allowNegativeStock: row.allow_negative_stock,
      trackStock: row.track_stock,
      lowStock: row.track_stock && stock <= min,
      description: row.description,
      storageLocation: row.storage_location,
      isActive: row.is_active,
      imageUrl: ProductImageStore.urlFor(row.image_path),
      barcodes: (row.barcodes ?? []).map((b) => ({
        id: b.id,
        barcode: b.barcode,
        isPrimary: b.is_primary,
        quantityMilli: Number(b.quantity_milli),
      })),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async getProduct(id: string, db: Queryable = this.pool): Promise<ProductSummary> {
    const r = await db.query<ProductRow>(`${PRODUCT_SELECT} WHERE p.id = $1`, [id]);
    if (!r.rows[0]) throw notFound('Product');
    return this.mapProduct(r.rows[0], await this.defaultTaxRate(db));
  }

  async listProducts(
    query: ProductListQuery,
  ): Promise<{ items: ProductSummary[]; total: number; page: number; pageSize: number }> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (query.active === 'active') where.push('p.is_active');
    if (query.active === 'inactive') where.push('NOT p.is_active');
    if (query.categoryId) {
      values.push(query.categoryId);
      where.push(`p.category_id = $${values.length}`);
    }
    if (query.lowStock) where.push('p.track_stock AND p.stock_milli <= p.min_stock_milli');
    if (query.q) {
      values.push(`%${query.q.toLowerCase()}%`, query.q);
      where.push(
        `(lower(p.name) LIKE $${values.length - 1} OR lower(p.sku) LIKE $${values.length - 1} OR lower(COALESCE(p.brand, '')) LIKE $${values.length - 1}
          OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.barcode = $${values.length}))`,
      );
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM products p ${clause}`,
      values,
    );
    values.push(query.pageSize, (query.page - 1) * query.pageSize);
    const rows = await this.pool.query<ProductRow>(
      `${PRODUCT_SELECT} ${clause} ORDER BY lower(p.name) LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    const rate = await this.defaultTaxRate();
    return {
      items: rows.rows.map((r) => this.mapProduct(r, rate)),
      total: Number(count.rows[0]!.n),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** POS scan: exact barcode first (with its pack quantity), then exact SKU. */
  async lookup(code: string): Promise<ProductLookupResponse> {
    const trimmed = code.trim();
    if (!trimmed) throw badRequest('Code is required');
    const byBarcode = await this.pool.query<{
      product_id: string;
      quantity_milli: string | number;
    }>('SELECT product_id, quantity_milli FROM product_barcodes WHERE barcode = $1', [trimmed]);
    if (byBarcode.rows[0]) {
      return {
        product: await this.getProduct(byBarcode.rows[0].product_id),
        quantityMilli: Number(byBarcode.rows[0].quantity_milli),
        matchedBy: 'barcode',
      };
    }
    const bySku = await this.pool.query<{ id: string }>(
      'SELECT id FROM products WHERE lower(sku) = lower($1)',
      [trimmed],
    );
    if (bySku.rows[0]) {
      return {
        product: await this.getProduct(bySku.rows[0].id),
        quantityMilli: 1000,
        matchedBy: 'sku',
      };
    }
    throw notFound('No product with this barcode or SKU');
  }

  async createProduct(input: ProductInput, actor: AuditActor): Promise<ProductSummary> {
    return withTransaction(this.pool, async (client) => {
      const sku = input.sku?.trim() || (await nextSku(client));
      const r = await client
        .query<{ id: string }>(
          `INSERT INTO products (name, sku, category_id, brand, supplier_id, tax_category_id, unit_code, purchase_cost_cents,
                                 average_cost_cents, selling_price_cents, price_includes_tax, min_stock_milli,
                                 allow_negative_stock, track_stock, description, storage_location, is_active, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
          [
            input.name,
            sku,
            input.categoryId,
            input.brand,
            input.supplierId,
            input.taxCategoryId,
            input.unitCode,
            input.purchaseCostCents,
            input.sellingPriceCents,
            input.priceIncludesTax,
            input.minStockMilli,
            input.allowNegativeStock,
            input.trackStock,
            input.description,
            input.storageLocation,
            input.isActive,
            actor.userId ?? null,
          ],
        )
        .catch((err: { code?: string; constraint?: string }) => {
          if (err.code === '23505') throw conflict('SKU already exists', { field: 'sku' });
          if (err.code === '23503' && err.constraint?.includes('unit_code'))
            throw badRequest('Unknown unit', { field: 'unitCode' });
          throw err;
        });
      const id = r.rows[0]!.id;
      for (const [i, b] of input.barcodes.entries()) {
        await this.insertBarcode(client, id, {
          ...b,
          isPrimary: b.isPrimary || (i === 0 && !input.barcodes.some((x) => x.isPrimary)),
        });
      }
      if (input.initialStockMilli && input.initialStockMilli > 0) {
        await applyMovement(client, {
          productId: id,
          type: 'initial',
          delta: input.initialStockMilli,
          unitCostCents: input.purchaseCostCents,
          reason: 'Opening stock',
          referenceType: 'product',
          referenceId: id,
          actorUserId: actor.userId ?? null,
          allowNegative: false,
        });
      }
      await recordAudit(client, actor, {
        action: 'catalog.product.created',
        entityType: 'product',
        entityId: id,
        details: { name: input.name, sku, sellingPriceCents: input.sellingPriceCents },
      });
      return this.getProduct(id, client);
    });
  }

  async updateProduct(
    id: string,
    patch: UpdateProductInput,
    actor: AuditActor,
  ): Promise<ProductSummary> {
    const map: Record<string, string> = {
      name: 'name',
      sku: 'sku',
      categoryId: 'category_id',
      brand: 'brand',
      supplierId: 'supplier_id',
      taxCategoryId: 'tax_category_id',
      unitCode: 'unit_code',
      purchaseCostCents: 'purchase_cost_cents',
      sellingPriceCents: 'selling_price_cents',
      priceIncludesTax: 'price_includes_tax',
      minStockMilli: 'min_stock_milli',
      allowNegativeStock: 'allow_negative_stock',
      trackStock: 'track_stock',
      description: 'description',
      storageLocation: 'storage_location',
      isActive: 'is_active',
    };
    return withTransaction(this.pool, async (client) => {
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [key, column] of Object.entries(map)) {
        if (key in patch) {
          const value = (patch as Record<string, unknown>)[key];
          if (key === 'sku' && typeof value === 'string' && !value.trim()) continue;
          values.push(value);
          sets.push(`${column} = $${values.length}`);
        }
      }
      if (sets.length === 0) throw badRequest('Nothing to update');
      values.push(id);
      const r = await client
        .query(`UPDATE products SET ${sets.join(', ')} WHERE id = $${values.length}`, values)
        .catch((err: { code?: string }) => {
          if (err.code === '23505') throw conflict('SKU already exists', { field: 'sku' });
          throw err;
        });
      if (!r.rowCount) throw notFound('Product');
      await recordAudit(client, actor, {
        action: 'catalog.product.updated',
        entityType: 'product',
        entityId: id,
        details: patch as Record<string, unknown>,
      });
      return this.getProduct(id, client);
    });
  }

  // ─── Product pictures ───────────────────────────────────────────────────────

  /** Replaces the product picture with an already stored file; the previous file is removed. */
  async setProductImage(id: string, fileName: string, actor: AuditActor): Promise<ProductSummary> {
    const previous = await withTransaction(this.pool, async (client) => {
      const r = await client.query<{ image_path: string | null }>(
        'UPDATE products SET image_path = $2 WHERE id = $1 RETURNING (SELECT image_path FROM products WHERE id = $1) AS image_path',
        [id, fileName],
      );
      if (!r.rowCount) throw notFound('Product');
      await recordAudit(client, actor, {
        action: 'catalog.product.image_set',
        entityType: 'product',
        entityId: id,
        details: { file: fileName },
      });
      return r.rows[0]!.image_path;
    }).catch(async (err: unknown) => {
      await this.images.remove(fileName); // the file was stored before the row update failed
      throw err;
    });
    if (previous && previous !== fileName) await this.images.remove(previous);
    return this.getProduct(id);
  }

  async clearProductImage(id: string, actor: AuditActor): Promise<ProductSummary> {
    const previous = await withTransaction(this.pool, async (client) => {
      const r = await client.query<{ image_path: string | null }>(
        'UPDATE products SET image_path = NULL WHERE id = $1 RETURNING (SELECT image_path FROM products WHERE id = $1) AS image_path',
        [id],
      );
      if (!r.rowCount) throw notFound('Product');
      await recordAudit(client, actor, {
        action: 'catalog.product.image_cleared',
        entityType: 'product',
        entityId: id,
      });
      return r.rows[0]!.image_path;
    });
    await this.images.remove(previous);
    return this.getProduct(id);
  }

  /**
   * Products that were ever sold are archived instead of deleted (sale lines reference them).
   * A hard delete also removes the picture file — after the row is gone, so a failed transaction
   * never leaves a product without its picture.
   */
  async deleteProduct(id: string, actor: AuditActor): Promise<{ archived: boolean }> {
    const result = await this.deleteProductRow(id, actor);
    if (result.imagePath) await this.images.remove(result.imagePath);
    return { archived: result.archived };
  }

  private async deleteProductRow(
    id: string,
    actor: AuditActor,
  ): Promise<{ archived: boolean; imagePath: string | null }> {
    return withTransaction(this.pool, async (client) => {
      const used = await client.query(
        `SELECT 1 FROM sale_items WHERE product_id = $1
          UNION ALL SELECT 1 FROM inventory_movements WHERE product_id = $1 LIMIT 1`,
        [id],
      );
      if (used.rowCount) {
        const r = await client.query('UPDATE products SET is_active = false WHERE id = $1', [id]);
        if (!r.rowCount) throw notFound('Product');
        await recordAudit(client, actor, {
          action: 'catalog.product.archived',
          entityType: 'product',
          entityId: id,
        });
        return { archived: true, imagePath: null };
      }
      const r = await client.query<{ image_path: string | null }>(
        'DELETE FROM products WHERE id = $1 RETURNING image_path',
        [id],
      );
      if (!r.rowCount) throw notFound('Product');
      await recordAudit(client, actor, {
        action: 'catalog.product.deleted',
        entityType: 'product',
        entityId: id,
      });
      return { archived: false, imagePath: r.rows[0]!.image_path };
    });
  }

  private async insertBarcode(
    client: DbClient,
    productId: string,
    input: { barcode: string; quantityMilli: number; isPrimary: boolean },
  ): Promise<void> {
    if (input.isPrimary) {
      await client.query(
        'UPDATE product_barcodes SET is_primary = false WHERE product_id = $1 AND is_primary',
        [productId],
      );
    }
    await client
      .query(
        'INSERT INTO product_barcodes (product_id, barcode, is_primary, quantity_milli) VALUES ($1, $2, $3, $4)',
        [productId, input.barcode, input.isPrimary, input.quantityMilli],
      )
      .catch((err: { code?: string }) => {
        if (err.code === '23505')
          throw conflict(`Barcode ${input.barcode} is already assigned to a product`, {
            field: 'barcode',
          });
        if (err.code === '23514')
          throw badRequest(
            'Barcode may contain letters, digits, ".", "_" and "-" (3–64 characters)',
            { field: 'barcode' },
          );
        throw err;
      });
  }

  async addBarcode(
    productId: string,
    input: { barcode: string; quantityMilli: number; isPrimary: boolean },
    actor: AuditActor,
  ): Promise<ProductSummary> {
    return withTransaction(this.pool, async (client) => {
      const exists = await client.query('SELECT 1 FROM products WHERE id = $1', [productId]);
      if (!exists.rowCount) throw notFound('Product');
      await this.insertBarcode(client, productId, input);
      await recordAudit(client, actor, {
        action: 'catalog.barcode.added',
        entityType: 'product',
        entityId: productId,
        details: { barcode: input.barcode, quantityMilli: input.quantityMilli },
      });
      return this.getProduct(productId, client);
    });
  }

  async removeBarcode(
    productId: string,
    barcodeId: string,
    actor: AuditActor,
  ): Promise<ProductSummary> {
    return withTransaction(this.pool, async (client) => {
      const r = await client.query(
        'DELETE FROM product_barcodes WHERE id = $1 AND product_id = $2 RETURNING barcode',
        [barcodeId, productId],
      );
      if (!r.rowCount) throw notFound('Barcode');
      await recordAudit(client, actor, {
        action: 'catalog.barcode.removed',
        entityType: 'product',
        entityId: productId,
        details: { barcode: (r.rows[0] as { barcode: string }).barcode },
      });
      return this.getProduct(productId, client);
    });
  }

  // ─── Stock ──────────────────────────────────────────────────────────────────

  async adjustStock(
    productId: string,
    input: StockAdjustmentInput,
    actor: AuditActor,
  ): Promise<ProductSummary> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query<{
        stock_milli: string | number;
        allow_negative_stock: boolean;
      }>('SELECT stock_milli, allow_negative_stock FROM products WHERE id = $1 FOR UPDATE', [
        productId,
      ]);
      if (!current.rows[0]) throw notFound('Product');
      const stock = Number(current.rows[0].stock_milli);
      const delta =
        input.newStockMilli !== undefined ? input.newStockMilli - stock : input.quantityMilliDelta!;
      if (delta === 0) throw badRequest('The adjustment does not change the stock');
      await applyMovement(client, {
        productId,
        type: input.type,
        delta,
        unitCostCents: input.unitCostCents ?? null,
        reason: input.reason,
        referenceType: 'adjustment',
        referenceId: null,
        actorUserId: actor.userId ?? null,
        allowNegative: current.rows[0].allow_negative_stock,
      });
      await recordAudit(client, actor, {
        action: 'inventory.adjusted',
        entityType: 'product',
        entityId: productId,
        details: { type: input.type, delta, reason: input.reason },
        severity: delta < 0 ? 'warning' : 'info',
      });
      return this.getProduct(productId, client);
    });
  }

  async listMovements(query: {
    productId?: string;
    type?: string;
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  }): Promise<{
    items: InventoryMovementSummary[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (query.productId) {
      values.push(query.productId);
      where.push(`m.product_id = $${values.length}`);
    }
    if (query.type) {
      values.push(query.type);
      where.push(`m.movement_type = $${values.length}`);
    }
    if (query.from) {
      values.push(query.from);
      where.push(`m.created_at >= $${values.length}`);
    }
    if (query.to) {
      values.push(query.to);
      where.push(`m.created_at <= $${values.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM inventory_movements m ${clause}`,
      values,
    );
    values.push(query.pageSize, (query.page - 1) * query.pageSize);
    const rows = await this.pool.query<{
      id: string;
      product_id: string;
      product_name: string;
      sku: string;
      movement_type: string;
      quantity_milli_delta: string;
      stock_after_milli: string;
      unit_cost_cents: string | null;
      reason: string | null;
      reference_type: string | null;
      reference_id: string | null;
      created_by_name: string | null;
      created_at: Date;
    }>(
      `SELECT m.id::text, m.product_id, p.name AS product_name, p.sku, m.movement_type, m.quantity_milli_delta::text,
              m.stock_after_milli::text, m.unit_cost_cents::text, m.reason, m.reference_type, m.reference_id,
              u.full_name AS created_by_name, m.created_at
         FROM inventory_movements m
         JOIN products p ON p.id = m.product_id
         LEFT JOIN users u ON u.id = m.created_by
         ${clause}
        ORDER BY m.created_at DESC, m.id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return {
      items: rows.rows.map((m) => ({
        id: Number(m.id),
        productId: m.product_id,
        productName: m.product_name,
        sku: m.sku,
        movementType: m.movement_type,
        quantityMilliDelta: Number(m.quantity_milli_delta),
        stockAfterMilli: Number(m.stock_after_milli),
        unitCostCents: m.unit_cost_cents === null ? null : Number(m.unit_cost_cents),
        reason: m.reason,
        referenceType: m.reference_type,
        referenceId: m.reference_id,
        createdByName: m.created_by_name,
        createdAt: m.created_at.toISOString(),
      })),
      total: Number(count.rows[0]!.n),
      page: query.page,
      pageSize: query.pageSize,
    };
  }
}

/** Generated SKUs: `SKU-000001`, continuous (no yearly reset). */
async function nextSku(client: DbClient): Promise<string> {
  const r = await client.query<{ next_value: string }>(
    `INSERT INTO document_sequences (kind, period, prefix, next_value) VALUES ('sku', '', 'SKU', 2)
     ON CONFLICT (kind, period) DO UPDATE SET next_value = document_sequences.next_value + 1
     RETURNING next_value`,
  );
  return `SKU-${String(Number(r.rows[0]!.next_value) - 1).padStart(6, '0')}`;
}

export interface MovementInput {
  productId: string;
  type: string;
  delta: number;
  unitCostCents: number | null;
  reason: string | null;
  referenceType: string | null;
  referenceId: string | null;
  actorUserId: string | null;
  /** Whether the product may go below zero (its `allow_negative_stock` flag). */
  allowNegative: boolean;
}

/**
 * Applies one stock movement to a product whose row is already locked by the caller
 * (`SELECT … FOR UPDATE`). Throws 409 when the stock would go negative and that is not allowed.
 */
export async function applyMovement(
  client: DbClient,
  input: MovementInput,
): Promise<{ movementId: number; stockAfterMilli: number }> {
  const r = await client.query<{ stock_milli: string | number; name: string }>(
    'SELECT stock_milli, name FROM products WHERE id = $1 FOR UPDATE',
    [input.productId],
  );
  if (!r.rows[0]) throw notFound('Product');
  const after = Number(r.rows[0].stock_milli) + input.delta;
  if (after < 0 && !input.allowNegative) {
    throw conflict(`Insufficient stock for ${r.rows[0].name}`, {
      code: 'INSUFFICIENT_STOCK',
      productId: input.productId,
      availableMilli: Number(r.rows[0].stock_milli),
      requestedMilli: -input.delta,
    });
  }
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO inventory_movements (product_id, movement_type, quantity_milli_delta, stock_after_milli, unit_cost_cents,
                                      reason, reference_type, reference_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id::text`,
    [
      input.productId,
      input.type,
      input.delta,
      after,
      input.unitCostCents,
      input.reason,
      input.referenceType,
      input.referenceId,
      input.actorUserId,
    ],
  );
  await client.query('UPDATE products SET stock_milli = $2 WHERE id = $1', [
    input.productId,
    after,
  ]);
  return { movementId: Number(inserted.rows[0]!.id), stockAfterMilli: after };
}
