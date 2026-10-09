import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: false,
  // Bundle the workspace package so the deployable server is self-contained.
  noExternal: ['@likapcs/shared'],
  banner: { js: '#!/usr/bin/env node' },
});
