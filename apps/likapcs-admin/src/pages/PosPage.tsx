/**
 * Point of sale. Keyboard-first: F2 search/scan field, F4 new sale, F6 payment, F8 / Enter
 * complete, Esc closes dialogs. USB barcode scanners act as keyboards — a fast burst ending in
 * Enter is picked up anywhere on the page (`useBarcodeScanner`), whatever has the focus; slower
 * typing in the search field searches by name.
 *
 * After a payment the "sale completed" screen shows the change due with Print / Finish and starts
 * the next sale by itself after `pos.auto_finish_seconds`; printing is on demand unless
 * `pos.auto_print_receipt` is on. Payment is cash only unless `pos.card_payments` is enabled.
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
} from '../lib/cart';
import { useFormat } from '../lib/format';
import { useBarcodeScanner } from '../lib/scanner';
import { useI18n } from '../i18n';
import { useAppSettings } from '../state/app-settings';
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
/** A tendered amount this far above the total is a mistyped/scanned code, not money. */
const MAX_OVERPAY_CENTS = 100_000_00;

export function PosPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const settings = useAppSettings();
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
  }, [focusSearch]);

  const add = useCallback(
    (product: ProductSummary, quantityMilli = 1000) => {
      if (!product.isActive) return;
      setCart((c) => addToCart(c, product, quantityMilli));
      focusSearch();
    },
    [focusSearch],
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
        if (cart.lines.length && !receipt && !dialog) setDialog('payment');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
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
                {p.imageUrl && (
                  <div className="tile__image" aria-hidden>
                    <img src={fileUrl(p.imageUrl) ?? undefined} alt="" loading="lazy" />
                  </div>
                )}
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
          cardEnabled={settings['pos.card_payments']}
          onClose={() => {
            setDialog(null);
            focusSearch();
          }}
          onCompleted={(_sale, receiptData) => {
            setDialog(null);
            setReceipt(receiptData);
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

// ─── Sale completed ────────────────────────────────────────────────────────────
/**
 * Shown the moment the sale is saved: the change due in large type, the receipt preview, and
 * Print / Finish. Finishing happens by itself after `autoFinishSeconds` (Settings › Printing;
 * 0 waits for the cashier); pressing Print stops the countdown so the print dialog is never
 * pulled away. Enter / Esc finish, P prints, scanning the next product finishes and starts the
 * next sale with it (handled by the page's scanner hook).
 */
function SaleDoneDialog({ receipt, onFinish }: { receipt: ReceiptData; onFinish: () => void }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const seconds = Math.max(0, Math.floor(receipt.autoFinishSeconds));
  const [remaining, setRemaining] = useState(seconds);
  const [counting, setCounting] = useState(seconds > 0);
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;

  const print = useCallback(() => {
    setCounting(false);
    printReceipt();
  }, []);

  // Settings › Printing › "Print receipt automatically" — the countdown keeps running: the print
  // dialog blocks the page while it is up, so the remaining seconds elapse after it closes.
  useEffect(() => {
    if (!receipt.autoPrint) return;
    const h = window.setTimeout(() => printReceipt(), 150);
    return () => window.clearTimeout(h);
  }, [receipt.autoPrint]);

  useEffect(() => {
    if (!counting) return;
    const h = window.setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          window.clearInterval(h);
          window.setTimeout(() => onFinishRef.current(), 0);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => window.clearInterval(h);
  }, [counting]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // `repeat`: the Enter that completed the payment may still be held down when this mounts.
      if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        onFinishRef.current();
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        print();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [print]);

  const { sale } = receipt;
  const tendered = sale.payments
    .filter((p) => p.kind === 'sale')
    .reduce((a, p) => a + p.amountCents, 0);
  return (
    <Dialog
      open
      onClose={onFinish}
      title={t('pos.doneTitle')}
      description={sale.receiptNo ?? undefined}
      size="sm"
      footer={
        <>
          <Button onClick={print}>
            <Printer size={14} /> {t('pos.print')} <Kbd>P</Kbd>
          </Button>
          <Button variant="primary" size="lg" onClick={onFinish} data-testid="pos-finish">
            {counting ? t('pos.finishCountdown', { s: remaining }) : t('pos.finish')}{' '}
            <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="pos-done">
          <div className="pos-done__row">
            <span>{t('pos.total')}</span>
            <span className="num">{fmt.money(sale.totalCents)}</span>
          </div>
          <div className="pos-done__row">
            <span>{t('pos.paid')}</span>
            <span className="num">{fmt.money(tendered)}</span>
          </div>
          <div className="pos-done__change" data-testid="pos-change">
            <span>{t('pos.change')}</span>
            <strong className="num">{fmt.money(sale.changeCents)}</strong>
          </div>
        </div>
        <p className="faint pos-done__hint">
          {counting ? t('pos.autoFinishHint', { s: remaining }) : t('pos.finishHint')}
        </p>
        <div className="pos-done__receipt">
          <Receipt data={receipt} />
        </div>
      </div>
    </Dialog>
  );
}

// ─── Payment dialog ────────────────────────────────────────────────────────────
function PaymentDialog({
  cart,
  resumedId,
  totalCents,
  cardEnabled,
  onClose,
  onCompleted,
}: {
  cart: Cart;
  resumedId: string | null;
  totalCents: number;
  /** `pos.card_payments` — off: cash only, no method choice at all. */
  cardEnabled: boolean;
  onClose: () => void;
  onCompleted: (sale: SaleDetail, receipt: ReceiptData) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const shiftGuard = useShiftGuard();
  // Pre-filled with the exact amount (selected on focus, so typing replaces it): an exact cash
  // sale is F6 → Enter.
  const [cashText, setCashText] = useState((totalCents / 100).toFixed(2));
  const [cardText, setCardText] = useState('');
  const [reference, setReference] = useState('');
  const [method, setMethod] = useState<'cash' | 'card' | 'split'>('cash');
  const cashRef = useRef<HTMLInputElement>(null);
  const effectiveMethod = cardEnabled ? method : 'cash';

  const cashCents = cashText.trim() ? parseMoneyInput(cashText) : 0;
  const cardCents = cardText.trim() ? parseMoneyInput(cardText) : 0;
  const payments: SalePaymentInput[] = [];
  if (effectiveMethod === 'card')
    payments.push({ method: 'card', amountCents: totalCents, reference: reference || undefined });
  else {
    if (effectiveMethod === 'split' && cardCents && cardCents > 0)
      payments.push({ method: 'card', amountCents: cardCents, reference: reference || undefined });
    if (cashCents && cashCents > 0) payments.push({ method: 'cash', amountCents: cashCents });
  }
  const paid = payments.reduce((a, p) => a + p.amountCents, 0);
  const nonCash = payments
    .filter((p) => p.method !== 'cash')
    .reduce((a, p) => a + p.amountCents, 0);
  const cardOver = nonCash > totalCents;
  // A number far above the total is a barcode that landed in the field, not money.
  const implausible = paid > totalCents + MAX_OVERPAY_CENTS;
  const covered =
    paid >= totalCents && !cardOver && !implausible && cashCents !== null && cardCents !== null;
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
  const submit = () => {
    if (covered && !complete.isPending) complete.mutate();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F8') {
        e.preventDefault();
        submit();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    cashRef.current?.focus();
    cashRef.current?.select();
  }, [effectiveMethod]);

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
            onClick={submit}
            data-testid="pos-complete"
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
        {cardEnabled && (
          <div className="chips" data-testid="pos-methods">
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
        )}
        {effectiveMethod !== 'card' && (
          <>
            <div className="chips">
              <button
                type="button"
                className="chip"
                onClick={() => {
                  setCashText(
                    (
                      Math.max(
                        0,
                        totalCents - (effectiveMethod === 'split' ? (cardCents ?? 0) : 0),
                      ) / 100
                    ).toFixed(2),
                  );
                  cashRef.current?.focus();
                }}
              >
                {t('pos.exact')}
              </button>
              {QUICK_CASH.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="chip"
                  onClick={() => {
                    setCashText((c / 100).toFixed(2));
                    cashRef.current?.focus();
                  }}
                >
                  {fmt.money(c)}
                </button>
              ))}
            </div>
            <Field label={t('pos.tendered')} hint={t('pos.tenderedHint')}>
              {(id) => (
                <Input
                  id={id}
                  ref={cashRef}
                  inputMode="decimal"
                  className="num"
                  style={{ fontSize: 22, height: 48 }}
                  value={cashText}
                  onChange={(e) => setCashText(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  aria-invalid={cashCents === null || implausible}
                  data-testid="pos-tendered"
                />
              )}
            </Field>
          </>
        )}
        {effectiveMethod !== 'cash' && (
          <div className="grid grid--2">
            {effectiveMethod === 'split' && (
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
        {implausible && <Alert tone="danger">{t('pos.implausibleAmount')}</Alert>}
        {!covered && !cardOver && !implausible && paid > 0 && (
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
