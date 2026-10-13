import { describe, expect, it } from 'vitest';
import {
  END_TASKS_SUGGESTIONS,
  MAX_END_TASKS,
  PROTECTED_PROCESSES,
  isProtectedProcess,
  normalizeExeName,
  validateEndTasks,
} from '../src/end-tasks.js';
import { SETTING_DEFAULTS, SETTING_SCHEMAS, validateSettingsPatch } from '../src/settings.js';

describe('End Task list rules', () => {
  it('normalises what the owner typed into a bare name.exe', () => {
    expect(normalizeExeName('steam')).toBe('steam.exe');
    expect(normalizeExeName('Steam.EXE')).toBe('Steam.exe');
    expect(normalizeExeName('  cs2.exe  ')).toBe('cs2.exe');
    expect(normalizeExeName('C:\\Program Files (x86)\\Steam\\steam.exe')).toBe('steam.exe');
    expect(normalizeExeName('/usr/bin/discord')).toBe('discord.exe');
    expect(normalizeExeName('"Battle.net.exe"')).toBe('Battle.net.exe');
  });

  it('rejects anything that is not a program name', () => {
    for (const bad of ['', '   ', '.exe', '..', 'steam?.exe', 'x'.repeat(70), 'steam.exe -t']) {
      expect(normalizeExeName(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('never lets a protected process into the list — not even with a path or other case', () => {
    expect(isProtectedProcess('likapcs-client.exe')).toBe(true);
    expect(isProtectedProcess('LIKApcs-Client.EXE')).toBe(true);
    expect(isProtectedProcess('explorer.exe')).toBe(true);
    expect(isProtectedProcess('cs2.exe')).toBe(false);
    for (const name of PROTECTED_PROCESSES) expect(isProtectedProcess(name)).toBe(true);
    expect(
      validateEndTasks(['C:\\Windows\\explorer', 'steam.exe']).ok,
      'path must not hide a protected name',
    ).toBe(false);
  });

  it('reports the first problem with the entry that caused it', () => {
    expect(validateEndTasks(['steam', 'not a name?'])).toEqual({
      ok: false,
      error: 'invalid_exe',
      entry: 'not a name?',
    });
    expect(validateEndTasks(['steam', 'svchost.exe'])).toEqual({
      ok: false,
      error: 'protected',
      entry: 'svchost.exe',
    });
    const many = Array.from({ length: MAX_END_TASKS + 1 }, (_, i) => `game${i}.exe`);
    expect(validateEndTasks(many)).toEqual({
      ok: false,
      error: 'too_many',
      entry: String(MAX_END_TASKS + 1),
    });
  });

  it('cleans the list: .exe appended, duplicates dropped case-insensitively, order kept', () => {
    expect(validateEndTasks(['steam', 'STEAM.exe', 'cs2.exe', 'Discord'])).toEqual({
      ok: true,
      exes: ['steam.exe', 'cs2.exe', 'Discord.exe'],
    });
    expect(validateEndTasks([])).toEqual({ ok: true, exes: [] });
  });

  it('the shipped suggestions are all acceptable and none is protected', () => {
    const v = validateEndTasks(END_TASKS_SUGGESTIONS);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.exes).toHaveLength(END_TASKS_SUGGESTIONS.length);
    expect(END_TASKS_SUGGESTIONS.length).toBeLessThanOrEqual(MAX_END_TASKS);
    for (const name of END_TASKS_SUGGESTIONS) expect(isProtectedProcess(name)).toBe(false);
  });
});

describe('End Task settings', () => {
  it('is off and empty by default', () => {
    expect(SETTING_DEFAULTS['stations.end_tasks_exes']).toEqual([]);
    expect(SETTING_DEFAULTS['stations.end_tasks_auto']).toBe(false);
    expect(SETTING_SCHEMAS['stations.end_tasks_exes'].safeParse([]).success).toBe(true);
    expect(SETTING_SCHEMAS['stations.end_tasks_auto'].safeParse(true).success).toBe(true);
  });

  it('stores the cleaned list and refuses protected / malformed entries', () => {
    expect(
      validateSettingsPatch({ 'stations.end_tasks_exes': ['C:\\Games\\cs2', 'steam.EXE'] }),
    ).toEqual({ 'stations.end_tasks_exes': ['cs2.exe', 'steam.exe'] });
    expect(() =>
      validateSettingsPatch({ 'stations.end_tasks_exes': ['likapcs-client.exe'] }),
    ).toThrow(/can never be closed/);
    expect(() => validateSettingsPatch({ 'stations.end_tasks_exes': ['steam', ''] })).toThrow(
      /not a program name/,
    );
    expect(() => validateSettingsPatch({ 'stations.end_tasks_auto': 'yes' })).toThrow();
  });
});
