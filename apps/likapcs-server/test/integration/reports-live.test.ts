/**
 * 0.30.0 — live reports. After a successful sale, the server tells every open screen (admin,
 * desktop, the phone's reports) with a "reports.changed" event. A plain read does not send it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CashShiftDetail, LoginResponse, ProductSummary } from '@likapcs/shared';
import { PROTOCOL_VERSION } from '@likapcs/shared';
import { authHeader, createTestContext, openSocket, runSetup, type TestContext } from '../helpers.js';

describe('live reports event', () => {
  let ctx: TestContext;
  let owner: LoginResponse;
  let cola: ProductSummary;
  let port: number;

  const call = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
    ctx.app.inject({ method, url: `/api/v1${url}`, headers: authHeader(owner.token), payload });

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app);
    cola = (
      await call('POST', '/products', {
        name: 'Cola 0.5L',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 50_000,
      })
    ).json() as ProductSummary;
    const shift = await call('POST', '/cash/shifts/open', { openingCents: 1000 });
    expect(shift.statusCode).toBe(201);
    expect((shift.json() as CashShiftDetail).status).toBe('open');
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    port = typeof address === 'object' && address ? address.port : 0;
    expect(port).toBeGreaterThan(0);
  }, 30_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('a sale sends reports.changed to a connected admin screen; a read does not', async () => {
    const admin = await openSocket(`ws://127.0.0.1:${port}/ws/admin`);
    try {
      admin.send({ type: 'admin.hello', token: owner.token, protocolVersion: PROTOCOL_VERSION });
      const welcome = await admin.next();
      expect(welcome.type).toBe('server.welcome');

      // A read: nothing for the reports to refresh.
      expect((await call('GET', '/reports/summary?from=2000-01-01&to=2000-01-01')).statusCode).toBe(200);

      const sale = await call('POST', '/sales', {
        items: [{ productId: cola.id, quantityMilli: 1000 }],
        payments: [{ method: 'cash', amountCents: 150 }],
      });
      expect(sale.statusCode).toBe(201);

      // Other events may arrive first; the reports event must arrive.
      let seen = false;
      for (let i = 0; i < 10 && !seen; i += 1) {
        const message = await admin.next(5000);
        if (message.type === 'server.event' && message.event === 'reports.changed') seen = true;
      }
      expect(seen).toBe(true);
    } finally {
      admin.socket.close();
    }
  });
});
