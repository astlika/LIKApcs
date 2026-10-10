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
  type RegisterDeviceResponse,
  type RegistrationPollResponse,
  type ServerCommand,
  type ServerToClientMessage,
} from '@likapcs/shared';
import {
  APP_VERSION,
  applySelfUpdate,
  deviceIdentity,
  discoverServers,
  powerAction,
  randomToken,
  secretDelete,
  secretGet,
  secretSet,
  setWindowMode,
  sha256Hex,
  type DeviceIdentity,
} from './native';
import {
  Clock,
  CommandGuard,
  applyWelcome,
  backoffMs,
  initialState,
  reduce,
  sessionView,
  type ClientState,
  type Effect,
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
}

const KEYS = {
  pairing: 'pairing',
  registration: 'registration',
  token: 'device-token',
  machineFallback: 'machine-id-fallback',
  language: 'language',
} as const;

const REGISTRATION_POLL_MS = 5000;
const NO_SERVER_RETRY_MS = 6000;
const REJECTED_RETRY_S = 120;
const DISCOVERY_AFTER_FAILURES = 6;

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
  };
  private readonly listeners = new Set<Listener>();
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

  // ─── store ────────────────────────────────────────────────────────────────
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): AgentSnapshot => this.snapshot;
  private set(patch: Partial<AgentSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }
  private setPhase(phase: Phase): void {
    this.set({ phase });
  }
  private setState(state: ClientState): void {
    const modeChanged = state.mode !== this.snapshot.state.mode;
    this.set({ state });
    if (modeChanged || !this.modeApplied) {
      this.modeApplied = true;
      void setWindowMode(state.mode === 'locked' ? 'locked' : 'overlay');
    }
  }
  private modeApplied = false;

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
    this.set({ identity, machineId, state: { ...this.snapshot.state, language } });
    this.tick = setInterval(() => this.onTick(), 1000);
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.tick) clearInterval(this.tick);
    this.closeSocket(1000, 'client stopping');
    this.wake?.();
  }

  /** Technician action (settings panel, unpaired only): use a fixed server address. */
  async useManualServer(url: string): Promise<void> {
    const cleaned = url.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/.+/.test(cleaned)) throw new Error('invalid url');
    await this.savePairing({ serverUrl: cleaned, installationId: null, source: 'manual' });
    this.closeSocket(4000, 'server changed');
    this.wake?.();
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
    const best = found[0];
    if (!best?.urls[0]) return null;
    const pairing: Pairing = {
      serverUrl: best.urls[0],
      installationId: best.installationId,
      source: 'discovery',
    };
    await this.savePairing(pairing);
    return pairing;
  }

  /** After repeated failures, look for the pinned installation again (its IP may have changed). */
  private async rediscover(pairing: Pairing): Promise<void> {
    if (pairing.source !== 'discovery' || !pairing.installationId) return;
    const found = await discoverServers(2500).catch(() => []);
    const same = found.find((s) => s.installationId === pairing.installationId);
    const url = same?.urls[0];
    if (url && url !== pairing.serverUrl) await this.savePairing({ ...pairing, serverUrl: url });
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
            break;
          }
          case 'server.heartbeat_ack':
            this.clock.sync(message.serverTime);
            this.lastAckAt = Date.now();
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
      const { state } = this.snapshot;
      this.send({
        type: 'client.heartbeat',
        ts: new Date(this.clock.now()).toISOString(),
        sessionId: state.session?.id ?? null,
        locked: state.mode === 'locked',
        metrics: { uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000) },
      });
    }, this.heartbeatIntervalMs);
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
    }
  }

  private async selfUpdate(trigger: 'command' | 'incompatible'): Promise<void> {
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
    this.set({ serverNowMs: now });
  }
}

export const agent = new Agent();
