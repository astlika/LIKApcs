/**
 * 0.32.0 — PC reservations. The desk books PCs for a time (the customer picks the PCs and the hour),
 * sees how many PCs are booked for each hour, changes a booking's tolerance and cancels it. The
 * default tolerance (minutes a customer may be late) is a house setting.
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Clock, Trash2 } from 'lucide-react';
import type { CustomerSummary, ReservationSummary, StationSummary } from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { groupByStart } from '../../lib/station-board';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { useToast } from '../../state/toast';
import { Button, ConfirmDialog, Dialog, Field, Input, Alert } from '../ui/primitives';
import { CustomerPicker } from '../customers/CustomerPicker';


/** Field wants a render function for the input id; the dialog's inputs do not need it. */
function Labeled({
  label,
  hint,
  optional,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <Field label={label} hint={hint} optional={optional}>
      {() => children}
    </Field>
  );
}

const TOLERANCE_KEY = 'reservations.tolerance_minutes';

/** The next five-minute mark, as the form's default: date and time in the browser's local zone. */
function defaultSlot(): { date: string; time: string } {
  const d = new Date(Date.now() + 5 * 60_000);
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

export function ReservationsDialog({
  open,
  onClose,
  stations,
  initialStationIds,
  canControl,
  canSettings,
}: {
  open: boolean;
  onClose: () => void;
  stations: StationSummary[];
  /** The PCs selected on the board when the dialog opens. */
  initialStationIds: string[];
  canControl: boolean;
  canSettings: boolean;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ['reservations'],
    queryFn: () => api<{ items: ReservationSummary[] }>('/reservations'),
    enabled: open,
    refetchInterval: open ? 15_000 : false,
  });
  const settings = useQuery({
    queryKey: ['settings', 'reservations'],
    queryFn: () => api<Record<string, unknown>>('/settings'),
    enabled: open && canSettings,
  });
  const defaultTolerance = Number(settings.data?.[TOLERANCE_KEY] ?? 5);

  const [tolerance, setTolerance] = useState<string>('');
  useEffect(() => {
    if (settings.data) setTolerance(String(defaultTolerance));
  }, [settings.data, defaultTolerance]);

  const saveTolerance = useMutation({
    mutationFn: (minutes: number) =>
      api('/settings', { method: 'PATCH', body: { [TOLERANCE_KEY]: minutes } }),
    onSuccess: () => {
      toast.success(t('reservations.toleranceSaved'));
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  // ─── New booking ─────────────────────────────────────────────
  const slot = useMemo(defaultSlot, [open]);
  const [date, setDate] = useState(slot.date);
  const [time, setTime] = useState(slot.time);
  const [picked, setPicked] = useState<string[]>(initialStationIds);
  const [customer, setCustomer] = useState<CustomerSummary | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [ownTolerance, setOwnTolerance] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setPicked(initialStationIds);
      const fresh = defaultSlot();
      setDate(fresh.date);
      setTime(fresh.time);
      setFormError(null);
    }
  }, [open, initialStationIds]);

  const enabledStations = useMemo(
    () => stations.filter((s) => s.isEnabled && !s.archived).sort((a, b) => a.number - b.number),
    [stations],
  );

  const create = useMutation({
    mutationFn: async (e: FormEvent) => {
      e.preventDefault();
      const customerName = customer?.name ?? name.trim();
      if (picked.length === 0) throw new Error(t('reservations.pickPcs'));
      if (!customerName) throw new Error(t('reservations.pickName'));
      const startsAt = new Date(`${date}T${time}:00`);
      if (Number.isNaN(startsAt.getTime())) throw new Error(t('reservations.pickTime'));
      const toleranceMinutes = ownTolerance.trim() ? Number(ownTolerance) : undefined;
      return api<ReservationSummary>('/reservations', {
        method: 'POST',
        body: {
          stationIds: picked,
          startsAt: startsAt.toISOString(),
          customerId: customer?.id,
          customerName,
          phone: phone.trim() || undefined,
          notes: notes.trim() || undefined,
          toleranceMinutes,
        },
      });
    },
    onSuccess: (created) => {
      toast.success(
        t('reservations.created', {
          n: created.stations.length,
          time: fmt.time(created.startsAt),
        }),
      );
      setName('');
      setCustomer(null);
      setPhone('');
      setNotes('');
      setOwnTolerance('');
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'reservation_overlap') {
        setFormError(t('reservations.overlap'));
      } else {
        setFormError(err instanceof Error ? err.message : t('common.errorGeneric'));
      }
    },
  });

  // ─── Changes to a booking ───────────────────────────────────
  const [cancelling, setCancelling] = useState<ReservationSummary | null>(null);
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/reservations/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      toast.success(t('reservations.cancelled'));
      setCancelling(null);
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });
  const changeTolerance = useMutation({
    mutationFn: ({ id, minutes }: { id: string; minutes: number }) =>
      api(`/reservations/${id}`, { method: 'PATCH', body: { toleranceMinutes: minutes } }),
    onSuccess: () => {
      toast.success(t('reservations.toleranceChanged'));
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  const items = list.data?.items ?? [];
  const groups = useMemo(() => groupByStart(items, fmt.timeZone), [items, fmt.timeZone]);
  const toggle = (id: string) =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <>
      <Dialog open={open} onClose={onClose} title={t('reservations.title')} size="lg">
        <div className="res">
          {canSettings && (
            <div className="res__tolerance">
              <Labeled label={t('reservations.defaultTolerance')} hint={t('reservations.defaultToleranceHint')}>
                <div className="res__row">
                  <Input
                    type="number"
                    min={1}
                    max={60}
                    value={tolerance}
                    onChange={(e) => setTolerance(e.target.value)}
                    aria-label={t('reservations.defaultTolerance')}
                    style={{ width: 90 }}
                  />
                  <Button
                    size="sm"
                    onClick={() => saveTolerance.mutate(Number(tolerance))}
                    loading={saveTolerance.isPending}
                    disabled={!Number.isInteger(Number(tolerance)) || Number(tolerance) < 1 || Number(tolerance) > 60}
                  >
                    {t('common.save')}
                  </Button>
                </div>
              </Labeled>
            </div>
          )}

          {canControl && (
            <form className="res__form" onSubmit={(e) => create.mutate(e)}>
              <h3 className="res__h">{t('reservations.newTitle')}</h3>
              <div className="res__pcs" role="group" aria-label={t('reservations.pcs')}>
                {enabledStations.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="res__pc"
                    data-picked={picked.includes(s.id) || undefined}
                    aria-pressed={picked.includes(s.id)}
                    onClick={() => toggle(s.id)}
                  >
                    {picked.includes(s.id) && <Check size={12} />} {s.code}
                  </button>
                ))}
              </div>
              <div className="res__grid">
                <Labeled label={t('reservations.date')}>
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </Labeled>
                <Labeled label={t('reservations.time')}>
                  <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
                </Labeled>
                <Labeled label={t('reservations.customer')}>
                  <CustomerPicker
                    value={customer}
                    onChange={(c) => {
                      setCustomer(c);
                      if (c) setName(c.name);
                    }}
                    text={name}
                    onTextChange={setName}
                    allowFreeText
                    placeholder={t('reservations.customerPlaceholder')}
                  />
                </Labeled>
                <Labeled label={t('reservations.phone')} optional>
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} />
                </Labeled>
                <Labeled label={t('reservations.ownTolerance')} optional hint={t('reservations.ownToleranceHint')}>
                  <Input
                    type="number"
                    min={1}
                    max={60}
                    value={ownTolerance}
                    onChange={(e) => setOwnTolerance(e.target.value)}
                  />
                </Labeled>
                <Labeled label={t('reservations.notes')} optional>
                  <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
                </Labeled>
              </div>
              {formError && <Alert tone="danger">{formError}</Alert>}
              <div className="res__actions">
                <span className="faint">{t('reservations.pickedCount', { n: picked.length })}</span>
                <Button type="submit" variant="primary" loading={create.isPending}>
                  {t('reservations.book')}
                </Button>
              </div>
            </form>
          )}

          <div className="res__list" aria-live="polite">
            <h3 className="res__h">{t('reservations.upcoming')}</h3>
            {list.isLoading && <p className="muted">{t('common.loading')}</p>}
            {!list.isLoading && groups.length === 0 && (
              <p className="muted">{t('reservations.none')}</p>
            )}
            {groups.map((g) => {
              const pcs = g.items.reduce((n, r) => n + r.stations.length, 0);
              return (
                <section key={g.key} className="res__group">
                  <header className="res__group-head">
                    <Clock size={14} aria-hidden />
                    <strong className="num">{fmt.time(g.startsAt)}</strong>
                    <span className="faint">{t('reservations.pcsForTime', { n: pcs })}</span>
                  </header>
                  {g.items.map((r) => (
                    <ReservationRow
                      key={r.id}
                      r={r}
                      canControl={canControl}
                      onCancel={() => setCancelling(r)}
                      onTolerance={(minutes) => changeTolerance.mutate({ id: r.id, minutes })}
                      busy={changeTolerance.isPending}
                    />
                  ))}
                </section>
              );
            })}
          </div>
        </div>
      </Dialog>
      {cancelling && (
        <ConfirmDialog
          open
          danger
          title={t('reservations.cancelTitle')}
          body={t('reservations.cancelBody', {
            name: cancelling.customerName,
            pcs: cancelling.stations.map((s) => s.code).join(', '),
          })}
          confirmLabel={t('reservations.cancelConfirm')}
          loading={cancel.isPending}
          onClose={() => setCancelling(null)}
          onConfirm={() => cancel.mutate(cancelling.id)}
        />
      )}
    </>
  );
}

function ReservationRow({
  r,
  canControl,
  onCancel,
  onTolerance,
  busy,
}: {
  r: ReservationSummary;
  canControl: boolean;
  onCancel: () => void;
  onTolerance: (minutes: number) => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const open = r.status === 'scheduled' || r.status === 'active';
  const [minutes, setMinutes] = useState(String(r.toleranceMinutes));
  useEffect(() => setMinutes(String(r.toleranceMinutes)), [r.toleranceMinutes]);
  const valid = Number.isInteger(Number(minutes)) && Number(minutes) >= 1 && Number(minutes) <= 60;
  return (
    <div className="res__row-item" data-status={r.status}>
      <div className="res__who">
        <strong>{r.customerName}</strong>
        {r.phone && <span className="faint"> · {r.phone}</span>}
        <span className="res__status">{t(`reservations.status.${r.status}`)}</span>
      </div>
      <div className="res__pcs-list">
        {r.stations.map((s) => (
          <span key={s.stationId} className="res__hold" data-state={s.state}>
            {s.code} · {t(`reservations.hold.${s.state}`)}
          </span>
        ))}
      </div>
      <div className="res__meta">
        <span className="faint">
          {t('reservations.windowUntil', { time: fmt.time(r.windowEndsAt) })}
        </span>
        {open && canControl && (
          <span className="res__edit">
            <Input
              type="number"
              min={1}
              max={60}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              aria-label={t('reservations.tolerance')}
              style={{ width: 70 }}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={!valid || Number(minutes) === r.toleranceMinutes || busy}
              onClick={() => onTolerance(Number(minutes))}
            >
              {t('reservations.setTolerance')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancel} aria-label={t('reservations.cancelConfirm')}>
              <Trash2 size={14} />
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}
