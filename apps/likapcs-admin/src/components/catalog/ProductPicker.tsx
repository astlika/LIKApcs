/**
 * Product picker — type-ahead over `GET /products?q=` (name, SKU or exact barcode, so a USB
 * scanner works too). Used by the purchase form to add lines. Re-uses the customer-picker styles.
 *
 * 0.36.1 — `browse` (the offer form): the products are listed as soon as the field is clicked, so
 * one is chosen from the list with what is in stock beside it, and what is typed is found in that
 * list without minding capitals or ë / ç ("cips" finds "Çips").
 */
import { useQuery } from '@tanstack/react-query';
import { PackageSearch } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { formatQuantity, type ProductSummary } from '@likapcs/shared';
import { api } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';

export interface ProductPickerProps {
  id?: string;
  onPick: (product: ProductSummary) => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
  /** 0.36.1: list the products without typing and search that list in the browser. */
  browse?: boolean;
  /** Products left out of the list (the ones already chosen). */
  exclude?: readonly string[];
  /** After a pick the field takes the focus again (the default); false leaves it to the caller. */
  keepFocus?: boolean;
  /** What stands at the right of each product; by default its stock and its purchase cost. */
  meta?: (product: ProductSummary) => ReactNode;
}

/** How many products `browse` loads at once; a larger catalogue is searched by the server. */
const BROWSE_LIMIT = 500;

/** Lower case without accents: "Çips" → "cips", "Ujë" → "uje". */
const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const matches = (p: ProductSummary, typed: string): boolean => {
  if (!typed) return true;
  const q = fold(typed);
  return (
    fold(p.name).includes(q) ||
    fold(p.sku).includes(q) ||
    (p.brand ? fold(p.brand).includes(q) : false) ||
    p.barcodes.some((b) => b.barcode === typed)
  );
};

export function ProductPicker({
  id,
  onPick,
  placeholder,
  autoFocus,
  disabled,
  style,
  browse = false,
  exclude,
  keepFocus = true,
  meta,
}: ProductPickerProps) {
  const { t, language } = useI18n();
  const fmt = useFormat();
  const listId = useId();
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // `browse`: with nothing typed no row is marked until the arrows or the mouse choose one, so a
  // stray Enter never adds the first product of the list.
  const [moved, setMoved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = setTimeout(() => setDebounced(text.trim()), 150);
    return () => clearTimeout(h);
  }, [text]);
  const catalogue = useQuery({
    queryKey: ['products', 'picker', 'all'],
    queryFn: () =>
      api<{ items: ProductSummary[]; total: number }>('/products', {
        query: { pageSize: BROWSE_LIMIT, kind: 'standard' },
      }),
    enabled: browse && open,
    staleTime: 10_000,
  });
  // The whole catalogue is here: what is typed is looked up in it, not asked from the server.
  const whole = browse && !!catalogue.data && catalogue.data.total <= catalogue.data.items.length;
  const results = useQuery({
    queryKey: ['products', 'picker', debounced],
    queryFn: () =>
      api<{ items: ProductSummary[]; total: number }>('/products', {
        // `standard`: internet access is not bought in pieces — its stock is its loaded codes.
        query: { q: debounced, pageSize: 10, kind: 'standard' },
      }),
    enabled: open && debounced.length > 0 && !whole,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
  });
  const found = !browse
    ? debounced.length > 0
      ? (results.data?.items ?? [])
      : []
    : whole || debounced.length === 0
      ? (catalogue.data?.items ?? []).filter((p) => matches(p, debounced))
      : (results.data?.items ?? []);
  const items = exclude?.length ? found.filter((p) => !exclude.includes(p.id)) : found;
  const listed = open && (browse || debounced.length > 0);
  const marked = !browse || debounced.length > 0 || moved;
  const loading = browse && !catalogue.data ? catalogue.isFetching : results.isFetching;
  useEffect(() => {
    setActive(0);
    setMoved(false);
  }, [debounced]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (p: ProductSummary) => {
    onPick(p);
    setText('');
    setDebounced('');
    setOpen(false);
    setMoved(false);
    if (keepFocus) setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <div ref={rootRef} className="customer-picker" style={style} data-testid="product-picker">
      <PackageSearch size={14} className="customer-picker__icon" aria-hidden />
      <input
        ref={inputRef}
        id={id}
        className="input customer-picker__input"
        role="combobox"
        aria-expanded={listed && items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder={placeholder ?? t('purchases.pickProduct')}
        value={text}
        disabled={disabled}
        autoFocus={autoFocus}
        maxLength={80}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && items.length) {
            e.preventDefault();
            // `browse`: the first press marks the first row; after that it walks down.
            if (!browse || (listed && marked)) setActive((a) => Math.min(a + 1, items.length - 1));
            setOpen(true);
            setMoved(true);
          } else if (e.key === 'ArrowUp' && items.length) {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
            setMoved(true);
          } else if (e.key === 'Enter') {
            // A scanner sends Enter right after the code: pick the single exact match.
            e.preventDefault();
            if (listed && marked && items[active]) pick(items[active]!);
          } else if (e.key === 'Escape' && listed) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {listed && (
        <ul id={listId} role="listbox" className="customer-picker__list">
          {items.map((p, i) => (
            <li
              key={p.id}
              role="option"
              aria-selected={marked && i === active}
              className={`customer-picker__item ${marked && i === active ? 'is-active' : ''} ${
                p.isActive ? '' : 'is-disabled'
              }`}
              onMouseEnter={() => {
                setActive(i);
                setMoved(true);
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => p.isActive && pick(p)}
            >
              <div className="customer-picker__main">
                <span className="customer-picker__name">{p.name}</span>
                <span className="faint mono">
                  {p.sku}
                  {p.barcodes[0] ? ` · ${p.barcodes[0].barcode}` : ''}
                </span>
              </div>
              <div className="customer-picker__meta">
                {meta ? (
                  meta(p)
                ) : (
                  <>
                    <span className="num faint">
                      {formatQuantity(p.stockMilli, language)} {p.unitCode}
                    </span>
                    <span className="num">{fmt.money(p.purchaseCostCents)}</span>
                  </>
                )}
              </div>
            </li>
          ))}
          {items.length === 0 && !loading && (
            <li className="customer-picker__empty">{t('purchases.noProducts')}</li>
          )}
        </ul>
      )}
    </div>
  );
}
