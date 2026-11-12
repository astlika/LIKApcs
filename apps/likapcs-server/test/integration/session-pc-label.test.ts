/**
 * 0.33.0 — the name a PC shows for one session. Typed at the start or changed while it runs, it
 * shows on the board; with none typed the customer's name shows; when the session ends the PC is
 * its own name again. A running session only; an empty name is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CustomerSummary,
  LoginResponse,
  SessionMutationResponse,
  StationSummary,
} from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

describe('session PC name', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let pc1: StationSummary;
  let pc2: StationSummary;
  let customer: CustomerSummary;

  const call = <T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    ctx.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: authHeader(owner.token),
        payload: payload as object,
      })
      .then((r) => ({
        status: r.statusCode,
        body: r.body ? (JSON.parse(r.body) as T) : (null as T),
        raw: r.body,
      }));

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    const shift = await call('POST', '/cash/shifts/open', { openingCents: 5000 });
    expect(shift.status).toBe(201);
    pc1 = (await call<StationSummary>('POST', '/stations', { number: 1, name: 'Arena 1' })).body;
    pc2 = (await call<StationSummary>('POST', '/stations', { number: 2, name: 'Arena 2' })).body;
    customer = (await call<CustomerSummary>('POST', '/customers', { name: 'Driton Klient' })).body;
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('shows the name typed at the start, then a changed name, and clears it back to the PC name', async () => {
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: pc1.id,
      billingMode: 'postpaid',
      customerName: 'Besa',
      pcLabel: 'Turneu 1',
    });
    expect(started.status).toBe(201);
    const sessionId = started.body.session.id;
    expect(started.body.session.pcLabel).toBe('Turneu 1');

    let board = (await call<StationSummary>('GET', `/stations/${pc1.id}`)).body;
    expect(board.activeSession?.pcLabel).toBe('Turneu 1');
    expect(board.activeSession?.customerName).toBe('Besa');

    const renamed = await call<{ pcLabel: string | null }>(
      'PATCH',
      `/sessions/${sessionId}/pc-label`,
      { pcLabel: 'Rafi' },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.pcLabel).toBe('Rafi');
    board = (await call<StationSummary>('GET', `/stations/${pc1.id}`)).body;
    expect(board.activeSession?.pcLabel).toBe('Rafi');

    const cleared = await call<{ pcLabel: string | null }>(
      'PATCH',
      `/sessions/${sessionId}/pc-label`,
      { pcLabel: null },
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.pcLabel).toBeNull();

    const ended = await call('POST', `/sessions/${sessionId}/end`, { discountCents: 0 });
    expect(ended.status).toBe(200);

    // The name belongs to the session: the PC is its own name again.
    board = (await call<StationSummary>('GET', `/stations/${pc1.id}`)).body;
    expect(board.activeSession).toBeNull();
  });

  it('uses the customer name when no PC name is typed, and refuses an empty name', async () => {
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: pc2.id,
      billingMode: 'postpaid',
      customerId: customer.id,
    });
    expect(started.status).toBe(201);
    const sessionId = started.body.session.id;

    const board = (await call<StationSummary>('GET', `/stations/${pc2.id}`)).body;
    expect(board.activeSession?.pcLabel).toBeNull();
    expect(board.activeSession?.customerName).toBe('Driton Klient');

    const empty = await call('PATCH', `/sessions/${sessionId}/pc-label`, { pcLabel: '   ' });
    expect(empty.status).toBe(400);

    await call('POST', `/sessions/${sessionId}/end`, { discountCents: 0 });
  });

  it('refuses to name a session that has already ended', async () => {
    const started = await call<SessionMutationResponse>('POST', '/sessions', {
      stationId: pc1.id,
      billingMode: 'postpaid',
    });
    const sessionId = started.body.session.id;
    await call('POST', `/sessions/${sessionId}/end`, { discountCents: 0 });

    const late = await call('PATCH', `/sessions/${sessionId}/pc-label`, { pcLabel: 'Vonë' });
    expect(late.status).toBe(409);
  });
});
