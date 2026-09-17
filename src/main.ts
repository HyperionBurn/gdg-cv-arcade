/**
 * App entry. Owns the canvas, the render loop, and the router.
 *
 * PLAN.md §1: "Games are modes in one app. One camera stream, one owner."
 * That means exactly one requestAnimationFrame in the whole codebase — this
 * one — and exactly one getUserMedia — camera.ts.
 */

import { camera } from './core/camera';
import { vision } from './core/vision';
import { audio } from './engine/audio';
import { simulator, isSimEnabled } from './core/simulator';
import type { VisionFrame } from './core/types';
import { resizeCanvas, viewportOf } from './engine/draw';
import type { FrameContext } from './shell/screen';
import { router } from './shell/router';
import { RigCheckScreen } from './shell/rigcheck';
import { installOperatorConsole } from './shell/operator';
import { highlights } from './meta/highlights';
import { AttractScreen } from './shell/attract';
import { MenuScreen } from './shell/menu';
import { InitialsScreen } from './shell/initials';
import { SixtySevenGame } from './games/sixtyseven';
import { FruitNinjaGame } from './games/fruitninja';
import { BalloonPopGame } from './games/balloonpop';
import { RedLightGame } from './games/redlight';
import { PoseMatchGame } from './games/posematch';
import { RunnerGame } from './games/runner';
import { RhythmGame } from './games/rhythm';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLElement;
const ctx = canvas.getContext('2d', { alpha: false })!;

const SIM = isSimEnabled();

/**
 * Sim mode starts MUTED.
 *
 * Sim mode is only ever used for development and automated verification, often
 * with several browser tabs driving rounds at once, and the resulting racket is
 * genuinely unpleasant to sit next to. Audio is reinforcement and never carries
 * gameplay information (PLAN.md §5: "every game fully legible with sound off"),
 * so muting costs nothing that a test can observe.
 *
 * Override either way with ?mute=0 / ?mute=1, or press M at any time.
 */
const MUTE_PARAM = new URLSearchParams(location.search).get('mute');
const START_MUTED = MUTE_PARAM !== null ? MUTE_PARAM !== '0' : SIM;

let latestVision: VisionFrame | null = null;
let startTime = 0;
let lastTime = 0;
/** Monotonic synthetic clock for the dev `tick()` harness. See its comment. */
let simClock = 0;

vision.subscribe((frame) => {
  latestVision = frame;
});

router.attach(overlay);
// Mounts on document.body, NOT #overlay — router.go() calls
// overlay.replaceChildren() and would delete the console mid-use.
installOperatorConsole();

// The rolling replay buffer reads from the one canvas. Measured at 0.079ms
// amortised per rendered frame, and it throttles itself off the frame-budget
// watchdog via GameBase.
highlights.attach(canvas);
router.register('rigcheck', () => new RigCheckScreen());
router.register('attract', () => new AttractScreen());
router.register('menu', () => new MenuScreen());
router.register('initials', () => new InitialsScreen());
router.register('sixtyseven', () => new SixtySevenGame());
router.register('fruitninja', () => new FruitNinjaGame());
router.register('balloonpop', () => new BalloonPopGame());
router.register('redlight', () => new RedLightGame());
router.register('posematch', () => new PoseMatchGame());
router.register('runner', () => new RunnerGame());
router.register('rhythm', () => new RhythmGame());

/**
 * One frame. Split out from the rAF callback so it can be driven with an
 * explicit clock — used by the headless smoke tests and by anything verifying
 * game logic in an environment where rAF is throttled or paused.
 */
function step(now: number, dt: number): void {
  resizeCanvas(canvas, ctx);
  const v = viewportOf(canvas);
  const time = (now - startTime) / 1000;

  // In sim mode the simulator stands in for camera + MediaPipe entirely.
  if (SIM) latestVision = simulator.step(time, dt);

  const fc: FrameContext = { time, dt, now, v, ctx, vision: latestVision };

  try {
    router.active?.render(fc);
  } catch (err) {
    // A thrown frame must never kill the loop — at a stall, a black screen
    // that stays black is unrecoverable without someone who can read a console.
    console.error('[render]', err);
  }

  // AFTER the frame is drawn — it grabs what is on the canvas.
  highlights.tick(now);
}

function loop(now: number): void {
  requestAnimationFrame(loop);
  // Clamp dt at BOTH ends.
  //
  // Upper: a backgrounded tab or a GC pause produces a huge delta, and physics
  // stepped by it teleports objects through walls.
  //
  // Lower: a negative delta flips the sign of every decay term — screen shake,
  // flash and slow-mo all grow instead of fading, and the screen washes out
  // permanently. performance.now() is monotonic so this shouldn't happen, but
  // it did the moment a test harness advanced the clock manually, and the
  // failure mode is bad enough to be worth one Math.max.
  const dt = Math.max(0, Math.min((now - lastTime) / 1000, 1 / 20));
  lastTime = now;
  step(now, dt);
}

function showBoot(
  message: string,
  detail: string,
  action?: { label: string; run: () => void }
): void {
  const el = document.createElement('div');
  el.className = 'boot';
  el.innerHTML = `<h1>${message}</h1><p>${detail}</p>`;
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      el.remove();
      action.run();
    });
    el.appendChild(btn);
  }
  overlay.appendChild(el);
}

async function boot(): Promise<void> {
  startTime = performance.now();
  lastTime = startTime;
  audio.setMuted(START_MUTED);
  requestAnimationFrame(loop);

  if (SIM) {
    // Skip camera and MediaPipe entirely. Games see synthetic poses.
    simulator.auto = true;
    await router.go(new URLSearchParams(location.search).get('screen') ?? 'sixtyseven');
    return;
  }

  // Secure-context guard. PLAN.md §9 flags this as a critical failure mode:
  // getUserMedia is blocked on plain http over a LAN IP, and the symptom is a
  // silently dead camera rather than an obvious error.
  if (!window.isSecureContext) {
    showBoot(
      'Insecure context',
      `The camera is blocked because this page is served over <code>${location.protocol}//${location.hostname}</code>.
       Use <code>localhost</code> or serve over https.`
    );
    return;
  }

  try {
    await camera.start();
  } catch {
    /* state carries the error */
  }

  if (camera.getState().status === 'error') {
    showBoot('Camera unavailable', camera.getState().error ?? 'Unknown error', {
      label: 'Retry',
      run: () => void boot(),
    });
    return;
  }

  await router.go(new URLSearchParams(location.search).get('screen') ?? 'attract');
}

/* ------------------------------------------------------------------ */
/* Operator keys                                                       */
/* ------------------------------------------------------------------ */

const SCREEN_KEYS: Record<string, string> = {
  '0': 'attract',
  '9': 'menu',
  '1': 'rigcheck',
  '2': 'sixtyseven',
  '3': 'fruitninja',
  '4': 'balloonpop',
  '5': 'redlight',
  '6': 'posematch',
  '7': 'runner',
  '8': 'rhythm',
};

window.addEventListener('keydown', (e) => {
  // Any key doubles as the user gesture Web Audio needs to start.
  audio.init();
  audio.setMuted(audio.muted);

  const target = SCREEN_KEYS[e.key];
  if (target) {
    void router.go(target);
    return;
  }

  switch (e.key.toLowerCase()) {
    case 'f':
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
      break;
    case 'c':
      document.body.classList.toggle('kiosk');
      break;
    case 'm':
      audio.setMuted(!audio.muted);
      break;
  }

  // Simulator controls — dev only, and the demo fallback if the camera dies.
  if (!SIM) return;
  switch (e.key.toLowerCase()) {
    case 'a':
      simulator.auto = !simulator.auto;
      break;
    case ' ':
      simulator.triggerJump();
      e.preventDefault();
      break;
    case 'p':
      simulator.auto = false;
      simulator.setPump(simulator.pumping ? 0 : 4);
      break;
    case 'arrowup':
      simulator.auto = false;
      simulator.setPump(Math.min(12, (simulator.players[0]?.pumpRate ?? 0) + 1));
      break;
    case 'arrowdown':
      simulator.auto = false;
      simulator.setPump(Math.max(0, (simulator.players[0]?.pumpRate ?? 0) - 1));
      break;
    case 'v':
      simulator.setPlayerCount(simulator.players.length === 1 ? 2 : 1);
      break;
  }
});

// Clicking anywhere also unlocks audio — the operator will click before they
// think to press a key.
window.addEventListener('pointerdown', () => {
  audio.init();
  audio.setMuted(audio.muted);
}, { once: false });

// The camera can be released when the OS sleeps the lid; recover on wake
// rather than leaving the stall staring at a frozen frame.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && camera.getState().status === 'error') {
    void camera.start();
  }
});

// Dev introspection. Also what the operator console will hang off later.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__arcade = {
    router,
    camera,
    vision,
    audio,
    simulator,
    get screen() {
      return router.active;
    },
    /** Automated regression sweep across every game. See src/dev/smoke.ts. */
    async smoke(only?: string[]) {
      const { runSmoke, formatSmoke } = await import('./dev/smoke');
      const host = (window as unknown as { __arcade: never }).__arcade;
      const report = await runSmoke(host as never, only);
      console.log(formatSmoke(report));
      return report;
    },

    /**
     * Advance the app by `frames` fixed steps without waiting on rAF.
     * Deterministic, and far faster than real time.
     *
     * The clock is MONOTONIC ACROSS CALLS. An earlier version re-seeded from
     * `performance.now()` on every call, which was fine for one `tick(600)` and
     * silently broken for `for (…) tick(1)`: real time barely advances between
     * calls, so the synthetic clock reset to roughly the same instant each
     * time and `fc.time` never accumulated. Everything time-based — One Euro,
     * beat grids, animations — froze, hands never reached their targets, and
     * the symptom was a game that "just missed everything" with no error. It
     * cost an agent an hour of debugging a game that was fine.
     *
     * `simClock` only ever moves forward, and is nudged up to real time so it
     * can't fall behind while the rAF loop is also running.
     */
    tick(frames = 1, dt = 1 / 60) {
      const stepMs = dt * 1000;
      simClock = Math.max(simClock, performance.now());
      for (let i = 0; i < frames; i++) {
        simClock += stepMs;
        step(simClock, dt);
      }
      // Hand the real clock back. Leaving `lastTime` in the synthetic future
      // makes the next rAF frame compute a negative dt, which inverts every
      // decay term in the juice engine.
      lastTime = performance.now();
      return { seconds: +(frames * dt).toFixed(2), clock: +simClock.toFixed(1) };
    },
  };
}

void boot();
