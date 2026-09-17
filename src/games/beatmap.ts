/**
 * RHYTHM PUNCH — the chart generator.
 *
 * PLAN.md §3 says beat maps come from "offline audio analysis (onset detection)
 * rather than hand-charting, so any CC0 track becomes a level". That premise
 * does not survive contact with this codebase: PLAN.md §5a and ARCHITECTURE.md
 * rule 2 forbid downloaded assets, and engine/audio.ts synthesises every sound
 * in the app. There is no audio file to analyse, and adding one would break a
 * hard rule to obtain a worse result.
 *
 * So the dependency is inverted. Rather than deriving a chart from audio, the
 * chart and the audio are both derived from ONE tempo/structure source — this
 * module's bar plan. The game drives its percussion from the same beat clock it
 * draws and scores against, which means audio/visual sync is not something we
 * measure and tune, it is true by construction. Onset detection can only ever
 * approach that.
 *
 * Everything here is pure and deterministic given a seed. No DOM, no canvas, no
 * imports at all — so the generator is unit-testable under `node --test`
 * (tests/beatmap.test.ts) and a given seed reproduces a byte-identical chart on
 * any machine, which is what makes a ghost or a replay possible later.
 *
 * THE THREE INVARIANTS. A generated chart must never be unfair, so the
 * generator refuses to emit:
 *
 *   1. Two notes for the SAME hand close enough that their timing windows
 *      overlap — the player could not tell which one they hit, and neither
 *      could the scorer.
 *   2. A punch inside a wall's duck window — you cannot duck and punch at once,
 *      and being asked to is the kind of unfairness a player reads as "the game
 *      is broken", not "I am bad at this".
 *   3. Anything at all before the lead-in, so no note ever arrives without
 *      having been telegraphed for a full bar first.
 *
 * `validateBeatmap` re-checks all three from the outside; the tests assert it
 * over hundreds of seeds.
 */

/* ------------------------------------------------------------------ */
/* Timing                                                              */
/* ------------------------------------------------------------------ */

export type Grade = 'perfect' | 'great' | 'good';

/**
 * Hit windows, in seconds either side of the beat.
 *
 * DELIBERATELY ENORMOUS by rhythm-game standards. Osu!'s hardest timing window
 * is ~20ms; ours is sixteen times that at its tightest. PLAN.md §1: this is a
 * stall game played once, for under a minute, by a stranger who will not read
 * anything. Three things set the floor:
 *
 *   - Inference runs at ~30fps, so the input is quantised to 33ms before any
 *     judgement happens.
 *   - The Runner measured 0.100s ± 0.001 of end-to-end detection latency
 *     (README), and that is a floor we cannot engineer away here.
 *   - One Euro filtering on the wrist adds phase lag on top of that.
 *
 * So the tightest window that is even measurable is ~0.15s, and a `perfect`
 * that a first-timer can never hit is not a grade, it is a taunt. 0.11s means
 * "you punched on the beat", 0.32s means "you punched at the right target and
 * roughly in time", and the gap between them is what the combo rewards.
 *
 * The wall window is wider again: a crouch is a whole-body move through a
 * hysteresis gate with a baseline, and it is physically slower to start and
 * slower to detect than a punch.
 */
export const TIMING = {
  perfect: 0.11,
  great: 0.2,
  good: 0.32,
  wall: 0.45,
} as const;

/** Points before the combo multiplier. */
export const GRADE_POINTS: Record<Grade, number> = {
  perfect: 100,
  great: 65,
  good: 35,
};

/** Weight toward the accuracy percentage. A miss contributes 0. */
export const GRADE_ACCURACY: Record<Grade, number> = {
  perfect: 1,
  great: 0.75,
  good: 0.45,
};

export const WALL_POINTS = 90;

/**
 * Timing grade for a signed offset from the note, or null if outside every
 * window. Shared by the game and the tests so "what counts as a hit" has
 * exactly one definition.
 */
export function gradeFor(deltaSeconds: number): Grade | null {
  const d = Math.abs(deltaSeconds);
  if (d <= TIMING.perfect) return 'perfect';
  if (d <= TIMING.great) return 'great';
  if (d <= TIMING.good) return 'good';
  return null;
}

/* ------------------------------------------------------------------ */
/* Playability constraints                                             */
/* ------------------------------------------------------------------ */

/**
 * Minimum separation between consecutive notes for the SAME hand, in beats.
 * One arm cannot be in two places at once, and at 126bpm two beats is 0.95s —
 * a comfortable punch-and-retract for someone who has never done this before.
 */
export const MIN_SAME_HAND_BEATS = 2;

/**
 * Minimum separation between a wall and any punch, in beats. Three beats
 * rather than two because the gap is doing double duty: it makes the pairing
 * physically possible, and the resulting hole in the chart is the telegraph
 * that a wall is coming.
 */
export const WALL_GUARD_BEATS = 3;

/** Ceiling on punches in one 4/4 bar — one per beat, alternating hands. */
export const MAX_PUNCHES_PER_BAR = 4;

/**
 * Both separations are also floored in SECONDS against the timing windows, so
 * the invariants survive someone changing the tempo. At 126bpm the beat-based
 * figure wins in both cases; at 220bpm the window-based one would.
 */
function separations(beatSeconds: number): {
  minSameHandSeconds: number;
  wallGuardSeconds: number;
} {
  return {
    // Two `good` windows plus slack: same-hand windows must never overlap.
    minSameHandSeconds: Math.max(MIN_SAME_HAND_BEATS * beatSeconds, TIMING.good * 2 + 0.08),
    // A duck window and a punch window must never overlap either.
    wallGuardSeconds: Math.max(WALL_GUARD_BEATS * beatSeconds, TIMING.wall + TIMING.good + 0.08),
  };
}

/* ------------------------------------------------------------------ */
/* Chart shape                                                         */
/* ------------------------------------------------------------------ */

export type Hand = 'left' | 'right';

/** How a bar is laid out. Named because the shapes have to be RECOGNISABLE. */
export type PatternName = 'single' | 'alternate' | 'double' | 'run';

export interface PunchNote {
  kind: 'punch';
  /** Index into `Beatmap.notes`. Assigned after the final sort. */
  id: number;
  /** Beats from chart start, including the lead-in. */
  beat: number;
  /** Seconds from chart start. */
  time: number;
  bar: number;
  hand: Hand;
  /** Lane-relative horizontal: -1 outer left, 0 centre, +1 outer right. */
  x: number;
  /** Strike height: 0 = high (shoulder), 1 = low (waist). */
  y: number;
  /** Discrete source of `x`: 0 inner, 1 mid, 2 outer. */
  col: number;
  /** Discrete source of `y`: 0 high, 1 low. */
  row: number;
  /** Part of a both-hands-at-once pair. Drawn linked. */
  double: boolean;
  pattern: PatternName;
}

export interface WallNote {
  kind: 'wall';
  id: number;
  beat: number;
  time: number;
  bar: number;
}

export type Note = PunchNote | WallNote;

export interface BarPlan {
  index: number;
  startBeat: number;
  startTime: number;
  /** 0..1, non-decreasing across the chart by construction. */
  difficulty: number;
  /** Punches the plan asked for. Non-decreasing across the chart. */
  targetPunches: number;
  /** Punches actually placed, after the wall guard and same-hand filters. */
  punches: number;
  pattern: PatternName;
  wall: boolean;
}

export interface Beatmap {
  seed: number;
  bpm: number;
  beatSeconds: number;
  beatsPerBar: number;
  barSeconds: number;
  leadInBeats: number;
  /** End of the last bar, in seconds. */
  durationSeconds: number;
  minSameHandSeconds: number;
  wallGuardSeconds: number;
  bars: BarPlan[];
  /** Sorted by time. `notes[i].id === i`. */
  notes: Note[];
}

export interface BeatmapOptions {
  seed: number;
  bpm?: number;
  bars?: number;
  beatsPerBar?: number;
  /** Silent beats before bar 0, so nothing ever arrives un-telegraphed. */
  leadInBeats?: number;
  /** Scales the difficulty ceiling. 1 = full ramp. */
  intensity?: number;
}

/* ------------------------------------------------------------------ */
/* Deterministic randomness                                            */
/* ------------------------------------------------------------------ */

/**
 * mulberry32. Chosen over the `Math.sin` hash used in geometry.ts because this
 * generator draws a few hundred values in sequence and needs them decorrelated;
 * the sin hash is fine for "jitter one radius" and visibly patterned when you
 * pull a stream from it.
 */
function makeRng(seed: number): () => number {
  let a = (Math.floor(Math.abs(seed)) ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The ramp. `t^0.6` is strictly increasing on [0,1], so bar difficulty is
 * monotonic by construction rather than by luck — the exponent only decides
 * how quickly the opening bars get out of the way.
 *
 * Deliberately concave (exponent < 1) rather than linear. A stall round is 60s
 * and the queue is watching: a linear ramp spends the first fifteen seconds at
 * one punch every two bars, which is long enough for the player to conclude the
 * game is slow and for the crowd to look away. This reaches a real rhythm by
 * about bar 3 and then spends most of the round in the interesting middle.
 */
function difficultyAt(index: number, bars: number, intensity: number): number {
  if (bars <= 1) return intensity;
  const t = index / (bars - 1);
  return Math.pow(t, 0.6) * intensity;
}

/** Punches a bar asks for. `round` is monotonic, so this ramps monotonically. */
function targetPunchesAt(difficulty: number): number {
  return 1 + Math.round(difficulty * (MAX_PUNCHES_PER_BAR - 1));
}

/** Bars between walls. Tightens as the chart builds. */
function wallGapBars(difficulty: number): number {
  return Math.round(8 - difficulty * 4);
}

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

interface BeatSlot {
  /** Beat within the bar. */
  beat: number;
  /** Both hands at once. */
  both: boolean;
  col: number;
  row: number;
}

/**
 * Beat positions and target columns for one bar.
 *
 * The column choices are the readability budget. A punch whose position is
 * random reads as noise at 3m; a run that sweeps outward and back reads as a
 * shape you can see coming, which is the entire pitch for this game in a loud
 * room (PLAN.md §3: "the rhythm is VISUAL").
 */
function slotsFor(
  pattern: PatternName,
  target: number,
  difficulty: number,
  rng: () => number
): BeatSlot[] {
  // Column range widens with difficulty: early bars stay near the chest where
  // nobody has to reach, later ones use the full span.
  const maxCol = difficulty < 0.35 ? 1 : 2;
  const pickCol = () => Math.floor(rng() * (maxCol + 1));
  const pickRow = () => (rng() < 0.3 + difficulty * 0.2 ? 1 : 0);

  switch (pattern) {
    case 'single':
      return [{ beat: 0, both: false, col: 1, row: 0 }];

    case 'double': {
      const beats = target >= 4 ? [0, 2] : [0];
      return beats.map((beat) => ({
        beat,
        both: true,
        // Both fists at the same column reads as one two-handed slam.
        col: Math.min(maxCol, 1 + (rng() < 0.5 ? 1 : 0)),
        row: pickRow(),
      }));
    }

    case 'run': {
      // Outward and back. The arc is the point.
      const arc = [0, 1, 2, 1];
      const row = pickRow();
      return [0, 1, 2, 3].map((beat, i) => ({
        beat,
        both: false,
        col: Math.min(maxCol, arc[i] ?? 1),
        row,
      }));
    }

    case 'alternate':
    default: {
      const beats = target >= 4 ? [0, 1, 2, 3] : target === 3 ? [0, 1, 2] : [0, 2];
      return beats.map((beat) => ({ beat, both: false, col: pickCol(), row: pickRow() }));
    }
  }
}

function pickPattern(target: number, rng: () => number): PatternName {
  if (target <= 1) return 'single';
  if (target === 2) return rng() < 0.3 ? 'double' : 'alternate';
  if (target === 3) return 'alternate';
  const r = rng();
  if (r < 0.35) return 'double';
  if (r < 0.7) return 'run';
  return 'alternate';
}

/** Discrete column/row to lane-relative offsets. */
function offsetX(hand: Hand, col: number): number {
  const magnitude = 0.22 + col * 0.29; // 0.22 / 0.51 / 0.80
  return hand === 'left' ? -magnitude : magnitude;
}

function offsetY(row: number): number {
  return row === 0 ? 0.25 : 0.7;
}

/**
 * Builds a chart.
 *
 * Two passes, in this order and for a reason: every wall is placed first, then
 * punches are offered to the chart and rejected if they would land inside a
 * wall's guard or too close to the previous note for the same hand. Generating
 * punches first and then trying to fit walls around them would mean either
 * dropping walls (the chart loses its structure) or moving them off the
 * downbeat (the chart loses its readability).
 *
 * The consequence is that bars near a wall hold fewer punches than they asked
 * for. That is not a defect — the resulting hole is what tells the player a
 * wall is coming.
 */
export function generateBeatmap(options: BeatmapOptions): Beatmap {
  const bpm = options.bpm ?? 126;
  const beatsPerBar = options.beatsPerBar ?? 4;
  const barCount = Math.max(1, Math.floor(options.bars ?? 32));
  const leadInBeats = options.leadInBeats ?? 6;
  const intensity = Math.max(0, Math.min(1, options.intensity ?? 1));

  const beatSeconds = 60 / bpm;
  const barSeconds = beatSeconds * beatsPerBar;
  const { minSameHandSeconds, wallGuardSeconds } = separations(beatSeconds);

  const rng = makeRng(options.seed);
  const timeOf = (beat: number) => (beat + leadInBeats) * beatSeconds;

  /* ---- pass 0: the bar plan ---- */

  const bars: BarPlan[] = [];
  let barsSinceWall = Number.POSITIVE_INFINITY;

  for (let i = 0; i < barCount; i++) {
    const difficulty = difficultyAt(i, barCount, intensity);
    const targetPunches = targetPunchesAt(difficulty);
    const pattern = pickPattern(targetPunches, rng);

    // Walls only once the player has had a few bars of punching, and never in
    // the final bar — a wall you have no time to recover from is a sour note
    // to end a round on.
    const eligible = difficulty >= 0.2 && i < barCount - 1;
    const wall = eligible && barsSinceWall >= wallGapBars(difficulty) && rng() < 0.8;
    barsSinceWall = wall ? 0 : barsSinceWall + 1;

    bars.push({
      index: i,
      startBeat: i * beatsPerBar,
      startTime: timeOf(i * beatsPerBar),
      difficulty,
      targetPunches,
      punches: 0,
      pattern,
      wall,
    });
  }

  /* ---- pass 1: walls ---- */

  const notes: Note[] = [];
  const wallTimes: number[] = [];

  for (const bar of bars) {
    if (!bar.wall) continue;
    const time = timeOf(bar.startBeat);
    wallTimes.push(time);
    notes.push({ kind: 'wall', id: -1, beat: bar.startBeat, time, bar: bar.index });
  }

  /* ---- pass 2: punches, filtered against the invariants ---- */

  const lastHandTime: Record<Hand, number> = {
    left: Number.NEGATIVE_INFINITY,
    right: Number.NEGATIVE_INFINITY,
  };
  // Alternating by default is what makes a chart feel like boxing rather than
  // like a list. The generator only breaks alternation for doubles.
  let nextHand: Hand = rng() < 0.5 ? 'left' : 'right';

  const clearsWalls = (time: number) => {
    for (const wt of wallTimes) {
      if (Math.abs(time - wt) < wallGuardSeconds - 1e-9) return false;
    }
    return true;
  };

  for (const bar of bars) {
    const slots = slotsFor(bar.pattern, bar.targetPunches, bar.difficulty, rng);

    for (const slot of slots) {
      const beat = bar.startBeat + slot.beat;
      const time = timeOf(beat);
      if (!clearsWalls(time)) continue;

      const hands: Hand[] = slot.both ? ['left', 'right'] : [nextHand];

      // A double is all-or-nothing: half a double is just a punch in a
      // confusing place.
      const ok = hands.every((h) => time - lastHandTime[h] >= minSameHandSeconds - 1e-9);
      if (!ok) continue;

      for (const hand of hands) {
        lastHandTime[hand] = time;
        notes.push({
          kind: 'punch',
          id: -1,
          beat,
          time,
          bar: bar.index,
          hand,
          x: offsetX(hand, slot.col),
          y: offsetY(slot.row),
          col: slot.col,
          row: slot.row,
          double: slot.both,
          pattern: bar.pattern,
        });
        bar.punches++;
      }

      if (!slot.both) nextHand = nextHand === 'left' ? 'right' : 'left';
    }
  }

  /* ---- sort and number ---- */

  notes.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    // Walls first at a tie, then left before right, so the order is total and
    // therefore stable across engines.
    if (a.kind !== b.kind) return a.kind === 'wall' ? -1 : 1;
    if (a.kind === 'punch' && b.kind === 'punch') return a.hand === b.hand ? 0 : a.hand === 'left' ? -1 : 1;
    return 0;
  });
  for (let i = 0; i < notes.length; i++) notes[i]!.id = i;

  return {
    seed: options.seed,
    bpm,
    beatSeconds,
    beatsPerBar,
    barSeconds,
    leadInBeats,
    durationSeconds: timeOf(barCount * beatsPerBar),
    minSameHandSeconds,
    wallGuardSeconds,
    bars,
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export interface BeatmapProblem {
  /** Note id the problem is reported against, or -1 for a whole-chart issue. */
  id: number;
  reason: string;
}

/**
 * Re-derives the three invariants from the finished chart.
 *
 * Deliberately independent of the generator's internals — it reads only the
 * emitted notes. A generator bug that silently stopped applying a filter would
 * otherwise pass every test that shared its code path.
 */
export function validateBeatmap(map: Beatmap): BeatmapProblem[] {
  const problems: BeatmapProblem[] = [];
  const lastHandTime: Record<Hand, number> = {
    left: Number.NEGATIVE_INFINITY,
    right: Number.NEGATIVE_INFINITY,
  };
  const walls = map.notes.filter((n): n is WallNote => n.kind === 'wall');
  const leadIn = map.leadInBeats * map.beatSeconds;

  let prevTime = Number.NEGATIVE_INFINITY;

  for (const note of map.notes) {
    if (note.time < prevTime - 1e-9) problems.push({ id: note.id, reason: 'notes are not sorted by time' });
    prevTime = note.time;

    if (note.time < leadIn - 1e-9) {
      problems.push({ id: note.id, reason: `arrives at ${note.time.toFixed(3)}s, inside the lead-in` });
    }

    if (note.kind === 'wall') continue;

    if (note.time - lastHandTime[note.hand] < map.minSameHandSeconds - 1e-9) {
      problems.push({
        id: note.id,
        reason: `${note.hand} hand asked for two notes ${(
          note.time - lastHandTime[note.hand]
        ).toFixed(3)}s apart (min ${map.minSameHandSeconds.toFixed(3)}s)`,
      });
    }
    lastHandTime[note.hand] = note.time;

    for (const wall of walls) {
      const gap = Math.abs(note.time - wall.time);
      if (gap < map.wallGuardSeconds - 1e-9) {
        problems.push({
          id: note.id,
          reason: `punch is ${gap.toFixed(3)}s from the wall at ${wall.time.toFixed(3)}s (min ${map.wallGuardSeconds.toFixed(3)}s)`,
        });
      }
    }

    if (note.x < -1 || note.x > 1) problems.push({ id: note.id, reason: `x ${note.x} out of lane` });
    if (note.y < 0 || note.y > 1) problems.push({ id: note.id, reason: `y ${note.y} out of strike zone` });
  }

  for (const bar of map.bars) {
    if (bar.punches > MAX_PUNCHES_PER_BAR) {
      problems.push({ id: -1, reason: `bar ${bar.index} holds ${bar.punches} punches` });
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ */
/* Read-back helpers                                                   */
/* ------------------------------------------------------------------ */

/** Fractional beat at a chart time, including the lead-in. */
export function beatAt(map: Beatmap, seconds: number): number {
  return seconds / map.beatSeconds - map.leadInBeats;
}

/** Notes per second across the whole chart. Used for density assertions. */
export function noteDensity(map: Beatmap): number {
  return map.notes.length / Math.max(1e-6, map.durationSeconds);
}

/**
 * The hand a given SLOT must punch a note with.
 *
 * 2P is mirrored (PLAN.md §3: "mirrored lanes, side by side"), and mirroring
 * has to be total: the lane geometry flips AND the hand flips with it. Flipping
 * only the geometry would put player two's left-hand target on their right,
 * which destroys the one piece of information this game cannot afford to lose —
 * that the target's side of the screen tells you which fist to use.
 *
 * The visible result is two people punching in mirror image, which is also the
 * best thing to watch from the queue.
 */
export function handForSlot(note: PunchNote, slot: number): Hand {
  if (slot % 2 === 0) return note.hand;
  return note.hand === 'left' ? 'right' : 'left';
}

/** Lane-relative x for a slot, mirrored to match `handForSlot`. */
export function laneXForSlot(note: PunchNote, slot: number): number {
  return slot % 2 === 0 ? note.x : -note.x;
}
