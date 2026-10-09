import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Monitor,
  PauseCircle,
  Play,
  WifiOff,
} from 'lucide-react';
import { PERMISSIONS, formatDate, toIsoDate, type DashboardSummary } from '@likapcs/shared';
import { api } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Input,
  Loading,
  StatTile,
} from '../components/ui/primitives';

export function DashboardPage() {
  const { t, td } = useI18n();
  const { can } = useAuth();
  const fmt = useFormat();
  const [date, setDate] = useState(() => toIsoDate(new Date(), { timeZone: fmt.timeZone }));
  const summary = useQuery({
    queryKey: ['dashboard', date],
    queryFn: () => api<DashboardSummary>('/dashboard/summary', { query: { date } }),
    refetchInterval: 30_000,
  });
  const s = summary.data;
  const isToday = date === toIsoDate(new Date(), { timeZone: fmt.timeZone });

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{t('dashboard.title')}</h1>
          <p className="page-header__sub">
            {t('dashboard.subtitle', { date: formatDate(`${date}T12:00:00`) })}
          </p>
        </div>
        <div className="page-header__actions">
          <Input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            style={{ width: 170 }}
            aria-label={t('common.date')}
          />
          {!isToday && (
            <Button onClick={() => setDate(toIsoDate(new Date(), { timeZone: fmt.timeZone }))}>
              {t('common.today')}
            </Button>
          )}
        </div>
      </div>

      {summary.isLoading && <Loading />}
      {summary.isError && (
        <Alert tone="danger">
          {t('common.errorGeneric')}{' '}
          <Button size="sm" onClick={() => void summary.refetch()}>
            {t('common.tryAgain')}
          </Button>
        </Alert>
      )}

      {s && (
        <>
          {s.pendingDevices > 0 && can(PERMISSIONS.DEVICES_MANAGE) && (
            <Alert tone="warning" icon={<AlertTriangle size={18} />}>
              <div className="row row--between row--wrap">
                <div>
                  <strong>
                    {s.pendingDevices} · {t('dashboard.pendingDevices')}
                  </strong>
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {t('dashboard.pendingDevicesHint')}
                  </div>
                </div>
                <Link to="/stations" className="btn btn--sm">
                  {t('dashboard.review')} <ArrowRight size={14} />
                </Link>
              </div>
            </Alert>
          )}

          <div className="grid grid--stats">
            <StatTile
              label={t('dashboard.revenueToday')}
              value={fmt.money(s.revenue.totalCents)}
              tone="accent"
              sub={t('dashboard.refunds', { amount: fmt.money(s.revenue.refundsCents) })}
            />
            <StatTile
              label={t('dashboard.productSales')}
              value={fmt.money(s.revenue.productSalesCents)}
            />
            <StatTile
              label={t('dashboard.gamingRevenue')}
              value={fmt.money(s.revenue.gamingCents)}
            />
            <StatTile label={t('dashboard.purchases')} value={fmt.money(s.purchasesCents)} />
            <StatTile label={t('dashboard.expenses')} value={fmt.money(s.expensesCents)} />
            <StatTile
              label={t('dashboard.grossProfit')}
              value={fmt.money(s.grossProfitCents)}
              tone={s.grossProfitCents < 0 ? 'danger' : 'success'}
              sub={t('dashboard.cogs', { amount: fmt.money(s.costOfGoodsSoldCents) })}
            />
            <StatTile
              label={t('dashboard.operatingProfit')}
              value={fmt.money(s.operatingProfitCents)}
              tone={s.operatingProfitCents < 0 ? 'danger' : undefined}
            />
            <StatTile
              label={t('dashboard.cashBalance')}
              value={
                s.cashRegisterBalanceCents === null ? '—' : fmt.money(s.cashRegisterBalanceCents)
              }
              sub={s.cashRegisterBalanceCents === null ? t('dashboard.noOpenShift') : undefined}
            />
          </div>

          <div className="grid grid--stats">
            <StatTile
              label={t('dashboard.stations')}
              value={s.stations.total}
              icon={<Monitor size={16} />}
              sub={t('dashboard.enabledOf', {
                enabled: s.stations.enabled,
                total: s.stations.total,
              })}
              to="/stations"
            />
            <StatTile
              label={t('dashboard.activeSessions')}
              value={s.stations.activeSessions}
              icon={<Play size={16} />}
              tone="accent"
              to="/stations"
            />
            <StatTile
              label={t('dashboard.availablePcs')}
              value={s.stations.available}
              tone="success"
              to="/stations"
            />
            <StatTile
              label={t('dashboard.occupiedPcs')}
              value={s.stations.occupied}
              to="/stations"
            />
            <StatTile
              label={t('dashboard.pausedSessions')}
              value={s.stations.paused}
              icon={<PauseCircle size={16} />}
              tone={s.stations.paused ? 'warning' : undefined}
              to="/stations"
            />
            <StatTile
              label={t('dashboard.offlineClients')}
              value={s.stations.offline}
              icon={<WifiOff size={16} />}
              tone={s.stations.offline ? 'danger' : undefined}
              to="/stations"
            />
            <StatTile
              label={t('dashboard.lowStock')}
              value={s.lowStockProducts}
              tone={s.lowStockProducts ? 'warning' : undefined}
            />
          </div>

          <div className="grid grid--2">
            <Card
              title={t('dashboard.recentActivity')}
              flush
              actions={
                can(PERMISSIONS.AUDIT_VIEW) ? (
                  <Link to="/audit" className="btn btn--ghost btn--sm">
                    {t('dashboard.viewAll')} <ArrowRight size={14} />
                  </Link>
                ) : undefined
              }
            >
              {s.recentAudit.length === 0 ? (
                <EmptyState icon={<Activity size={22} />} title={t('dashboard.noActivity')} />
              ) : (
                <div className="activity">
                  {s.recentAudit.map((entry) => (
                    <div key={entry.id} className="activity__item">
                      <span
                        className={`activity__dot ${entry.severity !== 'info' ? `activity__dot--${entry.severity}` : ''}`}
                      />
                      <div>
                        <div>
                          <span className="mono">{entry.action}</span>
                          {entry.actorLabel && <span className="muted"> · {entry.actorLabel}</span>}
                        </div>
                        {entry.entityType && (
                          <div className="faint" style={{ fontSize: 12 }}>
                            {td(`audit.entity`)}: {entry.entityType}
                            {entry.entityId ? ` ${entry.entityId.slice(0, 8)}` : ''}
                          </div>
                        )}
                      </div>
                      <span className="activity__time">{fmt.relative(entry.occurredAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card title={t('dashboard.stations')}>
              <p className="muted" style={{ marginBottom: 12 }}>
                {t('dashboard.financeNote')}
              </p>
              <Link to="/stations" className="btn">
                <Monitor size={16} /> {t('nav.stations')}
              </Link>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
