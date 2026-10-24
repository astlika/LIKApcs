/**
 * Pure protocol logic of the LIKApcs-Client — no I/O, fully unit-tested.
 *
 *  - CommandGuard: exactly-once / in-order / not-expired acceptance of server commands.
 *  - Clock: the server clock is authoritative; we only keep an offset to the local clock.
 *  - reduce(): applies welcome data and commands to the client state and returns the side
 *    effects the shell has to perform (power actions, update, lock/unlock the window…).
 */
import {
  isProtectedProcess,
  normalizeExeName,
  priceForSeconds,
  type ClientDisplayConfig,
  type ClientSessionBilling,
  type ServerCommand,
  type ServerDisplay,
  type ServerOrderUpdate,
  type ServerRequestUpdate,
  type ServerWelcomeToClient,
  type SessionRequest,
} from '@likapcs/shared';

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
  /** 0.10.0: who paused (shown on the covered screen) and when a customer pause ends by itself. */
  pausedBy: PausedBy | null;
  autoResumeAt: string | null;
  /** Display-only money facts from the server (paid amount / postpaid terms); null = unknown. */
  billing: ClientSessionBilling | null;
}

export type PausedBy = 'staff' | 'customer' | 'grace';
/** An order from this PC as the server reports it (`server.order` / welcome `orders`). */
export type OrderView = ServerOrderUpdate['order'];

function pausedByOf(value: unknown): PausedBy | null {
  return value === 'staff' || value === 'customer' || value === 'grace' ? value : null;
}

/**
 * Which native window the state needs: a locked PC *and* a paused session cover the whole screen
 * (nothing else may be used while paused); a running session / staff unlock shows the widget.
 */
export function baseWindowModeOf(state: ClientState): 'locked' | 'overlay' {
  if (state.mode === 'locked') return 'locked';
  if (state.mode === 'session' && state.session?.status === 'paused') return 'locked';
  return 'overlay';
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

/** 0.18.0: gifted minutes — the widget throws a party-popper burst (see `GiftCelebration`). */
export interface Celebration {
  minutes: number;
  /** Local clock when the command arrived; anything older than ~10 s is ignored by the widget. */
  at: number;
}

export interface ClientState {
  mode: Mode;
  session: SessionState | null;
  maintenance: MaintenanceState | null;
  notice: Notice | null;
  celebration: Celebration | null;
  station: ServerWelcomeToClient['station'] | null;
  businessName: string;
  welcomeMessage: string;
  language: 'en' | 'sq';
  /** Customer-screen look (widget, lock title, slideshow); null until the first welcome. */
  display: ClientDisplayConfig | null;
}

export const initialState: ClientState = {
  mode: 'locked',
  session: null,
  maintenance: null,
  notice: null,
  celebration: null,
  station: null,
  businessName: '',
  welcomeMessage: '',
  language: 'en',
  display: null,
};

export type Effect =
  | { type: 'power'; action: 'restart' | 'shutdown' }
  | { type: 'update' }
  /** Turn the Windows side of Wake-on-LAN on, then report + re-send hardware facts. */
  | { type: 'wol_configure' }
  /** End Task (0.17.0): close these programs (owner's list only), then report the outcome. */
  | { type: 'end_tasks'; exes: string[]; skipped: string[] }
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
    pausedBy: w.status === 'paused' ? (pausedByOf(w.pausedBy) ?? 'staff') : null,
    autoResumeAt: w.status === 'paused' ? (w.autoResumeAt ?? null) : null,
    billing: billingOf(w.billing),
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
    display: welcome.display ?? state.display,
    session,
    maintenance,
    // No session ⇒ locked — unless the server itself says a staff maintenance unlock is still in
    // force (it recorded that grant; a reconnect never invents an unlock on its own).
    mode: session ? 'session' : maintenance ? 'free' : 'locked',
  };
}

/** `server.display`: the owner changed a customer-screen setting (or renamed the business). */
/**
 * 0.20.0: the server sends this PC's wallpaper as a path under its own address (`/api/v1/...`);
 * the PC needs the full URL, like the ads' pictures.
 */
export function withAbsoluteWallpaper(
  display: ClientDisplayConfig,
  serverUrl: string,
): ClientDisplayConfig {
  const absolute = (value: string | null): string | null =>
    value && value.startsWith('/') ? `${serverUrl}${value}` : value;
  return {
    ...display,
    wallpaperUrl: absolute(display.wallpaperUrl),
    desktopWallpaperUrl: absolute(display.desktopWallpaperUrl ?? null),
  };
}

export function applyDisplay(state: ClientState, message: ServerDisplay): ClientState {
  return {
    ...state,
    display: message.display,
    businessName: message.businessName,
    welcomeMessage: message.welcomeMessage,
    language: message.language,
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Accepts the server's billing snapshot only when it is well-formed; anything else → unknown. */
function billingOf(v: unknown): ClientSessionBilling | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Record<string, unknown>;
  if (b.billingMode !== 'prepaid' && b.billingMode !== 'postpaid' && b.billingMode !== 'endpay')
    return null;
  const paidCents = num(b.paidCents);
  const billableSeconds = num(b.billableSeconds);
  const asOf = str(b.asOf);
  if (paidCents === null || billableSeconds === null || !asOf) return null;
  const terms =
    b.terms && typeof b.terms === 'object' ? (b.terms as ClientSessionBilling['terms']) : null;
  // End pay (0.14.0): the amount due at the desk when the time ends.
  const dueCents = num(b.dueCents) ?? 0;
  return { billingMode: b.billingMode, paidCents, dueCents, terms, billableSeconds, asOf };
}

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
            pausedBy: null,
            autoResumeAt: null,
            billing: billingOf(p.billing),
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
            pausedBy: pausedByOf(p.pausedBy) ?? 'staff',
            autoResumeAt: str(p.autoResumeAt),
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
            billing: billingOf(p.billing) ?? state.session.billing,
            status: 'active',
            pausedAt: null,
            endsAt: str(p.endsAt) ?? state.session.endsAt,
            remainingAtPauseSeconds: null,
            pausedBy: null,
            autoResumeAt: null,
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
      const billing = billingOf(p.billing) ?? state.session.billing;
      return {
        state: { ...state, session: { ...state.session, endsAt, billing } },
        effects: [],
        ok: true,
      };
    }
    case 'celebrate': {
      // 0.18.0: free minutes were gifted. The countdown itself was already refreshed by the
      // `session.extend` mirror the server sends right before this command — here the widget
      // only celebrates, so a payload with no plausible minutes is simply refused.
      const raw = Math.round(num(p.minutes) ?? 0);
      if (raw < 1) return { state, effects: [], ok: false, error: 'minutes missing' };
      return {
        state: { ...state, celebration: { minutes: Math.min(600, raw), at: Date.now() } },
        effects: [],
        ok: true,
      };
    }
    case 'session.end':
      return {
        state: { ...state, mode: 'locked', session: null, celebration: null },
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
    case 'wol.configure':
      return { state, effects: [{ type: 'wol_configure' }], ok: true };
    case 'tasks.end': {
      // End Task (0.17.0): filtered entry by entry on the PC itself — whatever the payload
      // claims, only a plausible `name.exe` that is not protected is closed, so LIKApcs-Client
      // and the Windows shell can never be killed by a broken or tampered request.
      const raw = Array.isArray(p.exes) ? (p.exes as unknown[]).map((x) => String(x)) : [];
      const exes: string[] = [];
      const seen = new Set<string>();
      const skipped: string[] = [];
      for (const entry of raw) {
        const name = normalizeExeName(entry);
        if (!name || isProtectedProcess(name) || seen.has(name.toLowerCase())) {
          skipped.push(entry);
          continue;
        }
        seen.add(name.toLowerCase());
        exes.push(name);
      }
      if (exes.length === 0)
        return { state, effects: [], ok: false, error: 'no programs to close' };
      return { state, effects: [{ type: 'end_tasks', exes, skipped }], ok: true };
    }
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
  /** Prepaid: amount already paid. null when the server did not say. */
  paidCents: number | null;
  /** Postpaid: running amount owed, derived from the server's terms + snapshot. null = unknown. */
  owedCents: number | null;
  /** How the session is billed (end pay labels the owed amount "pay at the end"). */
  billingMode: 'prepaid' | 'postpaid' | 'endpay' | null;
}

export function sessionView(session: SessionState, serverNowMs: number): SessionView {
  const money = {
    ...sessionMoney(session, serverNowMs),
    billingMode: session.billing?.billingMode ?? null,
  };
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
      ...money,
    };
  }
  const reference =
    session.status === 'paused' && session.pausedAt ? Date.parse(session.pausedAt) : serverNowMs;
  return {
    kind: 'elapsed',
    seconds: Math.max(0, Math.round((reference - Date.parse(session.startedAt)) / 1000)),
    paused: session.status === 'paused',
    expired: false,
    ...money,
  };
}

/**
 * Display-only money: prepaid shows what was paid; end pay shows the fixed amount due at the end;
 * postpaid counts billable seconds on from the server's snapshot (frozen while paused) and prices
 * them with the server's own terms. The real invoice is always computed by the server when the
 * session ends.
 */
function sessionMoney(
  session: SessionState,
  serverNowMs: number,
): Pick<SessionView, 'paidCents' | 'owedCents'> {
  const b = session.billing;
  if (!b) return { paidCents: null, owedCents: null };
  if (b.billingMode === 'prepaid') return { paidCents: b.paidCents, owedCents: null };
  // End pay: a fixed amount, collected at the desk when the time ends (shown as "to pay").
  if (b.billingMode === 'endpay') return { paidCents: null, owedCents: b.dueCents ?? 0 };
  if (!b.terms) return { paidCents: null, owedCents: null };
  const reference =
    session.status === 'paused' && session.pausedAt ? Date.parse(session.pausedAt) : serverNowMs;
  const since = Math.max(0, Math.round((reference - Date.parse(b.asOf)) / 1000));
  try {
    return { paidCents: null, owedCents: priceForSeconds(b.billableSeconds + since, b.terms) };
  } catch {
    return { paidCents: null, owedCents: null };
  }
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

// ─── Customer session requests (0.9.0) ──────────────────────────────────────────
/** How long an answered request stays on screen before it fades on its own. */
export const REQUEST_RESULT_MS = 60_000;

/**
 * `server.request` against the request the PC already shows. The same request → its answer is
 * taken over (status / reason / decision time). A pending request we do not know yet (made before
 * a restart, or the push overtook the create response) → `{ fetch: id }` so the shell loads it.
 * An answer to an unknown request is ignored: there is nothing on screen to update.
 */
export function mergeRequestPush(
  local: SessionRequest | null,
  push: ServerRequestUpdate['request'],
): { request: SessionRequest } | { fetch: string } | null {
  if (local && local.id === push.id) {
    return {
      request: {
        ...local,
        status: push.status,
        reason: push.reason,
        decidedAt: push.decidedAt,
      },
    };
  }
  return push.status === 'pending' ? { fetch: push.id } : null;
}

/** An answered request older than REQUEST_RESULT_MS is cleared from the screen by the tick. */
export function requestResultExpired(request: SessionRequest | null, nowMs: number): boolean {
  if (!request || request.status === 'pending' || !request.decidedAt) return false;
  return Date.parse(request.decidedAt) + REQUEST_RESULT_MS < nowMs;
}
