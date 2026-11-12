/**
 * 0.30.0 — the one-page summary on Reports: turnover (VAT included), net profit, expenses, the
 * drawer, and the day-by-day turnover. Every number comes from `GET /reports/summary`; nothing is
 * recomputed here except the bar widths.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReportSummary } from '@likapcs/shared';
import { api } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { Alert, Card, Loading, StatTile } from '../ui/primitives';

export function SummaryView({ from, to, enabled }: { from: string; to: string; enabled: boolean }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const q = useQuery({
    queryKey: ['reports', 'summary', from, to],
    queryFn: () => api<ReportSummary>('/reports/summary', { query: { from, to } }),
    enabled,
    placeholderData: (prev) => prev,
  });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Alert tone="danger">{t('common.errorGeneric')}</Alert>;
  const r = q.data;
  const gaps = r.checks.productsWithoutCost + r.checks.saleLinesWithoutCost + r.checks.lossesWithoutCost;
  const max = Math.max(1, ...r.daily.map((d) => d.turnoverCents));
  const pct = (bp: number | null) => (bp === null ? '—' : `${(bp / 100).toFixed(1)} %`);

  return (
    <div className="stack" data-testid="reports-summary">
      <p className="muted">{t('reports.summary.hint')}</p>
      {gaps > 0 && <Alert tone="warning">{t('reports.summary.incomplete')}</Alert>}
      <div className="grid grid--stats">
        <StatTile
          label={t('reports.summary.turnover')}
          value={fmt.money(r.turnoverCents)}
          sub={t('reports.summary.turnoverSub', { count: r.salesCount })}
          tone="accent"
        />
        <StatTile
          label={t('reports.summary.netProfit')}
          value={fmt.money(r.netProfitCents)}
          sub={t('reports.summary.margin', { percent: pct(r.netMarginBp) })}
          tone={r.netProfitCents < 0 ? 'danger' : 'success'}
        />
        <StatTile label={t('reports.summary.expenses')} value={fmt.money(r.expensesCents)} />
        <StatTile
          label={t('reports.summary.cashNet')}
          value={fmt.money(r.cash.netCents)}
          sub={t('reports.summary.cashDiff', { amount: fmt.money(r.cash.differenceCents) })}
          tone={r.cash.differenceCents < 0 ? 'danger' : undefined}
        />
      </div>
      <div className="grid grid--2">
        <Card title={t('reports.summary.details')}>
          <dl style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px 16px', margin: 0 }}>
            <dt>{t('reports.summary.net')}</dt>
            <dd className="num">{fmt.money(r.revenueCents)}</dd>
            <dt>{t('reports.summary.vat')}</dt>
            <dd className="num">{fmt.money(r.vatCents)}</dd>
            <dt>{t('reports.summary.cogs')}</dt>
            <dd className="num">{fmt.money(r.costOfSalesCents)}</dd>
            <dt>{t('reports.summary.grossProfit')}</dt>
            <dd className="num">
              {fmt.money(r.grossProfitCents)} · {pct(r.grossMarginBp)}
            </dd>
            <dt>{t('reports.summary.stockLoss')}</dt>
            <dd className="num">{fmt.money(r.stockLossCents)}</dd>
            <dt>{t('reports.summary.refunds')}</dt>
            <dd className="num">{fmt.money(r.refundedCents)}</dd>
            <dt>{t('reports.summary.average')}</dt>
            <dd className="num">{fmt.money(r.averageSaleCents)}</dd>
            <dt>{t('reports.summary.drawerIn')}</dt>
            <dd className="num">{fmt.money(r.cash.inCents)}</dd>
            <dt>{t('reports.summary.drawerOut')}</dt>
            <dd className="num">{fmt.money(r.cash.outCents)}</dd>
          </dl>
        </Card>
        <Card title={t('reports.summary.daily')}>
          {r.daily.length === 0 ? (
            <p className="muted">{t('reports.summary.noSales')}</p>
          ) : (
            <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {r.daily.map((d) => (
                <li key={d.date}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span>
                      {d.date} · <span className="muted">{d.salesCount}</span>
                    </span>
                    <strong className="num">{fmt.money(d.turnoverCents)}</strong>
                  </div>
                  <div
                    aria-hidden="true"
                    style={{
                      height: 6,
                      borderRadius: 3,
                      background: 'var(--accent, #3b82f6)',
                      width: `${(d.turnoverCents / max) * 100}%`,
                      marginTop: 4,
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
