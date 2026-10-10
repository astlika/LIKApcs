import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ServerCrash } from 'lucide-react';
import { useI18n, type TranslationKey } from '../i18n';
import { Button } from './ui/primitives';
import {
  embeddedServerInfo,
  embeddedServerLaunch,
  embeddedServerLog,
  embeddedServerStartup,
  type EmbeddedStartupState,
} from '../lib/desktop';

type GateState = 'checking' | 'starting' | 'ready' | 'failed';

/** Give up after this long; the server's own phases normally finish in a few seconds. */
const TIMEOUT_MS = 150_000;
/** Show the "taking longer than usual" hint and the live log from here on. */
const SLOW_MS = 20_000;
const POLL_MS = 400;

const PHASE_KEY: Record<EmbeddedStartupState['phase'], TranslationKey> = {
  starting: 'gate.phases.starting',
  'database-init': 'gate.phases.databaseInit',
  'database-start': 'gate.phases.databaseStart',
  'database-repair': 'gate.phases.databaseRepair',
  migrations: 'gate.phases.migrations',
  listening: 'gate.phases.listening',
  failed: 'gate.failed',
};

/**
 * On the main PC the Admin app owns the bundled server: before rendering anything that needs the
 * API we make sure the server answers, starting it when necessary. The server reports its start-up
 * phase in `startup.json`; we poll that (plus the health endpoint) so the screen shows what is
 * happening, how long it has been going on, and — on failure — the real error with the log, right
 * away. Secondary Admin PCs and the browser build pass straight through.
 */
export function ServerGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [state, setState] = useState<GateState>('checking');
  const [phase, setPhase] = useState<EmbeddedStartupState['phase'] | 'launching'>('launching');
  const [detail, setDetail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logFile, setLogFile] = useState<string | null>(null);
  const [logTail, setLogTail] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const startedAt = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const run = async () => {
      const info = await embeddedServerInfo().catch(() => null);
      if (cancelled) return;
      if (!info || !info.available || info.running) {
        setState('ready');
        return;
      }
      setLogFile(info.logFile);
      setState('starting');
      setPhase('launching');
      setDetail(null);
      setError(null);
      setLogTail(null);
      startedAt.current = Date.now();
      try {
        await embeddedServerLaunch();
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setState('failed');
        return;
      }
      const tick = async () => {
        if (cancelled) return;
        const status = await embeddedServerStartup().catch(() => null);
        if (cancelled) return;
        const now = Date.now() - startedAt.current;
        setElapsed(now);
        if (status?.running) {
          setState('ready');
          return;
        }
        const s = status?.startup ?? null;
        if (s) {
          setPhase(s.phase);
          setDetail(s.detail);
          if (s.phase === 'failed') {
            setError(s.error);
            setLogTail(await embeddedServerLog(16 * 1024).catch(() => null));
            setState('failed');
            return;
          }
        }
        if (now > SLOW_MS && (now / POLL_MS) % 5 < 1) {
          // Live log while it is slow (every ~2 s) — the user sees progress, not a frozen spinner.
          setLogTail(await embeddedServerLog(8 * 1024).catch(() => null));
        }
        if (now > TIMEOUT_MS) {
          setError(t('gate.timeout', { seconds: Math.round(TIMEOUT_MS / 1000) }));
          setLogTail(await embeddedServerLog(16 * 1024).catch(() => null));
          setState('failed');
          return;
        }
        timer = window.setTimeout(() => void tick(), POLL_MS);
      };
      void tick();
    };
    void run();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // `t` is stable per language; re-running on language change would restart the server.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  if (state === 'ready') return <>{children}</>;

  const seconds = Math.floor(elapsed / 1000);
  const slow = state === 'starting' && elapsed > SLOW_MS;
  const phaseText = phase === 'launching' ? t('gate.phases.launching') : t(PHASE_KEY[phase]);

  return (
    <div className="auth">
      <div
        className="card auth__card"
        style={{ textAlign: 'center', maxWidth: slow || state === 'failed' ? 640 : undefined }}
      >
        <div className="auth__brand" style={{ justifyContent: 'center' }}>
          <span className="auth__logo">L</span>
          <div className="auth__title">{t('app.name')}</div>
        </div>
        {state === 'failed' ? (
          <div className="stack" style={{ alignItems: 'center', gap: 12 }}>
            <ServerCrash size={36} className="text-danger" />
            <div style={{ fontWeight: 600 }}>{t('gate.failed')}</div>
            {error && (
              <div
                className="muted"
                style={{ fontSize: 12.5, wordBreak: 'break-word' }}
                data-testid="gate-error"
              >
                {error}
              </div>
            )}
            {logFile && (
              <div className="muted" style={{ fontSize: 12 }}>
                {t('gate.logHint')} <code>{logFile}</code>
              </div>
            )}
            <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
              <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
                {t('gate.retry')}
              </Button>
              {logTail && (
                <Button onClick={() => setShowLog((v) => !v)}>
                  {showLog ? t('gate.hideLog') : t('gate.showLog')}
                </Button>
              )}
            </div>
            {showLog && logTail && <LogBox text={logTail} />}
          </div>
        ) : (
          <div className="stack" style={{ alignItems: 'center', gap: 12 }}>
            <span className="spinner" style={{ width: 32, height: 32 }} />
            <div style={{ fontWeight: 600 }}>{t('gate.starting')}</div>
            <div className="muted" style={{ fontSize: 12.5 }} data-testid="gate-phase">
              {phaseText}
              {detail ? ` (${detail})` : ''}
            </div>
            <div className="faint" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
              {t('gate.elapsed', { seconds })}
            </div>
            {slow && (
              <>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {t('gate.slow')}
                </div>
                {logTail && <LogBox text={logTail} />}
              </>
            )}
            {!slow && (
              <div className="muted" style={{ fontSize: 12.5 }}>
                {t('gate.startingHint')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LogBox({ text }: { text: string }) {
  const lines = text.trimEnd().split('\n');
  return (
    <pre
      style={{
        width: '100%',
        maxHeight: 220,
        overflow: 'auto',
        textAlign: 'left',
        fontSize: 11,
        lineHeight: 1.4,
        padding: 10,
        borderRadius: 8,
        background: 'var(--bg-sunken, rgba(0,0,0,0.25))',
        border: '1px solid var(--border)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {lines.slice(-40).join('\n')}
    </pre>
  );
}
