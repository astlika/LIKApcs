/**
 * Purchases: supplier orders and deliveries. The list is filterable with a period summary; a new
 * purchase is built from the product picker (scanner friendly) and can be received and/or paid in
 * the same step. The detail dialog receives outstanding lines (fully or partially), records
 * supplier payments (cash leaves the open drawer) and cancels untouched orders.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, PackageCheck, Plus, ShoppingBag, Trash2, Wallet } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import {
  PAYMENT_METHODS,
  PERMISSIONS,
  PURCHASE_PAYMENT_STATUSES,
  PURCHASE_STATUSES,
  formatQuantity,
  multiplyByQuantity,
  parseMoneyInput,
  parseQuantityInput,
  percentOf,
  type PaymentMethod,
  type ProductSummary,
  type PurchaseDetail,
  type PurchaseListResponse,
  type PurchasePaymentStatus,
  type PurchaseStatus,
  type SupplierSummary,
} from '@likapcs/shared';
import { api, ApiError, fieldError } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import { useShiftGuard } from '../state/shift-guard';
import { ProductPicker } from '../components/catalog/ProductPicker';
import {
  Badge,
  Button,
  ConfirmDialog,
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
  Textarea,
} from '../components/ui/primitives';

const PAGE_SIZE = 50;
const STATUS_TONE: Record<PurchaseStatus, 'default' | 'info' | 'warning' | 'success' | 'danger'> = {
  draft: 'default',
  ordered: 'info',
  partially_received: 'warning',
  received: 'success',
  cancelled: 'danger',
};
const PAY_TONE: Record<PurchasePaymentStatus, 'warning' | 'info' | 'success'> = {
  unpaid: 'warning',
  partial: 'info',
  paid: 'success',
};

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const centsToInput = (cents: number) => (cents / 100).toFixed(2);

export function PurchasesPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.PURCHASES_MANAGE);
  const [params, setParams] = useSearchParams();
  const supplierId = params.get('supplierId') ?? '';
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | PurchaseStatus>('');
  const [payStatus, setPayStatus] = useState<'' | PurchasePaymentStatus>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const suppliers = useQuery({
    queryKey: ['suppliers', { q: '', includeInactive: true }],
    queryFn: () => api<SupplierSummary[]>('/suppliers', { query: { includeInactive: true } }),
    staleTime: 60_000,
  });
  const query = useMemo(
    () => ({
      q: q.trim() || undefined,
      supplierId: supplierId || undefined,
      status: status || undefined,
      paymentStatus: payStatus || undefined,
      from: from || undefined,
      to: to || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    [q, supplierId, status, payStatus, from, to, page],
  );
  const list = useQuery({
    queryKey: ['purchases', 'list', query],
    queryFn: () => api<PurchaseListResponse>('/purchases', { query }),
    placeholderData: (prev) => prev,
  });

  return (
    <>
      <PageHeader
        title={t('purchases.title')}
        subtitle={t('purchases.subtitle')}
        actions={
          canManage && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> {t('purchases.new')}
            </Button>
          )
        }
      />
      <div className="toolbar">
        <Input
          placeholder={t('purchases.search')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          style={{ maxWidth: 220 }}
          aria-label={t('purchases.search')}
        />
        <Select
          value={supplierId}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            if (e.target.value) next.set('supplierId', e.target.value);
            else next.delete('supplierId');
            setParams(next, { replace: true });
            setPage(1);
          }}
          aria-label={t('purchases.supplier')}
        >
          <option value="">{t('purchases.allSuppliers')}</option>
          {suppliers.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as '' | PurchaseStatus);
            setPage(1);
          }}
          aria-label={t('common.status')}
        >
          <option value="">{t('purchases.allStatuses')}</option>
          {PURCHASE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`purchases.status.${s}`)}
            </option>
          ))}
        </Select>
        <Select
          value={payStatus}
          onChange={(e) => {
            setPayStatus(e.target.value as '' | PurchasePaymentStatus);
            setPage(1);
          }}
          aria-label={t('purchases.paymentStatus')}
        >
          <option value="">{t('purchases.allPaymentStatuses')}</option>
          {PURCHASE_PAYMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`purchases.pay.${s}`)}
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
      {list.data && (
        <div className="grid grid--stats" style={{ marginBottom: 16 }}>
          <StatTile label={t('purchases.count')} value={String(list.data.summary.count)} />
          <StatTile label={t('purchases.total')} value={fmt.money(list.data.summary.totalCents)} />
          <StatTile label={t('purchases.paid')} value={fmt.money(list.data.summary.paidCents)} />
          <StatTile
            label={t('purchases.due')}
            value={fmt.money(list.data.summary.dueCents)}
            tone={list.data.summary.dueCents > 0 ? 'warning' : undefined}
          />
        </div>
      )}
      {list.isLoading && <Loading />}
      {list.isSuccess && list.data.items.length === 0 && (
        <EmptyState icon={<ShoppingBag size={22} />} title={t('purchases.empty')} />
      )}
      {list.isSuccess && list.data.items.length > 0 && (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('purchases.reference')}</th>
                <th>{t('common.date')}</th>
                <th>{t('purchases.supplier')}</th>
                <th>{t('purchases.supplierInvoice')}</th>
                <th className="right">{t('sales.items')}</th>
                <th>{t('common.status')}</th>
                <th>{t('purchases.paymentStatus')}</th>
                <th className="right">{t('sales.total')}</th>
                <th className="right">{t('purchases.due')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((p) => (
                <tr
                  key={p.id}
                  className={`clickable ${p.status === 'cancelled' ? 'row--muted' : ''}`}
                  onClick={() => setOpenId(p.id)}
                  data-testid="purchase-row"
                >
                  <td className="mono">{p.referenceNo}</td>
                  <td className="num">{fmt.date(p.orderDate)}</td>
                  <td>{p.supplierName}</td>
                  <td className="mono faint">{p.supplierInvoiceNo ?? '—'}</td>
                  <td className="right num">{p.itemsCount}</td>
                  <td>
                    <Badge tone={STATUS_TONE[p.status]}>{t(`purchases.status.${p.status}`)}</Badge>
                  </td>
                  <td>
                    {p.status !== 'cancelled' && (
                      <Badge tone={PAY_TONE[p.paymentStatus]}>
                        {t(`purchases.pay.${p.paymentStatus}`)}
                      </Badge>
                    )}
                  </td>
                  <td className="right num">{fmt.money(p.totalCents)}</td>
                  <td className="right num">
                    {p.status === 'cancelled' ? '—' : fmt.money(p.totalCents - p.paidCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />
        </div>
      )}
      {creating && (
        <NewPurchaseDialog
          suppliers={(suppliers.data ?? []).filter((s) => s.isActive)}
          defaultSupplierId={supplierId}
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            setOpenId(p.id);
          }}
        />
      )}
      {openId && <PurchaseDialog id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

/* ----------------------------------------------------------------------------------------------
 * New purchase
 * -------------------------------------------------------------------------------------------- */

interface Line {
  product: ProductSummary;
  qty: string;
  cost: string;
  taxPct: string;
}

function lineValues(l: Line) {
  const qtyMilli = parseQuantityInput(l.qty);
  const cost = parseMoneyInput(l.cost);
  const taxPct = Number(l.taxPct.replace(',', '.'));
  const taxBp =
    l.taxPct.trim() === '' ? 0 : Number.isFinite(taxPct) ? Math.round(taxPct * 100) : NaN;
  const ok =
    qtyMilli !== null && qtyMilli > 0 && cost !== null && Number.isFinite(taxBp) && taxBp >= 0;
  const total = ok ? multiplyByQuantity(cost, qtyMilli) : 0;
  return { qtyMilli, cost, taxBp, ok, total, tax: ok ? percentOf(total, taxBp) : 0 };
}

function NewPurchaseDialog({
  suppliers,
  defaultSupplierId,
  onClose,
  onCreated,
}: {
  suppliers: SupplierSummary[];
  defaultSupplierId: string;
  onClose: () => void;
  onCreated: (p: PurchaseDetail) => void;
}) {
  const { t, language } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const shiftGuard = useShiftGuard();
  const { can } = useAuth();
  const canPay = can(PERMISSIONS.PURCHASES_PAY);
  const [supplierId, setSupplierId] = useState(defaultSupplierId || (suppliers[0]?.id ?? ''));
  const [invoiceNo, setInvoiceNo] = useState('');
  const [orderDate, setOrderDate] = useState(todayLocal());
  const [expectedDate, setExpectedDate] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [extra, setExtra] = useState('');
  const [notes, setNotes] = useState('');
  const [receiveNow, setReceiveNow] = useState(true);
  const [payNow, setPayNow] = useState(false);
  const [payMethod, setPayMethod] = useState<PaymentMethod>('cash');
  const [payAmount, setPayAmount] = useState('');
  const [payRef, setPayRef] = useState('');

  useEffect(() => {
    if (!supplierId && suppliers[0]) setSupplierId(suppliers[0].id);
  }, [suppliers, supplierId]);

  const computed = lines.map(lineValues);
  const subtotal = computed.reduce((s, c) => s + c.total, 0);
  const tax = computed.reduce((s, c) => s + c.tax, 0);
  const extraCents = extra.trim() ? parseMoneyInput(extra) : 0;
  const total = subtotal + tax + (extraCents ?? 0);
  const payCents = payAmount.trim() ? parseMoneyInput(payAmount) : total;
  const valid =
    supplierId !== '' &&
    lines.length > 0 &&
    computed.every((c) => c.ok) &&
    extraCents !== null &&
    (!payNow || (payCents !== null && payCents > 0 && payCents <= total));

  const addProduct = (p: ProductSummary) => {
    setLines((prev) => {
      const i = prev.findIndex((l) => l.product.id === p.id);
      if (i >= 0) {
        const cur = prev[i]!;
        const qty = (parseQuantityInput(cur.qty) ?? 0) + 1000;
        return prev.map((l, j) => (j === i ? { ...l, qty: formatQuantity(qty) } : l));
      }
      return [
        ...prev,
        {
          product: p,
          qty: '1',
          cost: centsToInput(p.purchaseCostCents),
          taxPct: p.taxRateBp > 0 ? String(p.taxRateBp / 100) : '0',
        },
      ];
    });
  };
  const update = (i: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const mutation = useMutation({
    mutationFn: () =>
      api<PurchaseDetail>('/purchases', {
        method: 'POST',
        body: {
          supplierId,
          supplierInvoiceNo: invoiceNo.trim() || null,
          orderDate,
          expectedDate: expectedDate || null,
          items: lines.map((l, i) => ({
            productId: l.product.id,
            quantityMilli: computed[i]!.qtyMilli,
            unitCostCents: computed[i]!.cost,
            taxRateBp: computed[i]!.taxBp,
          })),
          additionalCostsCents: extraCents ?? 0,
          notes: notes.trim() || null,
          receiveNow,
          payment: payNow
            ? { method: payMethod, amountCents: payCents, reference: payRef.trim() || null }
            : null,
        },
      }),
    onSuccess: (p) => {
      toast.success(t('purchases.created', { ref: p.referenceNo }));
      void queryClient.invalidateQueries({ queryKey: ['purchases'] });
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onCreated(p);
    },
    onError: (err) => {
      if (shiftGuard.handle(err, () => mutation.mutate())) return;
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    },
  });
  const err = mutation.error;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('purchases.new')}
      size="lg"
      footer={
        <>
          <div className="row" style={{ marginRight: 'auto', gap: 14 }}>
            <span className="muted">{t('purchases.subtotal')}</span>
            <strong className="num">{fmt.money(subtotal)}</strong>
            <span className="muted">{t('purchases.tax')}</span>
            <strong className="num">{fmt.money(tax)}</strong>
            <span className="muted">{t('sales.total')}</span>
            <strong className="num" data-testid="purchase-total">
              {fmt.money(total)}
            </strong>
          </div>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {receiveNow ? t('purchases.saveAndReceive') : t('purchases.saveOrder')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid--2">
          <Field label={t('purchases.supplier')} error={fieldError(err, 'supplierId')}>
            {(id, invalid) => (
              <Select
                id={id}
                aria-invalid={invalid || undefined}
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
              >
                {suppliers.length === 0 && <option value="">{t('purchases.noSuppliers')}</option>}
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label={t('purchases.supplierInvoice')}
            error={fieldError(err, 'supplierInvoiceNo')}
          >
            {(id, invalid) => (
              <Input
                id={id}
                aria-invalid={invalid || undefined}
                className="mono"
                value={invoiceNo}
                onChange={(e) => setInvoiceNo(e.target.value)}
                maxLength={60}
              />
            )}
          </Field>
        </div>
        <div className="grid grid--2">
          <Field label={t('purchases.orderDate')} error={fieldError(err, 'orderDate')}>
            {(id, invalid) => (
              <Input
                id={id}
                aria-invalid={invalid || undefined}
                type="date"
                value={orderDate}
                onChange={(e) => setOrderDate(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('purchases.expectedDate')} error={fieldError(err, 'expectedDate')}>
            {(id, invalid) => (
              <Input
                id={id}
                aria-invalid={invalid || undefined}
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
              />
            )}
          </Field>
        </div>
        <Field label={t('purchases.addProduct')} hint={t('purchases.addProductHint')}>
          {(id) => <ProductPicker id={id} onPick={addProduct} autoFocus />}
        </Field>
        {lines.length > 0 && (
          <div className="table-wrap">
            <table className="table table--compact">
              <thead>
                <tr>
                  <th>{t('purchases.product')}</th>
                  <th className="right">{t('receipt.qty')}</th>
                  <th className="right">{t('purchases.unitCost')}</th>
                  <th className="right">{t('purchases.taxPct')}</th>
                  <th className="right">{t('sales.total')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const c = computed[i]!;
                  return (
                    <tr key={l.product.id} data-testid="purchase-line">
                      <td>
                        <div className="stack" style={{ gap: 0 }}>
                          <span>{l.product.name}</span>
                          <span className="faint mono">
                            {l.product.sku} · {t('purchases.stock')}{' '}
                            {formatQuantity(l.product.stockMilli, language)} {l.product.unitCode}
                          </span>
                        </div>
                      </td>
                      <td className="right">
                        <Input
                          inputMode="decimal"
                          className="num"
                          style={{ width: 90, textAlign: 'right' }}
                          value={l.qty}
                          aria-invalid={c.qtyMilli === null || c.qtyMilli <= 0 || undefined}
                          aria-label={t('receipt.qty')}
                          onChange={(e) => update(i, { qty: e.target.value })}
                        />
                      </td>
                      <td className="right">
                        <Input
                          inputMode="decimal"
                          className="num"
                          style={{ width: 100, textAlign: 'right' }}
                          value={l.cost}
                          aria-invalid={c.cost === null || undefined}
                          aria-label={t('purchases.unitCost')}
                          onChange={(e) => update(i, { cost: e.target.value })}
                        />
                      </td>
                      <td className="right">
                        <Input
                          inputMode="decimal"
                          className="num"
                          style={{ width: 70, textAlign: 'right' }}
                          value={l.taxPct}
                          aria-invalid={!Number.isFinite(c.taxBp) || undefined}
                          aria-label={t('purchases.taxPct')}
                          onChange={(e) => update(i, { taxPct: e.target.value })}
                        />
                      </td>
                      <td className="right num">{c.ok ? fmt.money(c.total + c.tax) : '—'}</td>
                      <td className="right">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t('common.delete')}
                          onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}
                        >
                          <Trash2 size={13} />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {lines.length === 0 && <p className="muted">{t('purchases.noLines')}</p>}
        <div className="grid grid--2">
          <Field
            label={t('purchases.additionalCosts')}
            hint={t('purchases.additionalCostsHint')}
            error={extra.trim() && extraCents === null ? t('common.invalid') : undefined}
          >
            {(id, invalid) => (
              <Input
                id={id}
                aria-invalid={invalid || undefined}
                inputMode="decimal"
                placeholder="0.00"
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('common.notes')} error={fieldError(err, 'notes')}>
            {(id, invalid) => (
              <Textarea
                id={id}
                aria-invalid={invalid || undefined}
                rows={1}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={1000}
              />
            )}
          </Field>
        </div>
        <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
          <Switch checked={receiveNow} onChange={setReceiveNow} label={t('purchases.receiveNow')} />
          {canPay && <Switch checked={payNow} onChange={setPayNow} label={t('purchases.payNow')} />}
        </div>
        {payNow && (
          <div className="grid grid--3">
            <Field label={t('sessions.paymentMethod')}>
              {(id) => (
                <Select
                  id={id}
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value as PaymentMethod)}
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t(`sessions.methods.${m}` as 'sessions.methods.cash')}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label={t('receipt.amount')}
              error={
                payAmount.trim() && (payCents === null || payCents <= 0 || payCents > total)
                  ? t('purchases.paymentTooHigh')
                  : undefined
              }
            >
              {(id, invalid) => (
                <Input
                  id={id}
                  aria-invalid={invalid || undefined}
                  inputMode="decimal"
                  placeholder={centsToInput(total)}
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                />
              )}
            </Field>
            <Field label={t('purchases.paymentReference')}>
              {(id) => (
                <Input
                  id={id}
                  className="mono"
                  value={payRef}
                  onChange={(e) => setPayRef(e.target.value)}
                  maxLength={80}
                />
              )}
            </Field>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/* ----------------------------------------------------------------------------------------------
 * Purchase detail: receive, pay, cancel
 * -------------------------------------------------------------------------------------------- */

function PurchaseDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, language } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const shiftGuard = useShiftGuard();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.PURCHASES_MANAGE);
  const canPay = can(PERMISSIONS.PURCHASES_PAY);
  const [mode, setMode] = useState<'view' | 'receive' | 'pay' | 'cancel'>('view');
  const detail = useQuery({
    queryKey: ['purchases', 'detail', id],
    queryFn: () => api<PurchaseDetail>(`/purchases/${id}`),
  });
  const p = detail.data;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['purchases'] });
    void queryClient.invalidateQueries({ queryKey: ['suppliers'] });
    void queryClient.invalidateQueries({ queryKey: ['products'] });
    void queryClient.invalidateQueries({ queryKey: ['cash'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const onError = (err: unknown, retry: () => void) => {
    if (shiftGuard.handle(err, retry)) return;
    toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
  };

  // Receive form: remaining quantity per line, editable.
  const [receiveQty, setReceiveQty] = useState<Record<number, string>>({});
  const [deliveryNote, setDeliveryNote] = useState('');
  useEffect(() => {
    if (!p) return;
    const next: Record<number, string> = {};
    for (const it of p.items) {
      const remaining = it.quantityOrderedMilli - it.quantityReceivedMilli;
      next[it.id] = remaining > 0 ? formatQuantity(remaining) : '0';
    }
    setReceiveQty(next);
  }, [p]);
  const receiveItems = p
    ? p.items
        .map((it) => ({
          purchaseItemId: it.id,
          quantityMilli: parseQuantityInput(receiveQty[it.id] ?? '0') ?? NaN,
          remaining: it.quantityOrderedMilli - it.quantityReceivedMilli,
        }))
        .filter((x) => x.remaining > 0)
    : [];
  const receiveValid =
    receiveItems.every(
      (x) =>
        Number.isFinite(x.quantityMilli) && x.quantityMilli >= 0 && x.quantityMilli <= x.remaining,
    ) && receiveItems.some((x) => x.quantityMilli > 0);
  const receive = useMutation({
    mutationFn: () =>
      api<PurchaseDetail>(`/purchases/${id}/receive`, {
        method: 'POST',
        body: {
          items: receiveItems
            .filter((x) => x.quantityMilli > 0)
            .map(({ purchaseItemId, quantityMilli }) => ({ purchaseItemId, quantityMilli })),
          deliveryNoteNo: deliveryNote.trim() || null,
        },
      }),
    onSuccess: (next) => {
      toast.success(t('purchases.receivedToast'));
      queryClient.setQueryData(['purchases', 'detail', id], next);
      invalidate();
      setDeliveryNote('');
      setMode('view');
    },
    onError: (err) => onError(err, () => receive.mutate()),
  });

  const [payMethod, setPayMethod] = useState<PaymentMethod>('cash');
  const [payAmount, setPayAmount] = useState('');
  const [payRef, setPayRef] = useState('');
  const due = p ? p.totalCents - p.paidCents : 0;
  const payCents = payAmount.trim() ? parseMoneyInput(payAmount) : due;
  const payValid = payCents !== null && payCents > 0 && payCents <= due;
  const pay = useMutation({
    mutationFn: () =>
      api<PurchaseDetail>(`/purchases/${id}/payments`, {
        method: 'POST',
        body: { method: payMethod, amountCents: payCents, reference: payRef.trim() || null },
      }),
    onSuccess: (next) => {
      toast.success(t('purchases.paymentRecorded'));
      queryClient.setQueryData(['purchases', 'detail', id], next);
      invalidate();
      setPayAmount('');
      setPayRef('');
      setMode('view');
    },
    onError: (err) => onError(err, () => pay.mutate()),
  });
  const cancel = useMutation({
    mutationFn: () => api<PurchaseDetail>(`/purchases/${id}/cancel`, { method: 'POST', body: {} }),
    onSuccess: (next) => {
      toast.success(t('purchases.cancelledToast'));
      queryClient.setQueryData(['purchases', 'detail', id], next);
      invalidate();
      setMode('view');
    },
    onError: (err) => onError(err, () => cancel.mutate()),
  });

  const outstanding = p
    ? p.items.some((it) => it.quantityReceivedMilli < it.quantityOrderedMilli)
    : false;
  const canReceive = !!p && canManage && p.status !== 'cancelled' && outstanding;
  const canRecordPayment = !!p && canPay && p.status !== 'cancelled' && due > 0;
  const canCancel =
    !!p && canManage && (p.status === 'ordered' || p.status === 'draft') && p.paidCents === 0;

  return (
    <Dialog
      open
      onClose={onClose}
      title={p ? `${t('purchases.purchase')} ${p.referenceNo}` : t('purchases.purchase')}
      size="lg"
      footer={
        <>
          {p && mode === 'view' && (
            <div className="row" style={{ marginRight: 'auto', gap: 8 }}>
              {canReceive && (
                <Button variant="primary" onClick={() => setMode('receive')}>
                  <PackageCheck size={14} /> {t('purchases.receive')}
                </Button>
              )}
              {canRecordPayment && (
                <Button onClick={() => setMode('pay')}>
                  <Wallet size={14} /> {t('purchases.addPayment')}
                </Button>
              )}
              {canCancel && (
                <Button variant="danger" onClick={() => setMode('cancel')}>
                  <Ban size={14} /> {t('purchases.cancel')}
                </Button>
              )}
            </div>
          )}
          {mode === 'receive' && (
            <>
              <Button variant="ghost" onClick={() => setMode('view')}>
                {t('common.back')}
              </Button>
              <Button
                variant="primary"
                disabled={!receiveValid}
                loading={receive.isPending}
                onClick={() => receive.mutate()}
              >
                {t('purchases.confirmReceive')}
              </Button>
            </>
          )}
          {mode === 'pay' && (
            <>
              <Button variant="ghost" onClick={() => setMode('view')}>
                {t('common.back')}
              </Button>
              <Button
                variant="primary"
                disabled={!payValid}
                loading={pay.isPending}
                onClick={() => pay.mutate()}
              >
                {t('purchases.confirmPayment')}
              </Button>
            </>
          )}
          {mode === 'view' && (
            <Button variant="ghost" onClick={onClose}>
              {t('common.close')}
            </Button>
          )}
        </>
      }
    >
      {detail.isLoading && <Loading />}
      {p && (
        <div className="stack">
          <div className="grid grid--3">
            <Meta label={t('purchases.supplier')} value={p.supplierName} />
            <Meta label={t('purchases.orderDate')} value={fmt.date(p.orderDate)} />
            <Meta
              label={t('common.status')}
              value={
                <span className="row" style={{ gap: 6 }}>
                  <Badge tone={STATUS_TONE[p.status]}>{t(`purchases.status.${p.status}`)}</Badge>
                  {p.status !== 'cancelled' && (
                    <Badge tone={PAY_TONE[p.paymentStatus]}>
                      {t(`purchases.pay.${p.paymentStatus}`)}
                    </Badge>
                  )}
                </span>
              }
            />
            <Meta label={t('purchases.supplierInvoice')} value={p.supplierInvoiceNo ?? '—'} mono />
            <Meta label={t('purchases.expectedDate')} value={fmt.date(p.expectedDate)} />
            <Meta label={t('purchases.createdBy')} value={p.createdByName ?? '—'} />
          </div>
          {p.notes && <p className="muted">{p.notes}</p>}

          <div className="table-wrap">
            <table className="table table--compact">
              <thead>
                <tr>
                  <th>{t('purchases.product')}</th>
                  <th className="right">{t('purchases.ordered')}</th>
                  <th className="right">{t('purchases.received')}</th>
                  {mode === 'receive' && <th className="right">{t('purchases.receiveQty')}</th>}
                  <th className="right">{t('purchases.unitCost')}</th>
                  <th className="right">{t('purchases.taxPct')}</th>
                  <th className="right">{t('sales.total')}</th>
                </tr>
              </thead>
              <tbody>
                {p.items.map((it) => {
                  const remaining = it.quantityOrderedMilli - it.quantityReceivedMilli;
                  const entered = parseQuantityInput(receiveQty[it.id] ?? '0');
                  const bad = entered === null || entered < 0 || entered > remaining;
                  return (
                    <tr key={it.id}>
                      <td>
                        <div className="stack" style={{ gap: 0 }}>
                          <span>{it.productName}</span>
                          {it.sku && <span className="faint mono">{it.sku}</span>}
                        </div>
                      </td>
                      <td className="right num">
                        {formatQuantity(it.quantityOrderedMilli, language)}
                      </td>
                      <td
                        className={`right num ${
                          it.quantityReceivedMilli >= it.quantityOrderedMilli
                            ? 'text-success'
                            : it.quantityReceivedMilli > 0
                              ? 'text-warning'
                              : ''
                        }`}
                      >
                        {formatQuantity(it.quantityReceivedMilli, language)}
                      </td>
                      {mode === 'receive' && (
                        <td className="right">
                          {remaining > 0 ? (
                            <Input
                              inputMode="decimal"
                              className="num"
                              style={{ width: 90, textAlign: 'right' }}
                              value={receiveQty[it.id] ?? ''}
                              aria-invalid={bad || undefined}
                              aria-label={t('purchases.receiveQty')}
                              onChange={(e) =>
                                setReceiveQty({ ...receiveQty, [it.id]: e.target.value })
                              }
                            />
                          ) : (
                            <span className="faint">—</span>
                          )}
                        </td>
                      )}
                      <td className="right num">{fmt.money(it.unitCostCents)}</td>
                      <td className="right num">{(it.taxRateBp / 100).toFixed(0)}%</td>
                      <td className="right num">{fmt.money(it.lineTotalCents)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={mode === 'receive' ? 6 : 5} className="right muted">
                    {t('purchases.subtotal')}
                  </td>
                  <td className="right num">{fmt.money(p.subtotalCents)}</td>
                </tr>
                {p.taxCents > 0 && (
                  <tr>
                    <td colSpan={mode === 'receive' ? 6 : 5} className="right muted">
                      {t('purchases.tax')}
                    </td>
                    <td className="right num">{fmt.money(p.taxCents)}</td>
                  </tr>
                )}
                {p.additionalCostsCents > 0 && (
                  <tr>
                    <td colSpan={mode === 'receive' ? 6 : 5} className="right muted">
                      {t('purchases.additionalCosts')}
                    </td>
                    <td className="right num">{fmt.money(p.additionalCostsCents)}</td>
                  </tr>
                )}
                <tr>
                  <td colSpan={mode === 'receive' ? 6 : 5} className="right">
                    <strong>{t('sales.total')}</strong>
                  </td>
                  <td className="right num">
                    <strong>{fmt.money(p.totalCents)}</strong>
                  </td>
                </tr>
                <tr>
                  <td colSpan={mode === 'receive' ? 6 : 5} className="right muted">
                    {t('purchases.paid')} / {t('purchases.due')}
                  </td>
                  <td className="right num">
                    {fmt.money(p.paidCents)} /{' '}
                    <span className={due > 0 ? 'text-warning' : ''}>{fmt.money(due)}</span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {mode === 'receive' && (
            <Field label={t('purchases.deliveryNote')}>
              {(id) => (
                <Input
                  id={id}
                  className="mono"
                  value={deliveryNote}
                  onChange={(e) => setDeliveryNote(e.target.value)}
                  maxLength={60}
                  autoFocus
                />
              )}
            </Field>
          )}
          {mode === 'pay' && (
            <div className="grid grid--3">
              <Field label={t('sessions.paymentMethod')}>
                {(id) => (
                  <Select
                    id={id}
                    value={payMethod}
                    onChange={(e) => setPayMethod(e.target.value as PaymentMethod)}
                  >
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {t(`sessions.methods.${m}` as 'sessions.methods.cash')}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field
                label={t('receipt.amount')}
                error={payAmount.trim() && !payValid ? t('purchases.paymentTooHigh') : undefined}
              >
                {(id, invalid) => (
                  <Input
                    id={id}
                    aria-invalid={invalid || undefined}
                    inputMode="decimal"
                    autoFocus
                    placeholder={centsToInput(due)}
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                  />
                )}
              </Field>
              <Field label={t('purchases.paymentReference')}>
                {(id) => (
                  <Input
                    id={id}
                    className="mono"
                    value={payRef}
                    onChange={(e) => setPayRef(e.target.value)}
                    maxLength={80}
                  />
                )}
              </Field>
            </div>
          )}

          {(p.receipts.length > 0 || p.payments.length > 0) && mode === 'view' && (
            <div className="grid grid--2">
              <div className="stack" style={{ gap: 6 }}>
                <h4>{t('purchases.receipts')}</h4>
                {p.receipts.length === 0 && <span className="faint">—</span>}
                {p.receipts.map((r) => (
                  <div key={r.id} className="row" style={{ justifyContent: 'space-between' }}>
                    <span>
                      {fmt.dateTime(r.receivedAt)}
                      {r.deliveryNoteNo && (
                        <span className="faint mono"> · {r.deliveryNoteNo}</span>
                      )}
                    </span>
                    <span className="faint">
                      {r.items.length} {t('sales.items').toLowerCase()} · {r.receivedByName ?? '—'}
                    </span>
                  </div>
                ))}
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <h4>{t('purchases.payments')}</h4>
                {p.payments.length === 0 && <span className="faint">—</span>}
                {p.payments.map((pm) => (
                  <div key={pm.id} className="row" style={{ justifyContent: 'space-between' }}>
                    <span>
                      {fmt.dateTime(pm.paidAt)} ·{' '}
                      {t(`sessions.methods.${pm.method}` as 'sessions.methods.cash')}
                      {pm.reference && <span className="faint mono"> · {pm.reference}</span>}
                    </span>
                    <strong className="num">{fmt.money(pm.amountCents)}</strong>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {mode === 'cancel' && p && (
        <ConfirmDialog
          open
          title={t('purchases.cancel')}
          body={t('purchases.cancelConfirm', { ref: p.referenceNo })}
          confirmLabel={t('purchases.cancel')}
          danger
          loading={cancel.isPending}
          onConfirm={() => cancel.mutate()}
          onClose={() => setMode('view')}
        />
      )}
    </Dialog>
  );
}

function Meta({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      <span className="faint" style={{ fontSize: 12 }}>
        {label}
      </span>
      <span className={mono ? 'mono' : undefined}>{value}</span>
    </div>
  );
}
