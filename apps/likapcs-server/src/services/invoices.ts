/**
 * Invoices: numbered A4 documents (`F-<year>-NNNNNN`, gap-free) issued for a completed sale.
 *
 *  - The lines are the sale's lines (sales are immutable once completed; refunds are separate
 *    documents), so an invoice stores only the header: buyer snapshot, dates, notes, status.
 *  - One live invoice per sale (partial unique index). Voiding keeps the number and records who
 *    and why; a replacement invoice may then be issued.
 *  - Every rendering for print is logged in `print_jobs` (reprints are audited).
 */
import type {
  CreateInvoiceRequest,
  InvoiceData,
  InvoiceDetail,
  InvoiceListQuery,
  InvoiceSummary,
  InvoicesListResponse,
} from '@likapcs/shared';
import { withTransaction, type DbClient, type DbPool } from '../db/pool.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { recordAudit, type AuditActor } from './audit.js';
import { nextDocumentNumber } from './documents.js';
import type { SalesService } from './sales.js';
import type { SettingsService } from './settings.js';

interface InvoiceRow {
  id: string;
  invoice_no: string;
  status: InvoiceSummary['status'];
  sale_id: string;
  receipt_no: string | null;
  customer_id: string | null;
  billing_name: string | null;
  billing_tax_id: string | null;
  billing_address: string | null;
  billing_email: string | null;
  notes: string | null;
  issued_at: Date;
  due_at: string | null;
  issued_by_name: string | null;
  total_cents: string;
  tax_cents: string;
  print_count: number;
  last_printed_at: Date | null;
  voided_at: Date | null;
  voided_by_name: string | null;
  void_reason: string | null;
}

const INVOICE_SELECT = `
  SELECT i.id, i.invoice_no, i.status, i.sale_id, s.receipt_no, i.customer_id, i.billing_name,
         i.billing_tax_id, i.billing_address, i.billing_email, i.notes, i.issued_at,
         to_char(i.due_at, 'YYYY-MM-DD') AS due_at, u.full_name AS issued_by_name,
         s.total_cents::text, s.tax_cents::text, i.print_count, i.last_printed_at,
         i.voided_at, v.full_name AS voided_by_name, i.void_reason
    FROM invoices i
    JOIN sales s ON s.id = i.sale_id
    LEFT JOIN users u ON u.id = i.issued_by
    LEFT JOIN users v ON v.id = i.voided_by
   WHERE i.kind = 'invoice'`;

function mapInvoice(r: InvoiceRow): InvoiceSummary {
  return {
    id: r.id,
    invoiceNo: r.invoice_no,
    status: r.status,
    saleId: r.sale_id,
    receiptNo: r.receipt_no,
    customerId: r.customer_id,
    billingName: r.billing_name ?? '',
    billingTaxId: r.billing_tax_id,
    billingAddress: r.billing_address,
    billingEmail: r.billing_email,
    notes: r.notes,
    issuedAt: r.issued_at.toISOString(),
    dueAt: r.due_at,
    issuedByName: r.issued_by_name,
    totalCents: Number(r.total_cents),
    taxCents: Number(r.tax_cents),
    printCount: r.print_count,
    lastPrintedAt: r.last_printed_at?.toISOString() ?? null,
    voidedAt: r.voided_at?.toISOString() ?? null,
    voidedByName: r.voided_by_name,
    voidReason: r.void_reason,
  };
}

export class InvoiceService {
  constructor(
    private readonly pool: DbPool,
    private readonly sales: SalesService,
    private readonly settings: SettingsService,
  ) {}

  async list(query: InvoiceListQuery): Promise<InvoicesListResponse> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (query.status) add('i.status = ?', query.status);
    if (query.customerId) add('i.customer_id = ?', query.customerId);
    if (query.from) add('i.issued_at >= ?', query.from);
    if (query.to) add('i.issued_at < ?', query.to);
    if (query.q) {
      params.push(`%${query.q}%`);
      const n = params.length;
      where.push(
        `(i.invoice_no ILIKE $${n} OR i.billing_name ILIKE $${n} OR i.billing_tax_id ILIKE $${n} OR s.receipt_no ILIKE $${n})`,
      );
    }
    const clause = where.length ? `AND ${where.join(' AND ')}` : '';
    const offset = (query.page - 1) * query.pageSize;
    const [rows, totals] = await Promise.all([
      this.pool.query<InvoiceRow>(
        `${INVOICE_SELECT} ${clause} ORDER BY i.issued_at DESC LIMIT ${query.pageSize} OFFSET ${offset}`,
        params,
      ),
      this.pool.query<{ count: string; total_cents: string }>(
        `SELECT count(*)::text AS count,
                COALESCE(SUM(CASE WHEN i.status = 'issued' THEN s.total_cents ELSE 0 END), 0)::text AS total_cents
           FROM invoices i JOIN sales s ON s.id = i.sale_id WHERE i.kind = 'invoice' ${clause}`,
        params,
      ),
    ]);
    const count = Number(totals.rows[0]!.count);
    return {
      items: rows.rows.map(mapInvoice),
      total: count,
      page: query.page,
      pageSize: query.pageSize,
      summary: { count, totalCents: Number(totals.rows[0]!.total_cents) },
    };
  }

  async getById(id: string, db: DbPool | DbClient = this.pool): Promise<InvoiceDetail> {
    const r = await db.query<InvoiceRow>(`${INVOICE_SELECT} AND i.id = $1`, [id]);
    if (!r.rows[0]) throw notFound('Invoice');
    const sale = await this.sales.getById(r.rows[0].sale_id, db);
    return { ...mapInvoice(r.rows[0]), sale };
  }

  /** Issues an invoice for a completed sale. */
  async create(input: CreateInvoiceRequest, actor: AuditActor): Promise<InvoiceDetail> {
    const dueDays = input.dueDays ?? (await this.settings.get('printing.invoice_due_days'));
    return withTransaction(this.pool, async (client) => {
      const sale = await client.query<{ status: string; customer_id: string | null }>(
        'SELECT status, customer_id FROM sales WHERE id = $1 FOR UPDATE',
        [input.saleId],
      );
      if (!sale.rows[0]) throw notFound('Sale');
      if (!['completed', 'partially_refunded'].includes(sale.rows[0].status)) {
        throw conflict('Only completed sales can be invoiced', { status: sale.rows[0].status });
      }
      const existing = await client.query<{ id: string; invoice_no: string }>(
        `SELECT id, invoice_no FROM invoices WHERE sale_id = $1 AND kind = 'invoice' AND status = 'issued'`,
        [input.saleId],
      );
      if (existing.rows[0]) {
        throw new AppError(409, 'INVOICE_EXISTS', 'This sale already has an invoice', {
          invoiceId: existing.rows[0].id,
          invoiceNo: existing.rows[0].invoice_no,
        });
      }
      const customerId = input.customerId ?? sale.rows[0].customer_id;
      if (customerId) {
        const c = await client.query('SELECT 1 FROM customers WHERE id = $1', [customerId]);
        if (!c.rows[0]) throw badRequest('Customer not found');
      }
      const issuedAt = new Date();
      const dueAt = new Date(issuedAt.getTime() + dueDays * 86_400_000);
      const invoiceNo = await nextDocumentNumber(client, 'invoice', issuedAt);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO invoices (invoice_no, kind, sale_id, customer_id, issued_at, issued_by, billing_name,
                               billing_tax_id, billing_address, billing_email, notes, due_at)
         VALUES ($1, 'invoice', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date)
         RETURNING id`,
        [
          invoiceNo,
          input.saleId,
          customerId,
          issuedAt,
          actor.userId ?? null,
          input.billingName,
          input.billingTaxId || null,
          input.billingAddress || null,
          input.billingEmail || null,
          input.notes || null,
          dueAt.toISOString().slice(0, 10),
        ],
      );
      await recordAudit(client, actor, {
        action: 'invoice.created',
        entityType: 'invoice',
        entityId: inserted.rows[0]!.id,
        details: { invoiceNo, saleId: input.saleId, billingName: input.billingName },
      });
      return this.getById(inserted.rows[0]!.id, client);
    });
  }

  /** Voids a live invoice (the number is kept; the sale may be invoiced again). */
  async void(id: string, reason: string, actor: AuditActor): Promise<InvoiceDetail> {
    return withTransaction(this.pool, async (client) => {
      const r = await client.query<{ status: string; invoice_no: string }>(
        `SELECT status, invoice_no FROM invoices WHERE id = $1 AND kind = 'invoice' FOR UPDATE`,
        [id],
      );
      if (!r.rows[0]) throw notFound('Invoice');
      if (r.rows[0].status === 'void') throw conflict('This invoice is already void');
      await client.query(
        `UPDATE invoices SET status = 'void', voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1`,
        [id, actor.userId ?? null, reason],
      );
      await recordAudit(client, actor, {
        action: 'invoice.voided',
        entityType: 'invoice',
        entityId: id,
        details: { invoiceNo: r.rows[0].invoice_no, reason },
      });
      return this.getById(id, client);
    });
  }

  /** Data for the A4 document; every call counts as a print (reprints are audited). */
  async document(id: string, actor: AuditActor): Promise<InvoiceData> {
    const invoice = await this.getById(id);
    const isReprint = invoice.printCount > 0;
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE invoices SET print_count = print_count + 1, last_printed_at = now() WHERE id = $1`,
        [id],
      );
      await client.query(
        `INSERT INTO print_jobs (document_type, document_id, is_reprint, printed_by, status)
         VALUES ('invoice', $1, $2, $3, 'printed')`,
        [id, isReprint, actor.userId ?? null],
      );
      if (isReprint) {
        await recordAudit(client, actor, {
          action: 'invoice.reprinted',
          entityType: 'invoice',
          entityId: id,
          details: { invoiceNo: invoice.invoiceNo, printCount: invoice.printCount + 1 },
        });
      }
    });
    const s = await this.settings.getAll();
    const { sale, ...header } = invoice;
    return {
      business: {
        name: s['business.name'],
        legalName: s['business.legal_name'],
        address: s['business.address'],
        city: s['business.city'],
        phone: s['business.phone'],
        email: s['business.email'],
        website: s['business.website'],
        taxId: s['business.tax_id'],
        registrationNo: s['business.registration_no'],
        bankDetails: s['printing.invoice_bank_details'],
        footer: s['printing.invoice_footer'],
      },
      invoice: { ...header, printCount: header.printCount + 1 },
      sale,
      currency: s['locale.currency'],
      printedAt: new Date().toISOString(),
      isReprint,
    };
  }
}
