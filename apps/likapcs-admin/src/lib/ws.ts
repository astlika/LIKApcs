import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PROTOCOL_VERSION, type LiveSale, type ServerToAdminMessage } from '@likapcs/shared';
import { getToken, websocketUrl } from './api';
import { emitLiveSale } from './live';
import { createRefreshQueue } from './live-refresh';

export type LiveStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/** DOM event fired when the server reports a role-permission change (consumed by the auth state). */
export const PERMISSIONS_CHANGED_EVENT = 'likapcs:permissions-changed';

/**
 * Maintains the /ws/admin connection while the user is signed in. Server events invalidate the
 * relevant React Query caches so every screen refreshes without polling. 0.37.0: the lists to
 * refresh are gathered for a moment, so a burst of events refreshes each once (lib/live-refresh).
 */
export function useAdminSocket(enabled: boolean): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('disconnected');
  const queryClient = useQueryClient();
  const attempts = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setStatus('disconnected');
      return;
    }
    let socket: WebSocket | null = null;
    let closedByUs = false;
    let timer: number | null = null;
    let ping: number | null = null;
    const queue = createRefreshQueue((queryKey) => {
      void queryClient.invalidateQueries({ queryKey });
    });
    const refresh = queue.add;

    const connect = () => {
      const token = getToken();
      if (!token) return;
      setStatus(attempts.current === 0 ? 'connecting' : 'reconnecting');
      socket = new WebSocket(websocketUrl('/ws/admin'));
      socket.onopen = () => {
        socket?.send(
          JSON.stringify({ type: 'admin.hello', token, protocolVersion: PROTOCOL_VERSION }),
        );
      };
      socket.onmessage = (event) => {
        let message: ServerToAdminMessage;
        try {
          message = JSON.parse(event.data as string) as ServerToAdminMessage;
        } catch {
          return;
        }
        if (message.type === 'server.welcome') {
          attempts.current = 0;
          setStatus('connected');
          ping = window.setInterval(
            () =>
              socket?.readyState === WebSocket.OPEN &&
              socket.send(JSON.stringify({ type: 'admin.ping' })),
            25_000,
          );
          void queryClient.invalidateQueries({ queryKey: ['stations'] });
          return;
        }
        if (message.type === 'server.event') {
          switch (message.event) {
            case 'station.changed':
            case 'session.changed':
              // `cash`: session bills land in the cash drawer. `awaiting-payment`: an end-pay
              // session ended / was collected — the "to collect" strip follows.
              refresh(['stations'], ['dashboard'], ['cash'], ['sessions', 'awaiting-payment']);
              break;
            case 'device.registered':
            case 'device.changed':
              refresh(['devices'], ['stations'], ['dashboard']);
              break;
            case 'system.restored':
              // A backup was restored on the server: every cached view is stale.
              queue.clear();
              void queryClient.invalidateQueries();
              break;
            case 'request.changed':
              // A customer asked for time / staff answered: bell, PC tile and detail refresh.
              refresh(['session-requests'], ['stations']);
              break;
            case 'order.changed':
              // Drinks / snacks ordered from a PC, or decided: bell, orders page, PC tile, session.
              refresh(['orders'], ['stations'], ['sessions']);
              break;
            case 'reports.changed':
              // Money or stock moved: the summary, the staff report, the drawer and the dashboard follow.
              refresh(['reports'], ['cash'], ['dashboard'], ['live']);
              break;
            case 'reservation.changed':
              // 0.32.0: a PC reservation was booked, changed, cancelled or finished: the board follows.
              refresh(['reservations'], ['stations'], ['dashboard']);
              break;
            case 'live.sale':
              // 0.31.0: a sale for the live tracking page. Only admins with live.view get it.
              refresh(['live']);
              emitLiveSale(message.payload as LiveSale);
              break;
            case 'ads.changed':
              // A slide / album / promo changed: the ads page and the customer display follow.
              refresh(['ads'], ['display', 'feed'], ['products']);
              break;
            case 'permissions.changed':
              // A role was edited: the auth provider re-reads /auth/me so the navigation,
              // buttons and the home page follow the new permissions immediately.
              refresh(['roles']);
              window.dispatchEvent(new Event(PERMISSIONS_CHANGED_EVENT));
              break;
            default:
              break;
          }
        }
      };
      socket.onclose = (event) => {
        if (ping) window.clearInterval(ping);
        ping = null;
        if (closedByUs) return;
        if (event.code === 4001) {
          // Unauthorized: the HTTP layer will handle the sign-out on the next request.
          setStatus('disconnected');
          return;
        }
        attempts.current += 1;
        setStatus('reconnecting');
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts.current, 5));
        timer = window.setTimeout(connect, delay);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      closedByUs = true;
      if (timer) window.clearTimeout(timer);
      if (ping) window.clearInterval(ping);
      queue.stop();
      socket?.close();
    };
  }, [enabled, queryClient]);

  return status;
}
