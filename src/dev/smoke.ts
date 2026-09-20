/**
 * Automated regression sweep across every game.
 *
 * Run it from the console on any ?sim=1 page:
 *
 *   await window.__arcade.smoke()            // all games
 *   await window.__arcade.smoke(['redlight']) // one game
 *
 * Why this exists: six games, four people editing in parallel, and a hard
 * deadline. Poking each game by hand after every change does not scale, and the
 * failures that matter here are quiet ones — a score that silently stays zero,
 * a round that never reaches results, a NaN that renders as "NaN" on a TV in
 * front of a queue.
 *
 * Each probe asserts the things a stall actually depends on:
 *
 *   - the game mounts and reaches `playing` without throwing
 *   - PASSIVE SCORING: a player who stands still and does nothing scores ZERO.
 *     This caught Balloon Pop scoring 36 points from a motionless player and
 *     would have caught Fruit Ninja harvesting with resting hands.
 *   - ACTIVE SCORING: a player who plays properly scores more than zero.
 *   - the round terminates in `results` rather than hanging
 *   - the score is a finite integer at every stage
 *   - nothing is written to console.error at any point
 *   - frame cost stays inside budget
 *
 * This is NOT a substitute for human playtesting (PLAN.md §8). It cannot tell
 * us whether a threshold is right for a real body under hall lighting. It tells
 * us whether we broke something since the last change.
 */

import type { GameId } from '../meta/leaderboard';
import { GAME_SEATS } from '../meta/games';
import type { PoseSimulator } from '../core/simulator';
import { JUMP_DURATION } from '../games/runner-world';

export interface SmokeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SmokeResult {
  game: string;
  passed: boolean;
  checks: SmokeCheck[];
  idleScore: number;
  activeScore: number;
  msPerFrame: number;
  errors: string[];
}

export interface SmokeReport {
  passed: boolean;
  total: number;
  failed: number;
  results: SmokeResult[];
  durationMs: number;
}

interface Probe {
  id: GameId;
  /** Drive the simulator so the game is played competently. */
  play: (sim: PoseSimulator) => void;
  /** Return the simulator to a neutral, idle body. */
  idle: (sim: PoseSimulator) => void;
  /**
   * Whether an idle player must score exactly zero.
   *
   * False only where the game legitimately accrues score without input —
   * the Runner scores distance because the world moves past you, which is the
   * genre. Everything else scoring while idle is a bug.
   */
  idleMustBeZero: boolean;
  /**
   * Largest idle score still considered "scored nothing", for the one game
   * where exactly zero is not achievable. Only consulted when
   * `idleMustBeZero` is true. See the Red Light probe for why it exists.
   */
  idleMax?: number;
  /** Frames to let the lobby/countdown run before input starts. */
  warmupFrames: number;
  /** Frames of active play before checking the active score. */
  playFrames: number;
  /** Extra sim players, for party games. */
  players?: number;
  /**
   * Closed-loop driver for games where blindly mashing input is not "playing
   * well" — it is losing. Called repeatedly in small tick slices with a handle
   * on the live game object, so the probe can react to game state.
   */
  drive?: (sim: PoseSimulator, game: unknown, tick: (n: number) => void, frames: number) => void;
}

/**
 * Runner driver timing, in SECONDS of time-to-row. Keep in step with turn.ts.
 *
 * `JUMP_LEAD_SEC` is `JUMP_DURATION / 2` — the jump arc is symmetric, so the
 * stretch where the feet clear a low barrier is centred half a jump after the
 * trigger. Derived rather than tuned, so changing the arc cannot silently
 * desync the driver from the collision test the way a typed-in number would.
 */
const JUMP_LEAD_SEC = JUMP_DURATION / 2;
/** Start the slide a little early and hold it across the row. */
const SLIDE_LEAD_SEC = 0.45;
const SLIDE_HOLD_SEC = 0.2;
/**
 * Blocks need a lane CHANGE, which is not an action — the sim body has to
 * physically cross, and `LaneDetector` then has to hold the new lane before
 * the game believes it. 1.2s was not enough: measured, every block was still
 * hit, 6 for 6. Raised until the number moved.
 */
const BLOCK_LEAD_SEC = 2.4;

/**
 * The slice of a simulator `driveRunner` uses. Named so the shared body is
 * identical in both harnesses although they hold different simulator types —
 * `turn.ts` has a structural `SimLike`, `smoke.ts` the real `PoseSimulator`.
 */
interface RunnerSim {
  setLane?: (n: number) => void;
  triggerJump?: () => void;
  setCrouch?: (on: boolean) => void;
}

/* RUNNER-DRIVER-BODY-START */
/**
 * ONE FRAME OF COMPETENT RUNNER PLAY.
 *
 * Duplicated character for character in `smoke.ts`. The two harnesses keep
 * their own drivers by design, and `probes.test.ts` compares these two bodies
 * directly, so the copies cannot drift the way the Rhythm duck did.
 */
function driveRunner(s: RunnerSim, game: unknown): void {
  const g = game as { debugState?: (slot?: number) => Record<string, unknown> } | null;
  const st = g?.debugState?.() ?? null;
  if (!st || st.state !== 'playing') {
    s.setCrouch?.(false);
    return;
  }

  const next = st.nextRow as { rel: number; cells: string[] } | null;
  if (!next) {
    s.setCrouch?.(false);
    return;
  }

  // `cells` is serialised as `lane:kind` for the console readout.
  const cells = next.cells.map((c) => {
    const [lane, kind] = c.split(':');
    return { lane: Number(lane), kind: kind ?? '' };
  });
  const lane = Number(st.lane) || 0;
  const here = cells.find((c) => c.lane === lane);
  const eta = next.rel / Math.max(1, Number(st.speed) || 1);

  // A block cannot be jumped or slid — it has to be gone around, and the
  // generator guarantees at least one lane is open.
  if (here?.kind === 'block' && eta < BLOCK_LEAD_SEC) {
    const blocked = new Set(cells.filter((c) => c.kind === 'block').map((c) => c.lane));
    const free = [0, -1, 1].find((l) => !blocked.has(l));
    if (free !== undefined) s.setLane?.(free);
  }

  if (here?.kind === 'low' && !st.airborne && eta > 0 && eta < JUMP_LEAD_SEC) {
    s.triggerJump?.();
  }

  // Held, not an edge: a slide started early and held through the row is what
  // the game's own note says everybody does the first time.
  s.setCrouch?.(here?.kind === 'high' && eta < SLIDE_LEAD_SEC && eta > -SLIDE_HOLD_SEC);
}
/* RUNNER-DRIVER-BODY-END */

const PROBES: Probe[] = [
  {
    id: 'sixtyseven',
    play: (s) => s.setPump(4.5, 1),
    idle: (s) => s.setPump(0),
    idleMustBeZero: true,
    warmupFrames: 260,
    playFrames: 420,
  },
  {
    id: 'fruitninja',
    play: (s) => s.setSwipe(2.2, 0.75),
    idle: (s) => {
      s.setSwipe(0);
      s.setPump(0);
    },
    idleMustBeZero: true,
    warmupFrames: 300,
    playFrames: 600,
  },
  {
    id: 'balloonpop',
    play: (s) => s.setPump(1.4, 1),
    idle: (s) => {
      s.setPump(0);
      s.setHandTarget(null);
    },
    idleMustBeZero: true,
    warmupFrames: 280,
    playFrames: 600,
  },
  {
    id: 'redlight',
    play: (s) => s.setPump(0),
    idle: (s) => s.setPump(0),
    idleMustBeZero: true,
    /**
     * The one game that cannot reach exactly zero, and it is the signal's
     * fault rather than the game's.
     *
     * Progress is motion ABOVE this player's own still-level. Under realistic
     * sensor noise the still and moving energy distributions OVERLAP — still
     * p99 is 5.40 against moving p10 of 5.07 (see the measured table in
     * redlight.ts) — so the tail of a motionless body crosses the line a few
     * times a round however the threshold is placed.
     *
     * MEASURED over a full 45s round with a body that never moves: energy
     * exceeded the threshold on 34 of 1538 green frames (2.2%), for a total of
     * 1.07-1.34% of the track. A player who actually plays finishes it. So the
     * invariant that matters — you cannot get anywhere by standing still — does
     * hold, and demanding a literal 0 here would mean tuning the detector
     * tight enough to eliminate people who are standing still, which is the
     * exact failure this game already shipped once.
     *
     * RE-MEASURED after `MotionEnergy` gained its aspect correction and the
     * simulator's noise became isotropic in pixels: a body that never moves for
     * a full 45s round now finishes on 8-12% of the track, reading as a score
     * of 2-5. A player who actually plays finishes it — 100%, scoring 49-79 —
     * so the invariant that matters, that you cannot get anywhere by standing
     * still, holds by an order of magnitude.
     *
     * 12 leaves headroom over the measured 5 without hiding a regression:
     * before the noise floor was learned at all, a motionless player advanced
     * continuously and was eliminated within 10s of every round.
     */
    idleMax: 12,
    // 10s lobby + countdown before anything counts.
    warmupFrames: 900,
    playFrames: 900,
    players: 3,
    /**
     * Red Light is the one game where mashing input is not competent play —
     * it is instant elimination. An open-loop probe flails through red lights,
     * gets knocked out, scores zero, and looks like a broken game.
     *
     * So this probe actually plays: flail on green, freeze on red, with a
     * reaction delay inside the grace period.
     */
    drive: (sim, game, tick, frames) => {
      const g = game as { light?: string } | null;
      const slice = 6;
      for (let done = 0; done < frames; done += slice) {
        sim.setPump(g?.light === 'green' ? 5 : 0, 1);
        tick(slice);
      }
    },
  },
  {
    id: 'posematch',
    /**
     * Closed-loop: adopt the pose the wall is actually asking for.
     *
     * It used to flail (`setPump(2.5, 1)`) and pass on a score of 1 or 2 —
     * accidental matches. That check was asserting almost nothing, and it broke
     * the moment `poseSimilarity` was aspect-corrected, because random flailing
     * stopped landing on poses by luck. Which is correct behaviour: random
     * flailing SHOULD score zero.
     *
     * Feeding each wall its own angles tests the mechanic instead of the noise,
     * and it is the only probe on the roster that verifies a game can be WON.
     */
    play: (s) => s.setPoseAll(null),
    idle: (s) => {
      s.setPoseAll(null);
      s.setPump(0);
    },
    drive: (sim, game, tick, frames) => {
      const g = game as { slots?: Array<{ wall?: { pose?: { angles?: unknown } } }> } | null;
      let last: unknown = null;
      for (let done = 0; done < frames; done++) {
        const pose = g?.slots?.[0]?.wall?.pose;
        if (pose && pose !== last) {
          last = pose;
          sim.setPoseAll(pose.angles as never);
        }
        tick(1);
      }
    },
    idleMustBeZero: true,
    warmupFrames: 300,
    playFrames: 900,
  },
  {
    id: 'rhythm',
    /**
     * CLOSED-LOOP, because waving is no longer play.
     *
     * This probe used to swing both fists across the lane targets and call that
     * active play. That worked only because the hit radius was half a torso —
     * big enough that a fist flung anywhere near the grid clipped something. At
     * the measured radius (0.3) a flailing player scores 284 where an aiming one
     * scores 2425, which is the entire point of the change, and the probe was
     * on the wrong side of it: it scored a flat ZERO and looked like a broken
     * game.
     *
     * So it now punches the notes the chart is actually asking for, using the
     * game's own `debug()` hook, which reports each live note's hand and its
     * target already converted to camera space. Between notes the fists retract
     * to a rest position — that is not decoration, it is what arms the
     * anti-passive gate, which requires a hand to ARRIVE from outside the ring.
     */
    play: (s) => s.clearWristTargets(),
    idle: (s) => {
      s.setSwipe(0);
      s.setPump(0);
      s.setCrouch(false);
      s.clearWristTargets();
    },
    drive: (sim, game, tick, frames) => {
      const g = game as {
        debug?: () => {
          notes: Array<{
            kind: string;
            delta: number;
            hands: Array<string | null>;
            status: string[];
            target: Array<{ x: number; y: number } | null>;
          }>;
        };
      } | null;
      // Hands down and outside the lanes, so every punch arrives from outside.
      const rest = { left: { x: 0.38, y: 0.75 }, right: { x: 0.62, y: 0.75 } };
      const slice = 2;
      for (let done = 0; done < frames; done += slice) {
        const notes = g?.debug?.().notes ?? [];

        // AND IT HAS TO DUCK, which it never did.
        //
        // Walls are one of this game's two scoring paths and the probe only
        // ever punched. FOUND BY COUNTING AUDIO CUES over a full seven-game
        // sweep: `wallhit` played 15 times and `duck` ZERO, so the simulated
        // player hit every wall in the chart and cleared none. Every automated
        // check passed the whole time, because nothing asserts that the duck
        // path is reachable — the same shape as the quad-chain clip that could
        // never fire.
        //
        // `isCrouching` is the HELD state, not the edge, so the duck can start
        // early and be held through the wall — which is what the game's own
        // comment says everyone does the first time. The window is
        // `TIMING.wall` (0.45s) either side; crouching a little before it opens
        // and holding until it closes is a player ducking, not a cheat.
        const wall = notes.find(
          (x) => x.kind === 'wall' && x.status[0] === 'live' && x.delta > -0.35 && x.delta < 0.6
        );
        sim.setCrouch(!!wall);

        for (const hand of ['left', 'right'] as const) {
          const n = notes.find(
            (x) =>
              x.kind === 'punch' &&
              x.hands[0] === hand &&
              x.status[0] === 'live' &&
              x.delta > -0.15 &&
              x.delta < 0.5
          );
          const t = n?.target[0];
          sim.setWristTargetAll(hand, t ?? rest[hand]);
        }
        tick(slice);
      }
      sim.setCrouch(false);
      sim.clearWristTargets();
    },
    idleMustBeZero: true,
    warmupFrames: 320,
    playFrames: 900,
  },
  {
    id: 'runner',
    play: (s) => {
      s.setLane?.(0);
      s.triggerJump();
    },
    // Closed-loop, because standing in the centre lane and walking into every
    // obstacle is not play. See `driveRunner` above for how that was found.
    drive: (sim, game, tick, frames) => {
      const slice = 2;
      for (let done = 0; done < frames; done += slice) {
        driveRunner(sim, game);
        tick(slice);
      }
    },
    idle: (s) => s.setPump(0),
    // Distance accrues because the world scrolls — that IS the game.
    idleMustBeZero: false,
    warmupFrames: 300,
    playFrames: 600,
  },
];

type ArcadeHost = {
  router: { go(id: string): Promise<void>; activeId: string; has(id: string): boolean };
  simulator: PoseSimulator;
  screen: unknown;
  tick(frames?: number, dt?: number): unknown;
  vision: {
    start(config: Record<string, unknown>): Promise<void>;
    setConfig(patch: Record<string, unknown>): Promise<void>;
    getStats(): { ready: boolean; error: string | null; delegate: string | null };
    dispose(): void;
  };
};

/** Seconds to allow for MediaPipe to fetch and instantiate a model. */
const VISION_BOOT_TIMEOUT_MS = 25000;

/**
 * Does the REAL vision pipeline start?
 *
 * THIS EXISTS BECAUSE EVERYTHING ELSE IN THIS FILE RUNS UNDER `?sim=1`, which
 * replaces the camera and MediaPipe wholesale — so the vision worker is never
 * constructed and a fault in it passes every check here at full marks.
 *
 * One did. `forVisionTasks()` defaults to MediaPipe's CLASSIC WASM loader,
 * whose only export is a top-level `var ModuleFactory`; in the module worker
 * this app uses, MediaPipe reaches that loader through `await import()`, where
 * a top-level `var` is module-scoped and never becomes a global. Every model
 * load failed with "ModuleFactory not set." on every machine, in dev and in
 * production, from the first commit — and the entire test suite, every smoke
 * sweep and every screenshot stayed green, because none of them ever built the
 * worker. It took a real camera to find it.
 *
 * Needs no camera: model loading is independent of any video frame, which is
 * exactly what makes it cheap enough to run on every sweep.
 */
async function checkVisionBoots(host: ArcadeHost): Promise<SmokeCheck[]> {
  if (!host.vision) return [check('vision boots', false, 'host.vision not exposed')];

  try {
    void host.vision.start({ mode: 'pose', numPoses: 2, poseModel: 'lite' });
  } catch (err) {
    return [check('vision boots', false, `start() threw: ${String(err)}`)];
  }

  const settle = async (label: string): Promise<SmokeCheck | null> => {
    const deadline = performance.now() + VISION_BOOT_TIMEOUT_MS;
    for (;;) {
      const s = host.vision.getStats();
      if (s.error) return check(label, false, s.error);
      if (s.ready) return null;
      if (performance.now() > deadline) {
        return check(label, false, `still not ready after ${VISION_BOOT_TIMEOUT_MS}ms`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const bootFail = await settle('vision boots');
  if (bootFail) return [bootFail];

  const checks = [check('vision boots', true, `ready on ${host.vision.getStats().delegate ?? '?'}`)];

  // THE SECOND CREATION, which is where it actually broke.
  //
  // Booting once proves almost nothing: `applyConfig` tears down and rebuilds
  // the pose landmarker whenever `numPoses` changes, attract runs 4 and the
  // games run 2 or 6, so every real session rebuilds within seconds of
  // starting. The first version of this check only booted once, passed, and
  // shipped a build that died on the first screen transition.
  try {
    await host.vision.setConfig({ numPoses: 6 });
  } catch (err) {
    return [...checks, check('vision rebuilds', false, `setConfig threw: ${String(err)}`)];
  }

  const rebuildFail = await settle('vision rebuilds');
  checks.push(rebuildFail ?? check('vision rebuilds', true, 'survives a numPoses change'));
  return checks;
}

/**
 * Return the simulator to a known body before a measurement.
 *
 * Each probe used to set only the knobs its own game cares about, so whatever
 * ran before it stayed switched on. MEASURED: a leftover 3-player pump made 67
 * Speed score 4 while standing perfectly still and Fruit Ninja score 0 while
 * swiping — two failures that look exactly like fresh regressions and are
 * entirely the harness. Reset everything, every time.
 */
function resetSim(sim: PoseSimulator, players: number): void {
  sim.auto = false;
  sim.setPump(0);
  sim.setSwipe(0);
  sim.setPoseAll(null);
  sim.setHandTarget(null);
  sim.clearWristTargets();
  sim.freezeAll(false);
  sim.setPlayerCount(players);
}

/**
 * Red Light judges each player INDIVIDUALLY.
 *
 * This is the whole game. If one person moving during a red light takes the
 * whole line out with them, the game is not Red Light — and nothing else in
 * this file would notice, because every other check drives all the sim bodies
 * identically and only ever reads player 0.
 *
 * A full lobby, all pumping on green. On red, half of them freeze and half keep
 * going. The ones who stopped must finish the round alive and the ones who did
 * not must be out.
 *
 * The roster size comes from `GAME_SEATS`, not from a literal. It was 6 and is
 * now 5 — `PLAYER_COLORS` only holds five identities that are not the disabled
 * colour — and this check hard-coded the 6 in three places, so a product
 * decision made in `redlight.ts` failed a probe in `smoke.ts` for no reason a
 * reader could see.
 *
 * `setFrozen` had never been called by anything when this was written — it
 * shipped with a doc comment promising exactly these semantics and a body that
 * only stopped the flail clock, so a "frozen" pumping body kept swinging its
 * arms and was eliminated every time. An untested API is not a working one.
 */
async function checkRedLightFairness(host: ArcadeHost): Promise<SmokeCheck[]> {
  const sim = host.simulator;
  const seats = GAME_SEATS.redlight;
  const frozen = Math.floor(seats / 2);
  resetSim(sim, seats);
  // Via the menu: `router.go(id)` when that screen is already active does NOT
  // remount it. Coming straight here after the standard probe leaves us holding
  // the finished round, still sitting in `results`, and the check reports "never
  // started" for a game that is fine.
  await host.router.go('menu');
  await host.router.go('redlight');
  const game = host.screen as { state?: string; light?: string; racers?: Map<number, unknown> };

  // Out of the lobby and countdown.
  for (let i = 0; i < 40 && stateOf(game) !== 'playing'; i++) host.tick(60);
  if (stateOf(game) !== 'playing') {
    return [check('red light judges individually', false, `never started (${stateOf(game)})`)];
  }

  // Sim indices 0-2 obey the light; 3-5 ignore it.
  //
  // THREE frames a slice, not fifteen. The slice size is how late the freeze
  // lands after the light turns, and it is added on top of whatever reaction
  // delay the game already models. At 15 frames that is an extra 0-250ms eaten
  // out of a 550ms grace, and an honest player is eliminated perhaps one round
  // in three — a flaky test that blames the game for the harness's sampling.
  for (let i = 0; i < 2000 && stateOf(game) === 'playing'; i++) {
    const red = game.light === 'red';
    sim.setPump(5, 1);
    for (let p = 0; p < seats; p++) sim.setFrozen(p, red && p < frozen);
    host.tick(3);
  }

  const racers = [...(game.racers?.values() ?? [])] as Array<{ alive: boolean; lane: number }>;
  const aliveLanes = racers.filter((r) => r.alive).map((r) => r.lane).sort((a, b) => a - b);
  resetSim(sim, 1);

  // Assert the INVARIANT, not an exact roster.
  //
  // Two properties, and between them they pin the thing that matters:
  //
  //   1. survivors all sit in ONE half of the lanes. The display is mirrored,
  //      so the honest bodies land in the upper lanes rather than the lower —
  //      which half does not matter, but a mix does: survivors scattered across
  //      both would mean the detector is firing at random, and that passes any
  //      bare count.
  //   2. at least one survives and at least one does not. Collective judging —
  //      one person moving takes the whole line out — shows up as nobody alive
  //      or everybody alive, and both are excluded.
  //
  // Deliberately tolerant of ONE honest player being caught. This is a noisy
  // signal by construction (still and moving energy overlap; see the measured
  // table in redlight.ts) and a check that demands a perfect 3/3 every run is a
  // check that cries wolf. Collective judging cannot hide inside that slack.
  const mid = seats / 2;
  const oneHalf =
    aliveLanes.every((l) => l < mid) || aliveLanes.every((l) => l >= mid);
  // 1..seats-1, not exactly `frozen`. A full lobby puts the outer lanes into
  // the frame edges where `edgeBias` makes them measurably noisier than the
  // middle, so one honest player being caught is within the signal's real
  // spread — and the thing this check exists to catch, judging the LINE
  // instead of the player, shows up as 0 or all and is excluded either way.
  const ok =
    racers.length === seats &&
    oneHalf &&
    aliveLanes.length >= 1 &&
    aliveLanes.length < seats;

  return [
    check(
      'red light judges individually',
      ok,
      `survivors in lanes [${aliveLanes.join(',')}] of ${racers.length}; ` +
        `expected 1-${seats - 1}, all in the half that stopped`
    ),
  ];
}

function scoreOf(screen: unknown): number {
  const s = screen as { scoreFor?: (slot: number) => number } | null;
  if (!s || typeof s.scoreFor !== 'function') return NaN;
  return s.scoreFor(0);
}

function stateOf(screen: unknown): string {
  return (screen as { state?: string } | null)?.state ?? 'unknown';
}

function check(name: string, ok: boolean, detail: string): SmokeCheck {
  return { name, ok, detail };
}

async function runProbe(host: ArcadeHost, probe: Probe): Promise<SmokeResult> {
  const checks: SmokeCheck[] = [];
  const errors: string[] = [];

  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(String(args[0]));
    originalError(...(args as []));
  };

  let idleScore = NaN;
  let activeScore = NaN;
  let msPerFrame = 0;

  try {
    const sim = host.simulator;
    resetSim(sim, probe.players ?? 1);
    probe.idle(sim);

    // VIA THE MENU. `router.go(id)` when that screen is already active does NOT
    // remount it, and a sweep that runs the same game twice — or any run that
    // follows one which ended on this screen — then inherits the FINISHED round
    // still sitting in `results`. Everything downstream reads that round's
    // final score as an idle score and reports a passive-scoring bug in a game
    // that is fine. Cost an hour the first time, so it is guarded in both
    // places that mount a game.
    if (host.router.activeId === probe.id) {
      await host.router.go('menu');
      // Let the menu actually mount. Bouncing straight back can land before the
      // swap completes, which re-delivers the screen we were trying to leave.
      host.tick(4);
    }
    await host.router.go(probe.id);
    checks.push(check('mounts', host.router.activeId === probe.id, host.router.activeId));

    // Hold the screen REFERENCE, don't re-read host.screen.
    //
    // A game can legitimately end its own round early — Red Light ends the
    // moment everyone is eliminated — after which the router has already moved
    // on to initials or attract, and re-reading host.screen yields a screen
    // with no scoreFor. That looked like the game returning NaN when it was
    // the probe looking in the wrong place.
    const game = host.screen;

    // Warm-up covers any lobby and the countdown.
    host.tick(probe.warmupFrames);
    const st = stateOf(game);
    checks.push(check('reaches playing', st === 'playing', `state=${st}`));

    // --- idle phase: a motionless player must not accumulate score ---
    probe.idle(sim);
    host.tick(240);
    idleScore = scoreOf(game);

    // If the round is already over, `idleScore` is the FINISHED score and
    // means nothing. Reporting it as an idle score produces failures like
    // "idle score 213, tolerance 3" for a game whose real problem is that the
    // round ended during the warm-up — which sends the next reader chasing a
    // passive-scoring bug that does not exist.
    const idlePhaseState = stateOf(game);
    if (idlePhaseState !== 'playing') {
      checks.push(
        check(
          'round still live for the idle check',
          false,
          `state=${idlePhaseState}; the idle and active scores below are meaningless`
        )
      );
    }
    if (probe.idleMustBeZero) {
      const limit = probe.idleMax ?? 0;
      checks.push(
        check(
          'idle scores zero',
          idleScore <= limit,
          limit > 0
            ? `idle score ${idleScore}, tolerance ${limit}`
            : `idle score was ${idleScore}`
        )
      );
    } else {
      checks.push(check('idle scores zero', true, `n/a (${idleScore})`));
    }

    // --- active phase ---
    probe.play(sim);
    const t0 = performance.now();
    if (probe.drive) {
      probe.drive(sim, game, (n) => host.tick(n), probe.playFrames);
    } else {
      host.tick(probe.playFrames);
    }
    msPerFrame = (performance.now() - t0) / probe.playFrames;
    activeScore = scoreOf(game);

    checks.push(
      check('active scores above idle', activeScore > idleScore, `${idleScore} -> ${activeScore}`)
    );
    checks.push(
      check(
        'score is a finite integer',
        Number.isFinite(activeScore) && Number.isInteger(activeScore),
        String(activeScore)
      )
    );
    checks.push(
      check('frame budget', msPerFrame < 16.7, `${msPerFrame.toFixed(2)}ms/frame`)
    );

    // --- run the round out; it must terminate ---
    for (let i = 0; i < 12 && stateOf(game) === 'playing'; i++) host.tick(600);
    const endState = stateOf(game);
    checks.push(
      check(
        'round terminates',
        endState === 'results' || host.router.activeId !== probe.id,
        `ended in ${endState} / ${host.router.activeId}`
      )
    );

    probe.idle(sim);
  } catch (err) {
    checks.push(check('no exception', false, err instanceof Error ? err.message : String(err)));
  } finally {
    console.error = originalError;
  }

  checks.push(
    check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'clean')
  );

  return {
    game: probe.id,
    passed: checks.every((c) => c.ok),
    checks,
    idleScore,
    activeScore,
    msPerFrame,
    errors,
  };
}

export async function runSmoke(host: ArcadeHost, only?: string[]): Promise<SmokeReport> {
  const started = performance.now();
  const probes = only ? PROBES.filter((p) => only.includes(p.id)) : PROBES;
  const results: SmokeResult[] = [];

  // Pre-flight, and only on a full sweep — it is about the app, not one game.
  if (!only) {
    const checks = await checkVisionBoots(host);
    results.push({
      game: 'vision' as GameId,
      passed: checks.every((c) => c.ok),
      checks,
      idleScore: 0,
      activeScore: 0,
      msPerFrame: 0,
      errors: [],
    });
  }

  for (const probe of probes) {
    if (!host.router.has(probe.id)) {
      results.push({
        game: probe.id,
        passed: false,
        checks: [check('registered', false, 'not registered in main.ts')],
        idleScore: NaN,
        activeScore: NaN,
        msPerFrame: 0,
        errors: [],
      });
      continue;
    }
    results.push(await runProbe(host, probe));

    // Red Light's defining property, which the standard probe cannot see: it
    // drives every body identically and reads only player 0.
    if (probe.id === 'redlight') {
      const fair = await checkRedLightFairness(host);
      const last = results[results.length - 1];
      if (last) {
        last.checks.push(...fair);
        last.passed = last.checks.every((c) => c.ok);
      }
    }
  }

  const failed = results.filter((r) => !r.passed).length;
  return {
    passed: failed === 0,
    total: results.length,
    failed,
    results,
    durationMs: performance.now() - started,
  };
}

/** Compact one-line-per-game summary for reading in a console. */
export function formatSmoke(report: SmokeReport): string {
  const lines: string[] = [];
  lines.push(
    `${report.passed ? 'PASS' : 'FAIL'} — ${report.total - report.failed}/${report.total} games in ${(report.durationMs / 1000).toFixed(1)}s`
  );
  for (const r of report.results) {
    lines.push(
      `${r.passed ? '  ok  ' : '  FAIL'} ${r.game.padEnd(12)} idle=${r.idleScore} active=${r.activeScore} ${r.msPerFrame.toFixed(2)}ms`
    );
    for (const c of r.checks) {
      if (!c.ok) lines.push(`         ✗ ${c.name}: ${c.detail}`);
    }
  }
  return lines.join('\n');
}
