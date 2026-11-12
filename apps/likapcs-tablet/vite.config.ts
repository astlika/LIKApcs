import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';

const here = path.dirname(fileURLToPath(import.meta.url));
// The tablet reuses the phone app's screens, API and helpers (apps/likapcs-phone/src).
const phoneSrc = path.resolve(here, '../likapcs-phone/src');

// In development the tablet talks to the LIKApcs Server through this proxy (relative URLs only).
const serverTarget = process.env.LIKAPCS_SERVER_URL ?? 'http://127.0.0.1:4700';

// The production build is served by the LIKApcs Server at /tab/ (same origin as the API).
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/tab/' : '/',
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: [{ find: '@phone', replacement: phoneSrc }],
    dedupe: ['react', 'react-dom', '@tanstack/react-query'],
  },
  server: {
    host: '0.0.0.0',
    port: 1431,
    strictPort: true,
    allowedHosts: true,
    fs: { allow: [searchForWorkspaceRoot(here)] },
    proxy: {
      '/api': { target: serverTarget, changeOrigin: true },
    },
  },
  build: { target: 'es2022', sourcemap: false, outDir: 'dist', chunkSizeWarningLimit: 600 },
}));
