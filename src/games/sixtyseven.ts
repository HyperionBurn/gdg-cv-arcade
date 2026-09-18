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

import { RepCounter } from '../core/gestures';
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
import type { FrameContext } from '../shell/screen';

/** Fallback bar target before anyone has set a record. */
const DEFAULT_TARGET = 55;

/** Reps per second above which the rate readout becomes a yellow action pill. */
const FAST_RATE = 4;

export class SixtySevenGame extends GameBase {
  private counters: RepCounter[] = [new RepCounter(), new RepCounter()];
  private target = DEFAULT_TARGET;
  /** Per-slot bar overshoot, for the springy fill. */
  private barPulse = [0, 0];
  private lastRepAt = [0, 0];

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
    for (const c of this.counters) c.reset();
    this.barPulse = [0, 0];
    this.lastRepAt = [0, 0];

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

  protected onTick(fc: FrameContext, players: TrackedPlayer[], dt: number): void {
    for (const p of players) {
      const slot = this.playerCount > 1 ? Math.max(0, Math.min(1, p.slot)) : 0;
      const counter = this.counters[slot];
      if (!counter) continue;

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

      this.barPulse[slot] = Math.max(0, (this.barPulse[slot] ?? 0) - dt * 5);
    }
  }

  protected onRender(fc: FrameContext, players: TrackedPlayer[]): void {
    for (let slot = 0; slot < this.playerCount; slot++) {
      const rect = this.slotRect(fc.v, slot);
      this.drawBar(fc, slot, rect);
    }
    for (const p of players) {
      const slot = this.playerCount > 1 ? Math.max(0, Math.min(1, p.slot)) : 0;
      this.drawArmIndicators(fc, p, slot);
    }
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
   * Each dot is a sticker with two flat states: an empty muted outline when the
   * arm is down, a filled brand-colour sticker with an ink outline and a hard
   * shadow when it is up. The old version faded a glow in and out, which is
   * both a blur and a tint of a brand colour.
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

    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i]!;
      // Ask the COUNTER, rather than running a second, different test on
      // filtered landmarks. See RepCounter.armUp.
      const up = counter.armUp(arm.side);
      const cx = rect.centerX + arm.dx;

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

      ctx.strokeStyle = up ? COLORS.ink : COLORS.muted;
      ctx.lineWidth = up ? stroke : vh(v, STROKE.thin);
      ctx.beginPath();
      ctx.arc(cx, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

}
