import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    // Everything must be servable from disk with no network. Keep assets inlined
    // below 4kb and otherwise emitted locally.
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          mediapipe: ['@mediapipe/tasks-vision'],
        },
      },
    },
  },
  // MediaPipe ships .wasm + .task files we copy into /public/models and
  // /public/wasm. Never resolve them from a CDN at runtime.
  optimizeDeps: {
    exclude: [],
  },
});
