/**
 * Reports: sales / gaming / expenses / cash for a date range, with quick presets, simple
 * CSS bar charts (no chart library) and CSV exports. All numbers come from the server; nothing
 * is recomputed here except percentages for the bars.
 */
import { useMemo, useState, type ReactNode } from 'react';
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
import { CashBookCard } from '../components/reports/CashBookCard';
import { ProfitReportView } from '../components/reports/ProfitReportView';
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
/** The two halves of Reports: the sales picture, or profit & spending (0.21.0). */
type ReportView = 'sales' | 'profit';

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
  const [view, setView] = useState<ReportView>('sales');
  const range = useMemo(
    () => (preset === 'custom' ? custom : presetRange(preset)),
    [preset, custom],
  );
  const valid = !!range.from && !!range.to && range.from <= range.to;

  const report = useQuery({
    queryKey: ['reports', 'sales', range],
    queryFn: () => api<SalesReport>('/reports/sales', { query: range }),
    enabled: valid && view === 'sales',
    placeholderData: (prev) => prev,
  });
  const r = view === 'sales' ? report.data : undefined;

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
        <Segmented<ReportView>
          value={view}
          onChange={setView}
          ariaLabel={t('reports.viewLabel')}
          testId="reports-view"
          options={[
            { value: 'sales', label: t('reports.view.sales') },
            { value: 'profit', label: t('reports.view.profit') },
          ]}
        />
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
      {view === 'sales' && report.isLoading && <Loading />}
      {view === 'sales' && report.isError && (
        <Alert tone="danger">
          {report.error instanceof ApiError ? report.error.message : t('common.errorGeneric')}
        </Alert>
      )}
      {view === 'profit' && valid && <ProfitReportView from={range.from} to={range.to} />}
      {r && (
        <div className="stack rep" style={{ gap: 24 }}>
          <ResultHero report={r} />

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
              label={t('reports.vat')}
              value={fmt.money(r.sales.taxCents)}
              sub={t('reports.discounts', { amount: fmt.money(r.sales.discountCents) })}
            />
          </div>

          {r.sales.count === 0 && r.expenses.count === 0 && (
            <EmptyState icon={<LineChart size={22} />} title={t('reports.empty')} />
          )}

          {(r.byDay.length > 0 || r.byHour.length > 0) && (
            <ReportSection title={t('reports.section.sales')} hint={t('reports.section.salesHint')}>
              {r.byDay.length > 0 && (
                <Card title={t('reports.byDay')}>
                  <ColumnChart
                    money={fmt.money}
                    rows={r.byDay.map((d) => {
                      const [, month, day] = d.date.split('-');
                      return {
                        key: d.date,
                        label: `${day}.${month}`,
                        value: d.amountCents,
                        detail: `${t('sales.source.retail')} ${fmt.money(d.retailCents)} · ${t('sales.source.gaming')} ${fmt.money(d.gamingCents)} · ${d.count}×`,
                      };
                    })}
                  />
                </Card>
              )}
              {r.byHour.length > 0 && (
                <Card title={t('reports.byHour')}>
                  <ColumnChart
                    money={fmt.money}
                    rows={Array.from({ length: 24 }, (_, h) => {
                      const row = r.byHour.find((x) => x.hour === h);
                      return {
                        key: String(h),
                        label: String(h).padStart(2, '0'),
                        value: row?.amountCents ?? 0,
                        detail: row
                          ? `${String(h).padStart(2, '0')}:00 · ${row.count}×`
                          : undefined,
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
                    showValues={false}
                  />
                </Card>
              )}
            </ReportSection>
          )}

          <ReportSection
            title={t('reports.section.payments')}
            hint={t('reports.section.paymentsHint')}
          >
            <div className="grid grid--2">
              <Card title={t('reports.byMethod')}>
                <Composition
                  money={fmt.money}
                  rows={r.byMethod.map((b) => ({
                    key: b.key,
                    label: t(`sessions.methods.${b.key}` as 'sessions.methods.cash'),
                    amountCents: b.amountCents,
                  }))}
                />
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
                <Composition
                  money={fmt.money}
                  rows={r.bySource.map((b) => ({
                    key: b.key,
                    label: t(`sales.source.${b.key}` as 'sales.source.retail'),
                    amountCents: b.amountCents,
                  }))}
                />
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
          </ReportSection>

          <ReportSection
            title={t('reports.section.products')}
            hint={t('reports.section.productsHint')}
          >
            <div className="grid grid--2">
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
              <Card title={t('reports.byEmployee')}>
                <BucketTable
                  rows={r.byEmployee.map((b) => ({ ...b, label: b.label ?? '—' }))}
                  money={fmt.money}
                  countLabel={t('reports.salesCount')}
                />
              </Card>
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
            </div>
          </ReportSection>

          <ReportSection title={t('reports.section.money')} hint={t('reports.section.moneyHint')}>
            <Card title={t('reports.expensesByCategory')}>
              <BucketTable
                rows={r.expenses.byCategory.map((b) => ({ ...b, label: b.label ?? b.key }))}
                money={fmt.money}
                countLabel={t('expenses.count')}
              />
            </Card>
            <CashBookCard from={range.from} to={range.to} enabled={valid} />
          </ReportSection>
        </div>
      )}
    </>
  );
}

/** The result of the period up top, with where the sales came from underneath. */
function ResultHero({ report: r }: { report: SalesReport }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const result = r.sales.netCents - r.expenses.totalCents;
  return (
    <section className="card rep-hero" data-testid="reports-hero">
      <div className="rep-hero__main">
        <div className="rep-hero__label">{t('reports.result')}</div>
        <div className={`rep-hero__value num ${result >= 0 ? 'is-good' : 'is-bad'}`}>
          {fmt.money(result)}
        </div>
        <div className="muted rep-hero__hint">
          {t('reports.resultHint')} · {fmt.money(r.sales.netCents)} −{' '}
          {fmt.money(r.expenses.totalCents)}
        </div>
      </div>
      <div className="rep-hero__split">
        <div className="rep-hero__split-title muted">{t('reports.bySource')}</div>
        <Composition
          money={fmt.money}
          rows={r.bySource.map((b) => ({
            key: b.key,
            label: t(`sales.source.${b.key}` as 'sales.source.retail'),
            amountCents: b.amountCents,
          }))}
        />
      </div>
    </section>
  );
}

/** A titled group of cards: the heading says what the group answers. */
function ReportSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section className="rep-section">
      <header className="rep-section__head">
        <h2 className="rep-section__title">{title}</h2>
        <p className="muted rep-section__hint">{hint}</p>
      </header>
      <div className="stack">{children}</div>
    </section>
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

const PALETTE = [
  'var(--accent)',
  'var(--success)',
  'var(--warning)',
  'var(--purple)',
  'var(--info)',
  'var(--danger)',
];

/** Vertical columns, one per row, scaled to the largest value. Values print above the columns
 *  when there are few enough to fit; every column keeps its full detail as a tooltip. */
function ColumnChart({
  rows,
  money,
  showValues,
}: {
  rows: { key: string; label: string; value: number; detail?: string }[];
  money: (c: number) => string;
  showValues?: boolean;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const values = showValues ?? rows.length <= 12;
  return (
    <div
      className="rep-cols"
      style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}
    >
      {rows.map((r) => (
        <div
          className="rep-col"
          key={r.key}
          title={
            r.detail
              ? `${r.label} · ${money(r.value)} · ${r.detail}`
              : `${r.label} · ${money(r.value)}`
          }
        >
          <div className="rep-col__value num">{values && r.value > 0 ? money(r.value) : ''}</div>
          <div className="rep-col__track">
            <div
              className="rep-col__bar"
              style={{ height: `${(r.value / max) * 100}%` }}
              data-empty={r.value === 0 ? 'true' : undefined}
            />
          </div>
          <div className="rep-col__label num">{r.label}</div>
        </div>
      ))}
    </div>
  );
}

/** One bar split by share, with a legend. Colours follow the row order, so they match the table. */
function Composition({
  rows,
  money,
}: {
  rows: { key: string; label: string; amountCents: number }[];
  money: (c: number) => string;
}) {
  const total = rows.reduce((a, b) => a + Math.max(0, b.amountCents), 0);
  if (total === 0) return null;
  const pct = (v: number) => `${Math.round((Math.max(0, v) / total) * 100)}%`;
  return (
    <div className="rep-comp">
      <div className="rep-comp__bar" role="img" aria-label={rows.map((b) => b.label).join(', ')}>
        {rows.map((b, i) =>
          b.amountCents > 0 ? (
            <span
              key={b.key}
              style={{ width: pct(b.amountCents), background: PALETTE[i % PALETTE.length] }}
              title={`${b.label} · ${money(b.amountCents)}`}
            />
          ) : null,
        )}
      </div>
      <ul className="rep-comp__legend">
        {rows.map((b, i) => (
          <li key={b.key}>
            <i style={{ background: PALETTE[i % PALETTE.length] }} aria-hidden="true" />
            <span>{b.label}</span>
            <span className="num">{money(b.amountCents)}</span>
            <span className="muted num">{pct(b.amountCents)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
