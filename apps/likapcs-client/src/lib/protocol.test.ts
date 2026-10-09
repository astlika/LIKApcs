import { describe, expect, it } from 'vitest';
import type { ServerCommand, ServerWelcomeToClient } from '@likapcs/shared';
import {
  Clock,
  CommandGuard,
  applyWelcome,
  backoffMs,
  formatHMS,
  initialState,
  reduce,
  sessionView,
} from './protocol';

const T0 = Date.parse('2026-10-09T12:00:00.000Z');
let n = 0;
function cmd(
  partial: Partial<ServerCommand> & { command: ServerCommand['command'] },
): ServerCommand {
  n += 1;
  return {
    type: 'server.command',
    commandId: partial.commandId ?? `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    seq: partial.seq ?? n,
    payload: partial.payload ?? {},
    issuedAt: partial.issuedAt ?? new Date(T0).toISOString(),
    expiresAt: partial.expiresAt ?? new Date(T0 + 30_000).toISOString(),
    command: partial.command,
  };
}

describe('CommandGuard (replay protection)', () => {
  it('accepts each command once, in order, before expiry', () => {
    const g = new CommandGuard();
    const a = cmd({ command: 'lock', seq: 1 });
    expect(g.check(a, T0)).toEqual({ accept: true });
    expect(g.check(a, T0)).toEqual({ accept: false, reason: 'duplicate' });
    expect(g.check(cmd({ command: 'lock', seq: 1 }), T0)).toEqual({
      accept: false,
      reason: 'out_of_order',
    });
    expect(g.check(cmd({ command: 'lock', seq: 2 }), T0)).toEqual({ accept: true });
    expect(g.check(cmd({ command: 'lock', seq: 3 }), T0 + 31_000)).toEqual({
      accept: false,
      reason: 'expired',
    });
    expect(
      g.check(
        cmd({
          command: 'lock',
          seq: 4,
          issuedAt: new Date(T0 + 10 * 60_000).toISOString(),
          expiresAt: new Date(T0 + 11 * 60_000).toISOString(),
        }),
        T0,
      ),
    ).toEqual({ accept: false, reason: 'future_dated' });
  });

  it('forgets very old ids but never accepts a lower sequence number', () => {
    const g = new CommandGuard(3);
    for (let i = 1; i <= 5; i += 1)
      expect(g.check(cmd({ command: 'lock', seq: i, commandId: `id-${i}` }), T0).accept).toBe(true);
    expect(g.check(cmd({ command: 'lock', seq: 1, commandId: 'id-1' }), T0)).toEqual({
      accept: false,
      reason: 'out_of_order',
    });
  });
});

describe('Clock', () => {
  it('tracks the server offset and reports server time', () => {
    const c = new Clock();
    expect(c.isSynced).toBe(false);
    c.sync(new Date(T0).toISOString(), T0 - 5000);
    expect(c.offset).toBe(5000);
    expect(c.now(T0)).toBe(T0 + 5000);
    c.sync('garbage', T0);
    expect(c.offset).toBe(5000);
  });
});

describe('reduce()', () => {
  const welcome: ServerWelcomeToClient = {
    type: 'server.welcome',
    protocolVersion: 1,
    serverVersion: '0.2.0',
    serverTime: new Date(T0).toISOString(),
    station: { id: 's1', number: 1, code: 'PC 01', name: 'Main hall 1' },
    heartbeatIntervalSeconds: 10,
    offlineAfterSeconds: 30,
    language: 'sq',
    welcomeMessage: 'Mirë se vini',
    businessName: 'Arena',
    session: null,
  };

  it('welcome without a session locks; with a session unlocks', () => {
    const locked = applyWelcome(initialState, welcome);
    expect(locked.mode).toBe('locked');
    expect(locked.language).toBe('sq');
    const inSession = applyWelcome(
      { ...initialState, mode: 'free' },
      {
        ...welcome,
        session: {
          id: 'g1',
          status: 'active',
          startedAt: new Date(T0 - 60_000).toISOString(),
          endsAt: new Date(T0 + 3_540_000).toISOString(),
          pausedAt: null,
          remainingSeconds: 3540,
        },
      },
    );
    expect(inSession.mode).toBe('session');
    expect(inSession.session?.id).toBe('g1');
  });

  it('runs a prepaid session through start → pause → resume → extend → end', () => {
    let state = applyWelcome(initialState, welcome);
    const endsAt = new Date(T0 + 3_600_000).toISOString();
    let r = reduce(
      state,
      cmd({
        command: 'session.start',
        payload: { sessionId: 'g1', startedAt: new Date(T0).toISOString(), endsAt },
      }),
      T0,
    );
    expect(r.ok).toBe(true);
    expect(r.state.mode).toBe('session');
    expect(r.effects).toEqual([{ type: 'event', event: 'unlocked', payload: { sessionId: 'g1' } }]);
    state = r.state;
    expect(sessionView(state.session!, T0 + 60_000)).toEqual({
      kind: 'countdown',
      seconds: 3540,
      paused: false,
      expired: false,
    });

    r = reduce(state, cmd({ command: 'session.pause', payload: { sessionId: 'g1' } }), T0 + 60_000);
    expect(r.ok).toBe(true);
    state = r.state;
    expect(sessionView(state.session!, T0 + 600_000)).toEqual({
      kind: 'countdown',
      seconds: 3540,
      paused: true,
      expired: false,
    });

    r = reduce(
      state,
      cmd({
        command: 'session.resume',
        payload: { sessionId: 'g1', endsAt: new Date(T0 + 600_000 + 3_540_000).toISOString() },
      }),
      T0 + 600_000,
    );
    state = r.state;
    expect(sessionView(state.session!, T0 + 600_000)).toMatchObject({
      seconds: 3540,
      paused: false,
    });

    r = reduce(
      state,
      cmd({
        command: 'session.extend',
        payload: { sessionId: 'g1', endsAt: new Date(T0 + 600_000 + 7_140_000).toISOString() },
      }),
      T0 + 600_000,
    );
    state = r.state;
    expect(sessionView(state.session!, T0 + 600_000).seconds).toBe(7140);

    expect(sessionView(state.session!, T0 + 600_000 + 7_141_000)).toMatchObject({
      seconds: 0,
      expired: true,
    });

    r = reduce(state, cmd({ command: 'session.end', payload: { sessionId: 'g1' } }), T0);
    expect(r.state.mode).toBe('locked');
    expect(r.state.session).toBeNull();
    expect(r.effects[0]).toMatchObject({ type: 'event', event: 'locked' });
  });

  it('rejects inconsistent session commands with an error instead of guessing', () => {
    const state = applyWelcome(initialState, welcome);
    expect(
      reduce(state, cmd({ command: 'session.pause', payload: { sessionId: 'nope' } }), T0),
    ).toMatchObject({ ok: false, error: 'no matching session' });
    expect(reduce(state, cmd({ command: 'session.start', payload: {} }), T0)).toMatchObject({
      ok: false,
      error: 'sessionId missing',
    });
    expect(
      reduce(
        state,
        cmd({
          command: 'session.start',
          payload: { sessionId: 'g2', endsAt: new Date(T0 - 1000).toISOString() },
        }),
        T0,
      ),
    ).toMatchObject({ ok: false, error: 'session already over' });
    expect(
      reduce(state, { ...cmd({ command: 'lock' }), command: 'format.disk' as never }, T0),
    ).toMatchObject({ ok: false });
  });

  it('open-ended sessions show elapsed time', () => {
    const state = applyWelcome(initialState, welcome);
    const r = reduce(
      state,
      cmd({
        command: 'session.start',
        payload: { sessionId: 'g3', startedAt: new Date(T0).toISOString(), endsAt: null },
      }),
      T0,
    );
    expect(sessionView(r.state.session!, T0 + 125_000)).toEqual({
      kind: 'elapsed',
      seconds: 125,
      paused: false,
      expired: false,
    });
  });

  it('lock/unlock/message/power/update produce the right effects', () => {
    let state = applyWelcome(initialState, welcome);
    expect(reduce(state, cmd({ command: 'unlock' }), T0).state.mode).toBe('free');
    expect(reduce({ ...state, mode: 'free' }, cmd({ command: 'lock' }), T0).state.mode).toBe(
      'locked',
    );
    const msg = reduce(
      state,
      cmd({ command: 'message.show', payload: { text: 'Closing soon', durationSeconds: 5 } }),
      T0,
    );
    expect(msg.state.notice).toMatchObject({ text: 'Closing soon', untilServerMs: T0 + 5000 });
    expect(reduce(state, cmd({ command: 'message.show', payload: {} }), T0).ok).toBe(false);
    expect(reduce(state, cmd({ command: 'power.restart' }), T0).effects).toEqual([
      { type: 'power', action: 'restart' },
    ]);
    expect(reduce(state, cmd({ command: 'power.shutdown' }), T0).effects).toEqual([
      { type: 'power', action: 'shutdown' },
    ]);
    expect(reduce(state, cmd({ command: 'update.apply' }), T0).effects).toEqual([
      { type: 'update' },
    ]);
    state = msg.state;
    expect(state.mode).toBe('locked');
  });
});

describe('helpers', () => {
  it('formats HH:MM:SS', () => {
    expect(formatHMS(0)).toBe('00:00:00');
    expect(formatHMS(59)).toBe('00:00:59');
    expect(formatHMS(3661)).toBe('01:01:01');
    expect(formatHMS(360000)).toBe('100:00:00');
    expect(formatHMS(-5)).toBe('00:00:00');
  });
  it('backs off exponentially with a cap and jitter', () => {
    expect(backoffMs(0, 0)).toBe(1000);
    expect(backoffMs(3, 0)).toBe(8000);
    expect(backoffMs(20, 0)).toBe(30_000);
    expect(backoffMs(20, 1)).toBe(36_000);
  });
});
