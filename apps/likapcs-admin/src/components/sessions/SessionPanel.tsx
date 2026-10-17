/**
 * Session controls for one station: start (prepaid with a live quote, or postpaid), pause, resume,
 * extend, end and cancel. Money is taken exactly like the POS: the shared `TenderPanel` (cash with
 * change, card when enabled, "pay later" on the session's customer when enabled) and the same
 * "done" dialog with the change, the receipt and Print / Finish. All amounts and timers are
 * authoritative on the server; this panel only mirrors them and ticks locally between refreshes.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Check,
  Clock,
  Gift,
  Hourglass,
  Pause,
  Play,
  Plus,
  Square,
  X,
  XCircle,
} from 'lucide-react';
import {
  PERMISSIONS,
  parseMoneyInput,
  type GamingPackageSummary,
  type CustomerSummary,
  type SessionMutationResponse,
  type SessionQuoteResponse,
  type SessionRequest,
  type SessionSummary,
  type StationPendingRequest,
  type StationSummary,
} from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import {
  billingModeKey,
  formatHms,
  liveSessionPrice,
  projectSession,
} from '../../lib/session-time';
import { useFormat } from '../../lib/format';
import { useEnterSubmits } from '../../lib/enter-submit';
import { useI18n } from '../../i18n';
import { useAuth } from '../../state/auth';
import { useToast } from '../../state/toast';
import { useShiftGuard } from '../../state/shift-guard';
import { CustomerPicker } from '../customers/CustomerPicker';
import { TenderPanel, useTender } from '../payments/TenderPanel';
import { RejectRequestDialog, requestDuration } from '../requests/requests';
import { SessionPaidDialog, type SessionPaid } from './SessionPaidDialog';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Field,
  Input,
  Kbd,
  Loading,
  Segmented,
  Textarea,
} from '../ui/primitives';

const QUICK_MINUTES = [30, 60, 90, 120, 180];

/** Re-render once per second so timers tick without refetching. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * The customer attached to a session, as a full summary (balance and credit limit) so the tender
 * panel can offer "pay later" and check the limit before the server does. A picker in the panel
 * may replace it for walk-in sessions.
 */
export function useSessionCustomer(session: SessionSummary | null) {
  const [picked, setPicked] = useState<CustomerSummary | null>(null);
  const customerId = session?.customerId ?? null;
  const attached = useQuery({
    queryKey: ['customers', customerId],
    queryFn: () => api<CustomerSummary>(`/customers/${customerId}`),
    enabled: customerId !== null,
    staleTime: 15_000,
  });
  return {
    customer: picked ?? attached.data ?? null,
    /** Set when the operator picked someone other than the attached customer. */
    pickedId: picked && picked.id !== customerId ? picked.id : undefined,
    setCustomer: setPicked,
  };
}

export function SessionPanel({
  station,
  onChanged,
  approveRequestId = null,
}: {
  station: StationSummary;
  onChanged: () => void;
  /** Deep link "Approve" (bell / toast): the matching request is pre-filled straight away. */
  approveRequestId?: string | null;
}) {
  const { t } = useI18n();
  const { can } = useAuth();
  // Lives here, not in the start form / active view: ending a session swaps those two, and the
  // "paid" dialog must survive the swap.
  const [paid, setPaid] = useState<SessionPaid | null>(null);
  const live = station.activeSession;
  const canControl = can(PERMISSIONS.STATIONS_CONTROL);
  // The customer's waiting request (if any) and whether staff chose to approve it: approving
  // pre-fills the start form / opens the extend dialog with `requestId`; the server then marks the
  // request approved in the same transaction as the session.
  const request = station.pendingRequest;
  const [approving, setApproving] = useState<string | null>(approveRequestId);
  const [rejecting, setRejecting] = useState(false);
  useEffect(() => {
    if (approveRequestId) setApproving(approveRequestId);
  }, [approveRequestId]);
  const approvedRequest = request && approving === request.id ? request : null;
  if (!canControl && !live) {
    return <p className="muted">{t('sessions.noSession')}</p>;
  }
  return (
    <>
      {request && canControl && (
        <RequestBanner
          request={request}
          approving={approvedRequest !== null}
          onApprove={() => setApproving(request.id)}
          onReject={() => setRejecting(true)}
        />
      )}
      {live ? (
        <ActiveSession
          sessionId={live.id}
          station={station}
          onChanged={onChanged}
          onPaid={setPaid}
          approveRequest={approvedRequest?.kind === 'extend' ? approvedRequest : null}
          onApproveHandled={() => setApproving(null)}
        />
      ) : (
        <StartSessionForm
          key={approvedRequest?.id ?? 'blank'}
          station={station}
          onChanged={onChanged}
          onPaid={setPaid}
          request={approvedRequest?.kind === 'start' ? approvedRequest : null}
        />
      )}
      {rejecting && request && (
        <RejectRequestDialog
          request={toRequest(request, station)}
          onClose={() => setRejecting(false)}
          onDone={() => setApproving(null)}
        />
      )}
      {paid && <SessionPaidDialog paid={paid} onFinish={() => setPaid(null)} />}
    </>
  );
}

/** The tile's compact request + the station → what the reject dialog needs to describe it. */
function toRequest(r: StationPendingRequest, station: StationSummary): SessionRequest {
  return {
    id: r.id,
    stationId: station.id,
    stationCode: station.code,
    stationName: station.name,
    customerId: r.customerId,
    customerName: r.customerName,
    customerCode: '',
    customerBalanceDueCents: 0,
    kind: r.kind,
    minutes: r.minutes,
    packageId: r.packageId,
    packageName: r.packageName,
    durationMinutes: r.durationMinutes,
    sessionId: null,
    status: 'pending',
    reason: null,
    requestedAt: r.requestedAt,
    decidedAt: null,
    decidedByName: null,
  };
}

function RequestBanner({
  request,
  approving,
  onApprove,
  onReject,
}: {
  request: StationPendingRequest;
  approving: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const duration = requestDuration(request, t('requests.package'));
  return (
    <div
      className={`request-banner ${approving ? 'request-banner--approving' : ''}`}
      data-testid="request-banner"
      data-approving={approving || undefined}
    >
      <Bell size={16} />
      <div className="request-banner__text">
        <div>
          {t(request.kind === 'extend' ? 'requests.bannerExtend' : 'requests.bannerStart', {
            customer: request.customerName,
            duration,
          })}
          <span className="faint">
            {' '}
            · {t('requests.since', { time: fmt.relative(request.requestedAt) })}
          </span>
        </div>
        {approving && (
          <div className="faint" style={{ fontSize: 12 }}>
            {t(request.kind === 'extend' ? 'requests.approveExtendHint' : 'requests.approveHint')}
          </div>
        )}
      </div>
      <div className="request-banner__actions">
        {!approving && (
          <Button size="sm" variant="primary" onClick={onApprove} data-testid="banner-approve">
            <Check size={14} /> {t('requests.approve')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onReject} data-testid="banner-reject">
          <X size={14} /> {t('requests.reject')}
        </Button>
      </div>
    </div>
  );
}

/** Where a successful start / extend / end lands: the "paid" dialog when money changed hands. */
export function paidFrom(result: SessionMutationResponse): SessionPaid | null {
  return result.payment ? { sessionId: result.session.id, payment: result.payment } : null;
}

// ─── Start ─────────────────────────────────────────────────────────────────────
function StartSessionForm({
  station,
  onChanged,
  onPaid,
  request = null,
}: {
  station: StationSummary;
  onChanged: () => void;
  onPaid: (paid: SessionPaid | null) => void;
  /** Approving a customer's request: duration + customer pre-filled, `requestId` sent along. */
  request?: StationPendingRequest | null;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const shiftGuard = useShiftGuard();
  const [mode, setMode] = useState<'prepaid' | 'postpaid'>('prepaid');
  const [packageId, setPackageId] = useState<string | null>(request?.packageId ?? null);
  const [minutes, setMinutes] = useState(
    request && !request.packageId ? String(request.durationMinutes) : '60',
  );
  const [customerName, setCustomerName] = useState('');
  const [customer, setCustomer] = useState<CustomerSummary | null>(null);
  const [notes, setNotes] = useState('');
  // One request id per form instance: a retried click can never start two sessions.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  // The requesting customer, as a full summary (debt / credit limit for "pay later").
  const requester = useQuery({
    queryKey: ['customers', request?.customerId ?? null],
    queryFn: () => api<CustomerSummary>(`/customers/${request!.customerId}`),
    enabled: !!request?.customerId,
    staleTime: 15_000,
  });
  useEffect(() => {
    if (requester.data && !customer) setCustomer(requester.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the requester arrives
  }, [requester.data]);

  const packages = useQuery({
    queryKey: ['pricing', 'packages', 'available', station.id],
    queryFn: () =>
      api<GamingPackageSummary[]>('/pricing/packages', { query: { stationId: station.id } }),
    staleTime: 30_000,
  });
  const minutesValue = Number.parseInt(minutes, 10);
  const minutesValid = Number.isInteger(minutesValue) && minutesValue > 0 && minutesValue <= 1440;
  const quoteBody = useMemo(
    () =>
      mode === 'postpaid'
        ? { stationId: station.id, billingMode: 'postpaid' as const }
        : packageId
          ? { stationId: station.id, billingMode: 'prepaid' as const, packageId }
          : minutesValid
            ? { stationId: station.id, billingMode: 'prepaid' as const, minutes: minutesValue }
            : null,
    [mode, packageId, minutesValid, minutesValue, station.id],
  );
  const quote = useQuery({
    queryKey: ['sessions', 'quote', quoteBody],
    queryFn: () =>
      api<SessionQuoteResponse>('/sessions/quote', { method: 'POST', body: quoteBody }),
    enabled: quoteBody !== null,
    staleTime: 10_000,
  });
  const prepaid = mode === 'prepaid';
  const tender = useTender({
    totalCents: prepaid ? (quote.data?.priceCents ?? 0) : 0,
    customer,
    allowEndPay: true,
  });

  const start = useMutation({
    mutationFn: () =>
      api<SessionMutationResponse>('/sessions', {
        method: 'POST',
        body: {
          ...quoteBody,
          // "End Pay": the same reserved time, nothing paid now, collected when it ends.
          ...(prepaid && tender.endPay ? { billingMode: 'endpay' } : {}),
          customerId: customer?.id,
          customerName: customer ? undefined : customerName.trim() || undefined,
          ...(prepaid && !tender.endPay ? { payments: tender.payments } : {}),
          notes: notes.trim() || undefined,
          clientRequestId: requestId,
          ...(request ? { requestId: request.id } : {}),
        },
      }),
    onSuccess: (result) => {
      toast.success(t('sessions.started', { code: station.code }));
      notifyClientAck(result, toast, t);
      setRequestId(crypto.randomUUID());
      setCustomerName('');
      setNotes('');
      onPaid(paidFrom(result));
      onChanged();
    },
    onError: (err) => {
      if (shiftGuard.handle(err, () => start.mutate())) return;
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    },
  });

  const noRule = quote.data && !quote.data.rule && (mode === 'postpaid' || !packageId);
  const endsAt =
    quote.data?.minutes != null ? new Date(Date.now() + quote.data.minutes * 60_000) : null;
  const ready = !!quoteBody && !!quote.data && station.isEnabled && (!prepaid || tender.covered);
  const submit = () => {
    if (ready && !start.isPending) start.mutate();
  };

  return (
    <div className="stack">
      <Segmented
        value={mode}
        onChange={(v) => {
          setMode(v);
          setPackageId(null);
        }}
        options={[
          { value: 'prepaid', label: t('sessions.prepaid') },
          { value: 'postpaid', label: t('sessions.postpaid') },
        ]}
        ariaLabel={t('sessions.duration')}
      />

      {prepaid && (
        <Field label={t('sessions.duration')}>
          {(id) => (
            <>
              <div className="chips">
                {(packages.data ?? []).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="chip"
                    aria-pressed={packageId === p.id}
                    onClick={() => setPackageId(p.id)}
                  >
                    <strong>{p.name}</strong> · {p.durationMinutes}{' '}
                    {t('sessions.minutes').toLowerCase()} · {fmt.money(p.priceCents)}
                  </button>
                ))}
                {QUICK_MINUTES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className="chip"
                    aria-pressed={packageId === null && minutes === String(m)}
                    onClick={() => {
                      setPackageId(null);
                      setMinutes(String(m));
                    }}
                  >
                    {m} min
                  </button>
                ))}
              </div>
              <div className="row" style={{ marginTop: 8, gap: 8, alignItems: 'center' }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  {t('sessions.customMinutes')}
                </span>
                <Input
                  id={id}
                  type="number"
                  min={1}
                  max={1440}
                  value={minutes}
                  style={{ width: 110 }}
                  onChange={(e) => {
                    setPackageId(null);
                    setMinutes(e.target.value);
                  }}
                />
              </div>
            </>
          )}
        </Field>
      )}

      <div className="grid grid--2">
        <Field label={t('sessions.customer')} optional>
          {(id) => (
            <CustomerPicker
              id={id}
              value={customer}
              onChange={setCustomer}
              text={customerName}
              onTextChange={setCustomerName}
              allowFreeText
              placeholder={t('sessions.customerOptional')}
            />
          )}
        </Field>
        <Field label={t('sessions.notes')} optional>
          {(id) => (
            <Textarea
              id={id}
              rows={1}
              value={notes}
              maxLength={500}
              onChange={(e) => setNotes(e.target.value)}
            />
          )}
        </Field>
      </div>

      {quote.isFetching && !quote.data && <Loading />}
      {quote.isError && (
        <Alert tone="danger">
          {quote.error instanceof ApiError ? quote.error.message : t('common.errorGeneric')}
        </Alert>
      )}
      {noRule && <Alert tone="warning">{t('sessions.noRule')}</Alert>}
      {quote.data && (
        <div className="quote">
          <div className="quote__row">
            <span className="muted">{t('sessions.quoteRule')}</span>
            <span>
              {quote.data.package?.name ?? quote.data.rule?.name ?? '—'}
              {quote.data.rule && (
                <span className="faint">
                  {' '}
                  · {fmt.money(quote.data.rule.rateCentsPerHour)}
                  {t('sessions.perHour')}
                </span>
              )}
            </span>
          </div>
          {endsAt && (
            <div className="quote__row">
              <span className="muted">{t('sessions.quoteUntil')}</span>
              <span className="num">{fmt.time(endsAt)}</span>
            </div>
          )}
          {!prepaid && (
            <div className="quote__row quote__row--total">
              <span>{t('sessions.quoteRate')}</span>
              <strong className="num">
                {fmt.money(quote.data.terms.rateCentsPerHour)}
                {t('sessions.perHour')}
              </strong>
            </div>
          )}
        </div>
      )}
      {prepaid && quote.data && quote.data.priceCents > 0 && (
        <TenderPanel
          tender={tender}
          onSubmit={submit}
          onCustomerChange={setCustomer}
          autoFocus={false}
          testId="session-start"
        />
      )}

      {!station.device?.online && <Alert tone="warning">{t('sessions.offlineWarning')}</Alert>}
      <Button
        variant="primary"
        size="lg"
        disabled={!ready}
        loading={start.isPending}
        onClick={submit}
        data-testid="session-start-submit"
      >
        <Play size={16} />{' '}
        {prepaid && tender.endPay && quote.data && quote.data.priceCents > 0
          ? t('map.startEndPay')
          : t('sessions.start')}
      </Button>
    </div>
  );
}

// ─── Active session ────────────────────────────────────────────────────────────
function ActiveSession({
  sessionId,
  station,
  onChanged,
  onPaid,
  approveRequest = null,
  onApproveHandled,
}: {
  sessionId: string;
  station: StationSummary;
  onChanged: () => void;
  onPaid: (paid: SessionPaid | null) => void;
  /** Approving a customer's extension request: the extend dialog opens pre-filled. */
  approveRequest?: StationPendingRequest | null;
  onApproveHandled?: () => void;
}) {
  const { t } = useI18n();
  const { can } = useAuth();
  const fmt = useFormat();
  const toast = useToast();
  const shiftGuard = useShiftGuard();
  const queryClient = useQueryClient();
  const now = useNow();
  const [dialog, setDialog] = useState<'end' | 'extend' | 'cancel' | null>(null);
  const canControl = can(PERMISSIONS.STATIONS_CONTROL);
  const canGift = can(PERMISSIONS.STATIONS_GIFT);
  useEffect(() => {
    if (approveRequest) setDialog('extend');
  }, [approveRequest]);

  const session = useQuery({
    queryKey: ['sessions', sessionId],
    queryFn: () => api<SessionSummary>(`/sessions/${sessionId}`),
    refetchInterval: 15_000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    onChanged();
  };
  const act = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: Record<string, unknown> }) =>
      api<SessionMutationResponse>(`/sessions/${sessionId}/${action}`, {
        method: 'POST',
        body: body ?? {},
      }),
    onSuccess: (result, { action }) => {
      const messages: Record<string, string> = {
        gift: t('sessions.gifted'),
        pause: t('sessions.paused'),
        resume: t('sessions.resumed'),
        extend: t('sessions.extended'),
        end: result.session.awaitingPayment
          ? t('sessions.endedAwaiting', {
              total: fmt.money(result.session.finalPriceCents ?? result.session.currentPriceCents),
            })
          : t('sessions.ended', {
              total: fmt.money(
                result.payment?.totalCents ??
                  result.session.finalPriceCents ??
                  result.session.currentPriceCents,
              ),
            }),
        cancel: t('sessions.cancelled'),
      };
      toast.success(messages[action] ?? t('pricing.saved'));
      notifyClientAck(result, toast, t);
      setDialog(null);
      onPaid(paidFrom(result));
      refresh();
    },
    onError: (err, variables) => {
      if (shiftGuard.handle(err, () => act.mutate(variables))) return;
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    },
  });

  if (session.isLoading || !session.data) return <Loading />;
  const s = session.data;
  const { elapsed, remaining } = projectSession(s, session.dataUpdatedAt, now);
  const livePrice = liveSessionPrice(s, Math.floor(elapsed));
  const expiringSoon = remaining !== null && remaining <= 300;

  return (
    <div className="stack">
      <div className="row row--between">
        <div className="row" style={{ gap: 8 }}>
          <Badge tone={s.status === 'paused' ? 'warning' : 'accent'} dot>
            {s.status === 'paused' && s.pausedBy
              ? t(`sessions.pausedBy.${s.pausedBy}`)
              : t(`sessions.status.${s.status}`)}
          </Badge>
          {s.status === 'paused' && s.autoResumeAt && (
            <span className="muted num" data-testid="session-auto-resume">
              {t('sessions.autoResumeIn', {
                time: formatHms(Math.max(0, Math.round((Date.parse(s.autoResumeAt) - now) / 1000))),
              })}
            </span>
          )}
          <Badge tone={s.billingMode === 'endpay' ? 'accent' : 'default'}>
            {t(billingModeKey(s.billingMode))}
          </Badge>
        </div>
        <span className="muted">{s.customerName ?? t('sessions.customerOptional')}</span>
      </div>

      <div className="session-timers">
        <div className="session-timer">
          <div className="session-timer__label">{t('sessions.elapsed')}</div>
          <div className="session-timer__value num">{formatHms(elapsed)}</div>
        </div>
        {remaining !== null && (
          <div className="session-timer" data-warn={expiringSoon || undefined}>
            <div className="session-timer__label">{t('sessions.remaining')}</div>
            <div className="session-timer__value num">{formatHms(remaining)}</div>
          </div>
        )}
        <div className="session-timer">
          <div className="session-timer__label">
            {s.billingMode === 'prepaid'
              ? t('sessions.paid')
              : s.billingMode === 'endpay'
                ? t('sessions.dueAtEnd')
                : t('sessions.currentPrice')}
          </div>
          <div className="session-timer__value num">{fmt.money(livePrice)}</div>
        </div>
      </div>

      <div className="stack" style={{ gap: 4, fontSize: 13 }}>
        <div className="row row--between">
          <span className="muted">{t('sessions.quoteRule')}</span>
          <span>
            {s.packageName ?? s.ruleName ?? '—'}
            <span className="faint">
              {' '}
              · {fmt.money(s.rateCentsPerHour)}
              {t('sessions.perHour')}
            </span>
          </span>
        </div>
        <div className="row row--between">
          <span className="muted">{t('common.created')}</span>
          <span className="num">{fmt.time(s.startedAt)}</span>
        </div>
        {s.endsAt && (
          <div className="row row--between">
            <span className="muted">{t('sessions.quoteUntil')}</span>
            <span className="num">{fmt.time(s.endsAt)}</span>
          </div>
        )}
        {s.receiptNo && (
          <div className="row row--between">
            <span className="muted">{t('sessions.receipt')}</span>
            <span className="num">{s.receiptNo}</span>
          </div>
        )}
        {s.openOrdersCount > 0 && (
          <div className="row row--between" data-testid="session-open-orders">
            <span className="muted">{t('sessions.openOrders')}</span>
            <Link to="/orders" className="num">
              {t('sessions.openOrdersN', {
                n: s.openOrdersCount,
                amount: fmt.money(s.openOrdersCents),
              })}
            </Link>
          </div>
        )}
      </div>

      {!station.device?.online && <Alert tone="warning">{t('sessions.offlineWarning')}</Alert>}

      {canControl && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {s.status === 'active' ? (
            <Button onClick={() => act.mutate({ action: 'pause' })} loading={act.isPending}>
              <Pause size={14} /> {t('sessions.pause')}
            </Button>
          ) : (
            <Button onClick={() => act.mutate({ action: 'resume' })} loading={act.isPending}>
              <Play size={14} /> {t('sessions.resume')}
            </Button>
          )}
          {s.billingMode !== 'postpaid' && (
            <Button onClick={() => setDialog('extend')}>
              <Plus size={14} /> {t('sessions.extend')}
            </Button>
          )}
          <Button variant="primary" onClick={() => setDialog('end')} data-testid="session-end">
            <Square size={14} /> {t('sessions.end')}
          </Button>
          {s.billingMode !== 'prepaid' && (
            <Button variant="ghost" onClick={() => setDialog('cancel')}>
              <XCircle size={14} /> {t('sessions.cancel')}
            </Button>
          )}
        </div>
      )}

      {dialog === 'end' && (
        <EndSessionDialog
          session={s}
          elapsedSeconds={Math.floor(elapsed)}
          livePrice={livePrice}
          busy={act.isPending}
          onClose={() => setDialog(null)}
          onConfirm={(body) => act.mutate({ action: 'end', body })}
        />
      )}
      {dialog === 'extend' && (
        <ExtendSessionDialog
          key={approveRequest?.id ?? 'manual'}
          session={s}
          busy={act.isPending}
          request={approveRequest}
          onClose={() => {
            setDialog(null);
            onApproveHandled?.();
          }}
          canGift={canGift}
          onConfirm={(body, action) => act.mutate({ action: action ?? 'extend', body })}
        />
      )}
      {dialog === 'cancel' && (
        <CancelSessionDialog
          busy={act.isPending}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => act.mutate({ action: 'cancel', body: { reason } })}
        />
      )}
    </div>
  );
}

// ─── End ───────────────────────────────────────────────────────────────────────
/**
 * Postpaid: the clock stops the moment this opens — the amount shown is the amount billed while
 * the money is counted (the server honours it within its own bounded window via
 * `stoppedSecondsAgo`) — then the shared tender panel takes the payment. End pay: the same, but
 * the amount is capped at the reserved price and "Collect later" parks the bill under
 * "To collect" instead of taking money now. Prepaid: nothing to pay, just a confirmation.
 */
export function EndSessionDialog({
  session,
  elapsedSeconds,
  livePrice,
  busy,
  onClose,
  onConfirm,
}: {
  session: SessionSummary;
  elapsedSeconds: number;
  livePrice: number;
  busy: boolean;
  onClose: () => void;
  onConfirm: (body: Record<string, unknown>) => void;
}) {
  const { t } = useI18n();
  const { can } = useAuth();
  const fmt = useFormat();
  const postpaid = session.billingMode === 'postpaid';
  const endpay = session.billingMode === 'endpay';
  /** The clock decides the amount (open time, end pay) — as opposed to prepaid. */
  const metered = postpaid || endpay;
  // Drinks / snacks accepted "on the bill" are settled on this receipt (prepaid too).
  const ordersCents = session.openOrdersCents;
  const bills = metered || ordersCents > 0;
  // Frozen at open: the first render's live values and the moment they were taken.
  const [stopped] = useState(() => ({
    at: Date.now(),
    elapsedSeconds,
    priceCents: livePrice,
  }));
  const [discount, setDiscount] = useState('');
  const discountCents = discount.trim() ? parseMoneyInput(discount) : 0;
  const discountInvalid =
    discountCents === null || discountCents < 0 || discountCents > stopped.priceCents;
  const timeCents = metered ? Math.max(0, stopped.priceCents - (discountCents ?? 0)) : 0;
  const total = timeCents + ordersCents;
  const { customer, pickedId, setCustomer } = useSessionCustomer(session);
  const tender = useTender({ totalCents: total, customer });
  const ready = !bills || (!discountInvalid && tender.covered);
  const stoppedSecondsAgo = () => Math.max(0, Math.floor((Date.now() - stopped.at) / 1000));
  const submit = () => {
    if (!ready || busy) return;
    onConfirm(
      metered
        ? {
            discountCents: discountCents ?? 0,
            payments: tender.payments,
            stoppedSecondsAgo: stoppedSecondsAgo(),
            customerId: pickedId,
          }
        : bills
          ? { payments: tender.payments, customerId: pickedId }
          : {},
    );
  };
  /** End pay only: lock the PC now, leave the bill open under "To collect". */
  const collectLater = () => {
    if (busy || discountInvalid) return;
    onConfirm({
      discountCents: discountCents ?? 0,
      stoppedSecondsAgo: stoppedSecondsAgo(),
      customerId: pickedId,
    });
  };
  useEnterSubmits(submit);

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('sessions.endTitle')}
      description={metered ? t('sessions.clockStoppedHint') : t('sessions.endBody')}
      size={bills ? 'md' : 'sm'}
      footer={
        <>
          <Button onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          {endpay && (
            <Button
              variant="ghost"
              size="lg"
              disabled={busy || discountInvalid}
              title={t('sessions.collectLaterHint')}
              onClick={collectLater}
              data-testid="session-end-later"
            >
              <Hourglass size={14} /> {t('sessions.collectLater')}
            </Button>
          )}
          <Button
            variant="primary"
            size="lg"
            loading={busy}
            disabled={!ready}
            onClick={submit}
            data-testid="session-end-confirm"
          >
            <Square size={14} />{' '}
            {bills && tender.mode === 'credit' && tender.creditCents > 0
              ? t('pos.completeOnTab')
              : t('sessions.end')}{' '}
            <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="quote">
          <div className="quote__row">
            <span className="muted">{t('sessions.billable')}</span>
            <span className="num">{formatHms(stopped.elapsedSeconds)}</span>
          </div>
          {endpay && stopped.priceCents < session.currentPriceCents && (
            <div className="quote__row" data-testid="session-end-reserved">
              <span className="muted">{t('sessions.reserved')}</span>
              <span className="num">
                <s className="faint">{fmt.money(session.currentPriceCents)}</s>
              </span>
            </div>
          )}
          {metered && ((discountCents ?? 0) > 0 || ordersCents > 0 || endpay) && (
            <div className="quote__row">
              <span className="muted">
                {ordersCents > 0 ? t('sessions.timePrice') : t('sessions.currentPrice')}
              </span>
              <span className="num">
                {(discountCents ?? 0) > 0 ? fmt.money(timeCents) : fmt.money(stopped.priceCents)}
              </span>
            </div>
          )}
          {!metered && (
            <div className={`quote__row ${ordersCents > 0 ? '' : 'quote__row--total'}`}>
              <span>{t('sessions.paid')}</span>
              <strong className="num">{fmt.money(session.currentPriceCents)}</strong>
            </div>
          )}
          {ordersCents > 0 && (
            <>
              <div className="quote__row" data-testid="session-end-orders">
                <span className="muted">
                  {t('sessions.ordersOnBill', { n: session.openOrdersCount })}
                </span>
                <span className="num">{fmt.money(ordersCents)}</span>
              </div>
              <div className="quote__row quote__row--total">
                <span>{t('sessions.totalDue')}</span>
                <strong className="num" data-testid="session-end-total">
                  {fmt.money(total)}
                </strong>
              </div>
            </>
          )}
        </div>
        {ordersCents > 0 && (
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            {t('sessions.endOrdersHint')}
          </p>
        )}
        {metered && can(PERMISSIONS.POS_DISCOUNT) && (
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
                data-testid="session-end-discount"
              />
            )}
          </Field>
        )}
        {bills && (
          <TenderPanel
            tender={tender}
            onSubmit={submit}
            onCustomerChange={setCustomer}
            testId="session-end"
          />
        )}
      </div>
    </Dialog>
  );
}

// ─── Extend ────────────────────────────────────────────────────────────────────
export function ExtendSessionDialog({
  session,
  busy,
  onClose,
  onConfirm,
  request = null,
  canGift = false,
  initialGift = false,
}: {
  session: SessionSummary;
  busy: boolean;
  onClose: () => void;
  onConfirm: (body: Record<string, unknown>, action?: 'extend' | 'gift') => void;
  /** 0.19.1: open straight in gift mode (the station's "Gift" button). */
  initialGift?: boolean;
  /** Approving a customer's extension request: duration pre-filled, `requestId` sent along. */
  request?: StationPendingRequest | null;
  /** 0.18.0: `stations.gift` — free minutes with a party on the PC (not for postpaid sessions). */
  canGift?: boolean;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const [packageId, setPackageId] = useState<string | null>(request?.packageId ?? null);
  const [minutes, setMinutes] = useState(
    request && !request.packageId ? String(request.durationMinutes) : '30',
  );
  const [gift, setGift] = useState(initialGift);
  const [reason, setReason] = useState('');
  const giftPossible = canGift && !request && session.billingMode !== 'postpaid';
  const useGift = gift && giftPossible;
  const [requestId] = useState(() => crypto.randomUUID());
  const minutesValue = Number.parseInt(minutes, 10);
  const minutesValid = Number.isInteger(minutesValue) && minutesValue > 0 && minutesValue <= 1440;
  const packages = useQuery({
    queryKey: ['pricing', 'packages', 'available', session.stationId],
    queryFn: () =>
      api<GamingPackageSummary[]>('/pricing/packages', { query: { stationId: session.stationId } }),
    staleTime: 30_000,
  });
  const body = packageId ? { packageId } : minutesValid ? { minutes: minutesValue } : null;
  const quote = useQuery({
    queryKey: ['sessions', 'quote', session.stationId, body],
    queryFn: () =>
      api<SessionQuoteResponse>('/sessions/quote', {
        method: 'POST',
        body: { stationId: session.stationId, billingMode: 'prepaid', ...body },
      }),
    enabled: body !== null && !useGift,
  });
  const { customer, setCustomer } = useSessionCustomer(session);
  const tender = useTender({ totalCents: quote.data?.priceCents ?? 0, customer });
  // End pay: the added time goes on the bill collected at the end — nothing is paid now.
  const endpay = session.billingMode === 'endpay';
  const ready = !!body && (useGift || (!!quote.data && (endpay || tender.covered)));
  const submit = () => {
    if (!ready || busy) return;
    if (useGift) {
      onConfirm({ ...body, reason: reason.trim() || undefined }, 'gift');
      return;
    }
    onConfirm({
      ...body,
      ...(endpay ? {} : { payments: tender.payments }),
      clientRequestId: requestId,
      ...(request ? { requestId: request.id } : {}),
    });
  };
  useEnterSubmits(submit);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('sessions.extendTitle')}
      description={
        request
          ? `${t('requests.bannerExtend', { customer: request.customerName, duration: requestDuration(request, t('requests.package')) })} — ${t('requests.approveExtendHint')}`
          : endpay
            ? t('sessions.extendEndPayBody')
            : t('sessions.extendBody')
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
            loading={busy}
            disabled={!ready}
            onClick={submit}
            data-testid="session-extend-confirm"
          >
            {useGift ? <Gift size={14} /> : <Plus size={14} />}{' '}
            {useGift ? t('sessions.giftConfirm') : t('sessions.extend')} <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="chips">
          {(packages.data ?? []).map((p) => (
            <button
              key={p.id}
              type="button"
              className="chip"
              aria-pressed={packageId === p.id}
              onClick={() => setPackageId(p.id)}
            >
              <strong>{p.name}</strong> · {p.durationMinutes} min · {fmt.money(p.priceCents)}
            </button>
          ))}
          {[15, 30, 60].map((m) => (
            <button
              key={m}
              type="button"
              className="chip"
              aria-pressed={packageId === null && minutes === String(m)}
              onClick={() => {
                setPackageId(null);
                setMinutes(String(m));
              }}
            >
              {m} min
            </button>
          ))}
        </div>
        <Field label={t('sessions.customMinutes')}>
          {(id) => (
            <Input
              id={id}
              type="number"
              min={1}
              max={1440}
              value={minutes}
              style={{ maxWidth: 160 }}
              onChange={(e) => {
                setPackageId(null);
                setMinutes(e.target.value);
              }}
            />
          )}
        </Field>
        {giftPossible && (
          <label
            className="row"
            style={{ gap: 8, alignItems: 'center', cursor: 'pointer' }}
            data-testid="session-gift-toggle"
          >
            <input type="checkbox" checked={gift} onChange={(e) => setGift(e.target.checked)} />
            <Gift size={14} />
            <strong>{t('sessions.giftMode')}</strong>
            <span className="faint" style={{ fontSize: 12 }}>
              {t('sessions.giftModeHint')}
            </span>
          </label>
        )}
        {useGift && (
          <Field label={t('sessions.giftReason')} hint={t('sessions.giftReasonHint')}>
            {(id) => (
              <Input
                id={id}
                value={reason}
                maxLength={200}
                placeholder={t('sessions.giftReasonPlaceholder')}
                onChange={(e) => setReason(e.target.value)}
                data-testid="session-gift-reason"
              />
            )}
          </Field>
        )}
        {!useGift && quote.data && (
          <>
            <div className="quote">
              <div className="quote__row">
                <span className="muted">{t('sessions.quote')}</span>
                <span className="num">
                  {quote.data.minutes} min
                  {quote.data.package && ` · ${quote.data.package.name}`}
                </span>
              </div>
              {endpay && (
                <>
                  <div className="quote__row">
                    <span className="muted">{t('sessions.addedToBill')}</span>
                    <span className="num">{fmt.money(quote.data.priceCents)}</span>
                  </div>
                  <div className="quote__row quote__row--total">
                    <span>{t('sessions.dueAtEnd')}</span>
                    <strong className="num" data-testid="session-extend-due">
                      {fmt.money(session.currentPriceCents + quote.data.priceCents)}
                    </strong>
                  </div>
                </>
              )}
            </div>
            {!endpay && (
              <TenderPanel
                tender={tender}
                onSubmit={submit}
                onCustomerChange={setCustomer}
                autoFocus={false}
                testId="session-extend"
              />
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

export function CancelSessionDialog({
  busy,
  onClose,
  onConfirm,
}: {
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={t('sessions.cancelTitle')}
      description={t('sessions.cancelBody')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={reason.trim().length < 2}
            onClick={() => onConfirm(reason.trim())}
          >
            <XCircle size={14} /> {t('sessions.cancel')}
          </Button>
        </>
      }
    >
      <Field label={t('sessions.cancelReason')}>
        {(id) => (
          <Input
            id={id}
            autoFocus
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </Field>
    </Dialog>
  );
}

export function notifyClientAck(
  result: SessionMutationResponse,
  toast: ReturnType<typeof useToast>,
  t: ReturnType<typeof useI18n>['t'],
) {
  if (result.client === null) {
    toast.toast('info', t('sessions.pcOffline'));
  } else if (!result.client.ok) {
    toast.error(t('sessions.pcNoAck', { error: result.client.error ?? '' }));
  }
}

/** Compact live timer used on the station grid cards. */
export function SessionCardTimer({
  station,
  fetchedAt,
}: {
  station: StationSummary;
  fetchedAt: number;
}) {
  const now = useNow();
  const fmt = useFormat();
  const live = station.activeSession;
  if (!live) {
    return (
      <div className="station__timer num faint">
        <Clock size={14} /> —:—:—
      </div>
    );
  }
  const { elapsed, remaining } = projectSession(
    {
      status: live.status,
      billableSeconds: live.elapsedSeconds,
      endsAt: live.endsAt,
      pausedAt: live.pausedAt,
    },
    fetchedAt,
    now,
  );
  const warn = remaining !== null && remaining <= 300;
  return (
    <div className="station__session">
      <div className="station__timer num" data-warn={warn || undefined}>
        {remaining !== null ? formatHms(remaining) : formatHms(elapsed)}
      </div>
      <div className="station__session-meta">
        <span>{live.customerName ?? ''}</span>
        <span className="num">{fmt.money(live.currentPriceCents)}</span>
      </div>
    </div>
  );
}
