/**
 * Orders from the customer PCs (0.10.0) — the Admin side.
 *
 * A customer in a running session orders drinks / snacks from the seat. The order is pushed to
 * every Admin (`order.changed`), counted in the bell next to the time requests, and decided here:
 *   accept "pay now"   → a real POS sale at the snapshot prices (receipt, drawer, stock);
 *   accept "on the bill" → parked; settled on the session's receipt when it ends (or paid at the
 *                        desk earlier with `pay`, or written off with `void`);
 *   reject             → the PC is told at once, with the reason.
 * Money never moves here except through those sale endpoints — the server is the authority.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, Check, ReceiptText, X } from 'lucide-react';
import type { CustomerSummary, ReceiptData, StationOrder } from '@likapcs/shared';
import { ApiError, api } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { useToast } from '../../state/toast';
import { SaleDoneDialog } from '../pos/SaleDoneDialog';
import { TenderPanel, useTender } from '../payments/TenderPanel';
import { Alert, Badge, Button, Dialog, Field, Input, Kbd, Loading } from '../ui/primitives';

export const PENDING_ORDERS_KEY = ['orders', 'pending'] as const;

/** Pending orders, refreshed by the `order.changed` live event (plus a slow safety poll). */
export function usePendingOrders(enabled = true) {
  return useQuery({
    queryKey: PENDING_ORDERS_KEY,
    queryFn: () => api<{ items: StationOrder[] }>('/orders', { query: { status: 'pending' } }),
    select: (r) => r.items,
    enabled,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
}

/** "2× Coca-Cola, 1× Chips" — compact line of what was ordered. */
export function orderItemsText(order: Pick<StationOrder, 'items'>, max = 3): string {
  const parts = order.items.map((i) => `${i.quantityMilli / 1000}× ${i.name}`);
  return parts.length > max
    ? `${parts.slice(0, max).join(', ')} +${parts.length - max}`
    : parts.join(', ');
}

export const ORDER_TONE: Record<
  StationOrder['status'],
  'success' | 'default' | 'info' | 'warning' | 'danger' | 'accent'
> = {
  pending: 'warning',
  accepted: 'info',
  paid: 'success',
  billed: 'success',
  rejected: 'danger',
  cancelled: 'default',
  void: 'default',
};

export function OrderStatusBadge({ order }: { order: StationOrder }) {
  const { t } = useI18n();
  return (
    <Badge tone={ORDER_TONE[order.status]} dot>
      {t(`orders.status.${order.status}`)}
    </Badge>
  );
}

function invalidateOrders(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ['orders'] });
  void queryClient.invalidateQueries({ queryKey: ['stations'] });
  void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  void queryClient.invalidateQueries({ queryKey: ['products'] });
  void queryClient.invalidateQueries({ queryKey: ['cash'] });
  void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
}

// ─── Accept / pay ──────────────────────────────────────────────────────────────
/**
 * Accepting a pending order (settlement choice + tender when paying now) and paying an order that
 * sits on the bill (`mode="pay"`). After a sale the usual "done" dialog (receipt, Print / Finish)
 * follows, read through `/orders/:id/receipt` so station operators without POS rights get it too.
 */
export function AcceptOrderDialog({
  order,
  mode = 'accept',
  defaultSettlement = 'ask',
  prepaidSession = false,
  onClose,
  onDone,
}: {
  order: StationOrder;
  mode?: 'accept' | 'pay';
  /** `orders.settlement`: pre-selects (and skips the question) unless `ask`. */
  defaultSettlement?: 'ask' | 'pay_now' | 'on_bill';
  prepaidSession?: boolean;
  onClose: () => void;
  onDone?: (order: StationOrder) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [settlement, setSettlement] = useState<'pay_now' | 'on_bill'>(
    mode === 'pay' || defaultSettlement === 'pay_now'
      ? 'pay_now'
      : defaultSettlement === 'on_bill'
        ? 'on_bill'
        : 'pay_now',
  );
  const [customer, setCustomer] = useState<CustomerSummary | null>(null);
  // The session's customer is the paying customer: pre-attach them so their prepaid balance
  // (0.11.0) is offered as a tender. The cashier may still clear or change the pick.
  const touched = useRef(false);
  const linked = useQuery({
    queryKey: ['customers', 'detail', order.customerId],
    queryFn: () => api<CustomerSummary>(`/customers/${order.customerId}`),
    enabled: Boolean(order.customerId),
  });
  useEffect(() => {
    if (linked.data && !touched.current && linked.data.status === 'active')
      setCustomer(linked.data);
  }, [linked.data]);
  const [done, setDone] = useState<StationOrder | null>(null);
  const tender = useTender({ totalCents: order.totalCents, customer });
  const payNow = settlement === 'pay_now';
  const ready = !payNow || tender.covered;

  const act = useMutation({
    mutationFn: () =>
      mode === 'pay'
        ? api<StationOrder>(`/orders/${order.id}/pay`, {
            method: 'POST',
            body: { payments: tender.payments, customerId: customer?.id },
          })
        : api<StationOrder>(`/orders/${order.id}/accept`, {
            method: 'POST',
            body: payNow
              ? { settlement: 'pay_now', payments: tender.payments, customerId: customer?.id }
              : { settlement: 'on_bill' },
          }),
    onSuccess: (result) => {
      invalidateOrders(queryClient);
      if (result.saleId) {
        toast.success(
          t(mode === 'pay' ? 'orders.paid' : 'orders.acceptedPaid', {
            receipt: result.receiptNo ?? '',
          }),
        );
        setDone(result);
      } else {
        toast.success(t('orders.accepted'));
        onDone?.(result);
        onClose();
      }
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
      if (err instanceof ApiError && err.status === 409) {
        invalidateOrders(queryClient);
        onClose();
      }
    },
  });
  const submit = () => {
    if (ready && !act.isPending) act.mutate();
  };

  if (done) {
    return (
      <OrderReceiptDialog
        order={done}
        onFinish={() => {
          onDone?.(done);
          onClose();
        }}
      />
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t(mode === 'pay' ? 'orders.payTitle' : 'orders.acceptTitle', {
        number: order.number,
        station: order.stationCode,
      })}
      description={mode === 'pay' ? t('orders.payHint') : t('orders.acceptHint')}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={!ready}
            loading={act.isPending}
            onClick={submit}
            data-testid="order-accept-confirm"
          >
            <Check size={15} />{' '}
            {mode === 'pay' ? t('orders.pay') : payNow ? t('orders.payNow') : t('orders.onBill')}{' '}
            <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
        <OrderLines order={order} />
        {mode === 'accept' && (
          <div className="order-settlement" role="radiogroup" data-testid="order-settlement">
            <button
              type="button"
              role="radio"
              aria-checked={payNow}
              className={`order-settlement__opt ${payNow ? 'is-on' : ''}`}
              onClick={() => setSettlement('pay_now')}
              data-testid="order-settlement-pay_now"
            >
              <Banknote size={18} />
              <span>
                <strong>{t('orders.payNow')}</strong>
                <small>{t('orders.payNowHint')}</small>
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!payNow}
              className={`order-settlement__opt ${!payNow ? 'is-on' : ''}`}
              onClick={() => setSettlement('on_bill')}
              data-testid="order-settlement-on_bill"
            >
              <ReceiptText size={18} />
              <span>
                <strong>{t('orders.onBill')}</strong>
                <small>
                  {prepaidSession ? t('orders.onBillPrepaidHint') : t('orders.onBillHint')}
                </small>
              </span>
            </button>
          </div>
        )}
        {payNow && (
          <TenderPanel
            tender={tender}
            onSubmit={submit}
            onCustomerChange={(c) => {
              touched.current = true;
              setCustomer(c);
            }}
            autoFocus
            testId="order"
          />
        )}
        {!payNow && (
          <div className="quote">
            <div className="quote__row quote__row--total">
              <span>{t('orders.total')}</span>
              <strong className="num">{fmt.money(order.totalCents)}</strong>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function OrderLines({ order }: { order: StationOrder }) {
  const { t } = useI18n();
  const fmt = useFormat();
  return (
    <div className="order-lines" data-testid="order-lines">
      {order.items.map((i) => (
        <div key={i.id} className="order-lines__row">
          <span className="num order-lines__qty">{i.quantityMilli / 1000}×</span>
          <span className="order-lines__name">{i.name}</span>
          <span className="num muted">{fmt.money(i.unitPriceCents)}</span>
          <span className="num order-lines__total">{fmt.money(i.lineTotalCents)}</span>
        </div>
      ))}
      {order.note && (
        <div className="order-lines__note">
          <span className="muted">{t('orders.note')}:</span> {order.note}
        </div>
      )}
    </div>
  );
}

/** Receipt of the sale an order produced — same Print / Finish flow as the POS. */
export function OrderReceiptDialog({
  order,
  onFinish,
}: {
  order: StationOrder;
  onFinish: () => void;
}) {
  const { t } = useI18n();
  const receipt = useQuery({
    queryKey: ['orders', order.id, 'receipt', order.saleId],
    queryFn: () => api<ReceiptData>(`/orders/${order.id}/receipt`),
    staleTime: Infinity,
  });
  if (receipt.data) {
    return (
      <SaleDoneDialog
        receipt={receipt.data}
        onFinish={onFinish}
        title={t('sessions.paidTitle')}
        testId="order"
        variant="session"
      />
    );
  }
  return (
    <Dialog
      open
      onClose={onFinish}
      title={t('sessions.paidTitle')}
      description={order.receiptNo ?? ''}
      size="sm"
      footer={<Button onClick={onFinish}>{t('common.close')}</Button>}
    >
      {receipt.isError ? (
        <Alert tone="danger">
          {receipt.error instanceof ApiError ? receipt.error.message : t('common.errorGeneric')}
        </Alert>
      ) : (
        <Loading />
      )}
    </Dialog>
  );
}

// ─── Reject / void ─────────────────────────────────────────────────────────────
export function RejectOrderDialog({
  order,
  mode = 'reject',
  onClose,
  onDone,
}: {
  order: StationOrder;
  /** `void` = write off an order that already sits on the bill (reason required). */
  mode?: 'reject' | 'void';
  onClose: () => void;
  onDone?: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const reasons = ['outOfStock', 'closing', 'comeToDesk', 'debt'] as const;
  const needReason = mode === 'void';
  const act = useMutation({
    mutationFn: () =>
      api<StationOrder>(`/orders/${order.id}/${mode}`, {
        method: 'POST',
        body: { reason: reason.trim() || undefined },
      }),
    onSuccess: () => {
      toast.success(t(mode === 'void' ? 'orders.voided' : 'orders.rejected'));
      invalidateOrders(queryClient);
      onDone?.();
      onClose();
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
      if (err instanceof ApiError && err.status === 409) {
        invalidateOrders(queryClient);
        onClose();
      }
    },
  });
  const ready = !needReason || reason.trim().length > 0;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && ready && !act.isPending) {
      e.preventDefault();
      act.mutate();
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t(mode === 'void' ? 'orders.voidTitle' : 'orders.rejectTitle', {
        number: order.number,
      })}
      description={
        mode === 'void'
          ? t('orders.voidBody')
          : t('orders.rejectBody', { station: order.stationCode })
      }
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button
            variant="danger"
            loading={act.isPending}
            disabled={!ready}
            onClick={() => act.mutate()}
            data-testid="order-reject-confirm"
          >
            <X size={15} /> {t(mode === 'void' ? 'orders.void' : 'orders.reject')} <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
        <OrderLines order={order} />
        {mode === 'reject' && (
          <div className="chips">
            {reasons.map((key) => {
              const label = t(`orders.reasons.${key}`);
              return (
                <button
                  key={key}
                  type="button"
                  className="chip"
                  aria-pressed={reason === label}
                  onClick={() => setReason(reason === label ? '' : label)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
        <Field label={t('orders.reason')} optional={!needReason}>
          {(id) => (
            <Input
              id={id}
              autoFocus
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={onKey}
              data-testid="order-reject-reason"
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
