import type { StationSummary } from '@likapcs/shared';
import { api, duration, money } from '../api';
import { useLive } from '../useLive';

const STATUS_LABEL: Record<string, string> = {
  available: 'E lirë',
  occupied: 'E zënë',
  paused: 'Në pauzë',
  locked: 'E kyçur',
  maintenance: 'Mirëmbajtje',
  updating: 'Po përditësohet',
  offline: 'Offline',
  error: 'Gabim',
  disabled: 'Joaktive',
};

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'off'> = {
  available: 'ok',
  occupied: 'ok',
  paused: 'warn',
  locked: 'warn',
  maintenance: 'warn',
  updating: 'warn',
  offline: 'off',
  error: 'off',
  disabled: 'off',
};

/** Live list of the PCs: status, who is on it, and the time that is running. */
export function Pcs() {
  const { data, error, isLoading, refetch } = useLive(['stations'], () =>
    api<StationSummary[]>('/stations'),
  );

  if (isLoading) return <p className="muted">Duke ngarkuar…</p>;
  if (error || !data) {
    return (
      <div className="card">
        <p className="alert alert--danger">Nuk u ngarkuan PC-të.</p>
        <button className="primary" onClick={() => void refetch()}>
          Provo përsëri
        </button>
      </div>
    );
  }

  const shown = data.filter((s) => s.isEnabled);
  return (
    <div className="stack">
      <h2>PC-të ({shown.length})</h2>
      {shown.map((s) => {
        const session = s.activeSession;
        return (
          <div className="card pc" key={s.id}>
            <div className="row row--between">
              <strong className="pc__name">{s.name}</strong>
              <span className={`badge badge--${STATUS_TONE[s.status] ?? 'off'}`}>
                {STATUS_LABEL[s.status] ?? s.status}
              </span>
            </div>
            <p className="muted">{s.code}{s.zone ? ` · ${s.zone}` : ''}</p>
            {session && (
              <div className="pc__session">
                <p>
                  {session.customerName ?? 'Pa emër klienti'} · {session.billingMode === 'prepaid' ? 'Me pagesë paraprake' : 'Pas përdorimit'}
                </p>
                <p>
                  Koha: <strong>{duration(session.elapsedSeconds)}</strong>
                  {session.remainingSeconds !== null && (
                    <>
                      {' '}· mbeten <strong>{duration(session.remainingSeconds)}</strong>
                    </>
                  )}
                </p>
                <p>
                  Çmimi deri tani: <strong>{money(session.currentPriceCents)}</strong>
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
