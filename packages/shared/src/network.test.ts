import { describe, expect, it } from 'vitest';
import { buildServerEndpoints, normalizeRemoteAddress, serverBaseUrl } from './network.js';

describe('normalizeRemoteAddress', () => {
  it('accepts IPv4, IPv6 and host names', () => {
    expect(normalizeRemoteAddress('100.101.102.103')).toBe('100.101.102.103');
    expect(normalizeRemoteAddress('  PC-Dyqani.tailnet-1a2b.ts.net ')).toBe(
      'pc-dyqani.tailnet-1a2b.ts.net',
    );
    expect(normalizeRemoteAddress('pc-dyqani')).toBe('pc-dyqani');
    expect(normalizeRemoteAddress('FD7A:115C:A1E0::1')).toBe('fd7a:115c:a1e0::1');
    expect(normalizeRemoteAddress('::ffff:192.168.1.1')).toBe('::ffff:192.168.1.1');
    expect(normalizeRemoteAddress('[fd7a:115c:a1e0::1]')).toBe('fd7a:115c:a1e0::1');
  });

  it('rejects URLs, ports, paths and malformed values', () => {
    expect(normalizeRemoteAddress('http://100.101.102.103:4700')).toBeNull();
    expect(normalizeRemoteAddress('100.101.102.103:4700')).toBeNull();
    expect(normalizeRemoteAddress('pc/dyqani')).toBeNull();
    expect(normalizeRemoteAddress('300.1.1.1')).toBeNull();
    expect(normalizeRemoteAddress('-bad.host')).toBeNull();
    expect(normalizeRemoteAddress('')).toBeNull();
    expect(normalizeRemoteAddress('fd7a:::zz')).toBeNull();
    expect(normalizeRemoteAddress('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(normalizeRemoteAddress('::ffff:999.1.1.1')).toBeNull();
  });
});

describe('serverBaseUrl and buildServerEndpoints', () => {
  it('wraps IPv6 literals in brackets', () => {
    expect(serverBaseUrl('fd7a::1', 4700)).toBe('http://[fd7a::1]:4700');
    expect(serverBaseUrl('192.168.1.109', 27015, 'https')).toBe('https://192.168.1.109:27015');
  });

  it('lists LAN addresses first, skips duplicates and adds phone URLs', () => {
    const endpoints = buildServerEndpoints({
      lanAddresses: ['192.168.1.109'],
      remoteAddresses: ['100.101.102.103', '192.168.1.109', 'fd7a::1'],
      port: 4700,
    });
    expect(endpoints.map((e) => [e.source, e.address])).toEqual([
      ['lan', '192.168.1.109'],
      ['manual', '100.101.102.103'],
      ['manual', 'fd7a::1'],
    ]);
    expect(endpoints[0]).toEqual({
      address: '192.168.1.109',
      source: 'lan',
      api: 'http://192.168.1.109:4700',
      phone: 'http://192.168.1.109:4700/phone/',
    });
    expect(endpoints[2]?.phone).toBe('http://[fd7a::1]:4700/phone/');
  });
});
