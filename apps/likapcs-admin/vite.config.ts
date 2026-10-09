import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// In development the Vite server proxies API and WebSocket traffic to the LIKApcs Server,
// so the UI can use relative URLs. In the packaged Tauri app the server URL is configurable.
const serverTarget = process.env.LIKAPCS_SERVER_URL ?? 'http://127.0.0.1:4700';

export default defineConfig({
  plugins: [react()],
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version) },
  clearScreen: false,
  server: {
    host: '0.0.0.0',
    port: 1420,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: serverTarget, changeOrigin: true },
      '/ws': { target: serverTarget.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
    },
  },
  build: {
    target: ['es2022', 'chrome110', 'edge110'],
    sourcemap: false,
    outDir: 'dist',
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
});
