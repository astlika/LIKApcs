import { describe, expect, it } from 'vitest';
import { bigNumber, compactDuration, effectiveWidgetStyle } from './widget';
import { t } from './i18n';

const tr = (k: Parameters<typeof t>[1], vars?: Record<string, string | number>) => t('en', k, vars);

describe('widget designs on the PC (0.13.0)', () => {
  const quiet = { notice: false, maintenance: false, flash: false };

  it('keeps the chosen design while nothing textual is on', () => {
    for (const id of ['minimal', 'ring', 'dot', 'pill', 'ticket', 'neon'])
      expect(effectiveWidgetStyle(id, quiet)).toBe(id);
  });

  it('hands a wordless design over to the classic card for a notice, maintenance or a flash', () => {
    expect(effectiveWidgetStyle('ring', { ...quiet, notice: true })).toBe('detailed');
    expect(effectiveWidgetStyle('dot', { ...quiet, maintenance: true })).toBe('detailed');
    expect(effectiveWidgetStyle('minutes', { ...quiet, flash: true })).toBe('detailed');
  });

  it('lets one-line designs carry the order flash but not a staff notice', () => {
    expect(effectiveWidgetStyle('pill', { ...quiet, flash: true })).toBe('pill');
    expect(effectiveWidgetStyle('minimal', { ...quiet, flash: true })).toBe('minimal');
    expect(effectiveWidgetStyle('pill', { ...quiet, notice: true })).toBe('detailed');
  });

  it('card designs (classic, glass, neon) show everything inline', () => {
    expect(effectiveWidgetStyle('glass', { notice: true, maintenance: true, flash: true })).toBe(
      'glass',
    );
    expect(effectiveWidgetStyle('neon', { ...quiet, notice: true })).toBe('neon');
  });

  it('falls back to the classic card for an unknown id (newer Admin than this client)', () => {
    expect(effectiveWidgetStyle('hologram', quiet)).toBe('detailed');
    expect(effectiveWidgetStyle(undefined, quiet)).toBe('detailed');
  });

  it('formats compact durations and the ring / dot number', () => {
    expect(compactDuration(45, tr)).toBe('45 s');
    expect(compactDuration(23 * 60 + 59, tr)).toBe('23 min');
    expect(compactDuration(3600 + 5 * 60, tr)).toBe('1h 05min');
    expect(bigNumber(0)).toEqual({ value: 0, unit: 'secShort' });
    expect(bigNumber(59)).toEqual({ value: 59, unit: 'secShort' });
    expect(bigNumber(60)).toEqual({ value: 1, unit: 'minShort' });
    expect(bigNumber(23 * 60 + 41)).toEqual({ value: 23, unit: 'minShort' });
    expect(bigNumber(-5)).toEqual({ value: 0, unit: 'secShort' });
  });
});
