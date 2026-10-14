/**
 * Point of sale. Keyboard-first and Enter-driven: scan or tap the products, **Enter** opens the
 * payment, **Enter** completes it (the exact amount is pre-filled, a tendered amount can be typed
 * or tapped), Enter / auto-finish starts the next sale. F2 focuses the search/scan field, F4
 * starts a new sale, Esc closes dialogs (F6 / F8 still work as silent aliases for old habits).
 * USB barcode scanners act as keyboards — a fast burst ending in Enter is picked up anywhere on
 * the page (`useBarcodeScanner`), whatever has the focus, and is never mistaken for the Enter
 * that opens the payment; slower typing in the search field searches by name.
 *
 * After a payment the "sale completed" screen shows the change due with Print / Finish and starts
 * the next sale by itself after `pos.auto_finish_seconds`; printing is on demand unless
 * `pos.auto_print_receipt` is on. Tenders come from the shared `TenderPanel`: cash only unless
 * `pos.card_payments` is on; "pay later" (a customer debt with a due date) when the cashier's role
 * has `debts.give` and a customer is attached to the sale (a new customer can be added inline by name).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Banknote,
  Minus,
  PauseCircle,
  Plus,
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
  type SettingsMap,
  type ReceiptData,
  type SaleDetail,
  type SalesListResponse,
} from '@likapcs/shared';
import { api, ApiError, fileUrl } from '../lib/api';
import {
  addToCart,
  cartItemCount,
  cartToRequest,
  cartTotals,
  emptyCart,
  removeLine,
  setLineDiscount,
  setQuantity,
  type Cart,
  unitPriceOf,
} from '../lib/cart';
import { useFormat } from '../lib/format';
import { isEditableElement, useBarcodeScanner } from '../lib/scanner';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import { useShiftGuard } from '../state/shift-guard';
import { usePosCart } from '../state/pos-cart';
import { displayCustomerOf, useCustomerDisplay } from '../state/customer-display';
import { useAppSettings } from '../state/app-settings';
import { SaleDoneDialog } from '../components/pos/SaleDoneDialog';
import { CustomerPicker } from '../components/customers/CustomerPicker';
import { TenderPanel, useTender } from '../components/payments/TenderPanel';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Kbd,
  Loading,
} from '../components/ui/primitives';

export function PosPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const display = useCustomerDisplay();
  const walletEnabled = useAppSettings()['wallet.enabled'];
  const [params, setParams] = useSearchParams();
  const canDiscount = can(PERMISSIONS.POS_DISCOUNT);
  const canSuspend = can(PERMISSIONS.POS_SUSPEND);

  // The draft sale lives in PosCartProvider so it survives switching pages (F9 Stations ↔ POS).
  const {
    cart,
    setCart,
    customer,
    setCustomer,
    resumedId,
    setResumedId,
    categoryId,
    setCategoryId,
  } = usePosCart();
  const [search, setSearch] = useState('');
  // The tile grid filters on a debounced copy so scanner key bursts don't trigger a query per key.
  const [gridSearch, setGridSearch] = useState('');
  const [dialog, setDialog] = useState<'payment' | 'confirmNew' | 'suspended' | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Keep the scan field focused whenever nothing else needs the keyboard, so the next scan (or
  // typed code) always has somewhere to go. Deferred: dialogs are still unmounting when called.
  const focusSearch = useCallback(() => {
    window.requestAnimationFrame(() => {
      const el = searchRef.current;
      if (el && document.activeElement !== el) el.focus();
    });
  }, []);

  const categories = useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: () => api<CategorySummary[]>('/catalog/categories'),
    staleTime: 60_000,
  });
  useEffect(() => {
    const h = setTimeout(() => setGridSearch(search.trim()), 180);
    return () => clearTimeout(h);
  }, [search]);
  const settings = useQuery({
    queryKey: ['settings', 'all'],
    queryFn: () => api<SettingsMap>('/settings'),
    staleTime: 60_000,
  });
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
    focusSearch();
  }, [focusSearch, setCart, setCustomer, setResumedId]);

  const add = useCallback(
    (product: ProductSummary, quantityMilli = 1000) => {
      if (!product.isActive) return;
      setCart((c) => addToCart(c, product, quantityMilli));
      focusSearch();
    },
    [focusSearch, setCart],
  );

  // Leaving the "sale completed" screen: refresh what the sale changed (stock on the tiles, the
  // sales list, dashboard and cash figures) only now, so the screen itself appears instantly.
  const finishSale = useCallback(() => {
    setReceipt(null);
    resetCart();
    void queryClient.invalidateQueries({ queryKey: ['products'] });
    void queryClient.invalidateQueries({ queryKey: ['sales'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ['cash'] });
  }, [queryClient, resetCart]);

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

  // Scans are caught page-wide, whatever has the focus. A scan on the "sale completed" screen
  // starts the next sale with that product; a scan while a dialog asks a question dismisses it;
  // a scan during payment adds the product (the total in the payment dialog follows the cart).
  const onScan = useCallback(
    (code: string) => {
      if (receipt) finishSale();
      else if (dialog === 'confirmNew' || dialog === 'suspended') setDialog(null);
      lookup.mutate(code);
    },
    [receipt, dialog, finishSale, lookup],
  );
  useBarcodeScanner({ onScan, focusTarget: searchRef });

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
  }, [params, setParams, setCart, setCustomer, setResumedId]);

  // Global shortcuts. Enter opens the payment from anywhere on the page: a scanner burst never
  // gets here (`useBarcodeScanner` swallows it first), text typed into a field keeps its own
  // Enter (search looks the code up, a quantity field commits), and dialogs handle theirs.
  // Capture phase, so a focused product tile is not "clicked" again by the same Enter.
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
      } else if (e.key === 'Enter' || e.key === 'F6') {
        if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
        const target = e.target instanceof Element ? e.target : null;
        if (target?.closest('[role="dialog"]')) return;
        if (e.key === 'Enter' && isEditableElement(target)) {
          const value = 'value' in target ? String((target as HTMLInputElement).value) : '';
          if (value.trim()) return;
        }
        e.preventDefault();
        if (cart.lines.length && !receipt && !dialog) {
          // The payment dialog mounts synchronously (discrete event): stop the same Enter from
          // reaching its own listener and completing the sale in one go.
          e.stopPropagation();
          setDialog('payment');
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [cart.lines.length, receipt, dialog, resetCart]);

  // Typed text confirmed with Enter (scanner bursts never get here — `useBarcodeScanner` takes
  // them first): a code is looked up exactly, otherwise the single visible match is added.
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = search.trim();
    if (!code) return;
    if (/^[A-Za-z0-9._-]{3,64}$/.test(code)) {
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

  // 0.18.0: the grid can hide sold-out products (Settings → POS); a barcode scan still adds one
  // (the server decides at payment time), the grid is only the browsing surface.
  const hideOut = settings.data?.['pos.hide_out_of_stock'] ?? true;
  const list = useMemo(() => {
    const items = products.data?.items ?? [];
    return hideOut
      ? items.filter((p) => !(p.trackStock && !p.allowNegativeStock && p.stockMilli <= 0))
      : items;
  }, [products.data, hideOut]);

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
                <div className="tile__head">
                  {p.imageUrl && (
                    <div className="tile__image" aria-hidden>
                      <img src={fileUrl(p.imageUrl) ?? undefined} alt="" loading="lazy" />
                    </div>
                  )}
                  <div className="tile__name" title={p.name}>
                    {p.name}
                  </div>
                </div>
                <div className="tile__meta">
                  {p.promoPriceCents !== null && p.promoPriceCents < p.sellingPriceCents ? (
                    <span className="num tile__promo" data-testid="tile-promo">
                      <s className="faint">{fmt.money(p.sellingPriceCents)}</s>{' '}
                      <strong className="text-success">{fmt.money(p.promoPriceCents)}</strong>
                    </span>
                  ) : (
                    <span className="num">{fmt.money(p.sellingPriceCents)}</span>
                  )}
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
                    {fmt.money(unitPriceOf(line.product))} × {line.quantityMilli / 1000}
                    {unitPriceOf(line.product) < line.product.sellingPriceCents && (
                      <span className="text-success"> · {t('pos.promo')}</span>
                    )}
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
                  <QtyInput
                    quantityMilli={line.quantityMilli}
                    label={t('pos.qty')}
                    onCommit={(milli) => {
                      setCart((c) => setQuantity(c, line.product.id, milli));
                      focusSearch();
                    }}
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
            <Banknote size={16} /> {t('pos.pay')} <Kbd>Enter</Kbd>
          </Button>
        </div>
        <div className="pos__hint faint">{t('pos.shortcuts')}</div>
      </aside>

      {dialog === 'payment' && (
        <PaymentDialog
          cart={cart}
          resumedId={resumedId}
          totalCents={totals.totalCents}
          customer={customer}
          onCustomerChange={(c) => {
            setCustomer(c);
            setCart((prev) => ({ ...prev, customerId: c?.id ?? null }));
          }}
          onClose={() => {
            setDialog(null);
            focusSearch();
          }}
          onCompleted={(sale, receiptData) => {
            setDialog(null);
            setReceipt(receiptData);
            // Customer display: "thank you" with what was paid / put on the tab.
            const paymentsNow = sale.payments.filter((p) => p.kind === 'sale');
            const creditCents = paymentsNow
              .filter((p) => p.method === 'credit')
              .reduce((a, p) => a + p.amountCents, 0);
            const walletCents = paymentsNow
              .filter((p) => p.method === 'wallet')
              .reduce((a, p) => a + p.amountCents, 0);
            const after = customer
              ? {
                  ...customer,
                  balanceDueCents: customer.balanceDueCents + creditCents,
                  walletBalanceCents: customer.walletBalanceCents - walletCents,
                }
              : null;
            display.setDone({
              receiptNo: sale.receiptNo,
              totalCents: sale.totalCents,
              paidCents: sale.paidCents - creditCents,
              changeCents: sale.changeCents,
              creditCents,
              customer: displayCustomerOf(after, walletEnabled),
            });
          }}
        />
      )}
      <ConfirmDialog
        open={dialog === 'confirmNew'}
        onClose={() => {
          setDialog(null);
          focusSearch();
        }}
        onConfirm={resetCart}
        title={t('pos.newSale')}
        body={t('pos.newSaleConfirm')}
        confirmLabel={t('pos.newSale')}
        danger
      />
      {dialog === 'suspended' && (
        <Dialog
          open
          onClose={() => {
            setDialog(null);
            focusSearch();
          }}
          title={t('pos.suspended')}
          size="md"
        >
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
      {receipt && <SaleDoneDialog receipt={receipt} onFinish={finishSale} />}
    </div>
  );
}

// ─── Quantity field ────────────────────────────────────────────────────────────
/**
 * Edits the line quantity locally and commits on Enter / blur. Committing per keystroke made
 * "0.5" impossible to type (the "0." step was rounded to 0 and the line vanished) and turned a
 * scanner burst that landed in the field into an absurd quantity.
 */
function QtyInput({
  quantityMilli,
  label,
  onCommit,
}: {
  quantityMilli: number;
  label: string;
  onCommit: (quantityMilli: number) => void;
}) {
  const shown = String(quantityMilli / 1000);
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(shown);
  }, [shown, editing]);
  const commit = () => {
    setEditing(false);
    const q = Number(text.replace(',', '.'));
    if (text.trim() && Number.isFinite(q) && q >= 0 && q <= 1_000_000) {
      const milli = Math.round(q * 1000);
      if (milli !== quantityMilli) onCommit(milli);
    } else setText(shown);
  };
  return (
    <input
      className="input pos-line__qty-input num"
      inputMode="decimal"
      value={text}
      onFocus={(e) => {
        setEditing(true);
        e.currentTarget.select();
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          setText(shown);
          setEditing(false);
        }
      }}
      aria-label={label}
    />
  );
}

// ─── Payment dialog ────────────────────────────────────────────────────────────
function PaymentDialog({
  cart,
  resumedId,
  totalCents,
  customer,
  onCustomerChange,
  onClose,
  onCompleted,
}: {
  cart: Cart;
  resumedId: string | null;
  totalCents: number;
  customer: CustomerSummary | null;
  /** "Pay later" needs a customer; picking one here attaches it to the sale as well. */
  onCustomerChange: (customer: CustomerSummary | null) => void;
  onClose: () => void;
  onCompleted: (sale: SaleDetail, receipt: ReceiptData) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const shiftGuard = useShiftGuard();
  const tender = useTender({ totalCents, customer });
  const display = useCustomerDisplay();

  // Customer display: what is being counted, live (cleared when the dialog closes).
  const { mode, paidCents, cashCents, walletCents, creditCents, changeCents, covered } = tender;
  useEffect(() => {
    display.setTender({
      mode,
      paidCents,
      cashCents: cashCents ?? 0,
      walletCents: walletCents ?? 0,
      creditCents,
      changeCents: covered ? changeCents : paidCents - totalCents,
      covered,
    });
  }, [
    display,
    mode,
    paidCents,
    cashCents,
    walletCents,
    creditCents,
    changeCents,
    covered,
    totalCents,
  ]);
  useEffect(() => () => display.setTender(null), [display]);

  const complete = useMutation({
    mutationFn: async () => {
      const body = { ...cartToRequest(cart), payments: tender.payments };
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
  const submit = () => {
    if (tender.covered && !complete.isPending) complete.mutate();
  };

  // Enter completes from anywhere in the dialog (a tapped chip, the method row); the tendered
  // field handles its own Enter. F8 stays as a silent alias. Key events older than the dialog
  // (the Enter that opened it) are ignored.
  const openedAt = useRef(performance.now());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.timeStamp <= openedAt.current) return;
      if (
        e.key === 'F8' ||
        (e.key === 'Enter' && !e.repeat && !isEditableElement(e.target as Element))
      ) {
        e.preventDefault();
        submit();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

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
            disabled={!tender.covered}
            loading={complete.isPending}
            onClick={submit}
            data-testid="pos-complete"
          >
            {tender.mode === 'credit' && tender.creditCents > 0
              ? t('pos.completeOnTab')
              : t('pos.complete')}{' '}
            <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <TenderPanel tender={tender} onSubmit={submit} onCustomerChange={onCustomerChange} />
    </Dialog>
  );
}
