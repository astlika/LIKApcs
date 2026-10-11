import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PROTOCOL_VERSION, type ServerToAdminMessage } from '@likapcs/shared';
import { getToken, websocketUrl } from './api';

export type LiveStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/** DOM event fired when the server reports a role-permission change (consumed by the auth state). */
export const PERMISSIONS_CHANGED_EVENT = 'likapcs:permissions-changed';

/**
 * Maintains the /ws/admin connection while the user is signed in. Server events invalidate the
 * relevant React Query caches so every screen refreshes without polling.
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
              void queryClient.invalidateQueries({ queryKey: ['stations'] });
              void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
              // Session bills land in the cash drawer.
              void queryClient.invalidateQueries({ queryKey: ['cash'] });
              break;
            case 'device.registered':
            case 'device.changed':
              void queryClient.invalidateQueries({ queryKey: ['devices'] });
              void queryClient.invalidateQueries({ queryKey: ['stations'] });
              void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
              break;
            case 'system.restored':
              // A backup was restored on the server: every cached view is stale.
              void queryClient.invalidateQueries();
              break;
            case 'permissions.changed':
              // A role was edited: the auth provider re-reads /auth/me so the navigation,
              // buttons and the home page follow the new permissions immediately.
              void queryClient.invalidateQueries({ queryKey: ['roles'] });
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
      socket?.close();
    };
  }, [enabled, queryClient]);

  return status;
}
