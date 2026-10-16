/**
 * "To collect" — end-pay sessions that have ended (or ran out) and whose bill is still open.
 *
 * The strip sits above the station grid and on the home page: one chip per open bill
 * (PC · customer · amount · time) with a one-click "Collect" that opens the same tender panel as
 * the POS and the session end dialog. Collecting is exactly-once on the server
 * (`POST /sessions/:id/collect`, 409 when already paid); the receipt "done" dialog follows.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Hourglass, Wallet } from 'lucide-react';
import { useState } from 'react';
import {
  PERMISSIONS,
  parseMoneyInput,
  type CollectStationResponse,
  type SessionMutationResponse,
  type SessionSummary,
} from '@likapcs/shared';
import { useI18n } from '../../i18n';
import { api, ApiError } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { formatHms } from '../../lib/session-time';
import { useEnterSubmits } from '../../lib/enter-submit';
import { useAuth } from '../../state/auth';
import { useShiftGuard } from '../../state/shift-guard';
import {
  allPcsBills,
  awaitingAmountCents,
  multiBillPcs,
  pcGroups,
  payAllTotalCents,
  type PcBills,
} from '../../lib/pay-all';
import { useToast } from '../../state/toast';
import { TenderPanel, useTender } from '../payments/TenderPanel';
import { Button, Dialog, Field, Input, Kbd } from '../ui/primitives';
import { paidFrom, useSessionCustomer } from './SessionPanel';
import { SessionPaidDialog, type SessionPaid } from './SessionPaidDialog';

export const AWAITING_PAYMENT_KEY = ['sessions', 'awaiting-payment'] as const;

/** Amount still owed for an ended end-pay session: the fixed time price plus orders on the bill. */

export function useAwaitingPayment(enabled = true) {
  return useQuery({
    queryKey: AWAITING_PAYMENT_KEY,
    queryFn: () =>
      api<{ items: SessionSummary[]; total: number }>('/sessions', {
        query: { awaitingPayment: 'true', pageSize: 50 },
      }),
    enabled,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
}

export function AwaitingPaymentStrip({ testId = 'awaiting' }: { testId?: string }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const fmt = useFormat();
  const canView = can(PERMISSIONS.STATIONS_VIEW);
  const canCollect = can(PERMISSIONS.STATIONS_CONTROL);
  const list = useAwaitingPayment(canView);
  const [collecting, setCollecting] = useState<SessionSummary | null>(null);
  const [collectingAll, setCollectingAll] = useState<PcBills | null>(null);
  /** Receipts to show, one "done" dialog after another (a pay-all step has one per bill). */
  const [paidQueue, setPaidQueue] = useState<SessionPaid[]>([]);
  const paid = paidQueue[0] ?? null;
  const finishPaid = () => setPaidQueue((q) => q.slice(1));
  const items = list.data?.items ?? [];
  if (!canView || items.length === 0) {
    return paid ? <SessionPaidDialog paid={paid} onFinish={finishPaid} /> : null;
  }
  const total = items.reduce((a, s) => a + awaitingAmountCents(s), 0);
  return (
    <>
      <div
        className="awaiting"
        role="region"
        aria-label={t('sessions.awaiting.title')}
        data-testid={testId}
      >
        <div className="awaiting__head">
          <Hourglass size={16} />
          <strong>{t('sessions.awaiting.title')}</strong>
          <span className="awaiting__count num" data-testid={`${testId}-count`}>
            {items.length}
          </span>
          <span className="muted num">· {fmt.money(total)}</span>
          <span className="awaiting__hint muted">{t('sessions.awaiting.hint')}</span>
          {canCollect && pcGroups(items).length >= 2 && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => setCollectingAll(allPcsBills(items))}
              data-testid={`${testId}-collect-everything`}
            >
              <Wallet size={13} /> {t('sessions.awaiting.collectEverything', { n: items.length })}
            </Button>
          )}
          {canCollect &&
            multiBillPcs(items).map((group) => (
              <Button
                key={group.stationId}
                size="sm"
                onClick={() => setCollectingAll(group)}
                data-testid={`${testId}-collect-all`}
              >
                <Wallet size={13} />{' '}
                {t('sessions.awaiting.collectAll', { code: group.code, n: group.bills.length })}
              </Button>
            ))}
        </div>
        <div className="awaiting__chips">
          {items.map((s) => (
            <div className="awaiting__chip" key={s.id} data-testid={`${testId}-item`}>
              <span className="awaiting__code">{s.stationCode}</span>
              <span className="awaiting__who">{s.customerName ?? t('pos.walkIn')}</span>
              <span className="awaiting__meta muted num">
                {formatHms(s.billableSeconds)}
                {s.endedAt ? ` · ${fmt.time(s.endedAt)}` : ''}
                {s.openOrdersCount > 0
                  ? ` · ${t('sessions.ordersOnBill', { n: s.openOrdersCount })}`
                  : ''}
              </span>
              <strong className="awaiting__amount num">{fmt.money(awaitingAmountCents(s))}</strong>
              {canCollect && (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => setCollecting(s)}
                  data-testid={`${testId}-collect`}
                >
                  <Wallet size={13} /> {t('sessions.collect')}
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>
      {collectingAll && (
        <CollectStationDialog
          group={collectingAll}
          onClose={() => setCollectingAll(null)}
          onPaid={(receipts) => {
            setCollectingAll(null);
            setPaidQueue(receipts);
          }}
        />
      )}
      {collecting && (
        <CollectDialog
          session={collecting}
          onClose={() => setCollecting(null)}
          onPaid={(p) => {
            setCollecting(null);
            setPaidQueue(p ? [p] : []);
          }}
        />
      )}
      {paid && <SessionPaidDialog paid={paid} onFinish={finishPaid} />}
    </>
  );
}

/**
 * 0.21.0 — pay all: the bills of one PC in one tender step (cash, card or split; no pay-later,
 * which needs one customer). The server settles every bill in one transaction, each with its own
 * receipt, or refuses the whole step. 0.19.5: `group.stationId` null means every PC at once.
 */
export function CollectStationDialog({
  group,
  onClose,
  onPaid,
}: {
  group: PcBills;
  onClose: () => void;
  onPaid: (receipts: SessionPaid[]) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const shiftGuard = useShiftGuard();
  const queryClient = useQueryClient();
  const total = payAllTotalCents(group.bills);
  const tender = useTender({ totalCents: total, customer: null, allowCredit: false });
  const everyPc = group.stationId === null;
  const collectAll = useMutation({
    mutationFn: () =>
      api<CollectStationResponse>(
        everyPc ? '/sessions/collect-all' : `/stations/${group.stationId}/collect-all`,
        { method: 'POST', body: { paymentMethod: 'cash', payments: tender.payments } },
      ),
    onSuccess: (result) => {
      toast.success(
        everyPc
          ? t('sessions.awaiting.collectedEverything', {
              n: result.collected.length,
              total: fmt.money(result.totalCents),
            })
          : t('sessions.awaiting.collectedAll', {
              code: group.code,
              n: result.collected.length,
              total: fmt.money(result.totalCents),
            }),
      );
      for (const key of [['sessions'], ['stations'], ['cash'], ['dashboard'], ['orders']])
        void queryClient.invalidateQueries({ queryKey: key });
      onPaid(
        result.collected.flatMap((c) =>
          c.payment ? [{ sessionId: c.sessionId, payment: c.payment }] : [],
        ),
      );
    },
    onError: (err) => {
      if (shiftGuard.handle(err, () => collectAll.mutate())) return;
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
      void queryClient.invalidateQueries({ queryKey: AWAITING_PAYMENT_KEY });
    },
  });
  const ready = tender.covered && !collectAll.isPending;
  const submit = () => {
    if (ready) collectAll.mutate();
  };
  useEnterSubmits(submit);

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        everyPc
          ? t('sessions.awaiting.collectEverythingTitle')
          : t('sessions.awaiting.collectAllTitle', { code: group.code })
      }
      description={
        everyPc
          ? t('sessions.awaiting.collectEverythingBody')
          : t('sessions.awaiting.collectAllBody')
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
            loading={collectAll.isPending}
            disabled={!ready}
            onClick={submit}
            data-testid="collect-all-confirm"
          >
            <Wallet size={14} /> {t('sessions.collectAmount', { amount: fmt.money(total) })}{' '}
            <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="quote" data-testid="collect-all-bills">
          {group.bills.map((s) => (
            <div className="quote__row" key={s.id}>
              <span className="muted">
                {everyPc ? `${s.stationCode} · ` : ''}
                {s.customerName ?? t('pos.walkIn')} · {formatHms(s.billableSeconds)}
              </span>
              <span className="num">{fmt.money(awaitingAmountCents(s))}</span>
            </div>
          ))}
          <div className="quote__row">
            <strong>{t('sessions.awaiting.total')}</strong>
            <strong className="num" data-testid="collect-all-total">
              {fmt.money(total)}
            </strong>
          </div>
        </div>
        <TenderPanel tender={tender} onSubmit={submit} testId="collect-all" />
      </div>
    </Dialog>
  );
}

export function CollectDialog({
  session,
  onClose,
  onPaid,
}: {
  session: SessionSummary;
  onClose: () => void;
  onPaid: (paid: SessionPaid | null) => void;
}) {
  const { t } = useI18n();
  const { can } = useAuth();
  const fmt = useFormat();
  const toast = useToast();
  const shiftGuard = useShiftGuard();
  const queryClient = useQueryClient();
  // Fixed when the session ended: used time capped at the reservation, or the full reservation.
  const due = session.finalPriceCents ?? session.currentPriceCents;
  const reserved = session.quotedPriceCents ?? due;
  const ordersCents = session.openOrdersCents;
  const [discount, setDiscount] = useState('');
  const discountCents = discount.trim() ? parseMoneyInput(discount) : 0;
  const discountInvalid = discountCents === null || discountCents < 0 || discountCents > due;
  const timeCents = Math.max(0, due - (discountCents ?? 0));
  const total = timeCents + ordersCents;
  const canDiscount = can(PERMISSIONS.POS_DISCOUNT);
  const { customer, pickedId, setCustomer } = useSessionCustomer(session);
  const tender = useTender({ totalCents: total, customer });
  const collect = useMutation({
    mutationFn: () =>
      api<SessionMutationResponse>(`/sessions/${session.id}/collect`, {
        method: 'POST',
        body: {
          discountCents: discountCents ?? 0,
          payments: tender.payments,
          customerId: pickedId,
        },
      }),
    onSuccess: (result) => {
      toast.success(
        t('sessions.collected', {
          code: session.stationCode,
          total: fmt.money(result.payment?.totalCents ?? total),
        }),
      );
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      onPaid(paidFrom(result));
    },
    onError: (err) => {
      if (shiftGuard.handle(err, () => collect.mutate())) return;
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
      // Someone else may have collected it meanwhile: refresh the strip so the chip disappears.
      void queryClient.invalidateQueries({ queryKey: AWAITING_PAYMENT_KEY });
    },
  });
  const ready = !discountInvalid && tender.covered && !collect.isPending;
  const submit = () => {
    if (ready) collect.mutate();
  };
  useEnterSubmits(submit);

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('sessions.collectTitle', { code: session.stationCode })}
      description={t('sessions.collectBody')}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button
            variant="primary"
            size="lg"
            loading={collect.isPending}
            disabled={!ready}
            onClick={submit}
            data-testid="collect-confirm"
          >
            {tender.mode === 'credit' && tender.creditCents > 0 ? (
              <>
                <CalendarClock size={14} /> {t('pos.completeOnTab')}
              </>
            ) : (
              <>
                <Wallet size={14} /> {t('sessions.collectAmount', { amount: fmt.money(total) })}
              </>
            )}{' '}
            <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="quote">
          <div className="quote__row">
            <span className="muted">{t('pos.customer')}</span>
            <span>{customer?.name ?? session.customerName ?? t('pos.walkIn')}</span>
          </div>
          <div className="quote__row">
            <span className="muted">{t('sessions.billable')}</span>
            <span className="num">
              {formatHms(session.billableSeconds)}
              {session.endedAt && (
                <span className="faint">
                  {' '}
                  · {t('sessions.endedAt', { time: fmt.time(session.endedAt) })}
                </span>
              )}
            </span>
          </div>
          {due < reserved && (
            <div className="quote__row" data-testid="collect-reserved">
              <span className="muted">{t('sessions.reserved')}</span>
              <span className="num">
                <s className="faint">{fmt.money(reserved)}</s>
              </span>
            </div>
          )}
          <div className="quote__row">
            <span className="muted">{t('sessions.timePrice')}</span>
            <span className="num" data-testid="collect-time">
              {fmt.money(timeCents)}
            </span>
          </div>
          {ordersCents > 0 && (
            <div className="quote__row" data-testid="collect-orders">
              <span className="muted">
                {t('sessions.ordersOnBill', { n: session.openOrdersCount })}
              </span>
              <span className="num">{fmt.money(ordersCents)}</span>
            </div>
          )}
          <div className="quote__row quote__row--total">
            <span>{t('sessions.totalDue')}</span>
            <strong className="num" data-testid="collect-total">
              {fmt.money(total)}
            </strong>
          </div>
        </div>
        {canDiscount && (
          <div className="row row--wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
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
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  data-testid="collect-discount"
                />
              )}
            </Field>
            {due > 0 && (
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={discountCents === due}
                title={t('sessions.waiveHint')}
                onClick={() => setDiscount(discountCents === due ? '' : (due / 100).toFixed(2))}
                data-testid="collect-waive"
              >
                {t('sessions.waive')}
              </Button>
            )}
          </div>
        )}
        <TenderPanel
          tender={tender}
          onSubmit={submit}
          onCustomerChange={setCustomer}
          testId="collect"
        />
      </div>
    </Dialog>
  );
}
