import { describe, expect, it } from 'vitest';
import { inMaintenanceWindow, shouldPushUpdate } from '../../src/services/commands.js';

const at = (h: number, m: number) => new Date(2026, 0, 1, h, m);

describe('client update policy', () => {
  it('maintenance windows work within a day and across midnight', () => {
    expect(inMaintenanceWindow('03:00-06:00', at(4, 30))).toBe(true);
    expect(inMaintenanceWindow('03:00-06:00', at(6, 0))).toBe(false);
    expect(inMaintenanceWindow('03:00-06:00', at(2, 59))).toBe(false);
    expect(inMaintenanceWindow('23:00-02:00', at(23, 30))).toBe(true);
    expect(inMaintenanceWindow('23:00-02:00', at(1, 59))).toBe(true);
    expect(inMaintenanceWindow('23:00-02:00', at(12, 0))).toBe(false);
    expect(inMaintenanceWindow('garbage', at(12, 0))).toBe(false);
  });

  it('never pushes to clients that are current or newer', () => {
    const base = {
      policy: 'idle_only' as const,
      maintenanceWindow: '03:00-06:00',
      hasActiveSession: false,
    };
    expect(shouldPushUpdate({ ...base, clientVersion: '0.2.0', serverVersion: '0.2.0' })).toBe(
      false,
    );
    expect(shouldPushUpdate({ ...base, clientVersion: '0.3.0', serverVersion: '0.2.0' })).toBe(
      false,
    );
    expect(shouldPushUpdate({ ...base, clientVersion: '0.1.9', serverVersion: '0.2.0' })).toBe(
      true,
    );
  });

  it('respects manual / idle-only / maintenance-window policies', () => {
    const base = {
      clientVersion: '0.1.0',
      serverVersion: '0.2.0',
      maintenanceWindow: '03:00-06:00',
    };
    expect(shouldPushUpdate({ ...base, policy: 'manual', hasActiveSession: false })).toBe(false);
    expect(shouldPushUpdate({ ...base, policy: 'idle_only', hasActiveSession: false })).toBe(true);
    expect(shouldPushUpdate({ ...base, policy: 'idle_only', hasActiveSession: true })).toBe(false);
    expect(
      shouldPushUpdate({
        ...base,
        policy: 'maintenance_window',
        hasActiveSession: false,
        now: at(4, 0),
      }),
    ).toBe(true);
    expect(
      shouldPushUpdate({
        ...base,
        policy: 'maintenance_window',
        hasActiveSession: false,
        now: at(14, 0),
      }),
    ).toBe(false);
    expect(
      shouldPushUpdate({
        ...base,
        policy: 'maintenance_window',
        hasActiveSession: true,
        now: at(4, 0),
      }),
    ).toBe(false);
  });
});
