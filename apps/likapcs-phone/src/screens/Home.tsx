import type { StationSummary } from '@likapcs/shared';
import { api, money } from '../api';
import { useLive } from '../useLive';
import { Loading, Stat, cx } from '../components/ui';
import { localeOf, useLang, useT } from '../i18n';

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
  const t = useT();
  const lang = useLang();
  const stations = useLive(['stations'], () => api<StationSummary[]>('/stations'));
  const overview = useLive(['debts', 'overview'], () => api<DebtsOverview>('/debts/overview'));

  const shown = (stations.data ?? []).filter((s) => s.isEnabled);
  const running = shown.filter((s) => s.activeSession && s.activeSession.status === 'active').length;
  const paused = shown.filter((s) => s.activeSession?.status === 'paused').length;
  const today = new Date().toLocaleDateString(localeOf(lang), { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{t('Përshëndetje, {name}', { name })}</h1>
          <span className="muted small">{today}</span>
        </div>
      </div>

      {canPcs && (
        <section className="stack-sm">
          <h2>{t('PC-të')}</h2>
          {stations.isLoading ? (
            <Loading />
          ) : (
            <div className="grid-3">
              <Stat label={t('Në punë')} tone="ok" value={running} />
              <Stat label={t('Në pauzë')} tone={paused > 0 ? 'warn' : undefined} value={paused} />
              <Stat label={t('Të lira')} value={shown.length - running - paused} />
            </div>
          )}
        </section>
      )}

      {canDebts && (
        <section className="stack-sm">
          <h2>{t('Borxhet')}</h2>
          {overview.isLoading ? (
            <Loading />
          ) : overview.data ? (
            <div className="grid-3">
              <Stat label={t('Gjithsej')} value={money(overview.data.openCents)} sub={t('{count} fatura', { count: overview.data.openCount })} />
              <Stat
                label={t('Të vonuara')}
                tone={overview.data.overdueCents > 0 ? 'danger' : undefined}
                value={money(overview.data.overdueCents)}
                sub={t('{count} fatura', { count: overview.data.overdueCount })}
              />
              <Stat label={t('Sot')} tone={overview.data.dueTodayCents > 0 ? 'warn' : undefined} value={money(overview.data.dueTodayCents)} />
            </div>
          ) : null}
        </section>
      )}

      <section className="stack-sm">
        <h2>{t('Veprime të shpejta')}</h2>
        <div className="shortcut-grid">
          {canPos && <Shortcut label={t('Shitje e re')} hint={t('Produkte dhe pagesë')} onClick={() => onGo('pos')} />}
          {canPcs && <Shortcut label={t('Nis / ndal PC')} hint={t('Kontrollo kohën')} onClick={() => onGo('pcs')} />}
          {canDebts && <Shortcut label={t('Arkëto borxh')} hint={t('Pagesë e plotë ose pjesë')} onClick={() => onGo('debts')} />}
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
