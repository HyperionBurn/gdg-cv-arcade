/**
 * BALLOON POP — "the accessible one".
 *
 * PLAN.md §3: "Not everyone will flail in front of a crowd — shy people, staff,
 * someone in formal dress, a kid dragged along by a sibling. Every stall needs
 * a game with a zero-embarrassment floor, and it's also the fastest
 * queue-overflow valve."
 *
 * So the design brief is unusual: this game is NOT trying to be the most
 * exciting thing on the roster. It is trying to be the one nobody can refuse.
 * That means:
 *   - playable standing still, hands only, no jumping or big movement
 *   - reachable without stretching (balloons drift through the comfortable zone)
 *   - impossible to be visibly bad at — there is no fail state at all
 *   - still satisfying, because a pop is inherently satisfying
 *
 * It shares the blade layer with Fruit Ninja but uses TOUCH rather than swipe:
 * you do not need to move fast, only to be there. That is the whole difference
 * in accessibility.
 *
 * BRAND: a balloon is a sticker. Flat brand fill, chunky ink outline, hard
 * shadow straight down, and a flat paper highlight — which is what still makes
 * it read as a balloon rather than a disc, and which survives "no gradients"
 * because it was never a gradient in the first place, only a white shape.
 *
 * The arming line is now carried by COLOUR rather than by fading the balloon
 * in. A balloon below your shoulders is flat muted grey; the moment it is live
 * it is flat brand colour. That is a state change instead of a tint, and it is
 * a far clearer signal at three metres than an opacity ramp ever was.
 */

import { BladeTracker, type Blade } from '../core/blades';
import { POSE } from '../core/types';
import type { TrackedPlayer } from '../core/tracker';
import { GameBase, type SlotRect } from './base';
import { BURST } from '../engine/particles';
import { audio } from '../engine/audio';
import {
  drawTabularNumber,
  labelPill,
  measureTabularNumber,
  stickerPill,
  vh,
} from '../engine/draw';
import type { Viewport } from '../engine/draw';
import { COLORS, PLAYER_COLORS, FONTS, SHADOW, STROKE, TRACK, WEIGHT } from '../shell/theme';
import { GAME_COLORS } from '../meta/games';
import type { FrameContext } from '../shell/screen';

interface Balloon {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  color: string;
  slot: number;
  /** Horizontal sway. */
  phase: number;
  /** Golden balloons are worth more and drift faster. */
  golden: boolean;
  /** 0..1 squash when a hand is near, telegraphing the pop. */
  squash: number;
}

/**
 * Balloons only become poppable ABOVE THE PLAYER'S SHOULDER LINE.
 *
 * Without an arming rule the game plays itself: balloons spawn at the bottom
 * and rise, and a player standing normally has their hands at hip height —
 * directly in the flight path. Measured in the sim, a player with hands down,
 * not moving at all, scored 36 points in two seconds.
 *
 * The first fix used a fixed fraction of screen height, which was wrong for
 * exactly the reason every other threshold in this codebase is body-relative:
 * where someone's hands rest in frame depends entirely on their height and how
 * far back they stand. A fixed line was still above the sim player's hips.
 *
 * Shoulder-relative is the correct frame. It means the same thing for everyone:
 * lift your hands up. Which is also the motion we want — hands up, in front of
 * you, no jumping, no stretching.
 *
 * Offset is in torso units below the shoulder, so there's a little forgiveness.
 */
const ARM_OFFSET_TORSOS = 0.25;
/** Used when nobody is tracked, purely so balloons render sensibly. */
const ARM_FALLBACK = 0.55;

const BALLOON_COLORS = [COLORS.blue, COLORS.red, COLORS.green, COLORS.yellow] as const;

/**
 * How long into a round the "hands up" hint can still appear.
 *
 * Long enough for somebody who spent the countdown reading the tagline rather
 * than getting ready, short enough that it is gone well before the round has
 * any shape to it. See `drawArmHint`.
 */
const ARM_HINT_SEC = 7;

/**
 * Half the width of the band balloons rise through, in TORSO UNITS either side
 * of the player's own body centre.
 *
 * THIS GAME PROMISES "reachable without stretching". It was not keeping that
 * promise on a television.
 *
 * Balloons used to spawn across the middle 70% of the SLOT RECT, which is a
 * fraction of the screen and has nothing to do with where a person's hands can
 * go. MEASURED at 1280x720 with the simulator's 3m framing (torso = 0.216 of
 * frame height, so one torso unit = 156 screen px):
 *
 *   spawn band, screen-relative (0.15-0.85 of 1280)      896 px
 *   a player's FULL stretched reach, both arms            ~490 px
 *   the sim player's relaxed pumping arc                  ~230 px
 *
 * So roughly 45% of balloons were outside the reach of someone standing with
 * their feet planted, and a player who stood slightly off-centre lost more on
 * one side. The fix is the one this codebase applies to every other threshold:
 * make it body-relative. 1.25 torso units matches Rhythm Punch's
 * LANE_HALF_TORSOS, which was chosen for exactly this question — its outer
 * targets sit at ~1.0 and are described as reachable without a lunge.
 *
 * Still clamped inside the slot, so a player standing at the very edge of frame
 * does not get balloons drawn off-screen.
 */
const REACH_HALF_TORSOS = 1.25;

/** See the identical constants and the full derivation in games/fruitninja.ts. */
const SOLO_LOCK_KEEP = 0.9;
const SWAP_APART_TORSOS = 0.35;
const SWAP_SETTLE_SEC = 0.25;
const SWAP_STAY_SPIKE = 3;

/**
 * A HAND THAT NEVER MOVES IS NOT PLAYING.
 *
 * This game deliberately has no activation speed — "a hand resting in the right
 * place still pops" is the whole accessibility decision and it stays. But with
 * the arming line as the ONLY gate, the winning strategy was to raise both
 * hands into the balloon stream and then do absolutely nothing.
 *
 * MEASURED, both wrists pinned above the shoulder line for 15s, no motion at
 * all: 64 / 84 / 180 points clean, 126 / 128 / 200 realistic — against 166 for
 * ten seconds of actually reaching for balloons. Parking BEAT playing. A
 * leaderboard that rewards holding still is not a leaderboard.
 *
 * So the gate is ENGAGEMENT, not speed: the hand must have moved at some point
 * recently, not at the instant of contact. Reach for a balloon and stop dead on
 * it and it still pops, which is the promise; hold a pose for fifteen seconds
 * and the field goes inert.
 *
 * MEASURED blade speed, screen-heights/sec, steady state (first 150 frames of
 * settling excluded, 1000+ samples per row):
 *
 *   condition                                p50     p90     p99     max
 *   parked hands, clean                      0       0       0       0
 *   parked hands, realistic                  0.037   0.074   0.111   0.169
 *   parked hands, HOSTILE                    0.071   0.154   0.225   0.292
 *   gentle play (0.5Hz, 45% reach), real     0.154   0.249   1.512   2.086
 *   normal play (1.4Hz), realistic           0.696   1.071   1.392   3.252
 *
 * 0.35 sits above the hostile parked MAXIMUM (0.292) and far below anything a
 * deliberate reach produces — gentle play clears it on every stroke. It is a
 * fraction of screen height per second, like every other speed in this app, so
 * it means the same thing on a laptop and on a 55" TV.
 */
const ENGAGE_SPEED = 0.35;

/**
 * How long a hand stays "engaged" after its last real movement, in ms.
 *
 * This is the accessibility budget. A balloon rises at 0.15-0.26 screen-heights
 * per second through a hit radius of ~0.06, so it is inside a resting hand for
 * roughly 0.5s: 1.2s means reach-and-hold always works, twice over. It is also
 * short enough that a parked hand collects nothing after the first second.
 */
const ENGAGE_WINDOW_MS = 1200;

/**
 * How far OUTSIDE the drawn balloon a hand still pops it, in TORSO UNITS.
 *
 * This replaces `b.r * 1.35`, and the change is the unit as much as the number.
 * A multiple of the balloon's own radius is not a tolerance, it is a tolerance
 * that scales with the target: balloons here are drawn at 0.035-0.063 of screen
 * height, so 1.35x handed the BIGGEST balloons the most slack and the small
 * fast golden ones the least — the opposite of what difficulty wants, and not
 * body-relative at all, which is the one thing every threshold in this codebase
 * has to be.
 *
 * MEASURED at the stall's 3m framing (one torso = 0.216 of screen height), slop
 * beyond the drawn edge under the old rule:
 *
 *   balloon          drawn r (torsos)   old slop (torsos)   new slop
 *   golden           0.162              0.057               0.040
 *   smallest normal  0.208              0.073               0.040
 *   largest normal   0.292              0.102               0.040
 *
 * WHY IT READ AS "TOO FAR". The hand marker is drawn at vh 2.6 = 0.120 torsos.
 * Subtract the slop and that is how much of the marker is inside the balloon at
 * the instant it pops: 0.018 torsos — under 3 PIXELS at 720p — for the largest
 * balloons. A playtester asked to "decrease the range at which they register as
 * a strikeable object", and a pop that fires on a 3px graze is that.
 *
 * WHY 0.04 AND NOT LESS. MEASURED, simulator, a driver that actually reaches
 * for the nearest armed balloon (rather than the flailing the smoke probe
 * does), REALISTIC noise, 25s rounds, 5 repeats per row:
 *
 *   slop (torsos)   score (mean)   golden popped   pops   pop distance p50/p90
 *   0.077 (= 1.35x) 1257           5.0             45.6   0.300 / 0.348 torsos
 *   0.040           1274           5.8             42.8   0.270 / 0.313
 *   0.020           1165           4.2             41.4   0.242 / 0.286
 *   0.000           942            2.4             39.0   0.220 / 0.264
 *
 * 0.04 is the last value that costs a competent player nothing — the score is
 * flat from 0.077 down to it and falls off below. It also fixes golden, which
 * the old size-proportional rule was quietly punishing twice (smaller AND
 * faster). Over a longer 33s run the worst case moves from 1.47 balloon radii
 * to 1.24, and the marker/balloon overlap at the pop goes from 8px to 15px.
 *
 * A hand that merely drifts through the field is hit harder than one that
 * reaches, which is the point: flailing 361 -> 322 while reaching 1572 -> 1660.
 */
const POP_SLOP_TORSOS = 0.04;

/**
 * Torso height as a fraction of screen height, used only for the frame or two
 * before a body is measured. The stall's 3m framing measures 0.216; 0.2 is the
 * conservative direction, because a smaller unit means a smaller slop.
 */
const UNIT_FALLBACK = 0.2;

export class BalloonPopGame extends GameBase {
  private blades = new BladeTracker({
    // Touch, not swipe. Zero activation speed is the entire accessibility
    // decision: a hand resting in the right place still pops.
    activateSpeed: 0,
    deactivateSpeed: 0,
    trailLength: 6,
  });

  private balloons: Balloon[] = [];
  private popped = [0, 0];
  private points = [0, 0];
  private streak = [0, 0];
  private spawnTimer = 0;
  /** Screen-space Y above which balloons are live, per slot. */
  private armLine = [0, 0];
  /** Screen-space body centre and torso size per slot. See REACH_HALF_TORSOS. */
  private bodyX: Array<number | null> = [null, null];
  private bodyUnit = [0, 0];

  /** Tracker id of the body this solo round belongs to. */
  private soloLock = -1;
  private rawWrists = new Map<
    number,
    { lx: number; ly: number; rx: number; ry: number; step: number }
  >();
  private swapUntil = new Map<number, number>();
  /** `fc.now` of each blade's last real movement. See ENGAGE_SPEED. */
  private engagedAt = new Map<string, number>();

  constructor() {
    super({
      gameId: 'balloonpop',
      title: 'BALLOON POP',
      tagline: '<POP THEM WITH YOUR HANDS>',
      // The arming line. `drawArmHint` says this in-round, but only once the
      // round is already running and only to a player standing with their
      // hands down — by which point they have spent several seconds watching
      // a grey field ignore them.
      avoid: 'GREY MEANS TOO LOW',
      visionMode: 'pose',
      maxPlayers: 2,
      roundSeconds: 30,
      color: GAME_COLORS.balloonpop,
      supportsVersus: true,
    });
  }

  protected onStart(): void {
    this.balloons = [];
    this.popped = [0, 0];
    this.points = [0, 0];
    this.streak = [0, 0];
    this.spawnTimer = 0.2;
    this.armLine = [0, 0];
    this.bodyX = [null, null];
    this.bodyUnit = [0, 0];
    // Per-round. A second round must not inherit the first round's locked body
    // or a stale engagement stamp — latched state across rounds is this
    // codebase's recurring bug class.
    this.soloLock = -1;
    this.rawWrists.clear();
    this.swapUntil.clear();
    this.engagedAt.clear();
    this.blades.reset();
  }

  protected scoreFor(slot: number): number {
    return this.points[slot] ?? 0;
  }

  protected primaryLabel(): string {
    return 'SCORE';
  }

  /* ---------------- whose body is this? ---------------- */

  /**
   * A SOLO ROUND IS PLAYED BY ONE BODY: the nearest one.
   *
   * `playerCount` freezes at the start of the round; the tracker does not. A
   * friend leaning into frame mid-round is a second confirmed player, and this
   * game was reading input from both. MEASURED, player motionless while a
   * bystander played for 10s: 42 points appeared on the player's score.
   *
   * Full derivation of SOLO_LOCK_KEEP, and the same helper, in fruitninja.ts.
   */
  private inPlay(players: TrackedPlayer[]): TrackedPlayer[] {
    if (players.length <= 1) {
      this.soloLock = players[0]?.id ?? -1;
      return players;
    }
    const best = new Map<number, TrackedPlayer>();
    for (const p of players) {
      const slot = this.slotOf(p);
      const held = best.get(slot);
      if (!held || p.scale.unit > held.scale.unit) best.set(slot, p);
    }
    if (this.playerCount === 1) {
      const top = best.get(0)!;
      const held = players.find((p) => p.id === this.soloLock);
      if (held && held.scale.unit >= top.scale.unit * SOLO_LOCK_KEEP) best.set(0, held);
      this.soloLock = best.get(0)!.id;
    }
    return [...best.values()];
  }

  /**
   * Drops a body whose left/right labels have just exchanged, until the One
   * Euro filter has finished sliding the wrists across to their new places.
   *
   * See SWAP_SETTLE_SEC in fruitninja.ts for the measured frame-by-frame trace
   * and for why `BladeTracker`'s own version of this test cannot fire.
   */
  private bladeBodies(players: TrackedPlayer[], now: number): TrackedPlayer[] {
    const live = new Set<number>();
    const out: TrackedPlayer[] = [];

    for (const p of players) {
      live.add(p.id);
      const lw = p.raw[POSE.LEFT_WRIST];
      const rw = p.raw[POSE.RIGHT_WRIST];
      const unit = p.scale.unit;

      if (lw && rw && unit > 0) {
        const prev = this.rawWrists.get(p.id);
        let step = prev?.step ?? -1;

        if (prev) {
          // Isotropic: landmark x is normalised by frame WIDTH and y by HEIGHT,
          // so x has to be scaled by the aspect before the two can be combined
          // or compared against a torso height. (ARCHITECTURE.md; the same
          // correction LaneDetector and TPoseDetector needed.)
          const a = p.scale.aspect;
          const d = (ax: number, ay: number, bx: number, by: number): number =>
            Math.hypot((ax - bx) * a, ay - by) / unit;

          const apart = d(prev.lx, prev.ly, prev.rx, prev.ry);
          const stay = d(lw.x, lw.y, prev.lx, prev.ly) + d(rw.x, rw.y, prev.rx, prev.ry);
          const swap = d(lw.x, lw.y, prev.rx, prev.ry) + d(rw.x, rw.y, prev.lx, prev.ly);

          const exchanged =
            step >= 0 &&
            apart >= SWAP_APART_TORSOS &&
            swap < stay * 0.5 &&
            stay >= Math.max(1e-3, step) * SWAP_STAY_SPIKE;

          if (exchanged) this.swapUntil.set(p.id, now + SWAP_SETTLE_SEC * 1000);

          // The baseline deliberately EXCLUDES the spike frame. Folding a swap
          // into it lifts it by an order of magnitude, and the next swap a
          // second later would then be measured against the last one and go
          // unnoticed. ~10-frame time constant: long enough to be a baseline,
          // short enough to follow a player winding up.
          if (step < 0) step = stay;
          else if (!exchanged) step = step * 0.9 + stay * 0.1;
        }

        this.rawWrists.set(p.id, { lx: lw.x, ly: lw.y, rx: rw.x, ry: rw.y, step });
      }

      if (now >= (this.swapUntil.get(p.id) ?? 0)) out.push(p);
    }

    // A kiosk runs for hours; ids never repeat, so these maps would grow for
    // the whole event.
    for (const id of this.rawWrists.keys()) {
      if (!live.has(id)) {
        this.rawWrists.delete(id);
        this.swapUntil.delete(id);
      }
    }

    return out;
  }

  /**
   * The slot a blade or body belongs to. SOLO IS ALWAYS SLOT 0.
   *
   * This is the other half of the bug `updateArmLines` already documents. The
   * arm line was fixed to follow the player's real slot, but `resolvePops` went
   * on crediting `pop(..., blade.slot)` — so the moment a bystander made the
   * player slot 1, every pop landed in `points[1]`, which nothing displays and
   * nothing submits. MEASURED: 52 of a 88-point run vanished into slot 1 while
   * the HUD showed 36.
   */
  private slotOf(of: { slot: number }): number {
    return this.playerCount > 1 ? Math.max(0, Math.min(1, of.slot)) : 0;
  }

  protected onTick(fc: FrameContext, players: TrackedPlayer[], dt: number): void {
    if (!this.proj) return;
    const { v } = fc;

    const mine = this.inPlay(players);
    const project = (nx: number, ny: number) => this.proj!.point({ x: nx, y: ny });
    const blades = this.blades.update(this.bladeBodies(mine, fc.now), project, dt, fc.now);

    this.updateEngagement(blades, v.height, fc.now);
    this.updateArmLines(mine, v.height);

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnWave(fc);
      const progress = 1 - this.timeLeft / this.roundTotal;
      this.spawnTimer = 0.8 - progress * 0.4;
    }

    for (let i = this.balloons.length - 1; i >= 0; i--) {
      const b = this.balloons[i]!;
      b.phase += dt * 1.6;
      b.y += b.vy * dt;
      b.x += b.vx * dt + Math.sin(b.phase) * v.width * 0.02 * dt;
      b.squash = Math.max(0, b.squash - dt * 4);

      if (b.y + b.r < -v.height * 0.05) {
        // A balloon that was LIVE and escaped unpopped breaks the streak.
        //
        // Without this there is no code path that resets it, so "14 STREAK" on
        // the HUD was really "14 pops so far" wearing a streak's clothes — the
        // number could never go down, which makes it meaningless as tension.
        //
        // Deliberately only counts balloons that were armed (above the player's
        // shoulder line). One that drifts past while still grey was never
        // poppable, so missing it is not a miss, and this game's whole promise
        // is that there is no fail state. Losing a streak is not failing — it
        // is the only thing that makes keeping one worth anything.
        if (b.y + b.r < (this.armLine[b.slot] ?? 0)) {
          this.streak[b.slot] = 0;
        }
        this.balloons.splice(i, 1);
      }
    }

    this.resolvePops(fc, blades);
  }

  private spawnWave(fc: FrameContext): void {
    const { v } = fc;
    for (let slot = 0; slot < this.playerCount; slot++) {
      const rect = this.slotRect(v, slot);
      const count = 1 + (Math.random() < 0.45 ? 1 : 0);

      for (let i = 0; i < count; i++) {
        const golden = Math.random() < 0.12;
        const r = v.height * (golden ? 0.035 : 0.045 + Math.random() * 0.018);

        // Spawn inside the player's own reach, not inside a fraction of the
        // screen — see REACH_HALF_TORSOS. Edge spawns force a stretch, and
        // stretching in front of a crowd is exactly what this game exists to
        // avoid.
        const band = this.reachBand(slot, rect, r);

        this.balloons.push({
          x: band.min + Math.random() * (band.max - band.min),
          y: v.height + r * 2,
          vx: (Math.random() - 0.5) * v.height * 0.05,
          vy: -v.height * (golden ? 0.26 : 0.15 + Math.random() * 0.06),
          r,
          color: golden ? COLORS.yellow : BALLOON_COLORS[Math.floor(Math.random() * 4)]!,
          slot,
          phase: Math.random() * Math.PI * 2,
          golden,
          squash: 0,
        });
      }
    }
  }

  /**
   * The horizontal band this slot's balloons rise through, in screen pixels.
   *
   * Centred on the body when one is tracked, and always clamped inside the slot
   * so nothing spawns half off the screen or across the versus divider. Falls
   * back to the old screen-relative band before anybody is anchored, which is
   * only ever the first frame or two of a round.
   */
  private reachBand(slot: number, rect: SlotRect, radius: number): { min: number; max: number } {
    const lo = rect.x + radius;
    const hi = rect.x + rect.width - radius;

    const cx = this.bodyX[slot] ?? null;
    const unit = this.bodyUnit[slot] ?? 0;
    if (cx === null || unit <= 0) {
      return { min: rect.x + rect.width * 0.15, max: rect.x + rect.width * 0.85 };
    }

    const half = unit * REACH_HALF_TORSOS;
    // Shift rather than shrink when the body is near the edge of its slot: a
    // player standing off to one side should still get a full-width spread of
    // balloons, just all on the side they can actually reach.
    let min = cx - half;
    let max = cx + half;
    if (min < lo) {
      max = Math.min(hi, max + (lo - min));
      min = lo;
    }
    if (max > hi) {
      min = Math.max(lo, min - (max - hi));
      max = hi;
    }
    return { min: Math.min(min, max), max: Math.max(min, max) };
  }

  /**
   * Tracks each player's shoulder line in screen space.
   *
   * INDEXED BY THE PLAYER'S OWN SLOT, not by `0..playerCount`.
   *
   * It used to loop `slot < this.playerCount`, so a solo round only ever wrote
   * `armLine[0]`. But the tracker re-sorts slots by screen position every
   * frame while `playerCount` stays frozen for the round — so the moment a
   * bystander stands to the player's left, the PLAYER becomes slot 1, and
   * `armLine[1]` is still its initial 0.
   *
   * The hit test then reads `b.y > (armLine[1] ?? 0)`, and `?? 0` cannot save
   * it because 0 is not nullish. Every balloon on screen is below y=0, so
   * every one is skipped: NOTHING IS POPPABLE. Worse, the draw path uses
   * `|| fallback` instead, so the balloons keep rendering as armed — the
   * player is swiping at bright, live-looking balloons that cannot be hit.
   *
   * At a club fair a friend leaning into frame is a certainty.
   *
   * NOW INDEXED BY `slotOf`, which is the SAME mapping the pop path uses. The
   * two disagreeing is exactly what the note above describes; one of them being
   * right was never enough.
   */
  private updateArmLines(players: readonly TrackedPlayer[], screenH: number): void {
    for (const p of players) {
      const slot = this.slotOf(p);
      if (!this.proj) continue;
      const ls = p.landmarks[POSE.LEFT_SHOULDER];
      const rs = p.landmarks[POSE.RIGHT_SHOULDER];
      if (!ls || !rs) continue;

      const unit = this.proj.len(p.scale.unit);
      const shoulderY = this.proj.y((ls.y + rs.y) / 2);
      const forgiveness = unit * ARM_OFFSET_TORSOS;
      // Ease toward the target so a momentary tracking wobble doesn't make the
      // whole field flicker between armed and dead.
      const target = shoulderY + forgiveness;
      const cur = this.armLine[slot] || target;
      this.armLine[slot] = cur + (target - cur) * 0.15;

      // Where this body actually is, for REACH_HALF_TORSOS. Smoothed on the
      // same easing as the arm line, for the same reason: a spawn band that
      // twitches with tracking noise would scatter balloons unpredictably.
      const cx = this.proj.x((ls.x + rs.x) / 2);
      const heldX = this.bodyX[slot] ?? null;
      this.bodyX[slot] = heldX === null ? cx : heldX + (cx - heldX) * 0.15;
      const heldU = this.bodyUnit[slot] || unit;
      this.bodyUnit[slot] = heldU + (unit - heldU) * 0.15;
    }

    // Any slot nobody occupies keeps the fallback rather than 0, so a stale or
    // unwritten entry can never read as "the line is at the top of the screen".
    for (let i = 0; i < this.armLine.length; i++) {
      if (!this.armLine[i]) this.armLine[i] = screenH * ARM_FALLBACK;
    }
  }

  /**
   * Stamps each blade's last real movement. See ENGAGE_SPEED.
   *
   * Speed, not position: a hand that is somewhere different from where it was
   * is the only evidence available that a person is taking part. Recorded for
   * every blade every frame, and read as a WINDOW at the moment of contact, so
   * this is not a speed gate — the hand may be perfectly still when it pops.
   */
  private updateEngagement(blades: Blade[], screenH: number, now: number): void {
    for (const blade of blades) {
      if (blade.reacquired) continue;
      if (blade.speed / Math.max(1, screenH) >= ENGAGE_SPEED) this.engagedAt.set(blade.id, now);
    }
    // Retire stamps for hands that have left, so a kiosk running all evening
    // does not accumulate one entry per person who ever played.
    if (this.engagedAt.size > 8) {
      for (const [id, at] of this.engagedAt) {
        if (now - at > ENGAGE_WINDOW_MS * 4) this.engagedAt.delete(id);
      }
    }
  }

  private resolvePops(fc: FrameContext, blades: Blade[]): void {
    for (const blade of blades) {
      // Same reason as Fruit Ninja: a snapped blade's position is valid but the
      // motion implied by it is not, and a pop is a statement about a hand
      // having arrived somewhere.
      if (blade.reacquired) continue;

      // Parked hands collect nothing. See ENGAGE_SPEED for the measured table
      // and for why this does NOT break "a resting hand still pops".
      if (fc.now - (this.engagedAt.get(blade.id) ?? -Infinity) > ENGAGE_WINDOW_MS) continue;

      const slot = this.slotOf(blade);
      // `||`, not `??`, and the same shape the arm line uses: a bodyUnit of 0
      // is an unwritten entry, not a body with no height, and multiplying the
      // slop by it would silently turn the tolerance off.
      const unit = this.bodyUnit[slot] || fc.v.height * UNIT_FALLBACK;
      for (let i = this.balloons.length - 1; i >= 0; i--) {
        const b = this.balloons[i]!;
        if (this.playerCount > 1 && b.slot !== slot) continue;
        // Still below the player's shoulder line — see ARM_OFFSET_TORSOS.
        // `||`, not `??`, and the SAME fallback the draw uses: an armLine of 0
        // is not a line at the top of the screen, it is an unwritten entry, and
        // the two paths disagreeing is what made balloons look armed while
        // being unhittable.
        if (b.y > (this.armLine[slot] || fc.v.height * ARM_FALLBACK)) continue;

        // The drawn balloon, plus a fixed body-relative margin. Still forgiving
        // — this game is about inclusion, not precision — but the forgiveness
        // is now the same for every balloon and small enough that the hand
        // marker is visibly two-thirds inside the balloon when it pops. See
        // POP_SLOP_TORSOS for the measured table this came from.
        const hitR = b.r + POP_SLOP_TORSOS * unit;
        const d = Math.hypot(blade.x - b.x, blade.y - b.y);

        if (d < hitR * 2.2) b.squash = Math.min(1, b.squash + 0.5);
        if (d > hitR) continue;

        this.balloons.splice(i, 1);
        this.pop(fc, b, slot);
      }
    }
  }

  private pop(fc: FrameContext, b: Balloon, slot: number): void {
    const { v } = fc;

    const streak = (this.streak[slot] ?? 0) + 1;
    this.streak[slot] = streak;
    this.popped[slot] = (this.popped[slot] ?? 0) + 1;

    const value = b.golden ? 50 : 10;
    const bonus = Math.min(streak - 1, 10) * 2;
    const gained = value + bonus;
    this.points[slot] = (this.points[slot] ?? 0) + gained;
    this.scores[slot]?.set(this.points[slot]!);

    audio.play('pop', 0.9 + Math.min(1.2, streak * 0.045) + (b.golden ? 0.35 : 0));
    this.juice.shake(b.golden ? 0.16 : 0.05);
    if (b.golden) {
      this.juice.flash(COLORS.yellow, 0.22, 6);
      this.juice.hitStop(40);
    }

    BURST.splat(this.particles, b.x, b.y, b.color, b.r / (v.height * 0.045));

    // Popups are ink, because flat yellow type on white paper vanishes at
    // three metres — which is precisely the size of the win this popup is
    // announcing. (The note that used to sit here, about PopupLayer blurring
    // its own fill, is obsolete: no `shadowBlur` survives anywhere in src/.)
    this.popups.spawn(
      b.golden ? `GOLD +${gained}` : `+${gained}`,
      b.x,
      b.y,
      COLORS.ink,
      vh(v, b.golden ? 4 : 2.8)
    );

    if (streak > 0 && streak % 10 === 0) {
      this.popups.spawn(`<${streak} IN A ROW>`, b.x, b.y - vh(v, 5), COLORS.ink, vh(v, 3.6));
      this.juice.shake(0.24);
    }
  }

  protected onRender(fc: FrameContext, _players: TrackedPlayer[]): void {
    const { ctx, v } = fc;

    for (const b of this.balloons) this.drawBalloon(ctx, b, v);

    // Hands are stickers too — a flat brand-colour disc with an ink outline, a
    // hard shadow and a paper centre. It reads as "reach out and touch" the way
    // the old translucent glowing orb did, without the blur or the tint.
    //
    // A hand that has not moved for ENGAGE_WINDOW_MS goes flat muted grey —
    // the same two-state treatment the balloons themselves use for the arming
    // line, and for the same reason: a hand that cannot pop anything must not
    // look like one that can. This is what stops the engagement gate reading as
    // "the game stopped working".
    for (const blade of this.blades.all) {
      const slot = this.slotOf(blade);
      const live = fc.now - (this.engagedAt.get(blade.id) ?? -Infinity) <= ENGAGE_WINDOW_MS;
      const color = this.playerCount > 1 ? PLAYER_COLORS[slot]! : COLORS.blue;
      this.drawHand(ctx, v, blade.x, blade.y, live ? color : COLORS.muted, live);
    }
  }

  private drawHand(
    ctx: CanvasRenderingContext2D,
    v: Viewport,
    x: number,
    y: number,
    color: string,
    live = true
  ): void {
    const r = vh(v, 2.6);
    // Flat on the page when it cannot pop anything — the same treatment an
    // un-armed balloon gets, and the same one `rankedRow` gives an empty place.
    const drop = live ? vh(v, SHADOW.base) : 0;

    ctx.save();
    ctx.shadowBlur = 0;

    if (drop > 0) {
      ctx.fillStyle = COLORS.ink;
      ctx.beginPath();
      ctx.arc(x, y + drop, r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = live ? COLORS.ink : COLORS.muted;
    ctx.lineWidth = vh(v, STROKE.base);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = COLORS.paper;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.34, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawBalloon(ctx: CanvasRenderingContext2D, b: Balloon, v: Viewport): void {
    const screenH = v.height;
    const squash = 1 + b.squash * 0.12;
    const stretch = 1 - b.squash * 0.08;

    // Above the arming line the balloon is live and wears its brand colour;
    // below it, it is flat muted grey. One boolean, two flat states, no ramp —
    // and it only ever crosses once, because balloons rise.
    const line = this.armLine[b.slot] || screenH * ARM_FALLBACK;
    const armed = b.y <= line;
    const fill = armed ? b.color : COLORS.muted;
    const outline = armed ? COLORS.ink : COLORS.muted;
    const stroke = vh(v, armed && b.golden ? STROKE.thick : STROKE.base);
    // Not armed yet = not lifted. Same treatment the brand gives an empty
    // leaderboard place in `rankedRow`: muted, and flat on the page.
    const drop = armed ? vh(v, SHADOW.base) : 0;

    const body = (dy: number): void => {
      ctx.beginPath();
      ctx.ellipse(0, dy, b.r, b.r * 1.16, 0, 0, Math.PI * 2);
    };

    ctx.save();
    ctx.shadowBlur = 0;
    ctx.translate(b.x, b.y);

    // String. Flat ink hairline — the old one was white at 25% on what is now
    // a white page, so it drew nothing at all.
    ctx.strokeStyle = armed ? COLORS.ink : COLORS.muted;
    ctx.lineWidth = Math.max(1, screenH * 0.0016);
    ctx.beginPath();
    ctx.moveTo(0, b.r * 0.95);
    ctx.quadraticCurveTo(
      Math.sin(b.phase) * b.r * 0.4,
      b.r * 1.6,
      Math.sin(b.phase * 0.7) * b.r * 0.2,
      b.r * 2.2
    );
    ctx.stroke();

    ctx.scale(squash, stretch);

    // Hard shadow, straight down, zero blur.
    if (drop > 0) {
      ctx.fillStyle = COLORS.ink;
      body(drop / stretch);
      ctx.fill();
    }

    ctx.fillStyle = fill;
    body(0);
    ctx.fill();

    ctx.strokeStyle = outline;
    ctx.lineWidth = stroke;
    body(0);
    ctx.stroke();

    // Specular highlight — this is what makes it read as a balloon rather than
    // a circle, at basically no cost. A FLAT paper shape, not a gradient and
    // not a translucent white, so it survives the brand unchanged.
    ctx.fillStyle = COLORS.paper;
    ctx.beginPath();
    ctx.ellipse(-b.r * 0.3, -b.r * 0.4, b.r * 0.22, b.r * 0.3, -0.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * A number in a sticker pill, with tabular digits.
   *
   * See the identical note in games/sixtyseven.ts: `labelPill` sets its label
   * in proportional figures, so a live counter jitters sideways as it changes.
   * This belongs in engine/draw.ts as a shared `numberPill`.
   */
  private numberPill(
    ctx: CanvasRenderingContext2D,
    v: Viewport,
    cx: number,
    cy: number,
    text: string,
    h: number,
    fill: string
  ): void {
    const size = h * 0.5;
    const w = measureTabularNumber(ctx, text, size, WEIGHT.black, FONTS.body) + h * 0.8;

    stickerPill(ctx, v, cx - w / 2, cy - h / 2, w, h, {
      fill,
      outline: COLORS.ink,
      outlineWidth: vh(v, STROKE.base),
      shadow: vh(v, SHADOW.base),
    });
    drawTabularNumber(ctx, text, cx, cy, {
      size,
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.black,
      letterSpacing: TRACK.number,
    });
  }

  /**
   * THE ARMING LINE IS THE ONE RULE NOTHING ON SCREEN SAYS OUT LOUD.
   *
   * A balloon below your shoulders is grey and cannot be popped. That is a
   * good rule — it is what stops a player flailing at waist height and
   * clearing the field — and the grey/colour flip is a clear signal ONCE YOU
   * KNOW WHAT IT MEANS. Somebody meeting the game in a queue, standing with
   * their hands at their sides, sees a screen full of grey balloons and a grey
   * hand marker, touches one, and nothing happens. There is no way to tell
   * that from the game being broken, which is the exact failure Red Light had
   * when people read "move" and walked.
   *
   * So: one line, aimed at the player it is about.
   *
   * TIME-BOUNDED **AND** STATE-BOUNDED, unlike Red Light's, and the difference
   * is whose state it reads. There the gate was on ANOTHER racer's progress,
   * so the fastest player pulled the instruction off screen away from the five
   * who still needed it. Here it is this slot's own hands: raising them is
   * both the instruction and the proof it was understood, so hiding it then is
   * correct. The clock cap is the backstop for somebody who never raises them
   * — an instruction nobody is acting on becomes clutter.
   */
  private drawArmHint(fc: FrameContext, slot: number, rect: SlotRect): void {
    const { ctx, v } = fc;
    if (this.roundTotal - this.timeLeft > ARM_HINT_SEC) return;

    const line = this.armLine[slot] ?? v.height * ARM_FALLBACK;
    let armed = false;
    for (const blade of this.blades.all) {
      if (this.playerCount > 1 && this.slotOf(blade) !== slot) continue;
      if (blade.y < line) armed = true;
    }
    if (armed) return;

    labelPill(ctx, v, rect.centerX, v.height * 0.62, 'HANDS UP TO POP', vh(v, 5.4), {
      size: vh(v, 2.8),
      fill: COLORS.yellow,
      color: COLORS.ink,
      outline: COLORS.ink,
      outlineWidth: vh(v, STROKE.base),
      shadow: vh(v, SHADOW.base),
      tilt: -4,
    });
  }

  protected onRenderHud(fc: FrameContext, slot: number, rect: SlotRect): void {
    const { ctx, v } = fc;
    const streak = this.streak[slot] ?? 0;

    this.drawArmHint(fc, slot, rect);

    if (streak >= 3) {
      // Yellow action pill, straight: it carries a number, so it never tilts.
      // Below the HUD band — at 27vh this covered the chase line at 26.
      this.numberPill(
        ctx,
        v,
        rect.centerX,
        this.hudBottom(v) + vh(v, 3.2),
        `${streak} STREAK`,
        vh(v, 4.6),
        COLORS.yellow
      );
    }

    drawTabularNumber(ctx, `${this.popped[slot] ?? 0} POPPED`, rect.centerX, v.height - vh(v, 3), {
      size: vh(v, 2),
      // Balloons drift across this line too. `drawTabularNumber` forwards opts
      // straight to `drawText`, so the knockout comes along per glyph.
      knockout: true,
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: TRACK.pill,
    });
  }
}
