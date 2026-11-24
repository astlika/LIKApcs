/**
 * 0.40.0 — the products on a PC's bill, each with the time it was put there.
 *
 * A customer who plays takes a drink, later something to eat, and pays at the end. When the bill
 * is questioned, the desk reads the time next to the product and looks at the camera recording of
 * that minute. The same list is drawn wherever a bill is looked at: the PC's panel, the window
 * that ends the session, the one that collects a waiting bill, the payment window and the
 * customer's bill.
 */
import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDate, formatTimeWithSeconds, type StationOrder } from '@likapcs/shared';
import { api } from '../../lib/api';
import { quantityText, sessionBill, type BillLine, type SessionBill } from '../../lib/bill-items';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';

/** One product line as the list draws it. */
export interface BillListRow {
  key: string;
  /** When the product was put on the bill. */
  addedAt: string;
  quantityMilli: number;
  name: string;
  lineTotalCents: number;
  /** Who put it there ("Arta", "from the PC"); the list has that column when any row names one. */
  who?: string;
  /** The whole story, for the tooltip. */
  tip?: string;
}

/**
 * The list itself: time · quantity × product · who · amount, one product per line, the times in
 * a column of their own so they can be run down with the eye.
 */
export function BillList({
  rows,
  variant = 'panel',
  tone,
  testId = 'bill-items-list',
}: {
  rows: readonly BillListRow[];
  /**
   * `panel`: in the PC's panel. `quote`: under the row that sums the products in a payment
   * window. `pay`: inside the card of one PC where several PCs are paid together.
   */
  variant?: 'panel' | 'quote' | 'pay';
  /** `paid`: set back — these are settled already. */
  tone?: 'paid';
  testId?: string;
}) {
  const fmt = useFormat();
  if (rows.length === 0) return null;
  const withWho = rows.some((row) => row.who !== undefined);
  return (
    <ul
      className="bill-items__list"
      data-variant={variant}
      data-tone={tone}
      data-who={withWho || undefined}
      data-testid={testId}
    >
      {rows.map((row) => (
        <li key={row.key} className="bill-items__row" title={row.tip} data-testid="bill-item">
          <span className="bill-items__time num" data-testid="bill-item-time">
            {fmt.timeOn(row.addedAt)}
          </span>
          <span className="bill-items__name">
            {quantityText(row.quantityMilli)}× {row.name}
          </span>
          {withWho && (
            <span className="bill-items__who" data-testid="bill-item-who">
              {row.who ?? ''}
            </span>
          )}
          <span className="bill-items__amount num">{fmt.money(row.lineTotalCents)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The bill of one session, read from its own orders (`GET /orders?sessionId=`); null until it is
 * read. The query lives under `['orders']`, so everything that already refreshes orders — a
 * product added here, an order from a PC, a payment on another desk — refreshes it too.
 */
export function useSessionBill(sessionId: string): SessionBill | null {
  const orders = useQuery({
    queryKey: ['orders', 'session-bill', sessionId],
    queryFn: () => api<{ items: StationOrder[] }>('/orders', { query: { sessionId, limit: 200 } }),
    staleTime: 5_000,
  });
  return useMemo(() => (orders.data ? sessionBill(orders.data.items) : null), [orders.data]);
}

/** The lines of a session's bill as list rows: who added each one, and the tooltip. */
function useBillRows(): (lines: readonly BillLine[]) => BillListRow[] {
  const { t } = useI18n();
  const fmt = useFormat();
  return (lines) => {
    // The tooltip has the whole moment, to the second, and how the product came onto the bill.
    const exact = (value: string) =>
      `${formatDate(value, { timeZone: fmt.timeZone })} ${formatTimeWithSeconds(value, {
        timeZone: fmt.timeZone,
      })}`;
    return lines.map((line) => {
      const name = line.byName ?? '—';
      const how = line.requestedAt
        ? t('billItems.tipFromPc', {
            requested: exact(line.requestedAt),
            at: exact(line.addedAt),
            name,
          })
        : t('billItems.tipDesk', { at: exact(line.addedAt), name });
      return {
        key: line.key,
        addedAt: line.addedAt,
        quantityMilli: line.quantityMilli,
        name: line.name,
        lineTotalCents: line.lineTotalCents,
        who: line.requestedAt ? t('billItems.fromPc') : (line.byName ?? ''),
        tip:
          line.paid && line.receiptNo
            ? `${how} · ${t('billItems.tipReceipt', { receipt: line.receiptNo })}`
            : how,
      };
    });
  };
}

export function SessionBillItems({
  sessionId,
  showPaid = false,
  variant = 'panel',
  fallback = null,
}: {
  sessionId: string;
  /** Also what this session has paid for already (at once at the desk, or with a part of the bill). */
  showPaid?: boolean;
  variant?: 'panel' | 'quote';
  /** Shown until the bill is read. */
  fallback?: ReactNode;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const bill = useSessionBill(sessionId);
  const toRows = useBillRows();
  if (!bill) return <>{fallback}</>;
  const paid = showPaid ? bill.paid : [];
  if (bill.open.length === 0 && paid.length === 0) return null;
  return (
    <div className="bill-items" data-variant={variant} data-testid="bill-items">
      <BillList rows={toRows(bill.open)} variant={variant} testId="bill-items-open" />
      {paid.length > 0 && (
        <>
          <div className="bill-items__group" data-testid="bill-items-paid-head">
            <span>{t('billItems.paid')}</span>
            <span className="num">{fmt.money(bill.paidCents)}</span>
          </div>
          <BillList rows={toRows(paid)} variant={variant} tone="paid" testId="bill-items-paid" />
        </>
      )}
    </div>
  );
}
