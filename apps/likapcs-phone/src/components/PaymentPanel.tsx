/**
 * Payment for a sale: one or more payment lines (cash, card, transfer, debt), quick cash amounts,
 * the amount still missing and the change to give back. Used by the phone and the tablet.
 * The server takes the lines as they are: non-cash lines may not exceed the total, and cash may
 * exceed it (the difference is the change).
 */
import type { SalePaymentMethod } from '@likapcs/shared';
import { money, parseEuroToCents } from '../api';
import { METHOD_LABEL } from '../labels';
import { useT } from '../i18n';
import { EuroInput, Notice } from './ui';

export interface PaymentLine {
  id: string;
  method: SalePaymentMethod;
  /** What the user typed, e.g. "12,50". */
  text: string;
  /** False while the line still follows the total automatically. */
  touched: boolean;
}

let lineSeq = 0;
export function newPaymentLine(method: SalePaymentMethod, text = '', touched = false): PaymentLine {
  lineSeq += 1;
  return { id: `pay-${lineSeq}`, method, text, touched };
}

export const centsText = (cents: number): string => (Math.max(0, cents) / 100).toFixed(2).replace('.', ',');

export interface PaymentSummary {
  /** Cents given so far (cash plus non-cash). */
  paid: number;
  /** Still missing; 0 when the sale can be finished. */
  remaining: number;
  /** Change to give back (cash only). */
  change: number;
  /** The amount due in cash when every non-cash line is counted as given. */
  cashDue: number;
  /** Non-cash lines above the total: the sale cannot be finished. */
  nonCashTooHigh: boolean;
  /** Lines that are sent to the server. */
  payments: { method: SalePaymentMethod; amountCents: number }[];
}

export function summarizePayment(lines: PaymentLine[], total: number): PaymentSummary {
  let nonCash = 0;
  let cash = 0;
  const payments: PaymentSummary['payments'] = [];
  for (const l of lines) {
    const cents = Math.max(0, parseEuroToCents(l.text) ?? 0);
    if (cents <= 0) continue;
    if (l.method === 'cash') cash += cents;
    else nonCash += cents;
    payments.push({ method: l.method, amountCents: cents });
  }
  const paid = cash + nonCash;
  return {
    paid,
    remaining: Math.max(0, total - paid),
    change: Math.max(0, paid - total),
    cashDue: Math.max(0, total - nonCash),
    nonCashTooHigh: nonCash > total,
    payments,
  };
}

const QUICK_NOTES = [5, 10, 20, 50];

export function PaymentPanel({
  total,
  lines,
  onChange,
  canCredit,
}: {
  total: number;
  lines: PaymentLine[];
  onChange: (lines: PaymentLine[]) => void;
  canCredit: boolean;
}) {
  const t = useT();
  const s = summarizePayment(lines, total);
  const cashLine = lines.find((l) => l.method === 'cash');

  const update = (id: string, patch: Partial<PaymentLine>) =>
    onChange(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const setCash = (cents: number) => {
    if (cashLine) update(cashLine.id, { text: centsText(cents), touched: true });
    else onChange([...lines, newPaymentLine('cash', centsText(cents), true)]);
  };

  const addLine = (method: SalePaymentMethod) =>
    onChange([...lines, newPaymentLine(method, centsText(s.remaining), true)]);

  const remove = (id: string) => onChange(lines.filter((l) => l.id !== id));

  const labelOf = (m: SalePaymentMethod): string => t(METHOD_LABEL[m] ?? m);

  return (
    <section className="pay-panel" aria-label={t('Pagesa')}>
      <h3 className="pay-panel__title">{t('Pagesa')}</h3>

      <div className="pay-lines">
        {lines.map((l) => (
          <div key={l.id} className="pay-line">
            <div className="pay-line__amount">
              <EuroInput label={labelOf(l.method)} value={l.text} onChange={(text) => update(l.id, { text, touched: true })} />
            </div>
            {lines.length > 1 && (
              <button type="button" className="icon-btn pay-line__remove" aria-label={t('Hiq')} onClick={() => remove(l.id)}>
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="pay-quick" role="group" aria-label={t('Shuma me para')}>
        <button type="button" className="chip chip--strong" onClick={() => setCash(s.cashDue)}>
          {t('Sakto')}
        </button>
        {QUICK_NOTES.map((v) => (
          <button key={v} type="button" className="chip" onClick={() => setCash(v * 100)}>
            {v} €
          </button>
        ))}
      </div>

      <div className="pay-add" role="group" aria-label={t('Shto pagesë')}>
        <button type="button" className="ghost small-btn" onClick={() => addLine('card')}>
          + {labelOf('card')}
        </button>
        <button type="button" className="ghost small-btn" onClick={() => addLine('bank_transfer')}>
          + {labelOf('bank_transfer')}
        </button>
        {canCredit && (
          <button type="button" className="ghost small-btn" onClick={() => addLine('credit')}>
            + {labelOf('credit')}
          </button>
        )}
      </div>

      <div className="pay-summary">
        <div className="total-row">
          <span>{t('Mbetet')}</span>
          <strong className={s.remaining > 0 ? 'text-danger' : undefined}>{money(s.remaining)}</strong>
        </div>
        {s.change > 0 && (
          <div className="total-row pay-change">
            <span>{t('Kthimi')}</span>
            <strong>{money(s.change)}</strong>
          </div>
        )}
      </div>
      {s.nonCashTooHigh && <Notice tone="danger">{t('Pagesat jo-kesh janë më të mëdha se totali.')}</Notice>}
    </section>
  );
}
