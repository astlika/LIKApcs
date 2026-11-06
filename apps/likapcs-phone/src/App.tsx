import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, clearToken, getToken, SESSION_LOST } from './api';
import { Login } from './screens/Login';
import { Summary } from './screens/Summary';
import { Pcs } from './screens/Pcs';
import { Debts } from './screens/Debts';

type Tab = 'summary' | 'pcs' | 'debts';

const TABS: { id: Tab; label: string }[] = [
  { id: 'summary', label: 'Përmbledhja' },
  { id: 'pcs', label: 'PC-të' },
  { id: 'debts', label: 'Borxhet' },
];

export function App() {
  const queryClient = useQueryClient();
  const [signedIn, setSignedIn] = useState(() => getToken() !== null);
  const [tab, setTab] = useState<Tab>('summary');
  const [notice, setNotice] = useState<string | null>(null);

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
  };

  return (
    <div className="shell">
      <header className="topbar">
        <strong>LIKApcs</strong>
        <button className="ghost" onClick={signOut}>
          Dil
        </button>
      </header>
      <main className="content">
        {tab === 'summary' && <Summary />}
        {tab === 'pcs' && <Pcs />}
        {tab === 'debts' && <Debts />}
      </main>
      <nav className="tabbar" aria-label="Menyja">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? 'tab tab--on' : 'tab'}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
