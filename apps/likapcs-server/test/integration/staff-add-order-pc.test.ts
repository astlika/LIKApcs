/**
 * What the customer sees at the PC after the desk adds a product (`POST /sessions/:id/orders`,
 * 0.27.1): the PC lists its running session's orders, so the added product appears there.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  LoginResponse,
  PricingRuleSummary,
  ProductSummary,
  RegisterDeviceResponse,
  RegistrationPollResponse,
  SessionMutationResponse,
  StationOrder,
  StationSummary,
} from '@likapcs/shared';
import { SERVER_VERSION } from '../../src/version.js';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

describe('the PC shows a product the desk added', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let station: StationSummary;
  let deviceToken: string;
  let cola: ProductSummary;

  const call = <T>(token: string | null, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    ctx.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: token ? authHeader(token) : {},
        payload: payload === undefined ? undefined : (payload as Record<string, unknown>),
      })
      .then((r) => ({ status: r.statusCode, body: r.json<T>() }));

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    expect(
      (
        await call<PricingRuleSummary>(owner.token, 'POST', '/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 150,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);
    station = (
      await call<StationSummary>(owner.token, 'POST', '/stations', { number: 1, name: 'PC 1' })
    ).body;
    cola = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Cola',
        sellingPriceCents: 200,
        trackStock: false,
      })
    ).body;

    // The PC registers and is approved, the same way as in the PC tests.
    const registrationSecret = randomBytes(32).toString('base64url');
    const reg = await call<RegisterDeviceResponse>(null, 'POST', '/client/register', {
      machineId: 'MACHINE-STAFF-ADD-0001',
      hostname: 'pc1',
      osInfo: 'Windows 11',
      appVersion: SERVER_VERSION,
      registrationSecret,
    });
    await call(owner.token, 'POST', `/devices/${reg.body.registrationId}/approve`, {
      stationId: station.id,
    });
    const poll = await call<RegistrationPollResponse>(
      null,
      'GET',
      `/client/registration/${reg.body.registrationId}?secret=${registrationSecret}`,
    );
    deviceToken = poll.body.deviceToken!;
    expect(deviceToken).toBeTruthy();
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('a product the desk adds shows in the PC order list of the running session', async () => {
    const started = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
      stationId: station.id,
      billingMode: 'endpay',
      minutes: 60,
    });
    expect(started.status).toBe(201);

    const added = await call<StationOrder>(
      owner.token,
      'POST',
      `/sessions/${started.body.session.id}/orders`,
      {
        items: [{ productId: cola.id, quantity: 1 }],
      },
    );
    expect(added.status).toBe(201);

    const mine = await call<{ items: StationOrder[] }>(deviceToken, 'GET', '/client/orders');
    expect(mine.status).toBe(200);
    const shown = mine.body.items.find((o) => o.id === added.body.id);
    expect(shown).toBeTruthy();
    expect(shown).toMatchObject({ status: 'accepted', totalCents: 200 });
  });
});
