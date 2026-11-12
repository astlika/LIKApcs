/**
 * 0.31.0 — Live tracking: what is happening in the shop today. Money figures come from the server
 * (`GET /live/snapshot`), which uses the same reports as the other pages; the page only lays them
 * out. It refreshes on the server's push (`live.sale`, `reports.changed`) and every 15 s as a
 * fallback, so a dropped socket never leaves it stale for long.
 */
import { useQuery } from '@tanstack/react-query';
import { Activity, Clock, ShieldOff, Wallet } from 'lucide-react';
import {
  PERMISSIONS,
  formatMinutesShort,
  type LiveSale,
  type LiveSnapshot,
} from '@likapcs/shared';
import { api } from '../lib/api';
import { itemLabel, qtyLabel } from '../lib/live';
import { useFormat } from '../lib/format';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { Alert, Badge, Card, EmptyState, Loading, PageHeader, StatTile } from '../components/ui/primitives';
import './live.css';

export function LivePage() {
  const { can } = useAuth();
  const { t } = useI18n();
  const fmt = useFormat();
  const allowed = can(PERMISSIONS.LIVE_VIEW);

  const snap = useQuery({
    queryKey: ['live', 'snapshot'],
    queryFn: () => api<LiveSnapshot>('/live/snapshot'),
    enabled: allowed,
    refetchInterval: 15_000,
  });

  if (!allowed) {
    return (
      <Card>
        <EmptyState icon={<ShieldOff size={24} />} title={t('common.noAccessTitle')} hint={t('live.noAccess')} />
      </Card>
    );
  }
  if (snap.isLoading || !snap.data) return <Loading />;

  const s = snap.data;
  const { totals: x, drawer: d } = s;

  return (
    <div className="live-page">
      <PageHeader
        title={t('live.title')}
        subtitle={t('live.subtitle')}
        actions={
          <span className="live-pill" aria-live="polite">
            <span className="live-pill__dot" />
            {t('live.updated')} {fmt.time(s.generatedAt)}
          </span>
        }
      />

      {x.incomplete && (
        <Alert tone="warning">{t('live.incomplete')}</Alert>
      )}

      <section className="live-kpis" aria-label={t('live.title')}>
        <StatTile
          label={t('live.turnover')}
          value={fmt.money(x.turnoverCents)}
          sub={t('live.turnoverSub', { count: x.salesCount })}
          tone="accent"
          icon={<Activity size={16} />}
        />
        <StatTile
          label={t('live.grossProfit')}
          value={fmt.money(x.grossProfitCents)}
          sub={t('live.grossProfitSub')}
          tone="success"
        />
        <StatTile label={t('live.netProfit')} value={fmt.money(x.netProfitCents)} tone={x.netProfitCents < 0 ? 'danger' : 'success'} />
        <StatTile label={t('live.expenses')} value={fmt.money(x.expensesCents)} tone="warning" />
        <StatTile
          label={t('live.losses')}
          value={fmt.money(x.lossCents)}
          sub={t('live.lossesSub', {
            refunded: fmt.money(x.refundedCents),
            stock: fmt.money(x.stockLossCents),
          })}
          tone={x.lossCents > 0 ? 'danger' : undefined}
        />
        <StatTile label={t('live.debtGiven')} value={fmt.money(x.debtGivenCents)} icon={<Wallet size={16} />} />
        <StatTile label={t('live.debtCollected')} value={fmt.money(x.debtCollectedCents)} />
        <StatTile
          label={t('live.drawer')}
          value={d.open && d.expectedCents !== null ? fmt.money(d.expectedCents) : '—'}
          sub={d.open ? t('live.expected') : t('live.drawerClosed')}
          tone="accent"
        />
      </section>

      <div className="live-grid">
        <Card title={t('live.drawer')} className="live-card" subtitle={d.open && d.openedBy ? t('live.drawerOpenedBy', { name: d.openedBy }) : t('live.drawerClosed')}>
          {d.open ? (
            <dl className="live-facts">
              <div><dt>{d.registerName ?? '—'}</dt><dd>{fmt.time(d.openedAt)}</dd></div>
              <div><dt>{t('live.opening')}</dt><dd>{d.openingCents !== null ? fmt.money(d.openingCents) : '—'}</dd></div>
              <div><dt>{t('live.expected')}</dt><dd>{d.expectedCents !== null ? fmt.money(d.expectedCents) : '—'}</dd></div>
            </dl>
          ) : (
            <p className="live-muted">{t('live.drawerClosed')}</p>
          )}
        </Card>

        <Card title={t('live.staff')} className="live-card" flush>
          {s.staff.length === 0 ? (
            <p className="live-muted live-pad">{t('live.noStaff')}</p>
          ) : (
            <ul className="live-list">
              {s.staff.map((p) => (
                <li key={p.userId} className="live-row">
                  <div className="live-row__main">
                    <span className="live-name">
                      {p.onDuty && <span className="live-dot" aria-hidden="true" />}
                      {p.name}
                    </span>
                    <span className="live-muted">
                      {p.workedMinutes > 0 ? t('live.worked', { time: formatMinutesShort(p.workedMinutes) }) : ''}
                      {p.lastSaleAt ? ` · ${t('live.lastSale', { time: fmt.time(p.lastSaleAt) })}` : ''}
                    </span>
                  </div>
                  <div className="live-row__end">
                    <Badge tone={p.onDuty ? 'success' : 'default'}>{p.onDuty ? t('live.onDuty') : t('live.off')}</Badge>
                    <span className="live-money">{t('live.staffSales', { count: p.salesCount, amount: fmt.money(p.salesCents) })}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={t('live.feed')} className="live-card live-card--feed" flush>
          {s.feed.length === 0 ? (
            <p className="live-muted live-pad">{t('live.feedEmpty')}</p>
          ) : (
            <ol className="live-feed">
              {s.feed.map((sale) => (
                <FeedRow key={sale.saleId} sale={sale} />
              ))}
            </ol>
          )}
        </Card>

        <Card title={t('live.topProducts')} className="live-card" flush>
          {s.topProducts.length === 0 ? (
            <p className="live-muted live-pad">{t('live.topEmpty')}</p>
          ) : (
            <table className="live-table">
              <tbody>
                {s.topProducts.map((p) => (
                  <tr key={p.name}>
                    <td>{p.name}</td>
                    <td className="live-num">×{qtyLabel(p.quantityMilli)}</td>
                    <td className="live-num">{fmt.money(p.amountCents)}</td>
                    <td className="live-num live-muted">{fmt.money(p.profitCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}

function FeedRow({ sale }: { sale: LiveSale }) {
  const { t } = useI18n();
  const fmt = useFormat();
  return (
    <li className="live-feed__item">
      <div className="live-feed__time">
        <Clock size={12} aria-hidden="true" /> {fmt.time(sale.completedAt)}
      </div>
      <div className="live-feed__body">
        <div className="live-feed__line">
          <strong>{sale.cashierName}</strong>
          <span className="live-muted"> · {sale.items.map(itemLabel).join(', ')}</span>
          {sale.onCredit && <Badge tone="warning">{t('live.credit')}</Badge>}
        </div>
        <div className="live-feed__meta">
          <span className="live-money">{fmt.money(sale.totalCents)}</span>
          <span className="live-muted">
            {' · '}
            {t('live.profit', { amount: fmt.money(sale.profitCents) })}
            {sale.missingCost ? ` (${t('live.noCost')})` : ''}
          </span>
        </div>
      </div>
    </li>
  );
}
