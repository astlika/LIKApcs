/**
 * Point of sale. Keyboard-first: F2 search/scan field, F4 new sale, F6 payment, F8 complete,
 * Esc closes dialogs. USB barcode scanners act as keyboards — a fast burst ending in Enter is
 * looked up as a code; slower typing searches by name.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Banknote,
  CreditCard,
  Minus,
  PauseCircle,
  Plus,
  Printer,
  ScanLine,
  ShoppingCart,
  Trash2,
  X,
} from 'lucide-react';
import {
  PERMISSIONS,
  parseMoneyInput,
  customerDiscountCents,
  type CategorySummary,
  type CustomerSummary,
  type ProductLookupResponse,
  type ProductSummary,
  type ReceiptData,
  type SaleDetail,
  type SalePaymentInput,
  type SalesListResponse,
} from '@likapcs/shared';
import { api, ApiError } from '../lib/api';
import {
  addToCart,
  cartItemCount,
  cartToRequest,
  cartTotals,
  emptyCart,
  removeLine,
  ScanBuffer,
  setLineDiscount,
  setQuantity,
  type Cart,
} from '../lib/cart';
import { useFormat } from '../lib/format';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import { useShiftGuard } from '../state/shift-guard';
import { Receipt, printReceipt } from '../components/pos/Receipt';
import { CustomerPicker } from '../components/customers/CustomerPicker';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  Input,
  Kbd,
  Loading,
} from '../components/ui/primitives';

const QUICK_CASH = [500, 1000, 2000, 5000];

export function PosPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const canDiscount = can(PERMISSIONS.POS_DISCOUNT);
  const canSuspend = can(PERMISSIONS.POS_SUSPEND);

  const [cart, setCart] = useState<Cart>(() => emptyCart());
  const [customer, setCustomer] = useState<CustomerSummary | null>(null);
  const [resumedId, setResumedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // The tile grid filters on a debounced copy so scanner key bursts don't trigger a query per key.
  const [gridSearch, setGridSearch] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'payment' | 'confirmNew' | 'suspended' | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scanner = useRef(new ScanBuffer());

  const categories = useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: () => api<CategorySummary[]>('/catalog/categories'),
    staleTime: 60_000,
  });
  useEffect(() => {
    const h = setTimeout(() => setGridSearch(search.trim()), 180);
    return () => clearTimeout(h);
  }, [search]);
  const products = useQuery({
    queryKey: ['products', 'pos', categoryId, gridSearch],
    queryFn: () =>
      api<{ items: ProductSummary[]; total: number }>('/products', {
        query: { q: gridSearch || undefined, categoryId: categoryId ?? undefined, pageSize: 200 },
      }),
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
  const suspended = useQuery({
    queryKey: ['sales', 'suspended'],
    queryFn: () =>
      api<SalesListResponse>('/sales', { query: { status: 'suspended', pageSize: 50 } }),
    enabled: canSuspend,
    staleTime: 10_000,
  });

  const totals = useMemo(() => cartTotals(cart, customer?.discountBp ?? 0), [cart, customer]);
  const resetCart = useCallback(() => {
    setCart(emptyCart());
    setCustomer(null);
    setResumedId(null);
    setSearch('');
    setDialog(null);
  }, []);

  const add = useCallback((product: ProductSummary, quantityMilli = 1000) => {
    if (!product.isActive) return;
    setCart((c) => addToCart(c, product, quantityMilli));
  }, []);

  const lookup = useMutation({
    mutationFn: (code: string) =>
      api<ProductLookupResponse>('/products/lookup', { query: { code } }),
    onSuccess: (r) => {
      add(r.product, r.quantityMilli);
      setSearch('');
    },
    onError: (err, code) => {
      // Clear the field either way so the next scan starts clean; the toast carries the code.
      setSearch('');
      toast.error(
        err instanceof ApiError && err.status === 404
          ? t('pos.scanUnknown', { code })
          : t('common.errorGeneric'),
      );
    },
  });

  // Resume a parked sale from the Sales page (?resume=<id>).
  useEffect(() => {
    const id = params.get('resume');
    if (!id) return;
    params.delete('resume');
    setParams(params, { replace: true });
    void api<SaleDetail>(`/sales/${id}`).then(async (sale) => {
      let next = emptyCart();
      for (const item of sale.items) {
        if (!item.productId) continue;
        const product = await api<ProductSummary>(`/products/${item.productId}`);
        next = addToCart(next, product, item.quantityMilli);
        if (item.discountCents) next = setLineDiscount(next, product.id, item.discountCents);
      }
      // A parked sale's discount may be the customer's default one (applied by the server); do
      // not resend it as an explicit discount, the server re-applies it on completion.
      let linked: CustomerSummary | null = null;
      let discountCents = sale.discountCents;
      if (sale.customerId) {
        linked = await api<CustomerSummary>(`/customers/${sale.customerId}`).catch(() => null);
        if (
          linked &&
          discountCents > 0 &&
          discountCents === customerDiscountCents(sale.subtotalCents, linked.discountBp)
        ) {
          discountCents = 0;
        }
      }
      setCustomer(linked);
      setCart({
        ...next,
        discountCents,
        customerId: linked?.id ?? null,
        notes: sale.notes ?? '',
      });
      setResumedId(sale.id);
    });
  }, [params, setParams]);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === 'F4') {
        e.preventDefault();
        if (cart.lines.length) setDialog('confirmNew');
        else resetCart();
      } else if (e.key === 'F6') {
        e.preventDefault();
        if (cart.lines.length && !receipt) setDialog('payment');
      } else if (e.key === 'Escape' && receipt) {
        setReceipt(null);
        resetCart();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cart.lines.length, receipt, resetCart]);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Use the event's own timestamp: it reflects when the key was pressed, not when React got
    // around to handling it, so a slow render cannot split a scanner burst.
    if (e.key.length === 1) scanner.current.push(e.key, e.timeStamp);
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const scanned = scanner.current.flush(e.timeStamp);
    const code = (scanned ?? search).trim();
    if (!code) return;
    // A scan, or a code typed and confirmed with Enter, is looked up exactly; if the typed text is
    // not a code the single visible match is added.
    if (scanned || /^[A-Za-z0-9._-]{3,64}$/.test(code)) {
      lookup.mutate(code);
    } else if (products.data?.items.length === 1) {
      add(products.data.items[0]!);
      setSearch('');
    }
  };

  const suspend = useMutation({
    mutationFn: () =>
      api<SaleDetail>('/sales/suspend', { method: 'POST', body: cartToRequest(cart) }),
    onSuccess: () => {
      toast.success(t('pos.parked'));
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      resetCart();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  const voidSale = useMutation({
    mutationFn: (id: string) => api<void>(`/sales/${id}/void`, { method: 'POST' }),
    onSuccess: () => {
      toast.success(t('pos.voided'));
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  const list = products.data?.items ?? [];

  return (
    <div className="pos">
      <section className="pos__catalog">
        <div className="pos__search">
          <ScanLine size={18} className="muted" />
          <input
            ref={searchRef}
            className="input pos__search-input"
            placeholder={t('pos.searchPlaceholder')}
            value={search}
            autoFocus
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKey}
            aria-label={t('pos.searchPlaceholder')}
          />
          {search && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setSearch('')}
              aria-label={t('common.close')}
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="chips pos__categories">
          <button
            type="button"
            className="chip"
            aria-pressed={categoryId === null}
            onClick={() => setCategoryId(null)}
          >
            {t('pos.allCategories')}
          </button>
          {(categories.data ?? [])
            .filter((c) => c.isActive)
            .map((c) => (
              <button
                key={c.id}
                type="button"
                className="chip"
                aria-pressed={categoryId === c.id}
                style={c.color ? { borderColor: c.color } : undefined}
                onClick={() => setCategoryId(c.id)}
              >
                {c.name}
              </button>
            ))}
        </div>
        {products.isLoading && <Loading />}
        {products.isSuccess && list.length === 0 && (
          <EmptyState
            icon={<ShoppingCart size={22} />}
            title={search ? t('pos.noMatches') : t('pos.noProducts')}
          />
        )}
        <div className="pos__grid">
          {list.map((p) => {
            const out = p.trackStock && !p.allowNegativeStock && p.stockMilli <= 0;
            return (
              <button
                key={p.id}
                type="button"
                className="tile"
                disabled={out}
                onClick={() => add(p)}
                style={
                  p.categoryColor ? { ['--tile-accent' as string]: p.categoryColor } : undefined
                }
              >
                <div className="tile__name">{p.name}</div>
                <div className="tile__meta">
                  <span className="num">{fmt.money(p.sellingPriceCents)}</span>
                  {p.trackStock && (
                    <span
                      className={`tile__stock ${out ? 'text-danger' : p.lowStock ? 'text-warning' : 'faint'}`}
                    >
                      {out ? t('pos.outOfStock') : t('pos.stockLeft', { n: p.stockMilli / 1000 })}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <aside className="pos__cart">
        <div className="pos__cart-head">
          <h2>
            <ShoppingCart size={18} /> {t('pos.cart')}
            {resumedId && <Badge tone="warning">{t('sales.status.suspended')}</Badge>}
          </h2>
          <span className="muted">{t('pos.items', { n: cartItemCount(cart) })}</span>
        </div>
        <div className="pos__customer">
          <CustomerPicker
            value={customer}
            onChange={(c) => {
              setCustomer(c);
              setCart((prev) => ({ ...prev, customerId: c?.id ?? null }));
            }}
            placeholder={t('pos.customerPlaceholder')}
          />
        </div>
        <div className="pos__lines">
          {cart.lines.length === 0 && <div className="pos__empty">{t('pos.emptyCart')}</div>}
          {cart.lines.map((line, i) => {
            const computed = totals.lines[i]!;
            return (
              <div key={line.product.id} className="pos-line">
                <div className="pos-line__main">
                  <div className="pos-line__name">{line.product.name}</div>
                  <div className="pos-line__price faint num">
                    {fmt.money(line.product.sellingPriceCents)} × {line.quantityMilli / 1000}
                  </div>
                </div>
                <div className="pos-line__qty">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() =>
                      setCart(setQuantity(cart, line.product.id, line.quantityMilli - 1000))
                    }
                    aria-label="−"
                  >
                    <Minus size={14} />
                  </button>
                  <input
                    className="input pos-line__qty-input num"
                    inputMode="decimal"
                    value={line.quantityMilli / 1000}
                    onChange={(e) => {
                      const q = Number(e.target.value.replace(',', '.'));
                      if (Number.isFinite(q) && q >= 0) {
                        setCart(setQuantity(cart, line.product.id, Math.round(q * 1000)));
                      }
                    }}
                    aria-label={t('pos.qty')}
                  />
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() =>
                      setCart(setQuantity(cart, line.product.id, line.quantityMilli + 1000))
                    }
                    aria-label="+"
                  >
                    <Plus size={14} />
                  </button>
                </div>
                <div className="pos-line__total num">
                  {fmt.money(computed.lineTotalCents)}
                  {canDiscount && (
                    <input
                      className="input pos-line__discount"
                      placeholder="−0.00"
                      title={t('pos.lineDiscount')}
                      inputMode="decimal"
                      defaultValue={line.discountCents ? (line.discountCents / 100).toFixed(2) : ''}
                      onBlur={(e) => {
                        const cents = e.target.value.trim() ? parseMoneyInput(e.target.value) : 0;
                        if (cents !== null) setCart(setLineDiscount(cart, line.product.id, cents));
                      }}
                      aria-label={t('pos.lineDiscount')}
                    />
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setCart(removeLine(cart, line.product.id))}
                  aria-label={t('common.delete')}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="pos__totals">
          {canDiscount && (
            <div className="row row--between">
              <span className="muted">{t('pos.saleDiscount')}</span>
              <input
                className="input pos__discount num"
                inputMode="decimal"
                placeholder="0.00"
                defaultValue={cart.discountCents ? (cart.discountCents / 100).toFixed(2) : ''}
                key={cart.clientRequestId}
                onBlur={(e) => {
                  const cents = e.target.value.trim() ? parseMoneyInput(e.target.value) : 0;
                  if (cents !== null) setCart({ ...cart, discountCents: cents });
                }}
                aria-label={t('pos.saleDiscount')}
              />
            </div>
          )}
          <div className="row row--between">
            <span className="muted">{t('pos.subtotal')}</span>
            <span className="num">{fmt.money(totals.subtotalCents)}</span>
          </div>
          {totals.discountCents > 0 && (
            <div className="row row--between">
              <span className="muted">
                {totals.memberDiscount
                  ? t('pos.memberDiscount', { pct: ((customer?.discountBp ?? 0) / 100).toFixed(0) })
                  : t('pos.discount')}
              </span>
              <span className="num">−{fmt.money(totals.discountCents)}</span>
            </div>
          )}
          <div className="row row--between faint" style={{ fontSize: 12 }}>
            <span>{t('pos.tax')}</span>
            <span className="num">{fmt.money(totals.taxCents)}</span>
          </div>
          <div className="pos__grand">
            <span>{t('pos.total')}</span>
            <span className="num">{fmt.money(totals.totalCents)}</span>
          </div>
        </div>
        <div className="pos__actions">
          <div className="pos__actions-row">
            <Button onClick={() => (cart.lines.length ? setDialog('confirmNew') : resetCart())}>
              {t('pos.newSale')} <Kbd>F4</Kbd>
            </Button>
            {canSuspend && (
              <>
                <Button
                  disabled={cart.lines.length === 0}
                  loading={suspend.isPending}
                  onClick={() => suspend.mutate()}
                >
                  <PauseCircle size={14} /> {t('pos.suspend')}
                </Button>
                <Button onClick={() => setDialog('suspended')}>
                  {t('pos.suspended')}
                  {(suspended.data?.total ?? 0) > 0 && (
                    <Badge tone="warning">{suspended.data!.total}</Badge>
                  )}
                </Button>
              </>
            )}
          </div>
          <Button
            variant="primary"
            size="lg"
            className="pos__pay"
            disabled={cart.lines.length === 0}
            onClick={() => setDialog('payment')}
          >
            <Banknote size={16} /> {t('pos.pay')} <Kbd>F6</Kbd>
          </Button>
        </div>
        <div className="pos__hint faint">{t('pos.shortcuts')}</div>
      </aside>

      {dialog === 'payment' && (
        <PaymentDialog
          cart={cart}
          resumedId={resumedId}
          totalCents={totals.totalCents}
          onClose={() => setDialog(null)}
          onCompleted={(sale, receiptData) => {
            setDialog(null);
            toast.success(t('pos.completed', { receipt: sale.receiptNo ?? '' }));
            void queryClient.invalidateQueries({ queryKey: ['products'] });
            void queryClient.invalidateQueries({ queryKey: ['sales'] });
            void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
            void queryClient.invalidateQueries({ queryKey: ['cash'] });
            setReceipt(receiptData);
          }}
        />
      )}
      <ConfirmDialog
        open={dialog === 'confirmNew'}
        onClose={() => setDialog(null)}
        onConfirm={resetCart}
        title={t('pos.newSale')}
        body={t('pos.newSaleConfirm')}
        confirmLabel={t('pos.newSale')}
        danger
      />
      {dialog === 'suspended' && (
        <Dialog open onClose={() => setDialog(null)} title={t('pos.suspended')} size="md">
          {(suspended.data?.items.length ?? 0) === 0 && (
            <p className="muted">{t('pos.noSuspended')}</p>
          )}
          {(suspended.data?.items ?? []).map((s) => (
            <div
              key={s.id}
              className="row row--between"
              style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}
            >
              <div>
                <strong>{fmt.money(s.totalCents)}</strong>
                <span className="muted"> · {t('pos.items', { n: s.itemCount })}</span>
                {s.notes && <span className="faint"> · {s.notes}</span>}
                <div className="faint" style={{ fontSize: 12 }}>
                  {fmt.dateTime(s.createdAt)} · {s.cashierName}
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <Button size="sm" variant="ghost" onClick={() => voidSale.mutate(s.id)}>
                  <Trash2 size={14} /> {t('pos.voidSale')}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    setDialog(null);
                    setParams({ resume: s.id });
                  }}
                >
                  {t('pos.resume')}
                </Button>
              </div>
            </div>
          ))}
        </Dialog>
      )}
      {receipt && (
        <Dialog
          open
          onClose={() => {
            setReceipt(null);
            resetCart();
          }}
          title={t('pos.receipt')}
          size="sm"
          footer={
            <>
              <Button onClick={printReceipt}>
                <Printer size={14} /> {t('pos.print')}
              </Button>
              <Button
                variant="primary"
                autoFocus
                onClick={() => {
                  setReceipt(null);
                  resetCart();
                }}
              >
                {t('pos.done')} <Kbd>Esc</Kbd>
              </Button>
            </>
          }
        >
          <Receipt data={receipt} />
        </Dialog>
      )}
    </div>
  );
}

// ─── Payment dialog ────────────────────────────────────────────────────────────
function PaymentDialog({
  cart,
  resumedId,
  totalCents,
  onClose,
  onCompleted,
}: {
  cart: Cart;
  resumedId: string | null;
  totalCents: number;
  onClose: () => void;
  onCompleted: (sale: SaleDetail, receipt: ReceiptData) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const shiftGuard = useShiftGuard();
  const [cashText, setCashText] = useState('');
  const [cardText, setCardText] = useState('');
  const [reference, setReference] = useState('');
  const [method, setMethod] = useState<'cash' | 'card' | 'split'>('cash');
  const cashRef = useRef<HTMLInputElement>(null);

  const cashCents = cashText.trim() ? parseMoneyInput(cashText) : 0;
  const cardCents = cardText.trim() ? parseMoneyInput(cardText) : 0;
  const payments: SalePaymentInput[] = [];
  if (method === 'card')
    payments.push({ method: 'card', amountCents: totalCents, reference: reference || undefined });
  else {
    if (method === 'split' && cardCents && cardCents > 0)
      payments.push({ method: 'card', amountCents: cardCents, reference: reference || undefined });
    if (cashCents && cashCents > 0) payments.push({ method: 'cash', amountCents: cashCents });
  }
  const paid = payments.reduce((a, p) => a + p.amountCents, 0);
  const nonCash = payments
    .filter((p) => p.method !== 'cash')
    .reduce((a, p) => a + p.amountCents, 0);
  const cardOver = nonCash > totalCents;
  const covered = paid >= totalCents && !cardOver && cashCents !== null && cardCents !== null;
  const change = covered ? paid - totalCents : 0;

  const complete = useMutation({
    mutationFn: async () => {
      const body = { ...cartToRequest(cart), payments };
      const sale = resumedId
        ? await api<SaleDetail>(`/sales/${resumedId}/complete`, { method: 'POST', body })
        : await api<SaleDetail>('/sales', { method: 'POST', body });
      const receipt = await api<ReceiptData>(`/sales/${sale.id}/receipt`);
      return { sale, receipt };
    },
    onSuccess: ({ sale, receipt }) => onCompleted(sale, receipt),
    onError: (err) => {
      if (shiftGuard.handle(err, () => complete.mutate())) return;
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F8') {
        e.preventDefault();
        if (covered && !complete.isPending) complete.mutate();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [covered, complete]);

  useEffect(() => {
    cashRef.current?.focus();
  }, [method]);

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('pos.paymentTitle')}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={!covered}
            loading={complete.isPending}
            onClick={() => complete.mutate()}
          >
            {t('pos.complete')} <Kbd>F8</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="pos__grand" style={{ fontSize: 26 }}>
          <span>{t('pos.total')}</span>
          <span className="num">{fmt.money(totalCents)}</span>
        </div>
        <div className="chips">
          {(
            [
              ['cash', t('pos.cash'), <Banknote key="b" size={14} />],
              ['card', t('pos.card'), <CreditCard key="c" size={14} />],
              ['split', `${t('pos.cash')} + ${t('pos.card')}`, null],
            ] as const
          ).map(([value, label, icon]) => (
            <button
              key={value}
              type="button"
              className="chip"
              aria-pressed={method === value}
              onClick={() => setMethod(value)}
            >
              {icon} {label}
            </button>
          ))}
        </div>
        {method !== 'card' && (
          <>
            <div className="chips">
              <button
                type="button"
                className="chip"
                onClick={() =>
                  setCashText(
                    (
                      Math.max(0, totalCents - (method === 'split' ? (cardCents ?? 0) : 0)) / 100
                    ).toFixed(2),
                  )
                }
              >
                {t('pos.exact')}
              </button>
              {QUICK_CASH.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="chip"
                  onClick={() => setCashText((c / 100).toFixed(2))}
                >
                  {fmt.money(c)}
                </button>
              ))}
            </div>
            <Field label={t('pos.tendered')}>
              {(id) => (
                <Input
                  id={id}
                  ref={cashRef}
                  inputMode="decimal"
                  className="num"
                  style={{ fontSize: 22, height: 48 }}
                  value={cashText}
                  onChange={(e) => setCashText(e.target.value)}
                  aria-invalid={cashCents === null}
                />
              )}
            </Field>
          </>
        )}
        {method !== 'cash' && (
          <div className="grid grid--2">
            {method === 'split' && (
              <Field label={t('pos.card')}>
                {(id) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    className="num"
                    value={cardText}
                    onChange={(e) => setCardText(e.target.value)}
                    aria-invalid={cardCents === null || cardOver}
                  />
                )}
              </Field>
            )}
            <Field label={t('pos.reference')} optional>
              {(id) => (
                <Input
                  id={id}
                  value={reference}
                  maxLength={80}
                  onChange={(e) => setReference(e.target.value)}
                />
              )}
            </Field>
          </div>
        )}
        {cardOver && <Alert tone="danger">{t('pos.cardOver')}</Alert>}
        {!covered && !cardOver && paid > 0 && (
          <div className="row row--between">
            <span className="muted">{t('pos.remaining')}</span>
            <strong className="num">{fmt.money(totalCents - paid)}</strong>
          </div>
        )}
        {covered && (
          <div className="pos__change">
            <span>{t('pos.change')}</span>
            <strong className="num">{fmt.money(change)}</strong>
          </div>
        )}
      </div>
    </Dialog>
  );
}
