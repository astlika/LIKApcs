/**
 * 0.33.4 — the reservation reminders, on every page of the app.
 *
 * A booking no longer marks its PCs. Instead, when its time comes close a card appears in the
 * corner and STAYS there until someone answers it (0.32.0 showed a toast for four seconds: looked
 * away, and it was missed). Two reminders per booking: at its reminder time ("in 10 min") and
 * again at the booked time ("starts now"); each plays the chime once. The card says who comes, at
 * what time, which PCs wait and whether each is free or still in use, and offers:
 *   - "Arrived — start the PCs": opens the start dialog for the waiting PCs (one more click starts
 *     them; PCs the customer already sits at are marked as arrived);
 *   - "Later": hides this reminder (the one at the booked time still comes).
 * A card goes away by itself once every PC is taken, the booking is cancelled or its tolerance ends.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Phone, Play, X } from 'lucide-react';
import { PERMISSIONS, type ReservationSummary, type StationSummary } from '@likapcs/shared';
import { api } from '../../lib/api';
import { chime } from '../../lib/chime';
import {
  dueReservations,
  pcOccupancy,
  reminderKey,
  untilLabel,
} from '../../lib/reservation-reminders';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { useAuth } from '../../state/auth';
import { soundEnabled } from '../requests/requests';
import { Button } from '../ui/primitives';

const DISMISSED_KEY = 'likapcs.reservation-alerts';
const CHIMED_KEY = 'likapcs.reservation-chimes';

function readKeys(key: string): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(key) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function writeKeys(key: string, keys: Set<string>): void {
  try {
    // Old keys are of no use once their booking has passed: keep the list short.
    sessionStorage.setItem(key, JSON.stringify([...keys].slice(-200)));
  } catch {
    // Storage full or blocked: a reminder may repeat after a reload; nothing else breaks.
  }
}

/** Where "Arrived" leads: the Stations page opens the start dialog for the booking's PCs. */
export function arrivalPath(reservationId: string): string {
  return `/stations?reservation=${reservationId}`;
}

export function ReservationAlerts() {
  const { can } = useAuth();
  const { t } = useI18n();
  const fmt = useFormat();
  const navigate = useNavigate();
  const enabled = can(PERMISSIONS.STATIONS_VIEW);
  const canControl = can(PERMISSIONS.STATIONS_CONTROL);

  const list = useQuery({
    queryKey: ['reservations'],
    queryFn: () => api<{ items: ReservationSummary[] }>('/reservations'),
    enabled,
    refetchInterval: 15_000,
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [enabled]);

  const [dismissed, setDismissed] = useState(() => readKeys(DISMISSED_KEY));
  const chimed = useRef<Set<string> | null>(null);
  chimed.current ??= readKeys(CHIMED_KEY);

  const items = list.data?.items;
  const due = useMemo(() => dueReservations(items ?? [], now), [items, now]);
  const shown = due.filter((d) => !dismissed.has(reminderKey(d)));

  // What each booked PC is doing right now; asked only while a reminder is on the screen.
  const stations = useQuery({
    queryKey: ['stations', false],
    queryFn: () => api<StationSummary[]>('/stations', { query: { includeArchived: false } }),
    enabled: enabled && shown.length > 0,
    staleTime: 5_000,
    refetchInterval: shown.length > 0 ? 20_000 : false,
  });
  const stationById = useMemo(
    () => new Map((stations.data ?? []).map((s) => [s.id, s])),
    [stations.data],
  );

  // One chime per reminder (and per phase), also after a reload.
  const dueKeys = due.map(reminderKey).join('|');
  useEffect(() => {
    const seen = chimed.current!;
    const fresh = dueKeys.split('|').filter((key) => key && !seen.has(key));
    if (fresh.length === 0) return;
    for (const key of fresh) seen.add(key);
    writeKeys(CHIMED_KEY, seen);
    if (soundEnabled()) chime();
  }, [dueKeys]);

  if (!enabled || shown.length === 0) return null;

  const dismiss = (key: string) =>
    setDismissed((current) => {
      const next = new Set(current).add(key);
      writeKeys(DISMISSED_KEY, next);
      return next;
    });

  return (
    <div className="rz-reminders" role="region" aria-label={t('reservations.remindersLabel')}>
      {shown.map((d) => {
        const r = d.reservation;
        const key = reminderKey(d);
        return (
          <article
            key={key}
            className="rz-reminder"
            data-phase={d.phase}
            data-testid="reservation-reminder"
            role="alert"
          >
            <header className="rz-reminder__head">
              <CalendarClock size={18} aria-hidden />
              <strong>
                {d.phase === 'soon'
                  ? t('reservations.remindSoonTitle', { time: untilLabel(d.secondsToStart) })
                  : t('reservations.remindNowTitle')}
              </strong>
              <span className="rz-reminder__time num">{fmt.time(r.startsAt)}</span>
              <button
                type="button"
                className="rz-reminder__close"
                onClick={() => dismiss(key)}
                aria-label={t('reservations.later')}
                title={t('reservations.later')}
              >
                <X size={15} />
              </button>
            </header>
            <div className="rz-reminder__who">
              <strong>{r.customerName}</strong>
              {r.phone && (
                <span className="muted">
                  <Phone size={12} aria-hidden /> {r.phone}
                </span>
              )}
            </div>
            {r.notes && <div className="rz-reminder__notes muted">{r.notes}</div>}
            <ul className="rz-reminder__pcs">
              {d.waiting.map((s) => {
                const occupancy = pcOccupancy(stationById.get(s.stationId));
                return (
                  <li key={s.stationId} data-busy={occupancy.busy || undefined}>
                    <strong>{s.code}</strong>
                    <span>
                      {!occupancy.busy
                        ? t('reservations.pcFree')
                        : occupancy.minutesLeft === null
                          ? t('reservations.pcBusy')
                          : t('reservations.pcBusyFor', { n: occupancy.minutesLeft })}
                    </span>
                  </li>
                );
              })}
            </ul>
            {d.phase === 'now' && (
              <div className="rz-reminder__left faint">
                {t('reservations.remindLeft', { time: untilLabel(d.secondsLeft) })}
              </div>
            )}
            <footer className="rz-reminder__actions">
              {canControl && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    dismiss(key);
                    navigate(arrivalPath(r.id));
                  }}
                  data-testid="reminder-arrived"
                >
                  <Play size={14} /> {t('reservations.arrivedStart')}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => dismiss(key)}
                data-testid="reminder-later"
              >
                {t('reservations.later')}
              </Button>
            </footer>
          </article>
        );
      })}
    </div>
  );
}
