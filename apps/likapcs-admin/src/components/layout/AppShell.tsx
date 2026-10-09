import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Monitor,
  Moon,
  ScrollText,
  Search,
  Settings,
  Sun,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  PERMISSIONS,
  type HealthResponse,
  type PermissionCode,
  type StationDeviceSummary,
} from '@likapcs/shared';
import { api } from '../../lib/api';
import { storage } from '../../lib/storage';
import { useAdminSocket } from '../../lib/ws';
import { useI18n } from '../../i18n';
import { useAuth } from '../../state/auth';
import { Badge, Button, Kbd, Segmented } from '../ui/primitives';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { CommandPalette } from './CommandPalette';

const ADMIN_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.1.0';

interface NavEntry {
  to: string;
  icon: typeof Monitor;
  label: string;
  permission?: PermissionCode;
  badge?: number;
}

export function useTheme() {
  const [theme, setThemeState] = useState<'dark' | 'light'>(
    () => (storage.get('theme') as 'dark' | 'light' | null) ?? 'dark',
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const setTheme = useCallback((next: 'dark' | 'light') => {
    storage.set('theme', next);
    setThemeState(next);
  }, []);
  return { theme, setTheme };
}

export function AppShell() {
  const { t, language, setLanguage } = useI18n();
  const { user, can, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => storage.get('sidebarCollapsed') === '1');
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const live = useAdminSocket(Boolean(user));

  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api<HealthResponse>('/system/health', { auth: false }),
    refetchInterval: 15_000,
    retry: false,
  });
  const pendingDevices = useQuery({
    queryKey: ['devices', 'pending'],
    queryFn: () => api<StationDeviceSummary[]>('/devices', { query: { status: 'pending' } }),
    enabled: can(PERMISSIONS.STATIONS_VIEW),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);
  useEffect(() => setMenuOpen(false), [location.pathname]);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    storage.set('sidebarCollapsed', next ? '1' : '0');
  };

  const sections: { label: string; items: NavEntry[] }[] = [
    {
      label: t('nav.overview'),
      items: [
        {
          to: '/',
          icon: LayoutDashboard,
          label: t('nav.dashboard'),
          permission: PERMISSIONS.DASHBOARD_VIEW,
        },
      ],
    },
    {
      label: t('nav.operations'),
      items: [
        {
          to: '/stations',
          icon: Monitor,
          label: t('nav.stations'),
          permission: PERMISSIONS.STATIONS_VIEW,
          badge: pendingDevices.data?.length,
        },
      ],
    },
    {
      label: t('nav.management'),
      items: [
        {
          to: '/employees',
          icon: Users,
          label: t('nav.employees'),
          permission: PERMISSIONS.USERS_VIEW,
        },
        {
          to: '/audit',
          icon: ScrollText,
          label: t('nav.audit'),
          permission: PERMISSIONS.AUDIT_VIEW,
        },
        {
          to: '/settings',
          icon: Settings,
          label: t('nav.settings'),
          permission: PERMISSIONS.SETTINGS_VIEW,
        },
      ],
    },
  ];

  const titles: Record<string, string> = {
    '/': t('nav.dashboard'),
    '/stations': t('nav.stations'),
    '/employees': t('nav.employees'),
    '/audit': t('nav.audit'),
    '/settings': t('nav.settings'),
  };
  const serverOk = health.isSuccess && health.data.status === 'ok';
  const initials = (user?.fullName ?? '?')
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="shell" data-collapsed={collapsed}>
      <aside className="sidebar">
        <div className="sidebar__brand">
          <div className="brand-mark">LK</div>
          <div className="brand-name">
            LIKA<span>pcs</span>
          </div>
        </div>
        <nav className="sidebar__nav">
          {sections.map((section) => {
            const visible = section.items.filter((i) => !i.permission || can(i.permission));
            if (!visible.length) return null;
            return (
              <div key={section.label}>
                <div className="nav-section">{section.label}</div>
                {visible.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === '/'}
                      className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                      title={collapsed ? item.label : undefined}
                    >
                      <Icon size={18} />
                      <span className="nav-item__label">{item.label}</span>
                      {item.badge ? <span className="nav-item__badge">{item.badge}</span> : null}
                    </NavLink>
                  );
                })}
              </div>
            );
          })}
        </nav>
        <div className="sidebar__footer">
          <span className="sidebar__footer-text">v{ADMIN_VERSION}</span>
          <Button
            variant="ghost"
            icon
            size="sm"
            onClick={toggleCollapsed}
            aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </Button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar__title">{titles[location.pathname] ?? t('app.name')}</div>
          <div className="topbar__spacer" />
          <Button variant="ghost" size="sm" onClick={() => setPaletteOpen(true)}>
            <Search size={15} /> {t('topbar.search')} <Kbd>{t('topbar.searchHint')}</Kbd>
          </Button>
          <span
            className="status-pill"
            title={serverOk ? t('topbar.serverOnline') : t('topbar.serverOffline')}
          >
            {serverOk ? (
              <Wifi size={15} className="text-success" />
            ) : (
              <WifiOff size={15} className="text-danger" />
            )}
            <span className="muted">
              {serverOk ? t('topbar.serverOnline') : t('topbar.serverOffline')}
            </span>
          </span>
          <Badge
            tone={
              live === 'connected'
                ? 'success'
                : live === 'reconnecting' || live === 'connecting'
                  ? 'warning'
                  : 'default'
            }
            dot
          >
            {live === 'connected'
              ? t('topbar.liveConnected')
              : live === 'disconnected'
                ? t('topbar.liveDisconnected')
                : t('topbar.liveReconnecting')}
          </Badge>
          <Segmented
            value={language}
            onChange={setLanguage}
            ariaLabel={t('topbar.language')}
            options={[
              { value: 'en', label: 'EN' },
              { value: 'sq', label: 'SQ' },
            ]}
          />
          <Button
            variant="ghost"
            icon
            size="sm"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={t('topbar.theme')}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </Button>
          <div ref={menuRef} style={{ position: 'relative' }}>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <span
                className="brand-mark"
                style={{
                  width: 28,
                  height: 28,
                  fontSize: 11,
                  boxShadow: 'none',
                  background: 'var(--bg-active)',
                  color: 'var(--text)',
                }}
              >
                {initials}
              </span>
              <span style={{ fontWeight: 600 }}>{user?.fullName}</span>
            </button>
            {menuOpen && (
              <div className="menu" role="menu">
                <div className="menu__header">
                  <div style={{ fontWeight: 600 }}>{user?.fullName}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    @{user?.username} ·{' '}
                    {user?.roles
                      .map((r) => t(`employees.roleNames.${r}` as 'employees.roleNames.owner'))
                      .join(', ')}
                  </div>
                </div>
                <button
                  type="button"
                  className="menu__item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setPasswordOpen(true);
                  }}
                >
                  <KeyRound size={16} /> {t('topbar.changePassword')}
                </button>
                <button
                  type="button"
                  className="menu__item menu__item--danger"
                  role="menuitem"
                  onClick={() => void logout()}
                >
                  <LogOut size={16} /> {t('topbar.logout')}
                </button>
              </div>
            )}
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ChangePasswordDialog
        open={passwordOpen || Boolean(user?.mustChangePassword)}
        forced={Boolean(user?.mustChangePassword)}
        onClose={() => setPasswordOpen(false)}
      />
    </div>
  );
}
