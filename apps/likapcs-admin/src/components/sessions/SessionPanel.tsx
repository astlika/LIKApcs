/**
 * Session controls for one station: start (prepaid with a live quote, or postpaid), pause, resume,
 * extend, end (with payment method and optional discount) and cancel. All amounts and timers are
 * authoritative on the server; this panel only mirrors them and ticks locally between refreshes.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Pause, Play, Plus, Square, XCircle } from 'lucide-react';
import {
  PAYMENT_METHODS,
  PERMISSIONS,
  parseMoneyInput,
  priceForSeconds,
  type GamingPackageSummary,
  type PaymentMethod,
  type SessionMutationResponse,
  type SessionQuoteResponse,
  type SessionSummary,
  type StationSummary,
} from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { formatHms, projectSession } from '../../lib/session-time';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { useAuth } from '../../state/auth';
import { useToast } from '../../state/toast';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Field,
  Input,
  Loading,
  Segmented,
  Select,
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

export function SessionPanel({
  station,
  onChanged,
}: {
  station: StationSummary;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const { can } = useAuth();
  const live = station.activeSession;
  if (!can(PERMISSIONS.STATIONS_CONTROL) && !live) {
    return <p className="muted">{t('sessions.noSession')}</p>;
  }
  return live ? (
    <ActiveSession sessionId={live.id} station={station} onChanged={onChanged} />
  ) : (
    <StartSessionForm station={station} onChanged={onChanged} />
  );
}

// ─── Start ─────────────────────────────────────────────────────────────────────
function StartSessionForm({
  station,
  onChanged,
}: {
  station: StationSummary;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const [mode, setMode] = useState<'prepaid' | 'postpaid'>('prepaid');
  const [packageId, setPackageId] = useState<string | null>(null);
  const [minutes, setMinutes] = useState('60');
  const [customerName, setCustomerName] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [notes, setNotes] = useState('');
  // One request id per form instance: a retried click can never start two sessions.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

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

  const start = useMutation({
    mutationFn: () =>
      api<SessionMutationResponse>('/sessions', {
        method: 'POST',
        body: {
          ...quoteBody,
          customerName: customerName.trim() || undefined,
          paymentMethod: method,
          notes: notes.trim() || undefined,
          clientRequestId: requestId,
        },
      }),
    onSuccess: (result) => {
      toast.success(t('sessions.started', { code: station.code }));
      notifyClientAck(result, toast, t);
      setRequestId(crypto.randomUUID());
      setCustomerName('');
      setNotes('');
      onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  const noRule = quote.data && !quote.data.rule && (mode === 'postpaid' || !packageId);
  const endsAt =
    quote.data?.minutes != null ? new Date(Date.now() + quote.data.minutes * 60_000) : null;

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

      {mode === 'prepaid' && (
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
            <Input
              id={id}
              value={customerName}
              placeholder={t('sessions.customerOptional')}
              maxLength={120}
              onChange={(e) => setCustomerName(e.target.value)}
            />
          )}
        </Field>
        {mode === 'prepaid' && (
          <Field label={t('sessions.paymentMethod')}>
            {(id) => (
              <Select
                id={id}
                value={method}
                onChange={(e) => setMethod(e.target.value as PaymentMethod)}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t(`sessions.methods.${m}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
      <Field label={t('sessions.notes')} optional>
        {(id) => (
          <Textarea
            id={id}
            rows={2}
            value={notes}
            maxLength={500}
            onChange={(e) => setNotes(e.target.value)}
          />
        )}
      </Field>

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
          <div className="quote__row quote__row--total">
            <span>{mode === 'prepaid' ? t('sessions.quote') : t('sessions.quoteRate')}</span>
            <strong className="num">
              {mode === 'prepaid'
                ? fmt.money(quote.data.priceCents)
                : `${fmt.money(quote.data.terms.rateCentsPerHour)}${t('sessions.perHour')}`}
            </strong>
          </div>
        </div>
      )}

      {!station.device?.online && <Alert tone="warning">{t('sessions.offlineWarning')}</Alert>}
      <Button
        variant="primary"
        size="lg"
        disabled={!quoteBody || !quote.data || !station.isEnabled}
        loading={start.isPending}
        onClick={() => start.mutate()}
      >
        <Play size={16} /> {t('sessions.start')}
      </Button>
    </div>
  );
}

// ─── Active session ────────────────────────────────────────────────────────────
function ActiveSession({
  sessionId,
  station,
  onChanged,
}: {
  sessionId: string;
  station: StationSummary;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const { can } = useAuth();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  const now = useNow();
  const [dialog, setDialog] = useState<'end' | 'extend' | 'cancel' | null>(null);
  const canControl = can(PERMISSIONS.STATIONS_CONTROL);

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
        pause: t('sessions.paused'),
        resume: t('sessions.resumed'),
        extend: t('sessions.extended'),
        end: t('sessions.ended', {
          total: fmt.money(result.session.finalPriceCents ?? result.session.currentPriceCents),
        }),
        cancel: t('sessions.cancelled'),
      };
      toast.success(messages[action] ?? t('pricing.saved'));
      notifyClientAck(result, toast, t);
      setDialog(null);
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  if (session.isLoading || !session.data) return <Loading />;
  const s = session.data;
  const { elapsed, remaining } = projectSession(s, session.dataUpdatedAt, now);
  const livePrice =
    s.billingMode === 'postpaid'
      ? priceForSeconds(Math.floor(elapsed), s.terms)
      : s.currentPriceCents;
  const expiringSoon = remaining !== null && remaining <= 300;

  return (
    <div className="stack">
      <div className="row row--between">
        <div className="row" style={{ gap: 8 }}>
          <Badge tone={s.status === 'paused' ? 'warning' : 'accent'} dot>
            {t(`sessions.status.${s.status}`)}
          </Badge>
          <Badge tone="default">
            {s.billingMode === 'prepaid' ? t('sessions.prepaidShort') : t('sessions.postpaidShort')}
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
            {s.billingMode === 'prepaid' ? t('sessions.paid') : t('sessions.currentPrice')}
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
          {s.billingMode === 'prepaid' && (
            <Button onClick={() => setDialog('extend')}>
              <Plus size={14} /> {t('sessions.extend')}
            </Button>
          )}
          <Button variant="primary" onClick={() => setDialog('end')}>
            <Square size={14} /> {t('sessions.end')}
          </Button>
          {s.billingMode === 'postpaid' && (
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
          session={s}
          busy={act.isPending}
          onClose={() => setDialog(null)}
          onConfirm={(body) => act.mutate({ action: 'extend', body })}
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

function EndSessionDialog({
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
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [discount, setDiscount] = useState('');
  const postpaid = session.billingMode === 'postpaid';
  const discountCents = discount.trim() ? parseMoneyInput(discount) : 0;
  const discountInvalid = discountCents === null || discountCents < 0 || discountCents > livePrice;
  const total = postpaid ? Math.max(0, livePrice - (discountCents ?? 0)) : 0;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('sessions.endTitle')}
      description={t('sessions.endBody')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={postpaid && discountInvalid}
            onClick={() =>
              onConfirm(
                postpaid ? { discountCents: discountCents ?? 0, paymentMethod: method } : {},
              )
            }
          >
            <Square size={14} /> {t('sessions.end')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="quote">
          <div className="quote__row">
            <span className="muted">{t('sessions.billable')}</span>
            <span className="num">{formatHms(elapsedSeconds)}</span>
          </div>
          {postpaid && (
            <div className="quote__row">
              <span className="muted">{t('sessions.currentPrice')}</span>
              <span className="num">{fmt.money(livePrice)}</span>
            </div>
          )}
          <div className="quote__row quote__row--total">
            <span>{postpaid ? t('sessions.total') : t('sessions.paid')}</span>
            <strong className="num">
              {fmt.money(postpaid ? total : session.currentPriceCents)}
            </strong>
          </div>
        </div>
        {postpaid && (
          <div className="grid grid--2">
            <Field label={t('sessions.paymentMethod')}>
              {(id) => (
                <Select
                  id={id}
                  value={method}
                  onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t(`sessions.methods.${m}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {can(PERMISSIONS.POS_DISCOUNT) && (
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
                    onChange={(e) => setDiscount(e.target.value)}
                  />
                )}
              </Field>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function ExtendSessionDialog({
  session,
  busy,
  onClose,
  onConfirm,
}: {
  session: SessionSummary;
  busy: boolean;
  onClose: () => void;
  onConfirm: (body: Record<string, unknown>) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const [packageId, setPackageId] = useState<string | null>(null);
  const [minutes, setMinutes] = useState('30');
  const [method, setMethod] = useState<PaymentMethod>('cash');
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
    enabled: body !== null,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('sessions.extendTitle')}
      description={t('sessions.extendBody')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!body || !quote.data}
            onClick={() =>
              onConfirm({ ...body, paymentMethod: method, clientRequestId: requestId })
            }
          >
            <Plus size={14} /> {t('sessions.extend')}
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
        <div className="grid grid--2">
          <Field label={t('sessions.customMinutes')}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={1440}
                value={minutes}
                onChange={(e) => {
                  setPackageId(null);
                  setMinutes(e.target.value);
                }}
              />
            )}
          </Field>
          <Field label={t('sessions.paymentMethod')}>
            {(id) => (
              <Select
                id={id}
                value={method}
                onChange={(e) => setMethod(e.target.value as PaymentMethod)}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t(`sessions.methods.${m}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {quote.data && (
          <div className="quote">
            <div className="quote__row quote__row--total">
              <span>
                {t('sessions.quote')} · {quote.data.minutes} min
              </span>
              <strong className="num">{fmt.money(quote.data.priceCents)}</strong>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function CancelSessionDialog({
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

function notifyClientAck(
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
