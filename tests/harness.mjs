/**
 * Makes the APP importable from `node --test`.
 *
 * WHY THIS EXISTS. Every test in this repo until now tested a PURE module —
 * geometry, poses, beatmap, the tracker, the gesture detectors. That is not
 * because the rest of the app was deemed not worth testing; it is because the
 * rest of the app was literally unimportable, for two reasons that have
 * nothing to do with the code being correct:
 *
 *   1. Source files import each other WITHOUT a file extension
 *      (`from '../core/tracker'`). Vite resolves that. Node's ESM loader does
 *      not, and throws ERR_MODULE_NOT_FOUND before a single test body runs.
 *   2. A handful of modules touch `window` at import time — `audio.ts` builds
 *      its singleton on the last line of the file.
 *
 * So the most-shared code in the project — `games/base.ts`, the round state
 * machine every one of the seven games inherits — had zero test coverage, and
 * the two-player path inside it had zero coverage of any kind. That is exactly
 * backwards: shared code deserves the most tests, not the fewest.
 *
 * This file fixes both problems from OUTSIDE the source tree, so nothing about
 * the app changes to suit its tests:
 *
 *   - A resolve hook appends `.ts` (or `/index.ts`) to extensionless relative
 *     specifiers, which is precisely what Vite does.
 *   - A minimal `window`/`document` stand-in satisfies module-scope reads.
 *     It is deliberately NOT a DOM emulator: anything that actually needs a
 *     real canvas should be driven through `src/dev/turn.ts` in a browser,
 *     where a real canvas exists. This only has to get modules LOADED.
 *
 * Wired in via `--import ./tests/harness.mjs` in the `test` script, so every
 * test file gets it without importing anything.
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./harness-resolve.mjs', pathToFileURL('./tests/'));

/* ---------------- browser stand-ins ---------------- */

/**
 * No-op AudioContext. `audio.ts` constructs its engine at module scope but
 * only reaches for a real context inside `unlock()`, which a test never calls.
 * Defining the constructor anyway means an accidental call fails as a silent
 * no-op rather than as a crash in an unrelated test.
 */
class StubAudioContext {
  state = 'suspended';
  currentTime = 0;
  destination = {};
  createGain() {
    return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} };
  }
  createOscillator() {
    return { type: 'sine', frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, start() {}, stop() {}, disconnect() {} };
  }
  createBuffer() {
    return { getChannelData: () => new Float32Array(0) };
  }
  createBufferSource() {
    return { buffer: null, connect() {}, start() {}, stop() {}, disconnect() {} };
  }
  createBiquadFilter() {
    return { type: 'lowpass', frequency: { value: 0, setValueAtTime() {} }, Q: { value: 0 }, connect() {}, disconnect() {} };
  }
  createDynamicsCompressor() {
    return { threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, connect() {}, disconnect() {} };
  }
  resume() {
    return Promise.resolve();
  }
}

if (typeof globalThis.window === 'undefined') {
  const timers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 16),
    cancelAnimationFrame: (h) => clearTimeout(h),
  };
  globalThis.window = {
    ...timers,
    devicePixelRatio: 1,
    innerWidth: 1920,
    innerHeight: 1080,
    AudioContext: StubAudioContext,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    localStorage: {
      _m: new Map(),
      getItem(k) {
        return this._m.has(k) ? this._m.get(k) : null;
      },
      setItem(k, v) {
        this._m.set(k, String(v));
      },
      removeItem(k) {
        this._m.delete(k);
      },
      clear() {
        this._m.clear();
      },
    },
    location: { search: '', href: 'http://localhost/' },
    navigator: { userAgent: 'node', mediaDevices: { getUserMedia: () => Promise.reject(new Error('no camera in tests')) } },
  };
  globalThis.window.window = globalThis.window;
}

if (typeof globalThis.localStorage === 'undefined') globalThis.localStorage = globalThis.window.localStorage;
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = globalThis.window.navigator;
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame;
}

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      style: {},
      getContext: () => null,
      appendChild() {},
      addEventListener() {},
      setAttribute() {},
      remove() {},
      classList: { add() {}, remove() {}, toggle() {} },
    }),
    body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} }, style: {} },
    documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} } },
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    getElementById: () => null,
    fonts: { ready: Promise.resolve(), load: () => Promise.resolve([]) },
    hidden: false,
    visibilityState: 'visible',
  };
}
