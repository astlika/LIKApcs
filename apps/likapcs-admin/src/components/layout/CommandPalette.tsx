import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  Contact,
  DatabaseBackup,
  RefreshCw,
  LayoutDashboard,
  Monitor,
  Package,
  Receipt,
  FileText,
  ScrollText,
  Search,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
  HandCoins,
  Megaphone,
  Undo2,
  ClipboardList,
  Loader2,
  CornerDownLeft,
} from 'lucide-react';
import type { PermissionCode, SearchHit, SearchResponse } from '@likapcs/shared';
import { PERMISSIONS } from '@likapcs/shared';
import { api } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useI18n, type TranslationKey } from '../../i18n';
import { useAuth } from '../../state/auth';

interface Item {
  id: string;
  label: string;
  /** Second line: who / how much / when. */
  detail?: string;
  /** Right-hand tag (group name). */
  kind: TranslationKey;
  to: string;
  icon: typeof Monitor;
  /** Document / record number shown in a monospace chip. */
  code?: string;
  tone?: 'muted' | 'danger';
}

/** Records are looked up after a short pause; pages filter instantly. */
const MIN_RECORD_CHARS = 2;
const DEBOUNCE_MS = 180;

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(handle);
  }, [value, ms]);
  return debounced;
}

/**
 * Ctrl+K — one box for everything: pages, and (from two characters) receipts, refunds, invoices,
 * purchases, customers, products and stations straight from the server. Enter opens the
 * highlighted record on its page (the pages read `?open=` / `?focus=` and show the detail).
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const { money, dateTime, date } = useFormat();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const trimmed = query.trim();
  const debounced = useDebounced(trimmed, DEBOUNCE_MS);
  const recordQuery = debounced.length >= MIN_RECORD_CHARS ? debounced : '';
  const results = useQuery({
    queryKey: ['search', recordQuery],
    queryFn: () => api<SearchResponse>('/search', { query: { q: recordQuery, limit: 6 } }),
    enabled: open && recordQuery.length > 0,
    staleTime: 15_000,
    placeholderData: (prev) => (recordQuery ? prev : undefined),
  });

  const pages = useMemo<Item[]>(() => {
    const all: (Item & { perm?: PermissionCode })[] = [
      {
        id: 'dashboard',
        label: t('nav.dashboard'),
        kind: 'palette.pages',
        to: '/',
        icon: LayoutDashboard,
      },
      {
        id: 'stations',
        label: t('nav.stations'),
        kind: 'palette.pages',
        to: '/stations',
        icon: Monitor,
        perm: PERMISSIONS.STATIONS_VIEW,
      },
      {
        id: 'pos',
        label: t('nav.pos'),
        kind: 'palette.pages',
        to: '/pos',
        icon: ShoppingCart,
        perm: PERMISSIONS.POS_SELL,
      },
      {
        id: 'sales',
        label: t('nav.sales'),
        kind: 'palette.pages',
        to: '/sales',
        icon: Receipt,
        perm: PERMISSIONS.POS_SELL,
      },
      {
        id: 'orders',
        label: t('nav.orders'),
        kind: 'palette.pages',
        to: '/orders',
        icon: ClipboardList,
        perm: PERMISSIONS.POS_SELL,
      },
      {
        id: 'products',
        label: t('nav.products'),
        kind: 'palette.pages',
        to: '/products',
        icon: Package,
        perm: PERMISSIONS.PRODUCTS_VIEW,
      },
      { id: 'ads', label: t('nav.ads'), kind: 'palette.pages', to: '/ads', icon: Megaphone },
      {
        id: 'purchases',
        label: t('nav.purchases'),
        kind: 'palette.pages',
        to: '/purchases',
        icon: ShoppingBag,
        perm: PERMISSIONS.PURCHASES_VIEW,
      },
      {
        id: 'suppliers',
        label: t('nav.suppliers'),
        kind: 'palette.pages',
        to: '/suppliers',
        icon: Truck,
        perm: PERMISSIONS.PURCHASES_VIEW,
      },
      { id: 'cash', label: t('nav.cash'), kind: 'palette.pages', to: '/cash', icon: Wallet },
      {
        id: 'expenses',
        label: t('nav.expenses'),
        kind: 'palette.pages',
        to: '/expenses',
        icon: Receipt,
      },
      {
        id: 'invoices',
        label: t('nav.invoices'),
        kind: 'palette.pages',
        to: '/invoices',
        icon: FileText,
        perm: PERMISSIONS.INVOICES_VIEW,
      },
      {
        id: 'customers',
        label: t('nav.customers'),
        kind: 'palette.pages',
        to: '/customers',
        icon: Contact,
        perm: PERMISSIONS.CUSTOMERS_VIEW,
      },
      { id: 'debts', label: t('nav.debts'), kind: 'palette.pages', to: '/debts', icon: HandCoins },
      {
        id: 'reports',
        label: t('nav.reports'),
        kind: 'palette.pages',
        to: '/reports',
        icon: BarChart3,
      },
      {
        id: 'employees',
        label: t('nav.employees'),
        kind: 'palette.pages',
        to: '/employees',
        icon: Users,
      },
      { id: 'audit', label: t('nav.audit'), kind: 'palette.pages', to: '/audit', icon: ScrollText },
      {
        id: 'settings',
        label: t('nav.settings'),
        kind: 'palette.pages',
        to: '/settings',
        icon: Settings,
      },
      {
        id: 'backups',
        label: t('nav.backups'),
        kind: 'palette.pages',
        to: '/backups',
        icon: DatabaseBackup,
      },
      {
        id: 'updates',
        label: t('nav.updates'),
        kind: 'palette.pages',
        to: '/updates',
        icon: RefreshCw,
      },
    ];
    return all.filter((p) => !p.perm || can(p.perm));
  }, [t, can]);

  const items = useMemo<Item[]>(() => {
    const q = trimmed.toLowerCase();
    const pageItems = q ? pages.filter((i) => i.label.toLowerCase().includes(q)) : pages;
    const hits = recordQuery && results.data?.q === recordQuery ? results.data.hits : [];
    const recordItems: Item[] = hits.map((h) => toItem(h));
    // Records first once the user is clearly searching for one; pages first otherwise.
    return recordItems.length ? [...recordItems, ...pageItems] : pageItems;

    function toItem(h: SearchHit): Item {
      switch (h.kind) {
        case 'sale':
          return {
            id: `sale:${h.id}`,
            code: h.receiptNo,
            label: h.customerName ?? t('palette.walkIn'),
            detail: [
              money(h.totalCents),
              h.completedAt ? dateTime(h.completedAt) : null,
              h.status !== 'completed' ? t(`sales.status.${h.status}` as TranslationKey) : null,
            ]
              .filter(Boolean)
              .join(' · '),
            kind: 'palette.receipts',
            to: `/sales?open=${h.id}`,
            icon: Receipt,
            tone: h.status === 'void' ? 'danger' : undefined,
          };
        case 'refund':
          return {
            id: `refund:${h.id}`,
            code: h.refundNo,
            label: h.receiptNo ? `${t('palette.refundOf')} ${h.receiptNo}` : t('palette.refunds'),
            detail: `${money(h.totalCents)} · ${dateTime(h.createdAt)}`,
            kind: 'palette.refunds',
            to: `/sales?open=${h.saleId}`,
            icon: Undo2,
          };
        case 'invoice':
          return {
            id: `invoice:${h.id}`,
            code: h.invoiceNo,
            label: h.billingName ?? '—',
            detail: [date(h.issuedAt), h.status === 'void' ? t('invoice.status.void') : null]
              .filter(Boolean)
              .join(' · '),
            kind: 'palette.invoices',
            to: `/invoices?open=${h.id}`,
            icon: FileText,
            tone: h.status === 'void' ? 'danger' : undefined,
          };
        case 'purchase':
          return {
            id: `purchase:${h.id}`,
            code: h.referenceNo,
            label: h.supplierName ?? '—',
            detail: [money(h.totalCents), h.orderDate ? date(h.orderDate) : null]
              .filter(Boolean)
              .join(' · '),
            kind: 'palette.purchases',
            to: `/purchases?open=${h.id}`,
            icon: ShoppingBag,
          };
        case 'customer':
          return {
            id: `customer:${h.id}`,
            code: h.code,
            label: h.name,
            detail: [
              h.phone,
              h.loginUsername ? `@${h.loginUsername}` : null,
              h.balanceDueCents > 0 ? `${t('palette.owes')} ${money(h.balanceDueCents)}` : null,
              h.walletBalanceCents > 0
                ? `${t('palette.balance')} ${money(h.walletBalanceCents)}`
                : null,
            ]
              .filter(Boolean)
              .join(' · '),
            kind: 'palette.customers',
            to: `/customers?open=${h.id}`,
            icon: Contact,
            tone: h.balanceDueCents > 0 ? 'danger' : undefined,
          };
        case 'product':
          return {
            id: `product:${h.id}`,
            code: h.barcode ?? undefined,
            label: h.name,
            detail: [
              money(h.sellingPriceCents),
              h.trackStock ? `${t('palette.stock')} ${formatQty(h.stockMilli)}` : null,
              h.isActive ? null : t('products.archived'),
            ]
              .filter(Boolean)
              .join(' · '),
            kind: 'palette.products',
            to: `/products?open=${h.id}`,
            icon: Package,
            tone: h.isActive ? undefined : 'muted',
          };
        case 'station':
          return {
            id: `station:${h.id}`,
            code: h.code,
            label: h.name,
            detail: h.enabled ? undefined : t('stations.status.disabled'),
            kind: 'palette.stations',
            to: `/stations?focus=${h.id}`,
            icon: Monitor,
            tone: h.enabled ? undefined : 'muted',
          };
      }
    }
  }, [trimmed, pages, recordQuery, results.data, t, money, dateTime, date]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
    }
  }, [open]);
  useEffect(() => setIndex(0), [items]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!open) return null;
  const go = (item: Item) => {
    navigate(item.to);
    onClose();
  };
  const searching =
    trimmed.length >= MIN_RECORD_CHARS && (results.isFetching || debounced !== trimmed);
  const nothing = items.length === 0 && !searching;
  return (
    <div className="overlay palette" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={t('topbar.search')} data-testid="palette">
        <div className="input-group palette__box">
          {searching ? <Loader2 size={18} className="palette__spin" /> : <Search size={18} />}
          <input
            autoFocus
            className="input palette__input"
            placeholder={t('palette.placeholder')}
            value={query}
            data-testid="palette-input"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter' && items[index]) go(items[index]);
              else if (e.key === 'Escape') onClose();
            }}
          />
        </div>
        <div className="palette__list" ref={listRef} data-testid="palette-list">
          {nothing && <div className="empty">{t('palette.noMatch')}</div>}
          {items.map((item, i) => {
            const Icon = item.icon;
            const groupStart = i === 0 || items[i - 1]!.kind !== item.kind;
            return (
              <div key={item.id}>
                {groupStart && <div className="palette__group">{t(item.kind)}</div>}
                <div
                  className={`palette__item${item.tone ? ` palette__item--${item.tone}` : ''}`}
                  aria-selected={i === index}
                  data-index={i}
                  data-testid="palette-item"
                  data-kind={item.kind}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => go(item)}
                >
                  <Icon size={16} className="muted" />
                  <div className="palette__text">
                    <div className="palette__title">
                      {item.code && <span className="palette__code">{item.code}</span>}
                      <span>{item.label}</span>
                    </div>
                    {item.detail && <div className="palette__detail">{item.detail}</div>}
                  </div>
                  {i === index ? (
                    <span className="palette__enter">
                      <CornerDownLeft size={13} />
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        {trimmed.length > 0 && trimmed.length < MIN_RECORD_CHARS && (
          <div className="palette__hint">{t('palette.typeMore')}</div>
        )}
      </div>
    </div>
  );
}

function formatQty(milli: number): string {
  const units = milli / 1000;
  return Number.isInteger(units) ? String(units) : units.toFixed(3).replace(/0+$/, '');
}
