import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import { formatMoney, type ClientRequestOptions, type SessionRequest } from '@likapcs/shared';
import {
  agent,
  type AgentSnapshot,
  type CustomerActionError,
  type ManualConnectResult,
} from './lib/agent';
import {
  discoverServers,
  isDesktopApp,
  onTrayAction,
  reapplyWidgetWindow,
  reportWebviewReady,
  setWidgetLayout,
  widgetWindowSizeOk,
  type TrayLabels,
} from './lib/native';
import { baseWindowModeOf, candidateServerUrls } from './lib/protocol';
import { t as translate, type Key, type Language } from './lib/i18n';
import { PausedScreen } from './PausedScreen';
import { Overlay, effectiveWidgetStyle } from './Overlay';
import { OrderPanel, ORDER_STATUS_KEY } from './OrderPanel';
import { AdsSlideshow } from './AdsSlideshow';

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
  // Customer login / "request time" dialog (lock screen) or "+ time" panel (during a session).
  const [customerOpen, setCustomerOpen] = useState(false);
  // "Order" panel (drinks / snacks from the seat, 0.10.0).
  const [orderOpen, setOrderOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const locked = snap.state.mode === 'locked';
  const paused = snap.state.mode === 'session' && snap.state.session?.status === 'paused';
  // Locked PC or paused session: the window covers the whole screen (see baseWindowModeOf).
  const covered = baseWindowModeOf(snap.state) === 'locked';
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
    setCustomerOpen(false);
    setOrderOpen(false);
    // Read the live snapshot (not render-time props): during a session the window is the small
    // countdown widget and must first grow into the panel, otherwise nothing would be visible.
    if (agent.getSnapshot().state.mode !== 'locked') await agent.openPanel();
    setSettingsOpen(true);
  }, []);
  const closeCustomer = useCallback(() => {
    setCustomerOpen(false);
    void agent.closePanel();
  }, []);
  const openCustomer = useCallback(async () => {
    setUnlockOpen(false);
    setSettingsOpen(false);
    setOrderOpen(false);
    if (agent.getSnapshot().state.mode !== 'locked') await agent.openPanel();
    setCustomerOpen(true);
  }, []);
  const closeOrder = useCallback(() => {
    setOrderOpen(false);
    void agent.closePanel();
  }, []);
  const openOrder = useCallback(async () => {
    setUnlockOpen(false);
    setSettingsOpen(false);
    setCustomerOpen(false);
    // Lock screen (0.14.0): the window is fullscreen already — the panel opens inline.
    if (agent.getSnapshot().state.mode !== 'locked' && !(await agent.openPanel())) return;
    setOrderOpen(true);
  }, []);
  const toggleSettings = useCallback(() => {
    if (settingsOpenRef.current) closeSettings();
    else void openSettings();
  }, [closeSettings, openSettings]);

  // 0.17.1 handshake: tell the native side the UI mounted. If this never arrives (blank window,
  // broken WebView2…), the Rust guard shows a native message instead of leaving a silent PC.
  useEffect(() => {
    void reportWebviewReady();
  }, []);

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
        if (customerOpen) closeCustomer();
        if (orderOpen) closeOrder();
        setUnlockOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    settingsOpen,
    customerOpen,
    orderOpen,
    locked,
    closeSettings,
    closeCustomer,
    closeOrder,
    toggleSettings,
  ]);

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

  // Widget design / footprint / corner chosen by the owner → native window (moves live during a
  // session). A design without room for words gives way to the classic card while a staff notice,
  // maintenance or an order flash must be shown (0.13.0).
  const widgetSize = snap.state.display?.widgetSize ?? 'normal';
  const widgetPosition = snap.state.display?.widgetPosition ?? 'top-right';
  const widgetStyle = effectiveWidgetStyle(snap.state.display?.widgetStyle, {
    notice: Boolean(snap.state.notice),
    maintenance: snap.state.mode === 'free' && Boolean(snap.state.maintenance),
    flash: Boolean(snap.orderFlash),
  });
  useEffect(() => {
    void setWidgetLayout(widgetSize, widgetPosition, widgetStyle);
  }, [widgetSize, widgetPosition, widgetStyle]);

  // Windows can finish the fullscreen → widget transition *after* the native resize landed (11
  // restores the window's old rect), leaving the countdown off-screen: the webview then reports a
  // size that is not the widget's, so ask again until it is. Self-heals within a second.
  useEffect(() => {
    if (snap.windowMode !== 'overlay') return;
    let cancelled = false;
    let tries = 0;
    const timer = window.setTimeout(async () => {
      while (!cancelled && tries < 4 && !widgetWindowSizeOk()) {
        tries += 1;
        await reapplyWidgetWindow();
        await new Promise((r) => setTimeout(r, 350));
      }
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [snap.windowMode, widgetSize, widgetPosition, widgetStyle]);

  // Back to the lock screen (e.g. maintenance expired) while the panel was open: keep it open
  // there, the window is fullscreen again anyway.
  useEffect(() => {
    if (covered && snap.windowMode === 'panel') void agent.closePanel();
    if (covered) {
      setSettingsOpen(false);
      setOrderOpen(false);
    }
  }, [covered, snap.windowMode]);
  // Lock ⇄ session flips (an approved request, a session end) close the customer dialog: the
  // overlay / lock screen that follows starts clean.
  useEffect(() => {
    setCustomerOpen(false);
  }, [snap.state.mode]);

  const notice = snap.state.notice;
  const customerLogin = Boolean(snap.state.display?.customerLogin) && snap.paired;
  const inSession = snap.state.mode === 'session' && snap.state.session !== null;
  if (!covered) {
    if (snap.windowMode === 'panel' && settingsOpen) {
      return (
        <div className="panel-window">
          <SettingsPanel snap={snap} t={t} onClose={closeSettings} />
        </div>
      );
    }
    if (snap.windowMode === 'panel' && customerOpen) {
      return (
        <div className="panel-window">
          <CustomerDialog snap={snap} t={t} onClose={closeCustomer} />
        </div>
      );
    }
    if (snap.windowMode === 'panel' && orderOpen) {
      return (
        <div className="panel-window">
          <OrderPanel snap={snap} onClose={closeOrder} />
        </div>
      );
    }
    return (
      <Overlay
        snap={snap}
        notice={notice?.text ?? null}
        onRequestTime={
          // Reserved time (prepaid / end pay) can be extended; open time runs until stopped.
          customerLogin &&
          snap.state.session?.billing &&
          snap.state.session.billing.billingMode !== 'postpaid'
            ? () => void openCustomer()
            : null
        }
        onPause={
          inSession && snap.state.display?.customerPause && snap.phase.phase === 'online'
            ? () => void agent.customerPause()
            : null
        }
        onOrder={inSession && snap.state.display?.orders ? () => void openOrder() : null}
      />
    );
  }

  const display = snap.state.display;
  const lockTitle =
    display?.lockTitle === 'station' && snap.state.station
      ? snap.state.station.code
      : snap.state.businessName || 'LIKApcs';
  if (paused) {
    return (
      <PausedScreen snap={snap} lockTitle={lockTitle}>
        {flash && (
          <div className="toast" role="status">
            {flash}
          </div>
        )}
        {settingsOpen && <SettingsPanel snap={snap} t={t} onClose={closeSettings} />}
      </PausedScreen>
    );
  }
  const showAds =
    Boolean(display?.ads.enabled) &&
    snap.ads.length > 0 &&
    snap.paired &&
    snap.phase.phase === 'online' &&
    !settingsOpen &&
    !unlockOpen &&
    !customerOpen;

  // A click anywhere on the locked screen — left or right button (0.14.0) — opens the customer
  // login; without customer login, the menu. Staff use the faint "admin" word or Ctrl+Alt+A.
  // Clicks inside dialogs / controls are left alone.
  const ordersLocked = Boolean(display?.orders && display?.ordersLocked);
  const onLockActivate = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!snap.paired || settingsOpen || unlockOpen || customerOpen || orderOpen) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, a, textarea, select, .panel, .lock__modal')) return;
    if (customerLogin) void openCustomer();
    else if (ordersLocked) void openOrder();
  };
  const onLockClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    onLockActivate(e);
  };
  const onLockContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    onLockActivate(e);
  };

  // With the slideshow on, every piece of chrome is the owner's choice (Settings › Client
  // screen): brand, clock, status strip, ticker. In full-screen mode the pictures run edge to
  // edge and whatever stays on becomes a translucent overlay.
  const ads = showAds && display ? display.ads : null;
  const fullscreen = Boolean(ads?.fullscreen);
  const showBrand = !ads || ads.showBrand;
  const showClock = !ads || ads.showClock;
  const showStatus = !ads || ads.showStatus;
  const ticker = ads?.tickerText.trim() ?? '';
  const lockClass = [
    'lock',
    showAds ? 'lock--ads' : '',
    fullscreen ? 'lock--fullscreen' : '',
    ads ? `ads__theme--${ads.background}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const slideshow =
    showAds && display ? (
      <AdsSlideshow
        items={snap.ads}
        albums={snap.adAlbums}
        display={display}
        language={snap.state.language}
        station={snap.state.station}
      />
    ) : null;

  return (
    <div
      className={lockClass}
      onClick={onLockClick}
      onContextMenu={onLockContextMenu}
      data-testid="lock-screen"
      data-fullscreen={fullscreen ? 'true' : undefined}
    >
      <div className="lock__bg" />
      {fullscreen && slideshow}
      <header className="lock__header">
        {showBrand ? (
          <div className="brand" data-testid="lock-title">
            <span className="brand__mark">L</span>
            <span>{lockTitle}</span>
          </div>
        ) : (
          <span />
        )}
        {showClock && <Clock serverNowMs={snap.serverNowMs} />}
      </header>

      <main className="lock__main">
        {showAds
          ? !fullscreen && slideshow
          : snap.state.station && (
              <div className="station">
                <div className="station__code">{snap.state.station.code}</div>
                <div className="station__name">{snap.state.station.name}</div>
              </div>
            )}
        {showStatus && <StatusCard snap={snap} t={t} compact={showAds} />}
        {notice && <div className="toast">{notice.text}</div>}
        {flash && (
          <div className="toast" role="status">
            {flash}
          </div>
        )}
      </main>

      {/* The lock screen carries no footer text of its own; the only extra elements are the
          owner's optional ticker line and a small pill while the server cannot be reached, so
          staff see the problem at a glance. */}
      <footer className="lock__footer">
        {snap.phase.phase === 'offline' && (
          <span className="offline-pill" role="status">
            <i />
            {t('offlineBanner')}
          </span>
        )}
        {ticker && <Ticker text={ticker} />}
        {snap.request && !customerOpen && (
          <RequestPill request={snap.request} t={t} onOpen={() => void openCustomer()} />
        )}
      </footer>

      {/* Corner words, deliberately quiet (they brighten on hover): "Client" and "Menu" on the
          right — a click anywhere does the same as "Client" — and the staff's "admin" on the
          left. Nothing on the screen says "administrator". */}
      {snap.paired && !customerOpen && !settingsOpen && !unlockOpen && !orderOpen && (
        <div className="lock__links">
          <button
            type="button"
            className="customer-link customer-link--staff"
            onClick={() => setUnlockOpen(true)}
            data-testid="staff-link"
            aria-label={t('staffLink')}
          >
            {t('staffLink')}
          </button>
          <span className="lock__links-spacer" />
          {ordersLocked && (
            <button
              type="button"
              className="customer-link customer-link--menu"
              onClick={() => void openOrder()}
              data-testid="menu-button"
            >
              {t('menuButton')}
            </button>
          )}
          {customerLogin && (
            <button
              type="button"
              className="customer-link"
              onClick={() => void openCustomer()}
              data-testid="customer-button"
            >
              {t('customerButton')}
            </button>
          )}
        </div>
      )}
      {snap.orderFlash && !orderOpen && (
        <div className="toast toast--order" role="status" data-testid="lock-order-flash">
          {t('orderNumber', { n: snap.orderFlash.order.number })} ·{' '}
          {snap.orderFlash.order.preparedAt &&
          (snap.orderFlash.order.status === 'accepted' || snap.orderFlash.order.status === 'paid')
            ? t('orderStatusPrepared')
            : t(ORDER_STATUS_KEY[snap.orderFlash.order.status])}
        </div>
      )}

      {settingsOpen && <SettingsPanel snap={snap} t={t} onClose={closeSettings} />}
      {unlockOpen && snap.paired && (
        <StaffUnlockDialog snap={snap} t={t} onClose={() => setUnlockOpen(false)} />
      )}
      {customerOpen && snap.paired && <CustomerDialog snap={snap} t={t} onClose={closeCustomer} />}
      {orderOpen && snap.paired && (
        <div
          className="lock__modal"
          data-testid="lock-order-modal"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeOrder();
          }}
        >
          <OrderPanel snap={snap} onClose={closeOrder} />
        </div>
      )}
    </div>
  );
}

/** Why a request ended: staff text as typed; server cancel codes translated for the customer. */
function requestReason(request: SessionRequest, t: T): string | null {
  if (!request.reason) return null;
  if (request.status !== 'cancelled') return request.reason;
  const codes: Record<string, Key> = {
    session_started: 'reasonSessionStarted',
    session_extended: 'reasonSessionExtended',
    session_ended: 'reasonSessionEnded',
    device_revoked: 'reasonStationUnavailable',
    station_disabled: 'reasonStationUnavailable',
  };
  const key = codes[request.reason];
  return key ? t(key) : request.reason === 'customer' ? null : request.reason;
}

/** Small status line on the lock screen while a request waits / was just answered. */
function RequestPill({
  request,
  t,
  onOpen,
}: {
  request: SessionRequest;
  t: T;
  onOpen: () => void;
}) {
  const text =
    request.status === 'pending'
      ? t('requestWaiting')
      : request.status === 'approved'
        ? t('requestApproved')
        : request.status === 'rejected'
          ? t('requestRejected')
          : t('requestCancelled');
  const reason = requestReason(request, t);
  return (
    <button
      type="button"
      className={`request-pill request-pill--${request.status}`}
      onClick={onOpen}
      data-testid="request-pill"
      data-status={request.status}
    >
      {request.status === 'pending' && <i />}
      {text}
      {reason && <span className="muted"> · {reason}</span>}
    </button>
  );
}

const CUSTOMER_ERRORS: Partial<Record<CustomerActionError, Key>> = {
  invalid_credentials: 'errCustomerCredentials',
  locked: 'errCustomerLockedUntil',
  login_disabled: 'errCustomerLoginDisabled',
  blocked: 'errCustomerBlocked',
  requests_disabled: 'customerLoginOff',
  rate_limited: 'errRateLimited',
  network: 'errNetwork',
  not_paired: 'errNetwork',
  request_pending: 'requestPending',
  session_active: 'requestSessionActive',
  no_session: 'requestNoneSession',
  unauthorized: 'errCustomerCredentials',
};

/**
 * Customer flow: sign in (username + PIN given by the staff) → pick a duration or package → wait
 * for the staff's answer. The dialog follows the agent's state, so a decision pushed by the server
 * switches the view by itself. Nothing here unlocks the PC: an approval arrives as a session
 * command from the server.
 */
function CustomerDialog({ snap, t, onClose }: { snap: AgentSnapshot; t: T; onClose: () => void }) {
  const language = snap.state.language;
  const connected = snap.phase.phase === 'online';
  const signedIn = snap.customer && Date.parse(snap.customer.expiresAt) > Date.now();
  const request = snap.request;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | null>(null);
  const [options, setOptions] = useState<ClientRequestOptions | null>(null);
  const [choice, setChoice] = useState<{ minutes?: number; packageId?: string } | null>(null);
  const step: 'login' | 'choose' | 'waiting' | 'result' =
    request?.status === 'pending' ? 'waiting' : request ? 'result' : signedIn ? 'choose' : 'login';
  // The account shown is the live one (pushed by the server on every top-up / payment); the
  // login answer is only the first value of it.
  const account = snap.account ?? (signedIn ? (snap.customer?.customer ?? null) : null);
  useEffect(() => {
    if (step === 'choose') void agent.refreshAccount();
  }, [step]);

  // What may be requested right now (quick durations with prices, packages, staff presence).
  // While nothing can be requested (PC disabled, someone else's session) it re-asks every few
  // seconds so the options appear by themselves once the situation changes.
  const [optionsTick, setOptionsTick] = useState(0);
  useEffect(() => {
    if (step !== 'choose') return;
    let cancelled = false;
    void agent.requestOptions().then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setOptions(res.options);
        setChoice((current) => {
          if (current?.packageId && res.options.packages.some((p) => p.id === current.packageId))
            return current;
          if (current?.minutes && res.options.quickMinutes.includes(current.minutes))
            return current;
          const first = res.options.quickMinutes[0];
          return first ? { minutes: first } : null;
        });
        if (res.options.kind === 'none')
          window.setTimeout(() => !cancelled && setOptionsTick((n) => n + 1), 5000);
      } else setError(CUSTOMER_ERRORS[res.error] ?? 'errGeneric');
    });
    return () => {
      cancelled = true;
    };
  }, [step, snap.state.mode, optionsTick]);

  // An approval needs no acknowledgement: the time is already running. The panel closes by itself.
  const approved = step === 'result' && request?.status === 'approved';
  useEffect(() => {
    if (!approved) return;
    const timer = window.setTimeout(() => {
      agent.dismissRequest();
      onClose();
    }, 2500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onClose is stable enough per step
  }, [approved]);

  const login = async () => {
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    const res = await agent.customerLogin(username.trim(), password);
    setBusy(false);
    setPassword('');
    if (!res.ok) setError(CUSTOMER_ERRORS[res.error] ?? 'errGeneric');
  };
  const send = async () => {
    if (!options || options.kind === 'none' || !choice || busy) return;
    setBusy(true);
    setError(null);
    const res = await agent.createRequest({
      kind: options.kind,
      ...(choice.packageId ? { packageId: choice.packageId } : { minutes: choice.minutes! }),
    });
    setBusy(false);
    if (!res.ok) setError(CUSTOMER_ERRORS[res.error] ?? 'errGeneric');
  };
  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    await agent.cancelRequest();
    setBusy(false);
  };
  const money = (cents: number | null | undefined) =>
    cents === null || cents === undefined
      ? ''
      : formatMoney(cents, { currency: options?.currency ?? 'EUR', locale: language });
  // "30 min", "1 h", "1 h 30 min" — whole hours without a dangling "00min".
  const minutesLabel = (m: number) => {
    if (m < 60) return `${m} ${t('minShort')}`;
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest === 0
      ? `${h} ${t('hourShort')}`
      : `${h} ${t('hourShort')} ${rest} ${t('minShort')}`;
  };
  const requestedLabel = (r: SessionRequest) =>
    r.packageName
      ? `${r.packageName} · ${minutesLabel(r.durationMinutes)}`
      : minutesLabel(r.durationMinutes);

  return (
    <div
      className="panel panel--center panel--customer"
      role="dialog"
      aria-labelledby="customer-title"
      data-testid="customer-dialog"
      data-step={step}
    >
      <div className="panel__head">
        <strong id="customer-title">
          {step === 'login'
            ? t('customerTitle')
            : step === 'choose'
              ? options?.kind === 'extend'
                ? t('requestExtendTitle')
                : t('requestTitle')
              : step === 'waiting'
                ? t('requestWaiting')
                : request?.status === 'approved'
                  ? t('requestApproved')
                  : request?.status === 'rejected'
                    ? t('requestRejected')
                    : t('requestCancelled')}
        </strong>
        {signedIn && snap.customer && (
          <span className="customer-who" data-testid="customer-who">
            {t('customerHello', { name: snap.customer.customer.name })}
            {step === 'choose' && (
              <button
                type="button"
                className="link"
                onClick={() => void agent.customerLogout()}
                data-testid="customer-signout"
              >
                {t('customerSignOut')}
              </button>
            )}
          </span>
        )}
      </div>

      {step === 'login' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void login();
          }}
        >
          <p className="muted small" style={{ marginTop: 0 }}>
            {t('customerHint')}
          </p>
          <label className="field">
            <span>{t('username')}</span>
            <input
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={busy}
              data-testid="customer-username"
            />
          </label>
          <label className="field">
            <span>{t('customerPin')}</span>
            <input
              type="password"
              autoComplete="off"
              inputMode="numeric"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              data-testid="customer-password"
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
              disabled={busy || !connected || !username.trim() || password.length < 4}
              data-testid="customer-signin"
            >
              {busy ? t('customerSigningIn') : t('customerSignIn')}
            </button>
          </div>
        </form>
      )}

      {step === 'choose' && (
        <div>
          {account && (snap.state.display?.wallet || account.walletBalanceCents > 0) && (
            <div
              className={`customer-account ${account.walletBalanceCents > 0 ? 'customer-account--funded' : ''}`}
              data-testid="customer-account"
              title={t('customerBalanceHint')}
            >
              <span className="customer-account__label">{t('customerBalance')}</span>
              <strong className="customer-account__amount" data-testid="customer-balance">
                {money(account.walletBalanceCents)}
              </strong>
              {account.walletBalanceCents <= 0 && (
                <span className="customer-account__hint small">{t('customerBalanceEmpty')}</span>
              )}
            </div>
          )}
          {account && account.balanceDueCents > 0 && (
            <p className="customer-debt small" data-testid="customer-debt">
              {t('customerDebt', { amount: money(account.balanceDueCents) })}
            </p>
          )}
          {!options && !error && <p className="muted small">{t('connecting')}</p>}
          {options && options.kind === 'none' && (
            <p className="muted" data-testid="request-none">
              {snap.state.mode === 'session' ? t('requestNoneSession') : t('requestNone')}
            </p>
          )}
          {options && options.kind !== 'none' && (
            <>
              <p className="muted small" style={{ marginTop: 0 }}>
                {options.kind === 'extend' ? t('requestExtendHint') : t('requestHint')}
              </p>
              {options.quickMinutes.length > 0 && (
                <div className="choice-group">
                  <span className="choice-group__label">{t('requestQuick')}</span>
                  <div className="choices">
                    {options.quickMinutes.map((m) => {
                      const active = !choice?.packageId && choice?.minutes === m;
                      const price = options.quickPrices[String(m)];
                      return (
                        <button
                          key={m}
                          type="button"
                          className={`choice ${active ? 'choice--active' : ''}`}
                          onClick={() => setChoice({ minutes: m })}
                          data-testid="request-quick"
                          data-minutes={m}
                          aria-pressed={active}
                        >
                          <strong>{minutesLabel(m)}</strong>
                          {price !== null && price !== undefined && <small>{money(price)}</small>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {options.packages.length > 0 && (
                <div className="choice-group">
                  <span className="choice-group__label">{t('requestPackages')}</span>
                  <div className="choices">
                    {options.packages.map((p) => {
                      const active = choice?.packageId === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          className={`choice ${active ? 'choice--active' : ''}`}
                          onClick={() => setChoice({ packageId: p.id })}
                          data-testid="request-package"
                          aria-pressed={active}
                        >
                          <strong>{p.name}</strong>
                          <small>
                            {minutesLabel(p.durationMinutes)} · {money(p.priceCents)}
                          </small>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {!options.staffOnline && <p className="muted small">{t('requestStaffAway')}</p>}
            </>
          )}
          {error && (
            <div className="card__error" role="alert">
              {t(error)}
            </div>
          )}
          <div className="row">
            <button className="btn btn--ghost" type="button" onClick={onClose} disabled={busy}>
              {t('cancel')}
            </button>
            {options && options.kind !== 'none' && (
              <button
                className="btn btn--primary"
                type="button"
                onClick={() => void send()}
                disabled={busy || !connected || !choice}
                data-testid="request-send"
              >
                {busy ? t('requestSending') : t('requestSend')}
              </button>
            )}
          </div>
        </div>
      )}

      {step === 'waiting' && request && (
        <div data-testid="request-waiting">
          <div className="request-wait">
            <span className="spinner" aria-hidden />
            <div>
              <strong>{requestedLabel(request)}</strong>
              <p className="muted small" style={{ margin: '4px 0 0' }}>
                {request.kind === 'extend'
                  ? t('requestWaitingExtendHint')
                  : t('requestWaitingHint')}
              </p>
            </div>
          </div>
          {options && !options.staffOnline && (
            <p className="muted small">{t('requestStaffAway')}</p>
          )}
          <div className="row">
            <button className="btn btn--ghost" type="button" onClick={onClose} disabled={busy}>
              {t('ok')}
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => void cancel()}
              disabled={busy || !connected}
              data-testid="request-cancel"
            >
              {t('requestCancel')}
            </button>
          </div>
        </div>
      )}

      {step === 'result' && request && (
        <div data-testid="request-result" data-status={request.status}>
          <div className={`request-result request-result--${request.status}`}>
            <strong>{requestedLabel(request)}</strong>
            {requestReason(request, t) && (
              <p style={{ margin: '6px 0 0' }}>
                {t('requestReason', { reason: requestReason(request, t)! })}
              </p>
            )}
          </div>
          <div className="row">
            <button
              className="btn btn--primary"
              type="button"
              onClick={() => {
                agent.dismissRequest();
                if (request.status === 'approved' || !signedIn) onClose();
              }}
              data-testid="request-ok"
            >
              {request.status === 'approved' || !signedIn ? t('ok') : t('back')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Staff unlock (a click on the lock screen or Ctrl+Alt+A). The credentials go to the server,
 * which verifies them and — when allowed — sends the `unlock` command; the dialog only relays and
 * reports. The owner can pre-fill the username (Settings › Client screen) so staff type only the
 * password.
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
  const presetUser = snap.state.display?.staffLoginUsername?.trim() ?? '';
  const [username, setUsername] = useState(presetUser);
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
              autoFocus={presetUser === ''}
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
              autoFocus={presetUser !== ''}
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

/** Owner's scrolling line at the bottom of the locked screen (`client.ads_ticker_text`). The
 *  text is doubled so the loop is seamless; speed follows the length (~6 chars / second). */
function Ticker({ text }: { text: string }) {
  const seconds = Math.max(14, Math.round(text.length / 6) + 6);
  return (
    <div className="ticker" data-testid="ticker" aria-label={text}>
      <div className="ticker__track" style={{ animationDuration: `${seconds}s` }}>
        <span>{text}</span>
        <span aria-hidden="true">{text}</span>
      </div>
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
