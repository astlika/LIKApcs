/**
 * Invoice dialogs: issue an invoice for a completed sale (buyer details, notes, payment term) and
 * preview / print the A4 document. Printing goes through a hidden iframe (see lib/print.ts).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Printer } from 'lucide-react';
import type {
  CreateInvoiceRequest,
  CustomerSummary,
  InvoiceData,
  InvoiceDetail,
  SaleSummary,
} from '@likapcs/shared';
import { api, ApiError, fieldError } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { printHtmlDocument } from '../../lib/print';
import { useI18n } from '../../i18n';
import { useToast } from '../../state/toast';
import { CustomerPicker } from '../customers/CustomerPicker';
import { Alert, Button, Dialog, Field, Input, Textarea } from '../ui/primitives';
import { buildInvoiceHtml, type InvoiceTextKey } from './invoice-document';

/** Renders InvoiceData to the printable HTML with the current language and formats. */
export function useInvoiceHtml(): (data: InvoiceData) => string {
  const { t, language } = useI18n();
  const fmt = useFormat();
  return useCallback(
    (data: InvoiceData) =>
      buildInvoiceHtml(data, {
        lang: language,
        t: (key: InvoiceTextKey) => t(`invoice.doc.${key}` as 'invoice.doc.title'),
        money: fmt.money,
        date: fmt.date,
        dateTime: fmt.dateTime,
        methodLabel: (method) =>
          t(`sessions.methods.${method}` as 'sessions.methods.cash') || method,
      }),
    [t, language, fmt],
  );
}

export function InvoicePreviewDialog({
  data,
  onClose,
}: {
  data: InvoiceData;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const render = useInvoiceHtml();
  const html = useMemo(() => render(data), [render, data]);
  const [printing, setPrinting] = useState(false);
  const print = async () => {
    setPrinting(true);
    try {
      await printHtmlDocument(html);
    } finally {
      setPrinting(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${t('invoice.title')} ${data.invoice.invoiceNo}`}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>{t('common.close')}</Button>
          <Button variant="primary" onClick={() => void print()} loading={printing} autoFocus>
            <Printer size={14} /> {t('invoice.print')}
          </Button>
        </>
      }
    >
      {data.isReprint && <Alert tone="info">{t('invoice.reprintNote')}</Alert>}
      <iframe
        title={data.invoice.invoiceNo}
        srcDoc={html}
        className="invoice-preview"
        data-testid="invoice-preview"
      />
    </Dialog>
  );
}

export function CreateInvoiceDialog({
  sale,
  onClose,
  onCreated,
}: {
  sale: SaleSummary;
  onClose: () => void;
  onCreated: (invoice: InvoiceDetail) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [customer, setCustomer] = useState<CustomerSummary | null>(null);
  const [form, setForm] = useState({
    billingName: sale.customerName ?? '',
    billingTaxId: '',
    billingAddress: '',
    billingEmail: '',
    notes: '',
    dueDays: '' as string,
  });
  const [error, setError] = useState<unknown>(null);

  // Prefill from the sale's customer (if any) once.
  useEffect(() => {
    if (!sale.customerId) return;
    api<CustomerSummary>(`/customers/${sale.customerId}`)
      .then((c) => {
        setCustomer(c);
        setForm((f) => ({
          ...f,
          billingName: f.billingName || c.name,
          billingEmail: f.billingEmail || c.email || '',
        }));
      })
      .catch(() => undefined);
  }, [sale.customerId]);

  const create = useMutation({
    mutationFn: () => {
      const body: CreateInvoiceRequest = {
        saleId: sale.id,
        customerId: customer?.id ?? null,
        billingName: form.billingName.trim(),
        billingTaxId: form.billingTaxId.trim() || null,
        billingAddress: form.billingAddress.trim() || null,
        billingEmail: form.billingEmail.trim() || null,
        notes: form.notes.trim() || null,
        ...(form.dueDays !== '' ? { dueDays: Number(form.dueDays) } : {}),
      };
      return api<InvoiceDetail>('/invoices', { method: 'POST', body });
    },
    onSuccess: (invoice) => {
      toast.success(t('invoice.created', { number: invoice.invoiceNo }));
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      onCreated(invoice);
    },
    onError: (err) => {
      setError(err);
      if (err instanceof ApiError && err.code === 'INVOICE_EXISTS') {
        toast.error(
          t('invoice.exists', {
            number: String((err.details as { invoiceNo?: string })?.invoiceNo ?? ''),
          }),
        );
      } else if (!(err instanceof ApiError && err.status === 400)) {
        toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
      }
    },
  });
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('invoice.issueTitle', { receipt: sale.receiptNo ?? '' })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={!form.billingName.trim()}
          >
            <FileText size={14} /> {t('invoice.issue')}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (form.billingName.trim()) create.mutate();
        }}
      >
        <Field label={t('invoice.customer')} hint={t('invoice.customerHint')}>
          {(id) => (
            <CustomerPicker
              id={id}
              value={customer}
              onChange={(c) => {
                setCustomer(c);
                if (c) {
                  setForm((f) => ({
                    ...f,
                    billingName: c.name,
                    billingEmail: c.email ?? f.billingEmail,
                  }));
                }
              }}
              placeholder={t('pos.customerPlaceholder')}
            />
          )}
        </Field>
        <div className="form-grid">
          <Field
            label={t('invoice.billingName')}
            error={fieldError(error, 'billingName')}
            className="span-2"
          >
            {(id, invalid) => (
              <Input
                id={id}
                value={form.billingName}
                onChange={(e) => set('billingName', e.target.value)}
                aria-invalid={invalid}
                autoFocus
                required
              />
            )}
          </Field>
          <Field label={t('invoice.billingTaxId')} error={fieldError(error, 'billingTaxId')}>
            {(id, invalid) => (
              <Input
                id={id}
                value={form.billingTaxId}
                onChange={(e) => set('billingTaxId', e.target.value)}
                aria-invalid={invalid}
              />
            )}
          </Field>
          <Field label={t('invoice.billingEmail')} error={fieldError(error, 'billingEmail')}>
            {(id, invalid) => (
              <Input
                id={id}
                type="email"
                value={form.billingEmail}
                onChange={(e) => set('billingEmail', e.target.value)}
                aria-invalid={invalid}
              />
            )}
          </Field>
          <Field
            label={t('invoice.billingAddress')}
            error={fieldError(error, 'billingAddress')}
            className="span-2"
          >
            {(id, invalid) => (
              <Textarea
                id={id}
                rows={2}
                value={form.billingAddress}
                onChange={(e) => set('billingAddress', e.target.value)}
                aria-invalid={invalid}
              />
            )}
          </Field>
          <Field
            label={t('invoice.dueDays')}
            hint={t('invoice.dueDaysHint')}
            error={fieldError(error, 'dueDays')}
          >
            {(id, invalid) => (
              <Input
                id={id}
                type="number"
                min={0}
                max={365}
                value={form.dueDays}
                onChange={(e) => set('dueDays', e.target.value)}
                aria-invalid={invalid}
                placeholder={t('invoice.dueDaysDefault')}
              />
            )}
          </Field>
          <Field label={t('invoice.notes')} error={fieldError(error, 'notes')} className="span-2">
            {(id, invalid) => (
              <Textarea
                id={id}
                rows={2}
                value={form.notes}
                onChange={(e) => set('notes', e.target.value)}
                aria-invalid={invalid}
              />
            )}
          </Field>
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
