/**
 * Pure protocol logic of the LIKApcs-Client — no I/O, fully unit-tested.
 *
 *  - CommandGuard: exactly-once / in-order / not-expired acceptance of server commands.
 *  - Clock: the server clock is authoritative; we only keep an offset to the local clock.
 *  - reduce(): applies welcome data and commands to the client state and returns the side
 *    effects the shell has to perform (power actions, update, lock/unlock the window…).
 */
import type { ServerCommand, ServerWelcomeToClient } from '@likapcs/shared';

// ─── Command guard ──────────────────────────────────────────────────────────────
export type GuardDecision =
  | { accept: true }
  | { accept: false; reason: 'duplicate' | 'out_of_order' | 'expired' | 'future_dated' };

export class CommandGuard {
  private readonly seen: string[] = [];
  private readonly seenSet = new Set<string>();
  private lastSeq = 0;

  constructor(private readonly maxRemembered = 500) {}

  /** `serverNowMs` must be the current time on the server clock (see Clock). */
  check(command: ServerCommand, serverNowMs: number): GuardDecision {
    if (this.seenSet.has(command.commandId)) return { accept: false, reason: 'duplicate' };
    if (command.seq <= this.lastSeq) return { accept: false, reason: 'out_of_order' };
    const expires = Date.parse(command.expiresAt);
    const issued = Date.parse(command.issuedAt);
    if (!Number.isFinite(expires) || expires < serverNowMs)
      return { accept: false, reason: 'expired' };
    // Tolerate small skew, but refuse commands claiming to come from far in the future.
    if (Number.isFinite(issued) && issued - serverNowMs > 120_000)
      return { accept: false, reason: 'future_dated' };
    this.remember(command.commandId);
    this.lastSeq = command.seq;
    return { accept: true };
  }

  private remember(id: string): void {
    this.seen.push(id);
    this.seenSet.add(id);
    if (this.seen.length > this.maxRemembered) {
      const oldest = this.seen.shift();
      if (oldest) this.seenSet.delete(oldest);
    }
  }
}

// ─── Clock ──────────────────────────────────────────────────────────────────────
export class Clock {
  private offsetMs = 0;
  private synced = false;

  /** Call with every server timestamp we receive (welcome, heartbeat acks). */
  sync(serverTimeIso: string, localNowMs = Date.now()): void {
    const server = Date.parse(serverTimeIso);
    if (!Number.isFinite(server)) return;
    this.offsetMs = server - localNowMs;
    this.synced = true;
  }
  now(localNowMs = Date.now()): number {
    return localNowMs + this.offsetMs;
  }
  get isSynced(): boolean {
    return this.synced;
  }
  get offset(): number {
    return this.offsetMs;
  }
}

// ─── State ──────────────────────────────────────────────────────────────────────
export interface SessionState {
  id: string;
  status: 'active' | 'paused';
  startedAt: string;
  /** null = open-ended (postpaid) session: the overlay shows elapsed time instead of a countdown. */
  endsAt: string | null;
  pausedAt: string | null;
  /** Remaining seconds frozen at pause time (paused sessions do not count down). */
  remainingAtPauseSeconds: number | null;
}

export interface Notice {
  id: string;
  text: string;
  untilServerMs: number;
}

export type Mode = 'locked' | 'session' | 'free';

/** Staff unlock (maintenance): the PC is open without a session until `untilServerMs`. */
export interface MaintenanceState {
  untilServerMs: number;
  byName: string | null;
}

export interface ClientState {
  mode: Mode;
  session: SessionState | null;
  maintenance: MaintenanceState | null;
  notice: Notice | null;
  station: ServerWelcomeToClient['station'] | null;
  businessName: string;
  welcomeMessage: string;
  language: 'en' | 'sq';
}

export const initialState: ClientState = {
  mode: 'locked',
  session: null,
  maintenance: null,
  notice: null,
  station: null,
  businessName: '',
  welcomeMessage: '',
  language: 'en',
};

export type Effect =
  | { type: 'power'; action: 'restart' | 'shutdown' }
  | { type: 'update' }
  | {
      type: 'event';
      event: 'locked' | 'unlocked' | 'maintenance_ended';
      payload?: Record<string, unknown>;
    };

export interface ReduceResult {
  state: ClientState;
  effects: Effect[];
  /** false → the command is acknowledged with ok=false and this error text. */
  ok: boolean;
  error?: string;
}

function sessionFromWelcome(w: ServerWelcomeToClient['session']): SessionState | null {
  if (!w) return null;
  return {
    id: w.id,
    status: w.status,
    startedAt: w.startedAt,
    endsAt: w.endsAt,
    pausedAt: w.pausedAt,
    remainingAtPauseSeconds: w.status === 'paused' ? w.remainingSeconds : null,
  };
}

function maintenanceFrom(
  until: string | null | undefined,
  byName: string | null | undefined,
  serverNowMs: number,
): MaintenanceState | null {
  const untilMs = until ? Date.parse(until) : NaN;
  if (!Number.isFinite(untilMs) || untilMs <= serverNowMs) return null;
  return { untilServerMs: untilMs, byName: byName ?? null };
}

/** Applies the authoritative snapshot sent right after the handshake. */
export function applyWelcome(state: ClientState, welcome: ServerWelcomeToClient): ClientState {
  const session = sessionFromWelcome(welcome.session);
  const serverNowMs = Date.parse(welcome.serverTime);
  const maintenance = session
    ? null
    : maintenanceFrom(welcome.maintenance?.until, welcome.maintenance?.byName, serverNowMs);
  return {
    ...state,
    station: welcome.station,
    businessName: welcome.businessName,
    welcomeMessage: welcome.welcomeMessage,
    language: welcome.language,
    session,
    maintenance,
    // No session ⇒ locked — unless the server itself says a staff maintenance unlock is still in
    // force (it recorded that grant; a reconnect never invents an unlock on its own).
    mode: session ? 'session' : maintenance ? 'free' : 'locked',
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function reduce(
  state: ClientState,
  command: ServerCommand,
  serverNowMs: number,
): ReduceResult {
  const p = command.payload ?? {};
  switch (command.command) {
    case 'lock':
      return {
        state: { ...state, mode: 'locked', session: null, maintenance: null },
        effects: [{ type: 'event', event: 'locked', payload: { reason: str(p.reason) } }],
        ok: true,
      };
    case 'unlock': {
      // Time-limited by the server (maintenance grant); without `until` the old open-ended form.
      const maintenance = maintenanceFrom(str(p.until), str(p.byName), serverNowMs) ?? {
        untilServerMs: Number.POSITIVE_INFINITY,
        byName: str(p.byName),
      };
      return {
        state: { ...state, mode: 'free', session: null, maintenance },
        effects: [{ type: 'event', event: 'unlocked', payload: { reason: 'staff' } }],
        ok: true,
      };
    }
    case 'session.start': {
      const id = str(p.sessionId);
      const startedAt = str(p.startedAt) ?? new Date(serverNowMs).toISOString();
      if (!id) return { state, effects: [], ok: false, error: 'sessionId missing' };
      const endsAt = str(p.endsAt);
      if (endsAt && Date.parse(endsAt) <= serverNowMs)
        return { state, effects: [], ok: false, error: 'session already over' };
      return {
        state: {
          ...state,
          mode: 'session',
          maintenance: null,
          session: {
            id,
            status: 'active',
            startedAt,
            endsAt,
            pausedAt: null,
            remainingAtPauseSeconds: null,
          },
        },
        effects: [{ type: 'event', event: 'unlocked', payload: { sessionId: id } }],
        ok: true,
      };
    }
    case 'session.pause': {
      if (!state.session || state.session.id !== str(p.sessionId))
        return { state, effects: [], ok: false, error: 'no matching session' };
      const remaining = state.session.endsAt
        ? Math.max(0, Math.round((Date.parse(state.session.endsAt) - serverNowMs) / 1000))
        : null;
      return {
        state: {
          ...state,
          session: {
            ...state.session,
            status: 'paused',
            pausedAt: new Date(serverNowMs).toISOString(),
            remainingAtPauseSeconds: num(p.remainingSeconds) ?? remaining,
          },
        },
        effects: [],
        ok: true,
      };
    }
    case 'session.resume': {
      if (!state.session || state.session.id !== str(p.sessionId))
        return { state, effects: [], ok: false, error: 'no matching session' };
      return {
        state: {
          ...state,
          mode: 'session',
          session: {
            ...state.session,
            status: 'active',
            pausedAt: null,
            endsAt: str(p.endsAt) ?? state.session.endsAt,
            remainingAtPauseSeconds: null,
          },
        },
        effects: [],
        ok: true,
      };
    }
    case 'session.extend': {
      if (!state.session || state.session.id !== str(p.sessionId))
        return { state, effects: [], ok: false, error: 'no matching session' };
      const endsAt = str(p.endsAt);
      if (!endsAt) return { state, effects: [], ok: false, error: 'endsAt missing' };
      return { state: { ...state, session: { ...state.session, endsAt } }, effects: [], ok: true };
    }
    case 'session.end':
      return {
        state: { ...state, mode: 'locked', session: null },
        effects: [{ type: 'event', event: 'locked', payload: { sessionId: str(p.sessionId) } }],
        ok: true,
      };
    case 'message.show': {
      const text = str(p.text);
      if (!text) return { state, effects: [], ok: false, error: 'text missing' };
      const seconds = Math.min(600, Math.max(3, num(p.durationSeconds) ?? 20));
      return {
        state: {
          ...state,
          notice: { id: command.commandId, text, untilServerMs: serverNowMs + seconds * 1000 },
        },
        effects: [],
        ok: true,
      };
    }
    case 'power.restart':
      return { state, effects: [{ type: 'power', action: 'restart' }], ok: true };
    case 'power.shutdown':
      return { state, effects: [{ type: 'power', action: 'shutdown' }], ok: true };
    case 'update.apply':
      return { state, effects: [{ type: 'update' }], ok: true };
    default:
      return {
        state,
        effects: [],
        ok: false,
        error: `unsupported command ${String(command.command)}`,
      };
  }
}

// ─── Time display ───────────────────────────────────────────────────────────────
export interface SessionView {
  kind: 'countdown' | 'elapsed';
  seconds: number;
  paused: boolean;
  /** True when a prepaid session has reached zero (the client locks itself locally). */
  expired: boolean;
}

export function sessionView(session: SessionState, serverNowMs: number): SessionView {
  if (session.endsAt) {
    const remaining =
      session.status === 'paused' && session.remainingAtPauseSeconds !== null
        ? session.remainingAtPauseSeconds
        : Math.round((Date.parse(session.endsAt) - serverNowMs) / 1000);
    return {
      kind: 'countdown',
      seconds: Math.max(0, remaining),
      paused: session.status === 'paused',
      expired: session.status === 'active' && remaining <= 0,
    };
  }
  const reference =
    session.status === 'paused' && session.pausedAt ? Date.parse(session.pausedAt) : serverNowMs;
  return {
    kind: 'elapsed',
    seconds: Math.max(0, Math.round((reference - Date.parse(session.startedAt)) / 1000)),
    paused: session.status === 'paused',
    expired: false,
  };
}

export function formatHMS(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// ─── Reconnection ──────────────────────────────────────────────────────────────
/** 1 s, 2 s, 4 s … capped at 30 s, with up to 20 % jitter so a LAN full of PCs does not stampede. */
export function backoffMs(attempt: number, random = Math.random()): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, Math.min(attempt, 10)));
  return Math.round(base * (1 + random * 0.2));
}

// ─── server address helpers ─────────────────────────────────────────────────
export const DEFAULT_SERVER_PORT = 4700;

/**
 * Normalises what staff type into the "server address" box: `192.168.1.10`, `192.168.1.10:4700`,
 * `http://main-pc:4700/` all become `http://192.168.1.10:4700`. Returns null when it is not an
 * address at all.
 */
export function normalizeServerUrl(input: string): string | null {
  let text = input.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // Browsers percent-encode junk instead of rejecting it ("not an address" → not%20an%20address).
  if (
    !/^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/i.test(
      url.hostname,
    )
  ) {
    return null;
  }
  const port = url.port || (url.protocol === 'https:' ? '' : String(DEFAULT_SERVER_PORT));
  return `${url.protocol}//${url.hostname}${port ? `:${port}` : ''}`;
}

/**
 * Addresses to try for a discovered server, best first: the address its discovery reply came
 * from (the only one proven reachable from this PC), then the addresses it advertises itself.
 * Servers with several adapters (VirtualBox, Hyper-V, Wi-Fi + Ethernet) list them all; blindly
 * taking the first one is the classic "client never connects" bug.
 */
export function candidateServerUrls(server: {
  from?: string | null;
  port: number;
  urls: string[];
}): string[] {
  const out: string[] = [];
  if (server.from) out.push(`http://${formatHost(server.from)}:${server.port}`);
  for (const url of server.urls) {
    const normalized = normalizeServerUrl(url);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function formatHost(ip: string): string {
  return ip.includes(':') && !ip.startsWith('[') ? `[${ip}]` : ip;
}
