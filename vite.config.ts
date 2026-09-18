import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { execSync } from 'node:child_process';

/**
 * Commit + build time, stamped into the bundle and shown on Rig Check.
 *
 * WHY: "still broken" and "still broken on the old build" look identical from
 * the outside, and we burned a round trip on exactly that. A visible stamp
 * makes the question answerable in one glance instead of one message.
 */
function buildStamp(): string {
  let sha = 'nogit';
  try {
    sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    /* a tarball checkout or a build box without git — the date still helps */
  }
  return `${sha} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
}

export default defineConfig({
  base: './',
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp()),
  },
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
