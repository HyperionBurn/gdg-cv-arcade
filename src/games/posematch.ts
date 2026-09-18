/**
 * POSE MATCH / HOLE IN THE WALL — "the funniest".
 *
 * PLAN.md §3: "a silhouette wall approaches. Match the pose before it hits.
 * Survive as many as possible. Score: walls cleared + match accuracy
 * percentage. 2P: side by side, who matches more. Why: funniest to watch by a
 * distance, and it produces the best photos — which matters when the photobooth
 * lands later."
 *
 * Three things carry this game, in order:
 *
 *  1. THE HOLE IS THE INSTRUCTION. The target pose is not described, listed or
 *     demonstrated — it is the literal hole in the approaching wall. Someone
 *     walking past the stall understands the game before they reach the end of
 *     the table, which is the one sentence PLAN.md §1 says governs every call.
 *
 *  2. THE LIVE STATE TEACHES IT IN ONE ATTEMPT. The player's own skeleton is
 *     drawn in one of three FLAT states — red "NOT YET", yellow "CLOSE", green
 *     "<MATCH>" — with the exact figure next to it as a percentage. Without
 *     this a player who is close has no way to tell whether they are close, and
 *     the failure mode is indistinguishable from the camera being broken.
 *
 *  3. FAILURE IS COMIC. The wall shoves past and keeps going. No red wash, no
 *     buzzer, no elimination. PLAN.md: "Failure should be funny, never
 *     punishing" — and the next person in the queue is learning the game from
 *     watching this one fail.
 *
 * All the actual matching lives in poses.ts.
 *
 * ---------------------------------------------------------------------------
 * BRAND NOTE — what the rebrand changed here, and why
 * ---------------------------------------------------------------------------
 *
 * THE WALL IS SOLID INK. It used to be a near-background-coloured plane with a
 * see-through tint of the slot colour over it and a blurred edge, which meant
 * the single object the whole game is about read as an outline floating in
 * space. Ink is the brand's most emphatic object and it costs nothing out of
 * the ten-percent colour budget, so the wall is now a flat black plane with a
 * person-shaped hole in it and the slot colour spent entirely on the rim of
 * that hole — which is the part the player actually has to read.
 *
 * THE MATCH SIGNAL IS THREE FLAT STATES PLUS A NUMBER, not a three-colour
 * gradient. See `matchColor` in poses.ts for the full argument.
 */

import type { TrackedPlayer } from '../core/tracker';
import { GameBase, type SlotRect } from './base';
import {
  POSES,
  passThreshold,
  passThresholdAt,
  matchColor,
  matchLabel,
  pickPose,
  poseSimilarity,
  drawPoseSilhouette,
  type PoseDef,
  type SegmentGroup,
} from './poses';
import { BURST } from '../engine/particles';
import { audio } from '../engine/audio';
import {
  drawText,
  drawTabularNumber,
  measureTabularNumber,
  measureText,
  graphPaper,
  stickerPill,
  roundRect,
  vh,
  progressBar,
} from '../engine/draw';
import type { Viewport } from '../engine/draw';
import { drawPose, SKELETON_STYLES } from '../engine/skeleton';
import {
  COLORS,
  PLAYER_COLORS,
  FONTS,
  EASE,
  SHADOW,
  STROKE,
  TRACK,
  WEIGHT,
} from '../shell/theme';
import { GAME_COLORS } from '../meta/games';
import { leaderboard } from '../meta/leaderboard';
import type { FrameContext } from '../shell/screen';

/* ---------------- tuning ---------------- */

/**
 * Seconds a wall takes to arrive, at the bottom and the top of the ramp.
 *
 * MEASURED — seconds from a wall appearing until the score first reaches the
 * gate, for a player who takes 0.35s to notice and 0.55s to move, under HOSTILE
 * simulated input (12 poses x 12 reps):
 *
 *                        p50    p90    p99
 *   accurate   (0 deg)   0.73   0.77   0.80
 *   good      (16 deg)   0.75   0.80   0.83
 *   rough     (24 deg)   0.77   0.87   —     (4% never reach an 0.84 gate)
 *
 * So 1.9s at the top of the ramp still leaves a full second of slack after a
 * player has done everything they are going to do, and speed is NOT where this
 * game's difficulty lives — which is why the ramp buys its late-round
 * difficulty with tolerance instead (see `passThresholdAt` in poses.ts). Below
 * about 1.2s these numbers stop having any margin at all and the game would
 * start testing reaction time, which nobody at a stall came for.
 */
const WALL_TIME_START = 4.4;
const WALL_TIME_END = 1.9;

/** Pause between walls. Long enough to read the new hole, short enough to rush. */
const GAP_AFTER_CLEAR = 0.45;
const GAP_AFTER_FAIL = 0.3;
/** How long a failed wall keeps shoving past before it is cleaned up. */
const FAIL_PUSH_SEC = 0.55;

/**
 * The match used at impact is a decaying peak, not the instantaneous value.
 *
 * One Euro is a low-pass filter and MediaPipe drops frames, so the exact frame
 * a wall lands on is a lottery. At 0.5/sec a player who was fully in the pose
 * still clears for just over half a second afterwards, which converts "you hit
 * it a moment ago" from a rejection into a pass. Everything in this file errs
 * that direction on purpose.
 */
const PEAK_DECAY = 0.5;

/** Perspective. z = 1 is the spawn plane, z = 0 is the player's plane. */
const PERSPECTIVE_K = 3.0;
const S_FAR = 1 / (1 + PERSPECTIVE_K);
/** Past the player the wall keeps growing; clamped so it doesn't fill memory. */
const Z_MIN = -0.18;

const VANISH_Y = 0.40;
const BODY_Y = 0.58;
/** Wall plane size as a multiple of the slot, at z = 0. */
const WALL_SPAN = 1.8;
/** Silhouette height as a fraction of the wall plane height. */
const HOLE_FRACTION = 0.42;
/** Extra thickness on the hole rim, in torso units. */
const RIM_GROW = 0.09;

/**
 * Top of the footer shelf, as a fraction of height.
 *
 * The match meter, the pass line, the percent pill, the word and the round
 * average all live below this. Every one of them was drawn bare over a
 * playfield that is a full-opacity ink plane for most of each wall's approach —
 * ink text and an ink-outlined pill on ink. Same fix as the header: give them a
 * paper surface and let the wall pass behind it.
 *
 * 0.845 clears the highest thing in the group (the percent pill's top edge at
 * 0.8635) by 1.85vh.
 */
const FOOTER_TOP = 0.845;

const SHATTER_COLORS = [COLORS.blue, COLORS.red, COLORS.yellow, COLORS.green] as const;

const GROUP_HINT: Record<SegmentGroup, string> = {
  arms: 'ARMS',
  legs: 'LEGS',
  torso: 'LEAN',
};

/* ---------------- state ---------------- */

interface WallState {
  pose: PoseDef;
  /** 1 = far, 0 = at the player. */
  z: number;
  /** Seconds this wall takes to travel from z=1 to z=0. */
  travel: number;
  /**
   * Where this wall sits on the ramp, 0..1. One number drives its speed, its
   * pose and its tolerance, so the three can never disagree about how hard the
   * wall in front of the player is meant to be.
   */
  difficulty: number;
  /**
   * The score this wall opens at — `passThresholdAt(difficulty)`.
   *
   * FIXED AT SPAWN, NOT RECOMPUTED PER FRAME. The ramp moves with the clock, so
   * a live-evaluated gate would slide to the right WHILE the player is holding
   * the pose: the dashed pass line would creep away under them and a hold that
   * was green a moment ago would go yellow with nothing having changed on their
   * side. Whatever the wall asked for when it appeared is what it judges.
   */
  gate: number;
  /** Instantaneous match, 0..1. */
  live: number;
  /** Decaying peak match — this is what the gate reads. */
  best: number;
  worst: SegmentGroup | null;
  resolved: 'clear' | 'fail' | null;
  since: number;
}

interface SlotState {
  wall: WallState | null;
  gap: number;
  cleared: number;
  faced: number;
  /** Sum of best-match at resolution, for the accuracy stat. */
  accuracySum: number;
  /** Recent pose ids, so the same wall never lands twice in a round. */
  recent: string[];
  /** Smoothed screen x the hole tracks, so the wall comes at YOU. */
  holeX: number;
  /** Pop animation on a clear. */
  flash: number;
  /**
   * Colour of the live skeleton: one of the three flat match states. Held
   * across the gap between walls rather than recomputed from a wall that no
   * longer exists — otherwise the player flashes angry red for half a second
   * immediately after clearing, which is the exact opposite of what just
   * happened.
   */
  tint: string;
}

function emptySlot(): SlotState {
  return {
    wall: null,
    gap: 0.6,
    cleared: 0,
    faced: 0,
    accuracySum: 0,
    recent: [],
    holeX: 0,
    flash: 0,
    // Ink before the first wall. Nothing is being asked yet, so nothing is
    // being judged, and spending a brand colour to say "no opinion" is exactly
    // the kind of thing the ten-percent budget is meant to stop. The skeleton
    // only ever turns red/yellow/green once there is a wall to be measured
    // against — and by then there is a wall behind it to read the ink against.
    tint: COLORS.ink,
  };
}

export class PoseMatchGame extends GameBase {
  private slots: SlotState[] = [emptySlot(), emptySlot()];

  /**
   * Offscreen buffer. The hole is punched with `destination-out`, which needs
   * its own surface — the silhouette is a pile of overlapping capsules, so an
   * even-odd fill on the main canvas would XOR the overlaps back to solid and
   * a hip would appear welded shut.
   */
  private buffer: HTMLCanvasElement | null = null;
  private bctx: CanvasRenderingContext2D | null = null;

  constructor() {
    super({
      gameId: 'posematch',
      title: 'POSE MATCH',
      // Player-facing, so it carries the brand voice: the action in brackets,
      // the stakes after it.
      tagline: '<MAKE THE SHAPE OF THE HOLE> BEFORE THE WALL HITS YOU',
      visionMode: 'pose',
      maxPlayers: 2,
      roundSeconds: 60,
      color: GAME_COLORS.posematch,
      supportsVersus: true,
      // This game scores a HELD SHAPE, so its input is the player STOPPING —
      // the one case the `body` preset handles worst. See GameConfig.filterPreset.
      filterPreset: 'poseHold',
      // The wall is an opaque ink plane the width of the screen. Without a
      // shelf the whole HUD spends most of every wall's approach unreadable on
      // top of it. See GameConfig.hudShelf for what else was tried.
      hudShelf: true,
    });
  }

  /* ---------------- lifecycle ---------------- */

  protected onStart(): void {
    this.slots = [emptySlot(), emptySlot()];
  }

  protected scoreFor(slot: number): number {
    return this.slots[slot]?.cleared ?? 0;
  }

  protected primaryStat(slot: number): string {
    return String(this.scoreFor(slot));
  }

  protected primaryLabel(): string {
    return 'WALLS';
  }

  /** Mean match at impact across every wall faced. The secondary stat. */
  private accuracy(slot: number): number {
    const s = this.slots[slot];
    if (!s || s.faced === 0) return 0;
    return s.accuracySum / s.faced;
  }

  /** How far through the round we are, 0..1. */
  private rampProgress(): number {
    const total = Math.max(0.001, this.roundTotal);
    return Math.max(0, Math.min(1, 1 - this.timeLeft / total));
  }

  /**
   * HOW HARD THE NEXT WALL IN THIS SLOT SHOULD BE, 0..1.
   *
   * PLAN.md §3: "walls arrive faster and poses get harder as the round goes
   * on." ONE curve drives all three axes — travel time, which pose is picked,
   * and the tolerance the wall is judged at — so the ramp stays a single thing
   * to tune rather than three that can disagree. It did disagree before this:
   * speed ran off round progress alone while the pose pick ran off round
   * progress PLUS walls cleared, so a player on a streak got harder poses
   * arriving at beginner speed.
   *
   * BOTH TERMS EARN THEIR PLACE. Round progress alone would hand an identical
   * ramp to someone clearing everything and someone who has not cleared a wall
   * yet. Walls cleared alone would let a player who freezes coast at the
   * opening difficulty for a full minute, which is the version of this game
   * that gets boring to watch — and the queue is watching. Cleared count is
   * the smaller term (0.035 a wall, so about 0.5 across a good round) because
   * it is a bonus for doing well, not the ramp itself.
   *
   * In 2P this makes the leading player's walls harder than their opponent's.
   * That is deliberate and it is not new — the pose pick has always read
   * `cleared` — and it is the only thing keeping a duel between a regular and a
   * first-timer interesting for both of them.
   */
  private wallDifficulty(state: SlotState): number {
    // IN VERSUS, BOTH PLAYERS FACE THE SAME CURVE.
    //
    // `state.cleared` is a per-player term, and in a head-to-head that means
    // the player who is AHEAD is handed harder poses and a tighter gate than
    // the player who is behind. As a solo ramp that is exactly right — you earn
    // your difficulty. As a duel it means the two scores are not measuring the
    // same thing, and the leader is punished for leading.
    //
    // So versus escalates on the round clock alone, which both players share.
    if (this.playerCount > 1) return Math.min(1, this.rampProgress() * 0.9);
    return Math.min(1, this.rampProgress() * 0.9 + state.cleared * 0.035);
  }

  /** Seconds a wall at this point on the ramp takes to arrive. */
  private travelTime(difficulty: number): number {
    return WALL_TIME_START + (WALL_TIME_END - WALL_TIME_START) * difficulty;
  }

  /** What a wall spawned right now in slot 0 would get. For `debugState`. */
  private travelTimeNow(): number {
    const state = this.slots[0];
    return this.travelTime(state ? this.wallDifficulty(state) : this.rampProgress() * 0.9);
  }

  private playerFor(players: readonly TrackedPlayer[], slot: number): TrackedPlayer | null {
    if (this.playerCount < 2) {
      // Largest bounding box = nearest to the camera. The tracker still follows
      // up to maxPlayers bodies during a solo round, so taking players[0] would
      // hand the round to whoever the tracker happened to list first — which,
      // at a stall, is as likely to be someone queueing behind the player
      // (PLAN.md §9, "crowd behind player gets tracked").
      let best: TrackedPlayer | null = null;
      for (const p of players) if (!best || p.area > best.area) best = p;
      return best;
    }
    return players.find((p) => Math.max(0, Math.min(1, p.slot)) === slot) ?? null;
  }

  /* ---------------- simulation ---------------- */

  protected onTick(fc: FrameContext, players: TrackedPlayer[], dt: number): void {
    for (let slot = 0; slot < this.playerCount; slot++) {
      const state = this.slots[slot];
      if (!state) continue;

      const rect = this.slotRect(fc.v, slot);
      if (state.holeX === 0) state.holeX = rect.centerX;
      state.flash = Math.max(0, state.flash - dt * 2.4);

      const player = this.playerFor(players, slot);
      this.trackHole(state, rect, player, dt);

      const wall = state.wall;
      if (!wall) {
        state.gap -= dt;
        if (state.gap <= 0) this.spawnWall(state);
        continue;
      }

      if (wall.resolved) {
        wall.since += dt;
        if (wall.resolved === 'fail') {
          wall.z = Math.max(Z_MIN, wall.z - dt / Math.max(0.2, wall.travel * 0.5));
        }
        if (wall.since > (wall.resolved === 'fail' ? FAIL_PUSH_SEC : 0)) {
          state.wall = null;
          state.gap = wall.resolved === 'clear' ? GAP_AFTER_CLEAR : GAP_AFTER_FAIL;
        }
        continue;
      }

      // Live match. Filtered landmarks, not raw: a held pose is exactly the
      // low-frequency signal One Euro is there to clean up.
      if (player) {
        const m = poseSimilarity(player, wall.pose.angles);
        wall.live = m.valid ? m.score : 0;
        wall.worst = m.worstGroup;
      } else {
        wall.live = 0;
      }
      wall.best = Math.max(wall.live, wall.best - PEAK_DECAY * dt);
      state.tint = matchColor(wall.live, wall.gate);

      wall.z -= dt / wall.travel;
      if (wall.z <= 0) {
        wall.z = 0;
        this.resolveWall(fc, slot, state, wall);
      }
    }
  }

  private trackHole(
    state: SlotState,
    rect: SlotRect,
    player: TrackedPlayer | null,
    dt: number
  ): void {
    // Position never affects the score — the hole follows the player purely so
    // the wall reads as coming at THEM rather than at the middle of the screen.
    let want = rect.centerX;
    if (player && this.proj) {
      const margin = rect.width * 0.24;
      want = Math.max(
        rect.x + margin,
        Math.min(rect.x + rect.width - margin, this.proj.x(player.centroid.x))
      );
    }
    const k = Math.min(1, dt * 4);
    state.holeX += (want - state.holeX) * k;
  }

  private spawnWall(state: SlotState): void {
    const difficulty = this.wallDifficulty(state);
    const pose = pickPose(difficulty, state.recent);

    // No-repeat window. MEASURED over 6000 simulated rounds of 15 walls with
    // the nineteen-pose library: window 15 gives 0.00 repeats a round and a
    // mean difficulty-target error of 0.127, and anything from 6 upward is
    // within 0.002 of that — the window stopped fighting the ramp for control
    // of the pick the moment the library got big enough. (With twelve poses it
    // could not: 15 walls out of 12 poses forced 3.0 repeats a round however
    // the window was set, and a window this deep cost 0.163 of targeting.)
    state.recent.push(pose.id);
    if (state.recent.length > Math.max(3, POSES.length - 4)) state.recent.shift();

    state.wall = {
      pose,
      z: 1,
      travel: this.travelTime(difficulty),
      difficulty,
      gate: passThresholdAt(difficulty),
      live: 0,
      best: 0,
      worst: null,
      resolved: null,
      since: 0,
    };
    audio.play('whoosh', 0.7);
  }

  private resolveWall(fc: FrameContext, slot: number, state: SlotState, wall: WallState): void {
    const cleared = wall.best >= wall.gate;
    wall.resolved = cleared ? 'clear' : 'fail';
    wall.since = 0;

    state.faced++;
    state.accuracySum += wall.best;

    const rect = this.slotRect(fc.v, slot);
    const x = state.holeX;
    const y = fc.v.height * BODY_Y;
    const color = this.playerCount > 1 ? PLAYER_COLORS[slot]! : this.config.color;

    state.tint = matchColor(wall.best, wall.gate);

    if (cleared) {
      state.cleared++;
      state.flash = 1;
      this.scores[slot]?.set(state.cleared);

      this.shatter(fc, rect, x, y);
      // Weight the impact by HOW WELL they hit it. This was flat, so a 66%
      // scrape-through landed with exactly the same force as a 99% clean match
      // — even though the percentage is already on screen and already drives
      // the pitch. `best` runs from THIS WALL'S gate to 1, so normalise across
      // that range rather than 0..1, where everything would bunch up at the top.
      const quality = Math.min(
        1,
        Math.max(0, (wall.best - wall.gate) / Math.max(0.01, 1 - wall.gate))
      );
      this.juice.shake(0.18 + 0.16 * quality);
      this.juice.hitStop(Math.round(38 + 30 * quality));
      // Pitch climbs with the streak — PLAN.md §5 calls this the highest-value
      // audio investment, and it is the only "you're on a run" cue that
      // survives a loud hall.
      audio.play('shatter', 0.85 + Math.min(0.9, state.cleared * 0.06));

      this.popups.spawn(wall.pose.name, x, y - vh(fc.v, 10), COLORS.green, vh(fc.v, 4.4), 1.3);
      this.popups.spawn(
        `${Math.round(wall.best * 100)}%`,
        x,
        y - vh(fc.v, 4),
        matchColor(wall.best, wall.gate),
        vh(fc.v, 3)
      );

      if (state.cleared % 5 === 0) {
        this.juice.celebrate(color);
        this.celebrateAt(x, y);
      }
    } else {
      // Comic, not punishing: a shove and a shrug. No flash, no red wash.
      this.juice.shake(0.12);
      audio.play('land', 0.7);
      // `textDim` now resolves to ink, so a "quiet" popup was arriving at full
      // primary weight. Muted is the token that actually means secondary.
      this.popups.spawn('OOF', x, y - vh(fc.v, 8), COLORS.muted, vh(fc.v, 4), 1.1);
      if (wall.worst) {
        this.popups.spawn(
          GROUP_HINT[wall.worst],
          x,
          y - vh(fc.v, 2),
          COLORS.yellow,
          vh(fc.v, 2.4),
          1.1
        );
      }
    }
  }

  private shatter(fc: FrameContext, rect: SlotRect, x: number, y: number): void {
    const { v } = fc;
    // Fragments launched from a ring around the hole, so the wall reads as
    // breaking outward from where the player went through it.
    const ring = 10;
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2;
      const rx = x + Math.cos(a) * rect.width * 0.3;
      const ry = y + Math.sin(a) * v.height * 0.28;
      const color = SHATTER_COLORS[i % SHATTER_COLORS.length]!;
      this.particles.emit({
        x: rx,
        y: ry,
        count: 9,
        color,
        angle: a,
        spread: 1.1,
        speed: 520,
        speedVariance: 380,
        size: vh(v, 0.7),
        life: 0.85,
        lifeVariance: 0.5,
        gravity: 1100,
        drag: 0.95,
        streak: true,
      });
    }
    BURST.celebrate(this.particles, x, y, SHATTER_COLORS, 0.9);
  }

  /* ---------------- render ---------------- */

  /**
   * The substrate: the brand's graph paper, with a second set of rules drawn in
   * PERSPECTIVE on top of it.
   *
   * This used to be two washes of see-through blue. Grid colour is the correct
   * token and it costs nothing out of the colour budget: `COLORS.grid` is what
   * a ruled line on paper looks like in this system, and a perspective grid is
   * still a grid. The wall then arrives as the only black object on a sheet of
   * graph paper, which is exactly the hierarchy this game wants.
   *
   * Flat, full opacity, one hairline weight — no alpha ramp to fake distance.
   * The depth cue is the SPACING (quadratic toward the horizon) and the wall
   * scaling against it, which is what actually reads as approach on a flat TV.
   */
  protected onRenderBackground(fc: FrameContext): void {
    const { ctx, v } = fc;
    const slots = Math.max(1, this.playerCount);

    graphPaper(ctx, v);

    ctx.save();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = Math.max(1, vh(v, 0.18));
    for (let slot = 0; slot < slots; slot++) {
      const rect = this.slotRect(v, slot);
      const vx = rect.centerX;
      const vy = v.height * VANISH_Y;

      // Receding floor. Without a depth cue the wall just scales up, and
      // "getting bigger" does not read as "coming at you" on a flat TV.
      for (let i = 1; i <= 11; i++) {
        const phase = (i + (fc.time * 0.35) % 1) / 12;
        const yy = vy + (v.height - vy) * (phase * phase);
        ctx.beginPath();
        ctx.moveTo(rect.x, yy);
        ctx.lineTo(rect.x + rect.width, yy);
        ctx.stroke();
      }

      for (let i = -6; i <= 6; i++) {
        ctx.beginPath();
        ctx.moveTo(vx, vy);
        ctx.lineTo(vx + i * rect.width * 0.33, v.height);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  protected onRender(fc: FrameContext, players: TrackedPlayer[]): void {
    const { ctx, v } = fc;

    const bctx = this.ensureBuffer(v);
    if (bctx) {
      bctx.save();
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.clearRect(0, 0, this.buffer!.width, this.buffer!.height);
      bctx.restore();

      for (let slot = 0; slot < this.playerCount; slot++) {
        const state = this.slots[slot];
        const wall = state?.wall;
        if (!state || !wall || wall.resolved === 'clear') continue;

        // CLIPPED TO THIS PLAYER'S HALF, and it has to be.
        //
        // Both walls share ONE offscreen buffer, and a wall at impact spans
        // 1.8x its slot rect — 0.9 of the whole viewport in versus — so each
        // one overhangs the divider by up to ~250px at 1024 wide. Slot 1 draws
        // second, so without a clip its opaque plane REPAINTED OVER slot 0's
        // already-punched hole, sealing a hole that player had earned, while
        // its `destination-out` punch CUT A PHANTOM HOLE in slot 0's wall.
        // Photographed with slot 0 at z=0.18 and slot 1 at z=0.02.
        //
        // The clip has to wrap the punch as well as the fill, which is why it
        // is here around the whole call rather than inside `drawWall`.
        const rect = this.slotRect(v, slot);
        bctx.save();
        if (this.playerCount > 1) {
          bctx.beginPath();
          bctx.rect(rect.x, rect.y, rect.width, rect.height);
          bctx.clip();
        }
        this.drawWall(bctx, v, rect, state, wall, slot);
        bctx.restore();
      }
      ctx.drawImage(this.buffer!, 0, 0, v.width, v.height);
    }

    // Player on top of the wall, always visible, in one of the three flat
    // match states.
    //
    // `glow: 0` and `alpha: 1` are both load-bearing. `drawPose`'s halo is
    // three stacked passes at alpha 0.1 / 0.2 / 1 — see-through brand colour,
    // which DESIGN.md rules out — and the old `18 + live * 34` also made the
    // halo WIDTH carry match quality, a second analogue channel nobody can read
    // from 3m. At glow 0 the helper draws exactly one opaque stroke, which is
    // the flat line the brand wants and a third of the fill rate. The line is
    // fattened to compensate: without a halo, weight is the only thing keeping
    // the skeleton legible against a solid ink wall.
    if (this.proj) {
      for (const p of players) {
        const slot = this.playerCount > 1 ? Math.max(0, Math.min(1, p.slot)) : 0;
        const state = this.slots[slot];
        drawPose(ctx, p.landmarks, this.proj, {
          ...SKELETON_STYLES.attract,
          color: state?.tint ?? COLORS.ink,
          lineWidth: Math.max(8, vh(v, 1.7)),
          glow: 0,
          alpha: 1,
        });
      }
    }

    this.drawFooterShelf(fc);

    for (let slot = 0; slot < this.playerCount; slot++) {
      this.drawSlotOverlay(fc, slot);
    }
  }

  /**
   * Paper band under the meter row, with a hard ink rule on top.
   *
   * Drawn once for the whole viewport rather than per slot, so the two-player
   * split does not produce two shelves with a seam between them. Mirrors the
   * header `hudShelf` in `base.ts`; together they frame the playfield, which is
   * the arcade convention and reads as depth rather than as overlap.
   */
  private drawFooterShelf(fc: FrameContext): void {
    const { ctx, v } = fc;
    const y = v.height * FOOTER_TOP;

    ctx.save();
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.rect(0, y, v.width, v.height - y);
    ctx.clip();
    graphPaper(ctx, v);
    ctx.restore();

    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLORS.ink;
    ctx.fillRect(0, y - Math.max(2, vh(v, STROKE.thick)), v.width, Math.max(2, vh(v, STROKE.thick)));
    ctx.restore();
  }

  private ensureBuffer(v: Viewport): CanvasRenderingContext2D | null {
    const w = Math.max(1, Math.round(v.width * v.dpr));
    const h = Math.max(1, Math.round(v.height * v.dpr));

    if (!this.buffer) {
      this.buffer = document.createElement('canvas');
      this.bctx = this.buffer.getContext('2d');
    }
    if (this.buffer.width !== w || this.buffer.height !== h) {
      this.buffer.width = w;
      this.buffer.height = h;
    }
    if (!this.bctx) return null;
    // Work in logical pixels, exactly like the main context.
    this.bctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
    return this.bctx;
  }

  /**
   * The wall: a solid INK plane with a person-shaped hole cut out of it,
   * scaling up in fake perspective. The hole silhouette IS the target pose —
   * there is no other instruction anywhere in the game.
   *
   * WHY INK, AND WHY FULLY OPAQUE.
   *
   * The previous version drew `bgRaised` (which is now simply paper), tinted it
   * with `withAlpha(slotColour, 0.18)`, outlined it with a blurred stroke, and
   * faded the whole plane from 45% to 100% opacity as it approached. Every one
   * of those is a see-through colour, and together they made the one object the
   * game is about read as an outline floating in space rather than as a wall.
   *
   * Flat ink fixes the readability and the brand in the same move. Ink is the
   * brand's most emphatic object; it is the maximum contrast available against
   * a paper background; and it spends nothing from the ten-percent colour
   * budget, which leaves the entire budget for the hole rim — the part the
   * player actually has to read and copy.
   *
   * The distance fade is gone with it. An "approaching" object that is
   * translucent when far away is a lighting effect, not a depth cue; the depth
   * cue is the wall scaling against the fixed perspective grid behind it. The
   * only alpha left is `fade`, which fades the WHOLE wall out after a miss —
   * the one use of transparency the brand permits.
   */
  private drawWall(
    bctx: CanvasRenderingContext2D,
    v: Viewport,
    rect: SlotRect,
    state: SlotState,
    wall: WallState,
    slot: number
  ): void {
    const z = Math.max(Z_MIN, wall.z);
    const s = 1 / (1 + z * PERSPECTIVE_K);
    const k = (s - S_FAR) / (1 - S_FAR);

    const vx = rect.centerX;
    const vy = v.height * VANISH_Y;
    const cx = vx + (state.holeX - vx) * k;
    const cy = vy + (v.height * BODY_Y - vy) * k;

    const w = rect.width * WALL_SPAN * s;
    const h = v.height * WALL_SPAN * s;
    const holeH = h * HOLE_FRACTION;

    const color = this.playerCount > 1 ? PLAYER_COLORS[slot]! : this.config.color;
    const fade = wall.resolved === 'fail' ? 1 - Math.min(1, wall.since / FAIL_PUSH_SEC) : 1;

    bctx.save();
    bctx.globalAlpha = fade;
    bctx.shadowBlur = 0;

    // The plane. One flat ink fill, full opacity, at every distance.
    const radius = vh(v, 1) * s;
    bctx.fillStyle = COLORS.ink;
    roundRect(bctx, cx - w / 2, cy - h / 2, w, h, radius);
    bctx.fill();

    // Panel lines — cheap texture that makes the scale-up read as approach
    // rather than as a rectangle being resized. Paper on ink, so they are the
    // same two neutrals as everything else and spend no colour.
    bctx.strokeStyle = COLORS.paper;
    bctx.lineWidth = Math.max(1, vh(v, 0.14) * s);
    for (let i = 1; i < 6; i++) {
      const px = cx - w / 2 + (w * i) / 6;
      bctx.beginPath();
      bctx.moveTo(px, cy - h / 2);
      bctx.lineTo(px, cy + h / 2);
      bctx.stroke();
    }
    for (let i = 1; i < 4; i++) {
      const py = cy - h / 2 + (h * i) / 4;
      bctx.beginPath();
      bctx.moveTo(cx - w / 2, py);
      bctx.lineTo(cx + w / 2, py);
      bctx.stroke();
    }

    // Edge band, in the slot colour. Chunky and flat — this is the sticker
    // outline of the biggest object in the game, and in versus it is also what
    // tells two players which wall is theirs.
    bctx.strokeStyle = color;
    bctx.lineWidth = Math.max(2, vh(v, STROKE.thick) * s);
    roundRect(bctx, cx - w / 2, cy - h / 2, w, h, radius);
    bctx.stroke();

    // The rim, drawn fat and then cut back by the punch below — so what
    // survives is a flat coloured outline around a real hole.
    //
    // Deliberately NOT one of the three match states: the live skeleton already
    // carries that, and when both used the same colour the target and the
    // player became one yellow mess on screen. The hole stays the slot colour
    // and snaps to green only on a pass, so "you are through" is a state change
    // rather than a shade. Slot colour + green is two brand colours, never
    // three, and never both at once.
    const through = wall.live >= wall.gate;
    drawPoseSilhouette(bctx, wall.pose.angles, {
      cx,
      cy,
      height: holeH * (1 + RIM_GROW),
      color: through ? COLORS.green : color,
      grow: RIM_GROW,
    });
    bctx.restore();

    // Punch. Full alpha so the hole is a real hole regardless of the plane's
    // distance fade.
    bctx.save();
    bctx.globalCompositeOperation = 'destination-out';
    drawPoseSilhouette(bctx, wall.pose.angles, {
      cx,
      cy,
      height: holeH,
      color: '#000000',
    });
    bctx.restore();
  }

  /** Pose name, match meter, accuracy. Everything the player reads mid-round. */
  private drawSlotOverlay(fc: FrameContext, slot: number): void {
    const { ctx, v } = fc;
    const state = this.slots[slot];
    if (!state) return;
    const rect = this.slotRect(v, slot);
    const wall = state.wall;

    // Name. Half the comedy is the caption on what you are being asked to do.
    //
    // ON A STICKER, NOT BARE. This used to be ink text with an ink drop shadow
    // drawn straight onto the playfield, which is correct on paper and
    // invisible the moment the wall's ink plane is behind it — and the plane is
    // behind it for most of every wall's approach. The hole is punched through
    // the plane and slides horizontally, so the caption did not vanish
    // cleanly: it flickered in and out as the hole passed under it, which is
    // worse than either state. A paper pill reads on both surfaces, which is
    // the whole reason this brand's components are stickers.
    if (wall) {
      const pop = 1 + EASE.out(state.flash) * 0.25;
      const size = vh(v, this.playerCount > 1 ? 2.8 : 3.4);
      const cleared = wall.resolved === 'clear';

      // AT THE TOP OF THE PLAYFIELD, NOT ITS MIDDLE. This used to sit at 34vh,
      // which as bare text was fine and as an opaque pill is not: 34vh is the
      // player's own chest. Tucked under the header rule the pill overlaps only
      // the crown of the head, and `matchAngles` scores arms, legs and torso —
      // head position is not part of any pose on the roster, so nothing the
      // player needs to see is behind it.
      ctx.save();
      ctx.translate(rect.centerX, vh(v, 19.4));
      ctx.scale(pop, pop);

      ctx.save();
      ctx.letterSpacing = '0.08em';
      const textW = measureText(ctx, wall.pose.name, size, WEIGHT.black, FONTS.display);
      ctx.restore();

      const pillH = size * 1.75;
      const pillW = textW + size * 1.3;
      stickerPill(ctx, v, -pillW / 2, -pillH / 2, pillW, pillH, {
        fill: cleared ? COLORS.green : COLORS.paper,
        outline: COLORS.ink,
        outlineWidth: vh(v, STROKE.base),
        shadow: vh(v, SHADOW.base),
      });
      drawText(ctx, wall.pose.name, 0, 0, {
        size,
        color: COLORS.ink,
        letterSpacing: '0.08em',
      });
      ctx.restore();
    }

    // Match meter. The threshold tick is the whole point: a player can see how
    // much more they need, not just that they are wrong.
    const live = wall?.live ?? 0;
    const best = wall?.best ?? 0;
    // THE GATE THIS WALL IS JUDGED AT, not the round's opening one. Every
    // channel below reads it — the bar's colour, the dashed pass line, the
    // percentage pill and the word — because they are one signal and a player
    // who sees green must walk through. Between walls there is nothing being
    // asked, so the opening gate stands in and the line does not jump about
    // during the gap.
    const gate = wall?.gate ?? passThreshold();
    const barW = Math.min(rect.width * 0.5, vh(v, 42));
    const barH = vh(v, 1.9);
    const barX = rect.centerX - barW / 2;
    // Pushed down from 0.88 to make room for the impact chip, which used to sit
    // at 0.818 — straddling the footer rule, half on paper and half on the ink
    // wall, which is the one place a sticker looks broken rather than layered.
    const barY = v.height * 0.905;

    // `progressBar` is already the brand component: grid-coloured track, flat
    // fill, ink outline. The glow argument is ignored; passing 0 makes that
    // explicit rather than leaving a number that looks like it does something.
    progressBar(ctx, barX, barY, barW, barH, live, matchColor(live, gate), 0);

    // Decaying peak, shown so the generosity is visible rather than mysterious.
    // Flat ink, full opacity — it is a tick mark, not a ghost.
    if (best > live + 0.02) {
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.fillStyle = COLORS.ink;
      ctx.fillRect(barX + barW * best - vh(v, 0.2), barY - vh(v, 0.5), vh(v, 0.4), barH + vh(v, 1));
      ctx.restore();
    }

    // THE PASS LINE — and, because the tolerance ramps, the one place the game
    // admits it is getting harder.
    //
    // It steps to the right between walls as `passThresholdAt` climbs, on the
    // same bar, next to the same percentage, so "I cleared that at 70% and this
    // one didn't open" has a visible answer instead of feeling like the camera
    // gave up. Nothing else is added to say it: a second badge or a level
    // number would be more to read in the one second between walls, and the
    // line is already the thing a player is watching.
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = vh(v, STROKE.base);
    ctx.setLineDash([vh(v, 0.7), vh(v, 0.55)]);
    ctx.beginPath();
    ctx.moveTo(barX + barW * gate, barY - vh(v, 1.4));
    ctx.lineTo(barX + barW * gate, barY + barH + vh(v, 1.4));
    ctx.stroke();
    ctx.restore();

    // THE NUMBER.
    //
    // DESIGN.md: "when colour conveys meaning, supplement with text, numbers or
    // icons." The skeleton and the bar carry three flat states; this carries the
    // resolution those states deliberately threw away. It is a sticker — flat
    // state fill, ink outline, hard ink shadow — because a pill is the shape
    // this brand uses for "one fact, loudly", and it is sized so the figure is
    // over MIN_LEGIBLE rather than a footnote beside the bar.
    //
    // Tabular, because it changes every frame: proportional figures make a
    // live-updating percentage jitter left and right inside its own pill.
    const stateColor = matchColor(live, gate);
    const pct = `${Math.round(live * 100)}%`;
    const pillH = vh(v, 5.2);
    const pctSize = vh(v, 3.2);
    const pctW = measureTabularNumber(ctx, pct, pctSize, WEIGHT.black, FONTS.display);
    const pillW = pctW + pillH * 0.9;
    const pillCx = barX + barW + vh(v, 2) + pillW / 2;
    const pillCy = barY + barH / 2;

    stickerPill(ctx, v, pillCx - pillW / 2, pillCy - pillH / 2, pillW, pillH, {
      fill: stateColor,
      outline: COLORS.ink,
      outlineWidth: vh(v, STROKE.base),
      shadow: vh(v, SHADOW.base),
    });
    drawTabularNumber(ctx, pct, pillCx, pillCy, {
      size: pctSize,
      color: COLORS.ink,
      weight: WEIGHT.black,
      letterSpacing: TRACK.number,
    });

    // THE WORD. The third channel, so the signal survives a badly calibrated
    // panel, a colour-blind player, or someone reading it from the back.
    drawText(ctx, matchLabel(live, gate), rect.centerX, barY + barH + vh(v, 3.4), {
      size: vh(v, 2.4),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: TRACK.pill,
    });

    // Round accuracy sits at the other end of the same bar. It lived up in the
    // HUD first, where the approaching silhouette covered it — the middle of
    // this screen belongs to the wall, so everything secondary is pushed to the
    // edges.
    const acc = this.accuracy(slot);
    const accLabel = `AVG ${Math.round(acc * 100)}%`;
    drawTabularNumber(ctx, accLabel, barX - vh(v, 2), barY + barH / 2, {
      size: vh(v, 2.2),
      // Secondary by intent. `textDim` now resolves to ink, which made this
      // read at exactly the same weight as the live figure.
      color: COLORS.muted,
      font: FONTS.body,
      weight: WEIGHT.black,
      align: 'right',
      letterSpacing: TRACK.number,
    });

    // Distance-to-impact, so the pressure is visible and not just felt. A
    // sticker again: paper normally, flat red once it is nearly on you.
    if (wall && !wall.resolved) {
      const left = wall.z * wall.travel;
      const urgent = left < 1;
      const chipW = vh(v, 12);
      const chipH = vh(v, 3.4);
      const chipY = v.height * FOOTER_TOP + vh(v, 1);
      stickerPill(ctx, v, rect.centerX - chipW / 2, chipY, chipW, chipH, {
        fill: urgent ? COLORS.red : COLORS.paper,
        outline: COLORS.ink,
        outlineWidth: vh(v, STROKE.base),
        shadow: vh(v, SHADOW.base),
      });
      drawTabularNumber(ctx, `${left.toFixed(1)}s`, rect.centerX, chipY + chipH / 2, {
        size: vh(v, 2.2),
        color: COLORS.ink,
        weight: WEIGHT.black,
        letterSpacing: TRACK.number,
      });
    }
  }

  protected onRenderHud(fc: FrameContext, slot: number, rect: SlotRect): void {
    // PLAN.md §4: "the thing to beat is visible DURING play, not only at the
    // end." Drawn high, above where the wall gets big.
    if (this.playerCount === 1) {
      const preview = leaderboard.previewRank('posematch', this.scoreFor(slot));
      if (preview.pointsToNext !== null && preview.nextRank !== null) {
        this.drawTargetMarker(
          fc,
          rect.centerX,
          vh(fc.v, 27),
          `${preview.pointsToNext} TO #${preview.nextRank}`
        );
      }
    }
  }

  /* ---------------- dev / operator hooks ---------------- */

  /**
   * Snapshot for the headless tests in ARCHITECTURE.md §Testing, and for the
   * operator console later. Read-only.
   */
  debugState(): {
    progress: number;
    travelTimeNow: number;
    playerCount: number;
    passThreshold: number;
    slots: Array<{
      cleared: number;
      faced: number;
      accuracy: number;
      poseId: string | null;
      poseName: string | null;
      /** Where this wall sits on the ramp, 0..1. */
      difficulty: number;
      /** The score THIS wall opens at. Ramps with `difficulty`. */
      gate: number;
      live: number;
      best: number;
      z: number;
      travel: number;
      resolved: string | null;
    }>;
  } {
    return {
      progress: this.rampProgress(),
      travelTimeNow: this.travelTimeNow(),
      playerCount: this.playerCount,
      passThreshold: passThreshold(),
      slots: this.slots.slice(0, Math.max(1, this.playerCount)).map((s) => ({
        cleared: s.cleared,
        faced: s.faced,
        accuracy: s.faced ? s.accuracySum / s.faced : 0,
        poseId: s.wall?.pose.id ?? null,
        poseName: s.wall?.pose.name ?? null,
        difficulty: s.wall?.difficulty ?? 0,
        gate: s.wall?.gate ?? passThreshold(),
        live: s.wall?.live ?? 0,
        best: s.wall?.best ?? 0,
        z: s.wall?.z ?? 1,
        travel: s.wall?.travel ?? 0,
        resolved: s.wall?.resolved ?? null,
      })),
    };
  }

  /**
   * Force the wall in a slot to a specific pose, resetting its approach.
   * Used by the tests to exercise a known pose against a known body, and by the
   * operator console to demo a pose on request.
   *
   * `difficulty` places the forced wall on the ramp, which is what decides its
   * GATE. It defaults to the pose's own difficulty rather than to 0 so that
   * "show me THE VOGUE" demonstrates the wall a player would actually meet,
   * tolerance included — a demo at the opening gate would be a different wall
   * wearing the same silhouette.
   */
  setWallPose(slot: number, poseId: string, travel = 3, difficulty?: number): boolean {
    const state = this.slots[slot];
    const pose = POSES.find((p) => p.id === poseId);
    if (!state || !pose) return false;
    const d = Math.max(0, Math.min(1, difficulty ?? pose.difficulty));
    state.wall = {
      pose,
      z: 1,
      travel: Math.max(0.2, travel),
      difficulty: d,
      gate: passThresholdAt(d),
      live: 0,
      best: 0,
      worst: null,
      resolved: null,
      since: 0,
    };
    return true;
  }

  override unmount(): void {
    super.unmount();
    this.buffer = null;
    this.bctx = null;
  }
}
