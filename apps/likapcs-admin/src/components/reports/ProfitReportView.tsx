/**
 * 0.21.0 — "Profit & spending" on Reports: the profit and loss on the accrual basis, the money that
 * actually moved, stock brought in, data-quality checks, and the spending register (every money-out
 * and stock movement, filterable). Numbers come from `GET /reports/profit` and `GET /reports/spending`;
 * nothing is recomputed here except the percentages shown next to them.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  SPENDING_EFFECTS,
  SPENDING_KINDS,
  type ProfitReport,
  type ReportBucket,
  type SpendingEffect,
  type SpendingKind,
  type SpendingReport,
} from '@likapcs/shared';
import { api } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { Alert, Card, EmptyState, Loading, Select, StatTile } from '../ui/primitives';

type Fmt = ReturnType<typeof useFormat>;

/** Basis points → "12.3%". */
function percent(bp: number | null): string {
  return bp === null ? '—' : `${(bp / 100).toFixed(1)}%`;
}

export function ProfitReportView({ from, to }: { from: string; to: string }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const profit = useQuery({
    queryKey: ['reports', 'profit', from, to],
    queryFn: () => api<ProfitReport>('/reports/profit', { query: { from, to } }),
    placeholderData: (prev) => prev,
  });
  const spending = useQuery({
    queryKey: ['reports', 'spending', from, to],
    queryFn: () => api<SpendingReport>('/reports/spending', { query: { from, to } }),
    placeholderData: (prev) => prev,
  });
  const p = profit.data;
  const s = spending.data;

  if (profit.isError || spending.isError) {
    const err = profit.error ?? spending.error;
    return (
      <Alert tone="danger">{err instanceof Error ? err.message : t('common.errorGeneric')}</Alert>
    );
  }
  if (!p || !s) return <Loading />;

  const lossCount = p.checks.lossesWithoutCost;
  const checksFailing =
    p.checks.productsWithoutCost + p.checks.saleLinesWithoutCost + lossCount > 0;

  return (
    <div className="stack rep" style={{ gap: 24 }} data-testid="profit-report">
      <ProfitHero p={p} fmt={fmt} />

      <div className="grid grid--stats">
        <StatTile
          label={t('reports.profit.revenue')}
          value={fmt.money(p.revenue.revenueCents)}
          sub={t('reports.profit.revenueSub', {
            net: fmt.money(p.revenue.netSalesCents),
            vat: fmt.money(p.revenue.vatCents),
          })}
        />
        <StatTile
          label={t('reports.profit.cogs')}
          value={fmt.money(p.costOfSalesCents)}
          sub={t('reports.profit.cogsSub', { amount: fmt.money(p.refundedNotRestockedCents) })}
          tone={p.refundedNotRestockedCents ? 'warning' : undefined}
        />
        <StatTile
          label={t('reports.profit.gross')}
          value={fmt.money(p.grossProfitCents)}
          sub={percent(p.grossMarginBp)}
          tone={p.grossProfitCents < 0 ? 'danger' : 'success'}
        />
        <StatTile
          label={t('reports.profit.opex')}
          value={fmt.money(p.operatingExpensesCents)}
          sub={t('reports.profit.opexSub', {
            count: p.expensesByCategory.reduce((n, b) => n + b.count, 0),
          })}
        />
        <StatTile
          label={t('reports.profit.stockLoss')}
          value={fmt.money(p.stockLossCents)}
          sub={t('reports.profit.stockLossSub')}
          tone={p.stockLossCents ? 'warning' : undefined}
        />
      </div>

      <div className="grid grid--2">
        <Card
          title={t('reports.profit.plTitle')}
          subtitle={t('reports.profit.plHint')}
          testId="pnl-card"
        >
          <Rows
            rows={[
              { label: t('reports.profit.plRevenue'), value: fmt.money(p.revenue.revenueCents) },
              { label: t('reports.profit.plCogs'), value: fmt.money(-p.costOfSalesCents) },
              {
                label: t('reports.profit.plGross'),
                value: fmt.money(p.grossProfitCents),
                sub: percent(p.grossMarginBp),
                strong: true,
              },
              { label: t('reports.profit.plOpex'), value: fmt.money(-p.operatingExpensesCents) },
              { label: t('reports.profit.plLoss'), value: fmt.money(-p.stockLossCents) },
              {
                label: t('reports.profit.plNet'),
                value: fmt.money(p.netProfitCents),
                sub: percent(p.netMarginBp),
                strong: true,
                total: true,
              },
            ]}
          />
        </Card>

        <Card title={t('reports.profit.checksTitle')} testId="profit-checks">
          {checksFailing ? (
            <div className="stack" style={{ gap: 8 }}>
              {p.checks.productsWithoutCost > 0 && (
                <Alert tone="warning">
                  {t('reports.profit.checks.productsWithoutCost', {
                    count: p.checks.productsWithoutCost,
                  })}
                </Alert>
              )}
              {p.checks.saleLinesWithoutCost > 0 && (
                <Alert tone="warning">
                  {t('reports.profit.checks.saleLinesWithoutCost', {
                    count: p.checks.saleLinesWithoutCost,
                  })}
                </Alert>
              )}
              {lossCount > 0 && (
                <Alert tone="warning">
                  {t('reports.profit.checks.lossesWithoutCost', { count: lossCount })}
                </Alert>
              )}
            </div>
          ) : (
            <Alert tone="success">{t('reports.profit.checksOk')}</Alert>
          )}
        </Card>
      </div>

      <div className="grid grid--2">
        <Card title={t('reports.profit.moneyTitle')} subtitle={t('reports.profit.moneyHint')}>
          <Rows
            rows={[
              { label: t('reports.profit.drawerIn'), value: fmt.money(p.cash.drawerInCents) },
              { label: t('reports.profit.drawerOut'), value: fmt.money(-p.cash.drawerOutCents) },
              {
                label: t('reports.profit.supplierPaid'),
                value: fmt.money(-p.cash.supplierPaidCents),
              },
              {
                label: t('reports.profit.payables'),
                value: fmt.money(p.payables.supplierBalanceCents),
                strong: true,
              },
            ]}
          />
        </Card>
        <Card title={t('reports.profit.stockTitle')} subtitle={t('reports.profit.stockHint')}>
          <Rows
            rows={[
              { label: t('reports.profit.received'), value: fmt.money(p.stock.receivedCents) },
              { label: t('reports.profit.opening'), value: fmt.money(p.stock.openingCents) },
              { label: t('reports.profit.added'), value: fmt.money(p.stock.addedCents) },
            ]}
          />
        </Card>
      </div>

      <div className="grid grid--2">
        <Card title={t('reports.profit.expensesTitle')}>
          <BucketRows rows={p.expensesByCategory} fmt={fmt} empty={t('common.none')} />
        </Card>
        <Card title={t('reports.profit.lossTitle')}>
          <BucketRows
            rows={p.stockLossByType.map((b) => ({
              ...b,
              label: t(`reports.profit.lossType.${b.key}` as 'reports.profit.lossType.damaged'),
            }))}
            fmt={fmt}
            empty={t('common.none')}
          />
        </Card>
      </div>

      <SpendingCard report={s} fmt={fmt} />
    </div>
  );
}

function ProfitHero({ p, fmt }: { p: ProfitReport; fmt: Fmt }) {
  const { t } = useI18n();
  return (
    <section className="card rep-hero" data-testid="profit-hero">
      <div className="rep-hero__main">
        <div className="rep-hero__label">{t('reports.profit.result')}</div>
        <div className={`rep-hero__value num ${p.netProfitCents >= 0 ? 'is-good' : 'is-bad'}`}>
          {fmt.money(p.netProfitCents)}
        </div>
        <div className="muted rep-hero__hint">
          {t('reports.profit.resultHint')}
          {p.netMarginBp !== null && (
            <> · {t('reports.profit.resultMargin', { percent: percent(p.netMarginBp) })}</>
          )}
        </div>
      </div>
    </section>
  );
}

function Rows({
  rows,
}: {
  rows: { label: string; value: string; sub?: string; strong?: boolean; total?: boolean }[];
}) {
  return (
    <table className="table table--compact">
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} style={r.total ? { borderTop: '2px solid currentColor' } : undefined}>
            <td style={{ fontWeight: r.strong ? 600 : undefined }}>
              {r.label}
              {r.sub && <span className="muted"> · {r.sub}</span>}
            </td>
            <td className="right num" style={{ fontWeight: r.strong ? 600 : undefined }}>
              {r.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BucketRows({ rows, fmt, empty }: { rows: ReportBucket[]; fmt: Fmt; empty: string }) {
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  return (
    <table className="table table--compact">
      <tbody>
        {rows.map((b) => (
          <tr key={b.key}>
            <td>{b.label ?? b.key}</td>
            <td className="right num muted">{b.count}×</td>
            <td className="right num">{fmt.money(b.amountCents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SpendingCard({ report, fmt }: { report: SpendingReport; fmt: Fmt }) {
  const { t } = useI18n();
  const [kind, setKind] = useState<SpendingKind | 'all'>('all');
  const [effect, setEffect] = useState<SpendingEffect | 'all'>('all');
  const rows = report.rows.filter(
    (r) => (kind === 'all' || r.kind === kind) && (effect === 'all' || r.effect === effect),
  );
  const dateLabel = (d: string) => {
    const [, m, day] = d.split('-');
    return `${day}.${m}`;
  };

  return (
    <Card
      title={t('reports.profit.spendingTitle')}
      subtitle={t('reports.profit.spendingHint')}
      testId="spending-card"
      actions={
        <div className="row" style={{ gap: 8 }}>
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as SpendingKind | 'all')}
            aria-label={t('reports.profit.allKinds')}
          >
            <option value="all">{t('reports.profit.allKinds')}</option>
            {SPENDING_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`reports.profit.kind.${k}`)}
              </option>
            ))}
          </Select>
          <Select
            value={effect}
            onChange={(e) => setEffect(e.target.value as SpendingEffect | 'all')}
            aria-label={t('reports.profit.allEffects')}
          >
            <option value="all">{t('reports.profit.allEffects')}</option>
            {SPENDING_EFFECTS.map((x) => (
              <option key={x} value={x}>
                {t(`reports.profit.effect.${x}`)}
              </option>
            ))}
          </Select>
        </div>
      }
    >
      <table className="table table--compact" style={{ marginBottom: 12 }}>
        <tbody>
          {report.totals.map((x) => (
            <tr key={x.kind}>
              <td>{t(`reports.profit.kind.${x.kind}`)}</td>
              <td className="right num muted">{x.count}×</td>
              <td className="right num">{fmt.money(x.amountCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {report.rowCount === 0 ? (
        <EmptyState title={t('reports.profit.empty')} />
      ) : (
        <>
          <div className="table-scroll">
            <table className="table table--compact" data-testid="spending-rows">
              <thead>
                <tr>
                  <th>{t('reports.profit.col.date')}</th>
                  <th>{t('reports.profit.col.type')}</th>
                  <th>{t('reports.profit.col.effect')}</th>
                  <th>{t('reports.profit.col.description')}</th>
                  <th>{t('reports.profit.col.method')}</th>
                  <th className="right">{t('reports.profit.col.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.kind}-${r.reference ?? ''}-${i}`}>
                    <td className="num">{dateLabel(r.date)}</td>
                    <td>{t(`reports.profit.kind.${r.kind}`)}</td>
                    <td>
                      <span className="muted">{t(`reports.profit.effect.${r.effect}`)}</span>
                    </td>
                    <td>
                      {r.description}
                      {r.category && <span className="muted"> · {r.category}</span>}
                    </td>
                    <td>
                      {r.method === null
                        ? '—'
                        : r.kind === 'stock_loss'
                          ? t(
                              `reports.profit.lossType.${r.method}` as 'reports.profit.lossType.damaged',
                            )
                          : t(`sessions.methods.${r.method}` as 'sessions.methods.cash')}
                    </td>
                    <td className="right num">{fmt.money(r.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {kind === 'all' && effect === 'all' ? null : (
            <p className="muted" style={{ marginBottom: 0 }}>
              {t('reports.profit.filteredCount', { count: rows.length })}
            </p>
          )}
          {report.truncated && (
            <Alert tone="info">
              {t('reports.profit.truncated', { shown: report.rows.length, total: report.rowCount })}
            </Alert>
          )}
        </>
      )}
    </Card>
  );
}
