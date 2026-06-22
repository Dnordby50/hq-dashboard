import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

// The estimator builds into repo-root /estimator so the existing static Netlify
// publish ('.') serves it at /estimator/. `base` must match that path.
//
// server.fs.allow includes the repo root so dev can import the CANONICAL
// production/calculator.js (one source of truth for the estimate math) from
// outside this app folder; the build (Rollup) bundles it regardless.
//
// VitePWA generates a service worker scoped to /estimator/ (from base), so it
// never intercepts the root dashboard. It precaches the app shell (so the
// estimator opens with no signal) and SPA-falls-back to the app's index.html.
export default defineConfig({
  base: '/estimator/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['pwa-icon.svg'],
      manifest: {
        name: 'PEC Estimator',
        short_name: 'Estimator',
        description: 'PEC on-site estimator',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        scope: '/estimator/',
        start_url: '/estimator/',
        icons: [
          { src: 'pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/estimator/index.html',
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
      },
    }),
  ],
  build: {
    outDir: fileURLToPath(new URL('../../estimator', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] },
  },
});
