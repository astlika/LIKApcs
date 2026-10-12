/**
 * Full-screen cover while the session is paused (0.10.0). A paused PC is really paused: nothing
 * behind this screen can be used until the session resumes — by the staff in LIKApcs, by the
 * customer with the Resume button (when the owner allows it), or by itself when a customer pause
 * reaches its limit. Everything shown is server state: who paused, the frozen timer, the
 * automatic-resume instant. The PC never resumes on its own; "Resume" only asks the server.
 */
import { useEffect, useState } from 'react';
import { agent, type AgentSnapshot, type CustomerActionError } from './lib/agent';
import { formatHMS, sessionView } from './lib/protocol';
import { t as translate, type Key } from './lib/i18n';

const RESUME_ERRORS: Partial<Record<CustomerActionError, Key>> = {
  resume_disabled: 'errResumeDisabled',
  network: 'errNetwork',
  not_paired: 'errNetwork',
  rate_limited: 'errRateLimited',
};

export function PausedScreen({
  snap,
  lockTitle,
  children,
}: {
  snap: AgentSnapshot;
  lockTitle: string;
  /** Dialogs hosted on the cover (settings panel). */
  children?: React.ReactNode;
}) {
  const t = (key: Key, vars?: Record<string, string | number>) =>
    translate(snap.state.language, key, vars);
  const session = snap.state.session;
  const display = snap.state.display;
  const view = session ? sessionView(session, snap.serverNowMs) : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | null>(null);
  const canResume = Boolean(display?.customerResume) && snap.phase.phase === 'online';
  const autoResumeIn =
    session?.autoResumeAt !== null && session?.autoResumeAt !== undefined
      ? Math.max(0, Math.round((Date.parse(session.autoResumeAt) - snap.serverNowMs) / 1000))
      : null;

  // The server's `session.resume` mirror ends the busy state (the screen itself goes away); a
  // refused call shows why. A stuck "Resuming…" is impossible: 6 s later the button is back.
  useEffect(() => {
    if (!busy) return;
    const timer = window.setTimeout(() => setBusy(false), 6000);
    return () => window.clearTimeout(timer);
  }, [busy]);

  const resume = async () => {
    if (busy || !canResume) return;
    setBusy(true);
    setError(null);
    const res = await agent.customerResume();
    if (!res.ok) {
      setBusy(false);
      setError(RESUME_ERRORS[res.error] ?? 'errGeneric');
    }
  };

  const by = session?.pausedBy ?? 'staff';
  const whyKey: Key =
    by === 'customer' ? 'pausedByYou' : by === 'grace' ? 'pausedByGrace' : 'pausedByStaff';

  return (
    <div className="lock lock--paused" data-testid="paused-screen" data-paused-by={by}>
      <div className="lock__bg" />
      <header className="lock__header">
        <div className="brand" data-testid="lock-title">
          <span className="brand__mark">L</span>
          <span>{lockTitle}</span>
        </div>
        {snap.state.station && <span className="paused__station">{snap.state.station.code}</span>}
      </header>
      <main className="lock__main">
        <div className="paused">
          <div className="paused__icon" aria-hidden>
            <i />
            <i />
          </div>
          <h1 className="paused__title">{t('pausedTitle')}</h1>
          <p className="paused__why" data-testid="paused-why">
            {t(whyKey)}
          </p>
          {view && (
            <div className="paused__time" data-testid="paused-time">
              <small>{view.kind === 'countdown' ? t('pausedTimeLeft') : t('pausedTimeUsed')}</small>
              <strong>{formatHMS(view.seconds)}</strong>
            </div>
          )}
          {autoResumeIn !== null && (
            <p className="paused__auto" data-testid="paused-auto-resume">
              {t('pausedResumesIn', { time: formatHMS(autoResumeIn) })}
            </p>
          )}
          {canResume ? (
            <button
              type="button"
              className="btn btn--primary paused__resume"
              onClick={() => void resume()}
              disabled={busy}
              data-testid="paused-resume"
            >
              {busy ? t('resuming') : t('resume')}
            </button>
          ) : (
            <p className="muted">{t('pausedStaffHint')}</p>
          )}
          {canResume && <p className="muted small">{t('pausedResumeHint')}</p>}
          {error && (
            <p className="card__error" role="alert">
              {t(error)}
            </p>
          )}
        </div>
        {snap.state.notice && <div className="toast">{snap.state.notice.text}</div>}
      </main>
      <footer className="lock__footer">
        {snap.phase.phase === 'offline' && (
          <span className="offline-pill" role="status">
            <i />
            {t('offlineBanner')}
          </span>
        )}
      </footer>
      {children}
    </div>
  );
}
