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
import { tunables } from '../meta/tunables';

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
  /** How many seats the live round actually opened. See the 2P pass. */
  playerCount?: number;
  scoreFor?: (slot: number) => number;
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
  setWristTargetAll?: (side: 'left' | 'right', target: { x: number; y: number } | null) => void;
  /** Hold or release a crouch. Drives Rhythm's duck and the Runner's slide. */
  setCrouch?: (on: boolean) => void;
}

/**
 * How each game is played well enough to finish a round and score.
 *
 * Open-loop where mashing IS competent play, closed-loop where it is not.
 * Red Light and Pose Match both score zero against a flailing or motionless
 * body — correctly — so a turn driven that way never earns a leaderboard place
 * and never exercises the initials screen, which is half of what this sweep is
 * for. These mirror the drivers in `smoke.ts`, and `tests/probes.test.ts`
 * now ENFORCES that rather than asking. The instruction used to be a comment
 * saying "keep the two in step", and they drifted the first time one was
 * touched: teaching the smoke probe to duck Rhythm's walls changed nothing,
 * because `turn()` runs this copy, and the sweep meant to prove the fix kept
 * reporting zero ducks.
 */
const PLAY: Record<string, (s: SimLike) => void> = {
  sixtyseven: (s) => s.setPump(4.5, 1),
  fruitninja: (s) => s.setSwipe(2.2, 0.75),
  balloonpop: (s) => s.setPump(1.4, 1),
  redlight: (s) => s.setPump(0),
  posematch: (s) => s.setPoseAll(null),
  rhythm: (s) => s.clearWristTargets?.(),
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
    const g = game as { light?: string; state?: string } | null;
    // ONLY ONCE THE ROUND IS RUNNING. The light reads 'green' during the lobby
    // and the countdown too, so driving off it alone pumped hard for the whole
    // ten-second lobby — and that is exactly when Red Light measures the room's
    // noise floor. The floor then learned a flailing body, the threshold landed
    // above real movement, and the race crawled to 10% of the track in a full
    // round. A person waiting for the countdown is not racing yet.
    const racing = g?.state === 'playing';
    s.setPump(racing && g?.light === 'green' ? 5 : 0, 1);
  },
  // Punch the notes the chart is asking for. Waving both fists across the grid
  // used to score, and no longer does — at the measured hit radius a flailing
  // player scores 284 against an aiming player's 2425, which is the whole point
  // of that change. Between notes the fists retract, which is what arms the
  // anti-passive gate: it requires a hand to ARRIVE from outside the ring.
  rhythm: (s, game) => {
    const g = game as {
      state?: string;
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
    // ONLY ONCE THE ROUND IS RUNNING. `turn()` starts driving the moment the
    // game mounts, so this also runs through the lobby and countdown — where
    // the note runtime does not exist yet and `status[0]` threw, killing the
    // whole turn. The same shape of mistake as driving Red Light off a light
    // that reads green before the round has started.
    if (g?.state !== 'playing') return;
    const rest = { left: { x: 0.38, y: 0.75 }, right: { x: 0.62, y: 0.75 } };
    const notes = g?.debug?.().notes ?? [];

    // AND IT HAS TO DUCK. Walls are one of this game's two scoring paths and
    // both drivers only ever punched. FOUND BY COUNTING AUDIO CUES over a full
    // seven-game sweep: `wallhit` played 15 times and `duck` ZERO, so the
    // simulated player hit every wall in the chart and cleared none, while
    // every check stayed green.
    //
    // `isCrouching` is the HELD state rather than the edge, so a duck started
    // early and held through the wall counts — which the game's own comment
    // says is what everyone does the first time.
    const wall = notes.find(
      (x) => x.kind === 'wall' && x.status?.[0] === 'live' && x.delta > -0.35 && x.delta < 0.6
    );
    s.setCrouch?.(!!wall);

    for (const hand of ['left', 'right'] as const) {
      const n = notes.find(
        (x) =>
          x.kind === 'punch' &&
          x.hands?.[0] === hand &&
          x.status?.[0] === 'live' &&
          x.delta > -0.15 &&
          x.delta < 0.5
      );
      s.setWristTargetAll?.(hand, n?.target?.[0] ?? rest[hand]);
    }
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

/**
 * The games that seat two, run a SECOND time with two bodies in frame.
 *
 * Every one of these was shipped two-player and never driven by a second body
 * in any harness, which is how Red Light came to give six people one score and
 * Pose Match's two walls came to punch holes in each other. The 1P pass cannot
 * see any of it: the code paths that break are the ones guarded by
 * `playerCount > 1`.
 *
 * Red Light is absent because its own pass runs three bodies AND picks ALL OF
 * US on the mode screen. It used to put the bodies in frame and then choose
 * JUST ME, so the three were present and only one of them was playing.
 */
const VERSUS_GAMES = ['sixtyseven', 'fruitninja', 'balloonpop', 'posematch', 'rhythm', 'runner'];

/** A turn that has not finished in three minutes of game time is a stall. */
const MAX_TURN_FRAMES = 60 * 180;

export async function runTurn(host: Host, only?: string[]): Promise<TurnReport> {
  const started = performance.now();
  const games = only?.length ? GAMES.filter((g) => only.includes(g as string)) : GAMES;
  const results: TurnResult[] = [];

  // FAIR MODE OFF FOR THE DURATION, AND PUT BACK AFTERWARDS.
  //
  // `shell.menuSize` hides all but the first N games, and this probe reaches
  // every game by hovering its MENU TILE. With the setting left at 4 the sweep
  // reported six failures reading "never reached the game" for balloonpop,
  // posematch and rhythm — which is not a bug, it is the feature working, but
  // it looks exactly like three games being broken and it cost a real
  // investigation to find out otherwise.
  //
  // A marshal is expected to leave this set between rushes, and the setting
  // persists to localStorage, so the next person to run a sweep would hit the
  // same wall. The probe tests the SHELL, not the roster on offer.
  const prevMenuSize = tunables.get('shell.menuSize', 0);
  tunables.set('shell.menuSize', 0);

  try {
    for (const game of games) {
      results.push(await oneTurn(host, game as string, 1));
      if (VERSUS_GAMES.includes(game as string)) {
        results.push(await oneTurn(host, game as string, 2));
      }
    }
  } finally {
    tunables.set('shell.menuSize', prevMenuSize);
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

async function oneTurn(host: Host, game: string, players = 1): Promise<TurnResult> {
  const label = players > 1 ? `${game} (${players}P)` : game;
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
    sim.setPlayerCount(players > 1 ? players : game === 'redlight' ? 3 : 1);

    // ── attract ──────────────────────────────────────────────────────────
    host.router.go('attract');
    await settle();
    note();
    await run(900, (s) => s === 'menu');
    step('attract promotes to menu on a body', id() === 'menu', `ended on ${id()}`);

    // ── menu: select the tile with the real dwell cursor ──────────────────
    await settle();
    const picked = await dwell(game);
    await run(240, (s) => s === game || s === 'mode');
    step('menu tile selects by dwell', id() === game || id() === 'mode', `picked=${picked} ended on ${id()}`);

    // ── "how many playing?", for every game that seats more than one ──────
    //
    // Driven rather than waited out. The screen answers itself after
    // DEFAULT_SEC, so a sweep that just ticked would pass without ever
    // exercising the dwell — and the dwell is the whole screen. The pass picks
    // the mode it is actually testing, which is also how the 2P sweep proves
    // that choosing VERSUS with two bodies really opens two seats.
    if (id() === 'mode') {
      await settle();
      // RED LIGHT'S HEADLINE MODE IS THE PARTY ONE, so ask for it.
      //
      // The sweep already puts THREE bodies in frame for Red Light (see
      // `setPlayerCount` above) and then picked JUST ME, which locks the round
      // to one player with two strangers standing in it. So the game the stall
      // is most social with — five people, one set of lanes, per-lane scoring,
      // `<FINAL STANDINGS>` at the end — ran solo in every automated check ever
      // made of it.
      //
      // FOUND BY COUNTING never-drawn strings: `<FINAL STANDINGS>` appeared
      // zero times across a full seven-game sweep, and the solo near-miss line
      // `1 OFF SEVENTH` appeared instead, which is what gave it away.
      const card = players > 1 || game === 'redlight' ? 'mode:open' : 'mode:solo';
      const mode = await dwell(card);
      step('mode card selects by dwell', mode, `${card}: ${mode ? 'committed' : 'timed out'}`);
      await run(300, (s) => s === game);
    }

    if (!step('reaches the game', id() === game, `ended on ${id()}`)) {
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

    // ── two seats, two scores ────────────────────────────────────────────
    //
    // Only meaningful while the game screen is still up: `results` still has
    // `playerCount` and `scoreFor`, `initials` and `attract` do not.
    if (players > 1 && landed === 'results') {
      const seated = played?.playerCount ?? 0;
      step('opened two seats', seated === 2, `playerCount=${seated}`);

      const a = played?.scoreFor?.(0);
      const b = played?.scoreFor?.(1);
      step(
        'both seats have a real score',
        Number.isFinite(a) && Number.isFinite(b) && (a ?? -1) >= 0 && (b ?? -1) >= 0,
        `slot0=${a} slot1=${b}`
      );
      // The failure this is really for: `scoreFor` ignoring its argument, which
      // is what Red Light shipped and what nothing but a second body can see.
      // Both bodies are driven identically by the simulator, so equal scores
      // are expected — what is NOT acceptable is a second seat stuck at zero
      // while the first one scored.
      step(
        'the second seat is not dead',
        !((a ?? 0) > 0 && (b ?? 0) === 0),
        `slot0=${a} slot1=${b}`
      );
    }

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
    game: label,
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
