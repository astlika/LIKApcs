/**
 * PC reservations (0.33.0). Left: book in three steps — When (quick hours or a date and time),
 * Which PCs (a PC already booked in that hour is shown as booked), Who (customer and tolerance).
 * Right: the coming reservations grouped by day and hour, each with its PCs and how far it is.
 *
 * 0.33.4: a booking can be worked with from here — "Arrived" starts its PCs (one dialog, no
 * confirmation), "Change" loads it into the form on the left (time, PCs, name, phone, notes), and
 * the bin cancels it. The house defaults (tolerance, reminder) sit at the bottom for managers.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Pencil, Play, Trash2 } from 'lucide-react';
import type { CustomerSummary, ReservationSummary, StationSummary } from '@likapcs/shared';
import { api, ApiError } from '../../lib/api';
import { groupByStart } from '../../lib/station-board';
import { untilLabel } from '../../lib/reservation-reminders';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { useToast } from '../../state/toast';
import { Alert, Button, ConfirmDialog, Dialog } from '../ui/primitives';
import { CustomerPicker } from '../customers/CustomerPicker';

const TOLERANCE_KEY = 'reservations.tolerance_minutes';
const REMINDER_KEY = 'reservations.reminder_minutes';
const HOUR = 60 * 60_000;
const TOLERANCE_CHOICES = [1, 2, 3, 5, 10, 15, 20, 30];

/** `YYYY-MM-DDTHH:MM` in the browser's zone, as a datetime-local input wants it. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The next four full hours, as the quick choices of the "When" step. */
function quickHours(now: number): Date[] {
  const first = new Date(now);
  first.setMinutes(0, 0, 0);
  first.setHours(first.getHours() + 1);
  return [0, 1, 2, 3].map((i) => new Date(first.getTime() + i * HOUR));
}

export function ReservationsDialog({
  open,
  onClose,
  stations,
  initialStationIds,
  canControl,
  canSettings,
  onArrive,
}: {
  open: boolean;
  onClose: () => void;
  stations: StationSummary[];
  /** The PCs selected on the board when the dialog opens. */
  initialStationIds: string[];
  canControl: boolean;
  canSettings: boolean;
  /** 0.33.4: the booked customer arrived: the page starts the booking's PCs. */
  onArrive: (reservation: ReservationSummary) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const queryClient = useQueryClient();
  // 0.33.4: the booking being changed (its values sit in the form); null while booking a new one.
  const [editing, setEditing] = useState<ReservationSummary | null>(null);
  // The list shows how far each booking is: one tick a second is enough.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [open]);

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
  const [tolerance, setTolerance] = useState('');
  useEffect(() => {
    if (settings.data) setTolerance(String(defaultTolerance));
  }, [settings.data, defaultTolerance]);

  const defaultReminder = Number(settings.data?.[REMINDER_KEY] ?? 10);
  const [reminder, setReminder] = useState('');
  useEffect(() => {
    if (settings.data) setReminder(String(defaultReminder));
  }, [settings.data, defaultReminder]);
  const saveReminder = useMutation({
    mutationFn: (minutes: number) => api('/settings', { method: 'PATCH', body: { [REMINDER_KEY]: minutes } }),
    onSuccess: () => {
      toast.success(t('reservations.remindSaved'));
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  const saveTolerance = useMutation({
    mutationFn: (minutes: number) => api('/settings', { method: 'PATCH', body: { [TOLERANCE_KEY]: minutes } }),
    onSuccess: () => {
      toast.success(t('reservations.toleranceSaved'));
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('common.errorGeneric')),
  });

  // ─── Step 1: when ───────────────────────────────────────────
  const hours = useMemo(() => quickHours(Date.now()), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const [when, setWhen] = useState('');
  // ─── Step 2: which PCs ──────────────────────────────────────
  const [picked, setPicked] = useState<string[]>([]);
  // ─── Step 3: who ────────────────────────────────────────────
  const [customer, setCustomer] = useState<CustomerSummary | null>(null);
  const [name, setName] = useState('');
  const [ownTolerance, setOwnTolerance] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setWhen(toLocalInput(hours[0]!));
    setPicked(initialStationIds);
    setName('');
    setCustomer(null);
    setOwnTolerance('');
    setPhone('');
    setNotes('');
    setFormError(null);
    setEditing(null);
  }, [open, initialStationIds, hours]);

  /** Loads a booking into the form, or (null) goes back to a new booking. */
  const beginEdit = (r: ReservationSummary | null) => {
    setEditing(r);
    setFormError(null);
    setCustomer(null);
    if (!r) {
      setWhen(toLocalInput(hours[0]!));
      setPicked([]);
      setName('');
      setOwnTolerance('');
      setPhone('');
      setNotes('');
      return;
    }
    setWhen(toLocalInput(new Date(r.startsAt)));
    setPicked(r.stations.filter((s) => s.state === 'held').map((s) => s.stationId));
    setName(r.customerName);
    setOwnTolerance(String(r.toleranceMinutes));
    setPhone(r.phone ?? '');
    setNotes(r.notes ?? '');
  };

  const enabledStations = useMemo(
    () => stations.filter((s) => s.isEnabled && !s.archived).sort((a, b) => a.number - b.number),
    [stations],
  );
  const items = list.data?.items ?? [];
  const startsAt = when ? new Date(when) : null;
  const validStart = !!startsAt && !Number.isNaN(startsAt.getTime());
  const endsAt = validStart ? new Date(startsAt!.getTime() + HOUR) : null;

  // A PC is booked for this hour when an open reservation's window touches [start, start+1h].
  const bookedAt = useMemo(() => {
    const map = new Map<string, string>();
    if (!validStart) return map;
    for (const r of items) {
      if (r.status !== 'scheduled' && r.status !== 'active') continue;
      // The booking being changed does not block its own PCs.
      if (r.id === editing?.id) continue;
      const rs = Date.parse(r.startsAt);
      const re = Date.parse(r.windowEndsAt);
      if (rs < endsAt!.getTime() && re > startsAt!.getTime()) {
        for (const s of r.stations) if (s.state === 'held') map.set(s.stationId, r.customerName);
      }
    }
    return map;
  }, [items, validStart, startsAt, endsAt, editing]);

  const customerName = (customer?.name ?? name).trim();
  const tolerated = ownTolerance.trim() ? Number(ownTolerance) : undefined;
  const blocker =
    picked.length === 0
      ? t('reservations.pickPcs')
      : !validStart
        ? t('reservations.pickTime')
        : startsAt!.getTime() < Date.now() - 60_000
          ? t('reservations.pickTime')
          : !customerName
            ? t('reservations.pickName')
            : picked.some((id) => bookedAt.has(id))
              ? t('reservations.overlap')
              : null;

  const create = useMutation({
    mutationFn: async (e: FormEvent) => {
      e.preventDefault();
      if (editing) {
        // The name alone keeps the customer the booking was made for; a new pick replaces it.
        return api<ReservationSummary>(`/reservations/${editing.id}`, {
          method: 'PATCH',
          body: {
            stationIds: picked,
            startsAt: startsAt!.toISOString(),
            ...(customer
              ? { customerId: customer.id }
              : customerName !== editing.customerName
                ? { customerId: null, customerName }
                : {}),
            phone: phone.trim() || null,
            notes: notes.trim() || null,
            ...(tolerated ? { toleranceMinutes: tolerated } : {}),
          },
        });
      }
      return api<ReservationSummary>('/reservations', {
        method: 'POST',
        body: {
          stationIds: picked,
          startsAt: startsAt!.toISOString(),
          customerId: customer?.id,
          customerName,
          phone: phone.trim() || undefined,
          notes: notes.trim() || undefined,
          toleranceMinutes: tolerated,
        },
      });
    },
    onSuccess: (created) => {
      toast.success(
        editing
          ? t('reservations.updated')
          : t('reservations.created', { n: created.stations.length, time: fmt.time(created.startsAt) }),
      );
      setEditing(null);
      setName('');
      setCustomer(null);
      setOwnTolerance('');
      setPhone('');
      setNotes('');
      setPicked([]);
      setFormError(null);
      void queryClient.invalidateQueries({ queryKey: ['reservations'] });
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'reservation_overlap') setFormError(t('reservations.overlap'));
      else setFormError(err instanceof Error ? err.message : t('common.errorGeneric'));
    },
  });

  const toggle = (id: string) =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const freeIds = enabledStations.filter((s) => !bookedAt.has(s.id)).map((s) => s.id);

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

  const groups = useMemo(() => groupByStart(items, fmt.timeZone), [items, fmt.timeZone]);

  return (
    <>
      <Dialog open={open} onClose={onClose} title={t('reservations.title')} size="lg">
        <div className="rz">
          {canControl && (
            <form className="rz__book" onSubmit={(e) => create.mutate(e)} data-testid="reservation-form">
              {editing && (
                <div className="rz__editing" data-testid="reservation-editing">
                  <strong>{t('reservations.editTitle', { name: editing.customerName })}</strong>
                  <button type="button" className="rz__link" onClick={() => beginEdit(null)}>
                    {t('reservations.cancelEdit')}
                  </button>
                </div>
              )}
              <section className="rz__step">
                <h3 className="rz__h">
                  <span className="rz__n">1</span> {t('reservations.stepTime')}
                </h3>
                <div className="rz__chips" role="group" aria-label={t('reservations.quickTimes')}>
                  {hours.map((h) => {
                    const v = toLocalInput(h);
                    return (
                      <button
                        key={v}
                        type="button"
                        className="rz__chip"
                        data-on={when === v || undefined}
                        aria-pressed={when === v}
                        onClick={() => setWhen(v)}
                      >
                        <Clock size={13} aria-hidden /> {fmt.time(h.toISOString())}
                      </button>
                    );
                  })}
                </div>
                <label className="rz__field">
                  <span>{t('reservations.otherTime')}</span>
                  <input
                    type="datetime-local"
                    value={when}
                    onChange={(e) => setWhen(e.target.value)}
                    aria-label={t('reservations.otherTime')}
                  />
                </label>
              </section>

              <section className="rz__step">
                <div className="rz__h-row">
                  <h3 className="rz__h">
                    <span className="rz__n">2</span> {t('reservations.stepPcs')}
                    <span className="rz__count num">{picked.length}</span>
                  </h3>
                  <div className="rz__tools">
                    <button type="button" className="rz__link" onClick={() => setPicked(freeIds)} disabled={freeIds.length === 0}>
                      {t('reservations.freeAll')}
                    </button>
                    <button type="button" className="rz__link" onClick={() => setPicked([])} disabled={picked.length === 0}>
                      {t('reservations.clearPcs')}
                    </button>
                  </div>
                </div>
                <div className="rz__pcs" role="group" aria-label={t('reservations.pcs')}>
                  {enabledStations.map((s) => {
                    const busy = bookedAt.get(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        className="rz__pc"
                        data-on={picked.includes(s.id) || undefined}
                        data-busy={busy ? '' : undefined}
                        aria-pressed={picked.includes(s.id)}
                        title={busy ? `${t('reservations.busyAt')}: ${busy}` : s.code}
                        onClick={() => toggle(s.id)}
                      >
                        <span className="rz__pc-code">{s.code}</span>
                        <span className="rz__pc-sub">{busy ? t('reservations.busyAt') : s.name !== s.code ? s.name : ''}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="rz__step">
                <h3 className="rz__h">
                  <span className="rz__n">3</span> {t('reservations.stepCustomer')}
                </h3>
                <div className="rz__who">
                  <div className="rz__field">
                    <span>{t('reservations.customer')}</span>
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
                  </div>
                  <label className="rz__field rz__tol">
                    <span>{t('reservations.tolerance')}</span>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={ownTolerance}
                      placeholder={String(defaultTolerance)}
                      onChange={(e) => setOwnTolerance(e.target.value)}
                    />
                  </label>
                </div>
                <details className="rz__more">
                  <summary>{t('reservations.moreFields')}</summary>
                  <div className="rz__who">
                    <label className="rz__field">
                      <span>{t('reservations.phone')}</span>
                      <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} />
                    </label>
                    <label className="rz__field">
                      <span>{t('reservations.notes')}</span>
                      <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
                    </label>
                  </div>
                </details>
              </section>

              {formError && <Alert tone="danger">{formError}</Alert>}
              <div className="rz__submit">
                <div className="rz__summary">
                  {blocker ? (
                    <span className="rz__blocker">{blocker}</span>
                  ) : (
                    <span>
                      {t('reservations.summary', {
                        pcs: picked.map((id) => stations.find((s) => s.id === id)?.code ?? '').join(', '),
                        time: fmt.time(startsAt!.toISOString()),
                        name: customerName,
                      })}
                    </span>
                  )}
                </div>
                <Button
                  type="submit"
                  variant="primary"
                  loading={create.isPending}
                  disabled={!!blocker}
                  data-testid="reservation-submit"
                >
                  {editing ? t('reservations.saveChanges') : t('reservations.book')}
                </Button>
              </div>
            </form>
          )}

          <section className="rz__list" aria-live="polite">
            <h3 className="rz__h">{t('reservations.upcoming')}</h3>
            {list.isLoading && <p className="muted">{t('common.loading')}</p>}
            {!list.isLoading && groups.length === 0 && <p className="muted">{t('reservations.none')}</p>}
            {groups.map((g, index) => {
              const pcs = g.items.reduce((n, r) => n + r.stations.length, 0);
              const day = dayLabel(g.startsAt, now, t('reservations.today'), t('reservations.tomorrow'), fmt.date);
              const previous = index > 0 ? groups[index - 1]! : null;
              const newDay =
                !previous ||
                dayLabel(previous.startsAt, now, t('reservations.today'), t('reservations.tomorrow'), fmt.date) !== day;
              return (
                <div key={g.key} className="rz__group">
                  {newDay && <div className="rz__day">{day}</div>}
                  <header className="rz__group-head">
                    <strong className="num">{fmt.time(g.startsAt)}</strong>
                    <span className="faint">{t('reservations.pcsForTime', { n: pcs })}</span>
                  </header>
                  {g.items.map((r) => (
                    <ReservationRow
                      key={r.id}
                      r={r}
                      now={now}
                      canControl={canControl}
                      editing={editing?.id === r.id}
                      onArrive={() => onArrive(r)}
                      onEdit={() => beginEdit(r)}
                      onCancel={() => setCancelling(r)}
                      onTolerance={(minutes) => changeTolerance.mutate({ id: r.id, minutes })}
                      busy={changeTolerance.isPending}
                    />
                  ))}
                </div>
              );
            })}
          </section>
        </div>

        {canSettings && (
          <div className="rz__settings">
            <label className="rz__field">
              <span>{t('reservations.defaultTolerance')}</span>
              <span className="rz__inline">
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={tolerance}
                  onChange={(e) => setTolerance(e.target.value)}
                  aria-label={t('reservations.defaultTolerance')}
                />
                <Button
                  size="sm"
                  onClick={() => saveTolerance.mutate(Number(tolerance))}
                  loading={saveTolerance.isPending}
                  disabled={!Number.isInteger(Number(tolerance)) || Number(tolerance) < 1 || Number(tolerance) > 60}
                >
                  {t('common.save')}
                </Button>
              </span>
            </label>
            <p className="faint rz__hint">{t('reservations.defaultToleranceHint')}</p>
            <label className="rz__field">
              <span>{t('reservations.defaultRemind')}</span>
              <span className="rz__inline">
                <input
                  type="number"
                  min={0}
                  max={240}
                  value={reminder}
                  onChange={(e) => setReminder(e.target.value)}
                  aria-label={t('reservations.defaultRemind')}
                  data-testid="reservation-default-reminder"
                />
                <Button
                  size="sm"
                  onClick={() => saveReminder.mutate(Number(reminder))}
                  loading={saveReminder.isPending}
                  disabled={
                    reminder.trim() === '' ||
                    !Number.isInteger(Number(reminder)) ||
                    Number(reminder) < 0 ||
                    Number(reminder) > 240
                  }
                >
                  {t('common.save')}
                </Button>
              </span>
            </label>
            <p className="faint rz__hint">{t('reservations.defaultRemindHint')}</p>
          </div>
        )}
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

/** "Today" / "Tomorrow" / the date: the day a group of bookings belongs to. */
function dayLabel(
  iso: string,
  now: number,
  today: string,
  tomorrow: string,
  formatDate: (value: string) => string,
): string {
  const day = new Date(iso).toDateString();
  if (day === new Date(now).toDateString()) return today;
  if (day === new Date(now + 24 * HOUR).toDateString()) return tomorrow;
  return formatDate(iso);
}

function ReservationRow({
  r,
  now,
  canControl,
  editing,
  onArrive,
  onEdit,
  onCancel,
  onTolerance,
  busy,
}: {
  r: ReservationSummary;
  now: number;
  canControl: boolean;
  editing: boolean;
  onArrive: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onTolerance: (minutes: number) => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const open = r.status === 'scheduled' || r.status === 'active';
  const waiting = r.stations.some((s) => s.state === 'held');
  const start = Date.parse(r.startsAt);
  const end = Date.parse(r.windowEndsAt);
  const choices = TOLERANCE_CHOICES.includes(r.toleranceMinutes)
    ? TOLERANCE_CHOICES
    : [...TOLERANCE_CHOICES, r.toleranceMinutes].sort((a, b) => a - b);
  return (
    <div className="rz__row" data-status={r.status} data-editing={editing || undefined} data-testid="reservation-row">
      <div className="rz__who-line">
        <strong>{r.customerName}</strong>
        <span className="rz__status">{t(`reservations.status.${r.status}`)}</span>
      </div>
      {open && (
        <div className="rz__when num">
          {now < start
            ? t('reservations.inTime', { time: untilLabel((start - now) / 1000) })
            : t('reservations.nowWaiting', { time: untilLabel(Math.max(0, end - now) / 1000) })}
        </div>
      )}
      {(r.phone || r.notes) && (
        <div className="rz__contact">
          {r.phone && <span>{r.phone}</span>}
          {r.notes && <span>{r.notes}</span>}
        </div>
      )}
      <div className="rz__row-pcs">
        {r.stations.map((s) => (
          <span key={s.stationId} className="rz__hold" data-state={s.state}>
            {s.code} · {t(`reservations.hold.${s.state}`)}
          </span>
        ))}
      </div>
      <div className="rz__row-end">
        <span className="faint num">{t('reservations.windowUntil', { time: fmt.time(r.windowEndsAt) })}</span>
        {open && canControl && (
          <>
            <label className="rz__tol-pick">
              <span className="sr-only">{t('reservations.tolerance')}</span>
              <select
                value={r.toleranceMinutes}
                disabled={busy}
                onChange={(e) => onTolerance(Number(e.target.value))}
              >
                {choices.map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="rz__icon rz__icon--edit"
              onClick={onEdit}
              aria-label={t('reservations.edit')}
              title={t('reservations.edit')}
              data-testid="reservation-edit"
            >
              <Pencil size={14} />
            </button>
            <button type="button" className="rz__icon" onClick={onCancel} aria-label={t('reservations.cancelConfirm')} title={t('reservations.cancelConfirm')}>
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>
      {open && canControl && waiting && (
        <div className="rz__row-actions">
          <Button size="sm" variant="primary" onClick={onArrive} data-testid="reservation-arrived">
            <Play size={14} /> {t('reservations.arrivedStart')}
          </Button>
        </div>
      )}
    </div>
  );
}

