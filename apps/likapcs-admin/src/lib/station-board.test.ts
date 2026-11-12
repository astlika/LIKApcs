import { describe, expect, it } from 'vitest';
import type { StationSummary } from '@likapcs/shared';
import {
  boardStateOf,
  boardStats,
  countdownLabel,
  describeStation,
  groupByStart,
  isBoardView,
  shortDuration,
  shortLineParts,
} from './station-board';

/** A PC as the server describes it; only the fields the board reads are filled in. */
function pc(over: Partial<Record<string, unknown>> = {}): StationSummary {
  return {
    id: 'pc-1',
    number: 1,
    code: 'PC01',
    name: 'PC01',
    zone: null,
    notes: null,
    isEnabled: true,
    status: 'available',
    device: null,
    activeSession: null,
    maintenance: null,
    pendingRequest: null,
    orders: { pending: 0, openCount: 0, openCents: 0, items: [] },
    awaitingPayment: { count: 0, amountCents: 0 },
    badges: [],
    reservation: null,
    debt: { cents: 0, customerName: null },
    archived: null,
    look: {},
    wallpaperUrl: null,
    desktopWallpaperUrl: null,
    createdAt: '2026-10-09T08:00:00.000Z',
    updatedAt: '2026-10-09T08:00:00.000Z',
    ...over,
  } as unknown as StationSummary;
}

const session = (over: Record<string, unknown> = {}) => ({
  id: 's-1',
  status: 'active',
  billingMode: 'postpaid',
  startedAt: '2026-10-09T14:26:00.000Z',
  endsAt: null,
  pausedAt: null,
  elapsedSeconds: 3600 + 34 * 60,
  currentPriceCents: 300,
  customerName: 'Besa',
  pcLabel: null,
  ...over,
});

describe('boardStateOf: the priority of the states', () => {
  it('shows a running session as active, and a paused one as paused', () => {
    expect(boardStateOf(pc({ status: 'occupied', activeSession: session() }), null)).toBe('active');
    expect(
      boardStateOf(pc({ status: 'paused', activeSession: session({ status: 'paused' }) }), null),
    ).toBe('paused');
  });

  it('shows a prepaid session with five minutes or less left as expiring', () => {
    expect(boardStateOf(pc({ activeSession: session() }), 300)).toBe('expiring');
    expect(boardStateOf(pc({ activeSession: session() }), 301)).toBe('active');
  });

  it('shows a waiting payment; an idle PC is never "debt" (0.33.4)', () => {
    const awaiting = pc({ awaitingPayment: { count: 1, amountCents: 450 }, debt: { cents: 900, customerName: 'X' } });
    expect(boardStateOf(awaiting, null)).toBe('awaiting');
    // Even if an older server still sent a debt for an idle PC, the card stays free.
    expect(boardStateOf(pc({ debt: { cents: 350, customerName: 'Besnik' } }), null)).toBe('free');
  });

  it('a reservation never changes what the PC card shows (0.33.4)', () => {
    const reservation = { reservationId: 'r', customerName: 'Ardit' };
    expect(boardStateOf(pc({ reservation }), null)).toBe('free');
    expect(boardStateOf(pc({ status: 'offline', reservation }), null)).toBe('offline');
    expect(boardStateOf(pc({ status: 'occupied', activeSession: session(), reservation }), null)).toBe('active');
  });

  it('reads a disabled PC as disabled, and a free one as free', () => {
    expect(boardStateOf(pc({ isEnabled: false, status: 'disabled' }), null)).toBe('disabled');
    expect(boardStateOf(pc(), null)).toBe('free');
  });
});

describe('describeStation', () => {
  it('names the PC after the session: the typed name first, then the customer, and nothing when idle', () => {
    const typed = describeStation(pc({ status: 'occupied', activeSession: session({ pcLabel: 'Turneu 1' }) }), 0, 0);
    expect(typed.pcName).toBe('Turneu 1');
    const customer = describeStation(pc({ status: 'occupied', activeSession: session() }), 0, 0);
    expect(customer.pcName).toBe('Besa');
    expect(describeStation(pc(), 0, 0).pcName).toBeNull();
  });

  it('adds the products and the total of the bill (gaming + products)', () => {
    const view = describeStation(
      pc({
        status: 'occupied',
        activeSession: session(),
        orders: {
          pending: 0,
          openCount: 1,
          openCents: 150,
          items: [{ name: 'Coca Cola', quantityMilli: 1000, amountCents: 150 }],
        },
      }),
      Date.parse('2026-10-09T15:00:00.000Z'),
      Date.parse('2026-10-09T15:00:00.000Z'),
    );
    expect(view.state).toBe('active');
    expect(view.totalCents).toBe(300 + 150);
    expect(view.products.map((p) => p.name)).toEqual(['Coca Cola']);
    expect(view.timerKind).toBe('elapsed');
    expect(view.customerName).toBe('Besa');
  });

  it('takes nothing from a reservation: the session of a walk-in does not get the booked name (0.33.4)', () => {
    const reservation = {
      reservationId: 'r1',
      customerName: 'Ardit',
      startsAt: '2026-10-09T18:00:00.000Z',
      windowEndsAt: '2026-10-09T18:05:00.000Z',
      toleranceMinutes: 5,
    };
    const idle = describeStation(pc({ reservation }), 0, Date.parse('2026-10-09T18:00:01.000Z'));
    expect(idle).not.toHaveProperty('hold');
    expect(idle.customerName).toBeNull();
    expect(idle.debtCustomerName).toBeNull();
    const walkIn = describeStation(
      pc({ status: 'occupied', activeSession: { ...session(), customerName: null, pcLabel: null }, reservation }),
      0,
      Date.parse('2026-10-09T18:00:01.000Z'),
    );
    expect(walkIn.customerName).toBeNull();
    expect(walkIn.pcName).toBeNull();
  });
});

describe('formatting', () => {
  it('writes durations the way the card line does', () => {
    expect(shortDuration(94 * 60)).toBe('1h34m');
    expect(shortDuration(45 * 60)).toBe('45m');
    expect(shortDuration(30)).toBe('30s');
  });

  it('writes the reservation countdown as 4m 59s', () => {
    expect(countdownLabel(299)).toBe('4m 59s');
    expect(countdownLabel(42)).toBe('42s');
    expect(countdownLabel(-5)).toBe('0s');
  });
});

describe('boardStats', () => {
  it('counts the PCs per state and takes the day figures from the dashboard', () => {
    const stations = [
      pc({ id: 'a', status: 'occupied', activeSession: session() }),
      pc({ id: 'b' }),
      pc({ id: 'c', awaitingPayment: { count: 1, amountCents: 300 } }),
      pc({ id: 'd', debt: { cents: 100, customerName: 'X' } }),
      pc({ id: 'e', reservation: { reservationId: 'r' } }),
      pc({ id: 'f', status: 'offline' }),
      pc({ id: 'g', status: 'occupied', activeSession: session(), debt: { cents: 250, customerName: 'Besa' } }),
    ];
    const stats = boardStats(stations, {
      revenue: { totalCents: 4200, productSalesCents: 0, gamingCents: 0, refundsCents: 0 },
      productUnitsSold: 7,
    });
    // d (an idle PC with a debt) and e (a booked PC) are simply free; g plays and owes.
    expect(stats).toEqual({
      active: 2,
      free: 3,
      awaiting: 1,
      debt: 1,
      revenueCents: 4200,
      productUnits: 7,
    });
  });
});

describe('groupByStart and the short line', () => {
  it('groups reservations by their booked time', () => {
    const groups = groupByStart(
      [
        { id: 1, startsAt: '2026-10-09T18:00:00.000Z' },
        { id: 2, startsAt: '2026-10-09T18:00:00.000Z' },
        { id: 3, startsAt: '2026-10-09T19:00:00.000Z' },
      ],
      'UTC',
    );
    expect(groups.map((g) => g.items.length)).toEqual([2, 1]);
  });

  it('builds the short line of a running PC, and of one that waits for its payment', () => {
    const labels = { state: 'Active', awaiting: 'Awaiting' };
    const money = (c: number) => `${(c / 100).toFixed(2)}€`;
    const running = describeStation(
      pc({
        status: 'occupied',
        activeSession: session(),
        orders: {
          pending: 0,
          openCount: 1,
          openCents: 150,
          items: [{ name: 'Coca Cola', quantityMilli: 1000, amountCents: 150 }],
        },
      }),
      Date.parse('2026-10-09T15:00:00.000Z'),
      Date.parse('2026-10-09T15:00:00.000Z'),
    );
    expect(shortLineParts(running, labels, money)).toEqual(['Active', '1h34m', 'Coca Cola', '4.50€']);

    const awaiting = describeStation(pc({ awaitingPayment: { count: 1, amountCents: 350 } }), 0, 0);
    expect(shortLineParts(awaiting, labels, money)).toEqual(['Awaiting', '3.50€']);
  });

  it('accepts only the four board views', () => {
    expect(isBoardView('detailed')).toBe(true);
    expect(isBoardView('tiles')).toBe(false);
  });
});
