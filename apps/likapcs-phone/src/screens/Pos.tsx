import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CategorySummary, CustomerSummary, Paginated, ProductAddonSummary, ProductSummary, SalePaymentMethod } from '@likapcs/shared';
import { api, errorText, money, newRequestId } from '../api';
import { METHOD_LABEL } from '../labels';
import { useLive } from '../useLive';
import { useNotify } from '../notify';
import { useOnline } from '../useOnline';
import { Btn, Choices, Empty, Loading, Notice, QueryError, Sheet, cx } from '../components/ui';
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

/** Point of sale: pick products (with extras when they have them), check the cart, take the money. Online only. */
export function Pos() {
  const notify = useNotify();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 250);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [cartOpen, setCartOpen] = useState(false);
  const [extrasFor, setExtrasFor] = useState<ProductSummary | null>(null);

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

  const cats = categories.data?.filter((c) => c.isActive) ?? [];
  // Products with no stock left are not shown at all (the till only offers what can be sold).
  const sellable = (products.data?.items ?? []).filter(inStock);
  const inCartCount = (p: ProductSummary) => lines.filter((l) => l.product.id === p.id).reduce((sum, l) => sum + l.qty, 0);

  return (
    <div className="stack pos">
      <div className="page-head">
        <h1>Shitje</h1>
      </div>

      <input
        className="search"
        type="search"
        placeholder="Kërko produkt…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Kërko produkt"
      />

      {cats.length > 0 && (
        <div className="chips" role="group" aria-label="Kategoritë">
          <button type="button" className={cx('chip', categoryId === null && 'chip--on')} onClick={() => setCategoryId(null)}>
            Të gjitha
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
              <li key={p.id}>
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

      {cartOpen && (
        <CartSheet
          lines={lines}
          total={total}
          onQty={setQty}
          onClose={() => setCartOpen(false)}
          onSold={(receipt) => {
            setCart({});
            setCartOpen(false);
            notify(receipt ? `Shitja u regjistrua · ${receipt}` : 'Shitja u regjistrua.');
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
  total,
  onQty,
  onClose,
  onSold,
}: {
  lines: CartLine[];
  total: number;
  onQty: (key: string, qty: number) => void;
  onClose: () => void;
  onSold: (receipt: string | null) => void;
}) {
  const online = useOnline();
  const qc = useQueryClient();
  const requestId = useState(newRequestId)[0];
  const [customer, setCustomer] = useState<CustomerSummary | null>(null);
  const [method, setMethod] = useState<SalePaymentMethod>('cash');

  const creditNeedsCustomer = method === 'credit' && !customer;
  const payOptions: { value: SalePaymentMethod; label: string; disabled?: boolean }[] = [
    { value: 'cash', label: METHOD_LABEL.cash ?? 'Cash' },
    { value: 'card', label: METHOD_LABEL.card ?? 'Kartelë' },
    { value: 'bank_transfer', label: METHOD_LABEL.bank_transfer ?? 'Transfer' },
    { value: 'credit', label: 'Me borxh', disabled: !customer },
  ];

  const sell = useMutation({
    mutationFn: () =>
      api<{ sale?: { receiptNo?: string | null }; receiptNo?: string | null }>('/sales', {
        method: 'POST',
        body: {
          items: lines.map((l) => ({
            productId: l.product.id,
            quantityMilli: l.qty * 1000,
            discountCents: 0,
            addonIds: l.addons.map((a) => a.id),
          })),
          discountCents: 0,
          customerId: customer?.id ?? null,
          payments: [{ method, amountCents: total }],
          clientRequestId: requestId,
          staff: false,
        },
      }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['phone', 'products'] });
      void qc.invalidateQueries({ queryKey: ['phone', 'debts'] });
      onSold(res.sale?.receiptNo ?? res.receiptNo ?? null);
    },
  });

  return (
    <Sheet
      title="Shporta"
      onClose={onClose}
      footer={
        <>
          {!online && <Notice tone="danger">Pa lidhje me serverin. Shitja nuk mund të regjistrohet tani.</Notice>}
          {sell.isError && <Notice tone="danger">{errorText(sell.error)}</Notice>}
          <Btn block onClick={() => sell.mutate()} disabled={!online || sell.isPending || lines.length === 0 || creditNeedsCustomer}>
            {sell.isPending ? 'Duke regjistruar…' : `Përfundo · ${money(total)}`}
          </Btn>
        </>
      }
    >
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

      <Choices label="Mënyra e pagesës" value={method} onChange={setMethod} options={payOptions} />
      {creditNeedsCustomer && <Notice tone="warn">Për pagesë me borxh zgjidhni klientin.</Notice>}
      {method === 'credit' && customer && (
        <Notice tone="info">Shuma {money(total)} shtohet te borxhi i {customer.name}.</Notice>
      )}

      <div className="total-row total-row--big">
        <span>Totali</span>
        <strong>{money(total)}</strong>
      </div>
    </Sheet>
  );
}
