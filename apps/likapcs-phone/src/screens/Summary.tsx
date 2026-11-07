import type { DashboardSummary } from '@likapcs/shared';
import { api, money, todayIso } from '../api';
import { useLive } from '../useLive';

/** Today at a glance: sales, profit, PC occupancy, and what needs attention. */
export function Summary() {
  const date = todayIso();
  const { data, error, isLoading, refetch } = useLive(['summary', date], () =>
    api<DashboardSummary>(`/dashboard/summary?date=${date}`),
  );

  if (isLoading) return <p className="muted">Duke ngarkuar…</p>;
  if (error || !data) {
    return (
      <div className="card">
        <p className="alert alert--danger">Nuk u ngarkua përmbledhja.</p>
        <button className="primary" onClick={() => void refetch()}>
          Provo përsëri
        </button>
      </div>
    );
  }

  const s = data.stations;
  return (
    <div className="stack">
      <h2>Sot</h2>
      <div className="grid2">
        <Stat label="Shitjet" value={money(data.revenue.totalCents)} tone="ok" />
        <Stat label="Fitimi bruto" value={money(data.grossProfitCents)} />
        <Stat label="Shpenzimet" value={money(data.expensesCents)} />
        <Stat
          label="Arka"
          value={data.cashRegisterBalanceCents === null ? '—' : money(data.cashRegisterBalanceCents)}
        />
      </div>

      <h2>PC-të</h2>
      <div className="grid2">
        <Stat label="Të zëna" value={`${s.occupied} / ${s.enabled}`} tone="ok" />
        <Stat label="Të lira" value={String(s.available)} />
        <Stat label="Në pauzë" value={String(s.paused)} />
        <Stat label="Offline" value={String(s.offline)} tone={s.offline > 0 ? 'warn' : undefined} />
      </div>

      {(data.pendingDevices > 0 || data.lowStockProducts > 0) && (
        <>
          <h2>Duhen kontrolluar</h2>
          <div className="card">
            {data.pendingDevices > 0 && (
              <p>
                <strong>{data.pendingDevices}</strong> pajisje presin miratim te PC-ja kryesore.
              </p>
            )}
            {data.lowStockProducts > 0 && (
              <p>
                <strong>{data.lowStockProducts}</strong> produkte me stok të ulët.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className={`stat${tone ? ` stat--${tone}` : ''}`}>
      <span className="muted">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
