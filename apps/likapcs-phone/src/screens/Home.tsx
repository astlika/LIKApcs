import type { CashStatusResponse, DebtSummary, Paginated, SalesReport, StationSummary } from '@likapcs/shared';
import { api, money, todayIso } from '../api';
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
  canCash = false,
  onGo,
}: {
  name: string;
  canPcs: boolean;
  canPos: boolean;
  canDebts: boolean;
  canCash?: boolean;
  onGo: (tab: Tab) => void;
}) {
  const t = useT();
  const lang = useLang();
  const stations = useLive(['stations'], () => api<StationSummary[]>('/stations'));
  const overview = useLive(['debts', 'overview'], () => api<DebtsOverview>('/debts/overview'));
  const isoToday = todayIso();
  const salesToday = useLive(['reports', 'sales-today', isoToday], () =>
    api<SalesReport>(`/reports/sales?from=${isoToday}&to=${isoToday}`),
  );
  const cash = useLive(['cash'], () => api<CashStatusResponse>('/cash/status'));
  const drawer = canCash ? cash.data?.current : null;
  const overdue = useLive(['debts', 'overdue-top'], () => api<Paginated<DebtSummary>>('/debts?filter=overdue&pageSize=5'));

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

      {canPos && salesToday.data && (
        <section className="stack-sm">
          <h2>{t('Shitjet sot')}</h2>
          <div className="grid-3">
            <Stat label={t('Shitje')} value={String(salesToday.data.sales.count)} />
            <Stat label={t('Totali')} tone="ok" value={money(salesToday.data.sales.netCents)} />
            <Stat label={t('Mesatarja')} value={money(salesToday.data.sales.averageCents)} />
          </div>
        </section>
      )}

      {canCash && drawer && (
        <section className="stack-sm">
          <h2>{t('Arka')}</h2>
          <div className="grid-3">
            <Stat label={t('Në arkë tani')} tone="ok" value={money(drawer.totals.expectedCashCents)} sub={t('Hapur, {name}', { name: drawer.registerName })} />
            <Stat label={t('Shitje me para')} value={money(drawer.totals.cashSalesCents)} sub={t('{count} shitje', { count: drawer.totals.salesCount })} />
            <Stat label={t('Shpenzime')} value={money(drawer.totals.expensesCents)} />
          </div>
        </section>
      )}

      {canDebts && overdue.data && overdue.data.items.length > 0 && (
        <section className="stack-sm">
          <h2>{t('Borxhe të vonuara')}</h2>
          <ul className="list">
            {overdue.data.items.map((d) => (
              <li key={d.id} className="card card--flat overdue-row">
                <span className="overdue-row__who">
                  <strong>{d.customerName}</strong>
                  <span className="muted small">
                    {t('Afati')}: {d.dueDate} · {money(d.remainingCents)}
                  </span>
                </span>
                <span className="overdue-row__actions">
                  {d.customerPhone ? (
                    <a className="btn btn--ghost small-btn" href={`tel:${d.customerPhone.replace(/\s+/g, '')}`}>
                      {t('Thirr')}
                    </a>
                  ) : (
                    <span className="muted small">{t('Pa telefon')}</span>
                  )}
                  <button type="button" className="btn btn--primary small-btn" onClick={() => onGo('debts')}>
                    {t('Pagesë')}
                  </button>
                </span>
              </li>
            ))}
          </ul>
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
