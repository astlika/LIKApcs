/**
 * Hover preview on the Stations map: a small live picture (480p, same rate as the focus view)
 * of the PC under the mouse. One socket for the whole Stations page, opened on the first hover
 * and kept for the page's lifetime; the server stops the picture when the mouse moves on
 * (stream_stop) or the page closes (the socket closes and the server releases the view).
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PROTOCOL_VERSION, type ServerToAdminMessage, type StationSummary } from '@likapcs/shared';
import { getToken, websocketUrl } from '../../lib/api';
import { useI18n } from '../../i18n';

/** Picture size asked from the PC: 480p (853×480), the smallest focus size. */
const PREVIEW_RESOLUTION = '480p' as const;

type PreviewState = 'waiting' | 'live' | 'offline' | 'denied' | 'ended';

export interface LivePreviewFeed {
  stationId: string;
  jpeg: string;
  state: PreviewState;
}

/**
 * Shows the picture of `stationId` while `enabled` (the page sets it on the first hover and the
 * caller passes the hovered PC id, or null when nothing is hovered).
 */
export function useLivePreview(stationId: string | null, enabled: boolean): LivePreviewFeed | null {
  const [feed, setFeed] = useState<LivePreviewFeed | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  /** The PC this page has asked the server to show (null = none). */
  const askedRef = useRef<string | null>(null);

  const send = (payload: unknown) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
  };

  // Keep one connection while enabled; reconnect if it drops.
  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    let retry: number | undefined;

    const connect = () => {
      const token = getToken();
      if (!token) return;
      const socket = new WebSocket(websocketUrl('/ws/admin'));
      socketRef.current = socket;
      socket.onopen = () => {
        socket.send(
          JSON.stringify({ type: 'admin.hello', token, protocolVersion: PROTOCOL_VERSION }),
        );
      };
      socket.onmessage = (event) => {
        let message: ServerToAdminMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerToAdminMessage;
        } catch {
          return;
        }
        if (message.type === 'server.welcome') {
          // A new connection starts with nothing asked for: ask again for the PC under the mouse.
          const asked = askedRef.current;
          if (asked) {
            socket.send(
              JSON.stringify({
                type: 'admin.stream_start',
                stationId: asked,
                mode: 'focus',
                resolution: PREVIEW_RESOLUTION,
              }),
            );
          }
        } else if (message.type === 'server.frame') {
          const { stationId: id, jpeg } = message;
          if (id === askedRef.current) {
            setFeed({ stationId: id, jpeg, state: 'live' });
          }
        } else if (message.type === 'server.stream_status') {
          const { stationId: id, state } = message;
          if (id === askedRef.current) {
            setFeed((prev) =>
              prev && prev.stationId === id
                ? { ...prev, state: state as PreviewState }
                : { stationId: id, jpeg: '', state: state as PreviewState },
            );
          }
        }
      };
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (!closed) retry = window.setTimeout(connect, 3000);
      };
    };

    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, [enabled]);

  // Move the picture to the PC under the mouse: stop the previous one, start the new one.
  useEffect(() => {
    const next = enabled ? stationId : null;
    const prev = askedRef.current;
    if (prev === next) return;
    if (prev) send({ type: 'admin.stream_stop', stationId: prev });
    askedRef.current = next;
    setFeed(null);
    if (next) {
      send({
        type: 'admin.stream_start',
        stationId: next,
        mode: 'focus',
        resolution: PREVIEW_RESOLUTION,
      });
    }
    // send() only reads refs, so it is not a dependency.
  }, [stationId, enabled]);

  return feed && feed.stationId === stationId ? feed : null;
}

const CARD_WIDTH = 320;
const LABEL_HEIGHT = 26;

/** The small card, next to the hovered tile. Never takes the mouse (pointer-events: none). */
export function LivePreviewCard({
  station,
  rect,
  feed,
}: {
  station: StationSummary;
  rect: DOMRect;
  feed: LivePreviewFeed | null;
}) {
  const { t } = useI18n();
  const height = Math.round((CARD_WIDTH * 9) / 16) + LABEL_HEIGHT;
  const gap = 8;
  let top = rect.top - height - gap;
  if (top < 8) top = rect.bottom + gap;
  const centre = rect.left + rect.width / 2 - CARD_WIDTH / 2;
  const left = Math.min(Math.max(8, centre), window.innerWidth - CARD_WIDTH - 8);

  const state = feed?.state ?? 'waiting';
  const stateText =
    state === 'live'
      ? t('remote.live')
      : state === 'offline'
        ? t('remote.offline')
        : state === 'denied'
          ? t('remote.denied')
          : t('remote.waiting');

  return createPortal(
    <div
      role="tooltip"
      data-testid="live-preview"
      style={{
        position: 'fixed',
        top,
        left,
        width: CARD_WIDTH,
        zIndex: 1000,
        pointerEvents: 'none',
        background: '#111',
        color: '#fff',
        borderRadius: 8,
        overflow: 'hidden',
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
      }}
    >
      <div
        style={{
          height: Math.round((CARD_WIDTH * 9) / 16),
          display: 'grid',
          placeItems: 'center',
          background: '#000',
        }}
      >
        {state === 'live' && feed?.jpeg ? (
          <img
            alt=""
            src={`data:image/jpeg;base64,${feed.jpeg}`}
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
          />
        ) : (
          <span style={{ fontSize: 12, opacity: 0.7 }}>{stateText}</span>
        )}
      </div>
      <div
        style={{
          height: LABEL_HEIGHT,
          lineHeight: `${LABEL_HEIGHT}px`,
          padding: '0 10px',
          fontSize: 12,
          display: 'flex',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {station.code}
        </strong>
        <span style={{ opacity: 0.8 }}>{stateText}</span>
      </div>
    </div>,
    document.body,
  );
}
