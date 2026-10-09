import { useEffect, useState, useSyncExternalStore } from 'react';
import { agent, type AgentSnapshot } from './lib/agent';
import { discoverServers, isDesktopApp } from './lib/native';
import { formatHMS, sessionView } from './lib/protocol';
import { t as translate, type Key } from './lib/i18n';

function useAgent(): AgentSnapshot {
  return useSyncExternalStore(agent.subscribe, agent.getSnapshot, agent.getSnapshot);
}

export function App() {
  const snap = useAgent();
  const t = (key: Key) => translate(snap.state.language, key);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Ctrl+Alt+S opens the technician panel (read-only once paired).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      }
      if (e.key === 'Escape') setSettingsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const notice = snap.state.notice;
  if (snap.state.mode !== 'locked') {
    return (
      <>
        <Overlay snap={snap} notice={notice?.text ?? null} />
      </>
    );
  }

  return (
    <div className="lock">
      <div className="lock__bg" />
      <header className="lock__header">
        <div className="brand">
          <span className="brand__mark">L</span>
          <span>{snap.state.businessName || 'LIKApcs'}</span>
        </div>
        <Clock serverNowMs={snap.serverNowMs} />
      </header>

      <main className="lock__main">
        {snap.state.station && (
          <div className="station">
            <div className="station__code">{snap.state.station.code}</div>
            <div className="station__name">{snap.state.station.name}</div>
          </div>
        )}
        <StatusCard snap={snap} t={t} />
        {notice && <div className="toast">{notice.text}</div>}
      </main>

      <footer className="lock__footer">
        <ConnectionDot snap={snap} t={t} />
        <span className="muted">
          LIKApcs Client {snap.version}
          {snap.identity ? ` · ${snap.identity.hostname}` : ''}
        </span>
      </footer>

      {settingsOpen && <SettingsPanel snap={snap} t={t} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function Clock({ serverNowMs }: { serverNowMs: number }) {
  const d = new Date(serverNowMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const date = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  return (
    <div className="clock">
      <div className="clock__time">
        {hh}:{mm}
      </div>
      <div className="clock__date">{date}</div>
    </div>
  );
}

function StatusCard({ snap, t }: { snap: AgentSnapshot; t: (k: Key) => string }) {
  const { phase } = snap;
  switch (phase.phase) {
    case 'starting':
    case 'connecting':
      return (
        <div className="card">
          <div className="card__title">{t('locked')}</div>
          <div className="card__text">{t('connecting')}</div>
        </div>
      );
    case 'no_server':
      return (
        <div className="card">
          <div className="spinner" />
          <div className="card__title">{t('noServer')}</div>
          <div className="card__text">{t('noServerHint')}</div>
          {snap.lastError && <div className="card__error">{snap.lastError}</div>}
        </div>
      );
    case 'registering':
      return (
        <div className="card">
          <div className="card__title">{t('registering')}</div>
          <div className="card__text">{t('registeringHint')}</div>
          <dl className="facts">
            <dt>{t('computer')}</dt>
            <dd>{snap.identity?.hostname}</dd>
            <dt>{t('machineId')}</dt>
            <dd className="mono">{snap.machineId?.slice(0, 12)}…</dd>
            <dt>{t('server')}</dt>
            <dd className="mono">{snap.pairing?.serverUrl}</dd>
          </dl>
        </div>
      );
    case 'rejected':
      return (
        <div className="card card--warn">
          <div className="card__title">{t('rejected')}</div>
          <div className="card__text">{t('rejectedHint')}</div>
        </div>
      );
    case 'needs_reissue':
      return (
        <div className="card card--warn">
          <div className="card__title">{t('needsReissue')}</div>
          <div className="card__text">{t('needsReissueHint')}</div>
          <dl className="facts">
            <dt>{t('computer')}</dt>
            <dd>{snap.identity?.hostname}</dd>
            <dt>{t('machineId')}</dt>
            <dd className="mono">{snap.machineId?.slice(0, 12)}…</dd>
          </dl>
        </div>
      );
    case 'incompatible':
      return (
        <div className="card card--warn">
          <div className="card__title">{t('incompatible')}</div>
          <div className="card__text">{t('incompatibleHint')}</div>
          <div className="card__error">{phase.detail}</div>
        </div>
      );
    case 'updating':
      return (
        <div className="card">
          <div className="spinner" />
          <div className="card__title">{t('updating')}</div>
          {phase.percent !== null && <div className="card__text">{phase.percent}%</div>}
        </div>
      );
    case 'offline':
    case 'online':
    default:
      return (
        <div className="card">
          <div className="card__title">{t('locked')}</div>
          <div className="card__text">{snap.state.welcomeMessage || t('lockedHint')}</div>
        </div>
      );
  }
}

function ConnectionDot({ snap, t }: { snap: AgentSnapshot; t: (k: Key) => string }) {
  const p = snap.phase.phase;
  const online = p === 'online' || p === 'updating';
  const label =
    p === 'online'
      ? t('connected')
      : p === 'offline'
        ? t('offline')
        : p === 'connecting'
          ? t('connecting')
          : '';
  return (
    <span className={`dot ${online ? 'dot--on' : p === 'offline' ? 'dot--warn' : 'dot--off'}`}>
      <i /> {label}
    </span>
  );
}

/**
 * Session timer strip. In the desktop app this is the whole (320×64) always-on-top window, so a
 * staff message is shown inside the strip instead of a toast.
 */
function Overlay({ snap, notice }: { snap: AgentSnapshot; notice: string | null }) {
  const t = (key: Key) => translate(snap.state.language, key);
  const session = snap.state.session;
  const view = session ? sessionView(session, snap.serverNowMs) : null;
  const offline = snap.phase.phase === 'offline';
  const low = view?.kind === 'countdown' && view.seconds <= 300;
  return (
    <div
      className={`overlay ${low ? 'overlay--low' : ''} ${offline ? 'overlay--offline' : ''} ${
        notice ? 'overlay--notice' : ''
      }`}
    >
      <span className="overlay__code">{snap.state.station?.code ?? 'LIKApcs'}</span>
      {notice ? (
        <span className="overlay__notice" title={notice}>
          {notice}
        </span>
      ) : view ? (
        <>
          <span className="overlay__label">
            {view.paused ? t('paused') : view.kind === 'countdown' ? t('remaining') : t('elapsed')}
          </span>
          <span className="overlay__time">{formatHMS(view.seconds)}</span>
        </>
      ) : (
        <span className="overlay__label">{t('free')}</span>
      )}
      {offline && <span className="overlay__offline" title={t('offlineSession')} />}
    </div>
  );
}

function SettingsPanel({
  snap,
  t,
  onClose,
}: {
  snap: AgentSnapshot;
  t: (k: Key) => string;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(snap.pairing?.serverUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const paired = snap.paired;

  const find = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const found = await discoverServers(2500);
      if (found[0]?.urls[0]) setUrl(found[0].urls[0]);
      else setMsg(t('foundNone'));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await agent.useManualServer(url);
      onClose();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel__head">
        <strong>{t('settingsTitle')}</strong>
        <button className="btn btn--ghost" onClick={onClose}>
          {t('close')}
        </button>
      </div>
      <dl className="facts">
        <dt>{t('version')}</dt>
        <dd>{snap.version}</dd>
        <dt>{t('computer')}</dt>
        <dd>{snap.identity?.hostname}</dd>
        <dt>{t('machineId')}</dt>
        <dd className="mono">{snap.machineId}</dd>
        {snap.state.station && (
          <>
            <dt>{t('station')}</dt>
            <dd>
              {snap.state.station.code} · {snap.state.station.name}
            </dd>
          </>
        )}
      </dl>
      <label className="field">
        <span>{t('language')}</span>
        <select
          value={snap.state.language}
          onChange={(e) => void agent.setLanguage(e.target.value as 'en' | 'sq')}
        >
          <option value="en">English</option>
          <option value="sq">Shqip</option>
        </select>
      </label>
      {paired ? (
        <>
          <label className="field">
            <span>{t('serverAddress')}</span>
            <input value={snap.pairing?.serverUrl ?? ''} readOnly />
          </label>
          <p className="muted small">{t('pairedNote')}</p>
        </>
      ) : (
        <>
          <label className="field">
            <span>{t('serverAddress')}</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://192.168.1.10:4700"
            />
            <small className="muted">{t('serverAddressHint')}</small>
          </label>
          <div className="row">
            {isDesktopApp() && (
              <button className="btn" onClick={() => void find()} disabled={busy}>
                {t('findServer')}
              </button>
            )}
            <button
              className="btn btn--primary"
              onClick={() => void save()}
              disabled={busy || !url}
            >
              {t('save')}
            </button>
            {msg && <span className="muted small">{msg}</span>}
          </div>
        </>
      )}
    </div>
  );
}
