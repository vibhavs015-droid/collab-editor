import { defineConfig } from 'vitest/config';

/**
 * Vite config.
 *
 * Two servers in development:
 *  - Vite on 5173 serves the client with hot module replacement
 *  - The Node API server on 3001 serves persistence
 *
 * The proxy forwards `/api` to the backend, so the browser sees one origin and
 * CORS never enters the picture during development. In production both are
 * served from one process, so the proxy disappears entirely.
 */
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    target: 'es2022',
    // Off by default; opt in with SOURCE_MAPS=true.
    //
    // `true` emits a 1.6 MB `.js.map` next to a 300 kB bundle AND writes a
    // `//# sourceMappingURL=` comment into the bundle, so every visitor's browser fetches
    // five times the payload it needs to run the app. A real cost, paid by every user, for a
    // debugging aid most deployments never use.
    //
    // `hidden` would generate the map without the reference comment, which avoids the fetch
    // but still ships the file. The image is built once and served many times, so not
    // generating it is the better default - and keeping the switch means debugging a
    // production-only failure is still one environment variable away.
    sourcemap: process.env['SOURCE_MAPS'] === 'true',
  },
});
