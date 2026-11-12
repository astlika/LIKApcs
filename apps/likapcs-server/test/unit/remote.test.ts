import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ClientFrame } from '@likapcs/shared';
import { RemoteViewers } from '../../src/realtime/remote';
import type { AdminPresence, DevicePresence } from '../../src/realtime/hub';

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];
  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }
}

function fakeHub() {
  const hub = new EventEmitter() as EventEmitter & {
    devices: Map<string, DevicePresence>;
    deviceForStation(stationId: string): DevicePresence | null;
    sendToDevice(deviceId: string, message: unknown): boolean;
    commands: Array<{ deviceId: string; message: unknown }>;
  };
  hub.devices = new Map();
  hub.commands = [];
  hub.deviceForStation = (stationId) =>
    [...hub.devices.values()].find((d) => d.stationId === stationId) ?? null;
  hub.sendToDevice = (deviceId, message) => {
    hub.commands.push({ deviceId, message });
    return true;
  };
  return hub;
}

const device = (stationId: string): DevicePresence =>
  ({ deviceId: `dev-${stationId}`, stationId }) as unknown as DevicePresence;

const admin = (socket = new FakeSocket()): AdminPresence & { socket: FakeSocket } =>
  ({ socket, userId: 'u1', username: 'ana' }) as unknown as AdminPresence & { socket: FakeSocket };

const frame: ClientFrame = {
  type: 'client.frame',
  width: 960,
  height: 540,
  jpeg: 'AAAAAAAAAAAAAAAAAAAA',
  ts: '2026-10-17T10:00:00.000Z',
};

describe('RemoteViewers', () => {
  it('asks the PC to stream only for the first viewer and to stop after the last', () => {
    const hub = fakeHub();
    hub.devices.set('d1', device('s1'));
    const remote = new RemoteViewers(hub as never);
    const a = admin();
    const b = admin();

    expect(remote.start('s1', a, 'focus')).toBe(true);
    expect(remote.start('s1', b, 'focus')).toBe(true);
    expect(hub.commands).toEqual([
      {
        deviceId: 'dev-s1',
        message: { type: 'server.stream', active: true, fps: 3, maxWidth: 1280, maxHeight: 720 },
      },
    ]);

    remote.stop('s1', a);
    expect(hub.commands).toHaveLength(1);
    remote.stop('s1', b);
    expect(hub.commands.at(-1)).toMatchObject({
      message: { type: 'server.stream', active: false },
    });
  });

  it('reports offline when the PC is not connected and sends nothing', () => {
    const hub = fakeHub();
    const remote = new RemoteViewers(hub as never);
    const a = admin();
    expect(remote.start('s9', a, 'focus')).toBe(false);
    expect(hub.commands).toHaveLength(0);
    expect(a.socket.sent).toEqual([
      { type: 'server.stream_status', stationId: 's9', state: 'offline' },
    ]);
  });

  it('relays frames only to viewers of that station, and drops frames for a slow viewer', () => {
    const hub = fakeHub();
    hub.devices.set('d1', device('s1'));
    const remote = new RemoteViewers(hub as never);
    const watching = admin();
    const other = admin();
    const slow = admin(Object.assign(new FakeSocket(), { bufferedAmount: 5_000_000 }));
    remote.start('s1', watching, 'focus');
    remote.start('s1', slow, 'focus');
    remote.start('s2', other, 'focus');

    remote.onFrame('s1', frame);
    expect(watching.socket.sent.at(-1)).toMatchObject({
      type: 'server.frame',
      stationId: 's1',
      width: 960,
    });
    expect(
      slow.socket.sent.filter((m) => (m as { type: string }).type === 'server.frame'),
    ).toHaveLength(0);
    expect(
      other.socket.sent.filter((m) => (m as { type: string }).type === 'server.frame'),
    ).toHaveLength(0);
  });

  it('releases every station when an Admin session closes, and notices a PC coming back', () => {
    const hub = fakeHub();
    hub.devices.set('d1', device('s1'));
    const remote = new RemoteViewers(hub as never);
    const a = admin();
    remote.start('s1', a, 'focus');
    remote.detachAdmin(a);
    expect(remote.isWatched('s1')).toBe(false);
    expect(hub.commands.at(-1)).toMatchObject({ message: { active: false } });

    const b = admin();
    remote.start('s1', b, 'focus');
    hub.emit('device.offline', { stationId: 's1' });
    expect(b.socket.sent.at(-1)).toEqual({
      type: 'server.stream_status',
      stationId: 's1',
      state: 'offline',
    });
    hub.emit('device.online', device('s1'));
    expect(hub.commands.at(-1)).toMatchObject({ message: { active: true } });
  });
  it('sends grid thumbnails at a slower rate, and asks the PC for the slow rate when only the grid is open', () => {
    const hub = fakeHub();
    hub.devices.set('d1', device('s1'));
    const clock = { t: 0 };
    const remote = new RemoteViewers(hub as never, () => clock.t);
    const grid = admin();
    remote.start('s1', grid, 'thumb');
    expect(hub.commands.at(-1)).toMatchObject({
      message: { active: true, fps: 0.4, maxWidth: 320, maxHeight: 180 },
    });

    const focus = admin();
    remote.start('s1', focus, 'focus');
    expect(hub.commands.at(-1)).toMatchObject({
      message: { active: true, fps: 3, maxWidth: 1280, maxHeight: 720 },
    });
    remote.stop('s1', focus);
    expect(hub.commands.at(-1)).toMatchObject({
      message: { active: true, fps: 0.4, maxWidth: 320, maxHeight: 180 },
    });

    const framesFor = (a: FakeSocket) =>
      a.sent.filter((m) => (m as { type: string }).type === 'server.frame').length;
    clock.t = 100;
    remote.onFrame('s1', frame);
    clock.t = 1_000;
    remote.onFrame('s1', frame);
    expect(framesFor(grid.socket)).toBe(1);
    clock.t = 2_600;
    remote.onFrame('s1', frame);
    expect(framesFor(grid.socket)).toBe(2);
  });
});

describe('RemoteViewers control (phase 2)', () => {
  const keyDown = { kind: 'key', code: 'KeyA', down: true } as const;
  const inputsTo = (hub: { commands: Array<{ message: unknown }> }) =>
    hub.commands
      .map((c) => c.message as { type: string; event?: unknown })
      .filter((m) => m.type === 'server.input')
      .map((m) => m.event);

  it('control needs a focused view: grid thumbnails cannot control', () => {
    const hub = fakeHub();
    hub.devices.set('d1', device('s1'));
    const remote = new RemoteViewers(hub as never);
    const a = admin();
    remote.start('s1', a, 'thumb');
    expect(remote.setControl('s1', a, true)).toBe('refused');
    expect(remote.relayInput('s1', a, keyDown)).toBe(false);
  });

  it('relays input only while controlling, and says when control starts and ends', () => {
    const hub = fakeHub();
    hub.devices.set('d1', device('s1'));
    const remote = new RemoteViewers(hub as never);
    const a = admin();
    remote.start('s1', a, 'focus');
    expect(remote.relayInput('s1', a, keyDown)).toBe(false);
    expect(remote.setControl('s1', a, true)).toBe('started');
    expect(remote.setControl('s1', a, true)).toBe('unchanged');
    expect(remote.relayInput('s1', a, keyDown)).toBe(true);
    expect(inputsTo(hub)).toEqual([keyDown]);
    expect(remote.setControl('s1', a, false)).toBe('ended');
    expect(remote.relayInput('s1', a, keyDown)).toBe(false);
  });

  it('releases keys still held when control stops, so none stays stuck on the PC', () => {
    const hub = fakeHub();
    hub.devices.set('d1', device('s1'));
    const remote = new RemoteViewers(hub as never);
    const a = admin();
    remote.start('s1', a, 'focus');
    remote.setControl('s1', a, true);
    remote.relayInput('s1', a, keyDown);
    remote.setControl('s1', a, false);
    expect(inputsTo(hub)).toContainEqual({ kind: 'key', code: 'KeyA', down: false });
  });

  it('going back to the grid ends control and releases held keys', () => {
    const hub = fakeHub();
    hub.devices.set('d1', device('s1'));
    const remote = new RemoteViewers(hub as never);
    const a = admin();
    remote.start('s1', a, 'focus');
    remote.setControl('s1', a, true);
    remote.relayInput('s1', a, keyDown);
    remote.start('s1', a, 'thumb');
    expect(remote.isControlling('s1', a)).toBe(false);
    expect(inputsTo(hub)).toContainEqual({ kind: 'key', code: 'KeyA', down: false });
  });

  it('when the session on the PC ends, every view stops, control is released and the Admins are told', () => {
    const hub = fakeHub();
    hub.devices.set('d1', device('s1'));
    const remote = new RemoteViewers(hub as never);
    const controller = admin();
    const watcher = admin();
    remote.start('s1', controller, 'focus');
    remote.setControl('s1', controller, true);
    remote.relayInput('s1', controller, keyDown);
    remote.start('s1', watcher, 'thumb');

    const released = remote.endStation('s1');
    expect(released.map((r) => [r.admin, r.wasControlling])).toEqual([
      [controller, true],
      [watcher, false],
    ]);
    expect(controller.socket.sent.at(-1)).toEqual({
      type: 'server.stream_status',
      stationId: 's1',
      state: 'ended',
    });
    expect(watcher.socket.sent.at(-1)).toEqual({
      type: 'server.stream_status',
      stationId: 's1',
      state: 'ended',
    });
    expect(remote.isWatched('s1')).toBe(false);
    expect(hub.commands.some((c) => (c.message as { active?: boolean }).active === false)).toBe(
      true,
    );
    expect(remote.relayInput('s1', controller, keyDown)).toBe(false);
  });

  it('reports what was released when an Admin disconnects while controlling', () => {
    const hub = fakeHub();
    hub.devices.set('d1', device('s1'));
    const remote = new RemoteViewers(hub as never);
    const a = admin();
    remote.start('s1', a, 'focus');
    remote.setControl('s1', a, true);
    expect(remote.detachAdmin(a)).toEqual([{ admin: a, stationId: 's1', wasControlling: true }]);
  });
});

describe('RemoteViewers resolution', () => {
  const lastOrder = (hub: { commands: Array<{ message: unknown }> }) =>
    (hub.commands.at(-1)?.message ?? {}) as {
      active?: boolean;
      maxWidth?: number;
      maxHeight?: number;
    };

  it('sends the picture size each focused view asked for, 16:9 width, 3 frames per second', () => {
    const hub = fakeHub();
    hub.devices.set('d1', device('s1'));
    const remote = new RemoteViewers(hub as never);
    const a = admin();
    remote.start('s1', a, 'focus', '480p');
    expect(lastOrder(hub)).toMatchObject({ active: true, maxWidth: 853, maxHeight: 480 });
    remote.start('s1', a, 'focus', '1080p');
    expect(lastOrder(hub)).toMatchObject({ active: true, maxWidth: 1920, maxHeight: 1080 });
    remote.start('s1', a, 'focus', '520p');
    expect(lastOrder(hub)).toMatchObject({ active: true, maxWidth: 924, maxHeight: 520 });
  });

  it('uses the largest size among focused views of the same PC, and keeps the control on change', () => {
    const hub = fakeHub();
    hub.devices.set('d1', device('s1'));
    const remote = new RemoteViewers(hub as never);
    const low = admin();
    const high = admin();
    remote.start('s1', low, 'focus', '480p');
    remote.start('s1', high, 'focus', '1080p');
    expect(lastOrder(hub)).toMatchObject({ maxHeight: 1080 });
    remote.stop('s1', high);
    expect(lastOrder(hub)).toMatchObject({ maxHeight: 480 });

    remote.setControl('s1', low, true);
    remote.start('s1', low, 'focus', '720p');
    expect(remote.isControlling('s1', low)).toBe(true);
    expect(lastOrder(hub)).toMatchObject({ maxHeight: 720 });
  });

  it('does not send a new order when the picture size is unchanged', () => {
    const hub = fakeHub();
    hub.devices.set('d1', device('s1'));
    const remote = new RemoteViewers(hub as never);
    const a = admin();
    remote.start('s1', a, 'focus', '720p');
    const before = hub.commands.length;
    remote.start('s1', a, 'focus', '720p');
    expect(hub.commands.length).toBe(before);
  });
});
