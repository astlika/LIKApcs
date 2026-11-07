import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoginResponse, ServerInfoResponse } from '@likapcs/shared';
import { authHeader, createTestContext, runSetup, type TestContext } from '../helpers.js';

describe('server info (Backups › Server and network)', () => {
  let ctx: TestContext;
  let owner: LoginResponse;

  beforeAll(async () => {
    ctx = await createTestContext();
    owner = await runSetup(ctx.app, 'Neon Arena');
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('requires a signed-in user', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/system/server-info' });
    expect(res.statusCode).toBe(401);
  });

  it('lists the bind address, the port and the phone URL for each address', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/system/server-info',
      headers: authHeader(owner.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ServerInfoResponse>();
    expect(body.scheme).toBe('http');
    expect(body.bind.port).toBe(ctx.app.config.port);
    expect(body.discovery.port).toBe(ctx.app.config.discovery.port);
    expect(body.remoteAddresses).toEqual([]);
    for (const endpoint of body.endpoints) {
      expect(endpoint.api).toBe(`http://${endpoint.address}:${body.bind.port}`);
      expect(endpoint.phone).toBe(`${endpoint.api}/phone/`);
    }
  });

  it('rejects anything that is not a plain address', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/system/server-info/remote-addresses',
      headers: authHeader(owner.token),
      payload: { addresses: ['http://100.101.102.103:4700'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { details: { invalid: string[] } } }>().error.details.invalid).toEqual([
      'http://100.101.102.103:4700',
    ]);
  });

  it('saves normalized, unique addresses and shows them with bracketed IPv6 URLs', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/system/server-info/remote-addresses',
      headers: authHeader(owner.token),
      payload: {
        addresses: ['100.101.102.103', 'FD7A::1', 'pc-dyqani.tailnet-1a2b.ts.net', '100.101.102.103'],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ServerInfoResponse>();
    expect(body.remoteAddresses).toEqual([
      '100.101.102.103',
      'fd7a::1',
      'pc-dyqani.tailnet-1a2b.ts.net',
    ]);
    const v6 = body.endpoints.find((e) => e.address === 'fd7a::1');
    expect(v6).toMatchObject({
      source: 'manual',
      api: `http://[fd7a::1]:${body.bind.port}`,
      phone: `http://[fd7a::1]:${body.bind.port}/phone/`,
    });

    const again = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/system/server-info',
      headers: authHeader(owner.token),
    });
    expect(again.json<ServerInfoResponse>().remoteAddresses).toEqual(body.remoteAddresses);
  });
});
