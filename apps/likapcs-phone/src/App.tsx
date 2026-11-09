import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS } from '@likapcs/shared';
import { api, clearToken, getToken, SESSION_LOST } from './api';
import { can, useMe } from './me';
import { useOnline } from './useOnline';
import { NotifyProvider } from './notify';
import { Login } from './screens/Login';
import { Home, type Tab } from './screens/Home';
import { Pcs } from './screens/Pcs';
import { Pos } from './screens/Pos';
import { Debts } from './screens/Debts';
import { Loading, QueryError, Sheet } from './components/ui';
import { Reports } from './screens/Reports';
import { Settings } from './screens/Settings';
import { Cash } from './screens/Cash';
import { Expenses } from './screens/Expenses';
import { Stock } from './screens/Stock';
import { PcAlerts } from './Alerts';
import { applyPrefs, DEFAULT_PREFS, usePrefsQuery } from './prefs';
import { translate, useT } from './i18n';
import type { UserPreferences } from '@likapcs/shared';

function Icon({ name }: { name: Tab }) {
  const common = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (name) {
    case 'home':
      return (
        <svg {...common}>
          <path d="M3 11l9-7 9 7" />
          <path d="M5 10v10h14V10" />
        </svg>
      );
    case 'pcs':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M8 20h8M12 16v4" />
        </svg>
      );
    case 'pos':
      return (
        <svg {...common}>
          <circle cx="9" cy="20" r="1.5" />
          <circle cx="18" cy="20" r="1.5" />
          <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L21 8H6" />
        </svg>
      );
    case 'debts':
      return (
        <svg {...common}>
          <path d="M6 3h9l4 4v14H6z" />
          <path d="M14 3v5h5M9 13h6M9 17h6" />
        </svg>
      );
  }
}

const TITLES: Record<Tab, string> = { home: 'Kryefaqja', pcs: 'PC-të', pos: 'Shitje', debts: 'Borxhet' };

export function App() {
  const queryClient = useQueryClient();
  const tr = useT();
  const [signedIn, setSignedIn] = useState(() => getToken() !== null);
  const [tab, setTab] = useState<Tab>('home');
  const [page, setPage] = useState<'tab' | 'reports' | 'settings' | 'cash' | 'expenses' | 'stock'>('tab');
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const me = useMe(signedIn);
  const prefs = usePrefsQuery(signedIn);
  const online = useOnline();

  // The account's look: applied when it arrives, and again when the phone's theme changes (Sipas telefonit).
  useEffect(() => {
    if (prefs.data) applyPrefs(prefs.data);
  }, [prefs.data]);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = () => {
      const p: UserPreferences = prefs.data ?? DEFAULT_PREFS;
      if (p.theme === 'system') applyPrefs(p);
    };
    media?.addEventListener?.('change', onChange);
    return () => media?.removeEventListener?.('change', onChange);
  }, [prefs.data]);

  useEffect(() => {
    const lost = () => {
      queryClient.clear();
      setSignedIn(false);
      setNotice(translate('Sesioni skadoi. Hyni përsëri.'));
    };
    window.addEventListener(SESSION_LOST, lost);
    return () => window.removeEventListener(SESSION_LOST, lost);
  }, [queryClient]);

  if (!signedIn) {
    return (
      <Login
        notice={notice}
        onSignedIn={() => {
          setNotice(null);
          setSignedIn(true);
        }}
      />
    );
  }

  const signOut = async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      // Signing out must always work locally, even offline.
    }
    clearToken();
    queryClient.clear(); // the next person on this phone must not see the last one's data
    setSignedIn(false);
    setTab('home');
    setPage('tab');
    setMenuOpen(false);
    applyPrefs(DEFAULT_PREFS); // the next sign-in shows its own saved look
  };

  const user = me.data;
  const canPcs = can(user, PERMISSIONS.STATIONS_VIEW);
  const canPcControl = can(user, PERMISSIONS.STATIONS_CONTROL);
  const canPos = can(user, PERMISSIONS.POS_SELL) && can(user, PERMISSIONS.PRODUCTS_VIEW);
  const canDebts = can(user, PERMISSIONS.CUSTOMERS_VIEW);
  const canCollect = can(user, PERMISSIONS.POS_SELL);
  const canPower = can(user, PERMISSIONS.STATIONS_POWER);

  const canReports = can(user, PERMISSIONS.REPORTS_VIEW);
  const canProfit = canReports;
  const canCash = can(user, PERMISSIONS.CASH_VIEW);
  const canExpenses = can(user, PERMISSIONS.EXPENSES_VIEW);
  const canStock = can(user, PERMISSIONS.PRODUCTS_VIEW);
  const tabs: Tab[] = ['home', ...(canPcs ? (['pcs'] as Tab[]) : []), ...(canPos ? (['pos'] as Tab[]) : []), ...(canDebts ? (['debts'] as Tab[]) : [])];
  const active: Tab = tabs.includes(tab) ? tab : 'home';

  const go = (next: Tab) => {
    setPage('tab');
    setTab(next);
  };

  let body: ReactNode;
  if (me.isLoading) body = <Loading text={tr('Duke hapur…')} />;
  else if (me.error || !user) body = <QueryError message={tr('Nuk u lexuan llogaria. Provoni përsëri.')} onRetry={() => void me.refetch()} />;
  else if (page === 'reports' && canReports) body = <Reports canProfit={canProfit} />;
  else if (page === 'settings') body = <Settings user={user} onSignOut={signOut} />;
  else if (page === 'cash' && canCash)
    body = (
      <Cash canOpenClose={can(user, PERMISSIONS.CASH_OPEN_CLOSE)} canMove={can(user, PERMISSIONS.CASH_MOVE)} />
    );
  else if (page === 'expenses' && canExpenses) body = <Expenses canManage={can(user, PERMISSIONS.EXPENSES_MANAGE)} />;
  else if (page === 'stock' && canStock) body = <Stock />;
  else if (active === 'home')
    body = (
      <Home
        name={user.fullName || user.username}
        canPcs={canPcs}
        canPos={canPos}
        canDebts={canDebts}
        canCash={canCash}
        onGo={go}
      />
    );
  else if (active === 'pcs')
    body = <Pcs canControl={canPcControl} canCredit={canCollect} canPower={canPower} />;
  else if (active === 'pos') body = <Pos />;
  else body = <Debts canCollect={canCollect} />;

  const title =
    page === 'reports'
      ? 'Raportet'
      : page === 'settings'
        ? 'Cilësimet'
        : page === 'cash'
          ? 'Arka'
          : page === 'expenses'
            ? 'Shpenzimet'
            : page === 'stock'
              ? 'Stoku'
              : TITLES[active];
  return (
    <NotifyProvider>
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark brand-mark--sm">LK</span>
            <strong>{tr(title)}</strong>
          </div>
          <button type="button" className="ghost small-btn menu-btn" onClick={() => setMenuOpen(true)} aria-label={tr('Menyja')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
            {tr('Menu')}
          </button>
        </header>
        {menuOpen && (
          <Sheet title={tr('Menyja')} onClose={() => setMenuOpen(false)}>
            <ul className="menu-list">
              {canCash && (
                <li>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      setPage('cash');
                    }}
                  >
                    {tr('Arka')}
                    <small className="muted">{tr('Hapja, mbyllja, depozita')}</small>
                  </button>
                </li>
              )}
              {canExpenses && (
                <li>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      setPage('expenses');
                    }}
                  >
                    {tr('Shpenzimet')}
                    <small className="muted">{tr('Regjistro dhe anulo')}</small>
                  </button>
                </li>
              )}
              {canStock && (
                <li>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      setPage('stock');
                    }}
                  >
                    {tr('Stoku')}
                    <small className="muted">{tr('Stoku i ulët, kontroll barkodi')}</small>
                  </button>
                </li>
              )}
              {canReports && (
                <li>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      setPage('reports');
                    }}
                  >
                    {tr('Raportet')}
                    <small className="muted">{tr('Shitjet, arka, fitimi')}</small>
                  </button>
                </li>
              )}
              <li>
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    setPage('settings');
                  }}
                >
                  {tr('Cilësimet')}
                  <small className="muted">{tr('Tema, teksti, llogaria')}</small>
                </button>
              </li>
              <li>
                <button type="button" className="menu-item menu-item--danger" onClick={() => void signOut()}>
                  {tr('Dil nga llogaria')}
                </button>
              </li>
            </ul>
          </Sheet>
        )}
        {canPcs && <PcAlerts enabled />}
        {!online && (
          <div className="offline-bar" role="status">
            {tr('Pa lidhje me serverin. Veprimet me para janë të bllokuara.')}
          </div>
        )}
        <main className="content">{body}</main>
        {tabs.length > 1 && (
          <nav className="tabbar" aria-label={tr('Menyja')}>
            {tabs.map((t) => (
              <button
                key={t}
                type="button"
                className={active === t && page === 'tab' ? 'tab tab--on' : 'tab'}
                aria-current={active === t && page === 'tab' ? 'page' : undefined}
                onClick={() => go(t)}
              >
                <Icon name={t} />
                <span>{tr(TITLES[t])}</span>
              </button>
            ))}
          </nav>
        )}
      </div>
    </NotifyProvider>
  );
}
