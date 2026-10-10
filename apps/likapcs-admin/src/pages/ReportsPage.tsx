/**
 * Reports: sales / gaming / expenses / cash for a date range, with quick presets, simple
 * CSS bar charts (no chart library) and CSV exports. All numbers come from the server; nothing
 * is recomputed here except percentages for the bars.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, LineChart } from 'lucide-react';
import {
  PERMISSIONS,
  REPORT_EXPORT_KINDS,
  formatMinutesShort,
  type ReportBucket,
  type ReportExportKind,
  type SalesReport,
} from '@likapcs/shared';
import { api, ApiError, getServerUrl, getToken } from '../lib/api';
import { useFormat } from '../lib/format';
import { useI18n } from '../i18n';
import { useAuth } from '../state/auth';
import { useToast } from '../state/toast';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Input,
  Loading,
  PageHeader,
  Segmented,
  Select,
  StatTile,
} from '../components/ui/primitives';

type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'lastMonth' | 'custom';

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function presetRange(p: Preset): { from: string; to: string } {
  const now = new Date();
  const today = iso(now);
  switch (p) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return { from: iso(y), to: iso(y) };
    }
    case 'week': {
      const d = new Date(now);
      const day = (d.getDay() + 6) % 7; // Monday = 0
      d.setDate(d.getDate() - day);
      return { from: iso(d), to: today };
    }
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today };
    case 'lastMonth': {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: iso(first), to: iso(last) };
    }
    default:
      return { from: today, to: today };
  }
}

/** Downloads an authenticated CSV export through fetch + blob (works in the browser and WebView2). */
async function downloadCsv(kind: ReportExportKind, from: string, to: string): Promise<void> {
  const url = new URL(`${getServerUrl()}/api/v1/reports/export`, window.location.origin);
  url.searchParams.set('kind', kind);
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  const res = await fetch(url.toString(), {
    headers: { authorization: `Bearer ${getToken() ?? ''}` },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, 'export_failed', message);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = match?.[1] ?? `likapcs-${kind}-${from}-${to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export function ReportsPage() {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const toast = useToast();
  const [preset, setPreset] = useState<Preset>('today');
  const [custom, setCustom] = useState(presetRange('today'));
  const [exportKind, setExportKind] = useState<ReportExportKind>('sales');
  const [exporting, setExporting] = useState(false);
  const range = useMemo(
    () => (preset === 'custom' ? custom : presetRange(preset)),
    [preset, custom],
  );
  const valid = !!range.from && !!range.to && range.from <= range.to;

  const report = useQuery({
    queryKey: ['reports', 'sales', range],
    queryFn: () => api<SalesReport>('/reports/sales', { query: range }),
    enabled: valid,
    placeholderData: (prev) => prev,
  });
  const r = report.data;

  const onExport = async () => {
    setExporting(true);
    try {
      await downloadCsv(exportKind, range.from, range.to);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('reports.title')}
        subtitle={
          r ? t('reports.generated', { time: fmt.dateTime(r.generatedAt) }) : t('reports.subtitle')
        }
        actions={
          can(PERMISSIONS.REPORTS_EXPORT) && (
            <div className="row" style={{ gap: 8 }}>
              <Select
                value={exportKind}
                onChange={(e) => setExportKind(e.target.value as ReportExportKind)}
                aria-label={t('reports.exportKind')}
              >
                {REPORT_EXPORT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`reports.export.${k}` as 'reports.export.sales')}
                  </option>
                ))}
              </Select>
              <Button onClick={() => void onExport()} loading={exporting} disabled={!valid}>
                <Download size={14} /> {t('reports.exportCsv')}
              </Button>
            </div>
          )
        }
      />
      <div className="toolbar">
        <Segmented<Preset>
          value={preset}
          onChange={(p) => {
            setPreset(p);
            if (p !== 'custom') setCustom(presetRange(p));
          }}
          options={[
            { value: 'today', label: t('reports.preset.today') },
            { value: 'yesterday', label: t('reports.preset.yesterday') },
            { value: 'week', label: t('reports.preset.week') },
            { value: 'month', label: t('reports.preset.month') },
            { value: 'lastMonth', label: t('reports.preset.lastMonth') },
            { value: 'custom', label: t('reports.preset.custom') },
          ]}
        />
        <label className="row" style={{ gap: 6 }}>
          <span className="muted">{t('sales.from')}</span>
          <Input
            type="date"
            value={range.from}
            onChange={(e) => {
              setPreset('custom');
              setCustom({ ...range, from: e.target.value });
            }}
          />
        </label>
        <label className="row" style={{ gap: 6 }}>
          <span className="muted">{t('sales.to')}</span>
          <Input
            type="date"
            value={range.to}
            onChange={(e) => {
              setPreset('custom');
              setCustom({ ...range, to: e.target.value });
            }}
          />
        </label>
      </div>
      {!valid && <Alert tone="warning">{t('reports.invalidRange')}</Alert>}
      {report.isLoading && <Loading />}
      {report.isError && (
        <Alert tone="danger">
          {report.error instanceof ApiError ? report.error.message : t('common.errorGeneric')}
        </Alert>
      )}
      {r && (
        <div className="stack" style={{ gap: 20 }}>
          <div className="grid grid--stats">
            <StatTile
              label={t('reports.netSales')}
              value={fmt.money(r.sales.netCents)}
              sub={t('reports.salesCountAvg', {
                count: r.sales.count,
                avg: fmt.money(r.sales.averageCents),
              })}
              tone="accent"
            />
            <StatTile
              label={t('reports.gaming')}
              value={fmt.money(r.gaming.amountCents)}
              sub={t('reports.gamingSub', {
                sessions: r.gaming.sessionsCount,
                time: formatMinutesShort(r.gaming.billedMinutes),
              })}
            />
            <StatTile
              label={t('reports.refunds')}
              value={fmt.money(r.sales.refundedCents)}
              sub={t('cash.refundsCount', { count: r.sales.refundsCount })}
              tone={r.sales.refundedCents ? 'warning' : undefined}
            />
            <StatTile
              label={t('reports.expenses')}
              value={fmt.money(r.expenses.totalCents)}
              sub={t('expenses.count') + `: ${r.expenses.count}`}
            />
            <StatTile
              label={t('reports.result')}
              value={fmt.money(r.sales.netCents - r.expenses.totalCents)}
              sub={t('reports.resultHint')}
              tone={r.sales.netCents - r.expenses.totalCents >= 0 ? 'success' : 'danger'}
            />
            <StatTile
              label={t('reports.vat')}
              value={fmt.money(r.sales.taxCents)}
              sub={t('reports.discounts', { amount: fmt.money(r.sales.discountCents) })}
            />
          </div>

          {r.sales.count === 0 && r.expenses.count === 0 && (
            <EmptyState icon={<LineChart size={22} />} title={t('reports.empty')} />
          )}

          {r.byDay.length > 0 && (
            <Card title={t('reports.byDay')}>
              <Bars
                rows={r.byDay.map((d) => ({
                  key: d.date,
                  label: fmt.date(d.date),
                  value: d.amountCents,
                  detail: `${t('sales.source.retail')} ${fmt.money(d.retailCents)} · ${t('sales.source.gaming')} ${fmt.money(d.gamingCents)} · ${d.count}×`,
                }))}
                money={fmt.money}
              />
            </Card>
          )}

          <div className="grid grid--2" style={{ alignItems: 'start' }}>
            <Card title={t('reports.byMethod')}>
              <BucketTable
                rows={r.byMethod.map((b) => ({
                  ...b,
                  label: t(`sessions.methods.${b.key}` as 'sessions.methods.cash'),
                }))}
                money={fmt.money}
                countLabel={t('reports.tenders')}
              />
            </Card>
            <Card title={t('reports.bySource')}>
              <BucketTable
                rows={r.bySource.map((b) => ({
                  ...b,
                  label: t(`sales.source.${b.key}` as 'sales.source.retail'),
                }))}
                money={fmt.money}
                countLabel={t('reports.salesCount')}
              />
            </Card>
          </div>

          {r.byHour.length > 0 && (
            <Card title={t('reports.byHour')}>
              <Bars
                rows={Array.from({ length: 24 }, (_, h) => {
                  const row = r.byHour.find((x) => x.hour === h);
                  return {
                    key: String(h),
                    label: `${String(h).padStart(2, '0')}:00`,
                    value: row?.amountCents ?? 0,
                    detail: row ? `${row.count}×` : '',
                  };
                }).filter((x, i, arr) => {
                  // trim leading/trailing empty hours
                  const firstIdx = arr.findIndex((y) => y.value > 0);
                  let lastIdx = -1;
                  arr.forEach((y, j) => {
                    if (y.value > 0) lastIdx = j;
                  });
                  return i >= firstIdx && i <= lastIdx;
                })}
                money={fmt.money}
                compact
              />
            </Card>
          )}

          <div className="grid grid--2" style={{ alignItems: 'start' }}>
            <Card title={t('reports.topProducts')}>
              {r.topProducts.length === 0 ? (
                <p className="muted">{t('common.none')}</p>
              ) : (
                <table className="table table--compact">
                  <thead>
                    <tr>
                      <th>{t('products.name')}</th>
                      <th className="right">{t('receipt.qty')}</th>
                      <th className="right">{t('receipt.amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.topProducts.map((p) => (
                      <tr key={p.productId}>
                        <td>{p.name}</td>
                        <td className="right num">
                          {p.quantityMilli % 1000 === 0
                            ? p.quantityMilli / 1000
                            : (p.quantityMilli / 1000).toFixed(3)}
                        </td>
                        <td className="right num">{fmt.money(p.amountCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title={t('reports.byCategory')}>
              <BucketTable
                rows={r.byCategory.map((b) => ({
                  ...b,
                  label: b.label ?? t('reports.uncategorised'),
                }))}
                money={fmt.money}
                countLabel={t('receipt.qty')}
              />
            </Card>
          </div>

          <div className="grid grid--2" style={{ alignItems: 'start' }}>
            <Card title={t('reports.byStation')}>
              {r.gaming.byStation.length === 0 ? (
                <p className="muted">{t('common.none')}</p>
              ) : (
                <table className="table table--compact">
                  <thead>
                    <tr>
                      <th>{t('nav.stations')}</th>
                      <th className="right">{t('reports.sessions')}</th>
                      <th className="right">{t('sessions.duration')}</th>
                      <th className="right">{t('receipt.amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.gaming.byStation.map((s) => (
                      <tr key={s.stationId}>
                        <td>
                          <span className="mono">{s.code}</span>{' '}
                          <span className="muted">{s.name}</span>
                        </td>
                        <td className="right num">{s.sessions}</td>
                        <td className="right num">{formatMinutesShort(s.minutes)}</td>
                        <td className="right num">{fmt.money(s.amountCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title={t('reports.byEmployee')}>
              <BucketTable
                rows={r.byEmployee.map((b) => ({ ...b, label: b.label ?? '—' }))}
                money={fmt.money}
                countLabel={t('reports.salesCount')}
              />
            </Card>
          </div>

          <div className="grid grid--2" style={{ alignItems: 'start' }}>
            <Card title={t('reports.expensesByCategory')}>
              <BucketTable
                rows={r.expenses.byCategory.map((b) => ({ ...b, label: b.label ?? b.key }))}
                money={fmt.money}
                countLabel={t('expenses.count')}
              />
            </Card>
            <Card title={t('reports.cashShifts')}>
              {r.cash.shifts.length === 0 ? (
                <p className="muted">{t('common.none')}</p>
              ) : (
                <>
                  <p className="muted" style={{ marginTop: 0 }}>
                    {t('reports.cashShiftsSummary', {
                      count: r.cash.shiftsCount,
                      difference: fmt.money(r.cash.differenceCents),
                    })}
                  </p>
                  <table className="table table--compact">
                    <thead>
                      <tr>
                        <th>{t('cash.opened')}</th>
                        <th>{t('cash.register')}</th>
                        <th className="right">{t('cash.expectedCash')}</th>
                        <th className="right">{t('cash.difference')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.cash.shifts.map((s) => (
                        <tr key={s.id}>
                          <td className="num">
                            {fmt.dateTime(s.openedAt)}
                            <span className="faint" style={{ marginLeft: 6, fontSize: 12 }}>
                              {s.openedBy.name}
                            </span>
                          </td>
                          <td>{s.registerName}</td>
                          <td className="right num">
                            {s.expectedCashCents != null ? fmt.money(s.expectedCashCents) : '—'}
                          </td>
                          <td className={`right num ${s.differenceCents ? 'text-danger' : ''}`}>
                            {s.differenceCents != null ? fmt.money(s.differenceCents) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

function BucketTable({
  rows,
  money,
  countLabel,
}: {
  rows: ReportBucket[];
  money: (c: number) => string;
  countLabel: string;
}) {
  const { t } = useI18n();
  const total = rows.reduce((a, b) => a + b.amountCents, 0);
  if (rows.length === 0) return <p className="muted">{t('common.none')}</p>;
  return (
    <table className="table table--compact">
      <thead>
        <tr>
          <th />
          <th className="right">{countLabel}</th>
          <th className="right">{t('receipt.amount')}</th>
          <th className="right">%</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((b) => (
          <tr key={b.key}>
            <td>{b.label ?? b.key}</td>
            <td className="right num muted">{b.count}</td>
            <td className="right num">{money(b.amountCents)}</td>
            <td className="right num muted">
              {total ? `${Math.round((b.amountCents / total) * 100)}%` : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Bars({
  rows,
  money,
  compact,
}: {
  rows: { key: string; label: string; value: number; detail?: string }[];
  money: (c: number) => string;
  compact?: boolean;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className={`bars ${compact ? 'bars--compact' : ''}`}>
      {rows.map((r) => (
        <div className="bars__row" key={r.key} title={r.detail}>
          <div className="bars__label">{r.label}</div>
          <div className="bars__track">
            <div className="bars__fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          <div className="bars__value num">{money(r.value)}</div>
        </div>
      ))}
    </div>
  );
}
