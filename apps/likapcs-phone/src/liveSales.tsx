/**
 * 0.31.0 — sale notifications for the phone and the tablet (admins with live.view only; the
 * server never sends `live.sale` to anyone else). Sales that arrive together are grouped per
 * cashier, shown as one message, with a short vibration and chime. Works only while the app is
 * open: a closed app cannot be woken without a native notification (not part of this version).
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PROTOCOL_VERSION, type LiveSale, type ServerToAdminMessage } from '@likapcs/shared';
import { getToken, money } from './api';
import { useNotify } from './notify';
import { useT, type TFunc } from './i18n';

const QUIET_MS = 2000;
const MAX_WAIT_MS = 5000;

function chime(): void {
  try {
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    window.setTimeout(() => void ctx.close(), 600);
  } catch {
    // Sound may be blocked until the first tap; the message still shows.
  }
}

const qty = (milli: number) => String(Number((milli / 1000).toFixed(3)));
const itemText = (i: LiveSale['items'][number]) => (i.isTime ? i.name : `${i.name} ×${qty(i.quantityMilli)}`);

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

/**
 * Mounted once, inside the NotifyProvider. It listens to the admin socket and, for each completed
 * sale, shows the message, vibrates, plays the chime and refreshes the live screen.
 */
export function LiveSalesListener({ enabled }: { enabled: boolean }) {
  const qc = useQueryClient();
  const notify = useNotify();
  const t = useT();
  const latest = useRef({ notify, t });
  latest.current = { notify, t };

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let retry: number | null = null;
    let ping: number | null = null;
    let closed = false;
    let batch: LiveSale[] = [];
    let quiet: number | null = null;
    let cap: number | null = null;

    const flush = () => {
      if (quiet) window.clearTimeout(quiet);
      if (cap) window.clearTimeout(cap);
      quiet = null;
      cap = null;
      const sales = batch;
      batch = [];
      if (sales.length === 0) return;
      const { notify: say, t: tr } = latest.current;
      say(saleMessages(sales, tr).join('\n'), 'ok');
      try {
        navigator.vibrate?.([80, 40, 80]);
      } catch {
        // Not every device vibrates.
      }
      chime();
    };

    const onSale = (sale: LiveSale) => {
      batch.push(sale);
      if (quiet) window.clearTimeout(quiet);
      quiet = window.setTimeout(flush, QUIET_MS);
      if (!cap) cap = window.setTimeout(flush, MAX_WAIT_MS);
    };

    const connect = () => {
      const token = getToken();
      if (!token) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${proto}//${window.location.host}/ws/admin`);
      socket.onopen = () =>
        socket?.send(JSON.stringify({ type: 'admin.hello', token, protocolVersion: PROTOCOL_VERSION }));
      socket.onmessage = (event) => {
        let message: ServerToAdminMessage;
        try {
          message = JSON.parse(event.data as string) as ServerToAdminMessage;
        } catch {
          return;
        }
        if (message.type === 'server.welcome') {
          ping = window.setInterval(
            () => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'admin.ping' })),
            25_000,
          );
          return;
        }
        if (message.type !== 'server.event') return;
        if (message.event === 'live.sale') {
          onSale(message.payload as LiveSale);
          void qc.invalidateQueries({ queryKey: ['phone', 'live'] });
        } else if (message.event === 'reports.changed') {
          void qc.invalidateQueries({ queryKey: ['phone', 'live'] });
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
