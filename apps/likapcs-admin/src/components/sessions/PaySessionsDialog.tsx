/**
 * 0.36.0 — "Paguaj": one receipt for one or several PCs, at any time.
 *
 * The server says what each PC owes right now (`POST /sessions/pay/quote`): time that is not paid
 * yet and the products on its bill. The desk takes one tender for the total — cash, card, split,
 * or pay later on one name — and gets ONE receipt (`POST /sessions/pay`). Sessions that run keep
 * running; only open time is stopped, and even that can be switched off.
 *
 * The quote's `asOf` goes back with the payment, so the amount on the screen is the amount billed
 * however long the money is counted.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Square, Wallet } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  PERMISSIONS,
  parseMoneyInput,
  type CustomerSummary,
  type PaySessionsQuote,
  type PaySessionsResponse,
} from '@likapcs/shared';
import { useI18n } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { useEnterSubmits } from '../../lib/enter-submit';
import { useFormat } from '../../lib/format';
import { useAuth } from '../../state/auth';
import { useShiftGuard } from '../../state/shift-guard';
import { useToast } from '../../state/toast';
import { TenderPanel, useTender } from '../payments/TenderPanel';
import { Alert, Button, Dialog, Field, Input, Kbd, Loading, Switch } from '../ui/primitives';
import type { SessionPaid } from './SessionPaidDialog';

/** 2000 → "2", 1500 → "1.5": a quantity in thousandths, without trailing zeros. */
export function quantityText(quantityMilli: number): string {
  return String(Math.round(quantityMilli) / 1000);
}

/** Queries that show money or bills: all of them are stale after a payment. */
const AFTER_PAYMENT = [
  ['sessions'],
  ['stations'],
  ['cash'],
  ['dashboard'],
  ['orders'],
  ['customers'],
  ['debts'],
  ['sales'],
] as const;

export function PaySessionsDialog({
  sessionIds,
  onClose,
  onPaid,
}: {
  sessionIds: string[];
  onClose: () => void;
  /** The receipt to show (the same "done" dialog as every other session payment). */
  onPaid: (paid: SessionPaid) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const { can } = useAuth();
  const shiftGuard = useShiftGuard();
  const queryClient = useQueryClient();
  const [stopOpen, setStopOpen] = useState(true);
  const [requestId] = useState(() => crypto.randomUUID());
  const ids = useMemo(() => [...new Set(sessionIds)].sort(), [sessionIds]);

  const quote = useQuery({
    queryKey: ['sessions', 'pay-quote', ids, stopOpen],
    queryFn: () =>
      api<PaySessionsQuote>('/sessions/pay/quote', {
        method: 'POST',
        body: { sessionIds: ids, stopOpen },
      }),
    // The clock is frozen while the money is counted; the server accepts a quote for ten
    // minutes, so a window left open is priced again well before that.
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchInterval: 5 * 60_000,
  });
  const bills = useMemo(() => quote.data?.bills ?? [], [quote.data]);
  const openTime = bills.some((b) => b.billingMode === 'postpaid' && (b.stopped || b.running));

  // Who pays: the customer all these PCs share is picked by itself; any other is picked here.
  const sharedId = useMemo(() => {
    const own = [...new Set(bills.map((b) => b.customerId))];
    return own.length === 1 ? (own[0] ?? null) : null;
  }, [bills]);
  const shared = useQuery({
    queryKey: ['customers', sharedId],
    queryFn: () => api<CustomerSummary>(`/customers/${sharedId}`),
    enabled: sharedId !== null,
    staleTime: 15_000,
  });
  const [picked, setPicked] = useState<CustomerSummary | null | undefined>(undefined);
  const customer = picked === undefined ? (shared.data ?? null) : picked;

  const canDiscount = can(PERMISSIONS.POS_DISCOUNT);
  const [discount, setDiscount] = useState('');
  const timeCents = quote.data?.timeCents ?? 0;
  const discountCents = discount.trim() ? parseMoneyInput(discount) : 0;
  const discountInvalid = discountCents === null || discountCents < 0 || discountCents > timeCents;
  const total = Math.max(0, (quote.data?.totalCents ?? 0) - (discountInvalid ? 0 : discountCents));
  const tender = useTender({ totalCents: total, customer });

  const pay = useMutation({
    mutationFn: () =>
      api<PaySessionsResponse>('/sessions/pay', {
        method: 'POST',
        body: {
          sessionIds: bills.map((b) => b.sessionId),
          stopOpen,
          customerId: customer?.id ?? null,
          discountCents: discountCents ?? 0,
          payments: tender.payments,
          asOf: quote.data?.asOf,
          clientRequestId: requestId,
        },
      }),
    onSuccess: (result) => {
      for (const key of AFTER_PAYMENT) void queryClient.invalidateQueries({ queryKey: key });
      // Nothing had to be paid (open time inside its free minutes): the PCs were stopped and
      // there is no receipt to show.
      if (!result.payment) {
        toast.success(t('pay.stoppedFree', { n: result.bills.length }));
        onClose();
        return;
      }
      toast.success(t('pay.done', { n: result.bills.length, total: fmt.money(result.totalCents) }));
      const first = result.bills.find((b) => b.timeCents + b.ordersCents > 0) ?? result.bills[0];
      if (first) onPaid({ sessionId: first.sessionId, payment: result.payment });
      else onClose();
    },
    onError: (err) => {
      if (shiftGuard.handle(err, () => pay.mutate())) return;
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
      // What is owed may have changed under the window (another desk, a session that ended).
      void quote.refetch();
    },
  });

  const ready =
    !!quote.data && bills.length > 0 && !quote.isFetching && !discountInvalid && tender.covered;
  const submit = () => {
    if (ready && !pay.isPending) pay.mutate();
  };
  useEnterSubmits(submit);

  // Nothing owed any more (paid elsewhere meanwhile): say so instead of an empty window.
  const nothing = !!quote.data && bills.length === 0;
  useEffect(() => {
    if (quote.isError) toast.error(t('common.errorGeneric'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote.isError]);

  return (
    <Dialog
      open
      onClose={onClose}
      title={bills.length > 1 ? t('pay.titleMany', { n: bills.length }) : t('pay.title')}
      description={t('pay.body')}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button
            variant="primary"
            size="lg"
            loading={pay.isPending}
            disabled={!ready}
            onClick={submit}
            data-testid="pay-sessions-confirm"
          >
            <Wallet size={14} />{' '}
            {tender.mode === 'credit' && tender.creditCents > 0
              ? t('pos.completeOnTab')
              : t('sessions.collectAmount', { amount: fmt.money(total) })}{' '}
            <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack" data-testid="pay-sessions">
        {quote.isLoading && <Loading />}
        {nothing && <Alert tone="info">{t('pay.nothing')}</Alert>}
        {bills.length > 0 && (
          <>
            <ul className="pay-bills" data-testid="pay-sessions-bills">
              {bills.map((b) => (
                <li key={b.sessionId} className="pay-bill" data-testid="pay-sessions-bill">
                  <div className="pay-bill__head">
                    <strong className="pay-bill__code">{b.stationCode}</strong>
                    <span className="pay-bill__who">{b.customerName ?? t('pos.walkIn')}</span>
                    {b.stopped && (
                      <span className="pay-bill__state" data-state="stop">
                        <Square size={11} /> {t('pay.stops')}
                      </span>
                    )}
                    {b.running && (
                      <span className="pay-bill__state" data-state="run">
                        <Play size={11} /> {t('pay.runsOn')}
                      </span>
                    )}
                    <strong className="pay-bill__amount num">
                      {fmt.money(b.timeCents + b.ordersCents)}
                    </strong>
                  </div>
                  <div className="pay-bill__lines">
                    {(b.timeCents > 0 || b.stopped) && (
                      <span>
                        {t('pay.time')} <b className="num">{fmt.money(b.timeCents)}</b>
                      </span>
                    )}
                    {b.items.map((item) => (
                      <span key={item.name}>
                        {quantityText(item.quantityMilli)}× {item.name}{' '}
                        <b className="num">{fmt.money(item.lineTotalCents)}</b>
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            {(quote.data?.skipped.length ?? 0) > 0 && (
              <p className="faint" style={{ fontSize: 12, margin: 0 }} data-testid="pay-skipped">
                {t('pay.skipped', { n: quote.data!.skipped.length })}
              </p>
            )}
            {openTime && (
              <label className="pay-stop" data-testid="pay-stop-open">
                <Switch checked={stopOpen} onChange={setStopOpen} />
                <span>
                  <strong>{t('pay.stopOpen')}</strong>
                  <span className="faint">
                    {stopOpen ? t('pay.stopOpenOn') : t('pay.stopOpenOff')}
                  </span>
                </span>
              </label>
            )}
            {canDiscount && timeCents > 0 && (
              <Field
                label={t('sessions.discount')}
                optional
                error={discount.trim() && discountInvalid ? t('common.invalid') : undefined}
              >
                {(id) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    placeholder="0.00"
                    value={discount}
                    style={{ maxWidth: 160 }}
                    onChange={(e) => setDiscount(e.target.value)}
                    data-testid="pay-sessions-discount"
                  />
                )}
              </Field>
            )}
            <div className="quote">
              <div className="quote__row quote__row--total">
                <span>{t('pay.oneReceipt', { n: bills.length })}</span>
                <strong className="num" data-testid="pay-sessions-total">
                  {fmt.money(total)}
                </strong>
              </div>
            </div>
            <TenderPanel
              tender={tender}
              onSubmit={submit}
              onCustomerChange={setPicked}
              autoFocus={false}
              testId="pay-sessions"
            />
          </>
        )}
      </div>
    </Dialog>
  );
}
