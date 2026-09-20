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
  // Vercel FIRST. `.vercelignore` excludes `.git` from the upload, so the build
  // box has no repository to ask and `git rev-parse` fails there — the first
  // deploy of this stamped itself "nogit", which is exactly the ambiguity the
  // stamp exists to remove. Vercel hands us the commit as an env var instead.
  const fromCi = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA;
  let sha = fromCi ? fromCi.slice(0, 7) : '';

  if (!sha) {
    try {
      sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    } catch {
      sha = 'nogit';
    }
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
    watch: {
      // DO NOT WATCH THE PROBE BUILD, OR IT KILLS THE DEV SERVER.
      //
      // `npm run build:probe` writes `dist-probe/` inside the project root,
      // and that includes the ~55MB pose model. Vite's watcher tries to open
      // it while the copy is still in flight, Windows returns EBUSY, chokidar
      // re-emits it as an unhandled error, and the DEV SERVER EXITS — code 1,
      // mid-session, for a build that has nothing to do with it.
      //
      // Seen for real on the 20th: the dev server died the moment the first
      // probe build ran and stayed dead, which then looked like the app
      // failing to load rather than a watcher fault.
      //
      // `dist` needs no entry because it is the configured `build.outDir` and
      // Vite already ignores that; `dist-probe` only becomes an outDir when
      // `--outDir` is passed, so the dev server has never heard of it.
      ignored: ['**/dist-probe/**'],
    },
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
