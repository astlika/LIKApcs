import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// Development: the Vite dev server proxies API + WebSocket traffic to a LIKApcs Server so the
// browser build can be exercised without Tauri. Packaged builds talk to the discovered server URL.
const serverTarget = process.env.LIKAPCS_SERVER_URL ?? 'http://127.0.0.1:4700';

export default defineConfig({
  plugins: [react()],
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version) },
  clearScreen: false,
  server: {
    host: '0.0.0.0',
    port: 1421,
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
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        // Black cover page for secondary monitors while the PC is locked (opened by src-tauri).
        cover: fileURLToPath(new URL('./cover.html', import.meta.url)),
      },
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
});
