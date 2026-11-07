import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CategorySummary, CustomerSummary, Paginated, ProductSummary, SalePaymentMethod } from '@likapcs/shared';
import { api, errorText, money, newRequestId } from '../api';
import { METHOD_LABEL } from '../labels';
import { useLive } from '../useLive';
import { useNotify } from '../notify';
import { useOnline } from '../useOnline';
import { Btn, Choices, Empty, Loading, Notice, QueryError, Sheet, cx } from '../components/ui';
import { CustomerPicker } from '../components/CustomerPicker';
import { useDebounced } from '../useDebounced';

interface CartLine {
  product: ProductSummary;
  qty: number;
}

const unitPrice = (p: ProductSummary): number => p.promoPriceCents ?? p.sellingPriceCents;

/** A product can be sold from the phone when it has no extras and is in stock. */
function sellState(p: ProductSummary): 'ok' | 'out' | 'extras' {
  if (p.addons.length > 0) return 'extras';
  if (p.trackStock && !p.allowNegativeStock && p.stockMilli <= 0) return 'out';
  return 'ok';
}

/** Point of sale: pick products, check the cart, take the money. Online only. */
export function Pos() {
  const notify = useNotify();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 250);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [cartOpen, setCartOpen] = useState(false);

  const categories = useLive(['categories'], () => api<CategorySummary[]>('/catalog/categories'));
  const products = useLive(['products', q, categoryId], () => {
    const params = new URLSearchParams({ active: 'active', pageSize: '200' });
    if (q) params.set('q', q);
    if (categoryId) params.set('categoryId', categoryId);
    return api<Paginated<ProductSummary>>(`/products?${params.toString()}`);
  });

  const lines = Object.values(cart);
  const count = lines.reduce((sum, l) => sum + l.qty, 0);
  const total = lines.reduce((sum, l) => sum + unitPrice(l.product) * l.qty, 0);

  const add = (p: ProductSummary) => {
    setCart((c) => {
      const cur = c[p.id];
      return { ...c, [p.id]: { product: p, qty: (cur?.qty ?? 0) + 1 } };
    });
  };
  const setQty = (id: string, qty: number) => {
    setCart((c) => {
      const next = { ...c };
      if (qty <= 0) delete next[id];
      else next[id] = { product: next[id]?.product ?? c[id]!.product, qty };
      return next;
    });
  };

  const cats = categories.data?.filter((c) => c.isActive) ?? [];
  // Products with no stock left are not shown at all (the till only offers what can be sold).
  const sellable = (products.data?.items ?? []).filter((p) => sellState(p) !== 'out');

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
            const state = sellState(p);
            const inCart = cart[p.id]?.qty ?? 0;
            const price = unitPrice(p);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className={cx('tile', state !== 'ok' && 'tile--off', inCart > 0 && 'tile--in')}
                  disabled={state !== 'ok'}
                  onClick={() => add(p)}
                  aria-label={`${p.name}, ${money(price)}`}
                >
                  {inCart > 0 && <span className="tile__count">{inCart}</span>}
                  <span className="tile__name">{p.name}</span>
                  <span className="tile__price">{money(price)}</span>
                  {state === 'extras' && <span className="tile__note">Me opsione</span>}
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

function CartSheet({
  lines,
  total,
  onQty,
  onClose,
  onSold,
}: {
  lines: CartLine[];
  total: number;
  onQty: (id: string, qty: number) => void;
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
            addonIds: [],
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
          <li key={l.product.id} className="cart-line">
            <span className="cart-line__name">
              {l.product.name}
              <span className="muted small block">{money(unitPrice(l.product))} × {l.qty}</span>
            </span>
            <span className="qty" role="group" aria-label={`Sasia e ${l.product.name}`}>
              <button type="button" aria-label="Pak" onClick={() => onQty(l.product.id, l.qty - 1)}>
                −
              </button>
              <strong aria-live="polite">{l.qty}</strong>
              <button type="button" aria-label="Shto" onClick={() => onQty(l.product.id, l.qty + 1)}>
                +
              </button>
            </span>
            <strong className="cart-line__total">{money(unitPrice(l.product) * l.qty)}</strong>
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
