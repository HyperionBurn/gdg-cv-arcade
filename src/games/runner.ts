/**
 * RUNNER — "the Subway Surfers slot" (PLAN.md §3, party tier).
 *
 * Three lanes. Step left/right to change lane, jump to jump, crouch to slide.
 * Score is distance in metres with a speed ramp, plus near-miss bonuses.
 *
 * The three calls that shape this build:
 *
 * 1. A COLLISION COSTS SPEED, IT DOES NOT END THE RUN.
 *    PLAN.md §1 makes the turn a hard 60 seconds and says the queue must keep
 *    moving; §11's "what good means" says failure should be funny, never
 *    punishing. A death-on-contact runner driven by noisy pose input ends a lot
 *    of turns at four seconds — the player has no idea why, the crowd sees
 *    nothing, and the operator has to explain a detector. So a hit SMASHES the
 *    obstacle, drops you to ~half speed for a couple of seconds, and kills your
 *    near-miss streak. Speed is the score rate, so the cost is real and legible
 *    ("my number stopped going up"), but every turn still fills its 60 seconds
 *    and every player still gets a number to shout.
 *
 * 2. THE GESTURE FIRES THE ACTION; THE GAME OWNS THE ARC.
 *    `VerticalGestures.jumped` is an edge, and `isAirborne` is however long the
 *    detector happens to think the hips were high — which for a real hop under
 *    hall lighting is short and ragged. Binding the jump arc to that would make
 *    the game feel like the camera, not like a game. Instead the edge launches a
 *    fixed 0.78s arc. Same for the slide: the crouch edge starts a fixed slide,
 *    and holding the crouch extends it (to a cap, so nobody wins by squatting
 *    for a minute).
 *
 * 3. NO GENERATED SEGMENT IS UNCLEARABLE.
 *    Enforced in runner-world.ts by a feasibility DP that every candidate row
 *    has to survive before it is committed, using the same timing constants the
 *    collision test uses. See `selfTestGeneration`.
 *
 * Three.js renders to its own canvas; this class blits it under the 2D HUD in
 * `onRenderBackground`. main.ts still owns the only requestAnimationFrame.
 *
 * BRAND: the 3D half of the conversion lives in runner-world.ts — read the note
 * at the top of that file for why the neon had to go and what was silently
 * drawing nothing. What matters here is the 2D layer on top of it:
 *
 *  - The lane indicator, the JUMP/SLIDE pills and the momentum readout are
 *    STICKERS: flat brand fill, ink outline, hard shadow straight down. Every
 *    one of them used to set `shadowBlur` INSIDE A LOOP, which canvas charges
 *    per draw call — three loops, six blurred draws a frame, for a halo.
 *  - The HUD band is a flat paper panel, not a gradient scrim. A gradient is
 *    exactly the thing DESIGN.md rules out, and against a paper sky it was
 *    fading white into white.
 *  - Numbers go through `drawTabularNumber`. The momentum multiplier and the
 *    speed readout both change every frame, and in proportional figures they
 *    twitch sideways the whole round.
 */

import { LaneDetector, VerticalGestures } from '../core/gestures';
import type { TrackedPlayer } from '../core/tracker';
import { GameBase, type SlotRect } from './base';
import { BURST } from '../engine/particles';
import { audio } from '../engine/audio';
import {
  drawTabularNumber,
  drawText,
  measureTabularNumber,
  roundRect,
  stickerPill,
  vh,
} from '../engine/draw';
import {
  COLORS,
  FONTS,
  SHADOW,
  STROKE,
  TRACK,
  WEIGHT,
  idlePulse,
} from '../shell/theme';
import { GAME_COLORS } from '../meta/games';
import { leaderboard } from '../meta/leaderboard';
import { tunables } from '../meta/tunables';
import type { FrameContext } from '../shell/screen';
import {
  RunnerWorld,
  TrackGenerator,
  jumpHeight,
  selfTestGeneration,
  validateRows,
  CROUCH_HEIGHT,
  GENERATE_AHEAD,
  HIGH_BOTTOM,
  JUMP_CLEAR,
  JUMP_DURATION,
  LANE_X,
  LOW_TOP,
  MAX_SPEED,
  MOMENTUM_FLOOR,
  MOMENTUM_MAX,
  OBSTACLE_HALF_D,
  OBSTACLE_HALF_W,
  PLAYER_HALF_D,
  PLAYER_HALF_W,
  RAMP_SPEED,
  RECYCLE_BEHIND,
  SLIDE_DURATION,
  SPEED_RAMP_SEC,
  STAND_HEIGHT,
  START_SPEED,
  type ObstacleCell,
  type ObstacleKind,
  type TrackRow,
  type WorldView,
} from './runner-world';

/**
 * Momentum: the scoring design in four constants.
 *
 * Clearing obstacle rows without being hit builds a streak, and the streak
 * makes you literally faster — which is the most legible reward a runner has,
 * because the player feels it and the crowd sees it. A hit resets the streak
 * AND applies a temporary speed penalty on top, so the cost of a collision is
 * obvious without a word of text: the number stops climbing.
 */
/**
 * Clean rows to reach MAX SPEED. 12 -> 8.
 *
 * TWELVE WAS THE CEILING ITSELF, so nobody could ever reach it.
 *
 * MEASURED, solo, full 60s rounds, counting scoring rows (breathers excluded)
 * with momentum forced to MAX for the whole round — the most rows a round can
 * possibly contain:
 *
 *   10, 10, 7, 17      mean 11, min 7, max 17
 *
 * The spread is the generator's breather placement, and it is the whole point:
 * a cap of 12 is above the MEAN of the best case. A real run also starts at
 * momentum 1 and accelerates as the streak builds, so it sees fewer rows than
 * any of those numbers. Reaching 12 therefore needs a lucky long round AND a
 * flawless one, and in a typical round the `<MAX SPEED>` popup never fires,
 * the `record` sting never plays, and the top of the momentum curve is never
 * felt by anybody.
 *
 * I FIRST MEASURED THIS ONCE and got 12 exactly, which made a tidy story about
 * the cap sitting precisely on the ceiling. The next round produced 17. One
 * sample of a generator with this much variance is not a measurement, and the
 * tidiness of the first answer is what made it convincing.
 *
 * Found by counting which on-screen strings never get drawn across a full
 * seven-game sweep. `<MAX SPEED>` was one of thirteen, and the only one that
 * turned out to be unreachable by construction rather than merely rare.
 *
 * Eight sits below the min of that best case, so it is reachable in a short
 * round as well as a long one, and still leaves rows to enjoy it on a good
 * run. It also makes
 * each clean row worth MORE speed — `MOMENTUM_PER_STREAK` divides by this — so
 * the thing the comment below calls "the most legible reward a runner has"
 * gets more legible, and a hit costs more visibly.
 *
 * This is a game-feel number on the one game PLAN.md pre-authorises cutting,
 * so confirm it with people at the Sept 21 go/no-go rather than taking a
 * simulator's word for it.
 */
const STREAK_CAP = 8;
const MOMENTUM_PER_STREAK = (MOMENTUM_MAX - 1) / STREAK_CAP;
/** Instant speed cost of a hit, on top of losing the streak. */
const HIT_PENALTY = 0.4;
const PENALTY_CAP = 0.6;
const PENALTY_RECOVERY = 0.12; // per second

/** Longest a held crouch can keep the slide alive, then you must stand up. */
const MAX_SLIDE_HOLD = 1.8;
const SLIDE_LOCKOUT = 0.35;

/**
 * Sideways offset, in torso units, that commits to a side lane — and where the
 * gate lets go again. `LaneDetector`'s own defaults are 0.55/0.30.
 *
 * ONE TORSO UNIT IS 51cm OF LATERAL SHOULDER TRAVEL for a 1.7m adult at 3m on
 * a 16:9 camera, so 0.35 is asking for 17.8cm — about a lean. A tester with a
 * tape measure reported needing 40-50cm.
 *
 * THE GATE WAS NEVER THE PROBLEM; THE REFERENCE WAS. `LaneDetector` measured
 * the shoulder midpoint against a `Baseline` that kept adapting on every frame
 * the lane was 0 — a ~0.83s time constant at 60Hz — so the reference chased
 * the player through the movement it was there to measure, and what reached
 * the gate was not "how far did they move" but "how far did they move faster
 * than 0.83 seconds". Lowering `enter` a second time could not have fixed it:
 * the previous drop, 0.55 -> 0.35, is what the tester was already measuring
 * against, and the floor underneath is a motionless body's own noise.
 *
 * MEASURED through the real `PoseTracker`, realistic noise at 3m, p10 of 25:
 *
 *   peak offset for a shoulder travel of   20cm    25cm    30cm    40cm
 *     taken in 0.9s                       0.254   0.316   0.470   0.701
 *     taken in 1.5s                       0.211   0.260   0.309   0.612
 *
 * A 20cm lean read 0.21-0.32 and fired 0 times in 60. `LaneDetector` now holds
 * its reference still while the body is displaced — see the long note there
 * for the mechanism and for what it costs — and the SAME 0.35 gate now means
 * what it says:
 *
 *   fire rate, 20cm of travel, 30 seeds x 2 directions, `enter` 0.35
 *     taken in                0.4s   0.6s   0.9s   1.2s   1.6s   2.0s
 *     before                     0%     0%     0%     0%     0%     0%
 *     after                    100%   100%   100%   100%   100%    97%
 *
 *   and, unchanged, 10cm fires 0% at every speed — a weight-shift is not a
 *   lane change. Hostile noise, a shoulders-only LEAN rather than a step, a
 *   body at 2.2m and a body at 4m all also fire 100% at 20cm.
 *
 * SO BOTH NUMBERS STAY WHERE THEY ARE. 0.35 is 1.20x the worst reading a body
 * rocking +-8cm on the spot produces under hostile input (0.291), which is the
 * widest sway this repo documents for a standing person. Past +-10cm of sway
 * it starts firing — that is the real cost of the fix, and it is why this is
 * live on the console: `runner.laneEnter` 0.40 buys the +-11cm case back for
 * 22cm of travel instead of 20cm.
 *
 * EXIT 0.22 is unchanged and still clears the still-body noise floor (hostile
 * max 0.078), so a player who steps back to the middle re-centres.
 */
const LANE_ENTER = 0.35;
const LANE_EXIT = 0.22;

/**
 * Where the lane reference stops following the body, and for how long.
 *
 * `holdAt` 0.12 torso (6.1cm) is above anything a standing body produces —
 * MEASURED, still and hostile, max 0.078 over 120s — and far below `LANE_EXIT`,
 * so the reference is already held by the time a movement is anywhere near
 * deciding anything. Raising it to 0.18 dropped a 20cm step from 100% to 85%.
 *
 * `holdSec` 2.0 is longer than any deliberate side-step (measured above: a
 * committed one is 0.4-1.2s) and short enough that a player who simply
 * re-plants their feet is absorbed in about 3 seconds rather than spending the
 * rest of the round with an off-centre gate.
 */
const LANE_HOLD_AT = 0.12;
const LANE_HOLD_SEC = 2;

/** Near-miss tuning. Garnish on top of momentum, never the main course. */
const NEAR_TIME_WINDOW = 0.22; // seconds of margin that still counts as close
const NEAR_LATERAL_WINDOW = 0.9; // metres of gap that still counts as close
/**
 * Below this a clearance is not a near miss and pays nothing.
 *
 * THIS IS ALSO WHAT KEEPS A MOTIONLESS PLAYER'S SCORE HONEST, and the margin
 * is thinner than it looks. Someone who never moves sits in lane 0 while
 * obstacles go past in lanes ±1, and that fixed geometry pays out every single
 * row if this number is set even slightly lower:
 *
 *   gap       = LANE_WIDTH - (OBSTACLE_HALF_W + PLAYER_HALF_W)
 *             = 2.4 - (1.032 + 0.6)          = 0.768 m
 *   closeness = 1 - gap / NEAR_LATERAL_WINDOW
 *             = 1 - 0.768 / 0.9              = 0.1467
 *
 * 0.16 clears that by 0.013, and because `laneX` tweens onto an exact LANE_X
 * the figure is not a distribution — it is the same 0.1467 on every row of
 * every run. So standing still earns distance and nothing else, which is the
 * intended passive floor. Lower this below 0.147, or widen
 * NEAR_LATERAL_WINDOW past 0.914, and doing nothing starts paying a bonus on
 * every obstacle row in the game.
 */
const NEAR_MIN_CLOSENESS = 0.16;
const NEAR_MAX_BONUS = 12; // metres

/**
 * What a collision says. PLAN.md: "failure should be funny, never punishing" —
 * so the game reacts like someone tripping over a bin, not like a game over.
 */
const OOF: readonly string[] = ['OOF', 'WHOOPS', 'NOPE', 'SPLAT', 'YIKES', 'OUCH'];

/**
 * EVERYTHING ONE RUNNER OWNS.
 *
 * This game was the only one on the roster that could not be played with a
 * friend, and the reason was structural rather than deliberate: every piece of
 * state below was a field on the screen. One detector, one track, one clock,
 * one streak. Nothing about the GAME is single-player — the track generator
 * already proves each segment clearable, the collision test is per-body, the
 * score is per-body — it was just that there was exactly one of each.
 *
 * So: one of these per player, and the screen holds an array of them.
 *
 * WHY EACH RUNNER GETS ITS OWN TRACK RATHER THAN SHARING ONE. `cell.destroyed`
 * is mutated the instant a body hits an obstacle, and it is the flag that
 * stops the same obstacle being hit twice. Sharing rows would mean the first
 * player to clip a barrier deletes it out from under the second — the leader
 * clearing the course for whoever is behind. Two generators seeded identically
 * give both runners the SAME track and independent destruction, which is what
 * "same race" actually means.
 */
interface RunnerLane {
  lanes: LaneDetector;
  vert: VerticalGestures;
  gen: TrackGenerator;
  rows: TrackRow[];

  /** Seconds. Sim time while playing, real time otherwise, always monotonic. */
  clock: number;
  distance: number;
  bonus: number;
  /** Temporary speed cost from recent collisions, 0..PENALTY_CAP. */
  penalty: number;
  speed: number;

  laneTarget: number;
  laneX: number;
  crouchVisual: number;

  airStart: number;
  wasAirborne: boolean;
  slideStart: number;
  slideHoldStart: number;
  slideLockUntil: number;

  /** Obstacle rows cleared without being hit. Drives momentum. */
  streak: number;
  bestStreak: number;
  rowsCleared: number;
  nearMisses: number;
  hits: number;
  lastMilestone: number;

  /** Scroll position used for the attract/countdown idle. */
  idleZ: number;
}

function makeLane(): RunnerLane {
  return {
    lanes: new LaneDetector({
      enter: LANE_ENTER,
      exit: LANE_EXIT,
      laneCount: 3,
      holdAt: LANE_HOLD_AT,
      holdSec: LANE_HOLD_SEC,
    }),
    vert: new VerticalGestures(),
    gen: new TrackGenerator(),
    rows: [],
    clock: 0,
    distance: 0,
    bonus: 0,
    penalty: 0,
    speed: START_SPEED,
    laneTarget: 0,
    laneX: 0,
    crouchVisual: 0,
    airStart: -99,
    wasAirborne: false,
    slideStart: -99,
    slideHoldStart: -99,
    slideLockUntil: -99,
    streak: 0,
    bestStreak: 0,
    rowsCleared: 0,
    nearMisses: 0,
    hits: 0,
    lastMilestone: 0,
    idleZ: 0,
  };
}

export class RunnerGame extends GameBase {
  private world: RunnerWorld | null = null;
  private worldFailed = false;

  /** One per seat. Index is the base class's slot. */
  private slots: RunnerLane[] = [makeLane(), makeLane()];

  constructor() {
    super({
      gameId: 'runner',
      title: 'RUNNER',
      // Player-facing, so it takes the brand voice: short, loud, bracketed.
      // It still has to explain all three controls on its own — nobody at a
      // stall gets told how to play.
      tagline: '<STEP TO MOVE — JUMP OVER — CROUCH TO SLIDE>',
      visionMode: 'pose',
      maxPlayers: 2,
      roundSeconds: 60,
      color: GAME_COLORS.runner,
      // Two runners, two identical tracks, one WebGL context rendered twice
      // through a scissor rect. See `RunnerLane` and `onRenderBackground`.
      supportsVersus: true,
      // 3D camera: a camera-space ghost skeleton would straddle the track.
      // The ghost still races through the score line.
      ghostSilhouette: false,
      // Same reason: the track is not in camera space, so a mirrored webcam
      // image behind it is two incompatible spaces stacked on each other.
      cameraGhost: false,
      // Two full-bleed 3D tracks need a hard ink rule between them, not the
      // faint dashed one the other versus games use.
      fullBleedSlots: true,
    });
  }

  /* ---------------- lifecycle ---------------- */

  override async mount(): Promise<void> {
    await super.mount();
    // Warm the WebGL context during the screen transition rather than on the
    // first rendered frame, where it shows up as a visible hitch.
    this.ensureWorld(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  }

  override unmount(): void {
    super.unmount();
    this.world?.dispose();
    this.world = null;
    for (const s of this.slots) s.rows = [];
  }

  private ensureWorld(width: number, height: number, dpr: number): RunnerWorld | null {
    if (this.world || this.worldFailed) {
      this.world?.resize(width, height, dpr);
      return this.world;
    }
    try {
      const w = new RunnerWorld();
      w.resize(width, height, dpr);
      this.world = w;
    } catch (err) {
      // No WebGL is survivable: the 2D HUD alone still communicates lane,
      // jump, slide and score. A black screen at the stall is not survivable.
      console.error('[runner] 3D unavailable, falling back to HUD only', err);
      this.worldFailed = true;
    }
    return this.world;
  }

  /**
   * PLAYTEST INSTRUMENTATION. See `meta/roundlog.ts`.
   *
   * FEEDBACK.md's open Runner row asks for the first-timer hit rate on `low`
   * (jump) obstacles SPECIFICALLY, and sets a clear-rate threshold below which
   * jumps get weighted to near zero and lanes and slides ship instead. That is
   * a ship decision resting on a number nobody can count by eye while running
   * a queue, and until now nothing recorded it — `s.hits` is a total, with no
   * denominator and no breakdown by kind.
   *
   * FACED is the denominator, and it is not "obstacles generated": it is
   * obstacles the runner was LATERALLY LINED UP WITH when the row reached
   * them. A `low` you side-stepped is not a jump you failed, so counting it
   * would flatter the jump mechanic by exactly the amount players avoid it.
   *
   * Counted once per cell, via a WeakSet of the cell objects rather than a
   * flag on `ObstacleCell` — the world renderer shares that type and does not
   * need to know about this. Cells are per-slot (one generator each, same
   * seed, separate `destroyed` flags), so two runners on the same course
   * contribute two independent samples, which is what an aggregate rate wants.
   */
  private facedBy: Record<ObstacleKind, number> = { low: 0, high: 0, block: 0 };
  private hitBy: Record<ObstacleKind, number> = { low: 0, high: 0, block: 0 };
  private countedCells = new WeakSet<ObstacleCell>();

  /** Idempotent per cell: whichever of hit-or-crossing happens first wins. */
  private faceCell(cell: ObstacleCell): void {
    if (this.countedCells.has(cell)) return;
    this.countedCells.add(cell);
    this.facedBy[cell.kind]++;
  }

  protected override roundDetail(): Record<string, number> {
    return {
      lowFaced: this.facedBy.low,
      lowHit: this.hitBy.low,
      highFaced: this.facedBy.high,
      highHit: this.hitBy.high,
      blockFaced: this.facedBy.block,
      blockHit: this.hitBy.block,
    };
  }

  protected onStart(): void {
    this.facedBy = { low: 0, high: 0, block: 0 };
    this.hitBy = { low: 0, high: 0, block: 0 };
    this.countedCells = new WeakSet<ObstacleCell>();

    // Re-read per round, not per frame: a marshal moving the slider between
    // plays has to see it take effect on the next go, and `LaneDetector` reads
    // its tunables out of a struct rather than a getter.
    const tune = {
      enter: tunables.get('runner.laneEnter', LANE_ENTER),
      exit: tunables.get('runner.laneExit', LANE_EXIT),
      holdAt: tunables.get('runner.laneHoldAt', LANE_HOLD_AT),
      holdSec: tunables.get('runner.laneHoldSec', LANE_HOLD_SEC),
    };

    // ONE SEED FOR BOTH RUNNERS. Two independently seeded generators would be
    // two different courses, and "I got the easy one" is the end of a race as
    // a race. Same seed, same rows, separate `destroyed` flags.
    const seed = (Math.random() * 0xffffffff) >>> 0;

    for (const s of this.slots) {
      s.lanes.setTunables(tune);
      s.lanes.reset();
      s.vert.reset();
      s.gen.reset(seed);
      s.rows = [];
      s.gen.fill(GENERATE_AHEAD, s.rows);

      s.clock = 0;
      s.distance = 0;
      s.bonus = 0;
      s.penalty = 0;
      s.speed = START_SPEED;
      s.laneTarget = 0;
      s.laneX = 0;
      s.crouchVisual = 0;
      s.airStart = -99;
      s.wasAirborne = false;
      s.slideStart = -99;
      s.slideHoldStart = -99;
      s.slideLockUntil = -99;
      s.streak = 0;
      s.bestStreak = 0;
      s.rowsCleared = 0;
      s.nearMisses = 0;
      s.hits = 0;
      s.lastMilestone = 0;
      s.idleZ = 0;
    }
  }

  protected scoreFor(slot: number): number {
    const s = this.slots[slot];
    if (!s) return 0;
    return Math.floor(s.distance + s.bonus);
  }

  protected override primaryStat(slot: number): string {
    return String(this.scoreFor(slot));
  }

  protected override primaryLabel(): string {
    return 'METRES';
  }

  /* ---------------- player state ---------------- */

  private airborneAt(s: RunnerLane, t: number): boolean {
    return t - s.airStart < JUMP_DURATION && t >= s.airStart;
  }

  private slidingAt(s: RunnerLane, t: number): boolean {
    return t - s.slideStart < SLIDE_DURATION && t >= s.slideStart;
  }

  /** Feet height above the track at time `t`. */
  private feetAt(s: RunnerLane, t: number): number {
    if (!this.airborneAt(s, t)) return 0;
    return jumpHeight((t - s.airStart) / JUMP_DURATION);
  }

  private headAt(s: RunnerLane, t: number): number {
    return this.feetAt(s, t) + (this.slidingAt(s, t) ? CROUCH_HEIGHT : STAND_HEIGHT);
  }

  /* ---------------- input ---------------- */

  /**
   * Runs in EVERY state, not just `playing`.
   *
   * The player controlling the glowing form during the countdown is the whole
   * tutorial. Nobody at a stall reads a tagline; they step sideways, the shape
   * slides sideways, and now they understand the game.
   */
  private updateInput(fc: FrameContext, slot: number, p: TrackedPlayer | undefined, dt: number): void {
    const s = this.slots[slot];
    if (!s) return;

    if (p && p.scale.valid) {
      // `fc.now` so the hold timer is in SECONDS rather than in frames. The
      // detector falls back to assuming 60Hz, which is what its adaptation rate
      // has always assumed — but this game runs on whatever the TV gives us.
      const lane = s.lanes.update(p, true, fc.now);
      const changed = s.lanes.changed;
      if (changed !== 0) {
        s.laneTarget = lane;
        this.onLaneChange(fc, slot, Math.sign(changed));
      } else {
        s.laneTarget = lane;
      }

      s.vert.update(p, fc.now);

      if (s.vert.jumped && !this.airborneAt(s, s.clock)) {
        s.airStart = s.clock;
        // A jump out of a slide is a legitimate cancel — the body cannot do
        // both, and forcing the player to wait for the slide to expire feels
        // like the game ignoring them.
        s.slideStart = -99;
        s.slideHoldStart = -99;
        audio.play('whoosh', 1.25);
        this.world?.impulseDip(slot, -0.12);
      }

      const canSlide = s.clock >= s.slideLockUntil;
      if (s.vert.crouched && canSlide && !this.airborneAt(s, s.clock)) {
        s.slideStart = s.clock;
        s.slideHoldStart = s.clock;
        audio.play('whoosh', 0.7);
      } else if (s.vert.isCrouching && this.slidingAt(s, s.clock) && canSlide) {
        // Held crouch keeps the slide alive, up to the hold cap. Past the cap
        // you have to stand up again — squatting for a minute is not a strategy.
        if (s.clock - s.slideHoldStart < MAX_SLIDE_HOLD) {
          s.slideStart = Math.max(s.slideStart, s.clock - SLIDE_DURATION + 0.14);
        } else {
          s.slideStart = -99;
          s.slideLockUntil = s.clock + SLIDE_LOCKOUT;
        }
      }
    }

    // Landing. Detected from the arc, not the detector, so it always lands.
    const airborne = this.airborneAt(s, s.clock);
    if (s.wasAirborne && !airborne) {
      this.world?.impulseDip(slot, 0.34);
      this.juice.shake(0.05);
      audio.play('land', 0.9);
      this.landingDust(fc, slot);
    }
    s.wasAirborne = airborne;

    // Lane tween. Fast enough to feel responsive, slow enough that the camera
    // roll has something to lean against.
    const targetX = LANE_X[Math.max(0, Math.min(2, s.laneTarget + 1))] ?? 0;
    s.laneX += (targetX - s.laneX) * (1 - Math.exp(-dt * 13));

    const crouchTarget = this.slidingAt(s, s.clock) ? 1 : 0;
    s.crouchVisual += (crouchTarget - s.crouchVisual) * (1 - Math.exp(-dt * 18));
  }

  private onLaneChange(fc: FrameContext, slot: number, dir: number): void {
    this.world?.impulseRoll(slot, dir * 0.9);
    audio.play('whoosh', 0.95);
    this.juice.shake(0.03);
    const { v } = fc;
    const rect = this.slotRect(v, slot);
    // Ink, not `blueBright`. `*Bright` is the same blue again — it only existed
    // to make the hex read as neon — and flat blue sparks on a paper track are
    // a particle budget spent on almost nothing.
    BURST.spark(
      this.particles,
      rect.centerX - dir * vh(v, 6),
      v.height * 0.62,
      dir > 0 ? Math.PI : 0,
      COLORS.ink,
      0.5
    );
  }

  private landingDust(fc: FrameContext, slot: number): void {
    const { v } = fc;
    const rect = this.slotRect(v, slot);
    const s = this.slots[slot];
    this.particles.emit({
      x: rect.centerX + (s?.laneX ?? 0) * vh(v, 4),
      y: v.height * 0.72,
      count: 12,
      color: COLORS.ink,
      angle: 0,
      spread: Math.PI * 2,
      speed: 180,
      speedVariance: 120,
      size: 3,
      life: 0.35,
      gravity: 200,
      drag: 0.9,
      streak: true,
    });
  }

  /* ---------------- simulation ---------------- */

  protected onTick(fc: FrameContext, _players: TrackedPlayer[], dt: number): void {
    if (dt <= 0) return;

    const roundElapsed = this.roundTotal - this.timeLeft;
    const ramp = Math.max(0, Math.min(1, roundElapsed / SPEED_RAMP_SEC));
    const base = START_SPEED + (RAMP_SPEED - START_SPEED) * ramp;

    // Each runner advances on its OWN speed. Two people on one shared scroll
    // would mean the slower one is dragged along by the faster, which deletes
    // the only thing momentum is for.
    for (let slot = 0; slot < this.playerCount; slot++) {
      const s = this.slots[slot];
      if (!s) continue;

      s.penalty = Math.max(0, s.penalty - PENALTY_RECOVERY * dt);
      s.speed = base * this.momentum(s);

      // Sub-step so nothing tunnels through a 1.4m-deep obstacle at 21 m/s, and
      // so the near-miss sample lands at the true crossing instant.
      const travel = s.speed * dt;
      const steps = Math.max(1, Math.min(6, Math.ceil(travel / 0.4)));
      const sdt = dt / steps;

      for (let i = 0; i < steps; i++) {
        s.clock += sdt;
        const prev = s.distance;
        s.distance += s.speed * sdt;
        this.resolveRows(fc, slot, prev, s.distance);
      }

      this.extendTrack(s);
      this.milestones(fc, slot);
    }
  }

  private extendTrack(s: RunnerLane): void {
    if (s.gen.lastZ < s.distance + GENERATE_AHEAD) {
      s.gen.fill(s.distance + GENERATE_AHEAD, s.rows);
    }
    let drop = 0;
    while (drop < s.rows.length && s.rows[drop]!.z < s.distance - RECYCLE_BEHIND) drop++;
    if (drop > 0) s.rows.splice(0, drop);
  }

  private milestones(fc: FrameContext, slot: number): void {
    const s = this.slots[slot];
    if (!s) return;
    const rect = this.slotRect(fc.v, slot);
    const m = Math.floor(s.distance / 250);
    if (m > s.lastMilestone) {
      s.lastMilestone = m;
      // Every popup in this game is INK. PopupLayer draws flat text with no
      // outline behind it, and flat yellow type on white paper is the one brand
      // pairing that vanishes at three metres.
      this.popups.spawn(
        `${m * 250}m`,
        rect.centerX,
        fc.v.height * 0.32,
        COLORS.ink,
        vh(fc.v, 4.5)
      );
      audio.play('select', 1 + m * 0.06);
      this.juice.shake(0.08);
    }
  }

  private halfDepth(): number {
    return OBSTACLE_HALF_D + PLAYER_HALF_D;
  }

  /**
   * Collision, near-miss sampling and row retirement, for one sub-step.
   *
   * Three distinct moments per row:
   *   - overlap window   → collision test, every sub-step
   *   - centre crossing  → sample how close it was
   *   - fully behind     → retire, and pay out the near-miss
   */
  private resolveRows(fc: FrameContext, slot: number, prevZ: number, nowZ: number): void {
    const s = this.slots[slot];
    if (!s) return;
    const half = this.halfDepth();

    for (const row of s.rows) {
      if (row.resolved) continue;
      const rel = row.z - nowZ;
      if (rel > half) break; // rows are ordered; nothing further is in range yet

      if (!row.resolved && Math.abs(rel) <= half) {
        if (this.collide(fc, slot, row)) continue;
      }

      // Centre crossing — the tightest point, so the honest place to measure.
      if (!row.resolved && prevZ < row.z && nowZ >= row.z) {
        row.closeness = this.closenessAt(s, row);

        // Everything still standing that the runner is lined up with was
        // faced and cleared. `destroyed` cells were already counted on the hit.
        for (const cell of row.cells) {
          if (cell.destroyed) continue;
          const ox = LANE_X[cell.lane + 1] ?? 0;
          if (Math.abs(s.laneX - ox) >= OBSTACLE_HALF_W + PLAYER_HALF_W) continue;
          this.faceCell(cell);
        }
      }

      if (rel < -half) {
        row.resolved = true;
        this.retireRow(fc, slot, row);
        row.closeness = 0;
      }
    }
  }

  /** @returns true if the row was hit this sub-step. */
  private collide(fc: FrameContext, slot: number, row: TrackRow): boolean {
    const s = this.slots[slot];
    if (!s) return false;
    const feet = this.feetAt(s, s.clock);
    const head = this.headAt(s, s.clock);

    for (const cell of row.cells) {
      if (cell.destroyed) continue;
      const ox = LANE_X[cell.lane + 1] ?? 0;
      if (Math.abs(s.laneX - ox) >= OBSTACLE_HALF_W + PLAYER_HALF_W) continue;

      if (cell.kind === 'low' && feet >= LOW_TOP) continue;
      if (cell.kind === 'high' && head <= HIGH_BOTTOM) continue;

      // Faced AND hit. Most hits land before the row's centre crossing, so
      // counting the denominator only at the crossing would miss exactly the
      // obstacles the question is about.
      this.faceCell(cell);
      this.hitBy[cell.kind]++;

      this.onHit(fc, slot, row, cell.kind);
      cell.destroyed = true;
      return true;
    }
    return false;
  }

  /**
   * 0 = comfortable, 1 = by a hair.
   *
   * For a jump or slide that is the TIMING margin — how close the crossing was
   * to the edge of the action's clearing window. For a lane dodge it is the
   * lateral gap. Both read to the player as "that was close", which is the only
   * definition that matters.
   */
  private closenessAt(s: RunnerLane, row: TrackRow): number {
    let best = 0;
    const t = s.clock;

    for (const cell of row.cells) {
      if (cell.destroyed) continue;
      const ox = LANE_X[cell.lane + 1] ?? 0;
      const overlap = Math.abs(s.laneX - ox) < OBSTACLE_HALF_W + PLAYER_HALF_W;

      if (overlap) {
        if (cell.kind === 'block') continue; // would have been a hit
        let start: number;
        let end: number;
        if (cell.kind === 'low') {
          start = s.airStart + JUMP_DURATION * JUMP_CLEAR.from;
          end = s.airStart + JUMP_DURATION * JUMP_CLEAR.to;
        } else {
          start = s.slideStart;
          end = s.slideStart + SLIDE_DURATION;
        }
        const margin = Math.min(t - start, end - t);
        if (margin < 0) continue;
        best = Math.max(best, 1 - Math.min(1, margin / NEAR_TIME_WINDOW));
      } else {
        const gap = Math.abs(s.laneX - ox) - (OBSTACLE_HALF_W + PLAYER_HALF_W);
        best = Math.max(best, 1 - Math.min(1, gap / NEAR_LATERAL_WINDOW));
      }
    }

    return best;
  }

  /**
   * A row has gone past without hitting the player. Bank the streak, and pay a
   * bonus if it was tight.
   */
  private retireRow(fc: FrameContext, slot: number, row: TrackRow): void {
    if (row.cells.length === 0) return; // breather rows are not an achievement
    const s = this.slots[slot];
    if (!s) return;
    const rect = this.slotRect(fc.v, slot);

    const wasCapped = s.streak >= STREAK_CAP;
    s.streak++;
    s.rowsCleared++;
    s.bestStreak = Math.max(s.bestStreak, s.streak);
    if (!wasCapped && s.streak === STREAK_CAP) {
      this.popups.spawn('<MAX SPEED>', rect.centerX, fc.v.height * 0.38, COLORS.ink, vh(fc.v, 4.4));
      this.juice.flash(COLORS.green, 0.18, 6);
      audio.play('record', 1.2);
    }

    const closeness = row.closeness;
    if (closeness < NEAR_MIN_CLOSENESS) return; // cleared it, but with room

    // NEAR-MISS PAYS A FLAT BONUS, NOT A STREAK-MULTIPLIED ONE.
    //
    // It used to multiply by the same streak that already rewards clean play,
    // reaching ~29m per near-miss at the cap — against obstacle gaps of only
    // 17-42m. So one late clear was worth almost a whole gap of running.
    //
    // And the risk was fake: the generator GUARANTEES every obstacle is
    // clearable with margin, so a player good enough never to miss loses
    // nothing by always cutting it late. Measured: a bot with a 0.35s lead
    // scored 644 against 598 for a 1.0s lead, while taking the same hits.
    // "Cut it fine" should be a trade, not free money on top of a bonus you
    // are already being paid.
    //
    // Flat, and capped well below a gap, so it flavours the run instead of
    // dominating the score.
    s.nearMisses++;
    const gained = NEAR_MAX_BONUS * closeness;
    s.bonus += gained;

    const { v } = fc;
    const y = v.height * 0.55;
    const label = `+${Math.round(gained)}`;
    this.popups.spawn(label, rect.centerX, y, COLORS.ink, vh(v, 3.4 + closeness * 1.8));

    audio.play('pop', 1 + Math.min(1.1, s.streak * 0.09 + closeness * 0.25));
    this.juice.shake(0.04 + closeness * 0.06);
    BURST.spark(this.particles, rect.centerX, y, -Math.PI / 2, COLORS.ink, 0.5 + closeness);

    // A genuinely tight one earns the slow-mo. PLAN.md §5 reserves time
    // dilation for records and near misses; constant use makes it worthless.
    if (closeness > 0.82) {
      this.juice.slowMo(0.55, 3.2);
      this.juice.flash(COLORS.yellow, 0.14, 7);
    }
  }

  /**
   * Speed multiplier from the clean streak, minus recent collisions.
   *
   * Clamped to MOMENTUM_MAX because MAX_SPEED — the speed the generator proves
   * every segment clearable at — is derived from exactly that bound.
   */
  private momentum(s: RunnerLane): number {
    const boost = Math.min(STREAK_CAP, s.streak) * MOMENTUM_PER_STREAK;
    return Math.max(MOMENTUM_FLOOR, Math.min(MOMENTUM_MAX, 1 + boost - s.penalty));
  }

  private onHit(fc: FrameContext, slot: number, row: TrackRow, kind: ObstacleKind): void {
    const s = this.slots[slot];
    if (!s) return;
    row.resolved = true;
    row.closeness = 0;
    s.hits++;
    s.streak = 0;
    s.penalty = Math.min(PENALTY_CAP, s.penalty + HIT_PENALTY);

    const { v } = fc;
    const rect = this.slotRect(v, slot);
    const colour = kind === 'block' ? COLORS.red : kind === 'low' ? COLORS.green : COLORS.yellow;

    this.juice.impact(0.95, COLORS.red);
    this.juice.slowMo(0.45, 2.4);
    this.juice.chromatic(5);
    this.world?.impulseDip(slot, -0.55);
    audio.play('bomb', 0.85);

    BURST.splat(this.particles, rect.centerX + s.laneX * vh(v, 4), v.height * 0.55, colour, 1.3);

    // Red is the brand's "closed", it is legible flat on paper, and it is the
    // one brand colour this moment is allowed.
    const word = OOF[Math.floor(Math.random() * OOF.length)] ?? 'OOF';
    this.popups.spawn(word, rect.centerX, v.height * 0.46, COLORS.red, vh(v, 6));
    // Ink, not muted: the sub-line stays quieter than the 6vh red word above
    // it by SIZE, which is the axis that survives being read from 3m.
    this.popups.spawn('COMBO LOST', rect.centerX, v.height * 0.53, COLORS.ink, vh(v, 2.4));
  }

  /* ---------------- render ---------------- */

  /**
   * ONE WEBGL CONTEXT, RENDERED ONCE PER RUNNER.
   *
   * A second `RunnerWorld` would be a second WebGL context, and browsers kill
   * the OLDEST context when they hit their cap (~16 in Chrome) with no error —
   * the failure mode `RunnerWorld.liveCount` exists to catch. So both runners
   * share one scene and one renderer, and the split is a scissor rect: update
   * the scene for slot 0, render it into the left half, update it for slot 1,
   * render into the right. The scene is fully rewritten between the two
   * passes, which is exactly what `update` already did every frame.
   *
   * The only state that CANNOT be rewritten that way is the camera springs and
   * the motion trail, because those are integrators — they carry history. Those
   * live per-rig inside `RunnerWorld`; see the note there.
   */
  protected override onRenderBackground(fc: FrameContext): void {
    const { ctx, v } = fc;
    const playing = this.state === 'playing';
    const count = Math.max(1, this.playerCount);

    // Input runs every frame, in every state.
    for (let slot = 0; slot < count; slot++) {
      const s = this.slots[slot];
      if (!s) continue;
      if (!playing) s.clock += fc.dt;
      this.updateInput(fc, slot, this.playerFor(slot), fc.dt);
      if (!playing) s.idleZ += START_SPEED * fc.dt * (this.state === 'results' ? 0.35 : 0.6);
    }

    const world = this.ensureWorld(v.width, v.height, v.dpr);
    if (!world) {
      this.drawFallbackBackdrop(fc);
      return;
    }

    for (let slot = 0; slot < count; slot++) {
      const s = this.slots[slot];
      if (!s) continue;

      const speedNorm = Math.max(
        0,
        Math.min(1, (s.speed - START_SPEED) / (MAX_SPEED - START_SPEED))
      );

      const view: WorldView = {
        distance: playing ? s.distance : s.idleZ,
        playerX: s.laneX,
        playerY: this.feetAt(s, s.clock),
        crouch: s.crouchVisual,
        speed: playing ? s.speed : START_SPEED * 0.6,
        speedNorm: playing ? speedNorm : 0,
        rows: playing ? s.rows : [],
        time: fc.time,
        active: playing,
      };

      world.update(slot, view, fc.dt);
      world.render(slot, count === 1 ? null : this.slotRect(v, slot));
    }

    world.presentTo(ctx, v.width, v.height);

    // No vignette (a gradient, and a no-op in engine/draw.ts already) and no
    // bloom (deleted in runner-world.ts — see the note there).
    this.drawHudBand(fc);
  }

  /**
   * The paper the HUD sits on.
   *
   * This was a vertical alpha gradient darkening the top of the screen so white
   * type would read over a bright track. Both halves of that are gone: the type
   * is ink, and a gradient is the first thing DESIGN.md rules out. It is now a
   * flat paper panel with one hard ink rule along the bottom — the same object
   * as a flat card, full-bleed.
   *
   * It is opaque on purpose. The band is exactly `hudBottom`, which the base
   * class already keeps every rising popup below, and the 3D sky above the
   * horizon is paper anyway, so nothing legible is being covered.
   */
  private drawHudBand(fc: FrameContext): void {
    const { ctx, v } = fc;
    const h = this.hudBottom(v);
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(0, 0, v.width, h);
    ctx.fillStyle = COLORS.ink;
    ctx.fillRect(0, h, v.width, vh(v, STROKE.thin));
    ctx.restore();
  }

  /**
   * No WebGL. Three lanes in perspective, ruled in grey, so the lane indicator
   * and the action pills still have something to sit against.
   *
   * Muted rather than a washed-out blue: `withAlpha` on a brand colour is a
   * tint, and the 3D track does not spend brand colour on scenery either.
   */
  private drawFallbackBackdrop(fc: FrameContext): void {
    const { ctx, v } = fc;
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = COLORS.muted;
    ctx.lineWidth = vh(v, STROKE.thin);
    for (let i = 0; i < 4; i++) {
      const x = v.width * (0.2 + i * 0.2);
      ctx.beginPath();
      ctx.moveTo(v.width / 2 + (x - v.width / 2) * 0.12, v.height * 0.35);
      ctx.lineTo(x, v.height);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The body driving a given track.
   *
   * Solo is ALWAYS slot 0 whoever the tracker calls primary — the same rule
   * every other game on the roster follows, and the reason a bystander drifting
   * into slot 1 cannot silently take the round away from the person playing.
   */
  private playerFor(slot: number): TrackedPlayer | undefined {
    if (this.playerCount > 1) return this.players.find((p) => p.slot === slot);
    return this.players[0];
  }

  protected onRender(fc: FrameContext, _players: TrackedPlayer[]): void {
    const count = Math.max(1, this.playerCount);
    for (let slot = 0; slot < count; slot++) {
      const s = this.slots[slot];
      if (!s) continue;
      const rect = this.slotRect(fc.v, slot);
      this.drawLaneIndicator(fc, s, rect);
      this.drawActionPills(fc, s, rect);
      this.drawSpeed(fc, s, rect);
      this.drawStreak(fc, s, rect);
    }
  }

  /**
   * The single most important piece of 2D in this game.
   *
   * It is the only thing that tells a player whether the camera saw them step.
   * Without it, someone whose lane change didn't register has no way to tell
   * that from the game being broken, and at a stall there is nobody free to
   * explain the difference.
   */
  private drawLaneIndicator(fc: FrameContext, s: RunnerLane, rect: SlotRect): void {
    const { ctx, v } = fc;
    // vh is the right unit for a TV (ARCHITECTURE hard rule 7), but a narrow
    // aspect makes vh-wide rows collide, so widths also get a width-relative
    // ceiling. In versus the slot is HALF the screen, so the ceiling is
    // measured against the slot rather than the viewport — otherwise three
    // pills sized for a whole TV overflow their own half.
    const w = Math.min(vh(v, 7), rect.width * 0.16);
    const h = vh(v, 1.5);
    const gap = Math.min(vh(v, 1.4), rect.width * 0.03);
    const y = v.height - vh(v, 9);
    const cx = rect.centerX;

    // Three sticker pills. The occupied lane is a flat blue sticker with an ink
    // outline and a hard shadow; the other two are the brand's empty slot —
    // paper, muted outline, sitting flat with no lift.
    //
    // The blurred halo this replaced set `shadowBlur` inside this loop, so the
    // canvas was charged for a blur on every one of the three fills, every
    // frame, for the whole round. A second flat fill offset on Y says the same
    // thing and is effectively free.
    for (let lane = -1; lane <= 1; lane++) {
      const x = cx + lane * (w + gap) - w / 2;
      const active = lane === s.laneTarget;
      stickerPill(ctx, v, x, y, w, h, {
        fill: active ? COLORS.blue : COLORS.paper,
        outline: active ? COLORS.ink : COLORS.muted,
        outlineWidth: vh(v, active ? STROKE.base : STROKE.thin),
        shadow: active ? vh(v, SHADOW.base) : 0,
      });
    }

    // The only place the game names its own control. It was 1.5vh of muted
    // grey — 16px at 1080p at 1.9:1 contrast — which is a control instruction
    // that cannot be read from the place the player is standing.
    // BELOW the action pills, not between them. At 1.5vh the line was short
    // enough to sit in the gap; at a size anyone can actually read it is ~300px
    // wide and runs straight under JUMP and SLIDE, which sit at +-34% of the
    // width with a 4.2vh pill body. Pills bottom out at height-6.15vh.
    // KNOCKOUT, like every other HUD string in this file.
    //
    // Runner had none at all — the only game whose playfield is a full-bleed
    // 3D scene, and therefore the one where it matters most. Balloon Pop, whose
    // balloons merely drift past, has four. Every label here sits on a moving
    // track with obstacles sliding under it; the speed readout in particular
    // spends a good part of each round on top of a green pad.
    //
    // On paper the knockout is paper-on-paper and draws nothing, so it costs
    // two strokeText calls and only shows up when it is earning its place.
    drawText(ctx, '<STEP LEFT OR RIGHT>', cx, y + vh(v, 5.6), {
      size: vh(v, 2),
      knockout: true,
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: '0.2em',
    });
  }

  private drawActionPills(fc: FrameContext, s: RunnerLane, rect: SlotRect): void {
    const { v } = fc;
    const y = v.height - vh(v, 9) + vh(v, 0.75);
    const offset = Math.min(vh(v, 20), rect.width * 0.34);

    // Colours match the obstacles they clear: green pill / green barrier,
    // yellow pill / yellow barrier. The mapping is never written down anywhere,
    // it is just consistently true, which is how a stranger picks it up.
    this.actionPill(fc, rect, rect.centerX - offset, y, 'JUMP', COLORS.green, this.airborneAt(s, s.clock));
    this.actionPill(fc, rect, rect.centerX + offset, y, 'SLIDE', COLORS.yellow, this.slidingAt(s, s.clock));
  }

  /**
   * One action's state, as a sticker pill.
   *
   * Firing = the brand colour becomes the SURFACE and the label on it is ink.
   * Flat green and flat yellow cannot carry type on paper at three metres, so
   * the colour has to be the fill rather than the text — the same call
   * `drawTargetMarker` in games/base.ts makes, for the same reason.
   *
   * Idle = the brand's disabled state: paper, muted outline, muted label, no
   * lift. Nothing here blurs; `shadowBlur` was being set twice per frame for
   * two pills and is charged on every draw call that follows it.
   */
  private actionPill(
    fc: FrameContext,
    rect: SlotRect,
    cx: number,
    cy: number,
    label: string,
    color: string,
    active: boolean
  ): void {
    const { ctx, v } = fc;
    const w = Math.min(vh(v, 13), rect.width * 0.22);
    const h = vh(v, 4.2);

    stickerPill(ctx, v, cx - w / 2, cy - h / 2, w, h, {
      fill: active ? color : COLORS.paper,
      outline: active ? COLORS.ink : COLORS.muted,
      outlineWidth: vh(v, active ? STROKE.base : STROKE.thin),
      shadow: active ? vh(v, SHADOW.lifted) : 0,
    });

    // INK EVEN WHEN IDLE. These two words are the game's only statement that
    // jumping and sliding exist at all, and in the kit's disabled grey they
    // were legible only while the player was already doing the thing they
    // were supposed to be teaching. The pill still reads as not-firing from
    // its paper fill, thin outline and missing lift.
    drawText(ctx, label, cx, cy, {
      knockout: true,
      size: vh(v, 1.9),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: '0.18em',
    });
  }

  /**
   * The speed gauge: a vertical progress bar, built the same way `progressBar`
   * in engine/draw.ts builds a horizontal one — grid-coloured track, flat brand
   * fill, ink outline, no blur.
   *
   * The fill used to be `lerpColor(blue → yellow)`, which is a gradient between
   * two brand colours evaluated per frame: off-brand twice over, and at any
   * given speed it rendered as a muddy in-between green that is not in the
   * palette at all. It is now flat blue, or flat red while a collision penalty
   * is still being paid off — two brand colours, never both at once.
   */
  private drawSpeed(fc: FrameContext, s: RunnerLane, rect: SlotRect): void {
    const { ctx, v } = fc;
    const x = rect.x + rect.width - Math.min(vh(v, 6), rect.width * 0.09);
    const top = vh(v, 30);
    const height = vh(v, 26);
    const width = vh(v, 1.6);

    const norm = Math.max(
      0,
      Math.min(1, (s.speed - START_SPEED * MOMENTUM_FLOOR) / (MAX_SPEED - START_SPEED * MOMENTUM_FLOOR))
    );
    const slowed = s.penalty > 0.01;
    const color = slowed ? COLORS.red : COLORS.blue;

    ctx.save();
    ctx.shadowBlur = 0;

    ctx.fillStyle = COLORS.grid;
    roundRect(ctx, x - width / 2, top, width, height, width / 2);
    ctx.fill();

    const fill = Math.max(height * norm, width);
    ctx.save();
    roundRect(ctx, x - width / 2, top, width, height, width / 2);
    ctx.clip();
    ctx.fillStyle = color;
    roundRect(ctx, x - width / 2, top + height - fill, width, fill, width / 2);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = vh(v, STROKE.thin);
    roundRect(ctx, x - width / 2, top, width, height, width / 2);
    ctx.stroke();
    ctx.restore();

    // Tabular: this number changes every frame, and in proportional figures a
    // decimal readout shuffles sideways the whole round.
    drawTabularNumber(ctx, s.speed.toFixed(1), x, top + height + vh(v, 3), {
      size: vh(v, 2.4),
      knockout: true,
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.black,
      letterSpacing: TRACK.number,
    });
    drawText(ctx, 'M/S', x, top + height + vh(v, 5.5), {
      size: vh(v, 1.8),
      knockout: true,
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: '0.2em',
    });
  }

  /**
   * The combo readout. This is the live "thing to beat" for this game: it is
   * the number that separates a good run from a flailing one, and it is the
   * thing the player can see climbing while they play.
   */
  private drawStreak(fc: FrameContext, s: RunnerLane, rect: SlotRect): void {
    const { ctx, v } = fc;
    const x = rect.x + Math.min(vh(v, 4), rect.width * 0.06);
    // Below the HUD band's ink rule, which sits at `hudBottom`.
    const y = vh(v, 34);
    const h = vh(v, 5.4);
    const maxed = s.streak >= STREAK_CAP;
    const running = s.streak >= 1;

    // Red while a collision is still being paid off, green at the cap, yellow
    // climbing. One at a time, always flat, so the component never carries more
    // than one brand colour plus ink.
    const color = s.penalty > 0.01 ? COLORS.red : maxed ? COLORS.green : COLORS.yellow;
    const text = `×${(running ? this.momentum(s) : 1).toFixed(2)}`;

    // A number PILL rather than coloured type. Flat yellow and flat green are
    // unreadable as text on paper, so the colour becomes the surface and the
    // figure on it is ink — and it means the readout no longer needs the
    // `shadowBlur: 24` halo it used to wear to be visible at all.
    //
    // `idlePulse` scales rather than fades, and it returns its rest value under
    // prefers-reduced-motion, so the cap still announces itself without a
    // brand colour ever being drawn at partial opacity.
    const pulse = maxed ? 1 + idlePulse(fc.time, 9, 0) * 0.05 : 1;

    const size = h * 0.52;
    const w = measureTabularNumber(ctx, text, size, WEIGHT.black, FONTS.body) + h * 0.9;

    ctx.save();
    ctx.translate(x + w / 2, y);
    ctx.scale(pulse, pulse);
    stickerPill(ctx, v, -w / 2, -h / 2, w, h, {
      fill: running ? color : COLORS.paper,
      outline: running ? COLORS.ink : COLORS.muted,
      outlineWidth: vh(v, running ? STROKE.base : STROKE.thin),
      shadow: running ? vh(v, SHADOW.base) : 0,
    });
    drawTabularNumber(ctx, text, 0, 0, {
      knockout: true,
      size,
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.black,
      letterSpacing: TRACK.number,
    });
    ctx.restore();

    const label = !running ? 'CLEAR TO SPEED UP' : maxed ? 'MAX SPEED' : `${s.streak} CLEAN`;
    drawText(ctx, label, x, y + h * 0.5 + vh(v, 2.6), {
      knockout: true,
      size: vh(v, 1.9),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: '0.16em',
      align: 'left',
    });
  }

  protected override onRenderHud(fc: FrameContext, slot: number, rect: SlotRect): void {
    const score = this.scoreFor(slot);
    // NOT WHEN THE HUD IS ALREADY SAYING IT — see chaseLineOwnsBoardRank. The
    // note below records moving this sticker out from under the chase line
    // because it was "covering the live thing to beat with a second copy of
    // roughly the same information". That treated the collision; this treats
    // the duplication. With a ghost loaded the chase line is racing the
    // player's own best, which is a different race, and the sticker returns.
    if (this.chaseLineOwnsBoardRank(slot)) return;
    const preview = leaderboard.previewRank('runner', score);
    if (preview.pointsToNext !== null && preview.nextRank !== null && score > 0) {
      this.drawTargetMarker(
        fc,
        rect.centerX,
        // Below the HUD band. At 27vh this 3.2vh sticker overlapped the chase
        // line at 26 — covering the live "thing to beat" with a second copy of
        // roughly the same information.
        this.hudBottom(fc.v) + vh(fc.v, 2.6),
        `${preview.pointsToNext}m TO #${preview.nextRank}`
      );
    }
  }

  /* ---------------- diagnostics ---------------- */

  /**
   * Machine-readable state for the browser harness and the operator console.
   *
   * Everything the "does the input actually move the player" question needs to
   * be answered numerically rather than by squinting at a screenshot.
   */
  debugState(slot = 0): Record<string, unknown> {
    const s = this.slots[slot] ?? this.slots[0]!;
    const next = s.rows.find((r) => r.z >= s.distance && !r.resolved);
    return {
      state: this.state,
      playerCount: this.playerCount,
      slot,
      timeLeft: +this.timeLeft.toFixed(3),
      clock: +s.clock.toFixed(3),
      distance: +s.distance.toFixed(3),
      bonus: +s.bonus.toFixed(3),
      score: this.scoreFor(slot),
      speed: +s.speed.toFixed(3),
      momentum: +this.momentum(s).toFixed(3),
      penalty: +s.penalty.toFixed(3),
      lane: s.laneTarget,
      laneX: +s.laneX.toFixed(3),
      detectorLane: s.lanes.current,
      airborne: this.airborneAt(s, s.clock),
      sliding: this.slidingAt(s, s.clock),
      feet: +this.feetAt(s, s.clock).toFixed(3),
      head: +this.headAt(s, s.clock).toFixed(3),
      crouchVisual: +s.crouchVisual.toFixed(3),
      hits: s.hits,
      rowsCleared: s.rowsCleared,
      nearMisses: s.nearMisses,
      streak: s.streak,
      bestStreak: s.bestStreak,
      rows: s.rows.length,
      generatorRejected: s.gen.rejected,
      generatorPushed: s.gen.pushed,
      worlds: RunnerWorld.liveCount,
      gfx: this.world?.stats ?? null,
      nextRow: next
        ? { z: +next.z.toFixed(2), rel: +(next.z - s.distance).toFixed(2), cells: next.cells.map((c) => `${c.lane}:${c.kind}`) }
        : null,
    };
  }

  /** Replaces the live track with a hand-built one. Test hook. */
  debugSetRows(rows: TrackRow[], slot = 0): void {
    const s = this.slots[slot];
    if (s) s.rows = rows;
  }

  debugRows(slot = 0): TrackRow[] {
    return this.slots[slot]?.rows ?? [];
  }

  debugValidate(slot = 0): ReturnType<typeof validateRows> {
    return validateRows(this.debugRows(slot));
  }

  debugSelfTest(runs?: number, metres?: number): ReturnType<typeof selfTestGeneration> {
    return selfTestGeneration(runs, metres);
  }
}
