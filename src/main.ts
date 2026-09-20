/**
 * App entry. Owns the canvas, the render loop, and the router.
 *
 * PLAN.md §1: "Games are modes in one app. One camera stream, one owner."
 * That means exactly one requestAnimationFrame in the whole codebase — this
 * one — and exactly one getUserMedia — camera.ts.
 */

import { camera, recoveryDelayMs } from './core/camera';
import { vision } from './core/vision';
import { setCameraAspect } from './core/tracker';
import { audio } from './engine/audio';
import { simulator, isSimEnabled, SIM_ASPECT } from './core/simulator';
import type { VisionFrame } from './core/types';
import { resizeCanvas, viewportOf, drawText, measureText, vh } from './engine/draw';
import { COLORS } from './shell/theme';
import type { FrameContext } from './shell/screen';
import { router, SCREEN_KEYS } from './shell/router';
import { drawDebugOverlay, toggleDebug, watchForDebug, logDebug } from './shell/debug';
import { probeStorage } from './meta/storage';
import { leaderboard } from './meta/leaderboard';
import { tunables } from './meta/tunables';
import { tournament } from './meta/tournament';
import { RigCheckScreen } from './shell/rigcheck';
import { installOperatorConsole, operatorConsole } from './shell/operator';
import { highlights } from './meta/highlights';
import { AttractScreen } from './shell/attract';
import { MenuScreen } from './shell/menu';
import { ModeScreen } from './shell/mode';
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

// Route vision faults into the debug log before anything else can swallow them.
watchForDebug();
router.register('rigcheck', () => new RigCheckScreen());
router.register('attract', () => new AttractScreen());
router.register('menu', () => new MenuScreen());
router.register('initials', () => new InitialsScreen());
// "How many playing?", between the menu and a game that seats more than one.
router.register('mode', () => new ModeScreen());
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

  // Publish the real camera aspect ONCE, here, for every tracker in the app.
  // Landmark space is anisotropic and each tracker needs this to measure a body
  // correctly; leaving it to the owners meant four of the five never did it.
  // See `setCameraAspect`.
  {
    const cam = camera.getState();
    if (cam.width > 0 && cam.height > 0) setCameraAspect(cam.width / cam.height);
  }

  // In sim mode the simulator stands in for camera + MediaPipe entirely.
  if (SIM) {
    // Including the aspect: the simulator squeezes x by its own SIM_ASPECT, so
    // a tracker measuring its bodies has to undo exactly that number, not
    // whatever camera happens to be plugged in.
    setCameraAspect(SIM_ASPECT);
    latestVision = simulator.step(time, dt);
    // Stamp with the SAME clock the frame is delivered on.
    //
    // The simulator stamps `performance.now()`, but `__arcade.tick()` drives
    // `now` from a synthetic monotonic clock that advances a fixed 16.7ms per
    // call regardless of real time — so after a few hundred ticks the two are
    // seconds apart, in the same units but from different origins. Anything
    // comparing them (the stale-vision guard in GameBase, the latency stat)
    // then reads a fresh frame as ancient. A synthetic frame is by definition
    // exactly as old as the frame it is delivered in.
    latestVision.captureTime = now;
  }

  const fc: FrameContext = { time, dt, now, v, ctx, vision: latestVision };

  try {
    router.active?.render(fc);
  } catch (err) {
    // A thrown frame must never kill the loop — at a stall, a black screen
    // that stays black is unrecoverable without someone who can read a console.
    console.error('[render]', err);
  }

  // Rig health, on top of whatever is showing.
  drawRigHealth(fc);

  // The debug overlay draws on top of everything, including the screen's own
  // chrome — it is a diagnostic, not part of the design.
  drawDebugOverlay(fc);

  // AFTER the frame is drawn — it grabs what is on the canvas.
  highlights.tick(now);
}

/** When the rig first looked broken, or -1. See `drawRigHealth`. */
let unhealthySince = -1;
/** `performance.now()` of the next camera restart attempt. See `drawRigHealth`. */
let recoverAt = 0;
let recoverTries = 0;
/**
 * Restarts to attempt before the banner gives up and asks for a human.
 *
 * Six, which with the backoff below is about 31 seconds. A USB blip or an OS
 * device suspend recovers inside the first two; anything still dead after half
 * a minute is a real fault and a marshal needs to know rather than watch a
 * reassuring word.
 */
const RECOVER_QUIET_TRIES = 6;

/**
 * A DEAD CAMERA LOOKS EXACTLY LIKE AN EMPTY STALL.
 *
 * Attract draws the same "STAND IN FRAME" invitation whether the camera is
 * feeding it or not, and every screen correctly treats stale vision as "nobody
 * here" — so a failed camera or a failed model reads as a quiet afternoon to
 * everyone, including the marshal, while visitors wave at a TV that is ignoring
 * them. The only places the truth was visible were the debug overlay and the
 * operator console, and neither is written down anywhere a marshal would look.
 *
 * Three seconds of grace so a routine reconnect does not flash this up, and it
 * names the one action that fixes almost everything.
 */
function drawRigHealth(fc: FrameContext): void {
  if (SIM) return;

  const cam = camera.getState();
  const visionErr = vision.getStats().error;
  const broken = cam.status === 'error' || !!visionErr;

  if (!broken) {
    unhealthySince = -1;
    recoverAt = 0;
    recoverTries = 0;
    return;
  }
  if (unhealthySince < 0) unhealthySince = fc.now;

  // TRY TO FIX IT BEFORE ASKING A HUMAN TO.
  //
  // The old banner said PRESS F5 from the first second and then waited. At a
  // stall the most likely cause is not a broken laptop — it is somebody's bag
  // catching the webcam's USB lead, or the OS suspending the device — and both
  // of those come back on their own the moment `getUserMedia` is asked again.
  // Nobody is watching the screen closely enough to press a key: the marshal is
  // talking to the queue, which is the entire job.
  //
  // Backoff 1s, 2s, 4s, 8s, then every 10s forever. `camera.start()` returns
  // early while `status === 'starting'`, so overlapping calls are free, and one
  // getUserMedia every ten seconds costs nothing against a dead stall.
  if (cam.status === 'error' && fc.now >= recoverAt) {
    recoverTries++;
    // The sequence itself lives in core/camera.ts, where a test can read it —
    // the README promises it to a marshal and tells them to wait through it.
    recoverAt = fc.now + recoveryDelayMs(recoverTries);
    void camera.start();
  }

  if (fc.now - unhealthySince < 3000) return;

  const { ctx, v } = fc;
  const pad = vh(v, 1.6);
  const size = vh(v, 2.4);
  // Say what is actually happening. RECONNECTING is true for as long as the
  // backoff is still short; PRESS F5 is the admission that it has not worked,
  // and it is only earned after roughly half a minute of trying.
  const text =
    cam.status === 'error'
      ? recoverTries <= RECOVER_QUIET_TRIES
        ? '<CAMERA LOST — RECONNECTING>'
        : '<CAMERA LOST — PRESS F5>'
      : '<VISION OFFLINE — PRESS F5>';

  ctx.save();
  ctx.shadowBlur = 0;
  const w = measureText(ctx, text, size, 800) + pad * 2;
  const h = size + pad * 1.4;
  const x = v.width / 2 - w / 2;
  const y = vh(v, 2);

  ctx.fillStyle = COLORS.red;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = COLORS.ink;
  ctx.fillRect(x, y + h - vh(v, 0.5), w, vh(v, 0.5));
  drawText(ctx, text, v.width / 2, y + h / 2, {
    size,
    color: COLORS.ink,
    weight: 800,
    letterSpacing: '0.04em',
  });
  ctx.restore();
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

  // THE TITLE IS TEXT, NOT MARKUP, AND THE BRAND IS WHY IT HAS TO BE.
  //
  // Every title this is called with is wrapped in angle brackets — that is the
  // house style for a headline, from `<INSECURE CONTEXT>` to `<CAMERA ERROR>`.
  // Assigned through `innerHTML` the browser reads that as a tag: the DOM came
  // out as `<h1><startup failed=""></startup></h1>` and the heading rendered
  // EMPTY. Both of the failure screens that predate this had invisible titles,
  // on the two screens a marshal is most likely to be standing in front of.
  //
  // `detail` stays as markup on purpose — the callers pass `<code>` spans — so
  // only the heading changes.
  const h1 = document.createElement('h1');
  h1.textContent = message;
  el.appendChild(h1);

  const p = document.createElement('p');
  p.innerHTML = detail;
  el.appendChild(p);

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

/**
 * ASK FOR THE FONTS. NOTHING ELSE IN THIS APP EVER DOES.
 *
 * `@font-face` declares a font; it does not fetch one. The browser fetches on
 * first USE, and "use" means a DOM element laid out with that family. This app
 * draws every glyph it has to a canvas, and setting `ctx.font` does NOT count:
 * the canvas silently falls back to the next family in the stack and never
 * tells anyone.
 *
 * MEASURED, six seconds on attract, before this existed: zero woff2 requests in
 * `performance.getEntriesByType('resource')`, three faces `unloaded`, and
 * canvas text measuring byte-identical to a deliberately nonexistent family.
 * The entire arcade — every headline, every score, every label — rendered in
 * Helvetica. DESIGN.md says "Archivo exclusively" and the CSS said so too; the
 * glass did not.
 *
 * The only DOM that uses Archivo is the operator console, which is
 * `display: none` until a marshal opens it, and a hidden element triggers
 * nothing. So on a laptop without Archivo installed it never loaded at all, and
 * on a machine that happens to have it the bug is invisible — which is the
 * worst possible combination for noticing.
 *
 * Boot WAITS for this. It is four local files totalling ~55KB off disk, and the
 * alternative is that the first screen of the stall's day is set in the wrong
 * typeface. `allSettled` plus a timeout, because a font that will not load must
 * never be a stall that will not start.
 */
const FONT_WEIGHTS = [900, 800, 700, 500] as const;
const FONT_TIMEOUT_MS = 3000;

async function loadFonts(): Promise<void> {
  if (!document.fonts?.load) return;
  const wanted = FONT_WEIGHTS.map((w) =>
    // A sample string matters: the browser only loads the faces needed for the
    // characters given, and this app is capitals, digits and the brand's
    // brackets.
    document.fonts.load(`${w} 16px Archivo`, 'ABCXYZ 0123456789 <>')
  );
  await Promise.race([
    Promise.allSettled(wanted),
    new Promise((resolve) => setTimeout(resolve, FONT_TIMEOUT_MS)),
  ]);
}

/**
 * The `?screen=` deep link, WITH A FALLBACK.
 *
 * README documents this as a day-of tool: "Boot straight to a screen." It went
 * to `router.go` unchecked, and `go` on an unknown id logs a console warning
 * and RETURNS — so nothing is ever mounted, the render loop has no screen to
 * draw, and a marshal who mistyped `?screen=redlihgt` gets a black rectangle
 * with nothing to press.
 *
 * That is the exact failure `showBoot` was hardened against yesterday, reached
 * by a different road: a typo in a query string rather than a throw during
 * boot. A wrong screen that still runs is recoverable in one keystroke; a
 * blank one at a stall is not.
 *
 * The miss is logged rather than swallowed, so `d` says why the screen a
 * marshal asked for is not the one they got.
 */
function requestedScreen(fallback: string): string {
  const wanted = new URLSearchParams(location.search).get('screen');
  if (!wanted) return fallback;
  if (router.has(wanted)) return wanted;
  logDebug(`unknown ?screen=${wanted} — starting on ${fallback} instead`);
  return fallback;
}

async function boot(): Promise<void> {
  startTime = performance.now();
  lastTime = startTime;
  audio.setMuted(START_MUTED);
  requestAnimationFrame(loop);

  await loadFonts();

  // WILL THIS PROFILE LET US WRITE ANYTHING DOWN?
  //
  // All three stores raise `saveFailed` when a write is refused, but none of
  // them can notice until something has already been lost — the first slider
  // move, the first reported match, the first submitted score. The condition
  // worth catching is a profile that was never going to allow storage at all:
  // locked-down, managed, or a private window somebody opened without
  // thinking. That is present from load, fixable in ten seconds at 9am, and
  // not fixable at 3pm without throwing away the morning.
  //
  // One probe answers for all three because localStorage is per-origin, so a
  // refusal belongs to the origin and not to any one key. See meta/storage.ts.
  if (!probeStorage()) {
    leaderboard.saveFailed = true;
    tunables.saveFailed = true;
    tournament.saveFailed = true;
    logDebug('storage refused a probe write — nothing will persist');
  }

  if (SIM) {
    // Skip camera and MediaPipe entirely. Games see synthetic poses.
    simulator.auto = true;
    await router.go(requestedScreen('sixtyseven'));
    return;
  }

  // Secure-context guard. PLAN.md §9 flags this as a critical failure mode:
  // getUserMedia is blocked on plain http over a LAN IP, and the symptom is a
  // silently dead camera rather than an obvious error.
  if (!window.isSecureContext) {
    showBoot(
      '<INSECURE CONTEXT>',
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
    showBoot('<CAMERA ERROR>', camera.getState().error ?? 'Unknown error', {
      label: '<TRY AGAIN>',
      run: () => void boot(),
    });
    return;
  }

  await router.go(requestedScreen('attract'));
}

/* ------------------------------------------------------------------ */
/* Operator keys                                                       */
/* ------------------------------------------------------------------ */

window.addEventListener('keydown', (e) => {
  // Any key doubles as the user gesture Web Audio needs to start.
  audio.init();
  audio.setMuted(audio.muted);

  // THE INITIALS SCREEN OWNS THE KEYBOARD WHILE IT IS UP.
  //
  // It accepts A-Z so a marshal can type a name instead of dwelling three
  // letters. Every one of these global shortcuts is also a letter, so spelling
  // anything containing M, D, F or C muted the stall, threw up the debug
  // overlay, or dropped out of fullscreen and put browser chrome on the TV —
  // in front of whoever was entering their name.
  const typing = router.activeId === 'initials';

  // A GAME IN PROGRESS IS SOMEBODY'S TURN. A bag or an elbow on the keyboard
  // used to end it: bare 0-9 jump straight to another screen. Holding shift
  // still works, which is what the marshal wants and what the README documents.
  const target = SCREEN_KEYS[e.key];
  if (target) {
    const mid = router.active?.id !== 'attract' && router.active?.id !== 'menu';
    if (mid && !e.shiftKey) return;
    void router.go(target);
    return;
  }

  if (typing) return;

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
    case 'd':
      // Works in production too. See shell/debug.ts for why.
      toggleDebug();
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
    // The REAL instance. A dev-console `import('/src/meta/highlights.ts')`
    // does not reach it: Vite appends an HMR timestamp to module URLs it has
    // reloaded, so a bare import resolves to a SECOND, freshly-constructed
    // module — one whose `source` is null and whose counters are all zero.
    // That looks exactly like "instant replay is dead" and is not. Reach it
    // through here instead.
    highlights,
    // SAME TRAP, AND IT CAUGHT ME. Checking a bracket through
    // `import('/src/meta/tournament.ts')` reported `start()` succeeding and
    // `active` true on a module the app has never seen, which proves nothing
    // about the app. The tell is that the console DOM disagrees with it.
    //
    // Anything with module-level state belongs on this handle for exactly this
    // reason; the alternative is reading `localStorage` back by hand, which is
    // what I ended up doing.
    tournament,
    // `operatorConsole()` has said "for `window.__arcade` and tests" since it
    // was written, and until now neither used it. Driving the console meant
    // synthesising a KeyboardEvent with `code: 'Backquote'` — which tests the
    // hotkey rather than the thing behind it, and silently does nothing if the
    // anti-lean guard rejects the chord.
    get operator() {
      return operatorConsole();
    },
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
     * End-to-end sweep of the WHOLE turn, not just the game: attract, menu
     * dwell, play, initials, and back out. See src/dev/turn.ts for why this is
     * separate from `smoke` — the bug that made every tile unselectable passed
     * a fully green smoke run.
     */
    async turn(only?: string[]) {
      const { runTurn, formatTurn } = await import('./dev/turn');
      const host = (window as unknown as { __arcade: never }).__arcade;
      const report = await runTurn(host as never, only);
      console.log(formatTurn(report));
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
      // The highlight buffer's cost guard measures wall-clock time around each
      // grab and sheds when the mean goes over budget. Under this loop the
      // grabs land microseconds apart with the GPU never idle, which measured
      // 4.20 ms mean against 0.07 ms at the real cadence — so a full turn sweep
      // used to end with replays disabled and the reel dropped. Capture keeps
      // running; only the cost sampling pauses. See `setSynthetic`.
      highlights.setSynthetic(true);
      try {
        for (let i = 0; i < frames; i++) {
          simClock += stepMs;
          step(simClock, dt);
        }
      } finally {
        highlights.setSynthetic(false);
      }
      // Hand the real clock back. Leaving `lastTime` in the synthetic future
      // makes the next rAF frame compute a negative dt, which inverts every
      // decay term in the juice engine.
      lastTime = performance.now();
      return { seconds: +(frames * dt).toFixed(2), clock: +simClock.toFixed(1) };
    },
  };
}

/**
 * A BOOT THAT THROWS MUST NOT BE A BLACK SCREEN.
 *
 * `step()` has wrapped every frame in a try/catch for a long time, with the
 * note that "a black screen that stays black is unrecoverable without someone
 * who can read a console". `boot()` was launched with a bare `void` and had no
 * such guard, so anything thrown before the first `router.go` — a module that
 * failed to evaluate, a rejected font or worker load, an API missing on a
 * borrowed laptop — left exactly that: black screen, no message, nothing to
 * press.
 *
 * Seen for real. A stale dev-server module graph threw `probeStorage is not
 * defined` out of `boot()` and the app rendered nothing at all; the only
 * evidence anywhere was one line in a console nobody at a stall is going to
 * open. The cause was not a real defect, but the failure mode it exposed is.
 *
 * `showBoot` is already the house style for every boot failure we anticipated
 * — insecure context, camera error. This is the one we did not.
 */
void boot().catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  console.error('[boot]', err);
  showBoot('<STARTUP FAILED>', `The app could not start: <code>${detail}</code>`, {
    label: '<TRY AGAIN>',
    run: () => void boot(),
  });
});
