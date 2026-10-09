import { describe, expect, it } from 'vitest';
import {
  compareSemVer,
  isCompatibleWithServer,
  isNewerVersion,
  parseSemVer,
} from '../src/version.js';

describe('semantic versioning', () => {
  it('parses versions with optional v prefix and prerelease', () => {
    expect(parseSemVer('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
    expect(parseSemVer('v1.0.0-beta.2')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: 'beta.2',
    });
    expect(parseSemVer('1.2')).toBeNull();
  });

  it('compares versions', () => {
    expect(compareSemVer('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemVer('1.0.1', '1.0.0')).toBe(1);
    expect(compareSemVer('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true);
    expect(isNewerVersion('1.9.9', '2.0.0')).toBe(false);
  });

  it('applies the compatibility policy', () => {
    expect(isCompatibleWithServer('1.2.0', '1.2.0')).toBe(true);
    expect(isCompatibleWithServer('1.1.5', '1.2.0')).toBe(true); // older client, fine
    expect(isCompatibleWithServer('1.3.0', '1.2.0')).toBe(false); // client newer than server
    expect(isCompatibleWithServer('2.0.0', '1.9.0')).toBe(false); // different major
  });
});
