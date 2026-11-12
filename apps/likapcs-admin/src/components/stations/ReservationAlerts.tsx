/**
 * 0.32.0 — the reservation warnings, inside the app only (a toast and a chime, as live tracking
 * does). Two per booking: REMINDER_LEAD_MINUTES before the booked time, and at the time itself.
 * Each warning fires once; what was already shown is remembered for the browser tab, so a reload
 * does not repeat it.
 */
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PERMISSIONS, type ReservationSummary } from '@likapcs/shared';
import { api } from '../../lib/api';
import { chime } from '../../lib/chime';
import { REMINDER_LEAD_MINUTES } from '../../lib/station-board';
import { useFormat } from '../../lib/format';
import { useI18n } from '../../i18n';
import { useAuth } from '../../state/auth';
import { useToast } from '../../state/toast';

const SEEN_KEY = 'likapcs.reservation-alerts';

function readSeen(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function markSeen(seen: Set<string>, key: string): void {
  seen.add(key);
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // Storage full or blocked: the warning may repeat after a reload; nothing else breaks.
  }
}

export function ReservationAlerts() {
  const { can } = useAuth();
  const { t } = useI18n();
  const fmt = useFormat();
  const toast = useToast();
  const enabled = can(PERMISSIONS.STATIONS_VIEW);

  const list = useQuery({
    queryKey: ['reservations'],
    queryFn: () => api<{ items: ReservationSummary[] }>('/reservations'),
    enabled,
    refetchInterval: 15_000,
  });

  // The timer reads the latest list and helpers from here, so it is set up once per session.
  const latest = useRef({ items: [] as ReservationSummary[], t, fmt, toast });
  latest.current = { items: list.data?.items ?? [], t, fmt, toast };

  useEffect(() => {
    if (!enabled) return;
    const seen = readSeen();
    const check = () => {
      const now = Date.now();
      const { items, t: tr, fmt: f, toast: notify } = latest.current;
      for (const r of items) {
        if (r.status !== 'scheduled' && r.status !== 'active') continue;
        const start = Date.parse(r.startsAt);
        const end = Date.parse(r.windowEndsAt);
        const pcs = r.stations.map((s) => s.code).join(', ');
        const lead = start - REMINDER_LEAD_MINUTES * 60_000;
        if (now >= lead && now < start && !seen.has(`${r.id}:soon`)) {
          markSeen(seen, `${r.id}:soon`);
          notify.toast(
            'warning',
            tr('board.alert.soonTitle', { time: f.time(r.startsAt) }),
            tr('board.alert.soon', { name: r.customerName, pcs, minutes: REMINDER_LEAD_MINUTES }),
          );
          chime();
        }
        if (now >= start && now < end && !seen.has(`${r.id}:start`)) {
          markSeen(seen, `${r.id}:start`);
          notify.toast(
            'info',
            tr('board.alert.startTitle', { name: r.customerName }),
            tr('board.alert.start', {
              pcs,
              minutes: r.toleranceMinutes,
            }),
          );
          chime();
        }
      }
    };
    check();
    const id = window.setInterval(check, 1000);
    return () => window.clearInterval(id);
  }, [enabled]);

  return null;
}
