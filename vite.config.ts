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
    // ES, matching the module worker in src/core/vision.ts, which in turn is
    // matched by the MODULE MediaPipe WASM build requested in vision.worker.ts.
    // Changing any one of those three alone breaks model loading.
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
          // No 'mediapipe' chunk. tasks-vision is imported ONLY by the vision
          // worker, which rollup bundles separately, so naming it here produced
          // a chunk with nothing in it — the "Generated an empty chunk:
          // mediapipe" warning on every build was saying exactly that.
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
