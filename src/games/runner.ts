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
const STREAK_CAP = 12;
const MOMENTUM_PER_STREAK = (MOMENTUM_MAX - 1) / STREAK_CAP;
/** Instant speed cost of a hit, on top of losing the streak. */
const HIT_PENALTY = 0.4;
const PENALTY_CAP = 0.6;
const PENALTY_RECOVERY = 0.12; // per second

/** Longest a held crouch can keep the slide alive, then you must stand up. */
const MAX_SLIDE_HOLD = 1.8;
const SLIDE_LOCKOUT = 0.35;

/** Near-miss tuning. Garnish on top of momentum, never the main course. */
const NEAR_TIME_WINDOW = 0.22; // seconds of margin that still counts as close
const NEAR_LATERAL_WINDOW = 0.9; // metres of gap that still counts as close
const NEAR_MIN_CLOSENESS = 0.16;
const NEAR_MAX_BONUS = 12; // metres

/**
 * What a collision says. PLAN.md: "failure should be funny, never punishing" —
 * so the game reacts like someone tripping over a bin, not like a game over.
 */
const OOF: readonly string[] = ['OOF', 'WHOOPS', 'NOPE', 'SPLAT', 'YIKES', 'OUCH'];

export class RunnerGame extends GameBase {
  private world: RunnerWorld | null = null;
  private worldFailed = false;

  private lanes = new LaneDetector();
  private vert = new VerticalGestures();
  private gen = new TrackGenerator();
  private rows: TrackRow[] = [];

  /** Seconds. Sim time while playing, real time otherwise, always monotonic. */
  private clock = 0;
  private distance = 0;
  private bonus = 0;
  /** Temporary speed cost from recent collisions, 0..PENALTY_CAP. */
  private penalty = 0;
  private speed = START_SPEED;

  private laneTarget = 0;
  private laneX = 0;
  private crouchVisual = 0;

  private airStart = -99;
  private wasAirborne = false;
  private slideStart = -99;
  private slideHoldStart = -99;
  private slideLockUntil = -99;

  /** Obstacle rows cleared without being hit. Drives momentum. */
  private streak = 0;
  private bestStreak = 0;
  private rowsCleared = 0;
  private nearMisses = 0;
  private hits = 0;
  private lastMilestone = 0;

  /** Scroll position used for the attract/countdown idle. */
  private idleZ = 0;

  constructor() {
    super({
      gameId: 'runner',
      title: 'RUNNER',
      // Player-facing, so it takes the brand voice: short, loud, bracketed.
      // It still has to explain all three controls on its own — nobody at a
      // stall gets told how to play.
      tagline: '<STEP TO MOVE — JUMP OVER — CROUCH TO SLIDE>',
      visionMode: 'pose',
      maxPlayers: 1,
      roundSeconds: 60,
      color: GAME_COLORS.runner,
      supportsVersus: false,
      // 3D camera: a camera-space ghost skeleton would straddle the track.
      // The ghost still races through the score line.
      ghostSilhouette: false,
      // Same reason: the track is not in camera space, so a mirrored webcam
      // image behind it is two incompatible spaces stacked on each other.
      cameraGhost: false,
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
    this.rows = [];
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

  protected onStart(): void {
    this.lanes.reset();
    this.vert.reset();
    this.gen.reset();
    this.rows = [];
    this.gen.fill(GENERATE_AHEAD, this.rows);

    this.distance = 0;
    this.bonus = 0;
    this.penalty = 0;
    this.speed = START_SPEED;
    this.laneTarget = 0;
    this.laneX = 0;
    this.crouchVisual = 0;
    this.airStart = -99;
    this.wasAirborne = false;
    this.slideStart = -99;
    this.slideHoldStart = -99;
    this.slideLockUntil = -99;
    this.streak = 0;
    this.bestStreak = 0;
    this.rowsCleared = 0;
    this.nearMisses = 0;
    this.hits = 0;
    this.lastMilestone = 0;
    this.idleZ = 0;
  }

  protected scoreFor(): number {
    return Math.floor(this.distance + this.bonus);
  }

  protected override primaryStat(): string {
    return String(this.scoreFor());
  }

  protected override primaryLabel(): string {
    return 'METRES';
  }

  /* ---------------- player state ---------------- */

  private airborneAt(t: number): boolean {
    return t - this.airStart < JUMP_DURATION && t >= this.airStart;
  }

  private slidingAt(t: number): boolean {
    return t - this.slideStart < SLIDE_DURATION && t >= this.slideStart;
  }

  /** Feet height above the track at time `t`. */
  private feetAt(t: number): number {
    if (!this.airborneAt(t)) return 0;
    return jumpHeight((t - this.airStart) / JUMP_DURATION);
  }

  private headAt(t: number): number {
    return this.feetAt(t) + (this.slidingAt(t) ? CROUCH_HEIGHT : STAND_HEIGHT);
  }

  /* ---------------- input ---------------- */

  /**
   * Runs in EVERY state, not just `playing`.
   *
   * The player controlling the glowing form during the countdown is the whole
   * tutorial. Nobody at a stall reads a tagline; they step sideways, the shape
   * slides sideways, and now they understand the game.
   */
  private updateInput(fc: FrameContext, players: TrackedPlayer[], dt: number): void {
    const p = players[0];

    if (p && p.scale.valid) {
      const lane = this.lanes.update(p, true);
      const changed = this.lanes.changed;
      if (changed !== 0) {
        this.laneTarget = lane;
        this.onLaneChange(fc, Math.sign(changed));
      } else {
        this.laneTarget = lane;
      }

      this.vert.update(p, fc.now);

      if (this.vert.jumped && !this.airborneAt(this.clock)) {
        this.airStart = this.clock;
        // A jump out of a slide is a legitimate cancel — the body cannot do
        // both, and forcing the player to wait for the slide to expire feels
        // like the game ignoring them.
        this.slideStart = -99;
        this.slideHoldStart = -99;
        audio.play('whoosh', 1.25);
        this.world?.impulseDip(-0.12);
      }

      const canSlide = this.clock >= this.slideLockUntil;
      if (this.vert.crouched && canSlide && !this.airborneAt(this.clock)) {
        this.slideStart = this.clock;
        this.slideHoldStart = this.clock;
        audio.play('whoosh', 0.7);
      } else if (this.vert.isCrouching && this.slidingAt(this.clock) && canSlide) {
        // Held crouch keeps the slide alive, up to the hold cap. Past the cap
        // you have to stand up again — squatting for a minute is not a strategy.
        if (this.clock - this.slideHoldStart < MAX_SLIDE_HOLD) {
          this.slideStart = Math.max(this.slideStart, this.clock - SLIDE_DURATION + 0.14);
        } else {
          this.slideStart = -99;
          this.slideLockUntil = this.clock + SLIDE_LOCKOUT;
        }
      }
    }

    // Landing. Detected from the arc, not the detector, so it always lands.
    const airborne = this.airborneAt(this.clock);
    if (this.wasAirborne && !airborne) {
      this.world?.impulseDip(0.34);
      this.juice.shake(0.05);
      audio.play('land', 0.9);
      this.landingDust(fc);
    }
    this.wasAirborne = airborne;

    // Lane tween. Fast enough to feel responsive, slow enough that the camera
    // roll has something to lean against.
    const targetX = LANE_X[Math.max(0, Math.min(2, this.laneTarget + 1))] ?? 0;
    this.laneX += (targetX - this.laneX) * (1 - Math.exp(-dt * 13));

    const crouchTarget = this.slidingAt(this.clock) ? 1 : 0;
    this.crouchVisual += (crouchTarget - this.crouchVisual) * (1 - Math.exp(-dt * 18));
  }

  private onLaneChange(fc: FrameContext, dir: number): void {
    this.world?.impulseRoll(dir * 0.9);
    audio.play('whoosh', 0.95);
    this.juice.shake(0.03);
    const { v } = fc;
    // Ink, not `blueBright`. `*Bright` is the same blue again — it only existed
    // to make the hex read as neon — and flat blue sparks on a paper track are
    // a particle budget spent on almost nothing.
    BURST.spark(
      this.particles,
      v.width / 2 - dir * vh(v, 6),
      v.height * 0.62,
      dir > 0 ? Math.PI : 0,
      COLORS.ink,
      0.5
    );
  }

  private landingDust(fc: FrameContext): void {
    const { v } = fc;
    this.particles.emit({
      x: v.width / 2 + this.laneX * vh(v, 4),
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

    this.penalty = Math.max(0, this.penalty - PENALTY_RECOVERY * dt);
    this.speed = base * this.momentum();

    // Sub-step so nothing tunnels through a 1.4m-deep obstacle at 21 m/s, and
    // so the near-miss sample lands at the true crossing instant.
    const travel = this.speed * dt;
    const steps = Math.max(1, Math.min(6, Math.ceil(travel / 0.4)));
    const sdt = dt / steps;

    for (let i = 0; i < steps; i++) {
      this.clock += sdt;
      const prev = this.distance;
      this.distance += this.speed * sdt;
      this.resolveRows(fc, prev, this.distance);
    }

    this.extendTrack();
    this.milestones(fc);
  }

  private extendTrack(): void {
    if (this.gen.lastZ < this.distance + GENERATE_AHEAD) {
      this.gen.fill(this.distance + GENERATE_AHEAD, this.rows);
    }
    let drop = 0;
    while (drop < this.rows.length && this.rows[drop]!.z < this.distance - RECYCLE_BEHIND) drop++;
    if (drop > 0) this.rows.splice(0, drop);
  }

  private milestones(fc: FrameContext): void {
    const m = Math.floor(this.distance / 250);
    if (m > this.lastMilestone) {
      this.lastMilestone = m;
      // Every popup in this game is INK. PopupLayer draws flat text with no
      // outline behind it, and flat yellow type on white paper is the one brand
      // pairing that vanishes at three metres.
      this.popups.spawn(
        `${m * 250}m`,
        fc.v.width / 2,
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
  private resolveRows(fc: FrameContext, prevZ: number, nowZ: number): void {
    const half = this.halfDepth();

    for (const row of this.rows) {
      if (row.resolved) continue;
      const rel = row.z - nowZ;
      if (rel > half) break; // rows are ordered; nothing further is in range yet

      if (!row.resolved && Math.abs(rel) <= half) {
        if (this.collide(fc, row)) continue;
      }

      // Centre crossing — the tightest point, so the honest place to measure.
      if (!row.resolved && prevZ < row.z && nowZ >= row.z) {
        row.closeness = this.closenessAt(row);
      }

      if (rel < -half) {
        row.resolved = true;
        this.retireRow(fc, row);
        row.closeness = 0;
      }
    }
  }

  /** @returns true if the row was hit this sub-step. */
  private collide(fc: FrameContext, row: TrackRow): boolean {
    const feet = this.feetAt(this.clock);
    const head = this.headAt(this.clock);

    for (const cell of row.cells) {
      if (cell.destroyed) continue;
      const ox = LANE_X[cell.lane + 1] ?? 0;
      if (Math.abs(this.laneX - ox) >= OBSTACLE_HALF_W + PLAYER_HALF_W) continue;

      if (cell.kind === 'low' && feet >= LOW_TOP) continue;
      if (cell.kind === 'high' && head <= HIGH_BOTTOM) continue;

      this.onHit(fc, row, cell.kind);
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
  private closenessAt(row: TrackRow): number {
    let best = 0;
    const t = this.clock;

    for (const cell of row.cells) {
      if (cell.destroyed) continue;
      const ox = LANE_X[cell.lane + 1] ?? 0;
      const overlap = Math.abs(this.laneX - ox) < OBSTACLE_HALF_W + PLAYER_HALF_W;

      if (overlap) {
        if (cell.kind === 'block') continue; // would have been a hit
        let start: number;
        let end: number;
        if (cell.kind === 'low') {
          start = this.airStart + JUMP_DURATION * JUMP_CLEAR.from;
          end = this.airStart + JUMP_DURATION * JUMP_CLEAR.to;
        } else {
          start = this.slideStart;
          end = this.slideStart + SLIDE_DURATION;
        }
        const margin = Math.min(t - start, end - t);
        if (margin < 0) continue;
        best = Math.max(best, 1 - Math.min(1, margin / NEAR_TIME_WINDOW));
      } else {
        const gap = Math.abs(this.laneX - ox) - (OBSTACLE_HALF_W + PLAYER_HALF_W);
        best = Math.max(best, 1 - Math.min(1, gap / NEAR_LATERAL_WINDOW));
      }
    }

    return best;
  }

  /**
   * A row has gone past without hitting the player. Bank the streak, and pay a
   * bonus if it was tight.
   */
  private retireRow(fc: FrameContext, row: TrackRow): void {
    if (row.cells.length === 0) return; // breather rows are not an achievement

    const wasCapped = this.streak >= STREAK_CAP;
    this.streak++;
    this.rowsCleared++;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    if (!wasCapped && this.streak === STREAK_CAP) {
      this.popups.spawn('<MAX SPEED>', fc.v.width / 2, fc.v.height * 0.38, COLORS.ink, vh(fc.v, 4.4));
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
    this.nearMisses++;
    const gained = NEAR_MAX_BONUS * closeness;
    this.bonus += gained;

    const { v } = fc;
    const y = v.height * 0.55;
    const label = `+${Math.round(gained)}`;
    this.popups.spawn(label, v.width / 2, y, COLORS.ink, vh(v, 3.4 + closeness * 1.8));

    audio.play('pop', 1 + Math.min(1.1, this.streak * 0.09 + closeness * 0.25));
    this.juice.shake(0.04 + closeness * 0.06);
    BURST.spark(this.particles, v.width / 2, y, -Math.PI / 2, COLORS.ink, 0.5 + closeness);

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
  private momentum(): number {
    const boost = Math.min(STREAK_CAP, this.streak) * MOMENTUM_PER_STREAK;
    return Math.max(MOMENTUM_FLOOR, Math.min(MOMENTUM_MAX, 1 + boost - this.penalty));
  }

  private onHit(fc: FrameContext, row: TrackRow, kind: ObstacleKind): void {
    row.resolved = true;
    row.closeness = 0;
    this.hits++;
    this.streak = 0;
    this.penalty = Math.min(PENALTY_CAP, this.penalty + HIT_PENALTY);

    const { v } = fc;
    const colour = kind === 'block' ? COLORS.red : kind === 'low' ? COLORS.green : COLORS.yellow;

    this.juice.impact(0.95, COLORS.red);
    this.juice.slowMo(0.45, 2.4);
    this.juice.chromatic(5);
    this.world?.impulseDip(-0.55);
    audio.play('bomb', 0.85);

    BURST.splat(this.particles, v.width / 2 + this.laneX * vh(v, 4), v.height * 0.55, colour, 1.3);

    // Red is the brand's "closed", it is legible flat on paper, and it is the
    // one brand colour this moment is allowed. 'COMBO LOST' is the secondary
    // line under it, so it is muted — `textDim` now resolves to ink, which
    // would have made the small print as loud as the headline.
    const word = OOF[Math.floor(Math.random() * OOF.length)] ?? 'OOF';
    this.popups.spawn(word, v.width / 2, v.height * 0.46, COLORS.red, vh(v, 6));
    this.popups.spawn('COMBO LOST', v.width / 2, v.height * 0.53, COLORS.muted, vh(v, 2.4));
  }

  /* ---------------- render ---------------- */

  protected override onRenderBackground(fc: FrameContext): void {
    const { ctx, v } = fc;
    const playing = this.state === 'playing';

    // Input runs every frame, in every state.
    if (!playing) this.clock += fc.dt;
    this.updateInput(fc, this.players, fc.dt);

    if (!playing) this.idleZ += START_SPEED * fc.dt * (this.state === 'results' ? 0.35 : 0.6);

    const world = this.ensureWorld(v.width, v.height, v.dpr);
    if (!world) {
      this.drawFallbackBackdrop(fc);
      return;
    }

    const speedNorm = Math.max(
      0,
      Math.min(1, (this.speed - START_SPEED) / (MAX_SPEED - START_SPEED))
    );

    const view: WorldView = {
      distance: playing ? this.distance : this.idleZ,
      playerX: this.laneX,
      playerY: this.feetAt(this.clock),
      crouch: this.crouchVisual,
      speed: playing ? this.speed : START_SPEED * 0.6,
      speedNorm: playing ? speedNorm : 0,
      rows: playing ? this.rows : [],
      time: fc.time,
      active: playing,
    };

    world.update(view, fc.dt);
    world.render();
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

  protected onRender(fc: FrameContext, _players: TrackedPlayer[]): void {
    this.drawLaneIndicator(fc);
    this.drawActionPills(fc);
    this.drawSpeed(fc);
    this.drawStreak(fc);
  }

  /**
   * The single most important piece of 2D in this game.
   *
   * It is the only thing that tells a player whether the camera saw them step.
   * Without it, someone whose lane change didn't register has no way to tell
   * that from the game being broken, and at a stall there is nobody free to
   * explain the difference.
   */
  private drawLaneIndicator(fc: FrameContext): void {
    const { ctx, v } = fc;
    // vh is the right unit for a TV (ARCHITECTURE hard rule 7), but a narrow
    // aspect makes vh-wide rows collide, so widths also get a width-relative
    // ceiling. The TV never hits it; a windowed operator screen does.
    const w = Math.min(vh(v, 7), v.width * 0.16);
    const h = vh(v, 1.5);
    const gap = Math.min(vh(v, 1.4), v.width * 0.03);
    const y = v.height - vh(v, 9);
    const cx = v.width / 2;

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
      const active = lane === this.laneTarget;
      stickerPill(ctx, v, x, y, w, h, {
        fill: active ? COLORS.blue : COLORS.paper,
        outline: active ? COLORS.ink : COLORS.muted,
        outlineWidth: vh(v, active ? STROKE.base : STROKE.thin),
        shadow: active ? vh(v, SHADOW.base) : 0,
      });
    }

    drawText(ctx, '<STEP LEFT OR RIGHT>', cx, y + vh(v, 3.4), {
      size: vh(v, 1.5),
      color: COLORS.muted,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: '0.2em',
    });
  }

  private drawActionPills(fc: FrameContext): void {
    const { v } = fc;
    const y = v.height - vh(v, 9) + vh(v, 0.75);
    const offset = Math.min(vh(v, 20), v.width * 0.34);

    // Colours match the obstacles they clear: green pill / green barrier,
    // yellow pill / yellow barrier. The mapping is never written down anywhere,
    // it is just consistently true, which is how a stranger picks it up.
    this.actionPill(fc, v.width / 2 - offset, y, 'JUMP', COLORS.green, this.airborneAt(this.clock));
    this.actionPill(fc, v.width / 2 + offset, y, 'SLIDE', COLORS.yellow, this.slidingAt(this.clock));
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
    cx: number,
    cy: number,
    label: string,
    color: string,
    active: boolean
  ): void {
    const { ctx, v } = fc;
    const w = Math.min(vh(v, 13), v.width * 0.22);
    const h = vh(v, 4.2);

    stickerPill(ctx, v, cx - w / 2, cy - h / 2, w, h, {
      fill: active ? color : COLORS.paper,
      outline: active ? COLORS.ink : COLORS.muted,
      outlineWidth: vh(v, active ? STROKE.base : STROKE.thin),
      shadow: active ? vh(v, SHADOW.lifted) : 0,
    });

    drawText(ctx, label, cx, cy, {
      size: vh(v, 1.9),
      color: active ? COLORS.ink : COLORS.muted,
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
  private drawSpeed(fc: FrameContext): void {
    const { ctx, v } = fc;
    const x = v.width - Math.min(vh(v, 6), v.width * 0.09);
    const top = vh(v, 30);
    const height = vh(v, 26);
    const width = vh(v, 1.6);

    const norm = Math.max(
      0,
      Math.min(1, (this.speed - START_SPEED * MOMENTUM_FLOOR) / (MAX_SPEED - START_SPEED * MOMENTUM_FLOOR))
    );
    const slowed = this.penalty > 0.01;
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
    drawTabularNumber(ctx, this.speed.toFixed(1), x, top + height + vh(v, 3), {
      size: vh(v, 2.4),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.black,
      letterSpacing: TRACK.number,
    });
    drawText(ctx, 'M/S', x, top + height + vh(v, 5.4), {
      size: vh(v, 1.3),
      color: COLORS.muted,
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
  private drawStreak(fc: FrameContext): void {
    const { ctx, v } = fc;
    const x = Math.min(vh(v, 4), v.width * 0.06);
    // Below the HUD band's ink rule, which sits at `hudBottom`.
    const y = vh(v, 34);
    const h = vh(v, 5.4);
    const maxed = this.streak >= STREAK_CAP;
    const running = this.streak >= 1;

    // Red while a collision is still being paid off, green at the cap, yellow
    // climbing. One at a time, always flat, so the component never carries more
    // than one brand colour plus ink.
    const color = this.penalty > 0.01 ? COLORS.red : maxed ? COLORS.green : COLORS.yellow;
    const text = `×${(running ? this.momentum() : 1).toFixed(2)}`;

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
      size,
      color: running ? COLORS.ink : COLORS.muted,
      font: FONTS.body,
      weight: WEIGHT.black,
      letterSpacing: TRACK.number,
    });
    ctx.restore();

    const label = !running ? 'CLEAR TO SPEED UP' : maxed ? 'MAX SPEED' : `${this.streak} CLEAN`;
    drawText(ctx, label, x, y + h * 0.5 + vh(v, 2.4), {
      size: vh(v, 1.4),
      color: COLORS.muted,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: '0.16em',
      align: 'left',
    });
  }

  protected override onRenderHud(fc: FrameContext, _slot: number, rect: SlotRect): void {
    const score = this.scoreFor();
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
  debugState(): Record<string, unknown> {
    const next = this.rows.find((r) => r.z >= this.distance && !r.resolved);
    return {
      state: this.state,
      timeLeft: +this.timeLeft.toFixed(3),
      clock: +this.clock.toFixed(3),
      distance: +this.distance.toFixed(3),
      bonus: +this.bonus.toFixed(3),
      score: this.scoreFor(),
      speed: +this.speed.toFixed(3),
      momentum: +this.momentum().toFixed(3),
      penalty: +this.penalty.toFixed(3),
      lane: this.laneTarget,
      laneX: +this.laneX.toFixed(3),
      detectorLane: this.lanes.current,
      airborne: this.airborneAt(this.clock),
      sliding: this.slidingAt(this.clock),
      feet: +this.feetAt(this.clock).toFixed(3),
      head: +this.headAt(this.clock).toFixed(3),
      crouchVisual: +this.crouchVisual.toFixed(3),
      hits: this.hits,
      rowsCleared: this.rowsCleared,
      nearMisses: this.nearMisses,
      streak: this.streak,
      bestStreak: this.bestStreak,
      rows: this.rows.length,
      generatorRejected: this.gen.rejected,
      generatorPushed: this.gen.pushed,
      worlds: RunnerWorld.liveCount,
      gfx: this.world?.stats ?? null,
      nextRow: next
        ? { z: +next.z.toFixed(2), rel: +(next.z - this.distance).toFixed(2), cells: next.cells.map((c) => `${c.lane}:${c.kind}`) }
        : null,
    };
  }

  /** Replaces the live track with a hand-built one. Test hook. */
  debugSetRows(rows: TrackRow[]): void {
    this.rows = rows;
  }

  debugRows(): TrackRow[] {
    return this.rows;
  }

  debugValidate(): ReturnType<typeof validateRows> {
    return validateRows(this.rows);
  }

  debugSelfTest(runs?: number, metres?: number): ReturnType<typeof selfTestGeneration> {
    return selfTestGeneration(runs, metres);
  }
}
