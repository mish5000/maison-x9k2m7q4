import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The dev server proxies `/api` to the Auralis API process so that the browser
 * only ever talks to one origin. That keeps `credentials: 'same-origin'` and the
 * CSRF header check meaningful in development as well as production.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5175',
        changeOrigin: false,
        // Server-sent events must not be buffered by the proxy.
        ws: false,
      },
    },
  },
  preview: {
    port: 5174,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
    assetsInlineLimit: 2048,
  },
  esbuild: {
    legalComments: 'none',
  },
});
