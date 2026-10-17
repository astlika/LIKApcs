/**
 * Live screens (remote view, phase 1): a grid of thumbnails of every station PC, and a focus view
 * of one PC at up to 3 frames per second. Read-only. Frames are only requested while this page is
 * open, and every station this page asked for is released when it closes.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  PERMISSIONS,
  PROTOCOL_VERSION,
  type ServerToAdminMessage,
  type StationSummary,
} from '@likapcs/shared';
import { api, getToken, websocketUrl } from '../lib/api';
import { PageHeader } from '../components/ui/primitives';
import { useAuth } from '../state/auth';
import { useI18n } from '../i18n';

type Mode = 'thumb' | 'focus';
type Link = 'connecting' | 'connected' | 'disconnected';
type PcState = 'live' | 'offline' | 'denied' | 'waiting';

interface Feed {
  jpeg: string;
  ts: string;
}

export function RemotePage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const allowed = can(PERMISSIONS.REMOTE_VIEW);

  const stations = useQuery({
    queryKey: ['stations', false],
    queryFn: () => api<StationSummary[]>('/stations', { query: { includeArchived: false } }),
    enabled: allowed,
  });
  const ids = useMemo(() => (stations.data ?? []).map((s) => s.id), [stations.data]);
  const idKey = ids.join(',');
  const [focusId, setFocusId] = useState<string | null>(null);

  const [link, setLink] = useState<Link>('connecting');
  const [feeds, setFeeds] = useState<Record<string, Feed>>({});
  const [states, setStates] = useState<Record<string, PcState>>({});
  const socketRef = useRef<WebSocket | null>(null);
  /** What this page has asked the server for, per station (so only changes are sent). */
  const askedRef = useRef<Map<string, Mode>>(new Map());

  // One /ws/admin connection for this page; reconnects if it drops.
  useEffect(() => {
    if (!allowed) return;
    let closed = false;
    let retry: number | undefined;

    const connect = () => {
      const token = getToken();
      if (!token) return;
      const socket = new WebSocket(websocketUrl('/ws/admin'));
      socketRef.current = socket;
      setLink('connecting');
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
          // A new connection starts with nothing asked for on the server side.
          askedRef.current.clear();
          setLink('connected');
        } else if (message.type === 'server.frame') {
          const { stationId, jpeg, ts } = message;
          setFeeds((prev) => ({ ...prev, [stationId]: { jpeg, ts } }));
          setStates((prev) =>
            prev[stationId] === 'live' ? prev : { ...prev, [stationId]: 'live' },
          );
        } else if (message.type === 'server.stream_status') {
          const { stationId, state } = message;
          setStates((prev) => ({ ...prev, [stationId]: state }));
        }
      };
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        setLink('disconnected');
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
  }, [allowed]);

  // Ask for what is on screen: thumbnails for the grid, one focused view. Only changes are sent.
  useEffect(() => {
    const socket = socketRef.current;
    if (link !== 'connected' || !socket || socket.readyState !== socket.OPEN) return;
    const asked = askedRef.current;
    const want = new Map<string, Mode>(ids.map((id) => [id, id === focusId ? 'focus' : 'thumb']));
    for (const [stationId, mode] of want) {
      if (asked.get(stationId) === mode) continue;
      socket.send(JSON.stringify({ type: 'admin.stream_start', stationId, mode }));
      asked.set(stationId, mode);
    }
    for (const stationId of [...asked.keys()]) {
      if (want.has(stationId)) continue;
      socket.send(JSON.stringify({ type: 'admin.stream_stop', stationId }));
      asked.delete(stationId);
    }
  }, [idKey, focusId, link, ids]);

  if (!allowed) {
    return (
      <>
        <PageHeader title={t('remote.title')} subtitle={t('remote.noPermission')} />
      </>
    );
  }

  const linkLabel =
    link === 'connected'
      ? t('remote.live')
      : link === 'connecting'
        ? t('remote.connecting')
        : t('remote.disconnected');

  const focused = focusId ? (stations.data ?? []).find((s) => s.id === focusId) : undefined;

  return (
    <>
      <PageHeader title={t('remote.title')} subtitle={t('remote.subtitle')} />
      <p className="muted" style={{ margin: '0 0 12px' }}>
        {linkLabel}
      </p>

      {focused ? (
        <section>
          <button type="button" className="btn btn--ghost" onClick={() => setFocusId(null)}>
            ← {t('remote.back')}
          </button>
          <h2 style={{ margin: '12px 0 4px' }}>{focused.name}</h2>
          <p className="muted" style={{ margin: '0 0 8px' }}>
            {stateLabel(states[focused.id] ?? 'waiting', t)} · {t('remote.focusHint')}
          </p>
          <Screen feed={feeds[focused.id]} state={states[focused.id] ?? 'waiting'} t={t} large />
        </section>
      ) : (
        <section>
          <p className="muted" style={{ margin: '0 0 12px' }}>
            {t('remote.gridHint')}
          </p>
          {ids.length === 0 ? (
            <p className="muted">{t('remote.noStations')}</p>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                gap: 12,
              }}
            >
              {(stations.data ?? []).map((station) => (
                <button
                  key={station.id}
                  type="button"
                  onClick={() => setFocusId(station.id)}
                  style={{
                    background: 'transparent',
                    border: '1px solid var(--border, #334)',
                    borderRadius: 8,
                    padding: 8,
                    textAlign: 'left',
                    cursor: 'pointer',
                    color: 'inherit',
                  }}
                >
                  <Screen feed={feeds[station.id]} state={states[station.id] ?? 'waiting'} t={t} />
                  <div style={{ marginTop: 6, fontWeight: 600 }}>{station.name}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {stateLabel(states[station.id] ?? 'waiting', t)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}

function stateLabel(state: PcState, t: ReturnType<typeof useI18n>['t']): string {
  switch (state) {
    case 'live':
      return t('remote.live');
    case 'offline':
      return t('remote.offline');
    case 'denied':
      return t('remote.denied');
    default:
      return t('remote.waiting');
  }
}

function Screen({
  feed,
  state,
  t,
  large = false,
}: {
  feed: Feed | undefined;
  state: PcState;
  t: ReturnType<typeof useI18n>['t'];
  large?: boolean;
}) {
  const box = {
    width: '100%',
    aspectRatio: '16 / 9',
    borderRadius: 6,
    background: '#0b0f14',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    color: '#8b96a5',
    fontSize: large ? 16 : 12,
  } as const;
  if (feed && state !== 'offline') {
    return (
      <div style={box}>
        <img
          alt=""
          src={`data:image/jpeg;base64,${feed.jpeg}`}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      </div>
    );
  }
  return <div style={box}>{state === 'offline' ? t('remote.offline') : t('remote.waiting')}</div>;
}
