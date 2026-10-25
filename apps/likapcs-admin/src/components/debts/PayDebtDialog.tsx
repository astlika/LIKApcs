/**
 * Pay a debt — the cash-drawer dialog shared by Debts and Customers (`pos.sell`).
 *
 * `debt` given: that one debt (`POST /debts/:id/pay`). No `debt`: everything the customer owes —
 * `POST /customers/:id/debts/pay`, the server settles the oldest debts first. The amount is
 * pre-filled (the whole remainder), so one click + Enter collects it all; any part can be typed.
 * Cash takes the amount handed over for the change; the customer's prepaid balance is offered
 * when there is one.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  parseMoneyInput,
  type CustomerSummary,
  type DebtDetail,
  type DebtPaymentRequest,
  type DebtPaymentResult,
  type DebtSummary,
  type Paginated,
} from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { usePaymentMethods } from '../../lib/payment-methods';
import { suggestTenders } from '../../lib/tender';
import { useI18n } from '../../i18n';
import { useAppSettings } from '../../state/app-settings';
import { useShiftGuard } from '../../state/shift-guard';
import { useToast } from '../../state/toast';
import { Alert, Button, Dialog, Field, Input, Kbd, Select } from '../ui/primitives';

export function PayDebtDialog({
  customer,
  debt,
  onClose,
}: {
  /** Whose debt (name for the title, id for the customer-level payment). */
  customer: { id: string; name: string };
  /** One debt — or, when omitted, everything the customer owes (oldest first). */
  debt?: DebtSummary;
  onClose: () => void;
}) {
  const all = !debt;
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const shiftGuard = useShiftGuard();
  const queryClient = useQueryClient();
  const { methods: cashMethods } = usePaymentMethods();
  const walletOn = useAppSettings()['wallet.enabled'];
  const outstanding = useQuery({
    queryKey: ['debts', 'customer-open', customer.id],
    queryFn: () =>
      api<Paginated<DebtSummary>>('/debts', {
        query: { filter: 'open', customerId: customer.id, page: 1, pageSize: 200 },
      }),
    enabled: all,
    // The pre-filled amount must be what is owed right now, not a cached figure.
    staleTime: 0,
  });
  // The customer's prepaid balance (0.11.0) can settle the debt — offered when there is one.
  const customerQuery = useQuery({
    queryKey: ['customers', 'detail', customer.id],
    queryFn: () => api<CustomerSummary>(`/customers/${customer.id}`),
    enabled: walletOn,
  });
  const walletCents = walletOn ? (customerQuery.data?.walletBalanceCents ?? 0) : 0;
  const methods: DebtPaymentRequest['method'][] =
    walletCents > 0 ? [...cashMethods, 'wallet'] : cashMethods;
  // 0.19.8: a debt with installments can be paid part by part.
  const plan = useQuery({
    queryKey: ['debts', 'detail', debt?.id],
    queryFn: () => api<DebtDetail>(`/debts/${debt!.id}`),
    enabled: !!debt && !!debt.installmentCount,
    staleTime: 0,
  });
  const parts = plan.data?.installments ?? [];
  const [partSeq, setPartSeq] = useState<number | null>(null);
  const selectedPart = partSeq === null ? undefined : parts.find((p) => p.seq === partSeq);
  const maxCents = selectedPart
    ? selectedPart.remainingCents
    : debt
      ? debt.remainingCents
      : (outstanding.data?.items.reduce((a, d) => a + d.remainingCents, 0) ?? 0);
  const [amountText, setAmountText] = useState(debt ? (debt.remainingCents / 100).toFixed(2) : '');
  const [method, setMethod] = useState<DebtPaymentRequest['method']>('cash');
  const [tenderedText, setTenderedText] = useState('');
  const [reference, setReference] = useState('');
  const [result, setResult] = useState<DebtPaymentResult | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const tenderedRef = useRef<HTMLInputElement>(null);

  // "Pay everything" pre-fills the whole balance once it is known.
  useEffect(() => {
    if (all && outstanding.data) setAmountText((maxCents / 100).toFixed(2));
  }, [all, outstanding.data, maxCents]);

  const amountCents = amountText.trim() ? parseMoneyInput(amountText) : 0;
  const tenderedCents = tenderedText.trim() ? parseMoneyInput(tenderedText) : null;
  const walletShort = method === 'wallet' && amountCents !== null && amountCents > walletCents;
  const amountOk =
    amountCents !== null && amountCents > 0 && amountCents <= maxCents && !walletShort;
  const tenderedOk =
    method !== 'cash' ||
    tenderedCents === null ||
    (amountCents !== null && tenderedCents >= amountCents);
  const change =
    method === 'cash' &&
    tenderedCents !== null &&
    amountCents !== null &&
    tenderedCents >= amountCents
      ? tenderedCents - amountCents
      : 0;

  const pay = useMutation({
    mutationFn: () =>
      api<DebtPaymentResult>(
        debt ? `/debts/${debt.id}/pay` : `/customers/${customer.id}/debts/pay`,
        {
          method: 'POST',
          body: {
            amountCents,
            method,
            tenderedCents: method === 'cash' && tenderedCents !== null ? tenderedCents : undefined,
            reference: reference.trim() || undefined,
            ...(partSeq !== null ? { installmentSeq: partSeq } : {}),
          },
        },
      ),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['debts'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      setResult(r);
    },
    onError: (err) => {
      if (shiftGuard.handle(err, () => pay.mutate())) return;
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    },
  });
  const submit = () => {
    if (amountOk && tenderedOk && !pay.isPending && !result) pay.mutate();
  };

  // Enter anywhere in the dialog pays; on the result screen it closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target && target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      if (result) onClose();
      else submit();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  if (result) {
    const settled = result.debts.filter((d) => d.status === 'paid').length;
    return (
      <Dialog
        open
        onClose={onClose}
        title={t('debts.paidTitle')}
        size="sm"
        footer={
          <Button
            variant="primary"
            size="lg"
            onClick={onClose}
            data-testid="debt-paid-done"
            autoFocus
          >
            {t('pos.done')} <Kbd>Enter</Kbd>
          </Button>
        }
      >
        <div className="pos-done">
          <div className="pos-done__row">
            <span>{t('debts.paid')}</span>
            <span className="num">{fmt.money(result.paidCents)}</span>
          </div>
          <div className="pos-done__row">
            <span>{t('debts.stillOwes', { name: result.customer.name })}</span>
            <span className="num" data-testid="debt-paid-balance">
              {fmt.money(result.customer.balanceDueCents)}
            </span>
          </div>
          {settled > 0 && (
            <div className="pos-done__row">
              <span>{t('debts.settledCount', { n: settled })}</span>
              <span />
            </div>
          )}
          <div className="pos-done__change" data-testid="debt-paid-change">
            <span>{t('pos.change')}</span>
            <strong className="num">{fmt.money(result.changeCents)}</strong>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={all ? t('debts.payAllTitle', { name: customer.name }) : t('debts.payTitle')}
      description={
        debt
          ? `${customer.name}${debt.receiptNo ? ` · ${debt.receiptNo}` : ''} · ${t('debts.due')} ${fmt.date(debt.dueDate)}`
          : t('debts.payAllHint')
      }
      size="md"
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={!amountOk || !tenderedOk}
            loading={pay.isPending}
            onClick={submit}
            data-testid="debt-pay-confirm"
          >
            {t('debts.confirmPay')} <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="pos__grand" style={{ fontSize: 24 }}>
          <span>{t('debts.remaining')}</span>
          <span className="num">{fmt.money(maxCents)}</span>
        </div>
        {parts.length > 0 && (
          <Field label={t('debts.partPay')}>
            {(id) => (
              <Select
                id={id}
                value={partSeq === null ? '' : String(partSeq)}
                onChange={(e) => {
                  const seq = e.target.value ? Number(e.target.value) : null;
                  setPartSeq(seq);
                  const part = seq === null ? undefined : parts.find((p) => p.seq === seq);
                  // A chosen part is paid in full by default; "oldest first" keeps the whole balance.
                  setAmountText(
                    ((part ? part.remainingCents : (debt?.remainingCents ?? 0)) / 100).toFixed(2),
                  );
                }}
                data-testid="debt-part"
              >
                <option value="">{t('debts.partAuto')}</option>
                {parts
                  .filter((p) => p.status !== 'paid')
                  .map((p) => (
                    <option key={p.seq} value={p.seq}>
                      {t('debts.partOption', {
                        label: t('debts.partN', { n: p.seq }),
                        amount: fmt.money(p.remainingCents),
                        date: fmt.date(p.dueDate),
                      })}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        )}
        <div className="grid grid--2">
          <Field
            label={t('debts.amountToPay')}
            error={amountCents !== null && amountCents > maxCents ? t('debts.overpay') : undefined}
          >
            {(id) => (
              <Input
                id={id}
                ref={amountRef}
                inputMode="decimal"
                className="num"
                style={{ fontSize: 20, height: 44 }}
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                aria-invalid={!amountOk}
                autoFocus
                data-testid="debt-amount"
              />
            )}
          </Field>
          {methods.length > 1 ? (
            <Field label={t('debts.method')}>
              {(id) => (
                <Select
                  id={id}
                  value={method}
                  onChange={(e) => setMethod(e.target.value as DebtPaymentRequest['method'])}
                  data-testid="debt-method"
                >
                  {methods.map((m) => (
                    <option key={m} value={m}>
                      {m === 'wallet'
                        ? `${t('pos.wallet')} · ${fmt.money(walletCents)}`
                        : t(`sessions.methods.${m}` as 'sessions.methods.cash')}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : (
            <Field label={t('debts.method')}>
              {(id) => <Input id={id} value={t('pos.cash')} readOnly />}
            </Field>
          )}
        </div>
        <div className="chips">
          <button
            type="button"
            className="chip"
            onClick={() => setAmountText((maxCents / 100).toFixed(2))}
          >
            {t('debts.payFull')}
          </button>
          {[0.5, 0.25].map((f) => {
            const c = Math.floor((maxCents * f) / 10) * 10;
            return c > 0 && c < maxCents ? (
              <button
                key={f}
                type="button"
                className="chip"
                onClick={() => setAmountText((c / 100).toFixed(2))}
              >
                {f === 0.5 ? '½' : '¼'} · {fmt.money(c)}
              </button>
            ) : null;
          })}
        </div>
        {method === 'cash' && (
          <>
            <div className="chips">
              {suggestTenders(amountCents ?? 0).map((c) => (
                <button
                  key={c}
                  type="button"
                  className="chip chip--tender"
                  onClick={() => {
                    setTenderedText((c / 100).toFixed(2));
                    tenderedRef.current?.focus();
                  }}
                >
                  {fmt.money(c)}
                </button>
              ))}
            </div>
            <Field label={t('pos.tendered')} optional hint={t('debts.tenderedHint')}>
              {(id) => (
                <Input
                  id={id}
                  ref={tenderedRef}
                  inputMode="decimal"
                  className="num"
                  value={tenderedText}
                  onChange={(e) => setTenderedText(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-invalid={!tenderedOk}
                  data-testid="debt-tendered"
                />
              )}
            </Field>
          </>
        )}
        {method === 'wallet' && (
          <div className="pos__change pos__change--wallet" data-testid="debt-wallet">
            <span>{t('pos.walletTaken')}</span>
            <strong className="num">
              {fmt.money(Math.min(amountCents ?? 0, walletCents))} ·{' '}
              {t('pos.walletLeft', {
                amount: fmt.money(Math.max(0, walletCents - (amountCents ?? 0))),
              })}
            </strong>
          </div>
        )}
        {walletShort && <Alert tone="danger">{t('pos.walletOver')}</Alert>}
        {method !== 'cash' && method !== 'wallet' && (
          <Field label={t('pos.reference')} optional>
            {(id) => (
              <Input
                id={id}
                value={reference}
                maxLength={80}
                onChange={(e) => setReference(e.target.value)}
              />
            )}
          </Field>
        )}
        {!tenderedOk && <Alert tone="danger">{t('debts.tenderedShort')}</Alert>}
        {amountOk && method === 'cash' && tenderedCents !== null && tenderedOk && (
          <div className="pos__change" data-testid="debt-change">
            <span>{t('pos.change')}</span>
            <strong className="num">{fmt.money(change)}</strong>
          </div>
        )}
      </div>
    </Dialog>
  );
}
