import type { DebtsOverview } from '@likapcs/shared';
import { api, money } from '../api';
import { useLive } from '../useLive';

/** Open debts at a glance. Paying a debt from the phone comes in a later step. */
export function Debts() {
  const { data, error, isLoading, refetch } = useLive(['debts'], () =>
    api<DebtsOverview>('/debts/overview'),
  );

  if (isLoading) return <p className="muted">Duke ngarkuar…</p>;
  if (error || !data) {
    return (
      <div className="card">
        <p className="alert alert--danger">Nuk u ngarkuan borxhet.</p>
        <button className="primary" onClick={() => void refetch()}>
          Provo përsëri
        </button>
      </div>
    );
  }

  return (
    <div className="stack">
      <h2>Borxhet</h2>
      <div className="grid2">
        <div className="stat stat--warn">
          <span className="muted">Të pa paguara</span>
          <strong>{money(data.openCents)}</strong>
          <span className="muted">{data.openCount} borxhe</span>
        </div>
        <div className={`stat${data.overdueCents > 0 ? ' stat--danger' : ''}`}>
          <span className="muted">Me afat të kaluar</span>
          <strong>{money(data.overdueCents)}</strong>
          <span className="muted">{data.overdueCount} borxhe</span>
        </div>
        <div className="stat">
          <span className="muted">Afati sot</span>
          <strong>{money(data.dueTodayCents)}</strong>
        </div>
        <div className="stat">
          <span className="muted">Debitorë</span>
          <strong>{data.debtors}</strong>
        </div>
      </div>
    </div>
  );
}
