/**
 * 0.31.0 — sale notifications for the phone and the tablet. 0.34.0 — every server event the owner
 * or an admin should see: PC sessions, PC requests and orders, reservations, staff sign-ins, debt
 * payments and low stock. Each notification follows a server event; nothing is decided on the
 * device. Sales that arrive together are grouped per cashier. While the APK is in the background the
 * notification is a system notification; while the app is open it is the in-app message.
 */
import { isStockSnoozed } from './stockData';
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  PROTOCOL_VERSION,
  type DebtChangedEvent,
  type LiveSale,
  type ReservationSummary,
  type ServerToAdminMessage,
  type SessionRequest,
  type SessionSummary,
  type StaffLoginEvent,
  type StationOrder,
  type StockLowEvent,
} from '@likapcs/shared';
import { api, getToken, money } from './api';
import { isNative } from './native';
import { ensureNativeAlerts, systemAlert } from './nativeAlerts';
import { buzz, playSound, type SoundKind } from './sound';
import { useNotify } from './notify';
import { useT, type TFunc } from './i18n';

const QUIET_MS = 2000;
const MAX_WAIT_MS = 5000;
/** A session that is already running when the app connects is not "started" again. */
const RECENT_MS = 60_000;


const qty = (milli: number) => String(Number((milli / 1000).toFixed(3)));
const itemText = (i: LiveSale['items'][number]) =>
  i.isTime ? i.name : `${i.name} ×${qty(i.quantityMilli)}`;
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Groups the sales of one burst by cashier and returns the text of each message. */
export function saleMessages(sales: LiveSale[], t: TFunc): string[] {
  const byCashier = new Map<string, LiveSale[]>();
  for (const s of sales) byCashier.set(s.cashierName, [...(byCashier.get(s.cashierName) ?? []), s]);
  return [...byCashier].map(([cashier, group]) => {
    const total = group.reduce((sum, s) => sum + s.totalCents, 0);
    const profit = group.reduce((sum, s) => sum + s.profitCents, 0);
    const noCost = group.some((s) => s.missingCost);
    const profitText = `${money(profit)}${noCost ? ` (${t('pa kosto')})` : ''}`;
    if (group.length === 1) {
      const [only] = group as [LiveSale];
      return t('{cashier} shiti {items} · {total} · fitimi {profit}', {
        cashier,
        items: only.items.map(itemText).join(', '),
        total: money(total),
        profit: profitText,
      });
    }
    return t('{cashier}: {count} shitje · {total} · fitimi {profit}', {
      cashier,
      count: group.length,
      total: money(total),
      profit: profitText,
    });
  });
}

/** The text of a session whose status just changed; null when there is nothing to say. */
export function sessionText(
  s: SessionSummary,
  previous: string | undefined,
  t: TFunc,
): string | null {
  if (previous === s.status) return null;
  const pc = s.stationCode;
  const who = s.pcLabel ?? s.customerName;
  switch (s.status) {
    case 'active':
      if (previous === 'paused') return t('{pc}: sesioni vazhdoi', { pc });
      return who
        ? t('{pc}: sesioni filloi · {who}', { pc, who })
        : t('{pc}: sesioni filloi', { pc });
    case 'paused':
      return t('{pc}: sesioni u pauzua', { pc });
    case 'completed':
      return t('{pc}: sesioni mbaroi · {total}', {
        pc,
        total: money(s.finalPriceCents ?? s.currentPriceCents),
      });
    case 'cancelled':
      return t('{pc}: sesioni u anulua', { pc });
    case 'expired':
      return t('{pc}: koha mbaroi', { pc });
    default:
      return null;
  }
}

/**
 * Mounted once, inside the NotifyProvider. It listens to the admin socket and turns each server
 * event into one message: a sale (grouped), a session change, a PC request or order, a reservation,
 * a staff sign-in, a debt payment, or a product under its minimum stock.
 */
export function LiveSalesListener({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  const notify = useNotify();
  const t = useT();
  const latest = useRef({ notify, t });
  latest.current = { notify, t };

  useEffect(() => {
    if (enabled) void ensureNativeAlerts();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let retry: number | null = null;
    let ping: number | null = null;
    let closed = false;
    let batch: LiveSale[] = [];
    let quiet: number | null = null;
    let cap: number | null = null;
    // What the listener has already announced, so a repeated event never speaks twice.
    const sessions = new Map<string, string>();
    const requests = new Set<string>();
    const orders = new Set<string>();
    const reservations = new Set<string>();
    let reservationsReady = false;

    /**
     * The in-app message and sound while the app is open; a system notification (with its own
     * sound) while it is in the background.
     */
    const announce = (text: string, kind: SoundKind = 'pc') => {
      if (isNative() && document.visibilityState === 'hidden') void systemAlert(text, kind);
      else {
        latest.current.notify(text, 'info');
        playSound(kind);
      }
    };

    const flush = () => {
      if (quiet) window.clearTimeout(quiet);
      if (cap) window.clearTimeout(cap);
      quiet = null;
      cap = null;
      const sales = batch;
      batch = [];
      if (sales.length === 0) return;
      announce(saleMessages(sales, latest.current.t).join('\n'), 'sale');
      buzz([80, 40, 80]);
    };

    const onSale = (sale: LiveSale) => {
      batch.push(sale);
      if (quiet) window.clearTimeout(quiet);
      quiet = window.setTimeout(flush, QUIET_MS);
      if (!cap) cap = window.setTimeout(flush, MAX_WAIT_MS);
    };

    const onSession = (s: SessionSummary) => {
      const previous = sessions.get(s.id);
      sessions.set(s.id, s.status);
      // The first sight of a session that started long ago is not a new start.
      if (
        previous === undefined &&
        s.status === 'active' &&
        Date.now() - new Date(s.startedAt).getTime() > RECENT_MS
      ) {
        return;
      }
      const text = sessionText(s, previous, latest.current.t);
      if (text) announce(text, 'pc');
      void qc.invalidateQueries({ queryKey: ['stations'] });
    };

    const onRequest = (r: SessionRequest) => {
      if (r.status !== 'pending' || requests.has(r.id)) return;
      requests.add(r.id);
      announce(
        latest.current.t('{pc} kërkon sesion · {who}', { pc: r.stationCode, who: r.customerName }),
        'call',
      );
    };

    const onOrder = (o: StationOrder) => {
      if (o.status !== 'pending' || orders.has(o.id)) return;
      orders.add(o.id);
      announce(
        latest.current.t('{pc}: porosi e re · {count} artikuj', {
          pc: o.stationCode,
          count: o.items.length,
        }),
        'call',
      );
    };

    const checkReservations = async () => {
      const now = Date.now();
      const from = new Date(now - 3_600_000).toISOString();
      const to = new Date(now + 2 * 86_400_000).toISOString();
      try {
        const { items } = await api<{ items: ReservationSummary[] }>(
          `/reservations?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        );
        for (const r of items) {
          if (reservations.has(r.id)) continue;
          reservations.add(r.id);
          // The first list only remembers what exists; it does not announce it.
          if (!reservationsReady || r.status !== 'scheduled') continue;
          announce(
            latest.current.t('Rezervim i ri: {name} · {time}', {
              name: r.customerName,
              time: clock(r.startsAt),
            }),
            'reservation',
          );
        }
        reservationsReady = true;
      } catch {
        // The next change tries again.
      }
    };

    const onStaffLogin = (p: StaffLoginEvent) => {
      const tr = latest.current.t;
      announce(
        tr('{name} u kyç nga {via}', {
          name: p.fullName,
          via: tr(p.via === 'phone' ? 'telefoni' : 'kompjuteri'),
        }),
        'staff',
      );
    };

    const onDebt = (p: DebtChangedEvent) => {
      const tr = latest.current.t;
      if (p.action === 'paid')
        announce(tr('Pagesë borxhi · {amount}', { amount: money(p.amountCents) }), 'debt');
      else if (p.action === 'rescheduled') announce(tr('Borxhi u rishikua'), 'debt');
      else announce(tr('Borxhi u fshi'), 'debt');
    };

    const onStock = (p: StockLowEvent) => {
      // The stock alarms can be paused from the stock settings; the list still refreshes.
      if (isStockSnoozed()) {
        void qc.invalidateQueries({ queryKey: ['phone', 'live'] });
        return;
      }
      // 0.34.x: an empty product says so; the rest keep the stock and the minimum.
      announce(
        p.stockMilli <= 0
          ? latest.current.t('Mbaroi stoku: {name}', { name: p.name })
          : latest.current.t('Stok i ulët: {name} · {stock} (min {min})', {
              name: p.name,
              stock: qty(p.stockMilli),
              min: qty(p.minStockMilli),
            }),
        'stock',
      );
      void qc.invalidateQueries({ queryKey: ['phone', 'live'] });
    };

    const connect = () => {
      const token = getToken();
      if (!token) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${proto}//${window.location.host}/ws/admin`);
      socket.onopen = () =>
        socket?.send(
          JSON.stringify({ type: 'admin.hello', token, protocolVersion: PROTOCOL_VERSION }),
        );
      socket.onmessage = (event) => {
        let message: ServerToAdminMessage;
        try {
          message = JSON.parse(event.data as string) as ServerToAdminMessage;
        } catch {
          return;
        }
        if (message.type === 'server.welcome') {
          ping = window.setInterval(
            () =>
              socket?.readyState === WebSocket.OPEN &&
              socket.send(JSON.stringify({ type: 'admin.ping' })),
            25_000,
          );
          void checkReservations();
          return;
        }
        if (message.type !== 'server.event') return;
        const p = message.payload;
        switch (message.event) {
          case 'live.sale':
            onSale(p as LiveSale);
            void qc.invalidateQueries({ queryKey: ['phone', 'live'] });
            break;
          case 'reports.changed':
            void qc.invalidateQueries({ queryKey: ['phone', 'live'] });
            break;
          case 'session.changed':
            onSession(p as SessionSummary);
            break;
          case 'request.changed':
            onRequest(p as SessionRequest);
            break;
          case 'order.changed':
            onOrder(p as StationOrder);
            break;
          case 'reservation.changed':
            void checkReservations();
            break;
          case 'staff.login':
            onStaffLogin(p as StaffLoginEvent);
            break;
          case 'debt.changed':
            onDebt(p as DebtChangedEvent);
            void qc.invalidateQueries({ queryKey: ['phone', 'live'] });
            break;
          case 'stock.low':
            onStock(p as StockLowEvent);
            break;
          default:
            break;
        }
      };
      socket.onclose = (event) => {
        if (ping) window.clearInterval(ping);
        ping = null;
        if (closed || event.code === 4001) return;
        retry = window.setTimeout(connect, 5_000);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      closed = true;
      if (retry) window.clearTimeout(retry);
      if (ping) window.clearInterval(ping);
      if (quiet) window.clearTimeout(quiet);
      if (cap) window.clearTimeout(cap);
      socket?.close();
    };
  }, [enabled, qc]);

  return null;
}
