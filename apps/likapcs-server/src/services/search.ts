/**
 * Global search (Ctrl+K): one query, every kind of record the user may see — receipts (R-),
 * refunds (K-), invoices (F-), purchases (B-), customers (name / phone / code / PC username),
 * products (name / SKU / barcode) and stations. Read-only, bounded (a handful per kind), and
 * permission-filtered server-side so the palette never shows a cashier what the page would refuse.
 *
 * A document number typed in full (or its bare counter, "123" → R-2026-000123) is returned as
 * `exact` so Enter opens it straight away.
 */
import type { Pool } from 'pg';
import { PERMISSIONS, type SaleStatus, type SearchHit, type SearchResponse } from '@likapcs/shared';

/** How a typed value reads as a document number: "R-2026-000123", "r123", "R2026000123" or "123". */
interface DocumentPattern {
  /** LIKE pattern (already escaped) applied to the number columns. */
  like: string;
  /** Prefix letter when the user typed one (R/F/B/K), else null. */
  prefix: string | null;
  /** `%-000123` when a counter was typed — ranks the exact counter first. */
  tail: string | null;
  /** Fully qualified number when the whole thing was typed, else null. */
  exactNo: string | null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function documentPattern(q: string): DocumentPattern {
  const compact = q.replace(/\s+/g, '').toUpperCase();
  const m = /^([RFBK])-?([\d-]*)$/.exec(compact);
  if (m && m[2]) {
    const prefix = m[1]!;
    const rest = m[2];
    let year: string | null = null;
    let counter: string | null = null;
    if (rest.includes('-')) {
      const [y = '', c = ''] = rest.split('-');
      year = /^\d{4}$/.test(y) ? y : null;
      counter = /^\d{1,6}$/.test(c) ? c : null;
    } else if (/^\d{10}$/.test(rest)) {
      year = rest.slice(0, 4);
      counter = rest.slice(4);
    } else if (/^\d{1,6}$/.test(rest)) {
      counter = rest;
    }
    if (year || counter) {
      const padded = counter ? counter.padStart(6, '0') : null;
      return {
        like: `${prefix}-${year ? `${year}-` : '%'}${counter ? `%${counter}` : '%'}`,
        prefix,
        tail: padded ? `%-${padded}` : null,
        exactNo: year && padded ? `${prefix}-${year}-${padded}` : null,
      };
    }
  }
  if (/^\d{1,6}$/.test(compact)) {
    return {
      like: `%-%${compact}`,
      prefix: null,
      tail: `%-${compact.padStart(6, '0')}`,
      exactNo: null,
    };
  }
  return { like: `%${escapeLike(compact)}%`, prefix: null, tail: null, exactNo: compact };
}

export class SearchService {
  constructor(private readonly pool: Pool) {}

  async search(q: string, limit: number, permissions: Set<string>): Promise<SearchResponse> {
    const like = `%${escapeLike(q)}%`;
    const prefix = `${escapeLike(q)}%`;
    const doc = documentPattern(q);
    const tail = doc.tail ?? '';
    const hits: SearchHit[] = [];
    let exact: SearchHit | null = null;
    /** Typed in full ("R-2026-000123") or prefix + counter ("r123") → that one document. */
    const isExactDoc = (no: string, kindPrefix: string) =>
      (doc.exactNo !== null && no.toUpperCase() === doc.exactNo) ||
      (doc.prefix === kindPrefix && doc.tail !== null && no.endsWith(doc.tail.slice(1)));

    const tasks: Promise<void>[] = [];
    if (permissions.has(PERMISSIONS.POS_SELL)) {
      tasks.push(
        this.pool
          .query<{
            id: string;
            receipt_no: string;
            status: SaleStatus;
            total_cents: string;
            customer_name: string | null;
            completed_at: Date | null;
          }>(
            `SELECT s.id, s.receipt_no, s.status, s.total_cents, c.name AS customer_name, s.completed_at
               FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
              WHERE s.receipt_no IS NOT NULL AND (s.receipt_no ILIKE $1 OR s.receipt_no ILIKE $2)
              ORDER BY (s.receipt_no LIKE $4) DESC, s.created_at DESC
              LIMIT $3`,
            [doc.like, like, limit, tail],
          )
          .then((r) => {
            for (const row of r.rows) {
              const hit: SearchHit = {
                kind: 'sale',
                id: row.id,
                receiptNo: row.receipt_no,
                status: row.status,
                totalCents: Number(row.total_cents),
                customerName: row.customer_name,
                completedAt: row.completed_at?.toISOString() ?? null,
              };
              hits.push(hit);
              if (!exact && isExactDoc(row.receipt_no, 'R')) exact = hit;
            }
          }),
        this.pool
          .query<{
            id: string;
            refund_no: string;
            sale_id: string;
            receipt_no: string | null;
            total_cents: string;
            created_at: Date;
          }>(
            `SELECT r.id, r.refund_no, r.sale_id, s.receipt_no, r.total_cents, r.created_at
               FROM refunds r JOIN sales s ON s.id = r.sale_id
              WHERE r.refund_no ILIKE $1 OR r.refund_no ILIKE $2
              ORDER BY (r.refund_no LIKE $4) DESC, r.created_at DESC
              LIMIT $3`,
            [doc.like, like, limit, tail],
          )
          .then((r) => {
            for (const row of r.rows) {
              const hit: SearchHit = {
                kind: 'refund',
                id: row.id,
                refundNo: row.refund_no,
                saleId: row.sale_id,
                receiptNo: row.receipt_no,
                totalCents: Number(row.total_cents),
                createdAt: row.created_at.toISOString(),
              };
              hits.push(hit);
              if (!exact && isExactDoc(row.refund_no, 'K')) exact = hit;
            }
          }),
      );
    }
    if (permissions.has(PERMISSIONS.INVOICES_VIEW)) {
      tasks.push(
        this.pool
          .query<{
            id: string;
            invoice_no: string;
            status: string;
            billing_name: string | null;
            issued_at: Date;
            sale_id: string | null;
          }>(
            `SELECT id, invoice_no, status, billing_name, issued_at, sale_id
               FROM invoices
              WHERE invoice_no ILIKE $1 OR invoice_no ILIKE $2 OR billing_name ILIKE $2
              ORDER BY (invoice_no LIKE $4) DESC, issued_at DESC
              LIMIT $3`,
            [doc.like, like, limit, tail],
          )
          .then((r) => {
            for (const row of r.rows) {
              const hit: SearchHit = {
                kind: 'invoice',
                id: row.id,
                invoiceNo: row.invoice_no,
                status: row.status,
                billingName: row.billing_name,
                issuedAt: row.issued_at.toISOString(),
                saleId: row.sale_id,
              };
              hits.push(hit);
              if (!exact && isExactDoc(row.invoice_no, 'F')) exact = hit;
            }
          }),
      );
    }
    if (permissions.has(PERMISSIONS.PURCHASES_VIEW)) {
      tasks.push(
        this.pool
          .query<{
            id: string;
            reference_no: string;
            status: string;
            supplier_name: string | null;
            total_cents: string;
            order_date: Date | string | null;
          }>(
            `SELECT p.id, p.reference_no, p.status, sp.name AS supplier_name, p.total_cents, p.order_date
               FROM purchases p LEFT JOIN suppliers sp ON sp.id = p.supplier_id
              WHERE p.reference_no ILIKE $1 OR p.reference_no ILIKE $2 OR p.supplier_invoice_no ILIKE $2
              ORDER BY (p.reference_no LIKE $4) DESC, p.created_at DESC
              LIMIT $3`,
            [doc.like, like, limit, tail],
          )
          .then((r) => {
            for (const row of r.rows) {
              const hit: SearchHit = {
                kind: 'purchase',
                id: row.id,
                referenceNo: row.reference_no,
                status: row.status,
                supplierName: row.supplier_name,
                totalCents: Number(row.total_cents),
                orderDate:
                  row.order_date instanceof Date
                    ? row.order_date.toISOString().slice(0, 10)
                    : (row.order_date ?? null),
              };
              hits.push(hit);
              if (!exact && isExactDoc(row.reference_no, 'B')) exact = hit;
            }
          }),
      );
    }
    if (permissions.has(PERMISSIONS.CUSTOMERS_VIEW)) {
      tasks.push(
        this.pool
          .query<{
            id: string;
            code: string;
            name: string;
            phone: string | null;
            login_username: string | null;
            balance_due_cents: string;
            wallet_balance_cents: string;
          }>(
            `SELECT id, code, name, phone, login_username, balance_due_cents, wallet_balance_cents
               FROM customers
              WHERE status <> 'archived'
                AND (name ILIKE $1 OR phone ILIKE $1 OR code ILIKE $1 OR login_username ILIKE $1
                     OR email ILIKE $1)
              ORDER BY (lower(name) = lower($3) OR code ILIKE $3 OR login_username ILIKE $3 OR phone = $3) DESC,
                       (name ILIKE $2) DESC, name
              LIMIT $4`,
            [like, prefix, q, limit],
          )
          .then((r) => {
            for (const row of r.rows)
              hits.push({
                kind: 'customer',
                id: row.id,
                code: row.code,
                name: row.name,
                phone: row.phone,
                loginUsername: row.login_username,
                balanceDueCents: Number(row.balance_due_cents),
                walletBalanceCents: Number(row.wallet_balance_cents),
              });
          }),
      );
    }
    if (permissions.has(PERMISSIONS.PRODUCTS_VIEW)) {
      tasks.push(
        this.pool
          .query<{
            id: string;
            name: string;
            barcode: string | null;
            selling_price_cents: string;
            stock_milli: string;
            track_stock: boolean;
            is_active: boolean;
          }>(
            `SELECT p.id, p.name,
                    COALESCE(
                      (SELECT b.barcode FROM product_barcodes b WHERE b.product_id = p.id AND b.barcode ILIKE $1 ORDER BY b.barcode LIMIT 1),
                      (SELECT b.barcode FROM product_barcodes b WHERE b.product_id = p.id ORDER BY b.barcode LIMIT 1)
                    ) AS barcode,
                    p.selling_price_cents, p.stock_milli, p.track_stock, p.is_active
               FROM products p
              WHERE p.name ILIKE $1 OR p.sku ILIKE $1
                 OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.barcode ILIKE $1)
              ORDER BY p.is_active DESC,
                       EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.barcode = $3) DESC,
                       (p.name ILIKE $2) DESC, p.name
              LIMIT $4`,
            [like, prefix, q, limit],
          )
          .then((r) => {
            for (const row of r.rows)
              hits.push({
                kind: 'product',
                id: row.id,
                name: row.name,
                barcode: row.barcode,
                sellingPriceCents: Number(row.selling_price_cents),
                stockMilli: Number(row.stock_milli),
                trackStock: row.track_stock,
                isActive: row.is_active,
              });
          }),
      );
    }
    if (permissions.has(PERMISSIONS.STATIONS_VIEW)) {
      tasks.push(
        this.pool
          .query<{ id: string; code: string; name: string; is_enabled: boolean }>(
            `SELECT id, code, name, is_enabled
               FROM stations
              WHERE code ILIKE $1 OR name ILIKE $1 OR number::text = $2
              ORDER BY number
              LIMIT $3`,
            [like, q.trim(), limit],
          )
          .then((r) => {
            for (const row of r.rows)
              hits.push({
                kind: 'station',
                id: row.id,
                code: row.code,
                name: row.name,
                enabled: row.is_enabled,
              });
          }),
      );
    }
    await Promise.all(tasks);
    // Stable group order: the kinds the operator reaches for most often first.
    const order: Record<SearchHit['kind'], number> = {
      sale: 0,
      refund: 1,
      invoice: 2,
      customer: 3,
      product: 4,
      station: 5,
      purchase: 6,
    };
    hits.sort((a, b) => order[a.kind] - order[b.kind]);
    if (exact) {
      const first: SearchHit = exact;
      hits.splice(hits.indexOf(first), 1);
      hits.unshift(first);
    }
    return { q, exact, hits };
  }
}
