/**
 * Live screens (remote view and control): a grid of thumbnails of every station PC, and a focus
 * view of one PC at up to 3 frames per second. In focus view the Admin can turn control on: the
 * mouse and keyboard then go to the PC. Frames are only requested while this page is open, and
 * everything this page asked for is released when it closes.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  PERMISSIONS,
  PROTOCOL_VERSION,
  REMOTE_DEFAULT_RESOLUTION,
  REMOTE_RESOLUTIONS,
  type RemoteResolution,
  type ServerToAdminMessage,
  type StationSummary,
} from '@likapcs/shared';
import { api, getToken, websocketUrl } from '../lib/api';
import { PageHeader } from '../components/ui/primitives';
import { useAuth } from '../state/auth';
import { useI18n } from '../i18n';

type Mode = 'thumb' | 'focus';
type Link = 'connecting' | 'connected' | 'disconnected';
type PcState = 'live' | 'offline' | 'denied' | 'ended' | 'waiting';
type T = ReturnType<typeof useI18n>['t'];

interface Feed {
  jpeg: string;
  ts: string;
}

/** MouseEvent.button → protocol button name (0 left, 1 middle, 2 right). */
const BUTTONS = ['left', 'middle', 'right'] as const;
const MOVE_INTERVAL_MS = 50;

export function RemotePage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const allowed = can(PERMISSIONS.REMOTE_VIEW);
  const canControl = can(PERMISSIONS.REMOTE_CONTROL);

  const stations = useQuery({
    queryKey: ['stations', false],
    queryFn: () => api<StationSummary[]>('/stations', { query: { includeArchived: false } }),
    enabled: allowed,
  });
  const ids = useMemo(() => (stations.data ?? []).map((s) => s.id), [stations.data]);
  const idKey = ids.join(',');
  // Opened from the Stations page context menu: ?focus=<id> starts in focus view of that PC.
  const [params, setParams] = useSearchParams();
  const [focusId, setFocusId] = useState<string | null>(() => params.get('focus'));
  useEffect(() => {
    if (params.has('focus')) setParams({}, { replace: true });
  }, [params, setParams]);

  const [link, setLink] = useState<Link>('connecting');
  const [feeds, setFeeds] = useState<Record<string, Feed>>({});
  const [states, setStates] = useState<Record<string, PcState>>({});
  const [controlOn, setControlOn] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  /** What this page has asked the server for, per station: `thumb` or `focus:<resolution>`. */
  const askedRef = useRef<Map<string, string>>(new Map());
  const [resolution, setResolution] = useState<RemoteResolution>(REMOTE_DEFAULT_RESOLUTION);
  /** Keys and buttons this page has pressed on the PC; released when control stops. */
  const heldKeysRef = useRef<Set<string>>(new Set());
  const heldButtonsRef = useRef<Set<number>>(new Set());
  const lastMoveRef = useRef(0);
  const focusRef = useRef<string | null>(null);
  focusRef.current = focusId;
  const controlRef = useRef(false);
  controlRef.current = controlOn;

  const sendNow = (payload: unknown) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
  };

  /** Ends control: releases every key and button still held, then tells the server. */
  const stopControl = (stationId: string | null) => {
    if (stationId) {
      for (const code of heldKeysRef.current) {
        sendNow({ type: 'admin.input', stationId, event: { kind: 'key', code, down: false } });
      }
      for (const button of heldButtonsRef.current) {
        sendNow({
          type: 'admin.input',
          stationId,
          event: { kind: 'button', button: BUTTONS[button] ?? 'left', down: false },
        });
      }
      sendNow({ type: 'admin.control', stationId, on: false });
    }
    heldKeysRef.current.clear();
    heldButtonsRef.current.clear();
    setControlOn(false);
  };

  // Leaving the page must never leave control on, or a key pressed on the PC. This effect is
  // declared before the socket effect, so on unmount it runs while the socket is still open.
  useEffect(() => {
    return () => {
      if (controlRef.current) stopControl(focusRef.current);
    };
    // stopControl only reads refs, so it is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          // The view ended on the server (session over): it is asked again only if something changes.
          if (state === 'ended') askedRef.current.delete(stationId);
        } else if (message.type === 'server.error') {
          // Control refused (no permission, not in focus view, or no longer under control).
          setControlError(message.message);
          setControlOn(false);
          heldKeysRef.current.clear();
          heldButtonsRef.current.clear();
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
    const want = new Map<string, string>(
      ids.map((id) => [id, id === focusId ? `focus:${resolution}` : 'thumb']),
    );
    for (const [stationId, key] of want) {
      if (asked.get(stationId) === key) continue;
      const [mode, res] = key.split(':') as [Mode, RemoteResolution | undefined];
      socket.send(
        JSON.stringify({
          type: 'admin.stream_start',
          stationId,
          mode,
          ...(res ? { resolution: res } : {}),
        }),
      );
      asked.set(stationId, key);
    }
    for (const stationId of [...asked.keys()]) {
      if (want.has(stationId)) continue;
      socket.send(JSON.stringify({ type: 'admin.stream_stop', stationId }));
      asked.delete(stationId);
    }
  }, [idKey, focusId, link, ids, resolution]);

  // Keyboard while controlling: every key goes to the PC, and the browser's own shortcuts are off.
  useEffect(() => {
    if (!controlOn || !focusId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      const down = e.type === 'keydown';
      if (down && e.repeat) return;
      if (down) heldKeysRef.current.add(e.code);
      else heldKeysRef.current.delete(e.code);
      sendNow({
        type: 'admin.input',
        stationId: focusId,
        event: { kind: 'key', code: e.code, down },
      });
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
    // sendNow only reads the socket ref.
  }, [controlOn, focusId]);

  const leaveFocus = () => {
    stopControl(focusId);
    setControlError(null);
    setFocusId(null);
  };

  const toggleControl = () => {
    if (!focusId) return;
    if (controlOn) {
      stopControl(focusId);
      return;
    }
    setControlError(null);
    setControlOn(true);
    sendNow({ type: 'admin.control', stationId: focusId, on: true });
  };

  if (!allowed) {
    return <PageHeader title={t('remote.title')} subtitle={t('remote.noPermission')} />;
  }

  const linkLabel =
    link === 'connected'
      ? t('remote.live')
      : link === 'connecting'
        ? t('remote.connecting')
        : t('remote.disconnected');

  const focused = focusId ? (stations.data ?? []).find((s) => s.id === focusId) : undefined;
  const focusedState = focused ? (states[focused.id] ?? 'waiting') : 'waiting';

  return (
    <>
      <PageHeader title={t('remote.title')} subtitle={t('remote.subtitle')} />
      <p className="muted" style={{ margin: '0 0 12px' }}>
        {linkLabel}
      </p>

      {focused ? (
        <section>
          <button type="button" className="btn btn--ghost" onClick={leaveFocus}>
            ← {t('remote.back')}
          </button>
          <h2 style={{ margin: '12px 0 4px' }}>{focused.name}</h2>
          <p className="muted" style={{ margin: '0 0 8px' }}>
            {stateLabel(focusedState, t)} · {t('remote.focusHint')}
          </p>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              margin: '0 0 8px',
              flexWrap: 'wrap',
            }}
          >
            <label htmlFor="remote-resolution" className="muted">
              {t('remote.resolution')}
            </label>
            <select
              id="remote-resolution"
              value={resolution}
              onChange={(e) => setResolution(e.target.value as RemoteResolution)}
            >
              {REMOTE_RESOLUTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            {resolution === '1080p' && <span className="muted">{t('remote.heavy')}</span>}
          </div>
          {canControl && (
            <div
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                margin: '0 0 8px',
                flexWrap: 'wrap',
              }}
            >
              <button
                type="button"
                className={controlOn ? 'btn btn--danger' : 'btn'}
                onClick={toggleControl}
                disabled={focusedState !== 'live'}
              >
                {controlOn ? t('remote.controlStop') : t('remote.control')}
              </button>
              {controlOn && <span className="muted">{t('remote.controlHint')}</span>}
              {controlError && <span style={{ color: '#e5484d' }}>{controlError}</span>}
            </div>
          )}
          <div
            onMouseMove={controlOn ? (e) => pointerMove(e, focused.id) : undefined}
            onMouseDown={controlOn ? (e) => pointerButton(e, focused.id, true) : undefined}
            onMouseUp={controlOn ? (e) => pointerButton(e, focused.id, false) : undefined}
            onWheel={controlOn ? (e) => pointerWheel(e, focused.id) : undefined}
            onContextMenu={controlOn ? (e) => e.preventDefault() : undefined}
          >
            <Screen feed={feeds[focused.id]} state={focusedState} t={t} large />
          </div>
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
              {(stations.data ?? []).map((station) => {
                const state = states[station.id] ?? 'waiting';
                return (
                  <button
                    key={station.id}
                    type="button"
                    onClick={() => {
                      setControlError(null);
                      setFocusId(station.id);
                    }}
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
                    <Screen feed={feeds[station.id]} state={state} t={t} />
                    <div style={{ marginTop: 6, fontWeight: 600 }}>{station.name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {stateLabel(state, t)}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      )}
    </>
  );

  // Pointer and wheel: positions are sent as fractions of the picture, never as pixels.
  function pointerMove(e: ReactMouseEvent<HTMLDivElement>, stationId: string) {
    const now = Date.now();
    if (now - lastMoveRef.current < MOVE_INTERVAL_MS) return;
    const p = pointerFraction(e);
    if (!p) return;
    lastMoveRef.current = now;
    sendNow({ type: 'admin.input', stationId, event: { kind: 'move', x: p.x, y: p.y } });
  }

  function pointerButton(e: ReactMouseEvent<HTMLDivElement>, stationId: string, down: boolean) {
    e.preventDefault();
    const button = BUTTONS[e.button];
    if (!button) return;
    if (down) {
      const p = pointerFraction(e);
      if (!p) return;
      // Move first, so the click lands where the pointer is.
      sendNow({ type: 'admin.input', stationId, event: { kind: 'move', x: p.x, y: p.y } });
      heldButtonsRef.current.add(e.button);
    } else {
      heldButtonsRef.current.delete(e.button);
    }
    sendNow({ type: 'admin.input', stationId, event: { kind: 'button', button, down } });
  }

  function pointerWheel(e: ReactWheelEvent<HTMLDivElement>, stationId: string) {
    // Browser: positive deltaY scrolls down. Windows: positive wheel scrolls up.
    const delta = Math.max(-1200, Math.min(1200, Math.round(-e.deltaY)));
    if (delta === 0) return;
    sendNow({ type: 'admin.input', stationId, event: { kind: 'wheel', delta } });
  }
}

/** Pointer position as a fraction of the picture (the picture is letterboxed inside its box). */
function pointerFraction(e: ReactMouseEvent<HTMLDivElement>): { x: number; y: number } | null {
  const img = e.currentTarget.querySelector('img');
  if (!img || !img.naturalWidth || !img.naturalHeight) return null;
  const box = img.getBoundingClientRect();
  const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  const left = box.left + (box.width - w) / 2;
  const top = box.top + (box.height - h) / 2;
  const x = (e.clientX - left) / w;
  const y = (e.clientY - top) / h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

function stateLabel(state: PcState, t: T): string {
  switch (state) {
    case 'live':
      return t('remote.live');
    case 'offline':
      return t('remote.offline');
    case 'denied':
      return t('remote.denied');
    case 'ended':
      return t('remote.ended');
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
  t: T;
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
  if (feed && state === 'live') {
    return (
      <div style={box}>
        <img
          alt=""
          draggable={false}
          src={`data:image/jpeg;base64,${feed.jpeg}`}
          style={{ width: '100%', height: '100%', objectFit: 'contain', userSelect: 'none' }}
        />
      </div>
    );
  }
  return <div style={box}>{stateLabel(state, t)}</div>;
}
