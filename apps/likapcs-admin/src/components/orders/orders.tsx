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
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, Check, CheckCheck, PackageCheck, ReceiptText, ScanLine, X } from 'lucide-react';
import type {
  CustomerSummary,
  OrderPrepare,
  ProductLookupResponse,
  ReceiptData,
  SessionSummary,
  StationOrder,
} from '@likapcs/shared';
import { ApiError, api } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useBarcodeScanner } from '../../lib/scanner';
import { useI18n } from '../../i18n';
import { useToast } from '../../state/toast';
import { ProductThumb } from '../catalog/ProductImageField';
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
  scanCheck = false,
  onClose,
  onDone,
}: {
  order: StationOrder;
  mode?: 'accept' | 'pay';
  /** `orders.settlement`: pre-selects (and skips the question) unless `ask`. */
  defaultSettlement?: 'ask' | 'pay_now' | 'on_bill';
  prepaidSession?: boolean;
  /** `orders.scan_check` (0.13.0): after accepting, the preparation step (scan / confirm lines). */
  scanCheck?: boolean;
  onClose: () => void;
  onDone?: (order: StationOrder) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  // Lock-screen orders (0.14.0) have no session to bill: "pay now" is the sensible default and
  // "on the bill" works only if a session is running on that PC by the time staff accept.
  const noSession = order.sessionId === null;
  const [settlement, setSettlement] = useState<'pay_now' | 'on_bill'>(
    mode === 'pay' || defaultSettlement === 'pay_now' || noSession
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
  // Accepted and waiting for the preparation check (scan / confirm every line).
  const [prepare, setPrepare] = useState<StationOrder | null>(null);
  const tender = useTender({ totalCents: order.totalCents, customer });
  const payNow = settlement === 'pay_now';
  const ready = !payNow || tender.covered;
  // "On the bill" (0.16.0): show what the customer will pay at the desk — the PC time so far
  // (nothing for prepaid: already paid), the orders already on the bill and this one.
  const session = useQuery({
    queryKey: ['sessions', 'detail', order.sessionId],
    queryFn: () => api<SessionSummary>(`/sessions/${order.sessionId}`),
    enabled: mode === 'accept' && !payNow && Boolean(order.sessionId),
    staleTime: 0,
  });
  const bill = session.data
    ? {
        timeCents: session.data.billingMode === 'prepaid' ? 0 : session.data.currentPriceCents,
        otherOrdersCents: session.data.openOrdersCents,
        billingMode: session.data.billingMode,
      }
    : null;
  const billTotal = bill ? bill.timeCents + bill.otherOrdersCents + order.totalCents : null;

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
      } else toast.success(t('orders.accepted'));
      // Accepting opens the preparation check first (unless switched off); the receipt follows.
      if (mode === 'accept' && scanCheck && result.items.length) setPrepare(result);
      else finish(result);
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
  const finish = (result: StationOrder) => {
    if (result.saleId) setDone(result);
    else {
      onDone?.(result);
      onClose();
    }
  };

  if (prepare) {
    return (
      <PrepareOrderDialog
        order={prepare}
        onClose={(prepared) => {
          const result = prepared ?? prepare;
          setPrepare(null);
          finish(result);
        }}
      />
    );
  }

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
                  {noSession
                    ? t('orders.onBillLockedHint')
                    : prepaidSession
                      ? t('orders.onBillPrepaidHint')
                      : t('orders.onBillHint')}
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
          <div className="quote" data-testid="order-bill-preview">
            {bill && (
              <>
                <div className="quote__row">
                  <span>
                    {bill.billingMode === 'prepaid'
                      ? t('orders.billTimePrepaid')
                      : bill.billingMode === 'endpay'
                        ? t('orders.billTimeEndPay')
                        : t('orders.billTimeSoFar')}
                  </span>
                  <span className="num">{fmt.money(bill.timeCents)}</span>
                </div>
                {bill.otherOrdersCents > 0 && (
                  <div className="quote__row">
                    <span>{t('orders.billOtherOrders')}</span>
                    <span className="num">{fmt.money(bill.otherOrdersCents)}</span>
                  </div>
                )}
              </>
            )}
            <div className="quote__row">
              <span>{t('orders.billThisOrder')}</span>
              <span className="num">{fmt.money(order.totalCents)}</span>
            </div>
            <div className="quote__row quote__row--total">
              <span>{bill ? t('orders.billTotal') : t('orders.total')}</span>
              <strong className="num" data-testid="order-bill-total">
                {fmt.money(billTotal ?? order.totalCents)}
              </strong>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ─── Preparation check (0.13.0) ─────────────────────────────────────────────────
interface PrepareLine {
  scanned: number;
  manual: boolean;
}

/**
 * After an order is accepted the desk prepares it: every line is scanned with the barcode scanner
 * (one scan per unit — the right product, the exact quantity) or confirmed by hand. The check is
 * optional per line ("Confirm without scanning") and as a whole ("Skip"); when it is finished
 * the server stores what was verified and the PC is told the order is on its way.
 */
export function PrepareOrderDialog({
  order,
  onClose,
}: {
  order: StationOrder;
  /** `prepared` = the order as stored by the server; null = skipped. */
  onClose: (prepared: StationOrder | null) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const units = (milli: number) => Math.max(1, Math.round(milli / 1000));
  const [lines, setLines] = useState<Record<number, PrepareLine>>(() =>
    Object.fromEntries(order.items.map((i) => [i.id, { scanned: 0, manual: false }])),
  );
  const [lastHit, setLastHit] = useState<number | null>(null);
  const lineOf = (id: number): PrepareLine => lines[id] ?? { scanned: 0, manual: false };
  const complete = (i: StationOrder['items'][number]) => {
    const l = lineOf(i.id);
    return l.manual || l.scanned >= units(i.quantityMilli);
  };
  const allDone = order.items.every(complete);
  const doneCount = order.items.filter(complete).length;

  const lookup = useMutation({
    mutationFn: (code: string) =>
      api<ProductLookupResponse>('/products/lookup', { query: { code } }),
    onSuccess: (r) => {
      const perScan = units(r.quantityMilli);
      // The first line of that product that still needs units; otherwise the first line of it.
      const candidates = order.items.filter((i) => i.productId === r.product.id);
      if (!candidates.length) {
        toast.error(t('orders.prepare.notInOrder', { name: r.product.name }));
        return;
      }
      const open = candidates.find((i) => !complete(i));
      if (!open) {
        toast.toast('warning', t('orders.prepare.alreadyComplete', { name: r.product.name }));
        return;
      }
      setLines((prev) => {
        const cur = prev[open.id] ?? { scanned: 0, manual: false };
        return { ...prev, [open.id]: { ...cur, scanned: cur.scanned + perScan } };
      });
      setLastHit(open.id);
    },
    onError: (err, code) =>
      toast.error(
        err instanceof ApiError && err.status === 404
          ? t('orders.prepare.unknownCode', { code })
          : err instanceof ApiError
            ? err.message
            : t('common.errorGeneric'),
      ),
  });
  const onScan = useCallback((code: string) => lookup.mutate(code), [lookup]);
  useBarcodeScanner({ onScan, exclusive: true });

  const save = useMutation({
    mutationFn: () => {
      const body: OrderPrepare = {
        items: order.items.map((i) => {
          const l = lineOf(i.id);
          const scanned = Math.min(l.scanned, units(i.quantityMilli));
          return {
            itemId: i.id,
            verifiedMilli: l.manual ? i.quantityMilli : scanned * 1000,
            verification: l.manual || scanned === 0 ? 'manual' : 'scan',
          };
        }),
      };
      return api<StationOrder>(`/orders/${order.id}/prepare`, { method: 'POST', body });
    },
    onSuccess: (result) => {
      invalidateOrders(queryClient);
      toast.success(t('orders.prepare.done', { number: order.number }));
      onClose(result);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  const confirmLine = (id: number) =>
    setLines((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? { scanned: 0, manual: false }), manual: true },
    }));
  const resetLine = (id: number) =>
    setLines((prev) => ({ ...prev, [id]: { scanned: 0, manual: false } }));

  return (
    <Dialog
      open
      onClose={() => onClose(null)}
      size="md"
      title={t('orders.prepare.title', { number: order.number, station: order.stationCode })}
      description={t('orders.prepare.hint')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onClose(null)} data-testid="order-prepare-skip">
            {t('orders.prepare.skip')} <Kbd>Esc</Kbd>
          </Button>
          <span className="muted" style={{ fontSize: 12.5 }}>
            {t('orders.prepare.progress', { done: doneCount, total: order.items.length })}
          </span>
          <span style={{ flex: 1 }} />
          <Button
            variant="primary"
            size="lg"
            disabled={!allDone}
            loading={save.isPending}
            onClick={() => save.mutate()}
            data-testid="order-prepare-done"
          >
            <PackageCheck size={16} /> {t('orders.prepare.finish')}
          </Button>
        </>
      }
    >
      <div className="prep" data-testid="order-prepare">
        <div className="prep__scanhint">
          <ScanLine size={16} />
          <span>{t('orders.prepare.scanHint')}</span>
        </div>
        <ul className="prep__lines">
          {order.items.map((i) => {
            const need = units(i.quantityMilli);
            const l = lineOf(i.id);
            const got = Math.min(l.scanned, need);
            const isDone = complete(i);
            return (
              <li
                key={i.id}
                className={`prep__line ${isDone ? 'is-done' : ''} ${lastHit === i.id ? 'is-hit' : ''}`}
                data-testid="order-prepare-line"
                data-done={isDone}
                data-scanned={got}
              >
                <ProductThumb url={i.imageUrl} size={44} name={i.name} />
                <div className="prep__main">
                  <div className="prep__name">{i.name}</div>
                  <div className="prep__count num" data-testid="order-prepare-count">
                    {l.manual ? (
                      <span className="prep__manual">
                        <CheckCheck size={13} /> {t('orders.prepare.confirmedManually')}
                      </span>
                    ) : (
                      <>
                        <b>{got}</b> / {need} {t('orders.prepare.scanned')}
                      </>
                    )}
                  </div>
                  <div className="prep__bar" aria-hidden>
                    <i style={{ width: `${l.manual ? 100 : Math.round((got / need) * 100)}%` }} />
                  </div>
                </div>
                <div className="prep__actions">
                  {isDone ? (
                    <>
                      <span className="prep__ok" data-testid="order-prepare-ok">
                        <Check size={16} />
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => resetLine(i.id)}>
                        {t('orders.prepare.again')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => confirmLine(i.id)}
                      data-testid="order-prepare-manual"
                    >
                      <Check size={14} /> {t('orders.prepare.confirmManual')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {order.note && (
          <div className="order-lines__note">
            <span className="muted">{t('orders.note')}:</span> {order.note}
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
