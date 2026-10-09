import { createRequire } from 'node:module';

/** Injected by tsup at build time (see tsup.config.ts); undefined when running from source. */
declare const __LIKAPCS_VERSION__: string | undefined;

function readVersion(): string {
  if (typeof __LIKAPCS_VERSION__ === 'string' && __LIKAPCS_VERSION__) return __LIKAPCS_VERSION__;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

export const SERVER_VERSION = readVersion();
