import { defineConfig } from 'vite';

// base './' — the same bundle runs from GitHub Pages sub-path, Capacitor's
// WebView (https://localhost) and Electron's file:// protocol.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: 'es' },
  server: { host: true },
});
