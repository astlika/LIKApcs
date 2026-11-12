/**
 * 0.30.0 — who is on duty now, and per person: hours from their cash shifts, sales, refunds and the
 * shortage or surplus of their closed shifts. All numbers come from `GET /reports/staff`. It refreshes
 * on the live "reports.changed" event, and every 15 seconds as a fallback.
 */
import { useQuery } from '@tanstack/react-query';
import type { StaffReport } from '@likapcs/shared';
import { formatMinutesShort } from '@likapcs/shared';
import { api } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { Alert, Badge, Card, Loading } from '../ui/primitives';

export function StaffView({ from, to, enabled }: { from: string; to: string; enabled: boolean }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const q = useQuery({
    queryKey: ['reports', 'staff', from, to],
    queryFn: () => api<StaffReport>('/reports/staff', { query: { from, to } }),
    enabled,
    placeholderData: (prev) => prev,
    refetchInterval: 15_000,
  });
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Alert tone="danger">{t('common.errorGeneric')}</Alert>;
  const r = q.data;

  return (
    <div className="stack" data-testid="reports-staff">
      <p className="muted">{t('reports.staff.hint')}</p>
      <Card title={t('reports.staff.onDuty')}>
        {r.onDuty.length === 0 ? (
          <p className="muted">{t('reports.staff.onDutyNone')}</p>
        ) : (
          <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {r.onDuty.map((o) => (
              <li key={o.userId} className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{o.name}</strong>
                <span className="muted">
                  {o.registerName} · {t('reports.staff.since', { time: fmt.dateTime(o.since) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={t('reports.staff.title')}>
        {r.staff.length === 0 ? (
          <p className="muted">{t('reports.staff.none')}</p>
        ) : (
          <table className="table table--compact">
            <thead>
              <tr>
                <th>{t('reports.staff.name')}</th>
                <th>{t('reports.staff.status')}</th>
                <th className="right">{t('reports.staff.hours')}</th>
                <th className="right">{t('reports.staff.shifts')}</th>
                <th className="right">{t('reports.staff.sales')}</th>
                <th className="right">{t('reports.staff.refunds')}</th>
                <th className="right">{t('reports.staff.cashDiff')}</th>
              </tr>
            </thead>
            <tbody>
              {r.staff.map((p) => (
                <tr key={p.userId}>
                  <td>{p.name}</td>
                  <td>
                    <Badge tone={p.onDutyNow ? 'success' : 'default'} dot>
                      {p.onDutyNow ? t('reports.staff.on') : t('reports.staff.off')}
                    </Badge>
                  </td>
                  <td className="right num">{formatMinutesShort(p.workedMinutes)}</td>
                  <td className="right num muted">{p.shiftsCount}</td>
                  <td className="right num">
                    {fmt.money(p.salesCents)} <span className="muted">({p.salesCount})</span>
                  </td>
                  <td className="right num muted">{p.refundsCount}</td>
                  <td className={`right num ${p.cashDifferenceCents < 0 ? 'text-danger' : ''}`}>
                    {fmt.money(p.cashDifferenceCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
