import { useEffect, useState, type ReactNode } from 'react';
import { ServerCrash } from 'lucide-react';
import { useI18n } from '../i18n';
import { Button } from './ui/primitives';
import { embeddedServerInfo, embeddedServerStart } from '../lib/desktop';

type GateState = 'checking' | 'starting' | 'ready' | 'failed';

/**
 * On the main PC the Admin app owns the bundled server: before rendering anything that needs the
 * API we make sure the server answers, starting it when necessary ("Starting LIKApcs server…").
 * Secondary Admin PCs and the browser build pass straight through.
 */
export function ServerGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [state, setState] = useState<GateState>('checking');
  const [error, setError] = useState<string | null>(null);
  const [logFile, setLogFile] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const info = await embeddedServerInfo().catch(() => null);
      if (cancelled) return;
      if (!info || !info.available || info.running) {
        setState('ready');
        return;
      }
      setLogFile(info.logFile);
      setState('starting');
      try {
        await embeddedServerStart();
        if (!cancelled) setState('ready');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (state === 'ready') return <>{children}</>;

  return (
    <div className="auth">
      <div className="card auth__card" style={{ textAlign: 'center' }}>
        <div className="auth__brand" style={{ justifyContent: 'center' }}>
          <span className="auth__logo">L</span>
          <div className="auth__title">{t('app.name')}</div>
        </div>
        {state === 'failed' ? (
          <div className="stack" style={{ alignItems: 'center', gap: 12 }}>
            <ServerCrash size={36} className="text-danger" />
            <div style={{ fontWeight: 600 }}>{t('gate.failed')}</div>
            {error && (
              <div className="muted" style={{ fontSize: 12.5, wordBreak: 'break-word' }}>
                {error}
              </div>
            )}
            {logFile && (
              <div className="muted" style={{ fontSize: 12 }}>
                {t('gate.logHint')} <code>{logFile}</code>
              </div>
            )}
            <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
              {t('gate.retry')}
            </Button>
          </div>
        ) : (
          <div className="stack" style={{ alignItems: 'center', gap: 12 }}>
            <span className="spinner" style={{ width: 32, height: 32 }} />
            <div style={{ fontWeight: 600 }}>{t('gate.starting')}</div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {t('gate.startingHint')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
