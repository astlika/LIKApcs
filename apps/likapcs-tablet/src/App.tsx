import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS, type UserPreferences } from '@likapcs/shared';
import { api, clearToken, getToken, SESSION_LOST } from '@phone/api';
import { can, useMe } from '@phone/me';
import { useOnline } from '@phone/useOnline';
import { NotifyProvider } from '@phone/notify';
import { LiveSalesListener } from '@phone/liveSales';
import { Login } from '@phone/screens/Login';
import { Home } from '@phone/screens/Home';
import { PcAlerts } from '@phone/Alerts';
import { applyPrefs, DEFAULT_PREFS, usePrefsQuery } from '@phone/prefs';
import { Loading, QueryError } from '@phone/components/ui';
import { translate, useT } from '@phone/i18n';

// Every screen except the first ones loads on demand, so the tablet starts fast.
const Pcs = lazy(() => import('@phone/screens/Pcs').then((m) => ({ default: m.Pcs })));
const Pos = lazy(() => import('@phone/screens/Pos').then((m) => ({ default: m.Pos })));
const Debts = lazy(() => import('@phone/screens/Debts').then((m) => ({ default: m.Debts })));
const Cash = lazy(() => import('@phone/screens/Cash').then((m) => ({ default: m.Cash })));
const Expenses = lazy(() => import('@phone/screens/Expenses').then((m) => ({ default: m.Expenses })));
const Stock = lazy(() => import('@phone/screens/Stock').then((m) => ({ default: m.Stock })));
const Reports = lazy(() => import('@phone/screens/Reports').then((m) => ({ default: m.Reports })));
const Settings = lazy(() => import('@phone/screens/Settings').then((m) => ({ default: m.Settings })));
const Live = lazy(() => import('@phone/screens/Live').then((m) => ({ default: m.Live })));

export type Page = 'home' | 'pcs' | 'pos' | 'debts' | 'cash' | 'expenses' | 'stock' | 'reports' | 'live' | 'settings';

type IconName = Page | 'signout';

function Icon({ name }: { name: IconName }) {
  const common = {
    width: 26,
    height: 26,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
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
    case 'live':
      return (
        <svg {...common}>
          <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />
        </svg>
      );
    case 'cash':
      return (
        <svg {...common}>
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <circle cx="12" cy="12" r="2.5" />
        </svg>
      );
    case 'expenses':
      return (
        <svg {...common}>
          <path d="M6 2h12v20l-3-2-3 2-3-2-3 2z" />
          <path d="M9 8h6M9 12h6" />
        </svg>
      );
    case 'stock':
      return (
        <svg {...common}>
          <path d="M3 7l9-4 9 4-9 4z" />
          <path d="M3 7v10l9 4 9-4V7M12 11v10" />
        </svg>
      );
    case 'reports':
      return (
        <svg {...common}>
          <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      );
    case 'signout':
      return (
        <svg {...common}>
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
        </svg>
      );
  }
}

const TITLES: Record<Page, string> = {
  home: 'Kryefaqja',
  pcs: 'PC-të',
  pos: 'Shitje',
  debts: 'Borxhet',
  cash: 'Arka',
  expenses: 'Shpenzimet',
  stock: 'Stoku',
  reports: 'Raportet',
  live: 'Live tracking',
  settings: 'Cilësimet',
};

export function App() {
  const queryClient = useQueryClient();
  const tr = useT();
  const [signedIn, setSignedIn] = useState(() => getToken() !== null);
  const [page, setPage] = useState<Page>('home');
  const [notice, setNotice] = useState<string | null>(null);
  const me = useMe(signedIn);
  const prefs = usePrefsQuery(signedIn);
  const online = useOnline();

  // The account's look: applied when it arrives, and again when the system theme changes.
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
    queryClient.clear(); // the next person on this tablet must not see the last one's data
    setSignedIn(false);
    setPage('home');
    applyPrefs(DEFAULT_PREFS);
  };

  const user = me.data;
  const canPcs = can(user, PERMISSIONS.STATIONS_VIEW);
  const canPcControl = can(user, PERMISSIONS.STATIONS_CONTROL);
  const canPower = can(user, PERMISSIONS.STATIONS_POWER);
  const canPos = can(user, PERMISSIONS.POS_SELL) && can(user, PERMISSIONS.PRODUCTS_VIEW);
  const canDebts = can(user, PERMISSIONS.CUSTOMERS_VIEW);
  const canCollect = can(user, PERMISSIONS.POS_SELL);
  const canReports = can(user, PERMISSIONS.REPORTS_VIEW);
  const canLive = can(user, PERMISSIONS.LIVE_VIEW);
  const canStaff = can(user, PERMISSIONS.USERS_VIEW);
  const canCash = can(user, PERMISSIONS.CASH_VIEW);
  const canExpenses = can(user, PERMISSIONS.EXPENSES_VIEW);
  const canStock = can(user, PERMISSIONS.PRODUCTS_VIEW);

  const allowed: Record<Page, boolean> = {
    home: true,
    pcs: canPcs,
    pos: canPos,
    debts: canDebts,
    cash: canCash,
    expenses: canExpenses,
    stock: canStock,
    reports: canReports,
    live: canLive,
    settings: true,
  };
  const main: Page[] = ['home', 'pcs', 'pos', 'debts'];
  const more: Page[] = ['live', 'cash', 'expenses', 'stock', 'reports'];
  const current: Page = allowed[page] ? page : 'home';

  let body: ReactNode;
  if (me.isLoading) body = <Loading text={tr('Duke hapur…')} />;
  else if (me.error || !user) body = <QueryError message={tr('Nuk u lexuan llogaria. Provoni përsëri.')} onRetry={() => void me.refetch()} />;
  else
    body = (
      <Suspense fallback={<Loading />}>
        {current === 'home' && (
          <Home
            name={user.fullName || user.username}
            canPcs={canPcs}
            canPos={canPos}
            canDebts={canDebts}
            canCash={canCash}
            onGo={(next) => setPage(next)}
          />
        )}
        {current === 'pcs' && <Pcs canControl={canPcControl} canCredit={canCollect} canPower={canPower} />}
        {current === 'pos' && <Pos />}
        {current === 'debts' && <Debts canCollect={canCollect} />}
        {current === 'cash' && <Cash canOpenClose={can(user, PERMISSIONS.CASH_OPEN_CLOSE)} canMove={can(user, PERMISSIONS.CASH_MOVE)} />}
        {current === 'expenses' && <Expenses canManage={can(user, PERMISSIONS.EXPENSES_MANAGE)} />}
        {current === 'stock' && <Stock />}
        {current === 'reports' && <Reports canProfit={canReports} canStaff={canStaff} />}
        {current === 'live' && <Live />}
        {current === 'settings' && <Settings user={user} onSignOut={() => void signOut()} />}
      </Suspense>
    );

  const navItem = (p: Page) => (
    <button
      key={p}
      type="button"
      className={current === p ? 'tb-nav__item tb-nav__item--on' : 'tb-nav__item'}
      aria-current={current === p ? 'page' : undefined}
      onClick={() => setPage(p)}
    >
      <Icon name={p} />
      <span>{tr(TITLES[p])}</span>
    </button>
  );

  return (
    <NotifyProvider>
      <LiveSalesListener enabled={canLive} />
      <div className="tb">
        <aside className="tb-nav" aria-label={tr('Menyja')}>
          <div className="tb-brand">
            <span className="brand-mark brand-mark--sm">LK</span>
            <strong className="tb-brand__name">LIKApcs</strong>
          </div>
          <span className="tb-nav__group">{tr('Kryesore')}</span>
          {main.filter((p) => allowed[p]).map(navItem)}
          {more.some((p) => allowed[p]) && <span className="tb-nav__group">{tr('Më shumë')}</span>}
          {more.filter((p) => allowed[p]).map(navItem)}
          <div className="tb-nav__foot">
            {navItem('settings')}
            <button type="button" className="tb-nav__item tb-nav__item--danger" onClick={() => void signOut()}>
              <Icon name="signout" />
              <span>{tr('Dil nga llogaria')}</span>
            </button>
          </div>
        </aside>
        <div className="tb-main">
          <header className="tb-top">
            <h1>{tr(TITLES[current])}</h1>
            <span className={online ? 'tb-status tb-status--on' : 'tb-status tb-status--off'} role="status">
              {online ? tr('Lidhur') : tr('Pa lidhje')}
            </span>
          </header>
          {!online && (
            <div className="offline-bar" role="status">
              {tr('Pa lidhje me serverin. Veprimet me para janë të bllokuara.')}
            </div>
          )}
          <main className="tb-content">{body}</main>
        </div>
        {canPcs && <PcAlerts enabled />}
      </div>
    </NotifyProvider>
  );
}
