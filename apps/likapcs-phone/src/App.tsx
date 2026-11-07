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
import { Loading, QueryError } from './components/ui';

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
  const [signedIn, setSignedIn] = useState(() => getToken() !== null);
  const [tab, setTab] = useState<Tab>('home');
  const [notice, setNotice] = useState<string | null>(null);
  const me = useMe(signedIn);
  const online = useOnline();

  useEffect(() => {
    const lost = () => {
      queryClient.clear();
      setSignedIn(false);
      setNotice('Sesioni skadoi. Hyni përsëri.');
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
  };

  const user = me.data;
  const canPcs = can(user, PERMISSIONS.STATIONS_VIEW);
  const canPcControl = can(user, PERMISSIONS.STATIONS_CONTROL);
  const canPos = can(user, PERMISSIONS.POS_SELL) && can(user, PERMISSIONS.PRODUCTS_VIEW);
  const canDebts = can(user, PERMISSIONS.CUSTOMERS_VIEW);
  const canCollect = can(user, PERMISSIONS.POS_SELL);

  const tabs: Tab[] = ['home', ...(canPcs ? (['pcs'] as Tab[]) : []), ...(canPos ? (['pos'] as Tab[]) : []), ...(canDebts ? (['debts'] as Tab[]) : [])];
  const active: Tab = tabs.includes(tab) ? tab : 'home';

  let body: ReactNode;
  if (me.isLoading) body = <Loading text="Duke hapur…" />;
  else if (me.error || !user) body = <QueryError message="Nuk u lexuan llogaria. Provoni përsëri." onRetry={() => void me.refetch()} />;
  else if (active === 'home')
    body = (
      <Home
        name={user.fullName || user.username}
        canPcs={canPcs}
        canPos={canPos}
        canDebts={canDebts}
        onGo={setTab}
      />
    );
  else if (active === 'pcs') body = <Pcs canControl={canPcControl} />;
  else if (active === 'pos') body = <Pos />;
  else body = <Debts canCollect={canCollect} />;

  return (
    <NotifyProvider>
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark brand-mark--sm">LK</span>
            <strong>{TITLES[active]}</strong>
          </div>
          <button type="button" className="ghost small-btn" onClick={signOut}>
            Dil
          </button>
        </header>
        {!online && (
          <div className="offline-bar" role="status">
            Pa lidhje me serverin. Veprimet me para janë të bllokuara.
          </div>
        )}
        <main className="content">{body}</main>
        {tabs.length > 1 && (
          <nav className="tabbar" aria-label="Menyja">
            {tabs.map((t) => (
              <button
                key={t}
                type="button"
                className={active === t ? 'tab tab--on' : 'tab'}
                aria-current={active === t ? 'page' : undefined}
                onClick={() => setTab(t)}
              >
                <Icon name={t} />
                <span>{t === 'home' ? 'Kryefaqja' : TITLES[t]}</span>
              </button>
            ))}
          </nav>
        )}
      </div>
    </NotifyProvider>
  );
}
