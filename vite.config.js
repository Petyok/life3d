import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  plugins: [wasm()],
  resolve: {
    alias: [
      {
        find: /^@dimforge\/rapier3d-compat$/,
        replacement: fileURLToPath(new URL('./src/sim/rapier-web.js', import.meta.url)),
      },
    ],
  },
  // local dev: run server/stats.py for the world stats card
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  preview: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  optimizeDeps: { exclude: ['@dimforge/rapier3d'] },
  build: {
    target: 'es2022', // top-level await in main.js and the wasm loader
    assetsInlineLimit: 0, // keep the .wasm a separate file
    chunkSizeWarningLimit: 1024, // three.js + rapier glue
  },
});
