/**
 * Live screens (remote view and control). A station PC sends small JPEG frames only while an
 * Admin session has it open. The PC is told how fast to send (`server.stream`) from what its
 * viewers need: one focused view → up to 3 frames/s at 960 px; only grid thumbnails → one frame
 * every 2.5 s at 320 px. Frames are relayed, never stored.
 *
 * Control (phase 2) is a second step on top of a focused view: the Admin turns it on, and input
 * events are relayed to the PC only while it is on, the view is focused and the session allows it.
 */
import type { WebSocket } from 'ws';
import type {
  ClientFrame,
  RemoteInputEvent,
  ServerFrame,
  ServerInput,
  ServerStream,
  ServerStreamStatus,
  ServerToAdminMessage,
} from '@likapcs/shared';
import type { AdminPresence, DevicePresence, RealtimeHub } from './hub.js';

export type RemoteMode = 'thumb' | 'focus';

const FOCUS_ORDER = { fps: 3, maxWidth: 960 } as const;
const THUMB_ORDER = { fps: 0.4, maxWidth: 320 } as const;
/** A grid thumbnail is refreshed at most this often, whatever the PC sends. */
export const THUMB_INTERVAL_MS = 2_500;
/** A viewer whose socket is this far behind drops frames instead of growing a queue. */
const MAX_BUFFERED_BYTES = 2_000_000;

interface Viewer {
  admin: AdminPresence;
  mode: RemoteMode;
  lastSentAt: number;
  controlling: boolean;
  /** Keys and buttons currently held down on the PC by this control, released if control ends. */
  heldKeys: Set<string>;
  heldButtons: Set<'left' | 'right' | 'middle'>;
}

/** A viewing session that ended, and whether the Admin was also controlling it. */
export interface ReleasedView {
  admin: AdminPresence;
  stationId: string;
  wasControlling: boolean;
}

export type ControlChange = 'started' | 'ended' | 'unchanged' | 'refused';

function send(socket: WebSocket, message: ServerToAdminMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

export class RemoteViewers {
  /** stationId → the Admin sessions watching it. */
  private readonly viewers = new Map<string, Map<AdminPresence, Viewer>>();
  /** stationId → the rate last sent to the PC (so an unchanged rate is not repeated). */
  private readonly orders = new Map<string, string>();

  constructor(
    private readonly hub: RealtimeHub,
    private readonly now: () => number = Date.now,
  ) {
    hub.on('device.online', (device) => this.deviceOnline(device));
    hub.on('device.offline', ({ stationId }) => this.deviceOffline(stationId));
  }

  /** Whether this Admin session is already watching this station. */
  isViewing(stationId: string, admin: AdminPresence): boolean {
    return this.viewers.get(stationId)?.has(admin) ?? false;
  }

  /** Whether this Admin session is controlling this station right now. */
  isControlling(stationId: string, admin: AdminPresence): boolean {
    return this.viewers.get(stationId)?.get(admin)?.controlling ?? false;
  }

  /** Whether any Admin session is watching this station right now. */
  isWatched(stationId: string): boolean {
    return (this.viewers.get(stationId)?.size ?? 0) > 0;
  }

  /**
   * An Admin opened this PC (or switched between grid and focus). Returns false when the PC is
   * offline, so nothing can be watched. Leaving focus also ends control.
   */
  start(stationId: string, admin: AdminPresence, mode: RemoteMode): boolean {
    let set = this.viewers.get(stationId);
    if (!set) {
      set = new Map();
      this.viewers.set(stationId, set);
    }
    const existing = set.get(admin);
    set.set(admin, {
      admin,
      mode,
      lastSentAt: existing?.lastSentAt ?? Number.NEGATIVE_INFINITY,
      controlling: mode === 'focus' && (existing?.controlling ?? false),
      heldKeys: existing?.heldKeys ?? new Set(),
      heldButtons: existing?.heldButtons ?? new Set(),
    });
    if (mode === 'thumb' && existing?.controlling) this.releaseHeld(stationId, existing);
    const device = this.hub.deviceForStation(stationId);
    this.status(admin, stationId, device ? 'live' : 'offline');
    if (device) this.updateOrder(device);
    return device !== null;
  }

  /**
   * An Admin closed this PC (or left the Admin). The PC stops when nobody watches it any more.
   * Returns what was released, or null when this session was not watching the station.
   */
  stop(stationId: string, admin: AdminPresence): ReleasedView | null {
    const set = this.viewers.get(stationId);
    const viewer = set?.get(admin);
    if (!set || !viewer) return null;
    set.delete(admin);
    this.releaseHeld(stationId, viewer);
    const device = this.hub.deviceForStation(stationId);
    if (set.size === 0) {
      this.viewers.delete(stationId);
      this.orders.delete(stationId);
      if (device) this.sendOrder(device, { active: false, ...FOCUS_ORDER });
    } else if (device) {
      this.updateOrder(device);
    }
    return { admin, stationId, wasControlling: viewer.controlling };
  }

  /**
   * The Admin connection closed: release every PC it watched. Returns what was released, so the
   * caller can record the end of each view (and of each control).
   */
  detachAdmin(admin: AdminPresence): ReleasedView[] {
    const released: ReleasedView[] = [];
    for (const stationId of [...this.viewers.keys()]) {
      const view = this.stop(stationId, admin);
      if (view) released.push(view);
    }
    return released;
  }

  /**
   * Turns control on or off for a focused view. Control needs a focused view; grid thumbnails
   * cannot control. The permission is checked by the caller.
   */
  setControl(stationId: string, admin: AdminPresence, on: boolean): ControlChange {
    const viewer = this.viewers.get(stationId)?.get(admin);
    if (!viewer) return on ? 'refused' : 'unchanged';
    if (on) {
      if (viewer.mode !== 'focus') return 'refused';
      if (viewer.controlling) return 'unchanged';
      viewer.controlling = true;
      return 'started';
    }
    if (!viewer.controlling) return 'unchanged';
    viewer.controlling = false;
    this.releaseHeld(stationId, viewer);
    return 'ended';
  }

  /** Relays one input event to the PC, if this Admin is controlling it. */
  relayInput(stationId: string, admin: AdminPresence, event: RemoteInputEvent): boolean {
    const viewer = this.viewers.get(stationId)?.get(admin);
    if (!viewer?.controlling || viewer.mode !== 'focus') return false;
    const device = this.hub.deviceForStation(stationId);
    if (!device) return false;
    // Track what is held down, so that a lost connection cannot leave a key stuck on the PC.
    if (event.kind === 'key') {
      if (event.down) viewer.heldKeys.add(event.code);
      else viewer.heldKeys.delete(event.code);
    } else if (event.kind === 'button') {
      if (event.down) viewer.heldButtons.add(event.button);
      else viewer.heldButtons.delete(event.button);
    }
    const message: ServerInput = { type: 'server.input', event };
    return this.hub.sendToDevice(device.deviceId, message);
  }

  /** Sends the release of every key and button still held by a control that just ended. */
  private releaseHeld(stationId: string, viewer: Viewer): void {
    const device = this.hub.deviceForStation(stationId);
    for (const code of viewer.heldKeys) {
      if (device) this.sendInput(device, { kind: 'key', code, down: false });
    }
    for (const button of viewer.heldButtons) {
      if (device) this.sendInput(device, { kind: 'button', button, down: false });
    }
    viewer.heldKeys.clear();
    viewer.heldButtons.clear();
  }

  private sendInput(device: DevicePresence, event: RemoteInputEvent): void {
    const message: ServerInput = { type: 'server.input', event };
    this.hub.sendToDevice(device.deviceId, message);
  }

  /**
   * The session on this PC ended: the view and any control stop, and every Admin watching it is
   * told why. Returns what was released, for the audit log.
   */
  endStation(stationId: string): ReleasedView[] {
    const set = this.viewers.get(stationId);
    if (!set) return [];
    this.viewers.delete(stationId);
    this.orders.delete(stationId);
    const device = this.hub.deviceForStation(stationId);
    if (device) this.sendOrder(device, { active: false, ...FOCUS_ORDER });
    const released: ReleasedView[] = [];
    for (const viewer of set.values()) {
      this.releaseHeld(stationId, viewer);
      this.status(viewer.admin, stationId, 'ended');
      released.push({ admin: viewer.admin, stationId, wasControlling: viewer.controlling });
    }
    return released;
  }

  /** A frame from a PC. Relayed to its viewers; thumbnails are throttled, slow sockets drop frames. */
  onFrame(stationId: string, frame: ClientFrame): void {
    const set = this.viewers.get(stationId);
    if (!set || set.size === 0) return;
    const now = this.now();
    const message: ServerFrame = {
      type: 'server.frame',
      stationId,
      width: frame.width,
      height: frame.height,
      jpeg: frame.jpeg,
      ts: frame.ts,
    };
    const text = JSON.stringify(message);
    for (const viewer of set.values()) {
      const { socket } = viewer.admin;
      if (socket.readyState !== socket.OPEN) continue;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      if (viewer.mode === 'thumb' && now - viewer.lastSentAt < THUMB_INTERVAL_MS) continue;
      viewer.lastSentAt = now;
      socket.send(text);
    }
  }

  /** The rate the PC should use now: focus if anyone has a focused view, otherwise thumbnails. */
  private desiredOrder(stationId: string): { active: true; fps: number; maxWidth: number } {
    const modes = [...(this.viewers.get(stationId)?.values() ?? [])].map((v) => v.mode);
    const order = modes.includes('focus') ? FOCUS_ORDER : THUMB_ORDER;
    return { active: true, ...order };
  }

  private updateOrder(device: DevicePresence): void {
    const order = this.desiredOrder(device.stationId);
    const key = `${order.fps}/${order.maxWidth}`;
    if (this.orders.get(device.stationId) === key) return;
    this.orders.set(device.stationId, key);
    this.sendOrder(device, order);
  }

  private sendOrder(
    device: DevicePresence,
    order: Pick<ServerStream, 'active' | 'fps' | 'maxWidth'>,
  ): void {
    const message: ServerStream = { type: 'server.stream', ...order };
    this.hub.sendToDevice(device.deviceId, message);
  }

  private status(
    admin: AdminPresence,
    stationId: string,
    state: ServerStreamStatus['state'],
  ): void {
    const message: ServerStreamStatus = { type: 'server.stream_status', stationId, state };
    send(admin.socket, message);
  }

  private deviceOnline(device: DevicePresence): void {
    if (!this.isWatched(device.stationId)) return;
    this.orders.delete(device.stationId);
    this.updateOrder(device);
    for (const viewer of this.viewers.get(device.stationId)?.values() ?? [])
      this.status(viewer.admin, device.stationId, 'live');
  }

  private deviceOffline(stationId: string): void {
    this.orders.delete(stationId);
    for (const viewer of this.viewers.get(stationId)?.values() ?? [])
      this.status(viewer.admin, stationId, 'offline');
  }
}
