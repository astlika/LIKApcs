/**
 * Everything a cashier can do to the selected PC(s), as one list of actions that drives the big
 * action bar, the right-click menu and keyboard shortcuts. Each action is a server call; the PC
 * only mirrors the result (and acknowledges commands).
 *
 * With several PCs selected (marquee / Ctrl+click on the map) the stateless actions — start,
 * lock/unlock, message, restart, shutdown — are sent to every selected PC in parallel and the
 * outcome is summarised in one toast. Session actions that need a bill (end, extend, cancel,
 * pause/resume) stay single-PC: each one has its own amount and payment.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Clock,
  Info,
  Lock,
  LockOpen,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Power,
  RotateCcw,
  Square,
  Timer,
  XCircle,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  PERMISSIONS,
  wakeReadiness,
  type GamingPackageSummary,
  type CustomerSummary,
  type PaymentMethod,
  type SalePaymentInput,
  type SessionMutationResponse,
  type SessionQuoteResponse,
  type SessionSummary,
  type StationCommandRequest,
  type StationCommandResponse,
  type StationSummary,
  type StationWakeResponse,
  type WakeIssue,
} from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { liveSessionPrice, projectSession } from '../../lib/session-time';
import { summarizeBulk, type BulkOutcome as BulkOutcomeOf } from '../../lib/map-selection';
import { useFormat } from '../../lib/format';
import { usePaymentMethods } from '../../lib/payment-methods';
import { useI18n } from '../../i18n';
import { useAuth } from '../../state/auth';
import { useToast } from '../../state/toast';
import { isShiftRequired, useShiftGuard } from '../../state/shift-guard';
import { CustomerPicker } from '../customers/CustomerPicker';
import { TenderPanel, useTender } from '../payments/TenderPanel';
import { SessionPaidDialog, type SessionPaid } from '../sessions/SessionPaidDialog';
import {
  CancelSessionDialog,
  EndSessionDialog,
  ExtendSessionDialog,
  notifyClientAck,
  paidFrom,
  useNow,
} from '../sessions/SessionPanel';
import {
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  Kbd,
  Loading,
  Segmented,
} from '../ui/primitives';

export type StationActionId =
  | 'start'
  | 'end'
  | 'pause'
  | 'resume'
  | 'extend'
  | 'cancel'
  | 'lock'
  | 'unlock'
  | 'message'
  | 'restart'
  | 'shutdown'
  | 'wake'
  | 'details';

/** Offline PC with a MAC on record — the only kind a magic packet can help. */
export function isWakeable(s: StationSummary): boolean {
  return !!s.device && !s.device.online && !!wakeReadiness(s.device.hardware, s.device.lastIp).mac;
}

export interface StationAction {
  id: StationActionId;
  label: string;
  icon: LucideIcon;
  /** Shown in the main bar (others only in the context menu). */
  bar: boolean;
  enabled: boolean;
  tone?: 'primary' | 'danger' | 'warning';
  shortcut?: string;
  /** Why it is disabled (tooltip). */
  hint?: string;
}

type BulkOutcome = BulkOutcomeOf<StationSummary>;

type Flow =
  | { kind: 'start' }
  | { kind: 'end'; sessionId: string }
  | { kind: 'extend'; sessionId: string }
  | { kind: 'cancel'; sessionId: string }
  | { kind: 'message' }
  | { kind: 'power'; command: 'power.restart' | 'power.shutdown' }
  /** Money changed hands: change / receipt / Print / Finish, like the POS. */
  | { kind: 'paid'; paid: SessionPaid }
  | null;

export function useStationActions(
  station: StationSummary | null,
  onChanged: () => void,
  onDetails: (id: string) => void,
  /** Current multi-selection; when it holds more than one PC, bulk-capable actions target all. */
  targets: StationSummary[] = [],
): {
  actions: StationAction[];
  primary: StationActionId | null;
  run: (id: StationActionId) => void;
  busy: boolean;
  dialogs: ReactNode;
  /** True when actions apply to several PCs. */
  multi: boolean;
} {
  const { t } = useI18n();
  const { can } = useAuth();
  const fmt = useFormat();
  const toast = useToast();
  const shiftGuard = useShiftGuard();
  const queryClient = useQueryClient();
  const [flow, setFlow] = useState<Flow>(null);
  const canControl = can(PERMISSIONS.STATIONS_CONTROL);
  const canPower = can(PERMISSIONS.STATIONS_POWER);
  const group = useMemo<StationSummary[]>(
    () => (targets.length > 1 ? targets : station ? [station] : []),
    [targets, station],
  );
  const multi = group.length > 1;

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    onChanged();
  }, [queryClient, onChanged]);

  const sessionAct = useMutation({
    mutationFn: ({
      sessionId,
      action,
      body,
    }: {
      sessionId: string;
      action: string;
      body?: Record<string, unknown>;
    }) =>
      api<SessionMutationResponse>(`/sessions/${sessionId}/${action}`, {
        method: 'POST',
        body: body ?? {},
      }),
    onSuccess: (result, { action }) => {
      const messages: Record<string, string> = {
        pause: t('sessions.paused'),
        resume: t('sessions.resumed'),
        extend: t('sessions.extended'),
        end: result.session.awaitingPayment
          ? t('sessions.endedAwaiting', {
              total: fmt.money(result.session.finalPriceCents ?? result.session.currentPriceCents),
            })
          : t('sessions.ended', {
              total: fmt.money(result.session.finalPriceCents ?? result.session.currentPriceCents),
            }),
        cancel: t('sessions.cancelled'),
      };
      toast.success(messages[action] ?? t('common.saving'));
      notifyClientAck(result, toast, t);
      const paid = paidFrom(result);
      setFlow(paid ? { kind: 'paid', paid } : null);
      refresh();
    },
    onError: (err, variables) => {
      if (shiftGuard.handle(err, () => sessionAct.mutate(variables))) return;
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    },
  });
  const command = useMutation({
    mutationFn: ({ stationId, body }: { stationId: string; body: StationCommandRequest }) =>
      api<StationCommandResponse>(`/stations/${stationId}/command`, { method: 'POST', body }),
    onSuccess: (r) => {
      const labels: Record<string, string> = {
        lock: t('stations.commands.lock'),
        unlock: t('stations.commands.unlock'),
        'message.show': t('stations.commands.messageShow'),
        'power.restart': t('stations.commands.powerRestart'),
        'power.shutdown': t('stations.commands.powerShutdown'),
        'update.apply': t('stations.commands.updateApply'),
      };
      if (r.ok) toast.success(t('stations.commandOk', { command: labels[r.command] ?? r.command }));
      else toast.error(t('stations.commandFailed', { error: r.error ?? '' }));
      setFlow(null);
      onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  // Wake-on-LAN: the server sends the magic packet; one toast per outcome.
  const issueText = useCallback(
    (issues: WakeIssue[]) => issues.map((i) => t(`stations.wake.issue.${i}`)).join(', '),
    [t],
  );
  const wake = useMutation({
    mutationFn: (stationId: string) =>
      api<StationWakeResponse>(`/stations/${stationId}/wake`, { method: 'POST' }),
    onSuccess: (r) => {
      if (r.warnings.length === 0) toast.success(t('stations.wake.sent', { code: r.code }));
      else
        toast.toast(
          'warning',
          t('stations.wake.sentWarn', { code: r.code, issues: issueText(r.warnings) }),
        );
      onChanged();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  const wakeMany = useMutation({
    mutationFn: async (): Promise<BulkOutcome[]> =>
      Promise.all(
        group.filter(isWakeable).map(async (s): Promise<BulkOutcome> => {
          try {
            await api<StationWakeResponse>(`/stations/${s.id}/wake`, { method: 'POST' });
            return { station: s, ok: true };
          } catch (err) {
            return {
              station: s,
              ok: false,
              error: err instanceof ApiError ? err.message : String(err),
            };
          }
        }),
      ),
    onSuccess: (results) => {
      const sum = summarizeBulk(results);
      if (sum.failed === 0) toast.success(t('stations.wake.sentMany', { n: sum.ok }));
      else
        toast.error(
          t('stations.wake.sentManyPartial', {
            ok: sum.ok,
            skipped: sum.failed,
            codes: sum.failedCodes.join(', '),
          }),
        );
      onChanged();
    },
  });
  // Same command to every online PC of the selection, in parallel; one toast with the outcome.
  const commandMany = useMutation({
    mutationFn: async (body: StationCommandRequest): Promise<BulkOutcome[]> =>
      Promise.all(
        group
          .filter((s) => s.device?.online)
          .map(async (s): Promise<BulkOutcome> => {
            try {
              const r = await api<StationCommandResponse>(`/stations/${s.id}/command`, {
                method: 'POST',
                body,
              });
              return { station: s, ok: r.ok, error: r.error ?? undefined };
            } catch (err) {
              return {
                station: s,
                ok: false,
                error: err instanceof ApiError ? err.message : String(err),
              };
            }
          }),
      ),
    onSuccess: (results, body) => {
      const labels: Record<string, string> = {
        lock: t('stations.commands.lock'),
        unlock: t('stations.commands.unlock'),
        'message.show': t('stations.commands.messageShow'),
        'power.restart': t('stations.commands.powerRestart'),
        'power.shutdown': t('stations.commands.powerShutdown'),
      };
      const sum = summarizeBulk(results);
      const command = labels[body.command] ?? body.command;
      if (sum.failed === 0) toast.success(t('stations.bulkOk', { command, n: sum.ok }));
      else
        toast.error(
          t('stations.bulkPartial', {
            command,
            ok: sum.ok,
            failed: sum.failed,
            codes: sum.failedCodes.join(', '),
          }),
        );
      setFlow(null);
      onChanged();
    },
  });

  const live = station?.activeSession ?? null;
  const online = !!station?.device?.online;
  const enabled = !!station?.isEnabled;
  const unlockable =
    online && !live && (station?.status === 'available' || station?.status === 'locked');
  const wakeable = !!station && isWakeable(station);
  // Bulk eligibility: what the selection as a whole can do.
  const groupOnline = group.filter((s) => s.device?.online).length;
  const groupWakeable = group.filter(isWakeable).length;
  const groupStartable = group.filter((s) => s.isEnabled && !s.activeSession).length;
  const groupUnlockable =
    groupOnline > 0 &&
    group
      .filter((s) => s.device?.online)
      .every((s) => !s.activeSession && (s.status === 'available' || s.status === 'locked'));

  const actions = useMemo<StationAction[]>(() => {
    if (!station) return [];
    const offlineHint = t('stations.commandsOffline');
    if (multi) {
      // Several PCs: only the actions that make sense for all of them at once.
      const n = group.length;
      const noneOnline = groupOnline === 0;
      const singleOnly = t('map.singleOnly');
      const bulk: StationAction[] = [
        {
          id: 'start',
          label: `${t('map.start')} (${groupStartable})`,
          icon: Play,
          bar: true,
          enabled: canControl && groupStartable > 0,
          tone: 'primary',
          shortcut: 'Enter',
          hint: groupStartable === 0 ? t('map.noneStartable') : undefined,
        },
        {
          id: 'end',
          label: t('map.stop'),
          icon: Square,
          bar: true,
          enabled: false,
          hint: singleOnly,
        },
        {
          id: 'extend',
          label: t('map.addTime'),
          icon: Plus,
          bar: true,
          enabled: false,
          hint: singleOnly,
        },
        {
          id: groupUnlockable ? 'unlock' : 'lock',
          label: `${groupUnlockable ? t('stations.commands.unlock') : t('stations.commands.lock')} (${groupOnline})`,
          icon: groupUnlockable ? LockOpen : Lock,
          bar: true,
          enabled: canControl && !noneOnline,
          hint: noneOnline ? offlineHint : undefined,
        },
        {
          id: 'message',
          label: `${t('map.message')} (${groupOnline})`,
          icon: MessageSquare,
          bar: true,
          enabled: canControl && !noneOnline,
          hint: noneOnline ? offlineHint : undefined,
        },
        {
          id: 'restart',
          label: `${t('map.restart')} (${groupOnline})`,
          icon: RotateCcw,
          bar: true,
          enabled: canPower && !noneOnline,
          hint: noneOnline ? offlineHint : undefined,
        },
        {
          id: 'shutdown',
          label: `${t('map.shutdown')} (${groupOnline})`,
          icon: Power,
          bar: true,
          enabled: canPower && !noneOnline,
          hint: noneOnline ? offlineHint : undefined,
        },
        {
          id: 'wake',
          label: `${t('map.wake')} (${groupWakeable})`,
          icon: Zap,
          bar: groupWakeable > 0,
          enabled: canPower && groupWakeable > 0,
          hint: groupWakeable === 0 ? t('stations.wake.noMac') : undefined,
        },
        {
          id: 'details',
          label: t('common.details'),
          icon: Info,
          bar: true,
          enabled: false,
          hint: `${singleOnly} (${n})`,
        },
      ];
      return bulk;
    }
    const list: StationAction[] = [
      {
        id: 'start',
        label: t('map.start'),
        icon: Play,
        bar: !live,
        enabled: canControl && enabled && !live,
        tone: 'primary',
        shortcut: 'Enter',
      },
      {
        id: 'end',
        label: t('map.stop'),
        icon: Square,
        bar: !!live,
        enabled: canControl && !!live,
        tone: 'danger',
        shortcut: 'Enter',
      },
      {
        id: live?.status === 'paused' ? 'resume' : 'pause',
        label: live?.status === 'paused' ? t('sessions.resume') : t('sessions.pause'),
        icon: live?.status === 'paused' ? Play : Pause,
        bar: true,
        enabled: canControl && !!live,
        tone: 'warning',
      },
      {
        id: 'extend',
        label: t('map.addTime'),
        icon: Plus,
        bar: true,
        // Prepaid and end pay reserve time; open time (postpaid) runs until stopped.
        enabled: canControl && !!live && live.billingMode !== 'postpaid',
        hint: live && live.billingMode === 'postpaid' ? t('map.addTimePostpaid') : undefined,
      },
      {
        // An idle PC shows its lock screen; staff can open it for maintenance (time-limited grant
        // on the server). In maintenance or during a session the action locks the screen.
        id: unlockable ? 'unlock' : 'lock',
        label: unlockable ? t('stations.commands.unlock') : t('stations.commands.lock'),
        icon: unlockable ? LockOpen : Lock,
        bar: true,
        enabled: canControl && online,
        hint: online ? undefined : offlineHint,
      },
      {
        id: 'message',
        label: t('map.message'),
        icon: MessageSquare,
        bar: true,
        enabled: canControl && online,
        hint: online ? undefined : offlineHint,
      },
      {
        id: 'restart',
        label: t('map.restart'),
        icon: RotateCcw,
        bar: true,
        enabled: canPower && online,
        hint: online ? undefined : offlineHint,
      },
      {
        id: 'shutdown',
        label: t('map.shutdown'),
        icon: Power,
        bar: true,
        enabled: canPower && online,
        hint: online ? undefined : offlineHint,
      },
      {
        // Offline PC: the server can send a Wake-on-LAN magic packet (needs a MAC on record).
        id: 'wake',
        label: t('map.wake'),
        icon: Zap,
        bar: !online,
        enabled: canPower && wakeable,
        tone: wakeable ? 'primary' : undefined,
        hint: online
          ? t('stations.wake.alreadyOnline')
          : wakeable
            ? undefined
            : t('stations.wake.noMac'),
      },
      {
        id: 'cancel',
        label: t('sessions.cancel'),
        icon: XCircle,
        bar: false,
        // Nothing was taken for open time / end pay, so they can simply be voided.
        enabled: canControl && !!live && live.billingMode !== 'prepaid',
      },
      { id: 'details', label: t('common.details'), icon: Info, bar: true, enabled: true },
    ];
    return list;
  }, [
    station,
    live,
    online,
    enabled,
    unlockable,
    wakeable,
    canControl,
    canPower,
    t,
    multi,
    group.length,
    groupOnline,
    groupStartable,
    groupUnlockable,
    groupWakeable,
  ]);

  const primary: StationActionId | null = !station
    ? null
    : multi
      ? canControl && groupStartable > 0
        ? 'start'
        : null
      : live
        ? 'end'
        : canControl && enabled
          ? 'start'
          : 'details';

  const run = useCallback(
    (id: StationActionId) => {
      if (!station) return;
      const action = actions.find((a) => a.id === id);
      if (!action || !action.enabled) return;
      switch (id) {
        case 'start':
          setFlow({ kind: 'start' });
          break;
        case 'end':
          if (live) setFlow({ kind: 'end', sessionId: live.id });
          break;
        case 'extend':
          if (live) setFlow({ kind: 'extend', sessionId: live.id });
          break;
        case 'cancel':
          if (live) setFlow({ kind: 'cancel', sessionId: live.id });
          break;
        case 'pause':
        case 'resume':
          if (live) sessionAct.mutate({ sessionId: live.id, action: id });
          break;
        case 'lock':
        case 'unlock':
          if (multi) commandMany.mutate({ command: id });
          else command.mutate({ stationId: station.id, body: { command: id } });
          break;
        case 'message':
          setFlow({ kind: 'message' });
          break;
        case 'restart':
          setFlow({ kind: 'power', command: 'power.restart' });
          break;
        case 'shutdown':
          setFlow({ kind: 'power', command: 'power.shutdown' });
          break;
        case 'wake':
          if (multi) wakeMany.mutate();
          else wake.mutate(station.id);
          break;
        case 'details':
          onDetails(station.id);
          break;
      }
    },
    [station, actions, live, sessionAct, command, commandMany, wake, wakeMany, multi, onDetails],
  );

  const busy =
    sessionAct.isPending ||
    command.isPending ||
    commandMany.isPending ||
    wake.isPending ||
    wakeMany.isPending;
  const close = () => setFlow(null);
  const dialogs: ReactNode = station && flow && (
    <>
      {flow.kind === 'start' && (
        <QuickStartDialog
          station={station}
          others={multi ? group.filter((s) => s.id !== station.id) : []}
          onClose={close}
          onStarted={(result) => {
            const paid = result ? paidFrom(result) : null;
            setFlow(paid ? { kind: 'paid', paid } : null);
            refresh();
          }}
        />
      )}
      {flow.kind === 'paid' && <SessionPaidDialog paid={flow.paid} onFinish={close} />}
      {flow.kind === 'end' && (
        <SessionFlow sessionId={flow.sessionId} onClose={close}>
          {(s, elapsed, livePrice) => (
            <EndSessionDialog
              session={s}
              elapsedSeconds={elapsed}
              livePrice={livePrice}
              busy={sessionAct.isPending}
              onClose={close}
              onConfirm={(body) => sessionAct.mutate({ sessionId: s.id, action: 'end', body })}
            />
          )}
        </SessionFlow>
      )}
      {flow.kind === 'extend' && (
        <SessionFlow sessionId={flow.sessionId} onClose={close}>
          {(s) => (
            <ExtendSessionDialog
              session={s}
              busy={sessionAct.isPending}
              onClose={close}
              onConfirm={(body) => sessionAct.mutate({ sessionId: s.id, action: 'extend', body })}
            />
          )}
        </SessionFlow>
      )}
      {flow.kind === 'cancel' && (
        <CancelSessionDialog
          busy={sessionAct.isPending}
          onClose={close}
          onConfirm={(reason) =>
            sessionAct.mutate({ sessionId: flow.sessionId, action: 'cancel', body: { reason } })
          }
        />
      )}
      {flow.kind === 'message' && (
        <MessageDialog
          busy={command.isPending || commandMany.isPending}
          count={multi ? groupOnline : 1}
          onClose={close}
          onSend={(text) =>
            multi
              ? commandMany.mutate({ command: 'message.show', text, durationSeconds: 20 })
              : command.mutate({
                  stationId: station.id,
                  body: { command: 'message.show', text, durationSeconds: 20 },
                })
          }
        />
      )}
      {flow.kind === 'power' && (
        <ConfirmDialog
          open
          danger
          title={
            flow.command === 'power.restart'
              ? t('stations.commands.powerRestart')
              : t('stations.commands.powerShutdown')
          }
          body={
            multi
              ? t('stations.powerConfirmMany', {
                  n: groupOnline,
                  codes: group
                    .filter((s) => s.device?.online)
                    .map((s) => s.code)
                    .join(', '),
                })
              : t('stations.powerConfirm', { code: station.code })
          }
          confirmLabel={flow.command === 'power.restart' ? t('map.restart') : t('map.shutdown')}
          loading={command.isPending || commandMany.isPending}
          onClose={close}
          onConfirm={() =>
            multi
              ? commandMany.mutate({ command: flow.command })
              : command.mutate({ stationId: station.id, body: { command: flow.command } })
          }
        />
      )}
    </>
  );

  return { actions, primary, run, busy, dialogs, multi };
}

// ─── Load the full session for end/extend dialogs ──────────────────────────────
function SessionFlow({
  sessionId,
  onClose,
  children,
}: {
  sessionId: string;
  onClose: () => void;
  children: (session: SessionSummary, elapsedSeconds: number, livePrice: number) => ReactNode;
}) {
  const { t } = useI18n();
  const now = useNow();
  const session = useQuery({
    queryKey: ['sessions', sessionId],
    queryFn: () => api<SessionSummary>(`/sessions/${sessionId}`),
  });
  if (!session.data) {
    return (
      <Dialog open onClose={onClose} title={t('sessions.title')} size="sm">
        {session.isError ? <p className="text-danger">{t('common.errorGeneric')}</p> : <Loading />}
      </Dialog>
    );
  }
  const s = session.data;
  const { elapsed } = projectSession(s, session.dataUpdatedAt, now);
  const livePrice = liveSessionPrice(s, Math.floor(elapsed));
  return <>{children(s, Math.floor(elapsed), livePrice)}</>;
}

// ─── Quick start: one click on "open time" or a package ────────────────────────
const QUICK = [30, 60, 120];

export function QuickStartDialog({
  station,
  others = [],
  onClose,
  onStarted,
}: {
  station: StationSummary;
  /** Further PCs that get the same choice (multi-selection); each is billed by its own rule. */
  others?: StationSummary[];
  onClose: () => void;
  /** The single start's result (to show the "paid" dialog); undefined for bulk starts. */
  onStarted: (result?: SessionMutationResponse) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const shiftGuard = useShiftGuard();
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const { cardEnabled } = usePaymentMethods();
  const [customerName, setCustomerName] = useState('');
  const [customer, setCustomer] = useState<CustomerSummary | null>(null);
  const [custom, setCustom] = useState('');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  // Single PC, prepaid: the tile picks the time, then the tender step takes the money (cash with
  // change, card, pay later) — the same panel as the POS. Bulk starts and open time skip it.
  const [pending, setPending] = useState<{
    body: Record<string, unknown>;
    label: string;
    totalCents: number;
  } | null>(null);
  // Only PCs that can actually take a session; the server is still the judge.
  const startTargets = useMemo(
    () => [station, ...others].filter((s) => s.isEnabled && !s.activeSession),
    [station, others],
  );
  const bulk = others.length > 0;

  const packages = useQuery({
    queryKey: ['pricing', 'packages', 'available', station.id],
    queryFn: () =>
      api<GamingPackageSummary[]>('/pricing/packages', { query: { stationId: station.id } }),
    staleTime: 30_000,
  });
  const quotes = useQueries({
    queries: [
      { stationId: station.id, billingMode: 'postpaid' as const },
      ...QUICK.map((minutes) => ({
        stationId: station.id,
        billingMode: 'prepaid' as const,
        minutes,
      })),
    ].map((body) => ({
      queryKey: ['sessions', 'quote', body],
      queryFn: () => api<SessionQuoteResponse>('/sessions/quote', { method: 'POST', body }),
      staleTime: 15_000,
    })),
  });
  const openQuote = quotes[0]?.data;
  const customMinutes = Number.parseInt(custom, 10);
  const customValid = Number.isInteger(customMinutes) && customMinutes > 0 && customMinutes <= 1440;
  const customQuote = useQuery({
    queryKey: [
      'sessions',
      'quote',
      { stationId: station.id, billingMode: 'prepaid', minutes: customMinutes },
    ],
    queryFn: () =>
      api<SessionQuoteResponse>('/sessions/quote', {
        method: 'POST',
        body: { stationId: station.id, billingMode: 'prepaid', minutes: customMinutes },
      }),
    enabled: customValid,
  });

  const startOne = (target: StationSummary, body: Record<string, unknown>) =>
    api<SessionMutationResponse>('/sessions', {
      method: 'POST',
      body: {
        stationId: target.id,
        paymentMethod: method,
        ...body,
        customerId: customer?.id,
        customerName: customer ? undefined : customerName.trim() || undefined,
        // One idempotency key per PC so a retry never double-starts any of them.
        clientRequestId: bulk ? `${requestId}:${target.number}` : requestId,
      },
    });
  const start = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      if (!bulk) return { single: await startOne(station, body), outcomes: [] as BulkOutcome[] };
      const outcomes = await Promise.all(
        startTargets.map(async (s): Promise<BulkOutcome> => {
          try {
            await startOne(s, body);
            return { station: s, ok: true };
          } catch (err) {
            // A missing cash shift stops the whole batch: onError offers to open one and retries.
            if (isShiftRequired(err)) throw err;
            return {
              station: s,
              ok: false,
              error: err instanceof ApiError ? err.message : String(err),
            };
          }
        }),
      );
      return { single: null, outcomes };
    },
    onSuccess: ({ single, outcomes }) => {
      if (single) {
        toast.success(t('sessions.started', { code: station.code }));
        notifyClientAck(single, toast, t);
        onStarted(single);
        return;
      }
      const sum = summarizeBulk(outcomes);
      if (sum.failed === 0) toast.success(t('map.startedMany', { n: sum.ok }));
      else
        toast.error(
          t('map.startedPartial', {
            ok: sum.ok,
            failed: sum.failed,
            codes: sum.failedCodes.join(', '),
          }),
        );
      setRequestId(crypto.randomUUID());
      if (sum.ok > 0) onStarted();
    },
    onError: (err, body) => {
      setRequestId(crypto.randomUUID());
      if (shiftGuard.handle(err, () => start.mutate(body))) return;
      toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric'));
    },
  });
  const noPricing = openQuote && !openQuote.rule;
  /** A tile was chosen: start now (bulk / open time / free) or take the money first. */
  const choose = (body: Record<string, unknown>, label: string, totalCents: number) => {
    if (bulk || totalCents <= 0) start.mutate(body);
    else setPending({ body, label, totalCents });
  };

  if (pending) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={t('map.startTitle', { code: station.code })}
        description={pending.label}
        size="md"
      >
        <QuickStartTender
          totalCents={pending.totalCents}
          customer={customer}
          onCustomerChange={setCustomer}
          busy={start.isPending}
          onBack={() => setPending(null)}
          onStart={(payments, endPay) =>
            start.mutate(
              endPay ? { ...pending.body, billingMode: 'endpay' } : { ...pending.body, payments },
            )
          }
        />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        bulk
          ? t('map.startManyTitle', { n: startTargets.length })
          : t('map.startTitle', { code: station.code })
      }
      size="md"
    >
      <div className="stack">
        {bulk && (
          <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
            <strong>{startTargets.map((s) => s.code).join(', ')}</strong>
            {' · '}
            {t('map.startManyHint', { code: station.code })}
          </p>
        )}
        <div className="row row--between row--wrap" style={{ gap: 10 }}>
          {bulk && cardEnabled && (
            <Segmented
              value={method}
              onChange={setMethod}
              options={[
                { value: 'cash', label: t('sessions.methods.cash') },
                { value: 'card', label: t('sessions.methods.card') },
              ]}
              ariaLabel={t('sessions.paymentMethod')}
            />
          )}
          <CustomerPicker
            value={customer}
            onChange={setCustomer}
            text={customerName}
            onTextChange={setCustomerName}
            allowFreeText
            placeholder={t('map.customerPlaceholder')}
            style={{ maxWidth: 260 }}
          />
        </div>
        {noPricing && <p className="text-danger">{t('sessions.noRule')}</p>}
        <div className="start-grid">
          <button
            type="button"
            className="start-tile start-tile--open"
            disabled={start.isPending || !openQuote?.rule}
            onClick={() => start.mutate({ billingMode: 'postpaid' })}
            data-testid="quick-start-open"
          >
            <Clock size={22} />
            <span className="start-tile__title">{t('map.openTime')}</span>
            <span className="start-tile__sub">
              {openQuote?.rule
                ? `${fmt.money(openQuote.rule.rateCentsPerHour)}${t('sessions.perHour')}`
                : '—'}
            </span>
          </button>
          {(packages.data ?? []).map((p) => (
            <button
              key={p.id}
              type="button"
              className="start-tile"
              disabled={start.isPending}
              onClick={() =>
                choose(
                  { billingMode: 'prepaid', packageId: p.id },
                  `${p.name} · ${p.durationMinutes} min`,
                  p.priceCents,
                )
              }
              data-testid="quick-start-package"
            >
              <Timer size={22} />
              <span className="start-tile__title">{p.name}</span>
              <span className="start-tile__sub">
                {p.durationMinutes} min · <strong>{fmt.money(p.priceCents)}</strong>
              </span>
            </button>
          ))}
          {QUICK.map((minutes, i) => {
            const q = quotes[i + 1]?.data;
            return (
              <button
                key={minutes}
                type="button"
                className="start-tile"
                disabled={start.isPending || !q?.rule}
                onClick={() =>
                  choose({ billingMode: 'prepaid', minutes }, `${minutes} min`, q?.priceCents ?? 0)
                }
                data-testid="quick-start-minutes"
              >
                <Timer size={22} />
                <span className="start-tile__title">
                  {minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`}
                </span>
                <span className="start-tile__sub">
                  {q ? <strong>{fmt.money(q.priceCents)}</strong> : '…'}
                </span>
              </button>
            );
          })}
        </div>
        <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <Field label={t('sessions.customMinutes')} className="grow">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={1440}
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customValid && customQuote.data?.rule)
                    choose(
                      { billingMode: 'prepaid', minutes: customMinutes },
                      `${customMinutes} min`,
                      customQuote.data.priceCents,
                    );
                }}
              />
            )}
          </Field>
          <Button
            variant="primary"
            disabled={!customValid || !customQuote.data?.rule}
            loading={start.isPending}
            onClick={() =>
              customQuote.data &&
              choose(
                { billingMode: 'prepaid', minutes: customMinutes },
                `${customMinutes} min`,
                customQuote.data.priceCents,
              )
            }
          >
            <Play size={14} /> {t('map.start')}
            {customValid && customQuote.data ? ` · ${fmt.money(customQuote.data.priceCents)}` : ''}
          </Button>
        </div>
        {!station.device?.online && (
          <p className="muted" style={{ fontSize: 12.5 }}>
            {t('sessions.pcOffline')}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** Second step of the quick start: the shared tender panel for the chosen time. */
function QuickStartTender({
  totalCents,
  customer,
  onCustomerChange,
  busy,
  onBack,
  onStart,
}: {
  totalCents: number;
  customer: CustomerSummary | null;
  onCustomerChange: (customer: CustomerSummary | null) => void;
  busy: boolean;
  onBack: () => void;
  /** `endPay`: nothing paid now — start the session as end pay instead of prepaid. */
  onStart: (payments: SalePaymentInput[], endPay: boolean) => void;
}) {
  const { t } = useI18n();
  const tender = useTender({ totalCents, customer, allowEndPay: true });
  const submit = () => {
    if (tender.covered && !busy) onStart(tender.endPay ? [] : tender.payments, tender.endPay);
  };
  return (
    <div className="stack">
      <TenderPanel
        tender={tender}
        onSubmit={submit}
        onCustomerChange={onCustomerChange}
        testId="quick-start"
      />
      <div className="row row--between" style={{ marginTop: 4 }}>
        <Button onClick={onBack}>
          <ArrowLeft size={14} /> {t('common.back')}
        </Button>
        <Button
          variant="primary"
          size="lg"
          disabled={!tender.covered}
          loading={busy}
          onClick={submit}
          data-testid="quick-start-submit"
        >
          <Play size={14} />{' '}
          {tender.endPay
            ? t('map.startEndPay')
            : tender.mode === 'credit' && tender.creditCents > 0
              ? t('pos.completeOnTab')
              : t('map.start')}{' '}
          <Kbd>Enter</Kbd>
        </Button>
      </div>
    </div>
  );
}

function MessageDialog({
  busy,
  count,
  onClose,
  onSend,
}: {
  busy: boolean;
  /** Number of PCs the message goes to (title shows it when > 1). */
  count: number;
  onClose: () => void;
  onSend: (text: string) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const presets = [t('map.presetClosing'), t('map.presetCome'), t('map.presetQuiet')];
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={
        count > 1
          ? `${t('stations.commands.messageShow')} · ${t('map.nPcs', { n: count })}`
          : t('stations.commands.messageShow')
      }
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!text.trim()}
            onClick={() => onSend(text.trim())}
          >
            {t('stations.sendMessage')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="chips">
          {presets.map((p) => (
            <button key={p} type="button" className="chip" onClick={() => setText(p)}>
              {p}
            </button>
          ))}
        </div>
        <Field label={t('stations.messageText')}>
          {(id) => (
            <Input
              id={id}
              autoFocus
              maxLength={300}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('stations.messagePlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && text.trim()) onSend(text.trim());
              }}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
