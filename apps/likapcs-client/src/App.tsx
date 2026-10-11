import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import { formatMoney, type ClientAdItem, type ClientDisplayConfig } from '@likapcs/shared';
import { agent, type AgentSnapshot, type ManualConnectResult } from './lib/agent';
import {
  discoverServers,
  isDesktopApp,
  onTrayAction,
  setWidgetLayout,
  type TrayLabels,
} from './lib/native';
import { candidateServerUrls, formatHMS, sessionView, type SessionView } from './lib/protocol';
import { t as translate, type Key, type Language } from './lib/i18n';

function useAgent(): AgentSnapshot {
  return useSyncExternalStore(agent.subscribe, agent.getSnapshot, agent.getSnapshot);
}

type T = (k: Key, vars?: Record<string, string | number>) => string;

/** One status line for the tray menu / tooltip, e.g. "LIKApcs Client · PC-03 · Online". */
function trayLabelsFor(snap: AgentSnapshot): TrayLabels {
  const lang: Language = snap.state.language;
  const tr = (k: Key) => translate(lang, k);
  const p = snap.phase.phase;
  let status: string;
  if (p === 'no_server') status = tr('trayStatusSearching');
  else if (p === 'registering' || p === 'rejected' || p === 'needs_reissue')
    status = tr('trayStatusPending');
  else if (p === 'offline') status = tr('trayStatusOffline');
  else if (snap.state.mode === 'session') status = tr('trayStatusSession');
  else if (snap.state.mode === 'free') status = tr('trayStatusMaintenance');
  else if (p === 'online') status = tr('trayStatusLocked');
  else status = tr('connecting');
  const station = snap.state.station?.code;
  return {
    status: `LIKApcs Client${station ? ` · ${station}` : ''} · ${status}`,
    settings: tr('traySettings'),
    update: tr('trayUpdate'),
    quit: tr('trayQuit'),
  };
}

export function App() {
  const snap = useAgent();
  const t: T = (key, vars) => translate(snap.state.language, key, vars);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const locked = snap.state.mode === 'locked';
  // Mirrors `settingsOpen` for the native tray listener, which is registered once and therefore
  // never sees re-rendered state.
  const settingsOpenRef = useRef(false);
  settingsOpenRef.current = settingsOpen;

  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    void agent.closePanel();
  }, []);
  const openSettings = useCallback(async () => {
    setUnlockOpen(false);
    // Read the live snapshot (not render-time props): during a session the window is the small
    // countdown widget and must first grow into the panel, otherwise nothing would be visible.
    if (agent.getSnapshot().state.mode !== 'locked') await agent.openPanel();
    setSettingsOpen(true);
  }, []);
  const toggleSettings = useCallback(() => {
    if (settingsOpenRef.current) closeSettings();
    else void openSettings();
  }, [closeSettings, openSettings]);

  // Ctrl+Alt+S opens the settings panel; Ctrl+Alt+A the staff unlock (lock screen only).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        toggleSettings();
      }
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'a' && locked) {
        e.preventDefault();
        setUnlockOpen((v) => !v);
        setSettingsOpen(false);
      }
      if (e.key === 'Escape') {
        if (settingsOpen) closeSettings();
        setUnlockOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen, locked, closeSettings, toggleSettings]);

  // Tray (native) → actions: a left click on the icon toggles the settings panel, the context
  // menu offers settings / update / quit. The native side already refuses "quit" while locked.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let lastClick = 0;
    void onTrayAction((action) => {
      if (action === 'settings') {
        // Windows reports a double click as two clicks — treat clicks within 350 ms as one.
        const now = Date.now();
        if (now - lastClick < 350) return;
        lastClick = now;
        toggleSettings();
      } else if (action === 'update') {
        void openSettings();
        void agent.checkUpdates('manual');
      } else if (action === 'quit') {
        void agent.quit().then((ok) => {
          if (!ok) {
            setFlash(translate(agent.getSnapshot().state.language, 'quitLocked'));
            window.setTimeout(() => setFlash(null), 6000);
          }
        });
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [openSettings, toggleSettings]);

  // Tray texts follow the language and status.
  useEffect(() => {
    agent.setTrayLabels(trayLabelsFor);
  }, []);

  // Widget footprint / corner chosen by the owner → native window (moves live during a session).
  const widgetSize = snap.state.display?.widgetSize ?? 'normal';
  const widgetPosition = snap.state.display?.widgetPosition ?? 'top-right';
  useEffect(() => {
    void setWidgetLayout(widgetSize, widgetPosition);
  }, [widgetSize, widgetPosition]);

  // Back to the lock screen (e.g. maintenance expired) while the panel was open: keep it open
  // there, the window is fullscreen again anyway.
  useEffect(() => {
    if (locked && snap.windowMode === 'panel') void agent.closePanel();
    if (locked) setSettingsOpen(false);
  }, [locked, snap.windowMode]);

  const notice = snap.state.notice;
  if (!locked) {
    if (snap.windowMode === 'panel' && settingsOpen) {
      return (
        <div className="panel-window">
          <SettingsPanel snap={snap} t={t} onClose={closeSettings} />
        </div>
      );
    }
    return <Overlay snap={snap} notice={notice?.text ?? null} />;
  }

  const display = snap.state.display;
  const lockTitle =
    display?.lockTitle === 'station' && snap.state.station
      ? snap.state.station.code
      : snap.state.businessName || 'LIKApcs';
  const showAds =
    Boolean(display?.ads.enabled) &&
    snap.ads.length > 0 &&
    snap.paired &&
    snap.phase.phase === 'online' &&
    !settingsOpen &&
    !unlockOpen;

  return (
    <div className={`lock${showAds ? ' lock--ads' : ''}`}>
      <div className="lock__bg" />
      <header className="lock__header">
        <div className="brand" data-testid="lock-title">
          <span className="brand__mark">L</span>
          <span>{lockTitle}</span>
        </div>
        <Clock serverNowMs={snap.serverNowMs} />
      </header>

      <main className="lock__main">
        {showAds && display ? (
          <AdsSlideshow
            items={snap.ads}
            display={display}
            language={snap.state.language}
            station={snap.state.station}
          />
        ) : (
          snap.state.station && (
            <div className="station">
              <div className="station__code">{snap.state.station.code}</div>
              <div className="station__name">{snap.state.station.name}</div>
            </div>
          )
        )}
        <StatusCard snap={snap} t={t} compact={showAds} />
        {notice && <div className="toast">{notice.text}</div>}
        {flash && (
          <div className="toast" role="status">
            {flash}
          </div>
        )}
      </main>

      {/* The lock screen carries no footer text at all; the only extra element is a small
          pill while the server cannot be reached, so staff see the problem at a glance. */}
      <footer className="lock__footer">
        {snap.phase.phase === 'offline' && (
          <span className="offline-pill" role="status">
            <i />
            {t('offlineBanner')}
          </span>
        )}
      </footer>

      {settingsOpen && <SettingsPanel snap={snap} t={t} onClose={closeSettings} />}
      {unlockOpen && snap.paired && (
        <StaffUnlockDialog snap={snap} t={t} onClose={() => setUnlockOpen(false)} />
      )}
    </div>
  );
}

/**
 * Staff unlock (Ctrl+Alt+A on the lock screen). The credentials go to the server, which verifies
 * them and — when allowed — sends the `unlock` command; the dialog only relays and reports.
 */
function StaffUnlockDialog({
  snap,
  t,
  onClose,
}: {
  snap: AgentSnapshot;
  t: T;
  onClose: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | null>(null);
  const [until, setUntil] = useState<string | null>(null);
  const connected = snap.phase.phase === 'online';

  const submit = async () => {
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    const result = await agent.staffUnlock(username.trim(), password);
    setBusy(false);
    if (result.ok) {
      setUntil(result.until);
      setPassword('');
      window.setTimeout(onClose, 1500);
      return;
    }
    setPassword('');
    const map: Record<string, Key> = {
      unauthorized: 'errInvalidCredentials',
      account_locked: 'errLocked',
      forbidden: 'errNoPermission',
      session_active: 'errSessionActive',
      conflict: 'errNotConnected',
      rate_limited: 'errRateLimited',
      network: 'errNetwork',
      not_paired: 'errNetwork',
    };
    setError(map[result.error] ?? 'errGeneric');
  };

  const hhmm = (iso: string) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div className="panel panel--center" role="dialog" aria-labelledby="staff-unlock-title">
      <div className="panel__head">
        <strong id="staff-unlock-title">{t('staffUnlockTitle')}</strong>
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t('staffUnlockHint')}
      </p>
      {until ? (
        <div className="unlock-ok" role="status">
          {t('unlockedUntil')} {hhmm(until)}
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span>{t('username')}</span>
            <input
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={busy}
              data-testid="staff-username"
            />
          </label>
          <label className="field">
            <span>{t('password')}</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              data-testid="staff-password"
            />
          </label>
          {error && (
            <div className="card__error" role="alert">
              {t(error)}
            </div>
          )}
          {!connected && !error && <div className="card__error">{t('errNotConnected')}</div>}
          <div className="row">
            <button className="btn btn--ghost" type="button" onClick={onClose} disabled={busy}>
              {t('cancel')}
            </button>
            <button
              className="btn btn--primary"
              type="submit"
              disabled={busy || !connected || !username.trim() || !password}
            >
              {busy ? t('unlocking') : t('unlock')}
            </button>
          </div>
        </form>
      )}
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

function StatusCard({
  snap,
  t,
  compact = false,
}: {
  snap: AgentSnapshot;
  t: T;
  compact?: boolean;
}) {
  const { phase } = snap;
  // While the slideshow is on, the online lock card shrinks to one line under the pictures.
  if (compact && (phase.phase === 'online' || phase.phase === 'offline')) {
    return (
      <div className="card card--strip" data-testid="lock-strip">
        <span className="card__title">{t('locked')}</span>
        <span className="card__text">{snap.state.welcomeMessage || t('lockedHint')}</span>
      </div>
    );
  }
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
          {snap.discoveryHint && (
            <div className="card__warn" role="status">
              {t('discoveryHint', { name: snap.discoveryHint.name, url: snap.discoveryHint.url })}
            </div>
          )}
          {snap.lastError && <div className="card__error">{snap.lastError}</div>}
          <ManualConnect t={t} snap={snap} intro={t('noServerManual')} />
        </div>
      );
    case 'registering':
      return (
        <div className="card">
          <div className="card__title">{t('registering')}</div>
          <div className="card__text">{t('registeringHint2')}</div>
          <dl className="facts">
            <dt>{t('computer')}</dt>
            <dd>
              <strong>{snap.identity?.hostname}</strong>
            </dd>
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

/** "23 min" / "1h 05m" / "45 s" — the compact duration of the minimal widget. */
function compactDuration(seconds: number, t: T): string {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe} ${t('secShort')}`;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours === 0) return `${minutes} ${t('minShort')}`;
  return `${hours}${t('hourShort')} ${String(minutes).padStart(2, '0')}${t('minShort')}`;
}

/** Paid (prepaid) or running amount owed (postpaid) — null when the server gave no figure. */
function moneyLine(
  view: SessionView | null,
  display: ClientDisplayConfig | null,
  language: Language,
  t: T,
): { label: string; amount: string; kind: 'paid' | 'owed' } | null {
  if (!view || !display?.widgetShowPayment) return null;
  const options = { currency: display.currency, locale: language };
  if (view.paidCents !== null)
    return { label: t('paid'), amount: formatMoney(view.paidCents, options), kind: 'paid' };
  if (view.owedCents !== null)
    return { label: t('owed'), amount: formatMoney(view.owedCents, options), kind: 'owed' };
  return null;
}

/**
 * Countdown widget. In the desktop app this is the whole always-on-top window (its size and
 * corner follow the owner's settings), draggable by its surface (`data-tauri-drag-region`), so a
 * staff message is shown inside it instead of a toast. Everything displayed is derived from server
 * time and server-provided billing facts (see Clock / sessionView) — the PC never computes billing.
 *
 * Two styles: `detailed` (code + label, big timer, paid / owed, progress bar) and `minimal` (one
 * calm line such as "PC 01 · 23 min · 1.50 €").
 */
function Overlay({ snap, notice }: { snap: AgentSnapshot; notice: string | null }) {
  const t = (key: Key) => translate(snap.state.language, key);
  const session = snap.state.session;
  const display = snap.state.display;
  const view = session ? sessionView(session, snap.serverNowMs) : null;
  const offline = snap.phase.phase === 'offline';
  const low = view?.kind === 'countdown' && !view.paused && view.seconds <= 300;
  const critical = view?.kind === 'countdown' && !view.paused && view.seconds <= 60;
  const maintenance = snap.state.mode === 'free' ? snap.state.maintenance : null;
  const maintenanceLeft =
    maintenance && Number.isFinite(maintenance.untilServerMs)
      ? Math.max(0, Math.round((maintenance.untilServerMs - snap.serverNowMs) / 1000))
      : null;
  const minimal = display?.widgetStyle === 'minimal' && !maintenance && !notice;
  const money = moneyLine(view, display, snap.state.language, t);
  // Progress of a prepaid session (fraction of planned time still left).
  let fraction: number | null = null;
  if (session?.endsAt && view?.kind === 'countdown') {
    const total = (Date.parse(session.endsAt) - Date.parse(session.startedAt)) / 1000;
    if (total > 0) fraction = Math.min(1, Math.max(0, view.seconds / total));
  }
  const code = snap.state.station?.code ?? 'LIKApcs';
  const cls = [
    'overlay',
    `overlay--${display?.widgetSize ?? 'normal'}`,
    minimal ? 'overlay--minimal' : '',
    low ? 'overlay--low' : '',
    critical ? 'overlay--critical' : '',
    offline ? 'overlay--offline' : '',
    notice ? 'overlay--notice' : '',
    maintenance ? 'overlay--maintenance' : '',
    view?.paused ? 'overlay--paused' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (minimal) {
    const text = view ? (view.paused ? t('paused') : compactDuration(view.seconds, t)) : t('free');
    return (
      <div className={cls} data-tauri-drag-region data-testid="overlay">
        <div className="overlay__line" data-tauri-drag-region>
          <span className="overlay__mark" data-tauri-drag-region>
            L
          </span>
          <span className="overlay__code" data-tauri-drag-region>
            {code}
          </span>
          <span className="overlay__dot" aria-hidden />
          <span className="overlay__mini-time" data-tauri-drag-region data-testid="overlay-time">
            {text}
          </span>
          {money && (
            <>
              <span className="overlay__dot" aria-hidden />
              <span
                className={`overlay__mini-money overlay__mini-money--${money.kind}`}
                data-tauri-drag-region
                data-testid="overlay-money"
                title={money.label}
              >
                {money.amount}
              </span>
            </>
          )}
          {offline && <span className="overlay__offline" title={t('offlineSession')} />}
        </div>
        {fraction !== null && (
          <div className="overlay__bar" aria-hidden>
            <span style={{ width: `${fraction * 100}%` }} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cls} data-tauri-drag-region data-testid="overlay">
      <div className="overlay__top" data-tauri-drag-region>
        <span className="overlay__brand" data-tauri-drag-region>
          <span className="overlay__mark">L</span>
          <span className="overlay__code">{code}</span>
        </span>
        <span className="overlay__label" data-tauri-drag-region>
          {notice
            ? ''
            : maintenance
              ? t('maintenance')
              : view
                ? view.paused
                  ? t('paused')
                  : view.kind === 'countdown'
                    ? t('remaining')
                    : t('elapsed')
                : t('free')}
        </span>
        {offline && <span className="overlay__offline" title={t('offlineSession')} />}
      </div>
      {notice ? (
        <div className="overlay__notice" title={notice}>
          {notice}
        </div>
      ) : maintenance ? (
        <div className="overlay__main">
          <div className="overlay__maint" data-tauri-drag-region>
            {maintenance.byName && (
              <span className="overlay__by">
                {t('maintenanceBy')} {maintenance.byName}
              </span>
            )}
            {maintenanceLeft !== null && (
              <span className="overlay__time overlay__time--sm">
                {t('locksIn')} {formatHMS(maintenanceLeft)}
              </span>
            )}
          </div>
          <button
            type="button"
            className="overlay__lock"
            onClick={() => void agent.staffLock()}
            data-testid="overlay-lock"
          >
            {t('lockNow')}
          </button>
        </div>
      ) : view ? (
        <div className="overlay__main" data-tauri-drag-region>
          <span className="overlay__time" data-tauri-drag-region data-testid="overlay-time">
            {formatHMS(view.seconds)}
          </span>
          {money && (
            <span
              className={`overlay__money overlay__money--${money.kind}`}
              data-tauri-drag-region
              data-testid="overlay-money"
            >
              <small>{money.label}</small>
              <strong>{money.amount}</strong>
            </span>
          )}
        </div>
      ) : (
        <div className="overlay__main" data-tauri-drag-region>
          <span className="overlay__time overlay__time--sm">{t('free')}</span>
        </div>
      )}
      {fraction !== null && !notice && (
        <div className="overlay__bar" aria-hidden>
          <span style={{ width: `${fraction * 100}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * Lock-screen product slideshow. Pictures are decoded *before* they are shown (an `Image()`
 * preload gate per slide) and two layers cross over with CSS transforms only, so there is never a
 * flash of an empty frame or a half-loaded photo. `layout`: `card` (one product on a glass card),
 * `full` (edge-to-edge photo with a caption), `grid` (a classic box of up to four products that
 * advances one page at a time). The interval, transition and price flag come from the owner.
 */
function AdsSlideshow({
  items,
  display,
  language,
  station,
}: {
  items: ClientAdItem[];
  display: ClientDisplayConfig;
  language: Language;
  station: { code: string; name: string } | null;
}) {
  const { layout, transition, intervalSeconds, showPrice } = display.ads;
  const perPage = layout === 'grid' ? 4 : 1;
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const [page, setPage] = useState(0);
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const [layers, setLayers] = useState<{ a: number | null; b: number | null; front: 'a' | 'b' }>({
    a: 0,
    b: null,
    front: 'a',
  });
  // The station pill repeats the PC code only when the lock title is the brand (never twice), and
  // not over the grid's own frames.
  const showPill = station !== null && display.lockTitle !== 'station' && layout !== 'grid';

  // Preload every picture once; a slide only becomes eligible when all of its pictures decoded.
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const item of items) {
      if (requested.current.has(item.imageUrl)) continue;
      requested.current.add(item.imageUrl);
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => setReady((r) => ({ ...r, [item.id]: true }));
      img.onerror = () => {
        requested.current.delete(item.imageUrl); // retried on the next list refresh
        setReady((r) => ({ ...r, [item.id]: false }));
      };
      img.src = item.imageUrl;
    }
  }, [items]);

  const pageItems = useCallback(
    (index: number) => items.slice(index * perPage, index * perPage + perPage),
    [items, perPage],
  );
  const pageReady = useCallback(
    (index: number) => {
      const slice = pageItems(index);
      return slice.length > 0 && slice.every((item) => ready[item.id] === true);
    },
    [pageItems, ready],
  );

  // Advance on the owner's interval — only onto a fully decoded page (skips broken pictures).
  useEffect(() => {
    if (pages <= 1) return;
    const timer = window.setInterval(
      () => {
        setPage((current) => {
          for (let step = 1; step <= pages; step += 1) {
            const candidate = (current + step) % pages;
            if (pageReady(candidate)) return candidate;
          }
          return current;
        });
      },
      Math.max(3, intervalSeconds) * 1000,
    );
    return () => window.clearInterval(timer);
  }, [pages, intervalSeconds, pageReady]);

  // The current page is not decoded yet (start-up, or its picture failed): jump to the first
  // page that is, so the very first frame shown is a complete one.
  const currentReady = pageReady(page);
  useEffect(() => {
    if (currentReady) return;
    for (let i = 0; i < pages; i += 1) {
      if (pageReady(i)) {
        if (i !== page) setPage(i);
        return;
      }
    }
  }, [currentReady, pages, pageReady, page]);

  // Two-layer crossfade: a *ready* incoming page is mounted on the back layer, then brought to
  // the front; the old one slides / fades out underneath and is unmounted on the next change.
  useEffect(() => {
    if (!currentReady) return;
    setLayers((l) => {
      const frontIndex = l.front === 'a' ? l.a : l.b;
      if (frontIndex === page) return l;
      return l.front === 'a' ? { ...l, b: page, front: 'b' } : { ...l, a: page, front: 'a' };
    });
  }, [page, currentReady]);

  const frontIndex = layers.front === 'a' ? layers.a : layers.b;
  if (frontIndex === null || !pageReady(frontIndex)) {
    return (
      <div className={`ads ads--${layout}`} data-testid="ads" data-state="loading">
        {showPill && (
          <div className="ads__station">
            <span className="ads__code">{station.code}</span>
          </div>
        )}
      </div>
    );
  }

  const money = (cents: number) =>
    formatMoney(cents, { currency: display.currency, locale: language });
  const renderPage = (index: number | null, key: 'a' | 'b') => {
    if (index === null) return null;
    const slice = pageItems(index);
    const front = layers.front === key;
    return (
      <div
        key={key}
        className={`ads__layer ads__layer--${transition} ${front ? 'is-front' : 'is-back'}`}
        aria-hidden={!front}
        onAnimationEnd={(e) => {
          // The incoming slide has fully covered the old one → drop the old layer entirely, so
          // nothing can ever bleed through (and the GPU keeps exactly one picture to composite).
          if (!front || e.target !== e.currentTarget) return;
          setLayers((l) => (l.front === 'a' ? { ...l, b: null } : { ...l, a: null }));
        }}
      >
        {layout === 'grid' ? (
          <div className="ads__grid">
            {slice.map((item) => (
              <figure key={item.id} className="ads__cell">
                <img src={item.imageUrl} alt="" draggable={false} />
                <figcaption>
                  <span className="ads__name">{item.name}</span>
                  {showPrice && <span className="ads__price">{money(item.priceCents)}</span>}
                </figcaption>
              </figure>
            ))}
          </div>
        ) : (
          slice.map((item) => (
            <figure key={item.id} className={`ads__slide ads__slide--${layout}`}>
              <img src={item.imageUrl} alt="" draggable={false} />
              <figcaption>
                {item.categoryName && <span className="ads__cat">{item.categoryName}</span>}
                <span className="ads__name">{item.name}</span>
                {showPrice && <span className="ads__price">{money(item.priceCents)}</span>}
              </figcaption>
            </figure>
          ))
        )}
      </div>
    );
  };

  return (
    <div className={`ads ads--${layout}`} data-testid="ads" data-state="ready" data-page={page}>
      {renderPage(layers.a, 'a')}
      {renderPage(layers.b, 'b')}
      {showPill && (
        <div className="ads__station">
          <span className="ads__code">{station.code}</span>
        </div>
      )}
      {pages > 1 && (
        <div className="ads__dots" aria-hidden>
          {Array.from({ length: Math.min(pages, 12) }, (_, i) => (
            <i key={i} className={i === page % 12 ? 'is-on' : ''} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Manual server address entry. Used on the lock screen while no server was found and inside the
 * settings panel. The agent probes the address before saving it and reports a precise reason.
 */
function ManualConnect({
  t,
  snap,
  intro,
  onDone,
}: {
  t: T;
  snap: AgentSnapshot;
  intro?: string;
  onDone?: () => void;
}) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ManualConnectResult | null>(null);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await agent.connectManually(url);
      setResult(r);
      if (r.ok) onDone?.();
    } finally {
      setBusy(false);
    }
  };
  const find = async () => {
    setBusy(true);
    setResult(null);
    try {
      const found = await discoverServers(2500);
      const first = found[0] ? candidateServerUrls(found[0])[0] : undefined;
      if (first) setUrl(first.replace(/^http:\/\//, ''));
      else setResult({ ok: false, reason: 'unreachable', url: '' });
    } finally {
      setBusy(false);
    }
  };

  const message = (() => {
    if (!result) return null;
    if (result.ok) return t('connectedTo', { name: result.name, version: result.version });
    const url = result.url ?? '';
    switch (result.reason) {
      case 'invalid':
        return t('errAddressInvalid');
      case 'timeout':
        return t('errAddressTimeout', { url });
      case 'http':
      case 'not_likapcs':
        return t('errAddressNotServer', { url });
      case 'different_installation':
        return t('errAddressDifferent', { url, name: result.name ?? '' });
      default:
        return url ? t('errAddressUnreachable', { url }) : t('foundNone');
    }
  })();

  return (
    <form className="connect" onSubmit={(e) => void submit(e)}>
      {intro && <p className="muted small">{intro}</p>}
      <div className="connect__row">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t('serverAddressPlaceholder')}
          aria-label={t('serverAddress')}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          data-testid="server-address"
        />
        <button className="btn btn--primary" type="submit" disabled={busy || !url.trim()}>
          {busy ? t('connecting2') : t('connect')}
        </button>
        {isDesktopApp() && !snap.paired && (
          <button className="btn" type="button" onClick={() => void find()} disabled={busy}>
            {t('findServer')}
          </button>
        )}
      </div>
      {message && (
        <div className={result?.ok ? 'unlock-ok' : 'card__error'} role="status">
          {message}
        </div>
      )}
    </form>
  );
}

/**
 * Settings panel (Ctrl+Alt+S, or the tray). Connection settings are editable only before pairing
 * or while staff unlocked the PC — a customer must never be able to re-point the client.
 */
function SettingsPanel({ snap, t, onClose }: { snap: AgentSnapshot; t: T; onClose: () => void }) {
  const unlockedByStaff = snap.state.mode === 'free';
  const canEditConnection = !snap.paired || unlockedByStaff;
  // Never under a customer session; a paired, locked PC needs the staff unlock first.
  const canQuit = unlockedByStaff || !snap.paired;
  const [checking, setChecking] = useState(false);
  const [quitMsg, setQuitMsg] = useState<string | null>(null);
  const updating = snap.phase.phase === 'updating';

  const checkNow = async () => {
    setChecking(true);
    try {
      await agent.checkUpdates('manual');
    } finally {
      setChecking(false);
    }
  };
  const forget = async () => {
    if (!window.confirm(t('forgetConfirm'))) return;
    await agent.forgetPairing();
  };
  const quit = async () => {
    const ok = await agent.quit();
    if (!ok) setQuitMsg(t('quitLocked'));
  };

  const phaseLabel = (() => {
    const p = snap.phase.phase;
    if (p === 'online') return t('connected');
    if (p === 'offline') return t('offline');
    if (p === 'no_server') return t('noServer');
    if (p === 'registering') return t('registering');
    if (p === 'rejected') return t('rejected');
    if (p === 'needs_reissue') return t('needsReissue');
    if (p === 'incompatible') return t('incompatible');
    if (p === 'updating') return t('updating');
    return t('connecting');
  })();
  const checkedAt = snap.updateCheckedAt
    ? new Date(snap.updateCheckedAt).toLocaleTimeString(undefined, { hour12: false })
    : t('updateNever');

  return (
    <div className="panel panel--settings" role="dialog" aria-labelledby="settings-title">
      <div className="panel__head">
        <strong id="settings-title">{t('settingsTitle')}</strong>
        <button className="btn btn--ghost" onClick={onClose}>
          {t('close')}
        </button>
      </div>
      <div className="panel__body">
        <section className="section">
          <h3>{t('sectionConnection')}</h3>
          <dl className="facts">
            <dt>{t('status')}</dt>
            <dd>{phaseLabel}</dd>
            <dt>{t('serverAddress')}</dt>
            <dd className="mono">{snap.pairing?.serverUrl ?? '—'}</dd>
            <dt>{t('installation')}</dt>
            <dd>
              {snap.paired ? t('pairedStatus') : t('notPaired')}
              {snap.state.station ? ` · ${snap.state.station.code} ${snap.state.station.name}` : ''}
            </dd>
          </dl>
          {canEditConnection ? (
            <>
              <ManualConnect t={t} snap={snap} />
              {snap.paired && (
                <div className="row">
                  <button className="btn" type="button" onClick={() => void forget()}>
                    {t('forgetPairing')}
                  </button>
                  <span className="muted small">{t('forgetPairingHint')}</span>
                </div>
              )}
            </>
          ) : (
            <p className="muted small">{t('pairedOnlyWhenUnlocked')}</p>
          )}
        </section>

        <section className="section">
          <h3>{t('sectionUpdates')}</h3>
          <dl className="facts">
            <dt>{t('version')}</dt>
            <dd>
              {snap.version}
              {snap.updateAvailable
                ? ` · ${t('updateAvailable', { version: snap.updateAvailable })}`
                : snap.updateCheckedAt && !snap.updateError
                  ? ` · ${t('updateUpToDate')}`
                  : ''}
            </dd>
            <dt>{t('updateChecked')}</dt>
            <dd>{checkedAt}</dd>
          </dl>
          {snap.updateError && (
            <div className="card__error">{t('updateError', { error: snap.updateError })}</div>
          )}
          {updating ? (
            <div className="unlock-ok">{t('updateInstalling')}</div>
          ) : (
            <div className="row">
              <button
                className="btn"
                type="button"
                onClick={() => void checkNow()}
                disabled={checking || !isDesktopApp()}
              >
                {checking ? t('connecting2') : t('updateCheck')}
              </button>
              {snap.updateAvailable && (
                <button
                  className="btn btn--primary"
                  type="button"
                  onClick={() => void agent.installUpdateNow()}
                  disabled={!!snap.state.session}
                  title={snap.state.session ? t('updateDuringSession') : undefined}
                >
                  {t('updateInstall')}
                </button>
              )}
            </div>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={snap.autoUpdate}
              onChange={(e) => void agent.setAutoUpdate(e.target.checked)}
            />
            <span>{t('updateAuto')}</span>
          </label>
          <p className="muted small">{t('updateDuringSession')}</p>
        </section>

        <section className="section">
          <h3>{t('sectionGeneral')}</h3>
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
        </section>

        <section className="section">
          <h3>{t('sectionAbout')}</h3>
          <dl className="facts">
            <dt>{t('computer')}</dt>
            <dd>{snap.identity?.hostname}</dd>
            <dt>{t('machineId')}</dt>
            <dd className="mono">{snap.machineId}</dd>
          </dl>
          <div className="row">
            <button
              className="btn"
              type="button"
              onClick={() => void quit()}
              disabled={!canQuit}
              title={canQuit ? undefined : t('quitHint')}
            >
              {t('quit')}
            </button>
            <span className="muted small">{quitMsg ?? t('quitHint')}</span>
          </div>
        </section>
      </div>
    </div>
  );
}
