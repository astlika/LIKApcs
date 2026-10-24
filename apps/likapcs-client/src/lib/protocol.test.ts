import { describe, expect, it } from 'vitest';
import type { ServerCommand, ServerWelcomeToClient, SessionRequest } from '@likapcs/shared';
import {
  REQUEST_RESULT_MS,
  mergeRequestPush,
  requestResultExpired,
  candidateServerUrls,
  normalizeServerUrl,
  Clock,
  CommandGuard,
  applyDisplay,
  applyWelcome,
  backoffMs,
  withAbsoluteWallpaper,
  formatHMS,
  initialState,
  reduce,
  sessionView,
  baseWindowModeOf,
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

  it('a live staff maintenance grant in the welcome keeps the PC open; an expired one does not', () => {
    const live = applyWelcome(initialState, {
      ...welcome,
      maintenance: { until: new Date(T0 + 600_000).toISOString(), byName: 'Arta' },
    });
    expect(live.mode).toBe('free');
    expect(live.maintenance).toEqual({ untilServerMs: T0 + 600_000, byName: 'Arta' });
    const stale = applyWelcome(initialState, {
      ...welcome,
      maintenance: { until: new Date(T0 - 1000).toISOString(), byName: 'Arta' },
    });
    expect(stale.mode).toBe('locked');
    expect(stale.maintenance).toBeNull();
    // A session always wins over a grant.
    const both = applyWelcome(initialState, {
      ...welcome,
      maintenance: { until: new Date(T0 + 600_000).toISOString(), byName: 'Arta' },
      session: {
        id: 'g2',
        status: 'active',
        startedAt: new Date(T0).toISOString(),
        endsAt: null,
        pausedAt: null,
        remainingSeconds: null,
      },
    });
    expect(both.mode).toBe('session');
    expect(both.maintenance).toBeNull();
  });

  it('a time-limited unlock records the grant; lock and session.start clear it', () => {
    const state = applyWelcome(initialState, welcome);
    const until = new Date(T0 + 900_000).toISOString();
    const open = reduce(
      state,
      cmd({ command: 'unlock', payload: { reason: 'maintenance', until, byName: 'Arta' } }),
      T0,
    );
    expect(open.ok).toBe(true);
    expect(open.state.mode).toBe('free');
    expect(open.state.maintenance).toEqual({ untilServerMs: T0 + 900_000, byName: 'Arta' });
    expect(reduce(open.state, cmd({ command: 'lock' }), T0).state.maintenance).toBeNull();
    const started = reduce(
      open.state,
      cmd({ command: 'session.start', payload: { sessionId: 'g3', endsAt: null } }),
      T0,
    );
    expect(started.state.mode).toBe('session');
    expect(started.state.maintenance).toBeNull();
    // Legacy open-ended unlock (no `until`) never expires on the PC.
    const legacy = reduce(state, cmd({ command: 'unlock' }), T0);
    expect(legacy.state.maintenance?.untilServerMs).toBe(Number.POSITIVE_INFINITY);
  });

  it('runs a prepaid session through start → pause → resume → extend → end', () => {
    let state = applyWelcome(initialState, welcome);
    const endsAt = new Date(T0 + 3_600_000).toISOString();
    let r = reduce(
      state,
      cmd({
        command: 'session.start',
        payload: {
          sessionId: 'g1',
          startedAt: new Date(T0).toISOString(),
          endsAt,
          billing: {
            billingMode: 'prepaid',
            paidCents: 150,
            terms: null,
            billableSeconds: 0,
            asOf: new Date(T0).toISOString(),
          },
        },
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
      paidCents: 150,
      owedCents: null,
      billingMode: 'prepaid',
    });

    r = reduce(state, cmd({ command: 'session.pause', payload: { sessionId: 'g1' } }), T0 + 60_000);
    expect(r.ok).toBe(true);
    state = r.state;
    expect(sessionView(state.session!, T0 + 600_000)).toEqual({
      kind: 'countdown',
      seconds: 3540,
      paused: true,
      expired: false,
      paidCents: 150,
      owedCents: null,
      billingMode: 'prepaid',
    });
    // A pause without a `pausedBy` (0.9 servers) counts as a staff pause; the covered screen is
    // the locked window, the widget comes back with the resume.
    expect(state.session?.pausedBy).toBe('staff');
    expect(state.session?.autoResumeAt).toBeNull();
    expect(baseWindowModeOf(state)).toBe('locked');

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
    expect(state.session?.pausedBy).toBeNull();
    expect(baseWindowModeOf(state)).toBe('overlay');

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

  it('keeps who paused and the automatic resume instant (0.10.0)', () => {
    const autoResumeAt = new Date(T0 + 15 * 60_000).toISOString();
    const started = reduce(
      applyWelcome(initialState, welcome),
      cmd({
        command: 'session.start',
        payload: { sessionId: 'g1', startedAt: new Date(T0).toISOString(), endsAt: null },
      }),
      T0,
    ).state;
    const paused = reduce(
      started,
      cmd({
        command: 'session.pause',
        payload: { sessionId: 'g1', remainingSeconds: null, pausedBy: 'customer', autoResumeAt },
      }),
      T0 + 1000,
    ).state;
    expect(paused.session).toMatchObject({ status: 'paused', pausedBy: 'customer', autoResumeAt });
    expect(baseWindowModeOf(paused)).toBe('locked');
    // The welcome after a reconnect carries the same facts.
    const fromWelcome = applyWelcome(initialState, {
      ...welcome,
      session: {
        id: 'g1',
        status: 'paused',
        startedAt: new Date(T0).toISOString(),
        endsAt: null,
        pausedAt: new Date(T0 + 1000).toISOString(),
        pausedBy: 'grace',
        autoResumeAt: null,
        remainingSeconds: null,
      },
    });
    expect(fromWelcome.session).toMatchObject({ pausedBy: 'grace', autoResumeAt: null });
    expect(baseWindowModeOf(fromWelcome)).toBe('locked');
    expect(baseWindowModeOf({ ...fromWelcome, mode: 'free', session: null })).toBe('overlay');
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
      // No billing snapshot from the server → the widget shows no money rather than a guess.
      paidCents: null,
      owedCents: null,
      billingMode: null,
    });
  });

  it('end-pay sessions show the fixed amount due at the end, labelled as such', () => {
    const state = applyWelcome(initialState, welcome);
    const r = reduce(
      state,
      cmd({
        command: 'session.start',
        payload: {
          sessionId: 'g4',
          startedAt: new Date(T0).toISOString(),
          endsAt: new Date(T0 + 3_600_000).toISOString(),
          billing: {
            billingMode: 'endpay',
            paidCents: 0,
            dueCents: 300,
            terms: null,
            billableSeconds: 0,
            asOf: new Date(T0).toISOString(),
          },
        },
      }),
      T0,
    );
    expect(r.ok).toBe(true);
    expect(sessionView(r.state.session!, T0 + 60_000)).toMatchObject({
      kind: 'countdown',
      seconds: 3540,
      paidCents: null,
      owedCents: 300,
      billingMode: 'endpay',
    });
  });

  it('postpaid sessions show a running amount derived from the server terms, frozen while paused', () => {
    const terms = {
      rateCentsPerHour: 120,
      billingIncrementMinutes: 1,
      minimumMinutes: 0,
      minimumChargeCents: 0,
      roundingMode: 'nearest' as const,
      roundingIncrementCents: 1,
    };
    const state = applyWelcome(initialState, welcome);
    let r = reduce(
      state,
      cmd({
        command: 'session.start',
        payload: {
          sessionId: 'g4',
          startedAt: new Date(T0).toISOString(),
          endsAt: null,
          billing: {
            billingMode: 'postpaid',
            paidCents: 0,
            terms,
            billableSeconds: 0,
            asOf: new Date(T0).toISOString(),
          },
        },
      }),
      T0,
    );
    // 30 minutes at 1.20 €/h → 0.60 €
    expect(sessionView(r.state.session!, T0 + 1_800_000).owedCents).toBe(60);
    r = reduce(
      r.state,
      cmd({ command: 'session.pause', payload: { sessionId: 'g4' } }),
      T0 + 1_800_000,
    );
    // Paused: time and money stand still.
    expect(sessionView(r.state.session!, T0 + 3_600_000)).toMatchObject({
      paused: true,
      seconds: 1800,
      owedCents: 60,
    });
    // Resume carries a fresh snapshot (billable seconds exclude the pause) → counting continues.
    r = reduce(
      r.state,
      cmd({
        command: 'session.resume',
        payload: {
          sessionId: 'g4',
          endsAt: null,
          billing: {
            billingMode: 'postpaid',
            paidCents: 0,
            terms,
            billableSeconds: 1800,
            asOf: new Date(T0 + 3_600_000).toISOString(),
          },
        },
      }),
      T0 + 3_600_000,
    );
    expect(sessionView(r.state.session!, T0 + 5_400_000).owedCents).toBe(120);
  });

  it('server.display replaces the customer-screen configuration without touching the session', () => {
    const state = { ...applyWelcome(initialState, welcome), mode: 'session' as const };
    const next = applyDisplay(state, {
      type: 'server.display',
      display: {
        widgetSize: 'small',
        widgetPosition: 'bottom-left',
        widgetStyle: 'minimal',
        widgetTheme: 'indigo',
        wallpaperUrl: null,
        desktopWallpaperUrl: null,
        widgetShowPayment: false,
        widgetHideInGames: true,
        blockWinInGames: true,
        lockTitle: 'station',
        currency: 'EUR',
        staffLoginUsername: 'admin',
        customerLogin: true,
        customerPause: true,
        customerResume: true,
        pauseMaxMinutes: 15,
        orders: true,
        ordersNote: false,
        ordersLocked: true,
        wallet: true,
        ads: {
          enabled: true,
          layout: 'full',
          transition: 'fade',
          intervalSeconds: 5,
          showPrice: false,
          grid: '3x3',
          fullscreen: true,
          showClock: false,
          showBrand: true,
          showStation: true,
          showStatus: false,
          showCategory: true,
          showProgress: true,
          imageFit: 'cover',
          caption: 'top',
          motion: true,
          background: 'ocean',
          tickerText: 'Happy hour 18:00 – 20:00',
          style: 'poster',
          shuffle: false,
          promoCountdown: true,
        },
      },
      businessName: 'Arena 2',
      welcomeMessage: 'Hi',
      language: 'sq',
    });
    expect(next.mode).toBe('session');
    expect(next.display?.widgetStyle).toBe('minimal');
    expect(next.display?.ads.layout).toBe('full');
    expect(next.display?.ads.fullscreen).toBe(true);
    expect(next.display?.ads.showClock).toBe(false);
    expect(next.display?.ads.grid).toBe('3x3');
    expect(next.display?.ads.tickerText).toBe('Happy hour 18:00 – 20:00');
    expect(next.businessName).toBe('Arena 2');
    expect(next.language).toBe('sq');
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
    expect(reduce(state, cmd({ command: 'wol.configure' }), T0).effects).toEqual([
      { type: 'wol_configure' },
    ]);
    state = msg.state;
    expect(state.mode).toBe('locked');
  });

  it('End Task only ever closes the listed programs — never itself, never the shell', () => {
    const state = applyWelcome(initialState, welcome);
    const run = reduce(
      state,
      cmd({
        command: 'tasks.end',
        payload: { exes: ['C:\\Games\\cs2', 'steam.EXE', 'likapcs-client.exe', 'not a name?'] },
      }),
      T0,
    );
    expect(run.ok).toBe(true);
    expect(run.state.mode).toBe(state.mode); // nothing about the lock/session changes
    expect(run.effects).toEqual([
      {
        type: 'end_tasks',
        exes: ['cs2.exe', 'steam.exe'],
        // Only what was refused is reported as skipped — the rest was closed.
        skipped: ['likapcs-client.exe', 'not a name?'],
      },
    ]);

    // A list with nothing usable in it is refused instead of silently doing nothing.
    const onlyProtected = reduce(
      state,
      cmd({ command: 'tasks.end', payload: { exes: ['explorer.exe', 'svchost'] } }),
      T0,
    );
    expect(onlyProtected.ok).toBe(false);
    expect(onlyProtected.effects).toEqual([]);
    const empty = reduce(state, cmd({ command: 'tasks.end', payload: {} }), T0);
    expect(empty.ok).toBe(false);
    expect(empty.error).toMatch(/no programs to close/);
  });
});

describe('server address helpers', () => {
  it('normalises typed addresses to http://host:port', () => {
    expect(normalizeServerUrl('192.168.1.10')).toBe('http://192.168.1.10:4700');
    expect(normalizeServerUrl(' 192.168.1.10:4700 ')).toBe('http://192.168.1.10:4700');
    expect(normalizeServerUrl('http://main-pc:4700/')).toBe('http://main-pc:4700');
    expect(normalizeServerUrl('MAIN-PC:4701')).toBe('http://main-pc:4701');
    expect(normalizeServerUrl('https://likapcs.example.com')).toBe('https://likapcs.example.com');
    expect(normalizeServerUrl('http://10.0.0.5:4700/api/v1/x?y=1')).toBe('http://10.0.0.5:4700');
    expect(normalizeServerUrl('')).toBeNull();
    expect(normalizeServerUrl('   ')).toBeNull();
    expect(normalizeServerUrl('ftp://x')).toBeNull();
    expect(normalizeServerUrl('http://')).toBeNull();
    expect(normalizeServerUrl('not an address!!')).toBeNull();
    expect(normalizeServerUrl('192.168.1.10:abc')).toBeNull();
  });

  it('tries the discovery reply source first, then the advertised addresses, without duplicates', () => {
    const urls = candidateServerUrls({
      from: '192.168.1.10',
      port: 4700,
      urls: ['http://192.168.56.1:4700', 'http://192.168.1.10:4700', 'http://172.20.0.1:4700'],
    });
    expect(urls).toEqual([
      'http://192.168.1.10:4700',
      'http://192.168.56.1:4700',
      'http://172.20.0.1:4700',
    ]);
    expect(candidateServerUrls({ port: 4700, urls: ['http://10.0.0.2:4700'] })).toEqual([
      'http://10.0.0.2:4700',
    ]);
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

describe('customer session requests (0.9.0)', () => {
  const pending: SessionRequest = {
    id: 'r1',
    stationId: 's1',
    stationCode: 'PC1',
    stationName: 'PC 1',
    customerId: 'c1',
    customerName: 'Lika',
    customerCode: 'C-0001',
    customerBalanceDueCents: 0,
    kind: 'start',
    minutes: 60,
    packageId: null,
    packageName: null,
    durationMinutes: 60,
    sessionId: null,
    status: 'pending',
    reason: null,
    requestedAt: '2026-10-12T10:00:00.000Z',
    decidedAt: null,
    decidedByName: null,
  };

  it('takes the staff answer over for the request on screen', () => {
    const merged = mergeRequestPush(pending, {
      id: 'r1',
      kind: 'start',
      status: 'rejected',
      reason: 'Full house',
      decidedAt: '2026-10-12T10:01:00.000Z',
    });
    expect(merged).toEqual({
      request: {
        ...pending,
        status: 'rejected',
        reason: 'Full house',
        decidedAt: '2026-10-12T10:01:00.000Z',
      },
    });
  });

  it('asks the shell to load an unknown pending request and ignores answers to unknown ones', () => {
    const push = { id: 'r2', kind: 'extend' as const, reason: null, decidedAt: null };
    expect(mergeRequestPush(null, { ...push, status: 'pending' })).toEqual({ fetch: 'r2' });
    expect(mergeRequestPush(pending, { ...push, status: 'pending' })).toEqual({ fetch: 'r2' });
    expect(
      mergeRequestPush(null, { ...push, status: 'approved', decidedAt: '2026-10-12T10:01:00Z' }),
    ).toBeNull();
  });

  it('fades an answered request after a minute, never a pending one', () => {
    const decidedAt = '2026-10-12T10:01:00.000Z';
    const answered: SessionRequest = { ...pending, status: 'approved', decidedAt };
    const t0 = Date.parse(decidedAt);
    expect(requestResultExpired(pending, t0 + 10 * REQUEST_RESULT_MS)).toBe(false);
    expect(requestResultExpired(answered, t0 + REQUEST_RESULT_MS - 1)).toBe(false);
    expect(requestResultExpired(answered, t0 + REQUEST_RESULT_MS + 1)).toBe(true);
    expect(requestResultExpired(null, t0)).toBe(false);
  });
});

describe('withAbsoluteWallpaper (0.20.0)', () => {
  const base = { widgetTheme: 'indigo', wallpaperUrl: null } as unknown as Parameters<
    typeof withAbsoluteWallpaper
  >[0];

  it('prefixes the server address to a relative wallpaper path', () => {
    const out = withAbsoluteWallpaper(
      { ...base, wallpaperUrl: '/api/v1/files/wallpapers/abc.png' },
      'http://192.168.1.10:4010',
    );
    expect(out.wallpaperUrl).toBe('http://192.168.1.10:4010/api/v1/files/wallpapers/abc.png');
  });

  it('leaves a missing wallpaper alone', () => {
    expect(withAbsoluteWallpaper(base, 'http://x').wallpaperUrl).toBeNull();
  });

  it('keeps an already absolute URL unchanged', () => {
    const url = 'https://cdn.example.com/w.png';
    expect(withAbsoluteWallpaper({ ...base, wallpaperUrl: url }, 'http://x').wallpaperUrl).toBe(
      url,
    );
  });
});
