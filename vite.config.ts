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
    sourcemap: true,
  },
});
