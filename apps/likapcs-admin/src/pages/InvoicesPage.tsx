/**
 * Invoices: every A4 invoice issued from a sale — search, date range, print (logged), void with a
 * reason. New invoices are issued from the sale (Sales › sale › Issue invoice).
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Ban, FileText, Printer } from 'lucide-react';
import {
  PERMISSIONS,
  type InvoiceData,
  type InvoiceDetail,
  type InvoiceStatus,
  type InvoiceSummary,
  type InvoicesListResponse,
} from '@likapcs/shared';
import { InvoicePreviewDialog } from '../components/invoices/InvoiceDialogs';
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
  Textarea,
} from '../components/ui/primitives';
import { useI18n } from '../i18n';
import { api, ApiError, fieldError } from '../lib/api';
import { useFormat } from '../lib/format';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';

const PAGE_SIZE = 50;

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
function monthStart(): string {
  return `${todayLocal().slice(0, 8)}01`;
}

export function InvoicesPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const canManage = can(PERMISSIONS.INVOICES_MANAGE);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | InvoiceStatus>('');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayLocal());
  const [page, setPage] = useState(1);
  const [doc, setDoc] = useState<InvoiceData | null>(null);
  const [voiding, setVoiding] = useState<InvoiceSummary | null>(null);

  const query = useMemo(
    () => ({
      q: q.trim() || undefined,
      status: status || undefined,
      from: dayBound(from, false),
      to: dayBound(to, true),
      page,
      pageSize: PAGE_SIZE,
    }),
    [q, status, from, to, page],
  );
  const list = useQuery({
    queryKey: ['invoices', 'list', query],
    queryFn: () => api<InvoicesListResponse>('/invoices', { query }),
    placeholderData: (prev) => prev,
  });
  const onError = (err: unknown) =>
    toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
  const open = useMutation({
    mutationFn: (id: string) => api<InvoiceData>(`/invoices/${id}/document`),
    onSuccess: (data) => {
      setDoc(data);
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
    onError,
  });

  const data = list.data;
  return (
    <>
      <PageHeader title={t('invoice.pageTitle')} subtitle={t('invoice.pageSubtitle')} />
      <div className="toolbar">
        <Input
          placeholder={t('invoice.search')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          style={{ maxWidth: 240 }}
          aria-label={t('invoice.search')}
        />
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as '' | InvoiceStatus);
            setPage(1);
          }}
          aria-label={t('common.status')}
        >
          <option value="">{t('invoice.allStatuses')}</option>
          <option value="issued">{t('invoice.status.issued')}</option>
          <option value="void">{t('invoice.status.void')}</option>
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
      {data && (
        <div className="grid grid--stats" style={{ marginBottom: 16 }}>
          <StatTile label={t('invoice.pageTitle')} value={String(data.summary.count)} />
          <StatTile
            label={t('invoice.doc.total')}
            value={fmt.money(data.summary.totalCents)}
            sub={t('invoice.totalHint')}
          />
        </div>
      )}
      {list.isLoading && <Loading />}
      {data && data.items.length === 0 && (
        <EmptyState
          icon={<FileText size={22} />}
          title={t('invoice.empty')}
          hint={t('invoice.emptyHint')}
          action={<Link to="/sales">{t('nav.sales')}</Link>}
        />
      )}
      {data && data.items.length > 0 && (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('invoice.number')}</th>
                <th>{t('common.date')}</th>
                <th>{t('invoice.buyer')}</th>
                <th>{t('sales.receipt')}</th>
                <th>{t('common.status')}</th>
                <th className="right">{t('invoice.doc.total')}</th>
                <th className="right">{t('invoice.printed')}</th>
                <th className="right">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((inv) => (
                <tr
                  key={inv.id}
                  className={inv.status === 'void' ? 'row--muted' : undefined}
                  data-testid="invoice-row"
                >
                  <td className="mono">
                    <strong>{inv.invoiceNo}</strong>
                  </td>
                  <td className="num">
                    {fmt.date(inv.issuedAt)}
                    {inv.dueAt && inv.dueAt !== inv.issuedAt.slice(0, 10) && (
                      <div className="faint" style={{ fontSize: 12 }}>
                        {t('invoice.doc.dueAt')}: {fmt.date(inv.dueAt)}
                      </div>
                    )}
                  </td>
                  <td>
                    {inv.billingName}
                    {inv.billingTaxId && (
                      <div className="faint" style={{ fontSize: 12 }}>
                        {t('invoice.doc.taxId')}: {inv.billingTaxId}
                      </div>
                    )}
                  </td>
                  <td className="mono">{inv.receiptNo ?? '—'}</td>
                  <td>
                    <Badge tone={inv.status === 'void' ? 'danger' : 'success'}>
                      {t(`invoice.status.${inv.status}`)}
                    </Badge>
                    {inv.voidReason && (
                      <div className="faint" style={{ fontSize: 12 }} title={inv.voidReason}>
                        {inv.voidReason.slice(0, 60)}
                      </div>
                    )}
                  </td>
                  <td className="right num">{fmt.money(inv.totalCents)}</td>
                  <td className="right num muted">
                    {inv.printCount > 0 ? `${inv.printCount}×` : '—'}
                  </td>
                  <td className="right">
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={open.isPending && open.variables === inv.id}
                        onClick={() => open.mutate(inv.id)}
                      >
                        <Printer size={13} /> {t('invoice.print')}
                      </Button>
                      {canManage && inv.status === 'issued' && (
                        <Button size="sm" variant="ghost" onClick={() => setVoiding(inv)}>
                          <Ban size={13} /> {t('invoice.void')}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} />
        </div>
      )}
      {doc && <InvoicePreviewDialog data={doc} onClose={() => setDoc(null)} />}
      {voiding && <VoidInvoiceDialog invoice={voiding} onClose={() => setVoiding(null)} />}
    </>
  );
}

function VoidInvoiceDialog({ invoice, onClose }: { invoice: InvoiceSummary; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const mutation = useMutation({
    mutationFn: () =>
      api<InvoiceDetail>(`/invoices/${invoice.id}/void`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      toast.success(t('invoice.voided', { number: invoice.invoiceNo }));
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      onClose();
    },
    onError: (err) => {
      setError(err);
      if (!(err instanceof ApiError && err.status === 400)) {
        toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
      }
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('invoice.voidTitle', { number: invoice.invoiceNo })}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            disabled={reason.trim().length < 3}
          >
            <Ban size={14} /> {t('invoice.void')}
          </Button>
        </>
      }
    >
      <p className="muted">{t('invoice.voidHint')}</p>
      <Field label={t('invoice.voidReason')} error={fieldError(error, 'reason')}>
        {(id, invalid) => (
          <Textarea
            id={id}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={invalid}
            autoFocus
          />
        )}
      </Field>
    </Dialog>
  );
}
