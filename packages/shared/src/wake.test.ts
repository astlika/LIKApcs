import { describe, expect, it } from 'vitest';
import { magicPacket, pickWakeAdapter, wakeReadiness } from './wake.js';

const eth = {
  name: 'Ethernet',
  description: 'Realtek PCIe GbE',
  mac: '08:BF:B8:12:34:56',
  ipv4: '192.168.1.21',
  up: true,
  wakeOnMagicPacket: true,
};
const wifi = {
  name: 'Wi-Fi',
  description: 'Intel Wi-Fi 6 AX200',
  mac: '3C:F0:11:AA:BB:CC',
  ipv4: '192.168.1.40',
  up: true,
  wakeOnMagicPacket: true,
};

describe('magicPacket', () => {
  it('is 6 × FF followed by the MAC repeated 16 times', () => {
    const p = magicPacket('08:bf:b8:12:34:56');
    expect(p.length).toBe(102);
    expect([...p.slice(0, 6)]).toEqual([255, 255, 255, 255, 255, 255]);
    for (let i = 0; i < 16; i += 1)
      expect([...p.slice(6 + i * 6, 12 + i * 6)]).toEqual([0x08, 0xbf, 0xb8, 0x12, 0x34, 0x56]);
  });
  it('rejects malformed addresses', () => {
    expect(() => magicPacket('08:bf:b8:12:34')).toThrow(/invalid MAC/);
    expect(() => magicPacket('zz:bf:b8:12:34:56:77')).toThrow(/invalid MAC/);
  });
});

describe('pickWakeAdapter', () => {
  it('prefers the adapter that carried the last connection', () => {
    const hw = { network: [wifi, eth] };
    expect(pickWakeAdapter(hw, '192.168.1.40')?.name).toBe('Wi-Fi');
    expect(pickWakeAdapter(hw, '192.168.1.21')?.name).toBe('Ethernet');
  });
  it('falls back to a wired adapter before Wi-Fi', () => {
    const hw = { network: [wifi, { ...eth, up: false, ipv4: null }] };
    expect(pickWakeAdapter(hw, '10.0.0.9')?.name).toBe('Ethernet');
    expect(pickWakeAdapter({ network: [wifi] }, null)?.name).toBe('Wi-Fi');
    expect(pickWakeAdapter({ network: [] }, null)).toBeNull();
    expect(pickWakeAdapter(null, null)).toBeNull();
  });
});

describe('wakeReadiness', () => {
  it('is ready only with a MAC, WoL on and Fast startup off', () => {
    expect(wakeReadiness({ network: [eth], fastStartup: false }, null)).toMatchObject({
      mac: '08:BF:B8:12:34:56',
      ready: true,
      issues: [],
    });
    expect(wakeReadiness({ network: [eth], fastStartup: true }, null).issues).toEqual([
      'fast_startup',
    ]);
    expect(
      wakeReadiness({ network: [{ ...eth, wakeOnMagicPacket: false }], fastStartup: true }, null)
        .issues,
    ).toEqual(['wol_off', 'fast_startup']);
    expect(wakeReadiness({ network: [{ ...eth, wakeOnMagicPacket: null }] }, null)).toMatchObject({
      ready: false,
      issues: ['wol_unknown'],
    });
    expect(wakeReadiness({}, null)).toMatchObject({ ready: false, mac: null, issues: ['no_mac'] });
  });
});
