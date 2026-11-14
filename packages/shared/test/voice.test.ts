import { describe, expect, it } from 'vitest';
import {
  SETTING_DEFAULTS,
  builtInVoiceFile,
  clientDisplayFromSettings,
  hasBuiltInVoice,
  isVoiceSlot,
  validateSettingsPatch,
  voicePlan,
  voiceSlotOfMinutes,
  voiceSlots,
  type ClientVoiceConfig,
  type SettingsMap,
} from '../src/index.js';

const config = (patch: Partial<ClientVoiceConfig> = {}): ClientVoiceConfig => ({
  enabled: true,
  language: 'sq',
  volume: 100,
  chime: true,
  custom: {},
  ...patch,
});

describe('voice slots', () => {
  it('a slot is `up` or the minutes left, 1 to 120', () => {
    for (const slot of ['up', '1', '5', '15', '120']) expect(isVoiceSlot(slot), slot).toBe(true);
    for (const slot of ['0', '121', '999', '05', '5.5', '-1', 'UP', '', 'five', '5 '])
      expect(isVoiceSlot(slot), slot).toBe(false);
    expect(voiceSlotOfMinutes(5)).toBe('5');
    expect(voiceSlotOfMinutes(1)).toBe('1');
    expect(voiceSlotOfMinutes(0)).toBeNull();
    expect(voiceSlotOfMinutes(121)).toBeNull();
    expect(voiceSlotOfMinutes(Number.NaN)).toBeNull();
  });

  it('lists the announcements the owner sets up: most minutes first, then the end', () => {
    expect(voiceSlots([5, 1])).toEqual(['5', '1', 'up']);
    expect(voiceSlots([1, 15, 5, 5, 10])).toEqual(['15', '10', '5', '1', 'up']);
    expect(voiceSlots([])).toEqual(['up']);
  });

  it('knows which minutes the built-in voices can say', () => {
    for (const slot of ['15', '10', '5', '1', 'up']) expect(hasBuiltInVoice(slot), slot).toBe(true);
    for (const slot of ['2', '3', '20', '30', '60'])
      expect(hasBuiltInVoice(slot), slot).toBe(false);
    expect(builtInVoiceFile('sq', '5')).toBe('sq-5.mp3');
    expect(builtInVoiceFile('en', 'up')).toBe('en-up.mp3');
    expect(builtInVoiceFile('sq', '3')).toBeNull();
    expect(builtInVoiceFile('sq', 'nonsense')).toBeNull();
  });
});

describe('voicePlan', () => {
  it('the built-in voice in the chosen language, after the chime', () => {
    expect(voicePlan(config(), '5')).toEqual({
      chime: true,
      volume: 1,
      sources: [{ kind: 'builtin', file: 'sq-5.mp3' }],
    });
    expect(voicePlan(config({ language: 'en', chime: false, volume: 35 }), 'up')).toEqual({
      chime: false,
      volume: 0.35,
      sources: [{ kind: 'builtin', file: 'en-up.mp3' }],
    });
  });

  it("the owner's recording first, the built-in voice behind it", () => {
    const plan = voicePlan(config({ custom: { '5': 'http://s/own.mp3' } }), '5');
    expect(plan?.sources).toEqual([
      { kind: 'custom', url: 'http://s/own.mp3' },
      { kind: 'builtin', file: 'sq-5.mp3' },
    ]);
    // A minute the built-in voices cannot say: the own recording alone.
    expect(voicePlan(config({ custom: { '3': 'http://s/tri.mp3' } }), '3')?.sources).toEqual([
      { kind: 'custom', url: 'http://s/tri.mp3' },
    ]);
  });

  it('only the chime where there is no voice; nothing without the chime either', () => {
    expect(voicePlan(config(), '3')).toEqual({ chime: true, volume: 1, sources: [] });
    expect(voicePlan(config({ chime: false }), '3')).toBeNull();
  });

  it('nothing when off, silent, not configured, or the slot is not one', () => {
    expect(voicePlan(config({ enabled: false }), '5')).toBeNull();
    expect(voicePlan(config({ volume: 0 }), '5')).toBeNull();
    expect(voicePlan(undefined, '5')).toBeNull();
    expect(voicePlan(null, '5')).toBeNull();
    expect(voicePlan(config(), '0')).toBeNull();
    expect(voicePlan(config(), 'x')).toBeNull();
    // A broken volume or language from an odd server never breaks the PC.
    expect(voicePlan(config({ volume: 500 }), '5')?.volume).toBe(1);
    expect(
      voicePlan(config({ language: 'de' as unknown as ClientVoiceConfig['language'] }), '5')
        ?.sources,
    ).toEqual([{ kind: 'builtin', file: 'sq-5.mp3' }]);
  });
});

describe('voice settings', () => {
  it('are on by default, in Albanian, and reach the PC with the recordings as addresses', () => {
    const display = clientDisplayFromSettings(SETTING_DEFAULTS);
    expect(display.voice).toEqual({
      enabled: true,
      language: 'sq',
      volume: 100,
      chime: true,
      custom: {},
    });
    const settings: SettingsMap = {
      ...SETTING_DEFAULTS,
      'client.voice_language': 'en',
      'client.voice_volume': 70,
      'client.voice_custom': {
        '5': { file: '0123456789abcdef01234567.mp3', name: 'pesë.mp3' },
        up: { file: 'aaaaaaaaaaaaaaaaaaaaaaaa.wav', name: 'fund.wav' },
      },
    };
    expect(clientDisplayFromSettings(settings).voice).toEqual({
      enabled: true,
      language: 'en',
      volume: 70,
      chime: true,
      custom: {
        '5': '/api/v1/files/voice/0123456789abcdef01234567.mp3',
        up: '/api/v1/files/voice/aaaaaaaaaaaaaaaaaaaaaaaa.wav',
      },
    });
  });

  it('shows the countdown during games unless the owner hides it', () => {
    expect(SETTING_DEFAULTS['client.widget_hide_in_games']).toBe(false);
  });

  it('refuses a volume, a language or a file name that cannot be', () => {
    expect(() => validateSettingsPatch({ 'client.voice_volume': 101 })).toThrow();
    expect(() => validateSettingsPatch({ 'client.voice_volume': 12.5 })).toThrow();
    expect(() => validateSettingsPatch({ 'client.voice_language': 'de' })).toThrow();
    expect(() =>
      validateSettingsPatch({ 'client.voice_custom': { '5': { file: '../x.mp3', name: 'x' } } }),
    ).toThrow();
    expect(() =>
      validateSettingsPatch({
        'client.voice_custom': { soon: { file: '0123456789abcdef01234567.mp3', name: 'x' } },
      }),
    ).toThrow();
    expect(
      validateSettingsPatch({
        'client.voice_custom': { '5': { file: '0123456789abcdef01234567.mp3', name: 'x' } },
      }),
    ).toBeTruthy();
  });
});
