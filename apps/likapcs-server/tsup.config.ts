import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  // ESM output still needs __dirname/__filename for a few bundled CommonJS libraries (pino workers).
  shims: true,
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: false,
  // Fully self-contained output: the workspace package AND all npm dependencies are bundled, so the
  // deployable server is `dist/*.js` + Node — no node_modules on the target machine.
  noExternal: [/.*/],
  // pg's optional native binding and pino's optional pretty transport stay dynamic (never bundled).
  external: ['pg-native', 'pino-pretty'],
  define: { __LIKAPCS_VERSION__: JSON.stringify(pkg.version) },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
});
