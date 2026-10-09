/**
 * Minimal, dependency-free Semantic Versioning helpers used for compatibility checks
 * between Admin, Client, Server and the database schema.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const SEMVER_REGEX = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemVer(input: string): SemVer | null {
  const m = SEMVER_REGEX.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

/** Returns -1, 0 or 1. Pre-release versions sort before their release (1.0.0-beta.1 < 1.0.0). */
export function compareSemVer(a: string, b: string): number {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);
  if (!pa || !pb) throw new TypeError(`Invalid semantic version: "${!pa ? a : b}"`);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return pa.prerelease < pb.prerelease ? -1 : pa.prerelease > pb.prerelease ? 1 : 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareSemVer(candidate, current) > 0;
}

/**
 * Compatibility policy: components must share the same MAJOR version, and a client/admin may
 * not be NEWER (minor) than the server it talks to — the server is upgraded first.
 */
export function isCompatibleWithServer(componentVersion: string, serverVersion: string): boolean {
  const c = parseSemVer(componentVersion);
  const s = parseSemVer(serverVersion);
  if (!c || !s) return false;
  if (c.major !== s.major) return false;
  if (c.minor > s.minor) return false;
  return true;
}
