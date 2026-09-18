/**
 * 67 SPEED DUEL — "the queue eater".
 *
 * PLAN.md §3: alternate arms up/down as fast as possible, 20 seconds, count
 * reps. Two players on one camera, split screen, racing bars.
 *
 * Why this game carries the stall:
 *   - zero explanation needed, zero skill floor
 *   - two people per turn, which roughly halves queue time
 *   - it is extremely funny to watch, which is what pulls the next person in
 *
 * THE BAR IS THE GAME, so it is drawn as the brand's signature object: a
 * sticker. Paper track, flat fill, chunky ink outline, hard shadow straight
 * down. It fills toward the CURRENT RECORD rather than a fixed target, and the
 * record is a solid ink dashed rule across the track — the thing to beat is a
 * line you can see from the back of the queue.
 *
 * Crossing it is a flat COLOUR CHANGE (player colour → yellow) plus a badge,
 * not a gradient. DESIGN.md caps a component at two brand colours and forbids
 * tints outright; the bar previously lerped red → yellow → white as it filled,
 * which was three colours and two gradients in one object.
 */

import { RepCounter, DEFAULT_REP_TUNABLES } from '../core/gestures';
import { POSE } from '../core/types';
import type { TrackedPlayer } from '../core/tracker';
import { GameBase, type SlotRect } from './base';
import { BURST } from '../engine/particles';
import { audio } from '../engine/audio';
import {
  drawTabularNumber,
  measureTabularNumber,
  labelPill,
  roundRect,
  sticker,
  stickerPill,
  vh,
} from '../engine/draw';
import type { Viewport } from '../engine/draw';
import { COLORS, PLAYER_COLORS, FONTS, SHADOW, STROKE, TRACK, WEIGHT } from '../shell/theme';
import { GAME_COLORS } from '../meta/games';
import { leaderboard } from '../meta/leaderboard';
import { tunables } from '../meta/tunables';
import type { FrameContext } from '../shell/screen';

/** Fallback bar target before anyone has set a record. */
const DEFAULT_TARGET = 55;

/**
 * WHERE THE REP GATE SITS ON THE BODY. Reported from a human playtest as
 * "they had to 67 at a certain angle".
 *
 * The first suspicion was anisotropy — x normalised by frame WIDTH against an
 * isotropic torso unit, the bug already found in three other detectors. IT IS
 * NOT THAT. `ArmPump` compares only Y deltas against `scale.unit`, and
 * `scale.unit` is torso HEIGHT, which a yaw does not change. Driving a rigid
 * yawed body through the real tracker and the real counter (tests/sixtyseven
 * .test.ts, 4Hz for 5s):
 *
 *   body yaw      0deg   30deg   45deg   60deg   75deg
 *   reps            39      39      39      39      39
 *
 * Two things ARE angle-dependent, and neither is a coordinate bug:
 *
 * 1. HOW HIGH YOU HAVE TO LIFT. The old gate needed the wrist 0.12 torso
 *    ABOVE the shoulder, and the cliff was vertical:
 *
 *      wrist peak (torso above shoulder)   -0.05   0.00   0.05   0.10   0.15
 *      reps in 5s, old gate                    0      0      0      0     39
 *      reps in 5s, this gate                   0      0     40     39     39
 *
 *    Five percent of a torso — about 2.5cm — between "the game is broken" and
 *    a perfect run. A player whose pump tops out at their chin got nothing,
 *    found one arm angle that worked, and reported exactly that.
 *
 * 2. OCCLUSION. Turned far enough, MediaPipe's confidence in the far arm falls
 *    under the 0.4 visibility gate and that arm stops counting, halving the
 *    score with no explanation (39 -> 19 reps, measured). No threshold can fix
 *    that, so `drawArmIndicators` now shows it instead — see `armSeen`.
 *
 * THE FIX KEEPS THE ANTI-CHEAT EXACTLY AS STRONG. PLAN.md §3 wants the wrist
 * to cross above the shoulder, and it wants "tiny twitchy hands" rejected. The
 * thing that rejects twitching is the SWING the wrist must travel, which is
 * `upEnter + downEnter` — 0.18 torso before and 0.18 torso after. The whole
 * band simply slides 0.08 torso (~4cm) down the body, so a modest pump crosses
 * it and a twitch still does not:
 *
 *   wrist peak / trough, torso rel. shoulder      old   new
 *   +0.05 / -0.15   (a small but real pump)         0    39
 *   +0.05 / -0.30                                   0    39
 *   +0.10 / -0.40                                   0    39
 *   +0.02 / -0.02   (a twitch on the shoulder)      0     0
 *   +0.03 / -0.12   (swing 0.15, under the band)    0     0
 *    0.00 / -0.50   (big swing, never above)        0     0
 *   -0.05 / -0.60   (ditto, lower)                  0     0
 *
 * Live on the operator console, because the right numbers belong to the bodies
 * that turn up on the day and this is the detector a marshal is most likely to
 * have to reach for.
 */
const REP_GATE = {
  /** Torso units the wrist must rise ABOVE the shoulder to arm a rep. */
  upEnter: 0.04,
  upExit: -0.04,
  /** Torso units the wrist must drop BELOW the shoulder to re-arm. */
  downEnter: 0.14,
  downExit: 0.08,
  minRepIntervalMs: DEFAULT_REP_TUNABLES.minRepIntervalMs,
} as const;

/**
 * Seconds an arm may be unseen before the HUD says so.
 *
 * Long enough that an ordinary blur between frames is not a warning, short
 * enough that a player who has turned too far finds out within one pump.
 */
const ARM_LOST_SEC = 0.8;

/** Visibility below which a landmark does not count. Matches core/gestures.ts. */
const MIN_VISIBILITY = 0.4;

/** Reps per second above which the rate readout becomes a yellow action pill. */
const FAST_RATE = 4;

/** See the identical constant and its derivation in games/fruitninja.ts. */
const SOLO_LOCK_KEEP = 0.9;

export class SixtySevenGame extends GameBase {
  private counters: RepCounter[] = [new RepCounter(), new RepCounter()];
  private target = DEFAULT_TARGET;
  /** Per-slot bar overshoot, for the springy fill. */
  private barPulse = [0, 0];
  private lastRepAt = [0, 0];
  /** Tracker id of the body this solo round belongs to. See `inPlay`. */
  private soloLock = -1;
  /** The bodies `onTick` accepted, so `onRender` draws the same arms. */
  private shown: TrackedPlayer[] = [];
  /** `fc.now` each arm was last actually visible, per slot. See ARM_LOST_SEC. */
  private armSeenAt = [
    { left: 0, right: 0 },
    { left: 0, right: 0 },
  ];

  constructor() {
    super({
      gameId: 'sixtyseven',
      title: '67 SPEED',
      tagline: '<PUMP YOUR ARMS>',
      visionMode: 'pose',
      maxPlayers: 2,
      roundSeconds: 20,
      color: GAME_COLORS.sixtyseven,
      supportsVersus: true,
    });
  }

  protected onStart(): void {
    // Re-read every round, so a marshal moving a slider between plays takes
    // effect on the next turn rather than on the next reload. See REP_GATE.
    const gate = {
      upEnter: tunables.get('sixtyseven.upEnter', REP_GATE.upEnter),
      upExit: tunables.get('sixtyseven.upExit', REP_GATE.upExit),
      downEnter: tunables.get('sixtyseven.downEnter', REP_GATE.downEnter),
      downExit: tunables.get('sixtyseven.downExit', REP_GATE.downExit),
      minRepIntervalMs: REP_GATE.minRepIntervalMs,
    };
    for (const c of this.counters) {
      c.reset();
      c.setTunables(gate);
    }
    this.barPulse = [0, 0];
    this.lastRepAt = [0, 0];
    // Per-round: a second round must not inherit the first round's locked body.
    this.soloLock = -1;
    this.shown = [];
    this.armSeenAt = [
      { left: 0, right: 0 },
      { left: 0, right: 0 },
    ];

    const best = leaderboard.getBest('sixtyseven');
    this.target = best ? Math.max(best.score, 10) : DEFAULT_TARGET;
  }

  protected scoreFor(slot: number): number {
    return this.counters[slot]?.count ?? 0;
  }

  protected primaryStat(slot: number): string {
    return String(this.scoreFor(slot));
  }

  protected primaryLabel(): string {
    return 'REPS';
  }

  /** The slot a body counts into. Solo is always slot 0. */
  private slotOf(of: { slot: number }): number {
    return this.playerCount > 1 ? Math.max(0, Math.min(1, of.slot)) : 0;
  }

  /**
   * Can the camera see all three landmarks this arm's rep gate needs?
   *
   * RAW, and the same three landmarks and the same threshold `ArmPump` itself
   * tests — the indicator exists to report on the counter, so anything it
   * measures differently is worse than not measuring it at all. (That is the
   * mistake the `armUp` note in core/gestures.ts already documents.)
   */
  private armVisible(p: TrackedPlayer, side: 'left' | 'right'): boolean {
    const idx =
      side === 'left'
        ? [POSE.LEFT_WRIST, POSE.LEFT_SHOULDER, POSE.LEFT_ELBOW]
        : [POSE.RIGHT_WRIST, POSE.RIGHT_SHOULDER, POSE.RIGHT_ELBOW];
    for (const i of idx) {
      const lm = p.raw[i];
      if (!lm || lm.visibility < MIN_VISIBILITY) return false;
    }
    return true;
  }

  /** Has this arm been out of sight long enough to be worth saying so? */
  private armLost(slot: number, side: 'left' | 'right', now: number): boolean {
    const seen = this.armSeenAt[slot];
    if (!seen) return false;
    const at = seen[side];
    return at > 0 && now - at > ARM_LOST_SEC * 1000;
  }

  /**
   * ONE BODY PER COUNTER — and in a solo round, that means one body in total.
   *
   * `playerCount` freezes when the round starts; the tracker keeps running at
   * `maxPlayers`. So a friend leaning into frame mid-round became a second
   * confirmed `TrackedPlayer` that ALSO mapped to slot 0, and `counters[0]` was
   * then fed two different bodies per frame — an `ArmPump` state machine
   * receiving alternating samples from an oscillating wrist and a still one,
   * which manufactures transitions that neither body made.
   *
   * MEASURED, 10s of pumping at 4.5Hz:
   *   one body, solo                                    91 reps   (= 9.0/s, exact)
   *   player MOTIONLESS + a bystander pumping          178 reps
   *   player pumping + a motionless bystander          194 reps   (vs 135 expected)
   *
   * So a bystander could nearly double your score, or score for you while you
   * stood still. At a club fair somebody standing behind the player is not an
   * edge case, it is the default.
   *
   * Biggest TORSO wins — "nearest to the camera", the same measurement the
   * tracker's own bystander gate uses. Deliberately not bounding-box area: a
   * bbox also grows when the arms come out, so ranking by it hands the round to
   * whoever is waving hardest. Measured numbers in games/fruitninja.ts.
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
    // Hysteresis: two bodies at the same distance measure within a few percent
    // of each other, and a bare comparison would hand the round back and forth
    // 30 times a second.
    if (this.playerCount === 1) {
      const top = best.get(0)!;
      const held = players.find((p) => p.id === this.soloLock);
      if (held && held.scale.unit >= top.scale.unit * SOLO_LOCK_KEEP) best.set(0, held);
      this.soloLock = best.get(0)!.id;
    }
    return [...best.values()];
  }

  protected onTick(fc: FrameContext, players: TrackedPlayer[], dt: number): void {
    // The springy bar overshoot decays on the CLOCK, not on how many bodies are
    // in frame. It used to sit inside the per-player loop, so a slot whose
    // player had stepped out kept its overshoot frozen on screen for the rest
    // of the round.
    for (let slot = 0; slot < this.counters.length; slot++) {
      this.barPulse[slot] = Math.max(0, (this.barPulse[slot] ?? 0) - dt * 5);
    }

    this.shown = this.inPlay(players);

    for (const p of this.shown) {
      const slot = this.slotOf(p);
      const counter = this.counters[slot];
      if (!counter) continue;

      // WHICH ARMS THE CAMERA CAN ACTUALLY SEE. A turned player loses the far
      // arm below the visibility gate and silently scores half — measured at
      // 39 reps down to 19. Nothing on screen said so, which is how it became
      // "you have to 67 at a certain angle".
      const seen = this.armSeenAt[slot];
      if (seen) {
        // Seed both clocks from the first frame this body is counted, NOT from
        // zero. An arm that has never been seen at all — the player who steps
        // up already turned, which is the whole case this exists for — would
        // otherwise sit at 0 forever and never be reported as lost.
        if (seen.left === 0) seen.left = fc.now;
        if (seen.right === 0) seen.right = fc.now;
        if (this.armVisible(p, 'left')) seen.left = fc.now;
        if (this.armVisible(p, 'right')) seen.right = fc.now;
      }

      const gained = counter.update(p, fc.now);

      if (gained > 0) {
        this.lastRepAt[slot] = fc.now;
        this.barPulse[slot] = 1;

        // Pitch climbs with rep rate. PLAN.md §5: the highest-value audio
        // investment, because it says "you're doing well" without any reading.
        const rate = counter.rate;
        audio.play('rep', 0.85 + Math.min(1.4, rate / 5));

        // Camera punch scales with rate so a fast player feels genuinely
        // more violent than a slow one.
        this.juice.shake(0.04 + Math.min(0.09, rate * 0.012));

        const rect = this.slotRect(fc.v, slot);
        const color = this.playerCount > 1 ? PLAYER_COLORS[slot]! : COLORS.red;
        BURST.spark(
          this.particles,
          rect.centerX,
          fc.v.height * 0.2,
          -Math.PI / 2,
          color,
          0.7
        );

        // Crossing the record mid-run is the single best moment in this game.
        if (counter.count === this.target + 1) {
          this.juice.celebrate(COLORS.yellow);
          audio.play('record');
          // Popups are ink: PopupLayer still blurs its fill, and flat yellow
          // type on white paper is the one brand pairing that vanishes at 3m.
          this.popups.spawn('<NEW BEST!>', rect.centerX, fc.v.height * 0.28, COLORS.ink, vh(fc.v, 5));
          this.celebrateAt(rect.centerX, fc.v.height * 0.4);
        } else if (counter.count % 10 === 0) {
          this.popups.spawn(
            String(counter.count),
            rect.centerX,
            fc.v.height * 0.28,
            COLORS.ink,
            vh(fc.v, 4)
          );
        }
      }
    }
  }

  protected onRender(fc: FrameContext, _players: TrackedPlayer[]): void {
    for (let slot = 0; slot < this.playerCount; slot++) {
      const rect = this.slotRect(fc.v, slot);
      this.drawBar(fc, slot, rect);
    }
    // THE SAME BODIES THE COUNTER ACCEPTED. Drawing a set the scorer rejected
    // would put two overlapping pairs of arm dots in one place and report on a
    // body that is not being counted — and these dots exist precisely to tell a
    // player whether the problem is their motion or the camera.
    for (const p of this.shown) this.drawArmIndicators(fc, p, this.slotOf(p));
  }

  /**
   * A number in a sticker pill, with tabular digits.
   *
   * `labelPill` in engine/draw.ts is this same object, but it sets its label
   * with proportional figures — and a live counter in proportional figures
   * changes width on almost every frame, which is exactly what tabular numbers
   * exist to stop. A `numberPill` belongs in draw.ts; until it is there, each
   * game that shows a live number builds it locally.
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
   * The racing bar, as a sticker. In 2P these sit side by side and the gap
   * between them is the whole drama.
   */
  private drawBar(fc: FrameContext, slot: number, rect: SlotRect): void {
    const { ctx, v } = fc;
    const count = this.scoreFor(slot);
    const own = this.playerCount > 1 ? PLAYER_COLORS[slot]! : COLORS.red;

    const barW = Math.min(rect.width * 0.22, vh(v, 14));
    const barH = v.height * 0.46;
    const x = rect.centerX - barW / 2;
    const y = v.height * 0.32;
    const radius = barW * 0.3;
    const stroke = vh(v, STROKE.base);
    const drop = vh(v, SHADOW.base);

    const ratio = count / this.target;
    const over = ratio > 1;
    // TWO colours on this object, and never both at once: the player's own
    // colour while chasing, and the record colour the instant it falls.
    //
    // The record colour is yellow, because yellow is the brand's 1st place and
    // a record IS 1st place. Player 1 in versus already wears yellow, though,
    // and a state change nobody can see is not a state change — so that one
    // player crosses into solid ink instead, the brand's other emphasis.
    const recordFill = own === COLORS.yellow ? COLORS.ink : COLORS.yellow;
    const fillColor = over ? recordFill : own;

    // The empty track is a paper sticker — same shape language as every other
    // object in the app, just taller.
    sticker(ctx, v, x, y, barW, barH, {
      radius,
      fill: COLORS.paper,
      outline: COLORS.ink,
      outlineWidth: stroke,
      shadow: drop,
    });

    const clamped = Math.min(1, ratio);
    const pulse = this.barPulse[slot] ?? 0;
    // Springy overshoot on each rep so the bar feels struck, not lerped.
    const fillH = Math.min(barH, barH * clamped * (1 + pulse * 0.02));

    if (fillH > 0) {
      ctx.save();
      ctx.shadowBlur = 0;
      // Clipped to the track so the fill inherits the sticker's corners
      // exactly, instead of a second rounded rect drifting out of register.
      roundRect(ctx, x, y, barW, barH, radius);
      ctx.clip();

      ctx.fillStyle = fillColor;
      ctx.fillRect(x, y + barH - fillH, barW, fillH);

      // A flat ink rule at the level. Replaces the travelling translucent
      // white band — this says "you are here" without a tint.
      ctx.fillStyle = COLORS.ink;
      ctx.fillRect(x, y + barH - fillH, barW, Math.max(1, stroke));
      ctx.restore();

      // The clip painted over the inside half of the outline; put it back.
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = stroke;
      roundRect(ctx, x, y, barW, barH, radius);
      ctx.stroke();
      ctx.restore();
    }

    // THE RECORD LINE. The bar is scaled so the record is a full track, so the
    // line sits on the top edge; it overhangs both sides, which is what makes
    // it read as a rule laid across the bar rather than the bar's own border.
    const recordY = y;
    const overhang = vh(v, 1.8);
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = stroke;
    ctx.setLineDash([vh(v, 1.1), vh(v, 0.8)]);
    ctx.beginPath();
    ctx.moveTo(x - overhang, recordY);
    ctx.lineTo(x + barW + overhang, recordY);
    ctx.stroke();
    ctx.restore();

    drawTabularNumber(ctx, `REC ${this.target}`, x + barW + overhang + vh(v, 1), recordY, {
      size: vh(v, 1.9),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      align: 'left',
      letterSpacing: TRACK.number,
    });

    // Past the record: a celebration badge. DESIGN.md allows decoration to
    // tilt; the bar, the rate and the score underneath it stay straight.
    //
    // It sits BESIDE the bar, opposite the REC label, rather than above it:
    // the strip above the bar belongs to the base HUD (score, label, chase
    // line) and the strip inside it is now flat yellow, so a yellow badge in
    // either place is either a collision or yellow on yellow.
    if (over) {
      labelPill(ctx, v, x - vh(v, 9), recordY + vh(v, 3), '<RECORD>', vh(v, 4.6), {
        fill: COLORS.yellow,
        outline: COLORS.ink,
        outlineWidth: vh(v, STROKE.base),
        shadow: vh(v, SHADOW.lifted),
        color: COLORS.ink,
        weight: WEIGHT.black,
        tilt: -8,
      });
    }

    // Live rate readout under the bar. Flat paper normally; the action colour
    // once they are genuinely moving — a state change, not a tint.
    const rate = this.counters[slot]?.rate ?? 0;
    const fast = rate >= FAST_RATE;
    this.numberPill(
      ctx,
      v,
      rect.centerX,
      y + barH + vh(v, 3.6),
      `${rate.toFixed(1)}/s`,
      vh(v, 4.4),
      fast ? COLORS.yellow : COLORS.paper
    );
  }

  /**
   * Two dots showing each arm's state. Without these, a player who isn't
   * registering has no idea whether the problem is their motion or the camera
   * — and at a stall nobody is there to explain it.
   *
   * Each dot is a sticker with THREE flat states, never a ramp: an empty muted
   * outline when the arm is down, a filled brand-colour sticker with an ink
   * outline and a hard shadow when it is up, and a red dashed ring when the
   * camera cannot see that arm at all.
   *
   * THE THIRD STATE IS THE ONE THAT MATTERS. Turned far enough, MediaPipe's
   * confidence in the far arm drops under the 0.4 visibility gate and that arm
   * simply stops counting — measured, a clean 39-rep run becomes 19. Before
   * this, the dot for a lost arm sat frozen in whatever state it was last in,
   * which is the most misleading thing it could possibly have done: it says
   * "your arm is down" when the truth is "I cannot see your arm". Reported from
   * a playtest as having to "67 at a certain angle".
   */
  private drawArmIndicators(fc: FrameContext, _player: TrackedPlayer, slot: number): void {
    const { ctx, v } = fc;
    const rect = this.slotRect(v, slot);
    const counter = this.counters[slot];
    if (!counter) return;

    // Clear of the rate pill on both axes — the dots are now solid stickers
    // with a shadow rather than a faint halo, so they take real space.
    const y = v.height * 0.88;
    const spacing = vh(v, 11);
    const r = vh(v, 2.4);
    const stroke = vh(v, STROKE.base);
    const drop = vh(v, SHADOW.base);
    const color = this.playerCount > 1 ? PLAYER_COLORS[slot]! : COLORS.red;

    // SIDES WERE SWAPPED. `Projection.x` mirrors (`1 - nx`), which is the
    // whole point — you move like you would in a mirror. So the subject's LEFT
    // arm appears on the LEFT of the screen, and this had it the other way
    // round, with a comment confidently asserting the opposite. Raising your
    // left arm lit the right-hand dot.
    const arms: Array<{ side: 'left' | 'right'; dx: number }> = [
      { side: 'left', dx: -spacing },
      { side: 'right', dx: spacing },
    ];

    let anyLost = false;

    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i]!;
      // Ask the COUNTER, rather than running a second, different test on
      // filtered landmarks. See RepCounter.armUp.
      const lost = this.armLost(slot, arm.side, fc.now);
      const up = !lost && counter.armUp(arm.side);
      const cx = rect.centerX + arm.dx;
      if (lost) anyLost = true;

      ctx.save();
      ctx.shadowBlur = 0;

      if (up) {
        ctx.fillStyle = COLORS.ink;
        ctx.beginPath();
        ctx.arc(cx, y + drop, r, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = up ? color : COLORS.paper;
      ctx.beginPath();
      ctx.arc(cx, y, r, 0, Math.PI * 2);
      ctx.fill();

      if (lost) ctx.setLineDash([vh(v, 0.8), vh(v, 0.6)]);
      ctx.strokeStyle = lost ? COLORS.red : up ? COLORS.ink : COLORS.muted;
      ctx.lineWidth = lost || up ? stroke : vh(v, STROKE.thin);
      ctx.beginPath();
      ctx.arc(cx, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // SAY WHAT TO DO ABOUT IT. A dashed dot tells a player something is wrong;
    // it does not tell them the fix, and nobody at a stall is there to explain
    // that turning back toward the camera is what brings the other arm back.
    //
    // BELOW the dots, not above them. Above puts it straight through the live
    // rate readout, which sits at the foot of the bar — measured on a 1280x720
    // TV: the rate pill centres at 0.816H and the dots at 0.880H, so there is
    // no clear strip between them. Underneath is empty in this game.
    if (anyLost && this.state === 'playing') {
      labelPill(ctx, v, rect.centerX, y + vh(v, 5.2), '<FACE THE CAMERA>', vh(v, 3.6), {
        fill: COLORS.red,
        outline: COLORS.ink,
        outlineWidth: vh(v, STROKE.base),
        shadow: vh(v, SHADOW.base),
        color: COLORS.paper,
        weight: WEIGHT.black,
      });
    }
  }
}
