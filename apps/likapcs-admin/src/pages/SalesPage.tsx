/**
 * Sales history: filters + summary, sale detail (items, payments, refunds), receipt reprint,
 * refunds (permission-gated) and resuming parked sales in the POS.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Printer, Receipt as ReceiptIcon, RotateCcw, Undo2 } from 'lucide-react';
import {
  PERMISSIONS,
  SALE_PAYMENT_METHODS,
  SALE_STATUSES,
  type ReceiptData,
  type RefundRequest,
  type SaleDetail,
  type SaleStatus,
  type SalesListResponse,
  type InvoiceData,
} from '@likapcs/shared';
import { api, ApiError } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import { Receipt, printReceipt } from '../components/pos/Receipt';
import { CreateInvoiceDialog, InvoicePreviewDialog } from '../components/invoices/InvoiceDialogs';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  Loading,
  PageHeader,
  Pagination,
  Select,
  StatTile,
  Switch,
} from '../components/ui/primitives';

const PAGE_SIZE = 50;
const qty = (milli: number) =>
  milli % 1000 === 0 ? String(milli / 1000) : (milli / 1000).toFixed(3);
const STATUS_TONE: Record<SaleStatus, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  suspended: 'warning',
  completed: 'success',
  partially_refunded: 'info',
  refunded: 'danger',
  void: 'default',
};

/** Local calendar date → ISO instant at local midnight (start) or end of day. */
function dayBound(date: string, end: boolean): string | undefined {
  if (!date) return undefined;
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  if (end) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function SalesPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'' | SaleStatus>('');
  const [source, setSource] = useState<'' | 'retail' | 'gaming' | 'mixed'>('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState(todayLocal());
  const [to, setTo] = useState(todayLocal());
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const query = useMemo(
    () => ({
      status: status || undefined,
      source: source || undefined,
      q: q.trim() || undefined,
      from: dayBound(from, false),
      to: dayBound(to, true),
      page,
      pageSize: PAGE_SIZE,
    }),
    [status, source, q, from, to, page],
  );
  const sales = useQuery({
    queryKey: ['sales', 'list', query],
    queryFn: () => api<SalesListResponse>('/sales', { query }),
    placeholderData: (prev) => prev,
  });

  return (
    <>
      <PageHeader
        title={t('sales.title')}
        subtitle={
          sales.data
            ? t('sales.subtitle', {
                count: sales.data.summary.count,
                total: fmt.money(sales.data.summary.totalCents),
                refunded: fmt.money(sales.data.summary.refundedCents),
              })
            : undefined
        }
      />
      <div className="toolbar">
        <Input
          placeholder={t('sales.searchReceipt')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          style={{ maxWidth: 220 }}
          aria-label={t('sales.searchReceipt')}
        />
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as '' | SaleStatus);
            setPage(1);
          }}
          aria-label={t('common.status')}
        >
          <option value="">{t('sales.allStatuses')}</option>
          {SALE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`sales.status.${s}` as 'sales.status.completed')}
            </option>
          ))}
        </Select>
        <Select
          value={source}
          onChange={(e) => {
            setSource(e.target.value as '' | 'retail' | 'gaming' | 'mixed');
            setPage(1);
          }}
          aria-label={t('sales.source.retail')}
        >
          <option value="">{t('common.all')}</option>
          {(['retail', 'gaming', 'mixed'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`sales.source.${s}` as 'sales.source.retail')}
            </option>
          ))}
        </Select>
        <label className="row" style={{ gap: 6 }}>
          <span className="muted">{t('sales.from')}</span>
          <Input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="row" style={{ gap: 6 }}>
          <span className="muted">{t('sales.to')}</span>
          <Input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
          />
        </label>
      </div>
      {sales.data && (
        <div className="grid grid--stats" style={{ marginBottom: 16 }}>
          <StatTile label={t('sales.title')} value={String(sales.data.summary.count)} />
          <StatTile label={t('sales.total')} value={fmt.money(sales.data.summary.totalCents)} />
          <StatTile
            label={t('sales.refunded')}
            value={fmt.money(sales.data.summary.refundedCents)}
          />
        </div>
      )}
      {sales.isLoading && <Loading />}
      {sales.isSuccess && sales.data.items.length === 0 && (
        <EmptyState icon={<ReceiptIcon size={22} />} title={t('sales.empty')} />
      )}
      {sales.isSuccess && sales.data.items.length > 0 && (
        <div className="card table-wrap">
          <table className="table table--clickable">
            <thead>
              <tr>
                <th>{t('sales.receipt')}</th>
                <th>{t('sales.time')}</th>
                <th>{t('sales.cashier')}</th>
                <th>{t('common.status')}</th>
                <th className="right">{t('sales.items')}</th>
                <th className="right">{t('sales.total')}</th>
                <th className="right">{t('sales.refunded')}</th>
              </tr>
            </thead>
            <tbody>
              {sales.data.items.map((s) => (
                <tr
                  key={s.id}
                  onClick={() => setOpenId(s.id)}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setOpenId(s.id)}
                >
                  <td className="mono">
                    {s.receiptNo ?? <span className="faint">—</span>}
                    {s.source !== 'retail' && (
                      <span className="faint" style={{ marginLeft: 6, fontSize: 12 }}>
                        {t(`sales.source.${s.source}` as 'sales.source.retail')}
                      </span>
                    )}
                    {s.invoiceNo && (
                      <span
                        className="faint"
                        style={{ marginLeft: 6, fontSize: 12 }}
                        title={t('invoice.title')}
                      >
                        · {s.invoiceNo}
                      </span>
                    )}
                  </td>
                  <td className="num">{fmt.dateTime(s.completedAt ?? s.createdAt)}</td>
                  <td>{s.cashierName ?? '—'}</td>
                  <td>
                    <Badge tone={STATUS_TONE[s.status]}>
                      {t(`sales.status.${s.status}` as 'sales.status.completed')}
                    </Badge>
                  </td>
                  <td className="right num">{s.itemCount}</td>
                  <td className="right num">{fmt.money(s.totalCents)}</td>
                  <td className="right num faint">
                    {s.refundedCents ? fmt.money(s.refundedCents) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} pageSize={PAGE_SIZE} total={sales.data.total} onPage={setPage} />
        </div>
      )}
      {openId && (
        <SaleDetailDialog
          saleId={openId}
          onClose={() => setOpenId(null)}
          canRefund={can(PERMISSIONS.POS_REFUND)}
          canReprint={can(PERMISSIONS.POS_REPRINT)}
          canInvoice={can(PERMISSIONS.INVOICES_MANAGE)}
          canViewInvoice={can(PERMISSIONS.INVOICES_VIEW)}
          onResume={(id) => navigate(`/pos?resume=${id}`)}
        />
      )}
    </>
  );
}

// ─── Detail ────────────────────────────────────────────────────────────────────
function SaleDetailDialog({
  saleId,
  onClose,
  canRefund,
  canReprint,
  canInvoice,
  canViewInvoice,
  onResume,
}: {
  saleId: string;
  onClose: () => void;
  canRefund: boolean;
  canReprint: boolean;
  canInvoice: boolean;
  canViewInvoice: boolean;
  onResume: (id: string) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const [refunding, setRefunding] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [invoicing, setInvoicing] = useState(false);
  const [invoiceDoc, setInvoiceDoc] = useState<InvoiceData | null>(null);
  const sale = useQuery({
    queryKey: ['sales', 'detail', saleId],
    queryFn: () => api<SaleDetail>(`/sales/${saleId}`),
  });
  const openInvoice = useMutation({
    mutationFn: (id: string) => api<InvoiceData>(`/invoices/${id}/document`),
    onSuccess: (data) => setInvoiceDoc(data),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  const reprint = useMutation({
    mutationFn: () => api<ReceiptData>(`/sales/${saleId}/receipt`, { query: { reprint: true } }),
    onSuccess: (data) => setReceipt(data),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  const s = sale.data;
  const refundable = s ? s.items.some((i) => i.refundedMilli < i.quantityMilli) : false;
  const canRefundThis =
    canRefund && !!s && (s.status === 'completed' || s.status === 'partially_refunded');

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('sales.detail', {
        receipt: s?.receiptNo ?? (s ? t('sales.status.suspended') : '…'),
      })}
      size="lg"
      footer={
        s && (
          <>
            {s.status === 'suspended' && (
              <Button variant="primary" onClick={() => onResume(s.id)}>
                <RotateCcw size={14} /> {t('pos.resume')}
              </Button>
            )}
            {canReprint && s.receiptNo && (
              <Button onClick={() => reprint.mutate()} loading={reprint.isPending}>
                <Printer size={14} /> {t('sales.reprint')}
              </Button>
            )}
            {s.invoiceId && canViewInvoice && (
              <Button
                onClick={() => openInvoice.mutate(s.invoiceId!)}
                loading={openInvoice.isPending}
                data-testid="sale-print-invoice"
              >
                <FileText size={14} /> {t('invoice.printExisting', { number: s.invoiceNo ?? '' })}
              </Button>
            )}
            {!s.invoiceId &&
              canInvoice &&
              (s.status === 'completed' || s.status === 'partially_refunded') && (
                <Button onClick={() => setInvoicing(true)} data-testid="sale-issue-invoice">
                  <FileText size={14} /> {t('invoice.issue')}
                </Button>
              )}
            {canRefundThis && (
              <Button
                variant="danger"
                disabled={!refundable}
                title={refundable ? undefined : t('sales.nothingToRefund')}
                onClick={() => setRefunding(true)}
              >
                <Undo2 size={14} /> {t('sales.refund')}
              </Button>
            )}
          </>
        )
      }
    >
      {sale.isLoading && <Loading />}
      {s && (
        <div className="stack">
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <Badge tone={STATUS_TONE[s.status]}>
              {t(`sales.status.${s.status}` as 'sales.status.completed')}
            </Badge>
            <span className="muted">{fmt.dateTime(s.completedAt ?? s.createdAt)}</span>
            <span className="muted">
              {t('sales.cashier')}: {s.cashierName ?? '—'}
            </span>
            {s.customerName && (
              <span className="muted">
                {t('sales.customer')}: {s.customerName}
              </span>
            )}
          </div>
          <table className="table table--compact">
            <thead>
              <tr>
                <th>{t('receipt.item')}</th>
                <th className="right">{t('receipt.qty')}</th>
                <th className="right">{t('receipt.price')}</th>
                <th className="right">{t('receipt.discount')}</th>
                <th className="right">{t('receipt.amount')}</th>
                <th className="right">{t('sales.refunded')}</th>
              </tr>
            </thead>
            <tbody>
              {s.items.map((i) => (
                <tr key={i.id}>
                  <td>
                    {i.description}
                    {i.sku && (
                      <span className="faint mono" style={{ marginLeft: 6, fontSize: 12 }}>
                        {i.sku}
                      </span>
                    )}
                  </td>
                  <td className="right num">{qty(i.quantityMilli)}</td>
                  <td className="right num">{fmt.money(i.unitPriceCents)}</td>
                  <td className="right num faint">
                    {i.discountCents ? `−${fmt.money(i.discountCents)}` : ''}
                  </td>
                  <td className="right num">{fmt.money(i.lineTotalCents)}</td>
                  <td className="right num faint">{i.refundedMilli ? qty(i.refundedMilli) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid grid--2">
            <div className="stack" style={{ gap: 4 }}>
              <div className="row row--between">
                <span className="muted">{t('receipt.subtotal')}</span>
                <span className="num">{fmt.money(s.subtotalCents)}</span>
              </div>
              {s.discountCents > 0 && (
                <div className="row row--between">
                  <span className="muted">{t('receipt.discount')}</span>
                  <span className="num">−{fmt.money(s.discountCents)}</span>
                </div>
              )}
              <div className="row row--between">
                <span className="muted">{t('receipt.vat')}</span>
                <span className="num">{fmt.money(s.taxCents)}</span>
              </div>
              <div className="row row--between" style={{ fontWeight: 600 }}>
                <span>{t('sales.total')}</span>
                <span className="num">{fmt.money(s.totalCents)}</span>
              </div>
              <div className="row row--between">
                <span className="muted">{t('sales.paid')}</span>
                <span className="num">{fmt.money(s.paidCents)}</span>
              </div>
              {s.changeCents > 0 && (
                <div className="row row--between">
                  <span className="muted">{t('sales.change')}</span>
                  <span className="num">{fmt.money(s.changeCents)}</span>
                </div>
              )}
              {s.refundedCents > 0 && (
                <div className="row row--between text-danger">
                  <span>{t('sales.refunded')}</span>
                  <span className="num">−{fmt.money(s.refundedCents)}</span>
                </div>
              )}
            </div>
            <div className="stack" style={{ gap: 4 }}>
              <div className="subhead">{t('sales.payments')}</div>
              {s.payments.length === 0 && <span className="faint">—</span>}
              {s.payments.map((p) => (
                <div key={p.id} className="row row--between">
                  <span className="muted">
                    {p.kind === 'refund' ? `${t('sales.refund')} · ` : ''}
                    {t(`sessions.methods.${p.method}` as 'sessions.methods.cash')}
                    {p.reference && <span className="faint"> · {p.reference}</span>}
                  </span>
                  <span className="num">
                    {p.kind === 'refund' ? '−' : ''}
                    {fmt.money(p.amountCents)}
                  </span>
                </div>
              ))}
              {s.refunds.length > 0 && (
                <div className="subhead" style={{ marginTop: 8 }}>
                  {t('sales.refunds')}
                </div>
              )}
              {s.refunds.map((r) => (
                <div key={r.id} className="row row--between" style={{ alignItems: 'flex-start' }}>
                  <span className="muted">
                    <span className="mono">{r.refundNo}</span> · {r.reason}
                    <span className="faint"> · {fmt.dateTime(r.createdAt)}</span>
                  </span>
                  <span className="num" style={{ whiteSpace: 'nowrap', marginLeft: 8 }}>
                    −{fmt.money(r.totalCents)}
                  </span>
                </div>
              ))}
            </div>
          </div>
          {s.notes && <p className="faint">{s.notes}</p>}
        </div>
      )}
      {refunding && s && <RefundDialog sale={s} onClose={() => setRefunding(false)} />}
      {invoicing && s && (
        <CreateInvoiceDialog
          sale={s}
          onClose={() => setInvoicing(false)}
          onCreated={(inv) => {
            setInvoicing(false);
            openInvoice.mutate(inv.id);
          }}
        />
      )}
      {invoiceDoc && <InvoicePreviewDialog data={invoiceDoc} onClose={() => setInvoiceDoc(null)} />}
      {receipt && (
        <Dialog
          open
          onClose={() => setReceipt(null)}
          title={t('pos.receipt')}
          size="sm"
          footer={
            <>
              <Button onClick={() => setReceipt(null)}>{t('common.close')}</Button>
              <Button variant="primary" onClick={printReceipt} autoFocus>
                <Printer size={14} /> {t('pos.print')}
              </Button>
            </>
          }
        >
          <Receipt data={receipt} />
        </Dialog>
      )}
    </Dialog>
  );
}

// ─── Refund ────────────────────────────────────────────────────────────────────
function RefundDialog({ sale, onClose }: { sale: SaleDetail; onClose: () => void }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(true);
  const [method, setMethod] = useState<(typeof SALE_PAYMENT_METHODS)[number]>('cash');

  const lines = sale.items.filter((i) => i.refundedMilli < i.quantityMilli);
  const items = lines
    .map((i) => {
      const text = quantities[i.id];
      const q = text === undefined || text === '' ? 0 : Number(text.replace(',', '.'));
      const milli = Number.isFinite(q) ? Math.round(q * 1000) : -1;
      return { item: i, milli, max: i.quantityMilli - i.refundedMilli };
    })
    .filter((x) => x.milli !== 0);
  const invalid = items.some((x) => x.milli < 0 || x.milli > x.max);
  // Preview: proportional share of the charged line amount (the server computes the exact value).
  const previewCents = items.reduce(
    (a, x) => a + Math.round((x.item.lineTotalCents * x.milli) / x.item.quantityMilli),
    0,
  );
  const valid = !invalid && items.length > 0 && reason.trim().length >= 2;

  const refund = useMutation({
    mutationFn: () => {
      const body: RefundRequest = {
        items: items.map((x) => ({ saleItemId: x.item.id, quantityMilli: x.milli })),
        reason: reason.trim(),
        restock,
        method,
      };
      return api<SaleDetail>(`/sales/${sale.id}/refund`, { method: 'POST', body });
    },
    onSuccess: (updated) => {
      const last = updated.refunds[updated.refunds.length - 1];
      toast.success(
        t('sales.refundDone', {
          no: last?.refundNo ?? '',
          total: fmt.money(last?.totalCents ?? 0),
        }),
      );
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${t('sales.refundTitle')} ${sale.receiptNo ?? ''}`}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            disabled={!valid}
            loading={refund.isPending}
            onClick={() => refund.mutate()}
          >
            {t('sales.refund')} {items.length > 0 && !invalid ? `· ${fmt.money(previewCents)}` : ''}
          </Button>
        </>
      }
    >
      <div className="stack">
        <table className="table table--compact">
          <thead>
            <tr>
              <th>{t('receipt.item')}</th>
              <th className="right">{t('receipt.qty')}</th>
              <th className="right">{t('sales.refundQty')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((i) => {
              const max = i.quantityMilli - i.refundedMilli;
              return (
                <tr key={i.id}>
                  <td>{i.description}</td>
                  <td className="right num">
                    {qty(max)}
                    {i.refundedMilli > 0 && (
                      <span className="faint"> / {qty(i.quantityMilli)}</span>
                    )}
                  </td>
                  <td className="right">
                    <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                      <Input
                        inputMode="decimal"
                        className="num"
                        style={{ width: 90 }}
                        value={quantities[i.id] ?? ''}
                        placeholder="0"
                        onChange={(e) => setQuantities((qs) => ({ ...qs, [i.id]: e.target.value }))}
                        aria-label={t('sales.refundQty')}
                      />
                      <Button
                        size="sm"
                        onClick={() => setQuantities((qs) => ({ ...qs, [i.id]: qty(max) }))}
                      >
                        {t('common.all')}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="grid grid--2">
          <Field label={t('sales.refundReason')}>
            {(id) => (
              <Input
                id={id}
                value={reason}
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('sales.refundMethod')}>
            {(id) => (
              <Select
                id={id}
                value={method}
                onChange={(e) => setMethod(e.target.value as (typeof SALE_PAYMENT_METHODS)[number])}
              >
                {SALE_PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t(`sessions.methods.${m}` as 'sessions.methods.cash')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Switch checked={restock} onChange={setRestock} label={t('sales.restock')} />
        <div className="row row--between">
          <span className="muted">{t('sales.refundTotal')}</span>
          <strong className="num">{invalid ? '—' : fmt.money(previewCents)}</strong>
        </div>
      </div>
    </Dialog>
  );
}
