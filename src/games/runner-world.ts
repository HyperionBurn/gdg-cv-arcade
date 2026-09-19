/**
 * RUNNER — the 3D world, the track generator, and the clearability validator.
 *
 * PLAN.md §3: "The only genuine 3D game on the roster. Three.js, but fully
 * procedural geometry — no downloaded models. Neon/Tron aesthetic: glowing
 * wireframe track, emissive obstacles, particle speed lines, all BufferGeometry
 * built at runtime."
 *
 * PLAN.md §5a: everything in this file is generated in code. There is no GLTF,
 * no texture, no asset pack, nothing to license and nothing to load. Every
 * colour resolves through shell/theme.ts, so the GDG palette swap is one file.
 * That half of the brief is untouched — the geometry is still 100% procedural.
 *
 * ============================ THE NEON IS GONE ============================
 * The "neon/Tron aesthetic" half of that quote is superseded by the GDG brand
 * kit (BRAND.md, design/DESIGN.md). The background is paper now, and neon is a
 * technique for dark backgrounds only. Three things followed from that, and all
 * three were silently drawing NOTHING before they were converted:
 *
 *  1. ADDITIVE BLENDING IS A NO-OP ON WHITE. `AdditiveBlending` saturates to
 *     white against a white clear colour, so the player core, every obstacle
 *     body, every obstacle mark, the trail and 170 speed streaks were each
 *     costing a full draw and contributing zero pixels. They are now opaque
 *     MeshBasicMaterial. The streaks are deleted outright — 170 lines that
 *     cannot be seen, updated per frame, is pure cost, and a blizzard of flying
 *     lines is the opposite of the brand's 70% paper anyway.
 *  2. THE BLOOM PASS IS DELETED. It was a `globalCompositeOperation='lighter'`
 *     blit of a blurred downsample — the same no-op on white — and DESIGN.md
 *     bans blur outright. It is gone, not converted.
 *  3. FOG IS DELETED. `THREE.Fog` lerps a material's colour toward the fog
 *     colour with distance, which is precisely the "tint of a brand colour"
 *     DESIGN.md forbids, and against paper it made every obstacle a wash of
 *     pale blue-green. Objects now hold their flat colour to the draw limit.
 *
 * The look is now: paper background, an ink-and-grey ruled track, and obstacles
 * and player drawn as STICKERS — flat brand fill, hard ink outline. WebGL
 * ignores `linewidth`, so the outlines are inverted-hull shells (a slightly
 * larger `BackSide` mesh in ink) rather than `LineSegments`: that is the only
 * way to get an outline with real weight on a TV read from three metres, and it
 * is still MeshBasicMaterial with no lights and no post-processing.
 * ==========================================================================
 *
 * Three things live here:
 *
 *  1. THE MODEL — lane/obstacle geometry constants and the timing model of what
 *     a human can physically clear. The game and the validator share it, so the
 *     two can never drift apart.
 *
 *  2. THE GENERATOR — appends rows of obstacles with a difficulty curve, and
 *     proves each row is clearable BEFORE committing it. A segment that cannot
 *     be cleared is not "hard", it is a bug that reads to the player as the
 *     game cheating, and at a stall nobody gets a second run to find out
 *     otherwise.
 *
 *  3. THE WORLD — the Three.js scene, pooled obstacle meshes, the camera
 *     spring, and disposal. The renderer draws to its OWN canvas which the game
 *     then blits under the 2D HUD; main.ts still owns the only rAF.
 *
 * Perf notes, because this runs next to MediaPipe for four hours:
 *   - every material is MeshBasicMaterial / LineBasicMaterial. No lights, no
 *     shadow maps, no lighting maths at all, and no post-processing.
 *   - obstacle meshes are pooled and recycled, never created per row.
 *   - geometries and materials are shared per obstacle kind.
 *   - the visible row window is capped; the scroll grid is one static geometry
 *     translated per frame rather than rebuilt.
 */

import * as THREE from 'three';
import { tunables } from '../meta/tunables';
import { COLORS } from '../shell/theme';

/* ------------------------------------------------------------------ */
/* The model                                                           */
/* ------------------------------------------------------------------ */

export const LANE_COUNT = 3;
/** Metres between lane centres. */
export const LANE_WIDTH = 2.4;
/** World x of lane -1, 0, 1. Index with `lane + 1`. */
export const LANE_X: readonly number[] = [-LANE_WIDTH, 0, LANE_WIDTH];
export const HALF_TRACK = LANE_WIDTH * 1.5;

/** Player capsule half-width in metres. */
export const PLAYER_HALF_W = 0.6;
/** Player half-depth along the track. */
export const PLAYER_HALF_D = 0.4;
export const STAND_HEIGHT = 1.75;
export const CROUCH_HEIGHT = 0.85;

/** One obstacle cell is slightly narrower than its lane, so a clean dodge reads as clean. */
export const OBSTACLE_HALF_W = LANE_WIDTH * 0.43;
export const OBSTACLE_HALF_D = 0.6;

/**
 * Top of a low barrier. Feet must be above this to clear it.
 *
 * Knee-high rather than waist-high, deliberately. Together with the jump arc
 * below it sets how many seconds of slack the player has to time a jump, and
 * measured against the simulator a waist-high barrier left a 0.24s window —
 * far too tight once ~0.1s of pose-detection latency is subtracted from it.
 * See the jump-window sweep in the notes on this game.
 */
export const LOW_TOP = 0.85;
/** Bottom of a high barrier. The head must be below this to clear it. */
export const HIGH_BOTTOM = 1.5;
export const HIGH_TOP = 3.1;
export const BLOCK_TOP = 2.7;

/**
 * Scripted jump arc. The gesture only fires the launch; the game owns the arc.
 *
 * Long and floaty on purpose. Air time IS the forgiveness budget: every extra
 * 100ms of hang widens the window in which a mistimed jump still clears, and
 * pose detection spends ~100ms of that budget before the game even knows the
 * player left the ground.
 */
export const JUMP_DURATION = 0.78;
export const JUMP_APEX = 2.1;
/** Scripted slide. A held crouch extends it; a twitchy one still clears. */
export const SLIDE_DURATION = 0.78;

/**
 * Speed. PLAN.md §3: "distance, with a speed ramp."
 *
 * The clock ramps a BASE speed; how cleanly you play multiplies it. That
 * multiplier is the whole scoring design. Measured against the simulator, a
 * purely time-based ramp gave a player who did nothing at all 888m and a
 * flawless player 1014m — a 14% spread, which makes a leaderboard meaningless
 * and makes "2 OFF THIRD" noise. With momentum in, doing nothing lands around
 * 420m and a clean run around 1000m.
 *
 * The base ramp is deliberately modest and the momentum range wide, because
 * the spread between a great run and a run where the player did nothing IS the
 * leaderboard. At a narrow momentum range that spread was 692m vs 897m — doing
 * nothing scored 77% of a flawless run, which makes every score look the same.
 *
 * `MAX_SPEED` is derived, not typed: it is the fastest the game can possibly
 * run, and it is what the clearability model validates against. Deriving it
 * means no tuning pass can quietly let the player outrun the proof.
 */
export const START_SPEED = 8;
/** Base speed once the clock ramp is complete, before momentum. */
export const RAMP_SPEED = 12;
export const SPEED_RAMP_SEC = 48;

/** Momentum multiplier bounds. 1.0 is "no streak, no penalty". */
export const MOMENTUM_FLOOR = 0.38;
export const MOMENTUM_MAX = 1.74;

export const MAX_SPEED = RAMP_SPEED * MOMENTUM_MAX;

/** Where the first obstacle can appear. ~4s of clear track to read the screen. */
export const FIRST_ROW_Z = 44;
/** Generate this far ahead of the player. */
export const GENERATE_AHEAD = 260;
/** Rows further back than this are recycled. */
export const RECYCLE_BEHIND = 14;
/** Fog swallows everything past here, so this is the real draw budget. */
export const VIEW_DISTANCE = 150;

/** Height of the jump arc at normalised time `s` in [0, 1]. */
export function jumpHeight(s: number): number {
  if (s <= 0 || s >= 1) return 0;
  return 4 * JUMP_APEX * s * (1 - s);
}

/**
 * Fraction of the jump during which the feet are above a low barrier.
 *
 * Solved from the arc rather than typed in, so changing JUMP_APEX or LOW_TOP
 * can never silently desync the generator's feasibility proof from the actual
 * collision test.
 */
function solveJumpClearWindow(): { from: number; to: number } {
  const k = LOW_TOP / (4 * JUMP_APEX); // need s(1-s) > k
  const disc = 1 - 4 * k;
  if (disc <= 0) return { from: 0.5, to: 0.5 };
  const root = Math.sqrt(disc);
  return { from: (1 - root) / 2, to: (1 + root) / 2 };
}

export const JUMP_CLEAR = solveJumpClearWindow();

export type ObstacleKind = 'low' | 'high' | 'block';

export interface ObstacleCell {
  /** -1, 0 or 1. */
  lane: number;
  kind: ObstacleKind;
  /** Set when the player smashes through it, so the world stops drawing it. */
  destroyed: boolean;
}

export interface TrackRow {
  id: number;
  /** Track distance in metres of the row centre. */
  z: number;
  cells: ObstacleCell[];
  /** Collision/near-miss already settled for this row. */
  resolved: boolean;
  /**
   * 0..1 "how close was that". Measured at the instant the row centre passes
   * the player and consumed when the row is retired, so a hit on the way out
   * can still cancel the bonus.
   */
  closeness: number;
  /** Difficulty at generation time, purely for debugging/telemetry. */
  difficulty: number;
}

export function makeRow(id: number, z: number, difficulty = 0): TrackRow {
  return { id, z, cells: [], resolved: false, closeness: 0, difficulty };
}

export function cellAt(row: TrackRow, lane: number): ObstacleCell | null {
  for (const c of row.cells) if (c.lane === lane) return c;
  return null;
}

/** Top of the solid part of an obstacle, for the collision test and the mesh. */
export function obstacleSpan(kind: ObstacleKind): { bottom: number; top: number } {
  switch (kind) {
    case 'low':
      return { bottom: 0, top: LOW_TOP };
    case 'high':
      return { bottom: HIGH_BOTTOM, top: HIGH_TOP };
    case 'block':
      return { bottom: 0, top: BLOCK_TOP };
  }
}

/* ------------------------------------------------------------------ */
/* Clearability                                                        */
/* ------------------------------------------------------------------ */

export interface ClearanceModel {
  /** Worst case — validating at top speed makes every earlier moment easier. */
  maxSpeed: number;
  /** Seconds a real body takes to step one lane across. */
  laneStepTime: number;
  jumpDuration: number;
  jumpClearFrom: number;
  jumpClearTo: number;
  slideDuration: number;
  /**
   * Dead time after an action before the body can start the next one.
   *
   * Covers the ~100ms of pose-detection latency measured against the simulator
   * plus human reaction. Without it the DP happily plans a landing and a
   * re-jump in the same millisecond, and calls a track clearable that no actual
   * person could clear.
   */
  recoveryTime: number;
  /** Half the z-overlap between the player and an obstacle, in metres. */
  crossHalfDepth: number;
}

/**
 * The clearance model with the operator's overrides applied.
 *
 * The generator's unclearability proof is exact at the MODELLED body and no
 * further: re-validated against a body 20% slower, 143 of 200 generated runs
 * became unclearable. So these two constants are the difference between a fair
 * track and an impossible one for whoever is actually standing there.
 */
export function liveClearance(): ClearanceModel {
  return {
    ...DEFAULT_CLEARANCE,
    laneStepTime: tunables.get('runner.laneStepTime', DEFAULT_CLEARANCE.laneStepTime),
    recoveryTime: tunables.get('runner.recoveryTime', DEFAULT_CLEARANCE.recoveryTime),
  };
}

export const DEFAULT_CLEARANCE: ClearanceModel = {
  maxSpeed: MAX_SPEED,
  // Deliberately much slower than the game's own lane lerp. The constraint is
  // a stranger stepping sideways in front of a camera in a crowded hall, plus
  // the detector's hysteresis, not the tween. Re-validating generated track
  // against a harsher model than it planned with is the only way to find out
  // how much margin there is, and at 0.34 there was almost none — a third of
  // runs contained a segment a slightly slower body could not clear.
  laneStepTime: 0.5,
  jumpDuration: JUMP_DURATION,
  jumpClearFrom: JUMP_CLEAR.from,
  jumpClearTo: JUMP_CLEAR.to,
  slideDuration: SLIDE_DURATION,
  recoveryTime: 0.36,
  crossHalfDepth: OBSTACLE_HALF_D + PLAYER_HALF_D,
};

/**
 * Earliest time the body is free again, per lane. `Infinity` = lane unreachable.
 * Index with `lane + 1`.
 */
export type LaneStates = readonly [number, number, number];

export const INITIAL_STATES: LaneStates = [0, 0, 0];

/**
 * One step of the feasibility DP.
 *
 * A player arriving at a row can be in any lane they had time to reach, and
 * must be free to perform whatever that lane demands. Modelling "the body can
 * only do one thing at a time" is what stops the generator emitting a
 * jump-immediately-followed-by-a-two-lane-step that looks fine on paper and is
 * physically impossible in front of a webcam.
 *
 * @returns the state set after the row. All-Infinity means unclearable.
 */
export function stepStates(
  prev: LaneStates,
  row: TrackRow,
  model: ClearanceModel = DEFAULT_CLEARANCE
): LaneStates {
  const v = model.maxSpeed;
  const t = row.z / v;
  const cross = model.crossHalfDepth / v;
  const next: [number, number, number] = [Infinity, Infinity, Infinity];

  for (let a = 0; a < LANE_COUNT; a++) {
    const free = prev[a]!;
    if (!Number.isFinite(free)) continue;

    for (let b = 0; b < LANE_COUNT; b++) {
      const laneEnd = free + Math.abs(a - b) * model.laneStepTime;
      // Must be settled in the destination lane before the body overlaps the row.
      if (laneEnd > t - cross) continue;

      const cell = cellAt(row, b - 1);
      // The body is committed to this lane for the whole crossing, so nothing
      // can start before the row is behind it. Omitting this let a track pass
      // validation that demanded a two-lane step inside a 70ms gap: the DP
      // happily started the step before the player had reached the first row.
      let after = t + cross;

      if (cell === null) {
        // Nothing to do here beyond being in the lane in time.
      } else if (cell.kind === 'block') {
        continue;
      } else {
        const dur = cell.kind === 'low' ? model.jumpDuration : model.slideDuration;
        const f0 = cell.kind === 'low' ? model.jumpClearFrom : 0;
        const f1 = cell.kind === 'low' ? model.jumpClearTo : 1;
        // An action launched at L clears [L + f0*dur, L + f1*dur]. That window
        // must cover the whole crossing [t - cross, t + cross].
        const latestLaunch = t - cross - f0 * dur;
        const earliestLaunch = t + cross - f1 * dur;
        const launch = Math.max(laneEnd, earliestLaunch);
        if (launch > latestLaunch) continue;
        after = Math.max(after, launch + dur + model.recoveryTime);
      }

      if (after < next[b]!) next[b] = after;
    }
  }

  return next;
}

export function statesAlive(s: LaneStates): boolean {
  return Number.isFinite(s[0]) || Number.isFinite(s[1]) || Number.isFinite(s[2]);
}

export interface ValidationResult {
  ok: boolean;
  /** Index of the first row that could not be cleared, or -1. */
  failedIndex: number;
  rowsChecked: number;
}

/**
 * Proves a whole generated track is clearable from a standing start in lane 0.
 *
 * The generator already guarantees this by construction; this exists so the
 * guarantee can be asserted from outside, over many thousands of rows, without
 * trusting the generator's own bookkeeping.
 */
export function validateRows(
  rows: readonly TrackRow[],
  model: ClearanceModel = DEFAULT_CLEARANCE
): ValidationResult {
  let states: LaneStates = INITIAL_STATES;
  for (let i = 0; i < rows.length; i++) {
    states = stepStates(states, rows[i]!, model);
    if (!statesAlive(states)) return { ok: false, failedIndex: i, rowsChecked: i + 1 };
  }
  return { ok: true, failedIndex: -1, rowsChecked: rows.length };
}

/* ------------------------------------------------------------------ */
/* Generator                                                           */
/* ------------------------------------------------------------------ */

/** mulberry32 — seedable so a failing track can be reproduced exactly. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS: readonly ObstacleKind[] = ['low', 'high', 'block'];

export interface GeneratorOptions {
  seed?: number;
  model?: ClearanceModel;
  /** Distance over which difficulty ramps to full. */
  rampMetres?: number;
}

/**
 * Appends obstacle rows ahead of the player, refusing to commit any row that
 * would make the track unclearable.
 *
 * Difficulty ramps with distance: gaps tighten, single obstacles give way to
 * two-lane gates and full-width sweeps. But the feasibility DP runs on every
 * candidate, so "harder" only ever means "less slack", never "impossible".
 */
export class TrackGenerator {
  private rng: () => number;
  private states: LaneStates = INITIAL_STATES;
  private nextZ = FIRST_ROW_Z;
  private nextId = 1;
  private model: ClearanceModel;
  private ramp: number;

  /** Diagnostics — how often the feasibility check saved us. */
  rejected = 0;
  /** How often a row had to be pushed further out to stay clearable. */
  pushed = 0;

  constructor(opts: GeneratorOptions = {}) {
    this.rng = makeRng(opts.seed ?? Math.floor(Math.random() * 0xffffffff));
    this.model = opts.model ?? liveClearance();
    this.ramp = opts.rampMetres ?? 750;
  }

  reset(seed?: number): void {
    if (seed !== undefined) this.rng = makeRng(seed);
    this.states = INITIAL_STATES;
    this.nextZ = FIRST_ROW_Z;
    this.nextId = 1;
    this.rejected = 0;
    this.pushed = 0;
  }

  get lastZ(): number {
    return this.nextZ;
  }

  private difficultyAt(z: number): number {
    return Math.max(0, Math.min(1, z / this.ramp));
  }

  /** Builds one candidate row. Purely random; feasibility is checked after. */
  private candidate(z: number, diff: number): TrackRow {
    const row = makeRow(this.nextId, z, diff);

    // A breather row. Early on these are frequent, which is what lets a first
    // time player work out what the lanes even are.
    const emptyChance = 0.3 - diff * 0.22;
    if (this.rng() < emptyChance) return row;

    const r = this.rng();
    const doubleChance = 0.22 + diff * 0.34;
    const sweepChance = diff * 0.22;

    if (r < sweepChance) {
      // Full-width sweep — one action clears the whole track. Reads brilliantly
      // from 3m because the entire screen tells you to do one thing.
      const kind: ObstacleKind = this.rng() < 0.55 ? 'low' : 'high';
      for (let lane = -1; lane <= 1; lane++) {
        row.cells.push({ lane, kind, destroyed: false });
      }
      return row;
    }

    if (r < sweepChance + doubleChance) {
      // Two lanes blocked, one free.
      const freeLane = Math.floor(this.rng() * 3) - 1;
      for (let lane = -1; lane <= 1; lane++) {
        if (lane === freeLane) continue;
        row.cells.push({ lane, kind: this.pickKind(diff), destroyed: false });
      }
      return row;
    }

    // Single obstacle.
    const lane = Math.floor(this.rng() * 3) - 1;
    row.cells.push({ lane, kind: this.pickKind(diff), destroyed: false });
    return row;
  }

  private pickKind(diff: number): ObstacleKind {
    // Blockers are the easiest to read, so they carry the early game. Slides
    // are the hardest gesture to get right, so they arrive last.
    const r = this.rng();
    if (r < 0.42 - diff * 0.12) return 'block';
    // The Sept 21 go/no-go lever. If first-timers can't land the jump, drop
    // this toward 0.42 and the Runner ships as lanes + slides with no other
    // change — see README "Runner go/no-go".
    const lowBandTop = tunables.get('runner.lowBandTop', 0.75);
    if (r < lowBandTop - diff * 0.06) return 'low';
    return 'high';
  }

  private gapFor(diff: number): number {
    // Gaps are authored in SECONDS AT TOP SPEED and converted to metres. That
    // means the same track is automatically roomier at the start of a round
    // (the player is slower) and after a collision (slower still).
    const secs = (1.66 - diff * 0.7) * (0.88 + this.rng() * 0.34);
    return secs * this.model.maxSpeed;
  }

  /**
   * Appends rows until the track reaches `untilZ`.
   *
   * Every candidate row is run through the feasibility DP before it is
   * committed. When nothing fits at a given distance — which happens when the
   * previous row left the body mid-jump — the row is PUSHED FURTHER DOWN THE
   * TRACK rather than committed anyway. An empty row far enough out is always
   * clearable, so this loop always terminates with a valid track, and the only
   * visible consequence is that the player gets a breather.
   *
   * An earlier version "fell back" by committing an empty row at the original
   * distance and resetting the DP state when even that failed. That reset was a
   * lie, and it produced a genuinely unclearable segment in 8 runs out of 1000.
   */
  fill(untilZ: number, out: TrackRow[]): void {
    let guard = 0;
    while (this.nextZ < untilZ && guard++ < 600) {
      let z = this.nextZ;
      const diff = this.difficultyAt(z);

      let committed: TrackRow | null = null;
      let committedStates: LaneStates = INITIAL_STATES;

      for (let attempt = 0; attempt < 16 && !committed; attempt++) {
        // The last attempts are plain breathers, so the loop always has an
        // escape that succeeds once z has been pushed far enough.
        const row = attempt < 10 ? this.candidate(z, diff) : makeRow(this.nextId, z, diff);
        const states = stepStates(this.states, row, this.model);
        if (statesAlive(states)) {
          committed = row;
          committedStates = states;
        } else {
          this.rejected++;
          if (attempt >= 2) {
            z += 5;
            this.pushed++;
          }
        }
      }

      // Unreachable: an empty row pushed 70m past a busy body always clears.
      // If it somehow is reached, stop generating rather than emit a segment
      // that cannot be cleared.
      if (!committed) break;

      this.nextId++;
      this.states = committedStates;
      out.push(committed);
      this.nextZ = z + this.gapFor(diff);
    }
  }
}

/**
 * Generates `runs` complete rounds' worth of track and validates every one.
 *
 * Exposed so the browser harness can assert the "no unclearable segment"
 * property over tens of thousands of rows in a few milliseconds, rather than
 * hoping a handful of playthroughs happened to hit the bad case.
 */
export function selfTestGeneration(
  runs = 200,
  metres = 1200,
  model: ClearanceModel = DEFAULT_CLEARANCE
): { runs: number; rows: number; failures: number; firstFailSeed: number; rejected: number; pushed: number } {
  let rows = 0;
  let failures = 0;
  let firstFailSeed = -1;
  let rejected = 0;
  let pushed = 0;

  for (let i = 0; i < runs; i++) {
    const seed = i * 2654435761 + 12345;
    const gen = new TrackGenerator({ seed, model });
    const out: TrackRow[] = [];
    gen.fill(metres, out);
    const res = validateRows(out, model);
    if (!res.ok) {
      failures++;
      if (firstFailSeed < 0) firstFailSeed = seed;
    }
    rows += out.length;
    rejected += gen.rejected;
    pushed += gen.pushed;
  }

  return { runs, rows, failures, firstFailSeed, rejected, pushed };
}

/* ------------------------------------------------------------------ */
/* World                                                               */
/* ------------------------------------------------------------------ */

export interface WorldView {
  /** Metres travelled. Everything in the scene is placed relative to this. */
  distance: number;
  playerX: number;
  /** Feet height above the track. */
  playerY: number;
  /** 0 = standing, 1 = fully slid. Visual only. */
  crouch: number;
  speed: number;
  /** 0..1 across the speed ramp. Drives fov, camera pull-back, speed lines. */
  speedNorm: number;
  rows: readonly TrackRow[];
  time: number;
  /** Whether the round is live — idles the player form when it isn't. */
  active: boolean;
}

interface KindStyle {
  /** Flat brand fill. One brand colour per obstacle, and never a tint of it. */
  body: THREE.Color;
  /** The action mark struck through the fill. Ink, or paper where ink is lost. */
  mark: THREE.Color;
}

const POOL_PER_KIND = 14;

/**
 * Thickness of the ink outline around a sticker, in METRES of world space.
 *
 * An absolute margin rather than a scale factor: a scale factor gives a tall
 * block a fat outline and a low barrier a hairline one, and the brand's whole
 * point is that every sticker carries the same weight of ink. Perspective
 * thins it with distance on its own, which is correct.
 */
const OUTLINE_MARGIN = 0.095;

/** Cheap deterministic hash so pooled meshes get a stable per-row wobble. */
function hash01(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * One obstacle, drawn as a STICKER: flat brand fill, hard ink outline.
 *
 * The outline is an inverted hull — the same unit box, a fixed margin larger,
 * with `side: BackSide` so only its far faces draw and the body covers the
 * middle. WebGL ignores `LineBasicMaterial.linewidth`, so the `LineSegments`
 * edge pass this replaced could only ever be one device pixel wide, which is
 * exactly the "thin grey outline" DESIGN.md forbids on a sticker.
 */
class ObstacleView {
  readonly group = new THREE.Group();
  private body: THREE.Mesh;
  private outline: THREE.Mesh;
  private mark: THREE.Mesh;

  constructor(
    boxGeo: THREE.BufferGeometry,
    markGeo: THREE.BufferGeometry,
    bodyMat: THREE.Material,
    outlineMat: THREE.Material,
    markMat: THREE.Material
  ) {
    this.body = new THREE.Mesh(boxGeo, bodyMat);
    this.outline = new THREE.Mesh(boxGeo, outlineMat);
    this.mark = new THREE.Mesh(markGeo, markMat);
    this.group.add(this.outline, this.body, this.mark);
    this.group.visible = false;
    this.group.matrixAutoUpdate = true;
  }

  place(
    x: number,
    z: number,
    kind: ObstacleKind,
    rowId: number,
    time: number
  ): void {
    const span = obstacleSpan(kind);
    const h = span.top - span.bottom;
    const cy = (span.top + span.bottom) / 2;

    this.group.visible = true;
    this.group.position.set(x, 0, z);

    this.body.position.set(0, cy, 0);
    this.body.scale.set(OBSTACLE_HALF_W * 2, h, OBSTACLE_HALF_D * 2);
    this.outline.position.copy(this.body.position);
    this.outline.scale.set(
      OBSTACLE_HALF_W * 2 + OUTLINE_MARGIN * 2,
      h + OUTLINE_MARGIN * 2,
      OBSTACLE_HALF_D * 2 + OUTLINE_MARGIN * 2
    );

    // A slow per-obstacle bob keeps the track from reading as a static diagram.
    // DESIGN.md allows decorative drift; it does NOT allow tilting something
    // functional, so the blocker's X no longer spins — it is the sign that says
    // "do not enter", and a sign that rotates is a sign you have to decode.
    const phase = hash01(rowId) * Math.PI * 2;
    const bob = Math.sin(time * 1.6 + phase) * 0.06;

    if (kind === 'low') {
      this.mark.position.set(0, span.top + 0.3 + bob, 0);
      this.mark.rotation.z = 0;
    } else if (kind === 'high') {
      this.mark.position.set(0, span.bottom - 0.3 - bob, 0);
      this.mark.rotation.z = Math.PI;
    } else {
      // The body is opaque now, so a mark at the box centre would be buried
      // inside it. Struck on the face the player is running at instead.
      this.mark.position.set(0, cy + bob, OBSTACLE_HALF_D + 0.04);
      this.mark.rotation.z = 0;
    }
  }

  hide(): void {
    this.group.visible = false;
  }
}

/**
 * One runner's camera, as state rather than as a THREE object.
 *
 * There is exactly one `PerspectiveCamera` in this file and there always will
 * be: a camera is cheap, but two of them would still be one scene and one
 * renderer, and the thing that actually has to be duplicated is not the object
 * — it is the SPRINGS. `camX`, `camRoll`, `dip` and `fov` are integrators, each
 * frame's value computed from the last, so they cannot be recomputed from
 * scratch the way the track and the player mesh are. `update` advances one
 * rig, `render` loads that rig into the shared camera and draws.
 */
interface CameraRig {
  camX: number;
  camY: number;
  camZ: number;
  camRoll: number;
  camRollVel: number;
  dip: number;
  dipVel: number;
  fov: number;
  /** Where the camera is aimed, resolved in `update`, applied in `render`. */
  lookX: number;
  lookY: number;
  /** Motion trail, in world space. Also an integrator — it is history. */
  trailHistory: Array<{ x: number; y: number; z: number }>;
}

function makeRig(): CameraRig {
  return {
    camX: 0,
    camY: 2.45,
    camZ: 6.3,
    camRoll: 0,
    camRollVel: 0,
    dip: 0,
    dipVel: 0,
    fov: 68,
    lookX: 0,
    lookY: 1.25,
    trailHistory: [],
  };
}

export class RunnerWorld {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;

  /** Everything that must be released when the screen unmounts. */
  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.Material[] = [];

  private scroll = new THREE.Group();
  private pools = new Map<ObstacleKind, ObstacleView[]>();

  private playerGroup = new THREE.Group();
  private playerCore: THREE.Mesh;
  private playerRing: THREE.Mesh;
  private trail: THREE.LineSegments;
  private trailPos: Float32Array;

  /**
   * PER-RUNNER STATE, AND THE ONLY STATE THAT CANNOT BE SHARED.
   *
   * Two players share this scene: `update` rewrites the track, the obstacle
   * pool, the player mesh and the trail buffer from scratch every call, so the
   * second runner's pass simply overwrites the first's and both render
   * correctly out of one WebGL context.
   *
   * The camera springs and the motion trail are the exception, because they
   * are INTEGRATORS - each frame's value is a function of the last one. Shared,
   * the two runners' cameras would fight over one position: every frame slot 0
   * would pull it toward its own lane and slot 1 would pull it back, and both
   * halves would render from whichever pass ran last. Hence one rig each.
   */
  private rigs: CameraRig[] = [makeRig(), makeRig()];
  /** The rig the current `update` pass belongs to. */
  private rig: CameraRig = this.rigs[0]!;

  private width = 1280;
  private height = 720;
  private pixelRatio = 1;
  private disposed = false;

  /** Live instance count. A leaked WebGL context is a four-hour problem. */
  static liveCount = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      // We blit this canvas with drawImage every frame, so the back buffer has
      // to survive the present.
      preserveDrawingBuffer: false,
    });
    // Paper. The single change the whole file follows from.
    this.renderer.setClearColor(new THREE.Color(COLORS.paper), 1);
    this.renderer.autoClear = true;

    this.camera = new THREE.PerspectiveCamera(this.rigs[0]!.fov, 16 / 9, 0.1, VIEW_DISTANCE + 60);
    // No fog: see the note at the top of the file. Distance fading toward the
    // paper is a tint of a brand colour, which the brand forbids outright.

    this.buildTrack();
    this.playerCore = this.buildPlayer();
    this.playerRing = this.buildPlayerRing();
    this.scene.add(this.playerGroup);

    const trail = this.buildTrail();
    this.trail = trail.mesh;
    this.trailPos = trail.positions;
    this.scene.add(this.trail);

    this.buildPools();

    RunnerWorld.liveCount++;
  }

  /* ---------------- construction ---------------- */

  private keepGeo<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private keepMat<T extends THREE.Material>(m: T): T {
    this.materials.push(m);
    return m;
  }

  /**
   * A flat ground quad, as two triangles, appended to `out`.
   *
   * Every rule painted on the track is a quad rather than a `LineSegments`,
   * because WebGL ignores `LineBasicMaterial.linewidth`: a line is one device
   * pixel wide however far away it is, so on the 1.5×-downsampled 3D layer an
   * ink rule resolved as a grey hairline — the exact thing DESIGN.md calls out
   * as forbidden on a sticker. A quad has real width in metres, so it holds its
   * ink weight near the camera and thins honestly with perspective.
   */
  private static groundQuad(
    out: number[],
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    y: number
  ): void {
    out.push(x0, y, z0, x1, y, z0, x1, y, z1);
    out.push(x0, y, z0, x1, y, z1, x0, y, z1);
  }

  private buildTrack(): void {
    const RUNG_SPACING = 6;
    const RUNG_COUNT = 30;
    const WALL_H = 3.4;
    /** Painted-rule widths in metres. Ink is the heavier of the two. */
    const INK_RULE = 0.1;
    const GREY_RULE = 0.075;
    /** Just above the track plane, so the rules never z-fight with anything. */
    const PAINT_Y = 0.012;

    // The track carries NO brand colour at all: ruled grey and ink, like the
    // graph paper everything else in the app sits on. That leaves the whole
    // 10% brand-colour budget for the things that matter — the obstacles and
    // the player — instead of spending it on scenery.
    const rungs: number[] = [];
    const arches: number[] = [];

    for (let i = 0; i < RUNG_COUNT; i++) {
      const z = -i * RUNG_SPACING;
      RunnerWorld.groundQuad(
        rungs,
        -HALF_TRACK,
        z - GREY_RULE / 2,
        HALF_TRACK,
        z + GREY_RULE / 2,
        PAINT_Y
      );

      if (i % 4 === 0) {
        arches.push(-HALF_TRACK, 0, z, -HALF_TRACK, WALL_H, z);
        arches.push(-HALF_TRACK, WALL_H, z, HALF_TRACK, WALL_H, z);
        arches.push(HALF_TRACK, WALL_H, z, HALF_TRACK, 0, z);
      }
    }

    const greyMat = this.keepMat(
      new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.muted), side: THREE.DoubleSide })
    );

    const rungGeo = this.keepGeo(new THREE.BufferGeometry());
    rungGeo.setAttribute('position', new THREE.Float32BufferAttribute(rungs, 3));
    this.scroll.add(new THREE.Mesh(rungGeo, greyMat));

    // The arches stay as lines: they are the only decorative element left in
    // the scene, they sit high above the play area, and a grey hairline gate in
    // the distance is exactly the weight they want.
    const archGeo = this.keepGeo(new THREE.BufferGeometry());
    archGeo.setAttribute('position', new THREE.Float32BufferAttribute(arches, 3));
    const archMat = this.keepMat(
      new THREE.LineBasicMaterial({ color: new THREE.Color(COLORS.muted) })
    );
    this.scroll.add(new THREE.LineSegments(archGeo, archMat));
    this.scene.add(this.scroll);

    // Lane boundaries run parallel to travel, so they never need to scroll.
    // These are the functional rules — they say where the three lanes ARE — so
    // they are ink while the scenery is grey.
    const lanes: number[] = [];
    const far = -VIEW_DISTANCE;
    for (const x of [-HALF_TRACK, -LANE_WIDTH / 2, LANE_WIDTH / 2, HALF_TRACK]) {
      RunnerWorld.groundQuad(lanes, x - INK_RULE / 2, 12, x + INK_RULE / 2, far, PAINT_Y);
    }
    const laneGeo = this.keepGeo(new THREE.BufferGeometry());
    laneGeo.setAttribute('position', new THREE.Float32BufferAttribute(lanes, 3));
    const laneMat = this.keepMat(
      new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.ink), side: THREE.DoubleSide })
    );
    this.scene.add(new THREE.Mesh(laneGeo, laneMat));
  }

  /**
   * The player, as a sticker: one flat brand colour, one hard ink outline.
   *
   * The old form was an additive-blended core inside a translucent wireframe
   * cage — two shades of the same blue, both invisible against paper. It is now
   * a single opaque blue solid wearing an inverted-hull ink shell, which is the
   * same object as a fruit in Fruit Ninja or a tile on the menu.
   */
  private buildPlayer(): THREE.Mesh {
    const geo = this.keepGeo(new THREE.IcosahedronGeometry(0.62, 1));
    const mat = this.keepMat(
      new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.blue) })
    );
    const mesh = new THREE.Mesh(geo, mat);

    const outlineMat = this.keepMat(
      new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.ink), side: THREE.BackSide })
    );
    const outline = new THREE.Mesh(geo, outlineMat);
    // A child, so it inherits the core's spin for free and can never drift out
    // of register with it.
    outline.scale.setScalar(1 + OUTLINE_MARGIN / 0.62);
    mesh.add(outline);

    this.playerGroup.add(mesh);
    return mesh;
  }

  /**
   * The shadow the player casts on the track — an ink annulus, not a line loop.
   *
   * This ring is the only altitude cue a head-on camera gives, so it is
   * functional: it gets ink, and it gets real width (a `RingGeometry`) for the
   * same reason the lane rules do. The geometry is pre-rotated flat so the
   * mesh's own transform stays axis-aligned and `scale(shrink, 1, shrink)`
   * still means what it says.
   */
  private buildPlayerRing(): THREE.Mesh {
    const geo = this.keepGeo(new THREE.RingGeometry(0.56, 0.72, 28));
    geo.rotateX(-Math.PI / 2);
    const mat = this.keepMat(
      new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.ink), side: THREE.DoubleSide })
    );
    const ring = new THREE.Mesh(geo, mat);
    this.scene.add(ring);
    return ring;
  }

  /**
   * The motion trail behind the player.
   *
   * Flat ink, no vertex-colour fade, no additive blending. On paper this reads
   * as a pen stroke — the same decision, for the same reason, as the blade
   * trail in Fruit Ninja. The fade it used to carry was a gradient in colour
   * space AND additive, so it was drawing nothing at all against white.
   */
  private buildTrail(): { mesh: THREE.LineSegments; positions: Float32Array } {
    const SEGMENTS = 18;
    const positions = new Float32Array(SEGMENTS * 2 * 3);
    const geo = this.keepGeo(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = this.keepMat(
      new THREE.LineBasicMaterial({ color: new THREE.Color(COLORS.ink) })
    );
    return { mesh: new THREE.LineSegments(geo, mat), positions };
  }

  /**
   * Two filled shapes, built from triangles, that say WHICH action a barrier
   * wants. Filled rather than stroked because WebGL clamps line width to one
   * device pixel: a 1px chevron 80 metres down the track is not a sign, it is a
   * smudge, and this is the part of the obstacle a stranger actually reads.
   */
  private buildMarkGeometries(): { chevron: THREE.BufferGeometry; cross: THREE.BufferGeometry } {
    const tri = (out: number[], a: number[], b: number[], c: number[]): void => {
      out.push(a[0]!, a[1]!, 0, b[0]!, b[1]!, 0, c[0]!, c[1]!, 0);
    };

    // Three stacked carets. Each is a band of thickness T following the caret.
    const chev: number[] = [];
    const HW = 0.85;
    const RISE = 0.5;
    const T = 0.2;
    const STEP = 0.34;
    for (const base of [0, STEP, STEP * 2]) {
      // Shifted up by T so the whole mark starts at y = 0 and the ducking
      // version, which is this same geometry rotated 180°, hangs to y = -H.
      const dy = base + T;
      const p0 = [-HW, dy];
      const p1 = [0, dy + RISE];
      const p2 = [HW, dy];
      const q0 = [-HW, dy - T];
      const q1 = [0, dy + RISE - T];
      const q2 = [HW, dy - T];
      tri(chev, p0, p1, q0);
      tri(chev, p1, q1, q0);
      tri(chev, p1, p2, q1);
      tri(chev, p2, q2, q1);
    }
    const chevron = this.keepGeo(new THREE.BufferGeometry());
    chevron.setAttribute('position', new THREE.Float32BufferAttribute(chev, 3));

    // Blocker mark: a struck X. Two thick bars at ±45°.
    const x: number[] = [];
    const L = 0.72;
    const W = 0.17;
    for (const s of [1, -1]) {
      const dx = Math.SQRT1_2 * L;
      const dy = Math.SQRT1_2 * L * s;
      const nx = -Math.SQRT1_2 * W * s;
      const ny = Math.SQRT1_2 * W;
      const a = [-dx + nx, -dy + ny];
      const b = [dx + nx, dy + ny];
      const c = [dx - nx, dy - ny];
      const d = [-dx - nx, -dy - ny];
      tri(x, a, b, c);
      tri(x, a, c, d);
    }
    const cross = this.keepGeo(new THREE.BufferGeometry());
    cross.setAttribute('position', new THREE.Float32BufferAttribute(x, 3));

    return { chevron, cross };
  }

  private buildPools(): void {
    const styles: Record<ObstacleKind, KindStyle> = {
      // Colour AND shape both encode the action, because the hall is loud and
      // nobody reads anything: green slab low down = jump, yellow slab hanging
      // = duck, red pillar = do not enter. Flat brand hexes, never the `*Bright`
      // aliases — those are the same three colours again and only ever existed
      // to make them work as neon.
      //
      // One brand colour and one ink outline per obstacle, so every one of them
      // is inside DESIGN.md's two-colour cap on its own. The X on the blocker is
      // PAPER rather than ink, for the same reason Fruit Ninja's bomb is: on a
      // saturated red field, white is the stronger strike-through.
      low: { body: new THREE.Color(COLORS.green), mark: new THREE.Color(COLORS.ink) },
      high: { body: new THREE.Color(COLORS.yellow), mark: new THREE.Color(COLORS.ink) },
      block: { body: new THREE.Color(COLORS.red), mark: new THREE.Color(COLORS.paper) },
    };

    const unitBox = this.keepGeo(new THREE.BoxGeometry(1, 1, 1));
    const marks = this.buildMarkGeometries();

    // One ink outline material shared by every obstacle in the scene.
    const outlineMat = this.keepMat(
      new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS.ink), side: THREE.BackSide })
    );

    for (const kind of KINDS) {
      const style = styles[kind];
      const bodyMat = this.keepMat(new THREE.MeshBasicMaterial({ color: style.body }));
      const markMat = this.keepMat(
        new THREE.MeshBasicMaterial({ color: style.mark, side: THREE.DoubleSide })
      );

      const markGeo = kind === 'block' ? marks.cross : marks.chevron;
      const pool: ObstacleView[] = [];
      for (let i = 0; i < POOL_PER_KIND; i++) {
        const view = new ObstacleView(unitBox, markGeo, bodyMat, outlineMat, markMat);
        this.scene.add(view.group);
        pool.push(view);
      }
      this.pools.set(kind, pool);
    }
  }

  /* ---------------- per frame ---------------- */

  resize(width: number, height: number, dpr: number): void {
    // The 3D layer is deliberately allowed to render below the 2D canvas's DPR.
    // On a 4K TV the fill-rate saving is large, and with flat fills and hard
    // outlines the only thing lost is a little edge crispness — which the 2D
    // HUD, drawn at full DPR on top, does not share.
    const ratio = Math.min(dpr, 1.5);
    if (
      Math.abs(width - this.width) < 0.5 &&
      Math.abs(height - this.height) < 0.5 &&
      ratio === this.pixelRatio
    ) {
      return;
    }
    this.width = width;
    this.height = height;
    this.pixelRatio = ratio;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  /** Kick the camera downward — landings, collisions. */
  impulseDip(slot: number, amount: number): void {
    const rig = this.rigs[slot];
    if (rig) rig.dipVel -= amount * 14;
  }

  /** Kick the camera roll — lane changes lean into the turn. */
  impulseRoll(slot: number, amount: number): void {
    const rig = this.rigs[slot];
    if (rig) rig.camRollVel += amount;
  }

  update(slot: number, view: WorldView, dt: number): void {
    if (this.disposed) return;
    const rig = this.rigs[slot];
    if (!rig) return;
    this.rig = rig;
    const step = Math.min(dt, 1 / 20);

    this.updateScroll(view);
    this.updateObstacles(view);
    this.updatePlayer(view, step);
    this.updateCamera(view, step);
  }

  private updateScroll(view: WorldView): void {
    const SPACING = 6;
    this.scroll.position.z = ((view.distance % SPACING) + SPACING) % SPACING;
  }

  private updateObstacles(view: WorldView): void {
    const used: Record<ObstacleKind, number> = { low: 0, high: 0, block: 0 };

    for (const row of view.rows) {
      const rel = row.z - view.distance;
      if (rel < -RECYCLE_BEHIND || rel > VIEW_DISTANCE) continue;
      for (const cell of row.cells) {
        if (cell.destroyed) continue;
        const pool = this.pools.get(cell.kind);
        if (!pool) continue;
        const index = used[cell.kind];
        if (index >= pool.length) continue;
        const viewMesh = pool[index]!;
        used[cell.kind] = index + 1;
        viewMesh.place(LANE_X[cell.lane + 1]!, -rel, cell.kind, row.id, view.time);
      }
    }

    for (const kind of KINDS) {
      const pool = this.pools.get(kind);
      if (!pool) continue;
      for (let i = used[kind]; i < pool.length; i++) pool[i]!.hide();
    }
  }

  private updatePlayer(view: WorldView, dt: number): void {
    const bodyH = STAND_HEIGHT - (STAND_HEIGHT - CROUCH_HEIGHT) * view.crouch;
    const centreY = view.playerY + bodyH * 0.5;

    this.playerGroup.position.set(view.playerX, centreY, 0);

    // Squash when sliding, stretch when rising. All from one scalar, so there
    // is nothing to rig and nothing to animate.
    const squash = 1 - view.crouch * 0.42;
    const stretch = view.playerY > 0.05 ? 1.12 : 1;
    this.playerGroup.scale.set(
      1 / squash,
      squash * stretch,
      1 / squash
    );

    const spin = view.active ? 1 : 0.25;
    this.playerCore.rotation.y -= dt * 2.4 * spin;
    this.playerCore.rotation.z += dt * 1.1 * spin;

    // Ground ring shrinks as the player rises — the only altitude cue that
    // survives a head-on camera.
    const shrink = 1 / (1 + view.playerY * 0.55);
    this.playerRing.position.set(view.playerX, 0.02, 0);
    this.playerRing.scale.set(shrink, 1, shrink);

    // Trail. History is in world space and scrolls backwards with the track.
    const history = this.rig.trailHistory;
    history.unshift({ x: view.playerX, y: centreY, z: 0 });
    const SEGMENTS = this.trailPos.length / 6;
    if (history.length > SEGMENTS + 1) history.pop();
    const drop = view.speed * dt;
    for (let i = 1; i < history.length; i++) {
      history[i]!.z += drop;
    }
    for (let i = 0; i < SEGMENTS; i++) {
      const a = history[Math.min(i, history.length - 1)]!;
      const b = history[Math.min(i + 1, history.length - 1)]!;
      const o = i * 6;
      this.trailPos[o] = a.x;
      this.trailPos[o + 1] = a.y;
      this.trailPos[o + 2] = a.z;
      this.trailPos[o + 3] = b.x;
      this.trailPos[o + 4] = b.y;
      this.trailPos[o + 5] = b.z;
    }
    const attr = this.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
  }

  /**
   * PLAN: "the 3D camera should react — lean into lane changes, dip on landing,
   * pull back with speed." This is most of what makes a runner feel good, so it
   * is a spring rather than a lerp: a spring overshoots, and the overshoot is
   * the feeling.
   */
  private updateCamera(view: WorldView, dt: number): void {
    const rig = this.rig;
    const followX = view.playerX * 0.72;
    const lag = followX - rig.camX;
    rig.camX += lag * Math.min(1, dt * 7.5);

    // Roll is driven by how far the camera is TRAILING the player, so it leans
    // into a lane change and unwinds as it catches up.
    const rollTarget = -lag * 0.16;
    rig.camRollVel += (rollTarget - rig.camRoll) * 120 * dt;
    rig.camRollVel *= Math.exp(-7 * dt);
    rig.camRoll += rig.camRollVel * dt;

    rig.dipVel += -rig.dip * 90 * dt;
    rig.dipVel *= Math.exp(-6.5 * dt);
    rig.dip += rig.dipVel * dt;
    rig.dip = Math.max(-1.2, Math.min(1.2, rig.dip));

    const baseY = 2.5 + view.playerY * 0.34 - view.crouch * 0.4;
    rig.camY += (baseY - rig.camY) * Math.min(1, dt * 9);

    rig.camZ = 6.3 + view.speedNorm * 2.5;
    const fovTarget = 66 + view.speedNorm * 15;
    rig.fov += (fovTarget - rig.fov) * Math.min(1, dt * 3);

    // Aim point only. The camera object itself is one shared THREE object, so
    // pointing it here would be pointless: the second runner's update would
    // move it before either of them rendered. `render` positions it.
    rig.lookX = view.playerX * 0.3;
    rig.lookY = 1.25 + view.playerY * 0.28 + rig.dip * 0.5;
  }

  /**
   * Draw the scene as ONE runner sees it.
   *
   * `rect` is the slice of the canvas this pass owns, in the same logical
   * pixels the 2D layer uses, or null for the whole thing. The scissor test is
   * what makes two passes into one buffer safe: `renderer.render` clears
   * first, and a clear obeys the scissor box, so the second pass cannot wipe
   * out the first.
   *
   * The projection aspect comes from the RECT, not the canvas. A camera left
   * at 16:9 while drawing into an 8:9 half stretches the track sideways, which
   * is not merely ugly - it changes how wide a lane looks and therefore how
   * far a player thinks they have to step.
   */
  render(
    slot = 0,
    rect: { x: number; y: number; width: number; height: number } | null = null
  ): void {
    if (this.disposed) return;
    const rig = this.rigs[slot];
    if (!rig) return;

    this.camera.position.set(rig.camX, rig.camY + rig.dip, rig.camZ);
    this.camera.lookAt(rig.lookX, rig.lookY, -16);
    this.camera.rotation.z += rig.camRoll;

    const aspect = rect
      ? rect.width / Math.max(1, rect.height)
      : this.width / Math.max(1, this.height);
    if (
      Math.abs(this.camera.fov - rig.fov) > 0.01 ||
      Math.abs(this.camera.aspect - aspect) > 1e-4
    ) {
      this.camera.fov = rig.fov;
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }

    if (rect) {
      // LOGICAL pixels, NOT device ones. `setViewport` multiplies by the
      // renderer's own pixel ratio internally, so scaling here first applies it
      // twice — which on any DPR above 1 renders the scene into a viewport
      // larger than the buffer and magnifies the whole track. It does not look
      // like a viewport bug when it happens; it looks like the camera broke.
      //
      // The y flip is the other half: WebGL's origin is bottom-left and the 2D
      // layer's rects are top-left.
      const y = this.height - rect.y - rect.height;
      this.renderer.setViewport(rect.x, y, rect.width, rect.height);
      this.renderer.setScissor(rect.x, y, rect.width, rect.height);
      this.renderer.setScissorTest(true);
    } else {
      this.renderer.setViewport(0, 0, this.width, this.height);
      this.renderer.setScissorTest(false);
    }

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Blit the 3D layer under the 2D HUD. One `drawImage`, and nothing else.
   *
   * THE BLOOM PASS THAT USED TO LIVE HERE IS DELETED, NOT CONVERTED.
   *
   * It downsampled this canvas through `filter: blur(2px)` and composited it
   * back with `globalCompositeOperation = 'lighter'`. Two independent reasons
   * it had to go, either of which is sufficient:
   *
   *   - DESIGN.md bans blur. Bloom is blur with extra steps.
   *   - `'lighter'` is additive, and additive against white is the identity
   *     operation. The pass was running every frame, paying for a blurred
   *     downsample and a full-screen composite, and changing not one pixel of
   *     a paper background. It failed silently and would have gone on failing
   *     silently, because "draws nothing" throws no error.
   *
   * Nothing replaces it. The look no longer wants one.
   */
  presentTo(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    if (this.disposed) return;
    ctx.drawImage(this.canvas, 0, 0, width, height);
  }

  /** Diagnostics for the perf pass. */
  get stats(): { calls: number; triangles: number; lines: number; points: number } {
    const r = this.renderer.info.render;
    return { calls: r.calls, triangles: r.triangles, lines: r.lines, points: r.points };
  }

  /**
   * Release the WebGL context and every GPU resource.
   *
   * Browsers cap live WebGL contexts (~16 in Chrome) and silently kill the
   * OLDEST one when the cap is hit. A leak here means the track goes black
   * partway through the day with no error, so this path is not optional.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const pool of this.pools.values()) {
      for (const view of pool) this.scene.remove(view.group);
    }
    this.pools.clear();
    this.scene.clear();

    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries = [];
    this.materials = [];
    for (const rig of this.rigs) rig.trailHistory = [];

    this.renderer.dispose();
    this.renderer.forceContextLoss();

    RunnerWorld.liveCount--;
  }
}
