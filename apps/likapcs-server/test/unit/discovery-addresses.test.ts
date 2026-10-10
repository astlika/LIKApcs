import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { rankLanAddresses } from '../../src/discovery.js';

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  };
}

describe('rankLanAddresses()', () => {
  it('puts the physical private adapter first and virtual switches / link-local last', () => {
    const ranked = rankLanAddresses({
      'vEthernet (Default Switch)': [v4('172.20.144.1')],
      'VirtualBox Host-Only Network': [v4('192.168.56.1')],
      Ethernet: [v4('192.168.1.10')],
      'Wi-Fi': [v4('169.254.12.7')],
      'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
    });
    expect(ranked[0]).toBe('192.168.1.10');
    expect(ranked).not.toContain('127.0.0.1');
    expect(ranked.indexOf('172.20.144.1')).toBeGreaterThan(ranked.indexOf('192.168.1.10'));
    expect(ranked.indexOf('192.168.56.1')).toBeGreaterThan(ranked.indexOf('192.168.1.10'));
    expect(ranked.at(-1)).toBe('169.254.12.7');
  });

  it('ignores IPv6 and de-duplicates', () => {
    const ranked = rankLanAddresses({
      Ethernet: [
        v4('10.0.0.5'),
        { ...v4('10.0.0.5'), family: 'IPv6', address: 'fe80::1', cidr: 'fe80::1/64' },
      ],
      'Ethernet 2': [v4('10.0.0.5')],
    });
    expect(ranked).toEqual(['10.0.0.5']);
  });
});
