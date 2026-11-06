import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the phone app talks to the LIKApcs Server through this proxy (relative URLs only).
const serverTarget = process.env.LIKAPCS_SERVER_URL ?? 'http://127.0.0.1:4700';

// The production build is served by the LIKApcs Server at /phone/ (same origin as the API).
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/phone/' : '/',
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '0.0.0.0',
    port: 1430,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: serverTarget, changeOrigin: true },
    },
  },
  build: { target: 'es2022', sourcemap: false, outDir: 'dist' },
}));
