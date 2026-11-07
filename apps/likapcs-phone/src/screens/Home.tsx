import type { StationSummary } from '@likapcs/shared';
import { api, money } from '../api';
import { useLive } from '../useLive';
import { Loading, Stat, cx } from '../components/ui';

interface DebtsOverview {
  openCents: number;
  overdueCents: number;
  dueTodayCents: number;
  openCount: number;
  overdueCount: number;
}

export type Tab = 'home' | 'pcs' | 'pos' | 'debts';

/** Start page: what is happening now, and the shortcuts the user may use. */
export function Home({
  name,
  canPcs,
  canPos,
  canDebts,
  onGo,
}: {
  name: string;
  canPcs: boolean;
  canPos: boolean;
  canDebts: boolean;
  onGo: (tab: Tab) => void;
}) {
  const stations = useLive(['stations'], () => api<StationSummary[]>('/stations'));
  const overview = useLive(['debts', 'overview'], () => api<DebtsOverview>('/debts/overview'));

  const shown = (stations.data ?? []).filter((s) => s.isEnabled);
  const running = shown.filter((s) => s.activeSession && s.activeSession.status === 'active').length;
  const paused = shown.filter((s) => s.activeSession?.status === 'paused').length;
  const today = new Date().toLocaleDateString('sq-AL', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Përshëndetje, {name}</h1>
          <span className="muted small">{today}</span>
        </div>
      </div>

      {canPcs && (
        <section className="stack-sm">
          <h2>PC-të</h2>
          {stations.isLoading ? (
            <Loading />
          ) : (
            <div className="grid-3">
              <Stat label="Në punë" tone="ok" value={running} />
              <Stat label="Në pauzë" tone={paused > 0 ? 'warn' : undefined} value={paused} />
              <Stat label="Të lira" value={shown.length - running - paused} />
            </div>
          )}
        </section>
      )}

      {canDebts && (
        <section className="stack-sm">
          <h2>Borxhet</h2>
          {overview.isLoading ? (
            <Loading />
          ) : overview.data ? (
            <div className="grid-3">
              <Stat label="Gjithsej" value={money(overview.data.openCents)} sub={`${overview.data.openCount} fatura`} />
              <Stat
                label="Të vonuara"
                tone={overview.data.overdueCents > 0 ? 'danger' : undefined}
                value={money(overview.data.overdueCents)}
                sub={`${overview.data.overdueCount} fatura`}
              />
              <Stat label="Sot" tone={overview.data.dueTodayCents > 0 ? 'warn' : undefined} value={money(overview.data.dueTodayCents)} />
            </div>
          ) : null}
        </section>
      )}

      <section className="stack-sm">
        <h2>Veprime të shpejta</h2>
        <div className="shortcut-grid">
          {canPos && <Shortcut label="Shitje e re" hint="Produkte dhe pagesë" onClick={() => onGo('pos')} />}
          {canPcs && <Shortcut label="Nis / ndal PC" hint="Kontrollo kohën" onClick={() => onGo('pcs')} />}
          {canDebts && <Shortcut label="Arkëto borxh" hint="Pagesë e plotë ose pjesë" onClick={() => onGo('debts')} />}
        </div>
      </section>
    </div>
  );
}

function Shortcut({ label, hint, onClick }: { label: string; hint: string; onClick: () => void }) {
  return (
    <button type="button" className={cx('shortcut')} onClick={onClick}>
      <strong>{label}</strong>
      <span className="muted small">{hint}</span>
    </button>
  );
}
