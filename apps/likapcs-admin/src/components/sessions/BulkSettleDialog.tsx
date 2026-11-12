/**
 * 0.19.0 — ONE payment step for many PCs.
 *
 *  · "End (N)" on the map: stop every selected PC and take all their bills at once.
 *  · "Collect all" in the "To collect" strip: take every bill that waits at the desk at once.
 *
 * The server works out every bill (the preview below is its answer, not a local estimate), the
 * cashier takes one amount, and the server splits it across the bills in a single transaction:
 * every PC goes through, or nothing changes and no money is recorded. The clock stands still
 * from the moment the amounts are shown (`quotedAt`), and the total the cashier saw travels with
 * the request — if the server's own total differs, the dialog shows the new amounts instead of
 * charging something else.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Hourglass, Square, Wallet } from 'lucide-react';
import type {
  BulkBill,
  BulkSettleResult,
  CustomerSummary,
  SalePaymentInput,
  SessionSummary,
  StationSummary,
} from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { useEnterSubmits } from '../../lib/enter-submit';
import { useFormat } from '../../lib/format';
import { billingModeKey } from '../../lib/session-time';
import { useI18n, type TranslationKey } from '../../i18n';
import { useShiftGuard } from '../../state/shift-guard';
import { useToast } from '../../state/toast';
import { TenderPanel, useTender } from '../payments/TenderPanel';
import { Alert, Button, Dialog, Kbd, Loading } from '../ui/primitives';

export type BulkSettleTarget =
  { kind: 'end'; stations: StationSummary[] } | { kind: 'collect'; sessions: SessionSummary[] };

export interface BulkSettleDone {
  result: BulkSettleResult;
  /** Cash handed over above the bills — what goes back to the customer. */
  changeCents: number;
  /** "Stop without collecting" was chosen. */
  later: boolean;
}

/** Machine-readable reason the server attaches to a refused batch. */
export function batchErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError) || !err.details || typeof err.details !== 'object') return null;
  const code = (err.details as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** What to tell the cashier when the server refused a batch — nothing was changed or charged. */
export function batchErrorText(
  err: unknown,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  const code = batchErrorCode(err);
  if (code === 'BILLS_CHANGED') return t('map.bulkBillsChanged');
  if (code === 'BATCH_BUSY') return t('map.bulkBusy');
  if (code === 'PAYMENT') return t('map.bulkTenderShort');
  // Anything else names the PC and the reason as the server gave them.
  return `${t('map.bulkRefused')} ${err instanceof ApiError ? err.message : t('common.errorGeneric')}`;
}

export function BulkSettleDialog({
  target,
  onClose,
  onDone,
}: {
  target: BulkSettleTarget;
  onClose: () => void;
  onDone: (done: BulkSettleDone) => void;
}) {
  const { t } = useI18n();
  const ending = target.kind === 'end';
  const path = ending ? '/sessions/bulk-end' : '/sessions/bulk-collect';
  const ids = ending ? target.stations.map((s) => s.id) : target.sessions.map((s) => s.id);
  const body = ending ? { stationIds: ids } : { sessionIds: ids };
  // Asked once when the dialog opens: the clock stops here, like the single "End" dialog.
  const preview = useQuery({
    queryKey: ['sessions', 'bulk-preview', target.kind, ids],
    queryFn: () =>
      api<BulkSettleResult>(path, { method: 'POST', body: { ...body, preview: true } }),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const title = ending
    ? t('map.bulkEndTitle', { n: preview.data?.done.length ?? ids.length })
    : t('map.bulkCollectTitle', { n: preview.data?.done.length ?? ids.length });

  if (!preview.data || preview.isFetching) {
    return (
      <Dialog open onClose={onClose} title={title} size="md">
        {preview.isError ? (
          <Alert tone="danger">
            {preview.error instanceof ApiError ? preview.error.message : t('common.errorGeneric')}
          </Alert>
        ) : (
          <Loading />
        )}
      </Dialog>
    );
  }
  return (
    <BulkSettleBody
      // A refreshed preview is a new set of bills: start the tender step over.
      key={preview.data.quotedAt}
      title={title}
      ending={ending}
      path={path}
      body={body}
      preview={preview.data}
      onRefresh={() => void preview.refetch()}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

function BulkSettleBody({
  title,
  ending,
  path,
  body,
  preview,
  onRefresh,
  onClose,
  onDone,
}: {
  title: string;
  ending: boolean;
  path: string;
  body: Record<string, unknown>;
  preview: BulkSettleResult;
  onRefresh: () => void;
  onClose: () => void;
  onDone: (done: BulkSettleDone) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const shiftGuard = useShiftGuard();
  const queryClient = useQueryClient();
  const bills = preview.done;
  const total = preview.totalCents;
  // Pay-at-the-end bills may be left for "To collect"; everything else is paid on the spot.
  const laterCents = bills
    .filter((b) => b.billingMode === 'endpay')
    .reduce((a, b) => a + b.dueCents, 0);
  const mustPayNow = bills.filter((b) => b.dueCents > 0 && b.billingMode !== 'endpay');

  // One customer behind every bill that owes money → their tab / balance is one click away.
  const owing = bills.filter((b) => b.dueCents > 0);
  const sharedCustomerId =
    owing.length > 0 && owing.every((b) => b.customerId && b.customerId === owing[0]!.customerId)
      ? owing[0]!.customerId
      : null;
  const attached = useQuery({
    queryKey: ['customers', sharedCustomerId],
    queryFn: () => api<CustomerSummary>(`/customers/${sharedCustomerId}`),
    enabled: sharedCustomerId !== null,
    staleTime: 15_000,
  });
  const [picked, setPicked] = useState<CustomerSummary | null>(null);
  const customer = picked ?? attached.data ?? null;
  const tender = useTender({ totalCents: total, customer });

  const settle = useMutation({
    mutationFn: ({ later }: { later: boolean }) => {
      const payments: SalePaymentInput[] = later || total === 0 ? [] : tender.payments;
      const onAccount = payments.some((p) => p.method === 'credit' || p.method === 'wallet');
      return api<BulkSettleResult>(path, {
        method: 'POST',
        body: {
          ...body,
          ...(ending
            ? {
                // Exactly the sessions shown, billed as of the moment they were shown.
                sessionIds: bills.map((b) => b.sessionId),
                quotedAt: preview.quotedAt,
                settle: later ? 'later' : 'pay',
              }
            : {}),
          expectedTotalCents: total,
          payments,
          customerId: onAccount ? customer?.id : undefined,
        },
      });
    },
    onSuccess: (result, { later }) => {
      for (const key of ['sessions', 'stations', 'cash', 'dashboard', 'orders', 'customers'])
        void queryClient.invalidateQueries({ queryKey: [key] });
      onDone({ result, later, changeCents: later || total === 0 ? 0 : tender.changeCents });
    },
    onError: (err, vars) => {
      if (shiftGuard.handle(err, () => settle.mutate(vars))) return;
      const code = batchErrorCode(err);
      if (code === 'BILLS_CHANGED' || code === 'BATCH_BUSY') {
        // Nothing was charged. Show the bills as they stand now and let the cashier look again.
        toast.toast('warning', batchErrorText(err, t));
        onRefresh();
        return;
      }
      toast.error(batchErrorText(err, t));
    },
  });
  const ready = bills.length > 0 && (total === 0 || tender.covered) && !settle.isPending;
  const submit = () => {
    if (ready) settle.mutate({ later: false });
  };
  useEnterSubmits(submit);
  const onTab = total > 0 && tender.mode === 'credit' && tender.creditCents > 0;

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={ending ? t('map.bulkEndBody') : t('map.bulkCollectBody')}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          {ending && laterCents > 0 && (
            <Button
              variant="ghost"
              size="lg"
              disabled={settle.isPending}
              title={t('map.bulkEndLaterHint')}
              onClick={() => settle.mutate({ later: true })}
              data-testid="bulk-settle-later"
            >
              <Hourglass size={14} /> {t('sessions.collectLater')}
            </Button>
          )}
          <Button
            variant="primary"
            size="lg"
            loading={settle.isPending}
            disabled={!ready}
            onClick={submit}
            data-testid="bulk-settle-confirm"
          >
            {ending ? <Square size={14} /> : <Wallet size={14} />}{' '}
            {onTab
              ? t('pos.completeOnTab')
              : ending
                ? total > 0
                  ? t('map.bulkEndPay', { total: fmt.money(total) })
                  : t('map.bulkEndConfirm', { n: bills.length })
                : t('sessions.collectAmount', { amount: fmt.money(total) })}{' '}
            <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
        {bills.length === 0 ? (
          <Alert tone="info">{ending ? t('map.bulkEndNone') : t('map.bulkCollectNone')}</Alert>
        ) : (
          <>
            {/* The bills that owe money, one per row; the rest in one quiet line. */}
            <div data-testid="bulk-settle-bills" className="stack" style={{ gap: 8 }}>
              {owing.length > 0 && (
                <ul className="bulk-bills bulk-bills--rows">
                  {owing.map((b) => (
                    <BillRow key={b.sessionId} bill={b} />
                  ))}
                </ul>
              )}
              {owing.length < bills.length && (
                <p
                  className="muted"
                  style={{ fontSize: 12.5, margin: 0 }}
                  data-testid="bulk-settle-free"
                >
                  {t('map.bulkNothingDue', {
                    codes: bills
                      .filter((b) => b.dueCents === 0)
                      .map((b) => b.code)
                      .join(', '),
                  })}
                </p>
              )}
            </div>
            {total === 0 && (
              <div className="quote">
                <div className="quote__row quote__row--total">
                  <span>{t('sessions.totalDue')}</span>
                  <strong className="num" data-testid="bulk-settle-total">
                    {fmt.money(total)}
                  </strong>
                </div>
              </div>
            )}
            {ending && laterCents > 0 && mustPayNow.length > 0 && (
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                {t('map.bulkEndLaterKeeps', { codes: mustPayNow.map((b) => b.code).join(', ') })}
              </p>
            )}
            {total > 0 && (
              <TenderPanel
                tender={tender}
                onSubmit={submit}
                onCustomerChange={setPicked}
                testId="bulk-settle"
              />
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

function BillRow({ bill }: { bill: BulkBill }) {
  const { t } = useI18n();
  const fmt = useFormat();
  return (
    <li data-testid="bulk-settle-bill">
      <span className="bulk-bills__code">{bill.code}</span>
      <span className="bulk-bills__who">
        {bill.customerName ?? t('pos.walkIn')} ·{' '}
        <span className="faint">{t(billingModeKey(bill.billingMode))}</span>
      </span>
      <strong className="num">{fmt.money(bill.dueCents)}</strong>
    </li>
  );
}

/**
 * After a batch that took cash above the bills: what goes back to the customer, large and until
 * dismissed — a toast is too easy to miss for money.
 */
export function BatchChangeDialog({
  title,
  totalCents,
  changeCents,
  onFinish,
}: {
  title: string;
  totalCents: number;
  changeCents: number;
  onFinish: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  useEnterSubmits(onFinish);
  return (
    <Dialog
      open
      onClose={onFinish}
      title={title}
      size="sm"
      footer={
        <Button variant="primary" size="lg" onClick={onFinish} data-testid="batch-change-finish">
          {t('pos.done')} <Kbd>Enter</Kbd>
        </Button>
      }
    >
      <div className="quote">
        <div className="quote__row">
          <span className="muted">{t('map.batchPaid')}</span>
          <span className="num">{fmt.money(totalCents)}</span>
        </div>
        <div className="quote__row quote__row--total">
          <span>{t('pos.change')}</span>
          <strong className="num batch-change" data-testid="batch-change">
            {fmt.money(changeCents)}
          </strong>
        </div>
      </div>
    </Dialog>
  );
}
