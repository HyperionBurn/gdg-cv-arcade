/**
 * Extensionless relative imports, resolved the way Vite resolves them.
 *
 * Runs on the module-loader thread, registered by `harness.mjs`. Node's ESM
 * resolver is strict by spec — `./foo` must be a real file called `foo` — while
 * every bundler in the world tries `./foo.ts`, `./foo.tsx`, `./foo/index.ts`.
 * The app is written for the bundler; the tests have to meet it there.
 *
 * Deliberately narrow: it only fires AFTER the default resolver has already
 * failed with ERR_MODULE_NOT_FOUND, and only for relative specifiers. A bare
 * package name, or a path that genuinely does not exist, fails exactly as it
 * did before — so a real typo in an import still surfaces as a real error
 * rather than being silently swallowed.
 */

/** Tried in order, matching the project's `resolve.extensions`. */
const CANDIDATES = ['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.js'];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (!relative || err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;

    for (const ext of CANDIDATES) {
      try {
        return await nextResolve(specifier + ext, context);
      } catch {
        // Try the next extension. The original error is rethrown below if
        // none of them resolve, so the message a developer sees still names
        // the specifier they actually wrote.
      }
    }
    throw err;
  }
}
