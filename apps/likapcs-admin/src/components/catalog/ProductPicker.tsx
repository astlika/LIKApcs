/**
 * Product picker — type-ahead over `GET /products?q=` (name, SKU or exact barcode, so a USB
 * scanner works too). Used by the purchase form to add lines. Re-uses the customer-picker styles.
 */
import { useQuery } from '@tanstack/react-query';
import { PackageSearch } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
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
}

export function ProductPicker({
  id,
  onPick,
  placeholder,
  autoFocus,
  disabled,
  style,
}: ProductPickerProps) {
  const { t, language } = useI18n();
  const fmt = useFormat();
  const listId = useId();
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = setTimeout(() => setDebounced(text.trim()), 150);
    return () => clearTimeout(h);
  }, [text]);
  const results = useQuery({
    queryKey: ['products', 'picker', debounced],
    queryFn: () =>
      api<{ items: ProductSummary[]; total: number }>('/products', {
        query: { q: debounced, pageSize: 10 },
      }),
    enabled: open && debounced.length > 0,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
  });
  const items = debounced.length > 0 ? (results.data?.items ?? []) : [];
  useEffect(() => setActive(0), [debounced]);
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
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <div ref={rootRef} className="customer-picker" style={style} data-testid="product-picker">
      <PackageSearch size={14} className="customer-picker__icon" aria-hidden />
      <input
        ref={inputRef}
        id={id}
        className="input customer-picker__input"
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder={placeholder ?? t('purchases.pickProduct')}
        value={text}
        disabled={disabled}
        autoFocus={autoFocus}
        maxLength={80}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && items.length) {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, items.length - 1));
          } else if (e.key === 'ArrowUp' && items.length) {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            // A scanner sends Enter right after the code: pick the single exact match.
            e.preventDefault();
            if (open && items[active]) pick(items[active]!);
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {open && debounced.length > 0 && (
        <ul id={listId} role="listbox" className="customer-picker__list">
          {items.map((p, i) => (
            <li
              key={p.id}
              role="option"
              aria-selected={i === active}
              className={`customer-picker__item ${i === active ? 'is-active' : ''} ${
                p.isActive ? '' : 'is-disabled'
              }`}
              onMouseEnter={() => setActive(i)}
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
                <span className="num faint">
                  {formatQuantity(p.stockMilli, language)} {p.unitCode}
                </span>
                <span className="num">{fmt.money(p.purchaseCostCents)}</span>
              </div>
            </li>
          ))}
          {items.length === 0 && !results.isFetching && (
            <li className="customer-picker__empty">{t('purchases.noProducts')}</li>
          )}
        </ul>
      )}
    </div>
  );
}
