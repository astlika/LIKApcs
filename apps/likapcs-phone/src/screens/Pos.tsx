import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS, type CategorySummary, type CustomerSummary, type Paginated, type ProductAddonSummary, type ProductLookupResponse, type ProductSummary, type SaleDetail, type SalePaymentMethod, type SalesListResponse } from '@likapcs/shared';
import { api, errorText, money, newRequestId, parseEuroToCents, shortDate } from '../api';
import { can, useMe } from '../me';
import { METHOD_LABEL } from '../labels';
import { useLive } from '../useLive';
import { useNotify } from '../notify';
import { useT } from '../i18n';
import { useOnline } from '../useOnline';
import { Btn, Choices, Empty, EuroInput, Loading, Notice, QueryError, Sheet, cx } from '../components/ui';
import { PaymentPanel, centsText, newPaymentLine, summarizePayment, type PaymentLine } from '../components/PaymentPanel';
import { CustomerPicker } from '../components/CustomerPicker';
import { useDebounced } from '../useDebounced';

/** One line of the cart: a product with the extras chosen for it. The same product with other extras is another line. */
interface CartLine {
  key: string;
  product: ProductSummary;
  addons: ProductAddonSummary[];
  qty: number;
}

const unitPrice = (p: ProductSummary, addons: ProductAddonSummary[] = []): number =>
  (p.promoPriceCents ?? p.sellingPriceCents) + addons.reduce((sum, a) => sum + a.priceCents, 0);

const lineKey = (p: ProductSummary, addons: ProductAddonSummary[]): string =>
  [p.id, ...addons.map((a) => a.id).sort()].join('|');

/** A product can be sold from the phone when it is in stock (tracked stock never goes negative here). */
function inStock(p: ProductSummary): boolean {
  return !(p.trackStock && !p.allowNegativeStock && p.stockMilli <= 0);
}

const FAV_KEY = 'likapcs-phone-favs';
function useFavs(): [Set<string>, (id: string) => void] {
  const [favs, setFavs] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]') as string[]);
    } catch {
      return new Set<string>();
    }
  });
  const toggle = (id: string) =>
    setFavs((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(FAV_KEY, JSON.stringify([...next]));
      } catch {
        // Private mode: the favourites last for this visit only.
      }
      return next;
    });
  return [favs, toggle];
}

/** Point of sale: pick products (with extras when they have them), check the cart, take the money. Online only. */
export function Pos() {
  const notify = useNotify();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 250);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [cartOpen, setCartOpen] = useState(false);
  const [extrasFor, setExtrasFor] = useState<ProductSummary | null>(null);
  const [favOnly, setFavOnly] = useState(false);
  const [resume, setResume] = useState<ResumeState | null>(null);
  const [suspendedOpen, setSuspendedOpen] = useState(false);
  const suspendedList = useLive(['suspended'], () => api<SalesListResponse>('/sales?status=suspended&pageSize=50'));
  const suspendedCount = suspendedList.data?.total ?? 0;
  const [favs, toggleFav] = useFavs();
  const me = useMe(true);
  const canDiscount = can(me.data, PERMISSIONS.POS_DISCOUNT);

  const categories = useLive(['categories'], () => api<CategorySummary[]>('/catalog/categories'));
  const products = useLive(['products', q, categoryId], () => {
    const params = new URLSearchParams({ active: 'active', pageSize: '200' });
    if (q) params.set('q', q);
    if (categoryId) params.set('categoryId', categoryId);
    return api<Paginated<ProductSummary>>(`/products?${params.toString()}`);
  });

  const lines = Object.values(cart);
  const count = lines.reduce((sum, l) => sum + l.qty, 0);
  const total = lines.reduce((sum, l) => sum + unitPrice(l.product, l.addons) * l.qty, 0);

  const addLine = (p: ProductSummary, addons: ProductAddonSummary[]) => {
    const key = lineKey(p, addons);
    setCart((c) => {
      const cur = c[key];
      return { ...c, [key]: { key, product: p, addons, qty: (cur?.qty ?? 0) + 1 } };
    });
  };
  const setQty = (key: string, qty: number) => {
    setCart((c) => {
      const next = { ...c };
      if (qty <= 0) delete next[key];
      else next[key] = { ...c[key]!, qty };
      return next;
    });
  };

  /** Opens a suspended sale: its lines go back into the cart, and paying it completes that same sale. */
  const resumeSale = async (id: string) => {
    if (lines.length > 0) {
      notify('Pezulloni ose përfundoni shportën aktuale para se të hapni një shitje.', 'err');
      return;
    }
    try {
      const sale = await api<SaleDetail>(`/sales/${id}`);
      if (sale.items.some((i) => !i.productId)) throw new Error('Kjo shitje ka rreshta që nuk hapen nga telefoni (p.sh. kohë PC).');
      if (sale.items.some((i) => i.discountCents > 0)) throw new Error('Kjo shitje ka zbritje për produkt. Hapeni nga desktopi.');
      if (sale.discountCents > 0 && !canDiscount) throw new Error('Kjo shitje ka zbritje. Nuk keni leje ta hapni nga telefoni.');
      const next: Record<string, CartLine> = {};
      for (const item of sale.items) {
        if (!item.productId || item.quantityMilli % 1000 !== 0) throw new Error('Sasia e një rreshti nuk mund të hapet nga telefoni.');
        const product = await api<ProductSummary>(`/products/${item.productId}`);
        const addons = product.addons.filter((a) => item.addonIds.includes(a.id));
        if (addons.length !== item.addonIds.length) throw new Error(`Opsionet e ${product.name} nuk gjenden më.`);
        const key = lineKey(product, addons);
        next[key] = { key, product, addons, qty: (next[key]?.qty ?? 0) + item.quantityMilli / 1000 };
      }
      const customer = sale.customerId ? await api<CustomerSummary>(`/customers/${sale.customerId}`) : null;
      setCart(next);
      setResume({ id, receiptNo: sale.receiptNo, discountCents: sale.discountCents, customer });
      setSuspendedOpen(false);
      setCartOpen(true);
    } catch (err) {
      notify(err instanceof Error ? err.message : errorText(err), 'err');
    }
  };

  const cats = categories.data?.filter((c) => c.isActive) ?? [];
  // Products with no stock left are not shown at all (the till only offers what can be sold).
  const sellable = (products.data?.items ?? []).filter(inStock).filter((p) => !favOnly || favs.has(p.id));

  // A barcode typed or scanned into the search box (Enter) adds the product straight to the cart.
  const scanCode = async () => {
    const code = search.trim();
    if (!code) return;
    try {
      const res = await api<ProductLookupResponse>(`/products/lookup?${new URLSearchParams({ code }).toString()}`);
      if (!inStock(res.product)) {
        notify('Ky produkt nuk ka stok.', 'err');
        return;
      }
      if (res.product.addons.length > 0) setExtrasFor(res.product);
      else addLine(res.product, []);
      setSearch('');
    } catch {
      // Not a barcode: the text stays in the search box and filters the list.
    }
  };
  const inCartCount = (p: ProductSummary) => lines.filter((l) => l.product.id === p.id).reduce((sum, l) => sum + l.qty, 0);

  return (
    <div className="stack pos">
      <div className="page-head">
        <h1>Shitje</h1>
        {suspendedCount > 0 && (
          <button type="button" className="ghost small-btn" onClick={() => setSuspendedOpen(true)}>
            Pezulluara ({suspendedCount})
          </button>
        )}
      </div>

      <input
        className="search"
        type="search"
        placeholder="Kërko produkt…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void scanCode();
          }
        }}
        aria-label="Kërko produkt ose skano barkodin"
      />

      {cats.length > 0 && (
        <div className="chips" role="group" aria-label="Kategoritë">
          <button type="button" className={cx('chip', categoryId === null && 'chip--on')} onClick={() => setCategoryId(null)}>
            Të gjitha
          </button>
          <button type="button" className={cx('chip', favOnly && 'chip--on')} aria-pressed={favOnly} onClick={() => setFavOnly((v) => !v)}>
            ★ Të preferuarat
          </button>
          {cats.map((c) => (
            <button
              key={c.id}
              type="button"
              className={cx('chip', categoryId === c.id && 'chip--on')}
              aria-pressed={categoryId === c.id}
              onClick={() => setCategoryId(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {products.isLoading && <Loading />}
      {products.error && <QueryError message="Produktet nuk u ngarkuan." onRetry={() => void products.refetch()} />}
      {products.data && sellable.length === 0 && <Empty>Nuk ka produkte për këtë kërkim.</Empty>}

      {products.data && sellable.length > 0 && (
        <ul className="tiles">
          {sellable.map((p) => {
            const inCart = inCartCount(p);
            const hasExtras = p.addons.length > 0;
            return (
              <li key={p.id} className="tile-wrap">
                <button
                  type="button"
                  className={cx('tile', inCart > 0 && 'tile--in')}
                  onClick={() => (hasExtras ? setExtrasFor(p) : addLine(p, []))}
                  aria-label={`${p.name}, ${money(unitPrice(p))}`}
                >
                  {inCart > 0 && <span className="tile__count">{inCart}</span>}
                  <span className="tile__name">{p.name}</span>
                  <span className="tile__price">{money(unitPrice(p))}</span>
                  {hasExtras && <span className="tile__note">Me opsione</span>}
                </button>
                <button
                  type="button"
                  className={cx('fav-btn', favs.has(p.id) && 'fav-btn--on')}
                  aria-pressed={favs.has(p.id)}
                  aria-label={favs.has(p.id) ? `Hiqe ${p.name} nga të preferuarat` : `Shto ${p.name} te të preferuarat`}
                  onClick={() => toggleFav(p.id)}
                >
                  ★
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {count > 0 && (
        <div className="cart-bar">
          <button type="button" className="cart-bar__btn" onClick={() => setCartOpen(true)}>
            <span>
              Shporta · {count} {count === 1 ? 'artikull' : 'artikuj'}
            </span>
            <strong>{money(total)}</strong>
          </button>
        </div>
      )}

      {extrasFor && (
        <ExtrasSheet
          product={extrasFor}
          onClose={() => setExtrasFor(null)}
          onAdd={(addons) => {
            addLine(extrasFor, addons);
            setExtrasFor(null);
          }}
        />
      )}

      {suspendedOpen && (
        <SuspendedSheet
          sales={suspendedList.data?.items ?? []}
          onResume={(id) => void resumeSale(id)}
          onClose={() => setSuspendedOpen(false)}
        />
      )}

      {cartOpen && (
        <CartSheet
          resume={resume}
          onVoidResume={() => {
            setCart({});
            setResume(null);
            setCartOpen(false);
          }}
          lines={lines}
          total={total}
          onQty={setQty}
          canDiscount={canDiscount}
          onClose={() => setCartOpen(false)}
          onSold={(receipt) => {
            setCart({});
            setResume(null);
            setCartOpen(false);
            notify(receipt ? `Shitja u regjistrua · ${receipt}` : 'Shitja u regjistrua.');
          }}
          onSuspended={(ref) => {
            setCart({});
            setResume(null);
            setCartOpen(false);
            notify(`Shitja u pezullua${ref ? ` · ${ref}` : ''}.`);
          }}
        />
      )}
    </div>
  );
}

/** Choose the extras for one product (any number, or none), then add it to the cart. */
function ExtrasSheet({
  product,
  onClose,
  onAdd,
}: {
  product: ProductSummary;
  onClose: () => void;
  onAdd: (addons: ProductAddonSummary[]) => void;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const addons = product.addons;
  const picked = addons.filter((a) => chosen.includes(a.id));
  const price = unitPrice(product, picked);

  return (
    <Sheet
      title={product.name}
      onClose={onClose}
      footer={<Btn block onClick={() => onAdd(picked)}>{`Shto në shportë · ${money(price)}`}</Btn>}
    >
      <p className="muted small">Zgjidhni opsionet (nëse dëshironi). Çmimi shtohet te produkti.</p>
      <ul className="extra-list" role="group" aria-label="Opsionet">
        <li>
          <button type="button" className={cx('extra-item', chosen.length === 0 && 'extra-item--on')} aria-pressed={chosen.length === 0} onClick={() => setChosen([])}>
            <strong>Pa opsione</strong>
            <span className="extra-item__price">{money(unitPrice(product))}</span>
          </button>
        </li>
        {addons.map((a) => {
          const on = chosen.includes(a.id);
          return (
            <li key={a.id}>
              <button
                type="button"
                className={cx('extra-item', on && 'extra-item--on')}
                aria-pressed={on}
                onClick={() => setChosen((c) => (on ? c.filter((x) => x !== a.id) : [...c, a.id]))}
              >
                <span className={cx('check', on && 'check--on')} aria-hidden="true">{on ? '✓' : ''}</span>
                <strong>{a.name}</strong>
                <span className="extra-item__price">+{money(a.priceCents)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

function CartSheet({
  lines,
  total: subtotal,
  onQty,
  canDiscount,
  resume,
  onVoidResume,
  onClose,
  onSold,
  onSuspended,
}: {
  lines: CartLine[];
  total: number;
  onQty: (key: string, qty: number) => void;
  canDiscount: boolean;
  resume: ResumeState | null;
  onVoidResume: () => void;
  onClose: () => void;
  onSold: (receipt: string | null) => void;
  onSuspended: (ref: string | null) => void;
}) {
  const online = useOnline();
  const qc = useQueryClient();
  const notify = useNotify();
  const requestId = useState(newRequestId)[0];
  const [customer, setCustomer] = useState<CustomerSummary | null>(resume?.customer ?? null);
  const t = useT();
  const [payLines, setPayLines] = useState<PaymentLine[]>(() => [newPaymentLine('cash')]);
  const [discountText, setDiscountText] = useState(resume && resume.discountCents > 0 ? centsText(resume.discountCents) : '');
  const discount = canDiscount ? (parseEuroToCents(discountText) ?? 0) : 0;
  const discountBad = discount < 0 || discount > subtotal;
  const total = Math.max(0, subtotal - discount);

  const pay = summarizePayment(payLines, total);
  const creditNeedsCustomer = payLines.some((l) => l.method === 'credit') && !customer;
  const canFinish = lines.length > 0 && (total === 0 || pay.remaining === 0) && !pay.nonCashTooHigh;

  // While the only line was never typed by hand, it follows the total (after items and discount).
  useEffect(() => {
    setPayLines((prev) =>
      prev.length === 1 && prev[0]!.method === 'cash' && !prev[0]!.touched ? [{ ...prev[0]!, text: centsText(total) }] : prev,
    );
  }, [total]);

  const saleBody = () => ({
    items: lines.map((l) => ({
      productId: l.product.id,
      quantityMilli: l.qty * 1000,
      discountCents: 0,
      addonIds: l.addons.map((a) => a.id),
    })),
    discountCents: discount,
    customerId: customer?.id ?? null,
    clientRequestId: requestId,
  });

  // Keeps the sale open (e.g. the customer is coming back); it is not paid or counted yet.
  const suspend = useMutation({
    mutationFn: () => api<{ id?: string; receiptNo?: string | null }>('/sales/suspend', { method: 'POST', body: saleBody() }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['phone', 'products'] });
      void qc.invalidateQueries({ queryKey: ['phone', 'suspended'] });
      onSuspended(res.receiptNo ?? null);
    },
  });

  // A suspended sale that was opened again is completed in place (same sale number), not copied.
  const sell = useMutation({
    mutationFn: () =>
      api<{ sale?: { receiptNo?: string | null }; receiptNo?: string | null }>(
        resume ? `/sales/${resume.id}/complete` : '/sales',
        {
          method: 'POST',
          body: {
            ...saleBody(),
            payments: total === 0 ? [] : pay.payments,
            staff: false,
          },
        },
      ),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['phone', 'products'] });
      void qc.invalidateQueries({ queryKey: ['phone', 'debts'] });
      void qc.invalidateQueries({ queryKey: ['phone', 'suspended'] });
      onSold(res.sale?.receiptNo ?? res.receiptNo ?? resume?.receiptNo ?? null);
    },
  });

  const voidResume = useMutation({
    mutationFn: () => api(`/sales/${resume!.id}/void`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['phone', 'suspended'] });
      notify('Shitja e pezulluar u anulua.');
      onVoidResume();
    },
  });

  return (
    <Sheet
      title={t('Shporta')}
      onClose={onClose}
      footer={
        <>
          {!online && <Notice tone="danger">Pa lidhje me serverin. Shitja nuk mund të regjistrohet tani.</Notice>}
          {sell.isError && <Notice tone="danger">{errorText(sell.error)}</Notice>}
          {suspend.isError && <Notice tone="danger">{errorText(suspend.error)}</Notice>}
          <Btn block onClick={() => sell.mutate()} disabled={!online || sell.isPending || creditNeedsCustomer || discountBad || !canFinish}>
            {sell.isPending ? t('Duke regjistruar…') : t('Përfundo · {amount}', { amount: money(total) })}
          </Btn>
          {resume ? (
            <Btn variant="danger" block onClick={() => voidResume.mutate()} disabled={!online || voidResume.isPending}>
              {voidResume.isPending ? 'Duke anuluar…' : 'Anulo shitjen e pezulluar'}
            </Btn>
          ) : (
            <Btn variant="ghost" block onClick={() => suspend.mutate()} disabled={!online || suspend.isPending || lines.length === 0 || discountBad}>
              {suspend.isPending ? 'Duke pezulluar…' : 'Pezullo shitjen'}
            </Btn>
          )}
        </>
      }
    >
      {resume && (
        <Notice tone="info">Po përfundoni shitjen e pezulluar{resume.receiptNo ? ` ${resume.receiptNo}` : ''}.</Notice>
      )}
      <ul className="cart-lines">
        {lines.map((l) => (
          <li key={l.key} className="cart-line">
            <span className="cart-line__name">
              {l.product.name}
              {l.addons.length > 0 && <span className="cart-line__extras">{l.addons.map((a) => a.name).join(', ')}</span>}
              <span className="muted small block">
                {money(unitPrice(l.product, l.addons))} × {l.qty}
              </span>
            </span>
            <span className="qty" role="group" aria-label={`Sasia e ${l.product.name}`}>
              <button type="button" aria-label="Pak" onClick={() => onQty(l.key, l.qty - 1)}>
                −
              </button>
              <strong aria-live="polite">{l.qty}</strong>
              <button type="button" aria-label="Shto" onClick={() => onQty(l.key, l.qty + 1)}>
                +
              </button>
            </span>
            <strong className="cart-line__total">{money(unitPrice(l.product, l.addons) * l.qty)}</strong>
          </li>
        ))}
      </ul>

      <CustomerPicker selected={customer} onSelect={setCustomer} />

      {canDiscount && (
        <EuroInput label="Zbritja (opsionale)" value={discountText} onChange={setDiscountText} placeholder="0,00" />
      )}
      {discountBad && <Notice tone="danger">Zbritja nuk mund të jetë më e madhe se shuma e shportës.</Notice>}

      <PaymentPanel total={total} lines={payLines} onChange={setPayLines} canCredit={!!customer} />
      {creditNeedsCustomer && <Notice tone="warn">{t('Për pagesë me borxh zgjidhni klientin.')}</Notice>}
      {customer && payLines.some((l) => l.method === 'credit') && (
        <Notice tone="info">{t('Shuma {amount} shtohet te borxhi i {name}.', { amount: money(pay.remaining > 0 ? pay.remaining : total), name: customer.name })}</Notice>
      )}

      {discount > 0 && (
        <div className="total-row">
          <span>{t('Nëntotali')}</span>
          <strong>{money(subtotal)}</strong>
        </div>
      )}
      {discount > 0 && (
        <div className="total-row">
          <span>{t('Zbritja')}</span>
          <strong>−{money(discount)}</strong>
        </div>
      )}
      <div className="total-row total-row--big">
        <span>{t('Totali')}</span>
        <strong>{money(total)}</strong>
      </div>
    </Sheet>
  );
}

interface ResumeState {
  id: string;
  receiptNo: string | null;
  discountCents: number;
  customer: CustomerSummary | null;
}


/** The sales that were suspended on this till or elsewhere: open one to finish it, or cancel it. */
function SuspendedSheet({
  sales,
  onResume,
  onClose,
}: {
  sales: SalesListResponse['items'];
  onResume: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet title="Shitje të pezulluara" onClose={onClose}>
      {sales.length === 0 && <Empty>Nuk ka shitje të pezulluara.</Empty>}
      <ul className="list">
        {sales.map((sale) => (
          <li key={sale.id} className="debt-row">
            <span className="pc-row__main">
              <strong>{sale.receiptNo ?? sale.localNumber ?? 'Pa numër'}</strong>
              <span className="muted small">
                {sale.customerName ?? 'Pa klient'} · {shortDate(sale.createdAt)}
              </span>
            </span>
            <span className="row">
              <strong>{money(sale.totalCents)}</strong>
              <button type="button" className="ghost small-btn" onClick={() => onResume(sale.id)}>
                Hap
              </button>
            </span>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
