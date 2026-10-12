/**
 * Customer session requests (0.9.0) — the Admin side.
 *
 * A customer signed in on a gaming PC asks for time (start) or more time (extend). The request
 * is pushed to every Admin (`request.changed`); the bell in the top bar counts the pending ones,
 * beeps once per new request and opens a panel with Approve / Reject. Approving navigates to the
 * PC (`/stations?focus=<station>&request=<id>`): the start / extend dialog opens pre-filled and
 * staff only pick the payment and press Enter — the PC unlocks when the session starts.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  BellOff,
  Check,
  Clock,
  Monitor,
  ShoppingBag,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  PERMISSIONS,
  formatMinutesShort,
  type SessionRequest,
  type SettingsMap,
  type StationOrder,
} from '@likapcs/shared';
import { ApiError, api } from '../../lib/api';
import {
  AcceptOrderDialog,
  RejectOrderDialog,
  orderItemsText,
  usePendingOrders,
} from '../orders/orders';
import { storage } from '../../lib/storage';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { useAuth } from '../../state/auth';
import { useToast } from '../../state/toast';
import { Badge, Button, Dialog, Field, Input, Kbd } from '../ui/primitives';

export const PENDING_REQUESTS_KEY = ['session-requests', 'pending'] as const;

/** Pending requests, refreshed by the `request.changed` live event (plus a slow safety poll). */
export function usePendingRequests(enabled = true) {
  return useQuery({
    queryKey: PENDING_REQUESTS_KEY,
    queryFn: () => api<SessionRequest[]>('/session-requests', { query: { status: 'pending' } }),
    enabled,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
}

/** "60 min" / "1 h 30 min" / "1 h 30 min · 1 orë (package)" — what the customer asked for. */
export function requestDuration(
  r: { durationMinutes: number; packageName: string | null },
  packageWord: string,
): string {
  const base = formatMinutesShort(r.durationMinutes);
  return r.packageName ? `${base} · ${r.packageName} (${packageWord})` : base;
}

export function approvePath(r: { stationId: string; id: string }): string {
  return `/stations?focus=${r.stationId}&request=${r.id}`;
}

// ─── Sound ─────────────────────────────────────────────────────────────────────
const SOUND_KEY = 'requestsSound';
export function soundEnabled(): boolean {
  return storage.get(SOUND_KEY) !== '0';
}
let audio: AudioContext | null = null;
/** Two short, soft beeps through Web Audio — no asset to ship, works offline. */
export function beep(): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    if (audio.state === 'suspended') void audio.resume();
    const t0 = audio.currentTime;
    for (const [offset, freq] of [
      [0, 880],
      [0.18, 1175],
    ] as const) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.16);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.18);
    }
  } catch {
    /* no audio device — the bell badge and the toast still show the request */
  }
}

// ─── Reject dialog ─────────────────────────────────────────────────────────────
export function RejectRequestDialog({
  request,
  onClose,
  onDone,
}: {
  request: SessionRequest;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const reasons = ['reserved', 'closing', 'debt', 'comeToDesk'] as const;
  const reject = useMutation({
    mutationFn: () =>
      api<SessionRequest>(`/session-requests/${request.id}/reject`, {
        method: 'POST',
        body: { reason: reason.trim() || undefined },
      }),
    onSuccess: () => {
      toast.success(t('requests.rejected'));
      void queryClient.invalidateQueries({ queryKey: ['session-requests'] });
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
      onDone?.();
      onClose();
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
      if (err instanceof ApiError && err.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ['session-requests'] });
        onClose();
      }
    },
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !reject.isPending) {
      e.preventDefault();
      reject.mutate();
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('requests.rejectTitle')}
      description={t('requests.rejectBody', {
        customer: request.customerName,
        station: request.stationCode,
        duration: requestDuration(request, t('requests.package')),
      })}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')} <Kbd>Esc</Kbd>
          </Button>
          <Button
            variant="danger"
            loading={reject.isPending}
            onClick={() => reject.mutate()}
            data-testid="request-reject-confirm"
          >
            <X size={15} /> {t('requests.reject')} <Kbd>Enter</Kbd>
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="chips">
          {reasons.map((key) => {
            const label = t(`requests.reasons.${key}`);
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
        <Field label={t('requests.reason')} optional>
          {(id) => (
            <Input
              id={id}
              autoFocus
              value={reason}
              maxLength={120}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={onKey}
              data-testid="request-reject-reason"
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

// ─── Bell + panel ───────────────────────────────────────────────────────────────
export function RequestsBell() {
  const { t } = useI18n();
  const fmt = useFormat();
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const canView = can(PERMISSIONS.STATIONS_VIEW);
  const canControl = can(PERMISSIONS.STATIONS_CONTROL);
  const pending = usePendingRequests(canView);
  const pendingOrders = usePendingOrders(canView);
  const publicSettings = useQuery({
    queryKey: ['settings', 'public'],
    queryFn: () => api<Partial<SettingsMap>>('/settings/public', { auth: false }),
    staleTime: 60_000,
  });
  const [open, setOpen] = useState(false);
  const [rejecting, setRejecting] = useState<SessionRequest | null>(null);
  const [orderAction, setOrderAction] = useState<{
    order: StationOrder;
    kind: 'accept' | 'reject';
  } | null>(null);
  const [sound, setSound] = useState(soundEnabled);
  const panelRef = useRef<HTMLDivElement>(null);
  const known = useRef<Set<string> | null>(null);
  const knownOrders = useRef<Set<string> | null>(null);
  const items = useMemo(() => pending.data ?? [], [pending.data]);
  const orders = useMemo(() => pendingOrders.data ?? [], [pendingOrders.data]);

  // New request → beep + toast (not for the ones already waiting when the app opened).
  useEffect(() => {
    if (!pending.data) return;
    const ids = new Set(pending.data.map((r) => r.id));
    if (known.current) {
      const fresh = pending.data.filter((r) => !known.current!.has(r.id));
      if (fresh.length) {
        if (soundEnabled()) beep();
        for (const r of fresh) {
          toast.toast(
            'info',
            t('requests.newTitle', { station: r.stationCode }),
            `${r.customerName} ${t(r.kind === 'extend' ? 'requests.wantsExtend' : 'requests.wantsStart', { duration: requestDuration(r, t('requests.package')) })}`,
          );
        }
      }
    }
    known.current = ids;
  }, [pending.data, t, toast]);
  // New order → beep + toast, same rule.
  useEffect(() => {
    if (!pendingOrders.data) return;
    const ids = new Set(pendingOrders.data.map((o) => o.id));
    if (knownOrders.current) {
      const fresh = pendingOrders.data.filter((o) => !knownOrders.current!.has(o.id));
      if (fresh.length) {
        if (soundEnabled()) beep();
        for (const o of fresh) {
          toast.toast(
            'info',
            t('orders.newTitle', { station: o.stationCode }),
            t('orders.newBody', {
              number: o.number,
              items: orderItemsText(o),
              total: fmt.money(o.totalCents),
            }),
          );
        }
      }
    }
    knownOrders.current = ids;
  }, [pendingOrders.data, t, toast, fmt]);

  // Click outside / Esc closes the panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!canView) return null;
  const count = items.length + orders.length;
  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    storage.set(SOUND_KEY, next ? '1' : '0');
    if (next) beep();
  };

  return (
    <div className="requests-bell" ref={panelRef}>
      <button
        type="button"
        className={`requests-bell__btn ${count ? 'requests-bell__btn--active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={t('requests.bell')}
        aria-expanded={open}
        title={count ? t('requests.waiting', { count }) : t('requests.bell')}
        data-testid="requests-bell"
        data-count={count}
      >
        {count ? <Bell size={16} /> : <BellOff size={16} className="muted" />}
        {count > 0 && <span className="requests-bell__count">{count}</span>}
      </button>
      {open && (
        <div className="requests-panel" role="dialog" aria-label={t('requests.title')}>
          <header className="requests-panel__head">
            <strong>{t('requests.title')}</strong>
            <span className="muted" style={{ fontSize: 12 }}>
              {count ? t('requests.waiting', { count }) : ''}
            </span>
            <span style={{ flex: 1 }} />
            <Button
              size="sm"
              variant="ghost"
              icon
              onClick={toggleSound}
              title={sound ? t('requests.soundOn') : t('requests.soundOff')}
              aria-label={t('requests.sound')}
              aria-pressed={sound}
              data-testid="requests-sound"
            >
              {sound ? <Volume2 size={15} /> : <VolumeX size={15} />}
            </Button>
          </header>
          {count === 0 ? (
            <div className="requests-panel__empty">
              <div>{t('requests.none')}</div>
              <div className="faint" style={{ fontSize: 12 }}>
                {t('requests.noneHint')}
              </div>
            </div>
          ) : (
            <ul className="requests-panel__list">
              {orders.map((o) => (
                <li key={o.id} className="request-row" data-testid="order-row" data-kind="order">
                  <div className="request-row__main">
                    <div className="request-row__title">
                      <strong>{t('orders.number', { number: o.number })}</strong>
                      <span className="muted"> · {orderItemsText(o)}</span>
                    </div>
                    <div className="request-row__meta">
                      <Badge tone="accent">
                        <Monitor size={11} /> {o.stationCode}
                      </Badge>
                      <strong className="num">{fmt.money(o.totalCents)}</strong>
                      <span className="muted">
                        <Clock size={11} />{' '}
                        {t('requests.since', { time: fmt.relative(o.requestedAt) })}
                      </span>
                      {o.customerName && <span className="muted">{o.customerName}</span>}
                      {o.note && (
                        <span className="muted" title={o.note}>
                          „{o.note}”
                        </span>
                      )}
                    </div>
                  </div>
                  {canControl ? (
                    <div className="request-row__actions">
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => setOrderAction({ order: o, kind: 'accept' })}
                        data-testid="order-accept"
                      >
                        <ShoppingBag size={14} /> {t('orders.accept')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setOrderAction({ order: o, kind: 'reject' })}
                        data-testid="order-reject"
                      >
                        <X size={14} /> {t('orders.reject')}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setOpen(false);
                        navigate(`/orders`);
                      }}
                    >
                      {t('nav.orders')}
                    </Button>
                  )}
                </li>
              ))}
              {items.map((r) => (
                <li key={r.id} className="request-row" data-testid="request-row" data-kind={r.kind}>
                  <div className="request-row__main">
                    <div className="request-row__title">
                      <strong>{r.customerName}</strong>
                      <span className="muted">
                        {' '}
                        {t(r.kind === 'extend' ? 'requests.wantsExtend' : 'requests.wantsStart', {
                          duration: requestDuration(r, t('requests.package')),
                        })}
                      </span>
                    </div>
                    <div className="request-row__meta">
                      <Badge tone={r.kind === 'extend' ? 'info' : 'warning'}>
                        <Monitor size={11} /> {r.stationCode}
                      </Badge>
                      <span className="muted">
                        <Clock size={11} />{' '}
                        {t('requests.since', { time: fmt.relative(r.requestedAt) })}
                      </span>
                      {r.customerBalanceDueCents > 0 && (
                        <Badge tone="danger">
                          {t('requests.owes', { amount: fmt.money(r.customerBalanceDueCents) })}
                        </Badge>
                      )}
                    </div>
                  </div>
                  {canControl ? (
                    <div className="request-row__actions">
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          setOpen(false);
                          navigate(approvePath(r));
                        }}
                        data-testid="request-approve"
                      >
                        <Check size={14} /> {t('requests.approve')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setRejecting(r)}
                        data-testid="request-reject"
                      >
                        <X size={14} /> {t('requests.reject')}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setOpen(false);
                        navigate(`/stations?focus=${r.stationId}`);
                      }}
                    >
                      {t('requests.openStation')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {rejecting && <RejectRequestDialog request={rejecting} onClose={() => setRejecting(null)} />}
      {orderAction?.kind === 'accept' && (
        <AcceptOrderDialog
          order={orderAction.order}
          defaultSettlement={publicSettings.data?.['orders.settlement'] ?? 'ask'}
          onClose={() => setOrderAction(null)}
        />
      )}
      {orderAction?.kind === 'reject' && (
        <RejectOrderDialog order={orderAction.order} onClose={() => setOrderAction(null)} />
      )}
    </div>
  );
}
