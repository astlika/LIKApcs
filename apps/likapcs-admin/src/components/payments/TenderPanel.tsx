/**
 * Tender panel — the one way money is taken everywhere in the app (POS payment, session start /
 * extend / end bills, quick start). It turns "how does the customer pay?" into the `payments`
 * array the server expects and reports whether the total is covered and the change to hand back.
 *
 * Modes (chips, shown only when more than one is possible):
 *   cash        default. "Cash received" pre-filled with the exact amount; denomination chips
 *               (`suggestTenders`) for what the customer plausibly hands over; change shown live.
 *   card        only when `pos.card_payments` is on; the full amount, optional reference.
 *   split       cash + card.
 *   credit      "pay later" — only when `pos.credit_sales` is on. Needs a customer; the part not
 *               paid in cash now goes on the customer's tab with a due date (pre-filled from
 *               `pos.credit_default_days`). The limit is checked here for a clear message and
 *               again on the server (the authority).
 *
 * `useTender` owns the state and the arithmetic (pure, integer cents); `TenderPanel` renders it.
 * Keep the two together: a dialog calls the hook, reads `tender.covered` / `tender.payments` for
 * its submit button, and renders `<TenderPanel tender={tender} … />`.
 */
import { Banknote, CalendarClock, CreditCard, UserRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CustomerSummary, SalePaymentInput } from '@likapcs/shared';
import { parseMoneyInput } from '@likapcs/shared';
import { useI18n } from '../../i18n';
import { useFormat } from '../../lib/format';
import { suggestTenders } from '../../lib/tender';
import { useAppSettings } from '../../state/app-settings';
import { CustomerPicker } from '../customers/CustomerPicker';
import { Alert, Field, Input } from '../ui/primitives';

export type TenderMode = 'cash' | 'card' | 'split' | 'credit';

/** A number far above the total is a barcode that landed in the field, not money. */
const MAX_OVERPAY_CENTS = 100_000_00;

/** `YYYY-MM-DD` for today plus `days` in the local calendar (same basis as the server's date). */
export function dueDateFromToday(days: number, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface TenderInput {
  totalCents: number;
  /** Customer attached to the sale / session (required for "pay later"). */
  customer: CustomerSummary | null;
  /** Hide "pay later" even when the setting is on (e.g. contexts without a customer concept). */
  allowCredit?: boolean;
}

export interface Tender {
  totalCents: number;
  mode: TenderMode;
  setMode: (m: TenderMode) => void;
  /** Modes the chips offer (cash is always first). */
  modes: TenderMode[];
  cashText: string;
  setCashText: (v: string) => void;
  cardText: string;
  setCardText: (v: string) => void;
  reference: string;
  setReference: (v: string) => void;
  dueDate: string;
  setDueDate: (v: string) => void;
  cashCents: number | null;
  cardCents: number | null;
  /** What the cash field should cover in the current mode (total minus card / credit part). */
  cashTargetCents: number;
  payments: SalePaymentInput[];
  paidCents: number;
  creditCents: number;
  changeCents: number;
  /** Total is covered by valid tenders and nothing is implausible → the sale may complete. */
  covered: boolean;
  problem: 'cardOver' | 'implausible' | 'creditNeedsCustomer' | 'creditOverLimit' | null;
  customer: CustomerSummary | null;
}

export function useTender({ totalCents, customer, allowCredit = true }: TenderInput): Tender {
  const settings = useAppSettings();
  const cardEnabled = settings['pos.card_payments'];
  const creditEnabled = allowCredit && settings['pos.credit_sales'];
  const defaultDays = settings['pos.credit_default_days'];
  const [mode, setMode] = useState<TenderMode>('cash');
  // Pre-filled with the exact amount (selected on focus, so typing replaces it): an exact cash
  // sale is Enter → Enter.
  const [cashText, setCashText] = useState((totalCents / 100).toFixed(2));
  const [cardText, setCardText] = useState('');
  const [reference, setReference] = useState('');
  const [dueDate, setDueDate] = useState(() => dueDateFromToday(defaultDays));

  const modes: TenderMode[] = ['cash'];
  if (cardEnabled) modes.push('card', 'split');
  if (creditEnabled) modes.push('credit');
  const effective: TenderMode = modes.includes(mode) ? mode : 'cash';

  const cashCents = cashText.trim() ? parseMoneyInput(cashText) : 0;
  const cardCents = cardText.trim() ? parseMoneyInput(cardText) : 0;
  const payments: SalePaymentInput[] = [];
  let creditCents = 0;
  let problem: Tender['problem'] = null;
  if (effective === 'card') {
    payments.push({ method: 'card', amountCents: totalCents, reference: reference || undefined });
  } else if (effective === 'credit') {
    const cashNow = Math.max(0, Math.min(cashCents ?? 0, totalCents));
    creditCents = totalCents - cashNow;
    if (cashNow > 0) payments.push({ method: 'cash', amountCents: cashNow });
    if (creditCents > 0) payments.push({ method: 'credit', amountCents: creditCents, dueDate });
    if (creditCents > 0 && !customer) problem = 'creditNeedsCustomer';
    else if (
      creditCents > 0 &&
      customer &&
      customer.creditLimitCents > 0 &&
      customer.balanceDueCents + creditCents > customer.creditLimitCents
    )
      problem = 'creditOverLimit';
  } else {
    if (effective === 'split' && cardCents && cardCents > 0)
      payments.push({ method: 'card', amountCents: cardCents, reference: reference || undefined });
    if (cashCents && cashCents > 0) payments.push({ method: 'cash', amountCents: cashCents });
  }
  const paidCents = payments.reduce((a, p) => a + p.amountCents, 0);
  const nonCash = payments
    .filter((p) => p.method !== 'cash')
    .reduce((a, p) => a + p.amountCents, 0);
  if (!problem && nonCash > totalCents) problem = 'cardOver';
  if (!problem && paidCents > totalCents + MAX_OVERPAY_CENTS) problem = 'implausible';
  const valid = cashCents !== null && cardCents !== null && problem === null;
  const covered = valid && paidCents >= totalCents && (effective !== 'credit' || !!dueDate);
  const changeCents = covered ? paidCents - totalCents : 0;
  const cashTargetCents =
    effective === 'split' ? Math.max(0, totalCents - (cardCents ?? 0)) : totalCents;

  return {
    totalCents,
    mode: effective,
    setMode,
    modes,
    cashText,
    setCashText,
    cardText,
    setCardText,
    reference,
    setReference,
    dueDate,
    setDueDate,
    cashCents,
    cardCents,
    cashTargetCents,
    payments,
    paidCents,
    creditCents,
    changeCents,
    covered,
    problem,
    customer,
  };
}

export function TenderPanel({
  tender,
  onSubmit,
  onCustomerChange,
  autoFocus = true,
  testId = 'pos',
}: {
  tender: Tender;
  /** Enter in the cash field. */
  onSubmit: () => void;
  /** When given, "pay later" without a customer shows a picker right in the panel. */
  onCustomerChange?: (customer: CustomerSummary | null) => void;
  autoFocus?: boolean;
  testId?: string;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const cashRef = useRef<HTMLInputElement>(null);
  const { mode, customer } = tender;

  // Credit mode starts with nothing paid now: the whole amount goes on the tab unless typed.
  const switchMode = (m: TenderMode) => {
    if (m === tender.mode) return;
    tender.setMode(m);
    if (m === 'credit') tender.setCashText('');
    else if (tender.mode === 'credit' && !tender.cashText.trim())
      tender.setCashText((tender.totalCents / 100).toFixed(2));
  };

  useEffect(() => {
    if (!autoFocus) return;
    cashRef.current?.focus();
    cashRef.current?.select();
  }, [mode, autoFocus]);

  const pick = (cents: number) => {
    tender.setCashText((cents / 100).toFixed(2));
    cashRef.current?.focus();
  };

  const modeLabel: Record<TenderMode, { label: string; icon: JSX.Element | null }> = {
    cash: { label: t('pos.cash'), icon: <Banknote size={14} /> },
    card: { label: t('pos.card'), icon: <CreditCard size={14} /> },
    split: { label: `${t('pos.cash')} + ${t('pos.card')}`, icon: null },
    credit: { label: t('pos.payLater'), icon: <CalendarClock size={14} /> },
  };

  return (
    <div className="stack">
      <div className="pos__grand" style={{ fontSize: 26 }}>
        <span>{t('pos.total')}</span>
        <span className="num">{fmt.money(tender.totalCents)}</span>
      </div>

      {tender.modes.length > 1 && (
        <div className="chips" data-testid={`${testId}-methods`}>
          {tender.modes.map((m) => (
            <button
              key={m}
              type="button"
              className={`chip ${m === 'credit' ? 'chip--credit' : ''}`}
              aria-pressed={mode === m}
              onClick={() => switchMode(m)}
              data-testid={`${testId}-method-${m}`}
            >
              {modeLabel[m].icon} {modeLabel[m].label}
            </button>
          ))}
        </div>
      )}

      {mode === 'credit' && (
        <div className="tender-credit">
          {customer ? (
            <div className="tender-credit__who">
              <UserRound size={16} />
              <div className="tender-credit__name">
                <strong>{customer.name}</strong>
                <span className="muted">
                  {customer.balanceDueCents > 0
                    ? t('pos.payLaterBalance', { amount: fmt.money(customer.balanceDueCents) })
                    : t('pos.payLaterNoBalance')}
                  {customer.creditLimitCents > 0 &&
                    ` · ${t('pos.payLaterLimit', { amount: fmt.money(customer.creditLimitCents) })}`}
                </span>
              </div>
            </div>
          ) : onCustomerChange ? (
            <Field label={t('pos.customer')} hint={t('pos.payLaterNeedsCustomer')}>
              {(id) => (
                <CustomerPicker
                  id={id}
                  value={null}
                  onChange={onCustomerChange}
                  placeholder={t('pos.customerPlaceholder')}
                  autoFocus
                />
              )}
            </Field>
          ) : (
            <Alert tone="warning">{t('pos.payLaterNeedsCustomer')}</Alert>
          )}
          <div className="grid grid--2">
            <Field label={t('pos.payLaterDue')}>
              {(id) => (
                <Input
                  id={id}
                  type="date"
                  value={tender.dueDate}
                  min={dueDateFromToday(0)}
                  onChange={(e) => tender.setDueDate(e.target.value)}
                  data-testid={`${testId}-due-date`}
                />
              )}
            </Field>
            <Field label={t('pos.payLaterCashNow')} optional>
              {(id) => (
                <Input
                  id={id}
                  ref={cashRef}
                  inputMode="decimal"
                  className="num"
                  placeholder="0.00"
                  value={tender.cashText}
                  onChange={(e) => tender.setCashText(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      onSubmit();
                    }
                  }}
                  aria-invalid={tender.cashCents === null}
                  data-testid={`${testId}-tendered`}
                />
              )}
            </Field>
          </div>
        </div>
      )}

      {(mode === 'cash' || mode === 'split') && (
        <>
          <div className="chips">
            <button type="button" className="chip" onClick={() => pick(tender.cashTargetCents)}>
              {t('pos.exact')}
            </button>
            {suggestTenders(tender.cashTargetCents).map((c) => (
              <button
                key={c}
                type="button"
                className="chip chip--tender"
                data-testid={`${testId}-tender-chip`}
                onClick={() => pick(c)}
              >
                {fmt.money(c)}
              </button>
            ))}
          </div>
          <Field label={t('pos.tendered')} hint={t('pos.tenderedHint')}>
            {(id) => (
              <Input
                id={id}
                ref={cashRef}
                inputMode="decimal"
                className="num"
                style={{ fontSize: 22, height: 48 }}
                value={tender.cashText}
                onChange={(e) => tender.setCashText(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onSubmit();
                  }
                }}
                aria-invalid={tender.cashCents === null || tender.problem === 'implausible'}
                data-testid={`${testId}-tendered`}
              />
            )}
          </Field>
        </>
      )}

      {(mode === 'card' || mode === 'split') && (
        <div className="grid grid--2">
          {mode === 'split' && (
            <Field label={t('pos.card')}>
              {(id) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  className="num"
                  value={tender.cardText}
                  onChange={(e) => tender.setCardText(e.target.value)}
                  aria-invalid={tender.cardCents === null || tender.problem === 'cardOver'}
                />
              )}
            </Field>
          )}
          <Field label={t('pos.reference')} optional>
            {(id) => (
              <Input
                id={id}
                value={tender.reference}
                maxLength={80}
                onChange={(e) => tender.setReference(e.target.value)}
              />
            )}
          </Field>
        </div>
      )}

      {tender.problem === 'cardOver' && <Alert tone="danger">{t('pos.cardOver')}</Alert>}
      {tender.problem === 'implausible' && (
        <Alert tone="danger">{t('pos.implausibleAmount')}</Alert>
      )}
      {tender.problem === 'creditOverLimit' && (
        <Alert tone="danger">{t('pos.payLaterOverLimit')}</Alert>
      )}
      {!tender.covered &&
        tender.problem === null &&
        tender.paidCents > 0 &&
        tender.paidCents < tender.totalCents && (
          <div className="row row--between">
            <span className="muted">{t('pos.remaining')}</span>
            <strong className="num">{fmt.money(tender.totalCents - tender.paidCents)}</strong>
          </div>
        )}
      {tender.covered && mode === 'credit' && tender.creditCents > 0 && (
        <div className="pos__change pos__change--credit" data-testid={`${testId}-credit`}>
          <span>
            {t('pos.payLaterOnTab')} · {fmt.date(tender.dueDate)}
          </span>
          <strong className="num">{fmt.money(tender.creditCents)}</strong>
        </div>
      )}
      {tender.covered && (mode !== 'credit' || tender.creditCents === 0) && (
        <div className="pos__change" data-testid={`${testId}-change`}>
          <span>{t('pos.change')}</span>
          <strong className="num">{fmt.money(tender.changeCents)}</strong>
        </div>
      )}
    </div>
  );
}
