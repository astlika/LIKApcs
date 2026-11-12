/**
 * 0.32.0 — the stations board, as plain functions (no React): what state a PC is in, what its card
 * says and the header figures. The components only draw these.
 *
 * Priority of the state (the first that applies wins): disabled → paused → expiring → active →
 * awaiting payment → offline → the rest (free, maintenance, locked, …).
 *
 * 0.33.4 — a PC card shows nothing of a reservation (no state, no pill, no name, no countdown): the
 * desk is reminded when the booked time comes (ReservationAlerts) and the bookings live in their
 * own dialog. An idle PC shows no debt either: once a bill is settled the PC is clean. The states
 * `reserved` and `debt` stay in the type for the styles that name them; nothing produces them.
 */
import type {
  StationBadge,
  StationOrderLine,
  StationSummary,
  DashboardSummary,
} from '@likapcs/shared';
import { projectSession } from './session-time';

export type BoardView = 'grid' | 'list' | 'compact' | 'detailed';
export const BOARD_VIEWS: readonly BoardView[] = ['grid', 'list', 'compact', 'detailed'];
export const DEFAULT_BOARD_VIEW: BoardView = 'grid';

export function isBoardView(value: unknown): value is BoardView {
  return typeof value === 'string' && (BOARD_VIEWS as readonly string[]).includes(value);
}

export type BoardState =
  | 'active'
  | 'paused'
  | 'expiring'
  | 'awaiting'
  | 'debt'
  | 'reserved'
  | 'offline'
  | 'free'
  | 'disabled'
  | 'maintenance'
  | 'locked'
  | 'updating'
  | 'error';

/** Five minutes or less left on a prepaid session: the timer blinks (as before 0.32.0). */
export const EXPIRING_SECONDS = 300;

export function boardStateOf(station: StationSummary, remaining: number | null): BoardState {
  if (!station.isEnabled) return 'disabled';
  const live = station.activeSession;
  if (live?.status === 'paused') return 'paused';
  if (live && remaining !== null && remaining <= EXPIRING_SECONDS) return 'expiring';
  if (live) return 'active';
  if (station.awaitingPayment.count > 0) return 'awaiting';
  if (station.status === 'offline') return 'offline';
  switch (station.status) {
    case 'maintenance':
      return 'maintenance';
    case 'locked':
      return 'locked';
    case 'updating':
      return 'updating';
    case 'error':
      return 'error';
    default:
      return 'free';
  }
}

/** What a card needs, computed once per station and clock tick. */
export interface StationView {
  state: BoardState;
  /** 0.33.0: the name the PC shows for this session: the name typed for it, else the customer's name; null when idle. */
  pcName: string | null;
  /** Seconds on the clock: what is left (prepaid) or what has run (open time); null when idle. */
  timerSeconds: number | null;
  timerKind: 'remaining' | 'elapsed' | null;
  /** Share of the planned time still left (0..1); null for open time or idle PCs. */
  fraction: number | null;
  customerName: string | null;
  /** The running session's gaming price (cents). */
  gamingCents: number;
  /** Open products on the PC's bill (cents). */
  productsCents: number;
  /** gaming + products: what the PC shows as its total. */
  totalCents: number;
  products: StationOrderLine[];
  /** When the running session started (ISO), or null. */
  startedAt: string | null;
  /** What the running session's customer owes in total (cents); 0 on an idle PC. */
  debtCents: number;
  /** The customer of a running session, or of an ended one that still waits for its payment. */
  debtCustomerName: string | null;
  awaitingCount: number;
  awaitingCents: number;
  badges: StationBadge[];
}

export function describeStation(
  station: StationSummary,
  fetchedAt: number,
  now: number,
): StationView {
  const live = station.activeSession;
  const projected = live
    ? projectSession(
        {
          status: live.status,
          billableSeconds: live.elapsedSeconds,
          endsAt: live.endsAt,
          pausedAt: live.pausedAt,
        },
        fetchedAt,
        now,
      )
    : null;
  const remaining = projected?.remaining ?? null;
  const plannedSeconds =
    live?.endsAt && live.startedAt
      ? Math.max(1, (new Date(live.endsAt).getTime() - new Date(live.startedAt).getTime()) / 1000)
      : null;
  const fraction =
    projected && remaining !== null && plannedSeconds
      ? Math.min(1, Math.max(0, remaining / plannedSeconds))
      : null;

  const gamingCents = live?.currentPriceCents ?? 0;
  const productsCents = station.orders.openCents;
  return {
    state: boardStateOf(station, remaining),
    timerSeconds: projected ? (remaining ?? projected.elapsed) : null,
    timerKind: projected ? (remaining !== null ? 'remaining' : 'elapsed') : null,
    fraction,
    pcName: live ? (live.pcLabel ?? live.customerName ?? null) : null,
    customerName: live?.customerName ?? null,
    gamingCents,
    productsCents,
    totalCents: gamingCents + productsCents,
    products: station.orders.items,
    startedAt: live?.startedAt ?? null,
    debtCents: station.debt.cents,
    debtCustomerName: station.debt.customerName,
    awaitingCount: station.awaitingPayment.count,
    awaitingCents: station.awaitingPayment.amountCents,
    badges: station.badges,
  };
}

/** 0.33.0: the name a PC card shows: the session's name, else the PC's own name when it differs from its code. */
export function pcNameShown(
  station: { name: string; code: string },
  view: { pcName: string | null },
): string | null {
  return view.pcName ?? (station.name !== station.code ? station.name : null);
}

/** "1h34m", "45m", "30s": the short form used on the card's line. */
export function shortDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

/** "4m 59s" for the reservation countdown ("⏳ Afati: 4m 59s"). */
export function countdownLabel(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

/** HH:mm in the business time zone (the "Filloi: 16:20" and "Për: 20:00" labels). */
export function clockLabel(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(new Date(iso));
}

/** The header figures. Counts are PCs; revenue and units come from the day's dashboard figures. */
export interface BoardStats {
  active: number;
  free: number;
  awaiting: number;
  /** PCs in use by a customer who owes money (0.33.4; before: idle PCs with an unpaid debt). */
  debt: number;
  revenueCents: number;
  productUnits: number;
}

export function boardStats(
  stations: readonly StationSummary[],
  dashboard?: Pick<DashboardSummary, 'revenue' | 'productUnitsSold'> | null,
): BoardStats {
  const stats: BoardStats = {
    active: 0,
    free: 0,
    awaiting: 0,
    debt: 0,
    revenueCents: dashboard?.revenue.totalCents ?? 0,
    productUnits: dashboard?.productUnitsSold ?? 0,
  };
  for (const s of stations) {
    if (s.archived) continue;
    const state = boardStateOf(s, null);
    if (state === 'active' || state === 'expiring') stats.active += 1;
    if (state === 'free') stats.free += 1;
    if (state === 'awaiting') stats.awaiting += 1;
    if (s.activeSession && s.debt.cents > 0) stats.debt += 1;
  }
  return stats;
}

/** Live PCs that wait for a reservation to start, grouped by their booked time (for the dialog). */
export function groupByStart<T extends { startsAt: string }>(
  items: readonly T[],
  timeZone?: string,
): { key: string; startsAt: string; items: T[] }[] {
  const groups = new Map<string, { key: string; startsAt: string; items: T[] }>();
  for (const item of items) {
    const key = clockLabel(item.startsAt, timeZone) + ' ' + new Date(item.startsAt).toDateString();
    const group = groups.get(key) ?? { key, startsAt: item.startsAt, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** The short line under a card: "Aktiv • 1h34m • Coca Cola • 3.00€" (labels and money passed in). */
export function shortLineParts(
  view: StationView,
  labels: { state: string; awaiting: string },
  money: (cents: number) => string,
): string[] {
  const parts: string[] = [];
  switch (view.state) {
    case 'awaiting':
      parts.push(labels.awaiting);
      if (view.awaitingCents > 0) parts.push(money(view.awaitingCents));
      return parts;
    default:
      parts.push(labels.state);
  }
  if (view.timerSeconds !== null) parts.push(shortDuration(view.timerSeconds));
  if (view.products.length > 0) parts.push(view.products[0]!.name);
  if (view.totalCents > 0) parts.push(money(view.totalCents));
  return parts;
}
