/**
 * Full-turn regression sweep: the whole path a visitor actually walks.
 *
 *   await window.__arcade.turn()              // every game
 *   await window.__arcade.turn(['redlight'])  // one game
 *
 * Why this exists alongside `smoke.ts`. Smoke mounts each game DIRECTLY and
 * asserts that it scores and terminates. That is half a turn. At the stall the
 * visitor never mounts a game directly — they walk up to an attract screen,
 * raise a hand, dwell on a tile, play, then spell three letters with the same
 * hand. Every one of those steps is a place the turn can die, and none of them
 * were covered: the cursor hand-teleport bug, which made it impossible to
 * select ANY game, sailed through a fully green smoke run.
 *
 * So this drives the SHELL, through the real hover cursor, and asserts that a
 * turn completes:
 *
 *   attract -> menu -> (dwell on the tile) -> game -> results/initials
 *           -> (dwell three letters + OK) -> back out to attract or menu
 *
 * It reuses the smoke probes to play each game, so the two stay in step.
 *
 * ── Two rules this harness exists to encode ──────────────────────────────
 *
 * 1. LAYOUT RUNS INSIDE render(). A screen's `targets` array is empty until it
 *    has drawn at least one frame. Reading the hit set on the same tick the
 *    router switched screens returns `[]`, and a cursor pointed at coordinates
 *    derived from it hovers nothing forever. This looks exactly like "the
 *    dwell is broken" and is not. `settle()` below is the fix: always advance
 *    a couple of frames after a screen change before touching `targets`.
 *
 * 2. POINT WITH `cursor.override`, NOT WITH THE SIMULATOR. The simulator eases
 *    a wrist toward a target over ~11 real seconds and cannot place it at an
 *    arbitrary screen point at all. Driving menu selection through it is slow
 *    and imprecise. `override` is the supported test hook and still runs the
 *    full filter/dwell/latch path, so it tests what we want tested.
 */

import type { GameId } from '../meta/leaderboard';

export interface TurnStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface TurnResult {
  game: string;
  passed: boolean;
  steps: TurnStep[];
  trail: string[];
  score: number | null;
  errors: string[];
}

export interface TurnReport {
  passed: boolean;
  total: number;
  failed: number;
  results: TurnResult[];
  durationMs: number;
}

/** Everything the harness needs off `window.__arcade`. */
interface Host {
  router: { go: (id: string) => void; active: ScreenLike | null };
  simulator: SimLike;
  screen: ScreenLike | null;
  tick: (frames?: number, dt?: number) => unknown;
}

interface ScreenLike {
  id: string;
  cursor?: CursorLike;
  targets?: ReadonlyArray<{ id: string; x: number; y: number; w: number; h: number }>;
  score?: number;
  letters?: string[];
  phase?: string;
}

interface CursorLike {
  override: { x: number; y: number } | null;
  state: { committed: string | null; hovered: string | null; present: boolean };
}

interface SimLike {
  auto: boolean;
  realism?: unknown;
  setPlayerCount: (n: number) => void;
  setPump: (a: number, b?: number) => void;
  setSwipe: (a: number, b?: number) => void;
  setPoseAll: (a: unknown) => void;
  setHandTarget?: (a: unknown) => void;
  setLane?: (n: number) => void;
  triggerJump?: () => void;
  clearWristTargets?: () => void;
}

/**
 * How each game is played well enough to finish a round and score.
 *
 * Open-loop where mashing IS competent play, closed-loop where it is not.
 * Red Light and Pose Match both score zero against a flailing or motionless
 * body — correctly — so a turn driven that way never earns a leaderboard place
 * and never exercises the initials screen, which is half of what this sweep is
 * for. These mirror the drivers in `smoke.ts`; keep the two in step.
 */
const PLAY: Record<string, (s: SimLike) => void> = {
  sixtyseven: (s) => s.setPump(4.5, 1),
  fruitninja: (s) => s.setSwipe(2.2, 0.75),
  balloonpop: (s) => s.setPump(1.4, 1),
  redlight: (s) => s.setPump(0),
  posematch: (s) => s.setPoseAll(null),
  rhythm: (s) => s.setSwipe(1.6, 0.55),
  runner: (s) => {
    s.setLane?.(0);
    s.triggerJump?.();
  },
};

/** Per-frame reaction to live game state, for the two games that need it. */
const DRIVE: Record<string, (s: SimLike, game: unknown) => void> = {
  // Flail on green, freeze on red. Mashing through a red light is instant
  // elimination, not play.
  redlight: (s, game) => {
    const g = game as { light?: string } | null;
    s.setPump(g?.light === 'green' ? 5 : 0, 1);
  },
  // Adopt the pose the wall is actually asking for. Random flailing scores
  // zero here, which is the correct behaviour and a useless turn.
  posematch: (s, game) => {
    const g = game as { slots?: Array<{ wall?: { pose?: { angles?: unknown } } }> } | null;
    const pose = g?.slots?.[0]?.wall?.pose;
    if (pose && pose.angles !== lastPose) {
      lastPose = pose.angles;
      s.setPoseAll(pose.angles as never);
    }
  },
};

let lastPose: unknown = null;

const GAMES: GameId[] = [
  'sixtyseven',
  'fruitninja',
  'balloonpop',
  'redlight',
  'posematch',
  'rhythm',
  'runner',
] as unknown as GameId[];

/** A turn that has not finished in three minutes of game time is a stall. */
const MAX_TURN_FRAMES = 60 * 180;

export async function runTurn(host: Host, only?: string[]): Promise<TurnReport> {
  const started = performance.now();
  const games = only?.length ? GAMES.filter((g) => only.includes(g as string)) : GAMES;
  const results: TurnResult[] = [];

  for (const game of games) {
    results.push(await oneTurn(host, game as string));
  }

  const failed = results.filter((r) => !r.passed).length;
  return {
    passed: failed === 0,
    total: results.length,
    failed,
    results,
    durationMs: Math.round(performance.now() - started),
  };
}

async function oneTurn(host: Host, game: string): Promise<TurnResult> {
  const steps: TurnStep[] = [];
  const errors: string[] = [];
  const trail: string[] = [];

  const origError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
    origError(...args);
  };

  const sim = host.simulator;
  const id = () => host.router.active?.id ?? '?';
  const note = () => {
    const cur = id();
    if (trail[trail.length - 1] !== cur) trail.push(cur);
  };

  /**
   * Advance the app, yielding to the event loop between slices.
   *
   * The yield is not needed for the simulator — in sim mode vision is produced
   * synchronously inside `step()`. It is here so a long sweep cannot lock the
   * tab for a minute, and so anything that legitimately waits on real time
   * (audio, the highlight recorder's frame grabs) still gets a turn.
   */
  const run = async (
    frames: number,
    stop?: (id: string) => boolean,
    each?: () => void
  ): Promise<void> => {
    // Small slices so a closed-loop driver reacts on roughly the timescale a
    // person does — a red light held for six frames is 100ms of over-running.
    const slice = each ? 3 : 6;
    for (let done = 0; done < frames; done += slice) {
      each?.();
      host.tick(slice);
      if (done % 60 === 0) await Promise.resolve();
      note();
      if (stop?.(id())) return;
    }
  };

  /** See rule 1 in the file header: no hit set exists until a frame is drawn. */
  const settle = async (): Promise<void> => {
    host.tick(3);
    await Promise.resolve();
  };

  const step = (name: string, ok: boolean, detail = ''): boolean => {
    steps.push({ name, ok, detail });
    return ok;
  };

  /** Point the cursor at a target's centre and hold until it commits. */
  const dwell = async (targetId: string, maxFrames = 480): Promise<boolean> => {
    const screen = host.router.active;
    const cursor = screen?.cursor;
    if (!cursor) return false;
    const t = screen?.targets?.find((x) => x.id === targetId);
    if (!t) return false;

    const canvas = document.querySelector('canvas');
    if (!canvas) return false;
    cursor.override = {
      x: (t.x + t.w / 2) / canvas.clientWidth,
      y: (t.y + t.h / 2) / canvas.clientHeight,
    };

    // ONE FRAME AT A TIME. `state.committed` is a one-frame edge: it names the
    // target on the frame the dwell lands and is null again on the next. A
    // poll that advances three frames per check misses it roughly two times in
    // three, and reports a letter that visibly landed on screen as a failure.
    for (let i = 0; i < maxFrames; i++) {
      host.tick(1);
      if (i % 60 === 0) await Promise.resolve();
      if (cursor.state.committed === targetId) return true;
      if (host.router.active?.id !== screen?.id) return true; // committed and moved on
    }
    return false;
  };

  let score: number | null = null;

  try {
    // FULL RESET, not just the knobs this game uses.
    //
    // Whatever ran before this — another game in the sweep, or a probe someone
    // typed into the console — leaves the simulator wherever it left it. A
    // stale `setPlayerCount(3)` or a pump still running turns the next game's
    // numbers into nonsense: measured, a leftover 3-player pump made 67 Speed
    // score 4 while standing still and Fruit Ninja score 0 while swiping, both
    // of which read as brand-new regressions in code that was fine.
    sim.auto = false;
    sim.setPump(0);
    sim.setSwipe(0);
    sim.setPoseAll(null);
    sim.setHandTarget?.(null);
    sim.clearWristTargets?.();
    sim.setPlayerCount(game === 'redlight' ? 3 : 1);

    // ── attract ──────────────────────────────────────────────────────────
    host.router.go('attract');
    await settle();
    note();
    await run(900, (s) => s === 'menu');
    step('attract promotes to menu on a body', id() === 'menu', `ended on ${id()}`);

    // ── menu: select the tile with the real dwell cursor ──────────────────
    await settle();
    const picked = await dwell(game);
    await run(240, (s) => s === game);
    if (!step('menu tile selects by dwell', id() === game, `picked=${picked} ended on ${id()}`)) {
      throw new Error('never reached the game');
    }

    // ── play ─────────────────────────────────────────────────────────────
    await settle();
    lastPose = null;
    PLAY[game]?.(sim);
    const drive = DRIVE[game];
    await run(
      MAX_TURN_FRAMES,
      (s) => s === 'results' || s === 'initials' || s === 'attract',
      drive && ((): void => drive(sim, host.router.active))
    );
    const landed = id();
    step(
      'round terminates',
      landed === 'results' || landed === 'initials' || landed === 'attract',
      `ended on ${landed}`
    );

    const played = host.router.active;
    if (typeof played?.score === 'number') score = played.score;

    // ── initials, when the score earned one ───────────────────────────────
    if (id() === 'initials') {
      await settle();
      let typed = 0;
      // Read the slots as we go. The third letter AUTO-SUBMITS (see
      // `initials.ts`: `letters.length >= MAX_INITIALS` calls `finish()`), so
      // the screen is already tearing down by the time the loop ends — reading
      // the slots afterwards reports an empty name for a turn that worked.
      let slots = '';
      for (const key of ['key:G', 'key:D', 'key:G']) {
        if (await dwell(key)) typed++;
        slots = (host.router.active?.letters ?? []).join('') || slots;
        if (id() !== 'initials') break;
        await settle();
      }
      step('three letters entered by dwell', typed === 3, `${typed}/3`);
      step('letters land in the slots', slots.length >= 2, slots || '(empty)');

      // Only needed when the screen did not already submit itself.
      if (id() === 'initials') {
        await dwell('key:OK');
        await run(900, (s) => s !== 'initials');
      }
      step('initials submits and exits', id() !== 'initials', `ended on ${id()}`);
    }

    // ── back to a rest state a stranger can walk up to ────────────────────
    await run(1800, (s) => s === 'attract' || s === 'menu');
    step('returns to attract or menu', id() === 'attract' || id() === 'menu', `ended on ${id()}`);

    step('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (err) {
    step('turn completed without throwing', false, String(err));
  } finally {
    console.error = origError;
    const cursor = host.router.active?.cursor;
    if (cursor) cursor.override = null;
    sim.setPump(0);
    sim.setSwipe(0);
  }

  return {
    game,
    passed: steps.every((s) => s.ok),
    steps,
    trail,
    score,
    errors,
  };
}

export function formatTurn(report: TurnReport): string {
  const lines: string[] = [];
  lines.push(
    `TURN ${report.passed ? 'PASS' : 'FAIL'}  ${report.total - report.failed}/${report.total} in ${report.durationMs}ms`
  );
  for (const r of report.results) {
    lines.push(`\n${r.passed ? 'ok  ' : 'FAIL'} ${r.game}   score=${r.score ?? '-'}`);
    lines.push(`     ${r.trail.join(' -> ')}`);
    for (const s of r.steps) {
      if (!s.ok) lines.push(`     x ${s.name}${s.detail ? `  (${s.detail})` : ''}`);
    }
  }
  return lines.join('\n');
}
