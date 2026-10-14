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
 *   credit      "pay later" — for cashiers holding `debts.give`. Needs a named customer (picked or
 *               created on the spot); the part not paid in cash now goes on the customer's tab
 *               with a due date (pre-filled from `pos.credit_default_days`). The limit is checked
 *               here for a clear message and again on the server (the authority).
 *   wallet      "balance" (0.11.0, `wallet.enabled`) — paid from the money the customer left in
 *               advance. Pre-filled with as much of the total as the balance covers; the rest is
 *               cash. The server locks the customer row and is the authority on the balance
 *               (409 `wallet_insufficient` carries the real figure).
 *
 * `useTender` owns the state and the arithmetic (pure, integer cents); `TenderPanel` renders it.
 * Keep the two together: a dialog calls the hook, reads `tender.covered` / `tender.payments` for
 * its submit button, and renders `<TenderPanel tender={tender} … />`.
 */
import { Banknote, CalendarClock, CreditCard, Hourglass, UserRound, Wallet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CustomerSummary, SalePaymentInput } from '@likapcs/shared';
import { PERMISSIONS, parseMoneyInput } from '@likapcs/shared';
import { useI18n } from '../../i18n';
import { useFormat } from '../../lib/format';
import { suggestTenders } from '../../lib/tender';
import { useAppSettings } from '../../state/app-settings';
import { useAuth } from '../../state/auth';
import { usePosFlags } from '../../lib/pos-flags';
import { CustomerPicker } from '../customers/CustomerPicker';
import { Alert, Field, Input } from '../ui/primitives';

export type TenderMode = 'cash' | 'endpay' | 'card' | 'split' | 'credit' | 'wallet';

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
  /** Hide "pay later" even for cashiers who may give it (contexts without a customer concept). */
  allowCredit?: boolean;
  /** Hide the balance tender (contexts without a customer concept). */
  allowWallet?: boolean;
  /**
   * Offer "End Pay" (session start only): nothing is paid now, the PC runs for the chosen time and
   * the bill is collected at the desk when the session ends. Sits right after Cash.
   */
  allowEndPay?: boolean;
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
  /** 0.19.0: pay-later installments as typed (empty = a plain debt). */
  installmentsText: string;
  setInstallmentsText: (v: string) => void;
  /** Balance mode: the part taken from the customer's wallet (text as typed). */
  walletText: string;
  setWalletText: (v: string) => void;
  cashCents: number | null;
  cardCents: number | null;
  walletCents: number | null;
  /** What the cash field should cover in the current mode (total minus card / credit / balance part). */
  cashTargetCents: number;
  payments: SalePaymentInput[];
  paidCents: number;
  creditCents: number;
  changeCents: number;
  /** Total is covered by valid tenders and nothing is implausible → the sale may complete. */
  covered: boolean;
  /** "End Pay" chosen: no payments now — the caller starts the session with `billingMode: 'endpay'`. */
  endPay: boolean;
  problem:
    | 'cardOver'
    | 'implausible'
    | 'creditNeedsCustomer'
    | 'creditOverLimit'
    | 'walletNeedsCustomer'
    | 'walletEmpty'
    | 'walletOver'
    | 'installmentsInvalid'
    | null;
  customer: CustomerSummary | null;
}

/** As much of the total as the balance covers — the pre-fill of the balance field. */
export function walletCoverCents(customer: CustomerSummary | null, totalCents: number): number {
  return Math.max(0, Math.min(customer?.walletBalanceCents ?? 0, totalCents));
}

export function useTender({
  totalCents,
  customer,
  allowCredit = true,
  allowWallet = true,
  allowEndPay = false,
}: TenderInput): Tender {
  const settings = useAppSettings();
  const { can } = useAuth();
  const cardEnabled = settings['pos.card_payments'];
  const creditEnabled = allowCredit && can(PERMISSIONS.DEBTS_GIVE);
  const walletEnabled = allowWallet && settings['wallet.enabled'];
  const defaultDays = settings['pos.credit_default_days'];
  const [mode, setMode] = useState<TenderMode>('cash');
  // Pre-filled with the exact amount (selected on focus, so typing replaces it): an exact cash
  // sale is Enter → Enter.
  const [cashText, setCashText] = useState((totalCents / 100).toFixed(2));
  const [cardText, setCardText] = useState('');
  const [walletText, setWalletText] = useState('');
  const [reference, setReference] = useState('');
  const [dueDate, setDueDate] = useState(() => dueDateFromToday(defaultDays));
  const [installmentsText, setInstallmentsText] = useState('');
  // The total can move while the panel is open (a session quote re-priced, a discount typed).
  // An untouched exact amount follows it; an amount the cashier typed is left alone.
  const [seenTotal, setSeenTotal] = useState(totalCents);
  if (seenTotal !== totalCents) {
    setSeenTotal(totalCents);
    const untouched = cashText.trim() === '' || cashText === (seenTotal / 100).toFixed(2);
    if (untouched && mode !== 'credit' && mode !== 'wallet')
      setCashText((totalCents / 100).toFixed(2));
    if (mode === 'wallet') {
      const cover = walletCoverCents(customer, totalCents);
      setWalletText((cover / 100).toFixed(2));
      setCashText(((totalCents - cover) / 100).toFixed(2));
    }
  }
  // A customer picked (or swapped) while in balance mode re-fills the split from their balance.
  const [seenCustomer, setSeenCustomer] = useState(customer?.id ?? null);
  if ((customer?.id ?? null) !== seenCustomer) {
    setSeenCustomer(customer?.id ?? null);
    if (mode === 'wallet') {
      const cover = walletCoverCents(customer, totalCents);
      setWalletText((cover / 100).toFixed(2));
      setCashText(((totalCents - cover) / 100).toFixed(2));
    }
  }

  // Order is deliberate: Cash · End Pay · (Card · Cash + Card) · Balance · Pay later.
  const modes: TenderMode[] = ['cash'];
  if (allowEndPay) modes.push('endpay');
  if (cardEnabled) modes.push('card', 'split');
  if (walletEnabled) modes.push('wallet');
  if (creditEnabled) modes.push('credit');
  const effective: TenderMode = modes.includes(mode) ? mode : 'cash';

  const cashCents = cashText.trim() ? parseMoneyInput(cashText) : 0;
  const cardCents = cardText.trim() ? parseMoneyInput(cardText) : 0;
  const walletCents = walletText.trim() ? parseMoneyInput(walletText) : 0;
  const payments: SalePaymentInput[] = [];
  let creditCents = 0;
  let problem: Tender['problem'] = null;
  if (effective === 'endpay') {
    // Nothing changes hands now; the amount is collected when the session ends.
  } else if (effective === 'card') {
    payments.push({ method: 'card', amountCents: totalCents, reference: reference || undefined });
  } else if (effective === 'wallet') {
    const fromWallet = walletCents ?? 0;
    if (fromWallet > 0) payments.push({ method: 'wallet', amountCents: fromWallet });
    if (cashCents && cashCents > 0) payments.push({ method: 'cash', amountCents: cashCents });
    if (!customer) problem = 'walletNeedsCustomer';
    else if (customer.walletBalanceCents <= 0) problem = 'walletEmpty';
    else if (fromWallet > customer.walletBalanceCents || fromWallet > totalCents)
      problem = 'walletOver';
  } else if (effective === 'credit') {
    const cashNow = Math.max(0, Math.min(cashCents ?? 0, totalCents));
    creditCents = totalCents - cashNow;
    if (cashNow > 0) payments.push({ method: 'cash', amountCents: cashNow });
    // Installments (0.19.0): a count of parts (2–24); empty means a plain debt.
    const installments = installmentsText.trim() ? Number(installmentsText.trim()) : null;
    if (
      installments !== null &&
      (!Number.isInteger(installments) || installments < 2 || installments > 24)
    )
      problem = 'installmentsInvalid';
    if (creditCents > 0)
      payments.push({
        method: 'credit',
        amountCents: creditCents,
        dueDate,
        ...(installments !== null && installments >= 2 ? { installments } : {}),
      });
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
  const valid =
    cashCents !== null && cardCents !== null && walletCents !== null && problem === null;
  const covered =
    effective === 'endpay' ||
    (valid &&
      paidCents >= totalCents &&
      (effective !== 'credit' || !!dueDate) &&
      (effective !== 'wallet' || (walletCents ?? 0) > 0));
  const changeCents = covered && effective !== 'endpay' ? paidCents - totalCents : 0;
  const cashTargetCents =
    effective === 'split'
      ? Math.max(0, totalCents - (cardCents ?? 0))
      : effective === 'wallet'
        ? Math.max(0, totalCents - (walletCents ?? 0))
        : totalCents;

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
    installmentsText,
    setInstallmentsText,
    walletText,
    setWalletText,
    cashCents,
    cardCents,
    walletCents,
    cashTargetCents,
    payments,
    paidCents,
    creditCents,
    changeCents,
    covered,
    endPay: effective === 'endpay',
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
  const flags = usePosFlags();
  const fmt = useFormat();
  const cashRef = useRef<HTMLInputElement>(null);
  const { mode, customer } = tender;

  // Credit mode starts with nothing paid now: the whole amount goes on the tab unless typed.
  // Balance mode starts with as much as the balance covers; the rest is pre-filled as cash.
  const switchMode = (m: TenderMode) => {
    if (m === tender.mode) return;
    tender.setMode(m);
    if (m === 'credit') tender.setCashText('');
    else if (m === 'wallet') {
      const cover = walletCoverCents(customer, tender.totalCents);
      tender.setWalletText((cover / 100).toFixed(2));
      tender.setCashText(((tender.totalCents - cover) / 100).toFixed(2));
    } else if (
      (tender.mode === 'credit' || tender.mode === 'wallet' || tender.mode === 'endpay') &&
      (!tender.cashText.trim() || tender.cashText !== (tender.totalCents / 100).toFixed(2))
    )
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
    endpay: { label: t('pos.endPay'), icon: <Hourglass size={14} /> },
    card: { label: t('pos.card'), icon: <CreditCard size={14} /> },
    split: { label: `${t('pos.cash')} + ${t('pos.card')}`, icon: null },
    credit: { label: t('pos.payLater'), icon: <CalendarClock size={14} /> },
    wallet: {
      label:
        customer && customer.walletBalanceCents > 0
          ? `${t('pos.wallet')} · ${fmt.money(customer.walletBalanceCents)}`
          : t('pos.wallet'),
      icon: <Wallet size={14} />,
    },
  };
  const walletRest = Math.max(0, tender.totalCents - (tender.walletCents ?? 0));

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
              className={`chip ${m === 'credit' ? 'chip--credit' : ''} ${m === 'wallet' ? 'chip--wallet' : ''} ${m === 'endpay' ? 'chip--endpay' : ''}`}
              aria-pressed={mode === m}
              onClick={() => switchMode(m)}
              data-testid={`${testId}-method-${m}`}
            >
              {modeLabel[m].icon} {modeLabel[m].label}
            </button>
          ))}
        </div>
      )}

      {mode === 'endpay' && (
        <div className="tender-credit tender-endpay" data-testid={`${testId}-endpay`}>
          <div className="tender-credit__who">
            <Hourglass size={16} />
            <div className="tender-credit__name">
              <strong>{t('pos.endPayTitle')}</strong>
              <span className="muted">
                {t('pos.endPayHint', { amount: fmt.money(tender.totalCents) })}
              </span>
            </div>
          </div>
          {onCustomerChange && (
            <Field label={t('pos.customer')} optional hint={t('pos.endPayCustomerHint')}>
              {(id) => (
                <CustomerPicker
                  id={id}
                  value={customer}
                  onChange={onCustomerChange}
                  placeholder={t('pos.customerPlaceholder')}
                  allowCreate
                />
              )}
            </Field>
          )}
        </div>
      )}

      {mode === 'wallet' && (
        <div className="tender-credit tender-wallet" data-testid={`${testId}-wallet`}>
          {customer ? (
            <div className="tender-credit__who">
              <Wallet size={16} />
              <div className="tender-credit__name">
                <strong>{customer.name}</strong>
                <span className="muted" data-testid={`${testId}-wallet-balance`}>
                  {t('pos.walletBalance', { amount: fmt.money(customer.walletBalanceCents) })}
                </span>
              </div>
            </div>
          ) : onCustomerChange ? (
            <Field label={t('pos.customer')} hint={t('pos.walletNeedsCustomer')}>
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
            <Alert tone="warning">{t('pos.walletNeedsCustomer')}</Alert>
          )}
          {customer && customer.walletBalanceCents <= 0 && (
            <Alert tone="warning">{t('pos.walletEmpty')}</Alert>
          )}
          {customer && customer.walletBalanceCents > 0 && (
            <div className="grid grid--2">
              <Field label={t('pos.walletFrom')}>
                {(id) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    className="num"
                    value={tender.walletText}
                    onChange={(e) => {
                      tender.setWalletText(e.target.value);
                      const cents = e.target.value.trim() ? parseMoneyInput(e.target.value) : 0;
                      if (cents !== null)
                        tender.setCashText(
                          (Math.max(0, tender.totalCents - cents) / 100).toFixed(2),
                        );
                    }}
                    onFocus={(e) => e.currentTarget.select()}
                    aria-invalid={tender.walletCents === null || tender.problem === 'walletOver'}
                    data-testid={`${testId}-wallet-amount`}
                  />
                )}
              </Field>
              <Field
                label={t('pos.walletCashRest')}
                hint={walletRest > 0 ? t('pos.walletCashRestHint') : undefined}
              >
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
          )}
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
                  allowCreate
                  autoFocus
                />
              )}
            </Field>
          ) : (
            <Alert tone="warning">{t('pos.payLaterNeedsCustomer')}</Alert>
          )}
          {flags.installments && (
            <Field label={t('pos.installments')} optional hint={t('pos.installmentsHint')}>
              {(id) => (
                <Input
                  id={id}
                  inputMode="numeric"
                  placeholder="—"
                  value={tender.installmentsText}
                  onChange={(e) => tender.setInstallmentsText(e.target.value.slice(0, 2))}
                  data-testid={`${testId}-installments`}
                />
              )}
            </Field>
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
      {tender.problem === 'walletOver' && <Alert tone="danger">{t('pos.walletOver')}</Alert>}
      {tender.problem === 'installmentsInvalid' && (
        <Alert tone="danger">{t('pos.installmentsInvalid')}</Alert>
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
      {tender.covered && mode === 'wallet' && (
        <div className="pos__change pos__change--wallet" data-testid={`${testId}-wallet-part`}>
          <span>
            {t('pos.walletTaken')} ·{' '}
            {t('pos.walletLeft', {
              amount: fmt.money((customer?.walletBalanceCents ?? 0) - (tender.walletCents ?? 0)),
            })}
          </span>
          <strong className="num">{fmt.money(tender.walletCents ?? 0)}</strong>
        </div>
      )}
      {tender.covered && mode !== 'endpay' && (mode !== 'credit' || tender.creditCents === 0) && (
        <div className="pos__change" data-testid={`${testId}-change`}>
          <span>{t('pos.change')}</span>
          <strong className="num">{fmt.money(tender.changeCents)}</strong>
        </div>
      )}
    </div>
  );
}
