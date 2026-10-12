/**
 * Customer picker — a small type-ahead over `GET /customers?q=` used by the POS cart and the
 * session start dialogs.
 *
 * Controlled by the parent: `value` is the selected customer (or null) and `text` the free text in
 * the box. Typing searches by name, phone or code; picking a row calls `onChange(customer)`.
 * With `allowFreeText` the typed text is kept when nothing is picked (gaming sessions store it as
 * `customerName`, so a walk-in can still be labelled "Arben" without creating a record).
 * With `allowCreate` (needs `customers.manage`) the list ends with "Add customer «Arben»": one
 * click creates the record (name only — phone and the rest can follow under Customers) and picks
 * it. That is how a debt gets a named customer in the two seconds a cashier has for it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, UserRound, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import type { CustomerSummary, Paginated } from '@likapcs/shared';
import { PERMISSIONS } from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../state/auth';
import { useI18n } from '../../i18n';
import { Badge } from '../ui/primitives';

export interface CustomerPickerProps {
  id?: string;
  value: CustomerSummary | null;
  onChange: (customer: CustomerSummary | null) => void;
  /** Free text (used only when `allowFreeText`). */
  text?: string;
  onTextChange?: (text: string) => void;
  allowFreeText?: boolean;
  /** Offer "Add customer «text»" when nothing matches exactly (requires `customers.manage`). */
  allowCreate?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
  className?: string;
}

export function CustomerPicker({
  id,
  value,
  onChange,
  text = '',
  onTextChange,
  allowFreeText = false,
  allowCreate = false,
  placeholder,
  autoFocus,
  disabled,
  style,
  className = '',
}: CustomerPickerProps) {
  const { t } = useI18n();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const canSearch = can(PERMISSIONS.CUSTOMERS_VIEW);
  const canCreate = allowCreate && can(PERMISSIONS.CUSTOMERS_MANAGE);
  const listId = useId();
  const [local, setLocal] = useState(text);
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Keep the local text in sync when the parent resets it (e.g. "New sale").
  useEffect(() => setLocal(text), [text]);
  useEffect(() => {
    const h = setTimeout(() => setDebounced(local.trim()), 180);
    return () => clearTimeout(h);
  }, [local]);

  const results = useQuery({
    queryKey: ['customers', 'picker', debounced],
    queryFn: () =>
      api<Paginated<CustomerSummary>>('/customers', { query: { q: debounced, pageSize: 8 } }),
    enabled: canSearch && open && debounced.length > 0,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
  });
  const items = debounced.length > 0 ? (results.data?.items ?? []) : [];
  // "Add «Arben»" is offered once the search has answered and no row is that exact name.
  const createName = local.trim().replace(/\s+/g, ' ');
  const offerCreate =
    canCreate &&
    createName.length >= 2 &&
    debounced === createName &&
    !results.isFetching &&
    !items.some(
      (c) => c.name.localeCompare(createName, undefined, { sensitivity: 'accent' }) === 0,
    );
  const optionCount = items.length + (offerCreate ? 1 : 0);

  const create = useMutation({
    mutationFn: (name: string) =>
      api<CustomerSummary>('/customers', { method: 'POST', body: { name } }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      pick(created);
    },
  });
  const createError =
    create.error instanceof ApiError
      ? create.error.message
      : create.error
        ? String(create.error)
        : null;

  useEffect(() => setActive(0), [debounced]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (c: CustomerSummary) => {
    onChange(c);
    setLocal('');
    onTextChange?.('');
    setOpen(false);
  };
  const clear = () => {
    onChange(null);
    setLocal('');
    onTextChange?.('');
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  if (value) {
    return (
      <div className={`customer-chip ${className}`} style={style} data-testid="customer-chip">
        <UserRound size={14} />
        <span className="customer-chip__name" title={`${value.code} · ${value.name}`}>
          {value.name}
        </span>
        {value.membership && <Badge tone="info">{value.membership}</Badge>}
        {value.discountBp > 0 && (
          <span className="faint num">−{(value.discountBp / 100).toFixed(0)}%</span>
        )}
        {!disabled && (
          <button
            type="button"
            className="customer-chip__clear"
            onClick={clear}
            aria-label={t('customers.pickerClear')}
            title={t('customers.pickerClear')}
          >
            <X size={14} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} className={`customer-picker ${className}`} style={style}>
      <Search size={14} className="customer-picker__icon" aria-hidden />
      <input
        ref={inputRef}
        id={id}
        className="input customer-picker__input"
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder={placeholder ?? t('customers.pickerPlaceholder')}
        value={local}
        disabled={disabled}
        autoFocus={autoFocus}
        maxLength={120}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setLocal(e.target.value);
          setOpen(true);
          if (allowFreeText) onTextChange?.(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && optionCount) {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, optionCount - 1));
          } else if (e.key === 'ArrowUp' && optionCount) {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && open && items[active]) {
            e.preventDefault();
            pick(items[active]!);
          } else if (e.key === 'Enter' && open && offerCreate && active === items.length) {
            e.preventDefault();
            if (!create.isPending) create.mutate(createName);
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {open && debounced.length > 0 && canSearch && (
        <ul id={listId} role="listbox" className="customer-picker__list">
          {items.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === active}
              className={`customer-picker__item ${i === active ? 'is-active' : ''} ${
                c.status !== 'active' ? 'is-disabled' : ''
              }`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => c.status === 'active' && pick(c)}
            >
              <div className="customer-picker__main">
                <span className="customer-picker__name">{c.name}</span>
                <span className="faint mono">
                  {c.code}
                  {c.phone ? ` · ${c.phone}` : ''}
                </span>
              </div>
              <div className="customer-picker__meta">
                {c.status !== 'active' && (
                  <Badge tone="danger">{t(`customers.status.${c.status}`)}</Badge>
                )}
                {c.membership && <Badge tone="info">{c.membership}</Badge>}
                {c.discountBp > 0 && (
                  <span className="num text-success">−{(c.discountBp / 100).toFixed(0)}%</span>
                )}
              </div>
            </li>
          ))}
          {offerCreate && (
            <li
              role="option"
              aria-selected={active === items.length}
              className={`customer-picker__item customer-picker__item--create ${
                active === items.length ? 'is-active' : ''
              }`}
              onMouseEnter={() => setActive(items.length)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => !create.isPending && create.mutate(createName)}
              data-testid="customer-create"
            >
              <Plus size={14} />
              <span>
                {create.isPending
                  ? t('customers.pickerCreating')
                  : t('customers.pickerCreate', { name: createName })}
              </span>
            </li>
          )}
          {createError && <li className="customer-picker__empty text-danger">{createError}</li>}
          {items.length === 0 && !results.isFetching && !offerCreate && (
            <li className="customer-picker__empty">
              {t('customers.pickerNoResults')}
              {allowFreeText && <span className="faint"> · {t('customers.pickerFreeText')}</span>}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
