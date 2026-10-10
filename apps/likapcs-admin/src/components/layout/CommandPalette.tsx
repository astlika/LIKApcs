import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  Contact,
  LayoutDashboard,
  Monitor,
  Package,
  Receipt,
  ScrollText,
  Search,
  Settings,
  ShoppingCart,
  Users,
  Wallet,
} from 'lucide-react';
import type { StationSummary } from '@likapcs/shared';
import { PERMISSIONS } from '@likapcs/shared';
import { api } from '../../lib/api';
import { useI18n } from '../../i18n';
import { useAuth } from '../../state/auth';

interface Item {
  id: string;
  label: string;
  kind: 'page' | 'station';
  to: string;
  icon: typeof Monitor;
}

/** Ctrl+K quick navigation across pages and stations. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const stations = useQuery({
    queryKey: ['stations'],
    queryFn: () => api<StationSummary[]>('/stations'),
    enabled: open && can(PERMISSIONS.STATIONS_VIEW),
  });

  const items = useMemo<Item[]>(() => {
    const pages: Item[] = [
      { id: 'dashboard', label: t('nav.dashboard'), kind: 'page', to: '/', icon: LayoutDashboard },
      { id: 'stations', label: t('nav.stations'), kind: 'page', to: '/stations', icon: Monitor },
      { id: 'pos', label: t('nav.pos'), kind: 'page', to: '/pos', icon: ShoppingCart },
      { id: 'products', label: t('nav.products'), kind: 'page', to: '/products', icon: Package },
      { id: 'cash', label: t('nav.cash'), kind: 'page', to: '/cash', icon: Wallet },
      { id: 'expenses', label: t('nav.expenses'), kind: 'page', to: '/expenses', icon: Receipt },
      { id: 'customers', label: t('nav.customers'), kind: 'page', to: '/customers', icon: Contact },
      { id: 'reports', label: t('nav.reports'), kind: 'page', to: '/reports', icon: BarChart3 },
      { id: 'employees', label: t('nav.employees'), kind: 'page', to: '/employees', icon: Users },
      { id: 'audit', label: t('nav.audit'), kind: 'page', to: '/audit', icon: ScrollText },
      { id: 'settings', label: t('nav.settings'), kind: 'page', to: '/settings', icon: Settings },
    ];
    const stationItems: Item[] = (stations.data ?? []).map((s) => ({
      id: s.id,
      label: `${s.code} · ${s.name}`,
      kind: 'station',
      to: `/stations?focus=${s.id}`,
      icon: Monitor,
    }));
    const all = [...pages, ...stationItems];
    const q = query.trim().toLowerCase();
    return q ? all.filter((i) => i.label.toLowerCase().includes(q)) : all;
  }, [query, stations.data, t]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
    }
  }, [open]);
  useEffect(() => setIndex(0), [query]);

  if (!open) return null;
  const go = (item: Item) => {
    navigate(item.to);
    onClose();
  };
  return (
    <div className="overlay palette" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={t('topbar.search')}>
        <div className="input-group">
          <Search size={18} />
          <input
            autoFocus
            className="input palette__input"
            placeholder={t('palette.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setIndex((i) => Math.min(items.length - 1, i + 1));
              else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1));
              else if (e.key === 'Enter' && items[index]) go(items[index]);
              else if (e.key === 'Escape') onClose();
            }}
          />
        </div>
        <div className="palette__list">
          {items.length === 0 && <div className="empty">{t('palette.noMatch')}</div>}
          {items.map((item, i) => {
            const Icon = item.icon;
            return (
              <div
                key={item.id}
                className="palette__item"
                aria-selected={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={() => go(item)}
              >
                <Icon size={16} className="muted" />
                <span>{item.label}</span>
                <span className="palette__kind">
                  {item.kind === 'page' ? t('palette.pages') : t('palette.stations')}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
