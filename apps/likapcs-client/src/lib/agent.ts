/**
 * The client agent: finds the server, registers this PC, keeps an authenticated WebSocket open,
 * applies commands and reports back. UI components subscribe to `agent` and only render.
 *
 * Safety rules (see docs/network-protocol.md):
 *  - the PC is locked until the server says otherwise; a reconnect never unlocks by itself;
 *  - every command is checked for replay/expiry and acknowledged exactly once;
 *  - a prepaid session that reaches zero locks the PC locally even when the server is unreachable;
 *  - the server address is pinned after pairing; discovery is only used to find it again by its
 *    installation id (a different server on the LAN cannot take over a paired PC).
 */
import {
  PROTOCOL_VERSION,
  WS_CLOSE_CODES,
  type ClientAdItem,
  type ClientMenu,
  type ClientMetrics,
  type ClientRequestOptions,
  type CustomerLoginResponse,
  type HardwareInfo,
  type OrderCreate,
  type RegisterDeviceResponse,
  type RegistrationPollResponse,
  type ServerCommand,
  type ServerOrderUpdate,
  type ServerRequestUpdate,
  type ServerToClientMessage,
  type SessionRequest,
  type SessionRequestCreate,
  type StationOrder,
} from '@likapcs/shared';
import {
  APP_VERSION,
  applySelfUpdate,
  checkForUpdate,
  deviceIdentity,
  discoverServers,
  firstReachable,
  hardwareInfo,
  hardwareMetrics,
  powerAction,
  probeServer,
  quitApp,
  randomToken,
  secretDelete,
  secretGet,
  secretSet,
  setWindowMode,
  sha256Hex,
  trayUpdate,
  wolConfigure,
  type DeviceIdentity,
  type TrayLabels,
  type UpdateCheck,
  type WindowMode,
} from './native';
import {
  Clock,
  CommandGuard,
  applyDisplay,
  applyWelcome,
  backoffMs,
  baseWindowModeOf,
  candidateServerUrls,
  initialState,
  mergeRequestPush,
  normalizeServerUrl,
  reduce,
  requestResultExpired,
  sessionView,
  type ClientState,
  type Effect,
  type OrderView,
} from './protocol';

export type Phase =
  | { phase: 'starting' }
  | { phase: 'no_server'; attempt: number }
  | { phase: 'registering'; registrationId: string | null }
  | { phase: 'rejected'; retryInSeconds: number }
  | { phase: 'needs_reissue' }
  | { phase: 'connecting'; attempt: number }
  | { phase: 'online' }
  | { phase: 'offline'; sinceMs: number; attempt: number }
  | { phase: 'incompatible'; detail: string }
  | { phase: 'updating'; percent: number | null };

export interface Pairing {
  serverUrl: string;
  installationId: string | null;
  /** 'manual' addresses are never replaced by discovery results. */
  source: 'discovery' | 'manual';
}

export interface AgentSnapshot {
  phase: Phase;
  state: ClientState;
  pairing: Pairing | null;
  identity: DeviceIdentity | null;
  machineId: string | null;
  paired: boolean;
  serverNowMs: number;
  version: string;
  lastError: string | null;
  /** A server answered discovery but none of its addresses accept connections (firewall). */
  discoveryHint: { name: string; url: string } | null;
  /** Newer client version offered by the release feed (null = up to date / not checked). */
  updateAvailable: string | null;
  updateCheckedAt: number | null;
  updateError: string | null;
  /** Install updates by itself while the PC is locked and idle (default on). */
  autoUpdate: boolean;
  /** Which native window layout is showing ('panel' = settings opened from the tray). */
  windowMode: WindowMode;
  /** Lock-screen slideshow items (absolute image URLs, null for text slides); empty when ads are off. */
  ads: ClientAdItem[];
  /** Customer signed in through the "Client" button (memory only; cleared when the PC locks). */
  customer: CustomerLoginState | null;
  /** The customer's request on this PC: pending while the staff decide, then the answer until dismissed. */
  request: SessionRequest | null;
  /** Orders sent from this PC during the running session (newest first); cleared when the PC locks. */
  orders: OrderView[];
  /** A just-decided order the widget shows for a few seconds ("Order #3 accepted"). */
  orderFlash: { order: OrderView; untilMs: number } | null;
}

/** Who is signed in at the PC. The token only lets this device create requests (20 min). */
export interface CustomerLoginState {
  token: string;
  expiresAt: string;
  customer: CustomerLoginResponse['customer'];
}

export type CustomerActionError =
  | 'not_paired'
  | 'network'
  | 'rate_limited'
  | 'invalid_credentials'
  | 'locked'
  | 'login_disabled'
  | 'blocked'
  | 'requests_disabled'
  | 'unauthorized'
  | 'session_active'
  | 'no_session'
  | 'request_pending'
  | 'conflict'
  | 'validation_error'
  | 'not_found'
  | 'orders_disabled'
  | 'out_of_stock'
  | 'pause_disabled'
  | 'resume_disabled'
  | 'generic';

export type ManualConnectResult =
  | { ok: true; url: string; name: string; version: string }
  | {
      ok: false;
      reason:
        'invalid' | 'timeout' | 'unreachable' | 'http' | 'not_likapcs' | 'different_installation';
      url?: string;
      name?: string;
    };

const KEYS = {
  pairing: 'pairing',
  registration: 'registration',
  token: 'device-token',
  machineFallback: 'machine-id-fallback',
  language: 'language',
  autoUpdate: 'auto-update',
} as const;

const REGISTRATION_POLL_MS = 5000;
const NO_SERVER_RETRY_MS = 6000;
const REJECTED_RETRY_S = 120;
const DISCOVERY_AFTER_FAILURES = 6;
const PROBE_TIMEOUT_MS = 2500;
/** First self-update check shortly after start, then periodically (also triggered by Admin). */
const UPDATE_FIRST_CHECK_MS = 2 * 60_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const UPDATE_RETRY_MS = 30 * 60_000;
/** Safety net behind the `server.display` push (a missed push must not keep stale ads for long). */
const ADS_REFRESH_MS = 10 * 60_000;
/** How long "Order #3 accepted" stays in the widget. */
const ORDER_FLASH_MS = 8000;

/** The PC keeps only what it shows of an order (no ids of staff, sales or customers). */
function orderViewOf(order: StationOrder | ServerOrderUpdate['order']): OrderView {
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    settlement: order.settlement,
    totalCents: order.totalCents,
    reason: order.reason,
    items: order.items.map((i) => ({
      name: i.name,
      quantity: 'quantity' in i ? i.quantity : Math.round(i.quantityMilli / 1000),
      lineTotalCents: i.lineTotalCents,
    })),
    requestedAt: order.requestedAt,
    decidedAt: order.decidedAt,
  };
}

type Listener = () => void;

export class Agent {
  private snapshot: AgentSnapshot = {
    phase: { phase: 'starting' },
    state: initialState,
    pairing: null,
    identity: null,
    machineId: null,
    paired: false,
    serverNowMs: Date.now(),
    version: APP_VERSION,
    lastError: null,
    discoveryHint: null,
    updateAvailable: null,
    updateCheckedAt: null,
    updateError: null,
    autoUpdate: true,
    windowMode: 'locked',
    ads: [],
    customer: null,
    request: null,
    orders: [],
    orderFlash: null,
  };
  private readonly listeners = new Set<Listener>();
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private trayLabels: ((snap: AgentSnapshot) => TrayLabels) | null = null;
  private lastTrayKey = '';
  private readonly clock = new Clock();
  private guard = new CommandGuard();
  private socket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastAckAt = 0;
  private heartbeatIntervalMs = 10_000;
  private started = false;
  private stopped = false;
  private wake: (() => void) | null = null;
  private readonly startedAt = Date.now();
  private tick: ReturnType<typeof setInterval> | null = null;
  private hardware: HardwareInfo | null = null;
  private metricsInFlight = false;
  private ads: ClientAdItem[] = [];
  private adsLoadedAt = 0;
  private adsLoading = false;
  /** Server-announced instant the slideshow changes by itself (a promo or schedule starts/ends). */
  private adsNextChangeTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── store ────────────────────────────────────────────────────────────────
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): AgentSnapshot => this.snapshot;
  private set(patch: Partial<AgentSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
    this.refreshTray();
  }
  private setPhase(phase: Phase): void {
    this.set({ phase });
  }
  private setState(state: ClientState): void {
    const modeChanged = state.mode !== this.snapshot.state.mode;
    // Locking signs the customer out: the next person at the PC must not inherit the login.
    const customer = modeChanged && state.mode === 'locked' ? null : this.snapshot.customer;
    // A lock ⇄ session flip is the answer itself (approved → the session runs; ended → locked):
    // an already-decided request would only linger as stale text, so it goes with the flip.
    const request =
      modeChanged && this.snapshot.request?.status !== 'pending' ? null : this.snapshot.request;
    // Orders belong to the session: once the PC locks they are the desk's business, not the screen's.
    const orders = modeChanged && state.mode === 'locked' ? [] : this.snapshot.orders;
    const orderFlash = modeChanged && state.mode === 'locked' ? null : this.snapshot.orderFlash;
    this.set({ state, customer, request, orders, orderFlash });
    // Locked PC or paused session → full-screen cover; otherwise the widget. A pause that arrives
    // while the order / settings panel is open closes it: nothing is usable while paused.
    const base = baseWindowModeOf(state);
    if (base !== this.baseMode) {
      this.baseMode = base;
      void this.applyWindowMode(base);
    }
  }
  private baseMode: WindowMode | null = null;

  private async applyWindowMode(mode: WindowMode): Promise<void> {
    this.set({ windowMode: mode });
    await setWindowMode(mode);
  }

  /**
   * Settings panel opened from the tray. Only possible while the PC is unlocked (session or
   * staff maintenance) — the lock screen itself hosts the panel otherwise (Ctrl+Alt+S).
   */
  async openPanel(): Promise<boolean> {
    if (baseWindowModeOf(this.snapshot.state) === 'locked') return false;
    await this.applyWindowMode('panel');
    return true;
  }
  async closePanel(): Promise<void> {
    if (this.snapshot.windowMode !== 'panel') return;
    await this.applyWindowMode(baseWindowModeOf(this.snapshot.state));
  }

  /**
   * Quits the client. Allowed only during a staff unlock (maintenance) or while the PC is not
   * paired yet (a technician setting it up) — never under a customer session, and never while a
   * paired PC is locked (the native side refuses that too).
   */
  async quit(): Promise<boolean> {
    const { state, paired } = this.snapshot;
    const allowed = state.mode === 'free' || !paired;
    if (!allowed) return false;
    try {
      await quitApp(!paired);
    } catch {
      return false;
    }
    this.stop();
    return true;
  }

  // ─── tray ─────────────────────────────────────────────────────────────────
  /** The UI provides translated tray texts; the agent pushes them whenever the status changes. */
  setTrayLabels(provider: (snap: AgentSnapshot) => TrayLabels): void {
    this.trayLabels = provider;
    this.lastTrayKey = '';
    this.refreshTray();
  }
  private refreshTray(): void {
    if (!this.trayLabels) return;
    const labels = this.trayLabels(this.snapshot);
    const key = JSON.stringify(labels);
    if (key === this.lastTrayKey) return;
    this.lastTrayKey = key;
    void trayUpdate(labels).catch(() => undefined);
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    void setWindowMode('locked');
    const identity = await deviceIdentity();
    let raw = identity.machineId;
    if (!raw) {
      raw = (await secretGet(KEYS.machineFallback)) ?? randomToken(16);
      await secretSet(KEYS.machineFallback, raw);
    }
    const machineId = await sha256Hex(`likapcs-client:${raw}`);
    const language = (await secretGet(KEYS.language)) === 'sq' ? 'sq' : 'en';
    const autoUpdate = (await secretGet(KEYS.autoUpdate)) !== 'off';
    this.set({ identity, machineId, autoUpdate, state: { ...this.snapshot.state, language } });
    // Hardware facts are collected once (GPU names need a short WMI query) and sent with every
    // hello. The first hello usually wins the race, so when the facts arrive while we are already
    // online they go out as an event — the Admin shows the specs without waiting for a reconnect.
    void hardwareInfo().then((hardware) => {
      this.hardware = hardware;
      if (hardware && this.snapshot.phase.phase === 'online') {
        this.send({ type: 'client.event', event: 'hardware', payload: hardware });
      }
    });
    this.tick = setInterval(() => this.onTick(), 1000);
    this.scheduleUpdateCheck(UPDATE_FIRST_CHECK_MS);
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.tick) clearInterval(this.tick);
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.closeSocket(1000, 'client stopping');
    this.wake?.();
  }

  /**
   * Staff typed a server address (lock screen while unpaired, or the settings panel). The
   * address is normalised and probed first so the answer is precise: unreachable (firewall /
   * wrong network), not a LIKApcs server, or a *different* installation than the one this PC
   * is paired with (its device token would be useless there — revoke/forget first).
   */
  async connectManually(input: string): Promise<ManualConnectResult> {
    const url = normalizeServerUrl(input);
    if (!url) return { ok: false, reason: 'invalid' };
    const probe = await probeServer(url, 4000);
    if (!probe.ok) return { ok: false, reason: probe.error ?? 'unreachable', url };
    const current = this.snapshot.pairing;
    if (
      this.snapshot.paired &&
      current?.installationId &&
      probe.installationId &&
      probe.installationId !== current.installationId
    ) {
      return { ok: false, reason: 'different_installation', url, name: probe.name };
    }
    await this.savePairing({
      serverUrl: url,
      installationId: probe.installationId ?? null,
      source: 'manual',
    });
    this.set({ lastError: null, discoveryHint: null });
    this.closeSocket(4000, 'server changed');
    this.wake?.();
    return { ok: true, url, name: probe.name ?? 'LIKApcs', version: probe.version ?? '' };
  }

  /**
   * Forgets the pairing, device token and registration so this PC registers again (used to
   * move a PC to another server). Only offered while the PC is unlocked by staff or unpaired.
   */
  async forgetPairing(): Promise<void> {
    await secretDelete(KEYS.token);
    await secretDelete(KEYS.registration);
    await secretDelete(KEYS.pairing);
    this.set({ pairing: null, paired: false, lastError: null, discoveryHint: null });
    this.closeSocket(4000, 'pairing reset');
    this.wake?.();
  }

  // ─── self-update ──────────────────────────────────────────────────────────
  private scheduleUpdateCheck(delayMs: number): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => void this.checkUpdates('scheduled'), delayMs);
  }

  /**
   * Looks for a newer signed client. Scheduled checks install it by themselves only when the
   * PC is locked with no session (never under a customer) and auto-update is on; otherwise
   * the version is just remembered and offered in the settings panel.
   */
  async checkUpdates(trigger: 'scheduled' | 'manual'): Promise<UpdateCheck> {
    const result = await checkForUpdate();
    this.set({
      updateCheckedAt: Date.now(),
      updateAvailable: result.status === 'available' ? (result.version ?? null) : null,
      updateError: result.status === 'failed' ? (result.error ?? 'failed') : null,
    });
    if (result.status === 'available' && trigger === 'scheduled' && this.canAutoInstall()) {
      await this.selfUpdate('scheduled');
    }
    const next =
      result.status === 'failed' || result.status === 'available'
        ? UPDATE_RETRY_MS
        : UPDATE_CHECK_INTERVAL_MS;
    this.scheduleUpdateCheck(next);
    return result;
  }

  private canAutoInstall(): boolean {
    const { state, phase } = this.snapshot;
    return (
      this.snapshot.autoUpdate &&
      state.mode === 'locked' &&
      !state.session &&
      phase.phase !== 'updating' &&
      this.snapshot.windowMode !== 'panel'
    );
  }

  /** Staff pressed "Install now". Refused during a customer session. */
  async installUpdateNow(): Promise<boolean> {
    if (this.snapshot.state.session || this.snapshot.phase.phase === 'updating') return false;
    await this.selfUpdate('manual');
    return true;
  }

  async setAutoUpdate(on: boolean): Promise<void> {
    await secretSet(KEYS.autoUpdate, on ? 'on' : 'off');
    this.set({ autoUpdate: on });
  }

  async setLanguage(language: 'en' | 'sq'): Promise<void> {
    await secretSet(KEYS.language, language);
    this.setState({ ...this.snapshot.state, language });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  private async loop(): Promise<void> {
    let noServerAttempt = 0;
    while (!this.stopped) {
      const pairing = await this.resolveServer(noServerAttempt);
      if (!pairing) {
        noServerAttempt += 1;
        await this.sleep(NO_SERVER_RETRY_MS);
        continue;
      }
      noServerAttempt = 0;
      const token = await this.ensureToken(pairing);
      if (!token) continue; // server unreachable or registration state changed → re-resolve
      await this.runConnection(pairing, token);
    }
  }

  // ─── server resolution ────────────────────────────────────────────────────
  private async loadPairing(): Promise<Pairing | null> {
    const raw = await secretGet(KEYS.pairing);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Pairing;
    } catch {
      return null;
    }
  }
  private async savePairing(pairing: Pairing): Promise<void> {
    await secretSet(KEYS.pairing, JSON.stringify(pairing));
    this.set({ pairing });
  }

  private async resolveServer(attempt: number): Promise<Pairing | null> {
    const stored = this.snapshot.pairing ?? (await this.loadPairing());
    if (stored) {
      this.set({ pairing: stored });
      return stored;
    }
    // Browser/dev build: same origin via the Vite proxy.
    if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) {
      const pairing: Pairing = {
        serverUrl: window.location.origin,
        installationId: null,
        source: 'manual',
      };
      await this.savePairing(pairing);
      return pairing;
    }
    this.setPhase({ phase: 'no_server', attempt });
    const found = await discoverServers(2500).catch(() => []);
    for (const server of found) {
      // A server may advertise several addresses (virtual adapters, Wi-Fi + Ethernet); only an
      // address that actually answers HTTP is saved — the reply's source address is tried first.
      const candidates = candidateServerUrls(server);
      const probe = await firstReachable(candidates, PROBE_TIMEOUT_MS);
      if (!probe) {
        this.set({
          discoveryHint: { name: server.name, url: candidates[0] ?? '' },
          lastError: null,
        });
        continue;
      }
      const pairing: Pairing = {
        serverUrl: probe.url,
        installationId: server.installationId,
        source: 'discovery',
      };
      await this.savePairing(pairing);
      this.set({ discoveryHint: null, lastError: null });
      return pairing;
    }
    return null;
  }

  /** After repeated failures, look for the pinned installation again (its IP may have changed). */
  private async rediscover(pairing: Pairing): Promise<void> {
    if (pairing.source !== 'discovery' || !pairing.installationId) return;
    const found = await discoverServers(2500).catch(() => []);
    const same = found.find((s) => s.installationId === pairing.installationId);
    if (!same) return;
    const probe = await firstReachable(candidateServerUrls(same), PROBE_TIMEOUT_MS);
    if (probe && probe.url !== pairing.serverUrl) {
      await this.savePairing({ ...pairing, serverUrl: probe.url });
    }
  }

  // ─── registration ─────────────────────────────────────────────────────────
  private async api<T>(
    pairing: Pairing,
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: T | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(`${pairing.serverUrl}/api/v1${path}`, {
        ...init,
        signal: controller.signal,
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as T) : null };
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureToken(pairing: Pairing): Promise<string | null> {
    const existing = await secretGet(KEYS.token);
    if (existing) {
      this.set({ paired: true });
      return existing;
    }
    this.set({ paired: false });
    const identity = this.snapshot.identity!;
    const machineId = this.snapshot.machineId!;

    // Registration record survives restarts so the same registration keeps polling.
    let registration: { id: string; secret: string } | null = null;
    const storedReg = await secretGet(KEYS.registration);
    if (storedReg) {
      try {
        registration = JSON.parse(storedReg) as { id: string; secret: string };
      } catch {
        registration = null;
      }
    }

    try {
      if (!registration) {
        const secret = randomToken(32);
        this.setPhase({ phase: 'registering', registrationId: null });
        const res = await this.api<RegisterDeviceResponse>(pairing, '/client/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            machineId,
            hostname: identity.hostname,
            osInfo: identity.osInfo,
            appVersion: APP_VERSION,
            registrationSecret: secret,
          }),
        });
        if (!res.body || (res.status !== 202 && res.status !== 200))
          throw new Error(`registration failed (${res.status})`);
        registration = { id: res.body.registrationId, secret };
        await secretSet(KEYS.registration, JSON.stringify(registration));
      }
      this.setPhase({ phase: 'registering', registrationId: registration.id });

      while (!this.stopped) {
        const poll = await this.api<RegistrationPollResponse>(
          pairing,
          `/client/registration/${registration.id}?secret=${encodeURIComponent(registration.secret)}`,
        );
        if (poll.status === 401 || poll.status === 404) {
          // Secret no longer matches (reinstalled PC whose token is still outstanding elsewhere).
          await secretDelete(KEYS.registration);
          this.setPhase({ phase: 'needs_reissue' });
          await this.sleep(15_000);
          return null;
        }
        if (poll.status !== 200 || !poll.body)
          throw new Error(`registration poll failed (${poll.status})`);
        const body = poll.body;
        if (body.status === 'approved' && body.deviceToken) {
          await secretSet(KEYS.token, body.deviceToken);
          await secretDelete(KEYS.registration);
          this.set({ paired: true, lastError: null });
          return body.deviceToken;
        }
        if (body.status === 'approved') {
          // Approved earlier and the token was already collected by another install of this PC.
          await secretDelete(KEYS.registration);
          this.setPhase({ phase: 'needs_reissue' });
          await this.sleep(15_000);
          return null;
        }
        if (body.status === 'rejected' || body.status === 'revoked') {
          await secretDelete(KEYS.registration);
          this.setPhase({ phase: 'rejected', retryInSeconds: REJECTED_RETRY_S });
          await this.sleep(REJECTED_RETRY_S * 1000);
          return null;
        }
        this.setPhase({ phase: 'registering', registrationId: registration.id });
        await this.sleep(REGISTRATION_POLL_MS);
      }
      return null;
    } catch (err) {
      this.set({ lastError: err instanceof Error ? err.message : String(err) });
      this.setPhase({ phase: 'no_server', attempt: 0 });
      await this.rediscover(pairing);
      await this.sleep(NO_SERVER_RETRY_MS);
      return null;
    }
  }

  // ─── realtime connection ──────────────────────────────────────────────────
  private closeSocket(code: number, reason: string): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const s = this.socket;
    this.socket = null;
    if (s && (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING)) {
      try {
        s.close(code >= 3000 && code < 5000 ? code : 1000, reason);
      } catch {
        /* ignore */
      }
    }
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private async runConnection(pairing: Pairing, token: string): Promise<void> {
    let attempt = 0;
    let wasOnline = false;
    let offlineSince = 0;
    while (!this.stopped) {
      if (wasOnline) this.setPhase({ phase: 'offline', sinceMs: offlineSince, attempt });
      else this.setPhase({ phase: 'connecting', attempt });

      const outcome = await this.connectOnce(pairing, token);
      if (this.stopped) return;

      switch (outcome.kind) {
        case 'reregister':
          await secretDelete(KEYS.token);
          this.set({ paired: false, lastError: outcome.detail });
          return;
        case 'incompatible': {
          this.setPhase({ phase: 'incompatible', detail: outcome.detail });
          await this.selfUpdate('incompatible');
          await this.sleep(60_000);
          attempt = 0;
          break;
        }
        case 'server_changed':
          return;
        case 'closed': {
          if (outcome.wasOnline) {
            wasOnline = true;
            offlineSince = Date.now();
            attempt = 0;
          } else attempt += 1;
          if (attempt > 0 && attempt % DISCOVERY_AFTER_FAILURES === 0) {
            await this.rediscover(pairing);
            const current = this.snapshot.pairing;
            if (current && current.serverUrl !== pairing.serverUrl) return; // reconnect to the new address
          }
          await this.sleep(backoffMs(attempt));
          break;
        }
      }
    }
  }

  private connectOnce(
    pairing: Pairing,
    token: string,
  ): Promise<
    | { kind: 'closed'; wasOnline: boolean }
    | { kind: 'reregister'; detail: string }
    | { kind: 'incompatible'; detail: string }
    | { kind: 'server_changed' }
  > {
    return new Promise((resolve) => {
      const url = `${pairing.serverUrl.replace(/^http/, 'ws')}/ws/client`;
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        this.set({ lastError: err instanceof Error ? err.message : String(err) });
        resolve({ kind: 'closed', wasOnline: false });
        return;
      }
      this.socket = socket;
      this.guard = new CommandGuard();
      let online = false;
      let lastServerError: string | null = null;

      const connectTimer = setTimeout(() => {
        if (!online) socket.close(4000, 'handshake timeout');
      }, 15_000);

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: 'client.hello',
            token,
            appVersion: APP_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            machineId: this.snapshot.machineId,
            ...(this.hardware ? { hardware: this.hardware } : {}),
          }),
        );
      };

      socket.onmessage = (ev) => {
        let message: ServerToClientMessage;
        try {
          message = JSON.parse(String(ev.data)) as ServerToClientMessage;
        } catch {
          return;
        }
        switch (message.type) {
          case 'server.welcome': {
            online = true;
            clearTimeout(connectTimer);
            this.clock.sync(message.serverTime);
            this.heartbeatIntervalMs = Math.max(3, message.heartbeatIntervalSeconds) * 1000;
            this.lastAckAt = Date.now();
            this.setState(applyWelcome(this.snapshot.state, message));
            void secretSet(KEYS.language, message.language);
            this.set({ lastError: null, serverNowMs: this.clock.now() });
            this.setPhase({ phase: 'online' });
            this.startHeartbeat();
            this.refreshAds(true);
            void this.reconcileRequest(message.request?.id ?? null);
            if (message.orders) this.set({ orders: message.orders });
            break;
          }
          case 'server.request':
            this.onRequestPush(message.request);
            break;
          case 'server.order':
            this.onOrderPush(message.order);
            break;
          case 'server.heartbeat_ack':
            this.clock.sync(message.serverTime);
            this.lastAckAt = Date.now();
            break;
          case 'server.display':
            this.setState(applyDisplay(this.snapshot.state, message));
            void secretSet(KEYS.language, message.language);
            this.refreshAds(true);
            break;
          case 'server.command':
            this.handleCommand(message);
            break;
          case 'server.error':
            lastServerError = `${message.code}: ${message.message}`;
            break;
        }
      };

      socket.onerror = () => {
        /* onclose follows */
      };

      socket.onclose = (ev) => {
        clearTimeout(connectTimer);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        if (this.socket === socket) this.socket = null;
        if (lastServerError) this.set({ lastError: lastServerError });
        if (ev.code === 4000 && ev.reason === 'server changed')
          return resolve({ kind: 'server_changed' });
        if (ev.code === WS_CLOSE_CODES.UNAUTHORIZED || ev.code === WS_CLOSE_CODES.DEVICE_REVOKED)
          return resolve({ kind: 'reregister', detail: lastServerError ?? `closed ${ev.code}` });
        if (ev.code === WS_CLOSE_CODES.INCOMPATIBLE_VERSION)
          return resolve({ kind: 'incompatible', detail: lastServerError ?? ev.reason });
        resolve({ kind: 'closed', wasOnline: online });
      };
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastAckAt > this.heartbeatIntervalMs * 3) {
        this.closeSocket(4000, 'heartbeat timeout');
        return;
      }
      void this.sendHeartbeat();
    }, this.heartbeatIntervalMs);
  }

  /** One heartbeat with the live load attached (never waits on a slow sensor read twice). */
  private async sendHeartbeat(): Promise<void> {
    let live: Omit<ClientMetrics, 'uptimeSeconds'> | null = null;
    if (!this.metricsInFlight) {
      this.metricsInFlight = true;
      try {
        live = await hardwareMetrics();
      } finally {
        this.metricsInFlight = false;
      }
    }
    const { state } = this.snapshot;
    this.send({
      type: 'client.heartbeat',
      ts: new Date(this.clock.now()).toISOString(),
      sessionId: state.session?.id ?? null,
      locked: state.mode === 'locked',
      metrics: { ...(live ?? {}), uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000) },
    });
  }

  // ─── Lock-screen slideshow ───────────────────────────────────────────────────

  /** The owner's ads (Admin › Ads) for the lock screen; refreshed on connect, on `server.display`, every 10 min. */
  private refreshAds(force = false): void {
    const { pairing, state } = this.snapshot;
    if (!pairing || !state.display?.ads.enabled) {
      if (!state.display?.ads.enabled && this.ads.length > 0) this.setAds([]);
      return;
    }
    if (this.adsLoading || (!force && Date.now() - this.adsLoadedAt < ADS_REFRESH_MS)) return;
    this.adsLoading = true;
    void (async () => {
      try {
        const token = await secretGet(KEYS.token);
        if (!token) return;
        const res = await this.api<{ items: ClientAdItem[]; nextChangeAt?: string | null }>(
          pairing,
          '/client/ads',
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (res.status === 200 && res.body) {
          this.adsLoadedAt = Date.now();
          const absolute = (url: string | null) =>
            url && url.startsWith('/') ? `${pairing.serverUrl}${url}` : url;
          this.setAds(
            res.body.items.map((item) => ({
              ...item,
              imageUrl: absolute(item.imageUrl),
              videoUrl: absolute(item.videoUrl ?? null) ?? null,
            })),
          );
          this.scheduleAdsChange(res.body.nextChangeAt ?? null);
        }
      } catch {
        /* keep the previous list; the next refresh will retry */
      } finally {
        this.adsLoading = false;
      }
    })();
  }

  /**
   * The server knows when the list changes next by itself (a promo ends at 18:00, a weekday
   * slide starts at 20:00): re-fetch right after that instant instead of waiting for the 10-min net.
   */
  private scheduleAdsChange(at: string | null): void {
    if (this.adsNextChangeTimer) clearTimeout(this.adsNextChangeTimer);
    this.adsNextChangeTimer = null;
    if (!at) return;
    const delay = Date.parse(at) - this.clock.now() + 1500;
    if (!Number.isFinite(delay) || delay > ADS_REFRESH_MS) return;
    this.adsNextChangeTimer = setTimeout(
      () => {
        this.adsNextChangeTimer = null;
        this.refreshAds(true);
      },
      Math.max(1000, delay),
    );
  }

  private setAds(ads: ClientAdItem[]): void {
    // Same list again (hourly refresh) → no re-render, the slideshow keeps its rhythm.
    if (JSON.stringify(ads) === JSON.stringify(this.ads)) return;
    this.ads = ads;
    this.set({ ads });
  }

  private handleCommand(command: ServerCommand): void {
    const now = this.clock.now();
    const decision = this.guard.check(command, now);
    if (!decision.accept) {
      // Duplicates were already acknowledged once; everything else is reported as a failure.
      if (decision.reason !== 'duplicate')
        this.send({
          type: 'client.ack',
          commandId: command.commandId,
          ok: false,
          error: decision.reason,
        });
      return;
    }
    const result = reduce(this.snapshot.state, command, now);
    this.send({
      type: 'client.ack',
      commandId: command.commandId,
      ok: result.ok,
      error: result.error,
    });
    if (!result.ok) return;
    this.setState(result.state);
    for (const effect of result.effects) void this.runEffect(effect);
  }

  private async runEffect(effect: Effect): Promise<void> {
    switch (effect.type) {
      case 'event':
        this.send({ type: 'client.event', event: effect.event, payload: effect.payload ?? {} });
        break;
      case 'power':
        // The ack went out first so staff see "ok" before the PC goes down.
        await new Promise((r) => setTimeout(r, 800));
        await powerAction(effect.action).catch((err: unknown) =>
          this.send({
            type: 'client.event',
            event: 'error',
            payload: { action: effect.action, error: String(err) },
          }),
        );
        break;
      case 'update':
        await this.selfUpdate('command');
        break;
      case 'wol_configure': {
        // Can take a while (UAC prompt on this PC); the ack already went out, the outcome is
        // reported as an event and the adapters are re-sent so the Admin's badge updates.
        const outcome = await wolConfigure().catch((err: unknown) => ({
          ok: false,
          message: String(err),
          elevated: false,
          hardware: null,
        }));
        this.send({
          type: 'client.event',
          event: 'wol_configured',
          payload: { ok: outcome.ok, message: outcome.message, elevated: outcome.elevated },
        });
        if (outcome.hardware)
          this.send({ type: 'client.event', event: 'hardware', payload: outcome.hardware });
        break;
      }
    }
  }

  private async selfUpdate(
    trigger: 'command' | 'incompatible' | 'scheduled' | 'manual',
  ): Promise<void> {
    const previous = this.snapshot.phase;
    this.setPhase({ phase: 'updating', percent: null });
    this.send({
      type: 'client.event',
      event: 'update_status',
      payload: { status: 'checking', trigger },
    });
    const outcome = await applySelfUpdate((percent) =>
      this.setPhase({ phase: 'updating', percent }),
    );
    this.send({
      type: 'client.event',
      event: 'update_status',
      payload: {
        status: outcome.status,
        version: outcome.version ?? null,
        error: outcome.error ?? null,
        trigger,
      },
    });
    if (outcome.status !== 'installed')
      this.setPhase(previous.phase === 'updating' ? { phase: 'online' } : previous);
  }

  // ─── staff unlock at the PC (maintenance) ─────────────────────────────────
  /**
   * Sends the staff member's own credentials to the server, which verifies them, checks the
   * `stations.unlock` permission and answers with the `unlock` command over the WebSocket. The
   * client never decides on its own; this just relays. Resolves with the grant end time.
   */
  async staffUnlock(
    username: string,
    password: string,
  ): Promise<{ ok: true; until: string; byName: string } | { ok: false; error: string }> {
    const { pairing } = this.snapshot;
    const token = await secretGet(KEYS.token);
    if (!pairing || !token) return { ok: false, error: 'not_paired' };
    try {
      const res = await this.api<
        { until: string; byName: string } | { error: { code: string; message: string } }
      >(pairing, '/client/staff-unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ username, password }),
      });
      if (res.status === 200 && res.body && 'until' in res.body) {
        return { ok: true, until: res.body.until, byName: res.body.byName };
      }
      const code =
        res.body && 'error' in res.body
          ? res.body.error.code
          : res.status === 429
            ? 'rate_limited'
            : `http_${res.status}`;
      return { ok: false, error: code };
    } catch {
      return { ok: false, error: 'network' };
    }
  }

  /** Staff ended the maintenance unlock: lock immediately, then tell the server. */
  async staffLock(): Promise<void> {
    const { state } = this.snapshot;
    if (state.mode === 'free') {
      this.setState({ ...state, mode: 'locked', maintenance: null });
      this.send({ type: 'client.event', event: 'maintenance_ended', payload: { reason: 'staff' } });
    }
    const { pairing } = this.snapshot;
    const token = await secretGet(KEYS.token);
    if (!pairing || !token) return;
    await this.api(pairing, '/client/staff-lock', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
    }).catch(() => undefined);
  }

  // ─── customer login + session requests (0.9.0) ────────────────────────────
  // The PC never unlocks or extends by itself here: these calls only create / cancel a request
  // record on the server. Staff answer in LIKApcs; an approval arrives as the usual
  // `session.start` / `session.extend` command, the decision itself as `server.request`.

  private async customerCall<T>(
    path: string,
    init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown; customer?: boolean },
  ): Promise<{ ok: true; body: T } | { ok: false; error: CustomerActionError; until?: string }> {
    const { pairing } = this.snapshot;
    const token = await secretGet(KEYS.token);
    if (!pairing || !token) return { ok: false, error: 'not_paired' };
    // No content-type without a body: Fastify rejects an empty JSON body (DELETE / GET).
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    };
    if (init.customer) {
      const customer = this.snapshot.customer;
      if (!customer || Date.parse(customer.expiresAt) <= Date.now()) {
        this.set({ customer: null });
        return { ok: false, error: 'unauthorized' };
      }
      headers['x-customer-token'] = customer.token;
    }
    try {
      const res = await this.api<T | { error: { code: string; details?: { until?: string } } }>(
        pairing,
        path,
        {
          method: init.method,
          headers,
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        },
      );
      if (res.status >= 200 && res.status < 300) return { ok: true, body: res.body as T };
      const err =
        res.body && typeof res.body === 'object' && 'error' in res.body ? res.body.error : null;
      const code = err?.code ?? (res.status === 429 ? 'rate_limited' : 'generic');
      if (code === 'unauthorized' && init.customer) this.set({ customer: null });
      const known: CustomerActionError[] = [
        'rate_limited',
        'invalid_credentials',
        'locked',
        'login_disabled',
        'blocked',
        'requests_disabled',
        'unauthorized',
        'session_active',
        'no_session',
        'request_pending',
        'conflict',
        'validation_error',
        'not_found',
        'orders_disabled',
        'out_of_stock',
        'pause_disabled',
        'resume_disabled',
      ];
      return {
        ok: false,
        error: known.includes(code as CustomerActionError)
          ? (code as CustomerActionError)
          : 'generic',
        ...(err?.details?.until ? { until: err.details.until } : {}),
      };
    } catch {
      return { ok: false, error: 'network' };
    }
  }

  /** Customer signs in with the username + PIN the staff gave them (verified by the server). */
  async customerLogin(
    username: string,
    password: string,
  ): Promise<
    | { ok: true; customer: CustomerLoginResponse['customer']; pending: SessionRequest | null }
    | { ok: false; error: CustomerActionError; until?: string }
  > {
    const res = await this.customerCall<CustomerLoginResponse>('/client/customer-login', {
      method: 'POST',
      body: { username: username.trim().toLowerCase(), password },
    });
    if (!res.ok) return res;
    this.set({
      customer: {
        token: res.body.customerToken,
        expiresAt: res.body.expiresAt,
        customer: res.body.customer,
      },
      request: res.body.pending ?? this.snapshot.request,
    });
    return { ok: true, customer: res.body.customer, pending: res.body.pending };
  }

  async customerLogout(): Promise<void> {
    const { customer } = this.snapshot;
    this.set({ customer: null });
    if (!customer) return;
    await this.customerCall('/client/customer-logout', { method: 'POST', body: {} }).catch(
      () => undefined,
    );
  }

  /** A signed-in customer whose token is still valid (null otherwise). */
  customerSignedIn(): CustomerLoginState | null {
    const { customer } = this.snapshot;
    return customer && Date.parse(customer.expiresAt) > Date.now() ? customer : null;
  }

  /** What may be requested on this PC right now (quick durations with prices, packages). */
  async requestOptions(): Promise<
    { ok: true; options: ClientRequestOptions } | { ok: false; error: CustomerActionError }
  > {
    const res = await this.customerCall<ClientRequestOptions>('/client/request-options', {
      method: 'GET',
    });
    return res.ok ? { ok: true, options: res.body } : res;
  }

  async createRequest(
    input: SessionRequestCreate,
  ): Promise<{ ok: true; request: SessionRequest } | { ok: false; error: CustomerActionError }> {
    const res = await this.customerCall<SessionRequest>('/client/session-request', {
      method: 'POST',
      body: input,
      customer: true,
    });
    if (!res.ok) return res;
    this.set({ request: res.body });
    return { ok: true, request: res.body };
  }

  /** The customer takes the waiting request back (device-scoped — no customer token needed). */
  async cancelRequest(): Promise<boolean> {
    const current = this.snapshot.request;
    if (!current || current.status !== 'pending') return false;
    const res = await this.customerCall<SessionRequest>(`/client/session-request/${current.id}`, {
      method: 'DELETE',
    });
    // The customer took it back themselves — nothing to announce on screen. (A request the staff
    // answered in the meantime comes back with its real status and stays visible.)
    if (res.ok) this.set({ request: res.body.status === 'cancelled' ? null : res.body });
    else if (res.error === 'not_found') this.set({ request: null });
    return res.ok;
  }

  /** Clears an answered request from the screen. */
  dismissRequest(): void {
    if (this.snapshot.request?.status !== 'pending') this.set({ request: null });
  }

  // ─── Orders from the seat + customer pause / resume (0.10.0) ─────────────────
  // The PC only *asks*: the menu, prices and every status come from the server; staff accept,
  // reject and settle in LIKApcs. Money never moves here.

  /** What can be ordered right now (needs a running session on this PC). */
  async loadMenu(): Promise<
    { ok: true; menu: ClientMenu } | { ok: false; error: CustomerActionError }
  > {
    const res = await this.customerCall<ClientMenu>('/client/menu', { method: 'GET' });
    if (!res.ok) return res;
    const { pairing } = this.snapshot;
    const base = pairing?.serverUrl ?? '';
    return {
      ok: true,
      menu: {
        ...res.body,
        items: res.body.items.map((item) => ({
          ...item,
          imageUrl: item.imageUrl?.startsWith('/') ? `${base}${item.imageUrl}` : item.imageUrl,
        })),
      },
    };
  }

  async placeOrder(
    input: OrderCreate,
  ): Promise<{ ok: true; order: OrderView } | { ok: false; error: CustomerActionError }> {
    const res = await this.customerCall<StationOrder>('/client/orders', {
      method: 'POST',
      body: input,
      customer: Boolean(this.customerSignedIn()),
    });
    if (!res.ok) return res;
    const order = orderViewOf(res.body);
    this.upsertOrder(order);
    return { ok: true, order };
  }

  /** The customer takes a still-pending order back. */
  async cancelOrder(id: string): Promise<boolean> {
    const res = await this.customerCall<StationOrder>(`/client/orders/${id}`, { method: 'DELETE' });
    if (res.ok) this.upsertOrder(orderViewOf(res.body));
    else if (res.error === 'not_found')
      this.set({ orders: this.snapshot.orders.filter((o) => o.id !== id) });
    return res.ok;
  }

  /** Re-reads the session's orders (panel opened, reconnect) — pushes may have been missed. */
  async refreshOrders(): Promise<void> {
    const res = await this.customerCall<{ items: StationOrder[] }>('/client/orders', {
      method: 'GET',
    });
    if (res.ok) this.set({ orders: res.body.items.map(orderViewOf) });
  }

  private upsertOrder(order: OrderView): void {
    const rest = this.snapshot.orders.filter((o) => o.id !== order.id);
    this.set({ orders: [order, ...rest].sort((a, b) => b.number - a.number).slice(0, 30) });
  }

  /** `server.order`: the desk answered — list + a short flash in the widget. */
  private onOrderPush(order: OrderView): void {
    const before = this.snapshot.orders.find((o) => o.id === order.id);
    this.upsertOrder(order);
    if (before?.status !== order.status && order.status !== 'pending')
      this.set({ orderFlash: { order, untilMs: this.clock.now() + ORDER_FLASH_MS } });
  }

  dismissOrderFlash(): void {
    if (this.snapshot.orderFlash) this.set({ orderFlash: null });
  }

  /** "Pause" in the widget: the server pauses the session and mirrors `session.pause` back. */
  async customerPause(): Promise<{ ok: true } | { ok: false; error: CustomerActionError }> {
    const res = await this.customerCall<unknown>('/client/session-pause', { method: 'POST' });
    return res.ok ? { ok: true } : res;
  }

  /** "Resume" on the covered screen. */
  async customerResume(): Promise<{ ok: true } | { ok: false; error: CustomerActionError }> {
    const res = await this.customerCall<unknown>('/client/session-resume', { method: 'POST' });
    return res.ok ? { ok: true } : res;
  }

  /** On every welcome: the server's view of the pending request wins (restart / reconnect). */
  private async reconcileRequest(pendingId: string | null): Promise<void> {
    const local = this.snapshot.request;
    const id = pendingId ?? (local?.status === 'pending' ? local.id : null);
    if (!id) return;
    const res = await this.customerCall<SessionRequest>(`/client/session-request/${id}`, {
      method: 'GET',
    });
    if (res.ok) this.set({ request: res.body });
    else if (res.error === 'not_found') this.set({ request: null });
  }

  /** `server.request`: the staff answered (or the server cancelled) — show it instantly. */
  private onRequestPush(push: ServerRequestUpdate['request']): void {
    const merged = mergeRequestPush(this.snapshot.request, push);
    if (!merged) return;
    if ('request' in merged) this.set({ request: merged.request });
    else void this.reconcileRequest(merged.fetch);
  }

  // ─── 1 s tick: countdown, local expiry, notice expiry ─────────────────────
  private onTick(): void {
    const now = this.clock.now();
    const { state } = this.snapshot;
    let next = state;
    if (state.session && sessionView(state.session, now).expired) {
      next = { ...state, mode: 'locked', session: null };
      this.send({
        type: 'client.event',
        event: 'session_expired_locally',
        payload: { sessionId: state.session.id },
      });
    }
    if (state.mode === 'free' && state.maintenance && state.maintenance.untilServerMs <= now) {
      // The staff unlock ran out: lock locally right away (the server sends `lock` as well).
      next = { ...next, mode: 'locked', maintenance: null };
      this.send({
        type: 'client.event',
        event: 'maintenance_ended',
        payload: { reason: 'expired' },
      });
    }
    if (state.notice && state.notice.untilServerMs <= now) next = { ...next, notice: null };
    if (next !== state) this.setState(next);
    if (requestResultExpired(this.snapshot.request, now)) this.set({ request: null });
    if (this.snapshot.orderFlash && this.snapshot.orderFlash.untilMs <= now)
      this.set({ orderFlash: null });
    this.set({ serverNowMs: now });
    // Periodic slideshow refresh while locked (new products / photos appear without a reconnect).
    if (next.mode === 'locked' && this.snapshot.phase.phase === 'online') this.refreshAds();
  }
}

export const agent = new Agent();
