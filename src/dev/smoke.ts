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
import type { PoseSimulator } from '../core/simulator';

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
    play: (s) => s.setPump(2.5, 1),
    idle: (s) => s.setPump(0),
    idleMustBeZero: true,
    warmupFrames: 300,
    playFrames: 900,
  },
  {
    id: 'rhythm',
    // Both fists parked on the lane targets. The game's anti-passive gate
    // requires a hand to ARRIVE from outside the ring, so a parked fist scores
    // zero — which is exactly the idle check we want.
    play: (s) => s.setSwipe(1.6, 0.55),
    idle: (s) => {
      s.setSwipe(0);
      s.setPump(0);
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
    sim.auto = false;
    sim.setPlayerCount(probe.players ?? 1);
    probe.idle(sim);

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
    if (probe.idleMustBeZero) {
      checks.push(
        check('idle scores zero', idleScore === 0, `idle score was ${idleScore}`)
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
