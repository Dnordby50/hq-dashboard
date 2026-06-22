import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The estimator builds into repo-root /estimator so the existing static Netlify
// publish ('.') serves it at /estimator/. `base` must match that path.
//
// server.fs.allow includes the repo root so dev can import the CANONICAL
// production/calculator.js (one source of truth for the estimate math) from
// outside this app folder; the build (Rollup) bundles it regardless.
export default defineConfig({
  base: '/estimator/',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../../estimator', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] },
  },
});
