/**
 * 0.21.0 — the cash book on Reports: one row per cash shift in the range (opening, cash in, cash
 * out, expected, counted, difference). Open a row to see that shift's drawer movements. All
 * numbers come from `GET /reports/cash-book`; nothing is recomputed here.
 */
import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { CashBookReport, CashBookRow, CashMovementSummary } from '@likapcs/shared';
import { api } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { Card, EmptyState, Loading } from '../ui/primitives';

export function CashBookCard({
  from,
  to,
  enabled,
}: {
  from: string;
  to: string;
  enabled: boolean;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const book = useQuery({
    queryKey: ['reports', 'cash-book', from, to],
    queryFn: () => api<CashBookReport>('/reports/cash-book', { query: { from, to } }),
    enabled,
    placeholderData: (prev) => prev,
  });
  const data = book.data;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Card
      title={t('reports.cashBook.title')}
      subtitle={t('reports.cashBook.hint')}
      testId="cash-book-card"
    >
      {!data ? (
        <Loading />
      ) : data.rows.length === 0 ? (
        <EmptyState title={t('reports.cashBook.empty')} />
      ) : (
        <>
          <p className="muted" style={{ marginTop: 0 }} data-testid="cash-book-summary">
            {t('reports.cashBook.summary', {
              count: data.totals.shiftsCount,
              open: data.totals.openShiftsCount,
              difference: fmt.money(data.totals.differenceCents),
            })}
          </p>
          <div className="table-wrap">
            <table className="table table--compact" data-testid="cash-book-table">
              <thead>
                <tr>
                  <th style={{ width: 28 }} aria-hidden="true" />
                  <th>{t('cash.opened')}</th>
                  <th>{t('cash.register')}</th>
                  <th className="right">{t('reports.cashBook.opening')}</th>
                  <th className="right">{t('reports.cashBook.cashIn')}</th>
                  <th className="right">{t('reports.cashBook.cashOut')}</th>
                  <th className="right">{t('cash.expectedCash')}</th>
                  <th className="right">{t('reports.cashBook.counted')}</th>
                  <th className="right">{t('cash.difference')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const s = row.shift;
                  const isOpen = expanded.has(s.id);
                  return (
                    <Fragment key={s.id}>
                      <tr data-testid="cash-book-row">
                        <td>
                          <button
                            type="button"
                            className="btn btn--ghost btn--icon"
                            aria-expanded={isOpen}
                            aria-label={
                              isOpen ? t('reports.cashBook.collapse') : t('reports.cashBook.expand')
                            }
                            onClick={() => toggle(s.id)}
                          >
                            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        </td>
                        <td className="num">
                          {fmt.dateTime(s.openedAt)}
                          <span className="faint" style={{ marginLeft: 6, fontSize: 12 }}>
                            {s.openedBy.name}
                          </span>
                          {s.status === 'open' && (
                            <span className="badge badge--info" style={{ marginLeft: 6 }}>
                              {t('reports.cashBook.open')}
                            </span>
                          )}
                        </td>
                        <td>{s.registerName}</td>
                        <td className="right num">{fmt.money(s.openingCents)}</td>
                        <td className="right num">{fmt.money(row.cashInCents)}</td>
                        <td className="right num">{fmt.money(-row.cashOutCents)}</td>
                        <td className="right num">{fmt.money(row.expectedCashCents)}</td>
                        <td className="right num">
                          {s.countedCashCents != null ? fmt.money(s.countedCashCents) : '—'}
                        </td>
                        <td
                          className={`right num ${s.differenceCents ? 'text-danger' : ''}`}
                          data-testid="cash-book-difference"
                        >
                          {s.differenceCents != null ? fmt.money(s.differenceCents) : '—'}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="cash-book__movements">
                          <td />
                          <td colSpan={8}>
                            <Movements row={row} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr data-testid="cash-book-totals">
                  <td />
                  <td>
                    <strong>{t('reports.cashBook.total')}</strong>
                  </td>
                  <td />
                  <td className="right num">{fmt.money(data.totals.openingCents)}</td>
                  <td className="right num">{fmt.money(data.totals.cashInCents)}</td>
                  <td className="right num">{fmt.money(-data.totals.cashOutCents)}</td>
                  <td className="right num">{fmt.money(data.totals.expectedCashCents)}</td>
                  <td className="right num">{fmt.money(data.totals.countedCashCents)}</td>
                  <td className="right num">{fmt.money(data.totals.differenceCents)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

function Movements({ row }: { row: CashBookRow }) {
  const { t } = useI18n();
  const fmt = useFormat();
  if (row.movements.length === 0) {
    return <p className="muted">{t('reports.cashBook.noMovements')}</p>;
  }
  return (
    <table className="table table--compact" aria-label={t('reports.cashBook.movements')}>
      <thead>
        <tr>
          <th>{t('reports.cashBook.movementTime')}</th>
          <th>{t('cash.movementType')}</th>
          <th>{t('reports.cashBook.movementReason')}</th>
          <th>{t('reports.cashBook.movementBy')}</th>
          <th className="right">{t('reports.cashBook.movementAmount')}</th>
        </tr>
      </thead>
      <tbody>
        {row.movements.map((m: CashMovementSummary) => (
          <tr key={m.id}>
            <td className="num">{fmt.dateTime(m.createdAt)}</td>
            <td>{t(`cash.movement.${m.type}` as 'cash.movement.sale')}</td>
            <td className="muted">{m.reason ?? '—'}</td>
            <td>{m.createdBy?.name ?? '—'}</td>
            <td className={`right num ${m.amountCents < 0 ? 'text-danger' : ''}`}>
              {fmt.money(m.amountCents)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
