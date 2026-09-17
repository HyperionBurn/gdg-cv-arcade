/**
 * FRUIT NINJA — "the crowd-puller".
 *
 * PLAN.md §3: hands are blades, slice fruit, bombs for drama. Best spectacle on
 * the roster — blade trails and particle juice read beautifully from across a
 * hall, so this is the game that pulls the next person into the queue.
 *
 * Built on real polygon geometry (games/geometry.ts): every fruit is a convex
 * polygon, and a slice splits it along the ACTUAL line your hand travelled,
 * producing two halves with correct shape and inherited physics. That is the
 * difference between "the fruit disappeared" and "I cut that".
 *
 * BRAND: every fruit is a STICKER. Flat brand fill, chunky ink outline, hard
 * shadow straight down, zero blur — the same object as a menu tile or a rank
 * badge, just convex and airborne. The halves keep the outline, so a cut fruit
 * still reads as two stickers rather than two coloured smudges.
 *
 * The bomb is the one object on the roster drawn in SOLID INK. On white paper,
 * among four bright flat colours, a black blob is the most emphatic "no" the
 * brand owns — and it needs no blur to say it.
 *
 * Blades come from pose wrists, not hand landmarks — see core/blades.ts for why.
 */

import { BladeTracker, drawBladeTrail, type Blade } from '../core/blades';
import type { TrackedPlayer } from '../core/tracker';
import { GameBase, type SlotRect } from './base';
import {
  makeBlob,
  polygonCentroid,
  splitConvexPolygon,
  segmentCrossesPolygon,
  transformPolygon,
  type Point,
} from './geometry';
import { BURST } from '../engine/particles';
import { audio } from '../engine/audio';
import {
  drawTabularNumber,
  measureTabularNumber,
  stickerPill,
  vh,
} from '../engine/draw';
import type { Viewport } from '../engine/draw';
import { COLORS, FONTS, SHADOW, STROKE, TRACK, WEIGHT } from '../shell/theme';
import type { FrameContext } from '../shell/screen';

type BodyKind = 'fruit' | 'bomb';

interface Body {
  kind: BodyKind;
  /** Local-space convex polygon, centred on the origin. */
  poly: Point[];
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  radius: number;
  color: string;
  slot: number;
  /** Halves only: fade-out timer. Whole bodies have life = Infinity. */
  life: number;
  isHalf: boolean;
}

interface Splat {
  x: number;
  y: number;
  r: number;
  color: string;
  life: number;
  seed: number;
}

/** Gravity in screen-heights per second squared — resolution independent. */
const GRAVITY = 1.55;
/** Slices within this window chain into a combo. */
const COMBO_WINDOW_MS = 700;
/** Seconds removed by a bomb. See the note on bombs below. */
const BOMB_TIME_PENALTY = 8;
/** Seconds a juice splat survives. It fades out at the end — see drawSplats. */
const SPLAT_DECAY = 0.4;
/** Hard ceiling on splats. Paper has to stay the majority of the screen. */
const MAX_SPLATS = 16;

/**
 * The four brand colours, flat, and nothing else.
 *
 * This list previously carried `redBright` and `greenBright` as well — which
 * are the same two hexes again, so a third of the fruit were duplicates bought
 * at the price of implying a second palette.
 */
const FRUIT_COLORS = [COLORS.red, COLORS.yellow, COLORS.green, COLORS.blue] as const;

export class FruitNinjaGame extends GameBase {
  private blades = new BladeTracker();
  private bodies: Body[] = [];
  private splats: Splat[] = [];

  private points = [0, 0];
  private sliced = [0, 0];
  private combo = [0, 0];
  private lastSliceAt = [0, 0];
  private bombsHit = [0, 0];

  private spawnTimer = 0;
  private seed = 1;

  constructor() {
    super({
      gameId: 'fruitninja',
      title: 'FRUIT NINJA',
      tagline: '<SLICE THE FRUIT — DODGE THE BOMBS>',
      visionMode: 'pose',
      maxPlayers: 2,
      roundSeconds: 45,
      color: COLORS.green,
      supportsVersus: true,
    });
  }

  protected onStart(): void {
    this.bodies = [];
    this.splats = [];
    this.points = [0, 0];
    this.sliced = [0, 0];
    this.combo = [0, 0];
    this.lastSliceAt = [0, 0];
    this.bombsHit = [0, 0];
    this.spawnTimer = 0.6;
    this.seed = 1;
    this.blades.reset();
  }

  protected scoreFor(slot: number): number {
    return this.points[slot] ?? 0;
  }

  protected primaryLabel(): string {
    return 'SCORE';
  }

  /* ---------------- simulation ---------------- */

  protected onTick(fc: FrameContext, players: TrackedPlayer[], dt: number): void {
    if (!this.proj) return;

    const project = (nx: number, ny: number) => this.proj!.point({ x: nx, y: ny });
    const blades = this.blades.update(players, project, dt, fc.now);

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawn(fc);
      // Ramps from a lazy lob at the start to a steady stream by the end, so
      // the round builds instead of running flat.
      const progress = 1 - this.timeLeft / this.config.roundSeconds;
      this.spawnTimer = (0.95 - progress * 0.55) * (this.playerCount > 1 ? 0.75 : 1);
    }

    this.stepBodies(fc, dt);
    this.resolveSlices(fc, blades);
    this.expireCombos(fc.now);

    for (let i = this.splats.length - 1; i >= 0; i--) {
      const s = this.splats[i]!;
      s.life -= dt * SPLAT_DECAY;
      if (s.life <= 0) this.splats.splice(i, 1);
    }
  }

  private spawn(fc: FrameContext): void {
    const { v } = fc;
    for (let slot = 0; slot < this.playerCount; slot++) {
      const rect = this.slotRect(v, slot);
      const progress = 1 - this.timeLeft / this.config.roundSeconds;

      // Never in the first few seconds — a bomb before the player has worked
      // out the game is pure punishment.
      const bombChance = this.timeLeft > this.config.roundSeconds - 6 ? 0 : 0.1 + progress * 0.12;
      const count = 1 + (Math.random() < 0.3 + progress * 0.3 ? 1 : 0);

      for (let i = 0; i < count; i++) {
        const isBomb = Math.random() < bombChance;
        const radius = v.height * (isBomb ? 0.045 : 0.05 + Math.random() * 0.022);

        const x = rect.x + rect.width * (0.18 + Math.random() * 0.64);
        const y = v.height + radius * 2;

        // Aim the arc so the apex lands in the upper-middle of the slot: that
        // is where hands naturally are, and it keeps fruit off the HUD.
        const apex = v.height * (0.2 + Math.random() * 0.16);
        const rise = y - apex;
        const vy = -Math.sqrt(2 * GRAVITY * v.height * rise) / v.height;
        const towardCentre = (rect.centerX - x) / rect.width;
        const vx = (towardCentre * 0.45 + (Math.random() - 0.5) * 0.28) * v.height * 0.55;

        this.bodies.push({
          kind: isBomb ? 'bomb' : 'fruit',
          poly: makeBlob(radius, isBomb ? 10 : 9, this.seed++),
          x,
          y,
          vx,
          vy: vy * v.height,
          angle: Math.random() * Math.PI * 2,
          spin: (Math.random() - 0.5) * 3.4,
          radius,
          color: isBomb
            ? COLORS.ink
            : FRUIT_COLORS[Math.floor(Math.random() * FRUIT_COLORS.length)]!,
          slot,
          life: Infinity,
          isHalf: false,
        });
      }
    }
  }

  private stepBodies(fc: FrameContext, dt: number): void {
    const { v } = fc;
    const g = GRAVITY * v.height;

    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i]!;
      b.vy += g * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.angle += b.spin * dt;

      if (b.isHalf) {
        b.life -= dt;
        b.vx *= 0.995;
      }

      const offscreen = b.y - b.radius > v.height + v.height * 0.1;
      if (offscreen || b.life <= 0) this.bodies.splice(i, 1);
    }
  }

  private resolveSlices(fc: FrameContext, blades: Blade[]): void {
    for (const blade of blades) {
      if (!blade.active) continue;

      // Everything this blade cut in THIS frame — a single fast swipe through
      // three fruit must register as a 3-chain, not three separate slices.
      const cutThisSwipe: Body[] = [];

      for (let i = this.bodies.length - 1; i >= 0; i--) {
        const b = this.bodies[i]!;
        if (b.isHalf) continue;
        // In versus, you can only cut your own half's fruit.
        if (this.playerCount > 1 && b.slot !== blade.slot) continue;

        const world = transformPolygon(b.poly, b.x, b.y, b.angle);
        const p1 = { x: blade.px, y: blade.py };
        const p2 = { x: blade.x, y: blade.y };
        if (!segmentCrossesPolygon(p1, p2, world)) continue;

        this.bodies.splice(i, 1);
        cutThisSwipe.push(b);

        if (b.kind === 'bomb') this.detonate(fc, b, blade.slot);
        else this.sliceFruit(fc, b, world, p1, p2);
      }

      if (cutThisSwipe.length > 0) {
        const fruit = cutThisSwipe.filter((b) => b.kind === 'fruit');
        if (fruit.length > 0) this.awardSlice(fc, blade.slot, fruit, blade);
      }
    }
  }

  /** Splits the fruit along the real blade line and spawns two halves. */
  private sliceFruit(
    fc: FrameContext,
    b: Body,
    world: Point[],
    p1: Point,
    p2: Point
  ): void {
    const { v } = fc;
    const halves = splitConvexPolygon(world, p1, p2);

    // Separation is perpendicular to the cut, so the halves fall apart along
    // the line you actually swung through.
    const cutAngle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const nx = -Math.sin(cutAngle);
    const ny = Math.cos(cutAngle);
    const push = v.height * 0.16;

    if (halves) {
      halves.forEach((half, idx) => {
        const c = polygonCentroid(half);
        const dir = idx === 0 ? 1 : -1;
        this.bodies.push({
          kind: 'fruit',
          poly: half.map((p) => ({ x: p.x - c.x, y: p.y - c.y })),
          x: c.x,
          y: c.y,
          vx: b.vx + nx * push * dir,
          vy: b.vy + ny * push * dir - v.height * 0.05,
          angle: 0,
          spin: b.spin + dir * 2.6,
          radius: b.radius * 0.6,
          color: b.color,
          slot: b.slot,
          life: 1.4,
          isHalf: true,
        });
      });
    }

    BURST.splat(this.particles, b.x, b.y, b.color, b.radius / (v.height * 0.05));
    // Ink, not white. The playfield is paper now — white sparks on white are a
    // particle budget spent on nothing.
    BURST.spark(this.particles, b.x, b.y, cutAngle, COLORS.ink, 0.6);

    this.splats.push({
      x: b.x,
      y: b.y,
      r: b.radius * 1.1,
      color: b.color,
      life: 1,
      seed: this.seed++,
    });
    if (this.splats.length > MAX_SPLATS) this.splats.shift();
  }

  /**
   * BOMBS COST TIME, THEY DO NOT END THE ROUND.
   *
   * PLAN.md §3 originally had a bomb end the run. Deliberate deviation: at a
   * stall, someone who steps up, swings once and hits a bomb at four seconds
   * has had their turn taken away, feels cheated, and the crowd gets no show.
   * A time penalty keeps the round length predictable for the queue (which was
   * the reason for the timer in the first place) and turns the bomb into the
   * biggest laugh in the game rather than the end of it.
   *
   * PLAN.md §11: "failure should be funny, never punishing."
   */
  private detonate(fc: FrameContext, b: Body, slot: number): void {
    const { v } = fc;
    this.bombsHit[slot] = (this.bombsHit[slot] ?? 0) + 1;
    this.combo[slot] = 0;

    this.timeLeft = Math.max(0.6, this.timeLeft - BOMB_TIME_PENALTY);

    audio.play('bomb');
    this.juice.shake(0.75);
    this.juice.hitStop(110);
    this.juice.flash(COLORS.red, 0.6, 3);
    this.juice.chromatic(6);

    this.particles.emit({
      x: b.x,
      y: b.y,
      count: 70,
      color: COLORS.red,
      speed: v.height * 0.9,
      speedVariance: v.height * 0.7,
      size: 7,
      life: 0.9,
      gravity: v.height * 0.8,
      drag: 0.93,
      streak: true,
    });
    // Ink debris rather than yellow: two brand colours per component, and the
    // red already carries the alarm. Ink also reads on paper; yellow does not.
    this.particles.emit({
      x: b.x,
      y: b.y,
      count: 30,
      color: COLORS.ink,
      speed: v.height * 0.5,
      size: 10,
      life: 0.5,
      gravity: 0,
      drag: 0.9,
    });

    this.popups.spawn(`-${BOMB_TIME_PENALTY}s`, b.x, b.y, COLORS.red, vh(v, 6), 1.2);
  }

  private awardSlice(fc: FrameContext, slot: number, fruit: Body[], blade: Blade): void {
    const { v } = fc;
    const chain = fruit.length;

    const combo = (this.combo[slot] ?? 0) + 1;
    this.combo[slot] = combo;
    this.lastSliceAt[slot] = fc.now;
    this.sliced[slot] = (this.sliced[slot] ?? 0) + chain;

    // Multi-cut in one swipe is worth far more than the same fruit cut singly —
    // that is the skill the game rewards and the thing worth showing off.
    const base = 10 * chain;
    const chainBonus = chain > 1 ? base * (chain - 1) : 0;
    const comboBonus = Math.min(combo - 1, 9) * 5 * chain;
    const gained = base + chainBonus + comboBonus;

    this.points[slot] = (this.points[slot] ?? 0) + gained;
    this.scores[slot]?.set(this.points[slot]!);

    // Rising pitch with the combo. PLAN.md §5: highest-value audio investment.
    audio.play('slice', 0.9 + Math.min(1.1, combo * 0.09 + (chain - 1) * 0.18));
    this.juice.shake(0.06 + Math.min(0.18, chain * 0.05 + combo * 0.01));
    if (chain > 1) this.juice.hitStop(26 * chain);

    const cx = fruit.reduce((s, f) => s + f.x, 0) / chain;
    const cy = fruit.reduce((s, f) => s + f.y, 0) / chain;

    // Every popup is ink. PopupLayer still blurs its own fill (engine/juice.ts,
    // not ours), and flat yellow type on white paper is the one brand pairing
    // that disappears at three metres.
    if (chain > 1) {
      this.popups.spawn(`<${chain} CHAIN!>`, cx, cy - vh(v, 4), COLORS.ink, vh(v, 5), 1.1);
      this.juice.flash(COLORS.yellow, 0.16, 6);
    }
    if (combo >= 3) {
      this.popups.spawn(`x${combo}`, blade.x, blade.y - vh(v, 3), COLORS.ink, vh(v, 3.6));
    }
    this.popups.spawn(`+${gained}`, cx, cy, COLORS.ink, vh(v, 3.4));
  }

  private expireCombos(now: number): void {
    for (let slot = 0; slot < this.playerCount; slot++) {
      if (now - (this.lastSliceAt[slot] ?? 0) > COMBO_WINDOW_MS) this.combo[slot] = 0;
    }
  }

  /* ---------------- rendering ---------------- */

  protected onRender(fc: FrameContext, _players: TrackedPlayer[]): void {
    const { ctx, v } = fc;

    this.drawSplats(ctx);

    for (const b of this.bodies) this.drawBody(ctx, b, v);

    // The trail is INK in both solo and versus. On paper it reads as a pen
    // stroke, which is exactly the brand; and in versus each player is already
    // confined to their own half, so a colour is not what disambiguates them.
    // (Yellow — PLAYER_COLORS[0] — on white paper is invisible at 3m.)
    const maxWidth = vh(v, 1.5);
    for (const blade of this.blades.all) {
      drawBladeTrail(ctx, blade, COLORS.ink, maxWidth);
    }
  }

  /**
   * A body as a sticker: hard ink shadow straight down, flat fill, chunky ink
   * outline. Three fills and a stroke, no shadow state, no blur.
   */
  private drawBody(ctx: CanvasRenderingContext2D, b: Body, v: Viewport): void {
    const world = transformPolygon(b.poly, b.x, b.y, b.angle);
    if (world.length < 3) return;

    // The one permitted use of alpha: fading a WHOLE element out over time.
    // Not a tint — a half at full life is the same flat colour as the fruit it
    // came from.
    const alpha = b.isHalf ? Math.min(1, b.life / 0.5) : 1;
    const stroke = vh(v, b.isHalf ? STROKE.thin : STROKE.base);
    const drop = vh(v, b.isHalf ? SHADOW.none : SHADOW.base);

    const path = (dy: number): void => {
      ctx.beginPath();
      ctx.moveTo(world[0]!.x, world[0]!.y + dy);
      for (let i = 1; i < world.length; i++) ctx.lineTo(world[i]!.x, world[i]!.y + dy);
      ctx.closePath();
    };

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowBlur = 0;
    ctx.lineJoin = 'round';

    if (drop > 0) {
      ctx.fillStyle = COLORS.ink;
      path(drop);
      ctx.fill();
    }

    ctx.fillStyle = b.color;
    path(0);
    ctx.fill();

    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = stroke;
    path(0);
    ctx.stroke();

    if (b.kind === 'bomb') this.drawBombMark(ctx, b, v);

    ctx.restore();
  }

  /**
   * What makes a bomb unmistakable with no blur at all.
   *
   * Solid ink body (drawn by drawBody), a flat red warning ring, and a paper ✕
   * struck through it. Ink-on-paper against four bright flat fruit is already
   * the strongest contrast the palette can make; the ring is the single brand
   * colour this component is allowed, and red is the brand's own "closed".
   *
   * The ✕ is two stroked lines rather than a glyph, so it cannot depend on
   * Archivo carrying U+2715 and it stays crisp at any TV resolution.
   */
  private drawBombMark(ctx: CanvasRenderingContext2D, b: Body, v: Viewport): void {
    const ring = b.radius * 1.34;
    const arm = b.radius * 0.44;

    ctx.save();
    ctx.shadowBlur = 0;
    ctx.lineCap = 'round';

    ctx.strokeStyle = COLORS.red;
    ctx.lineWidth = vh(v, STROKE.thick);
    ctx.beginPath();
    ctx.arc(b.x, b.y, ring, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = COLORS.paper;
    ctx.lineWidth = Math.max(2, b.radius * 0.22);
    ctx.beginPath();
    ctx.moveTo(b.x - arm, b.y - arm);
    ctx.lineTo(b.x + arm, b.y + arm);
    ctx.moveTo(b.x + arm, b.y - arm);
    ctx.lineTo(b.x - arm, b.y + arm);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Persistent juice on the screen. PLAN.md §3.
   *
   * Flat fruit colour at FULL opacity — the old version drew every splat at
   * 20% and under, which is a tint of a brand colour. Instead they are smaller,
   * capped at MAX_SPLATS, and fade out only in their last moments, which is
   * alpha used as a fade over time rather than as a colour treatment.
   */
  private drawSplats(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.shadowBlur = 0;
    for (const s of this.splats) {
      ctx.globalAlpha = Math.min(1, s.life * 3);
      ctx.fillStyle = s.color;
      const blobs = 5;
      for (let i = 0; i < blobs; i++) {
        const a = (i / blobs) * Math.PI * 2 + s.seed;
        const d = s.r * (0.3 + ((Math.sin(s.seed * 12.9 + i * 78.2) + 1) / 2) * 0.9);
        const rr = s.r * (0.22 + ((Math.sin(s.seed * 4.1 + i * 33.7) + 1) / 2) * 0.3);
        ctx.beginPath();
        ctx.arc(s.x + Math.cos(a) * d, s.y + Math.sin(a) * d, rr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
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

  protected onRenderHud(fc: FrameContext, slot: number, rect: SlotRect): void {
    const { ctx, v } = fc;
    const combo = this.combo[slot] ?? 0;
    const sliced = this.sliced[slot] ?? 0;

    if (combo >= 2) {
      // A yellow action pill, straight — it carries a number, so DESIGN.md
      // says it does not tilt. The scale pulse is motion, not a colour change,
      // and it is the only thing left of the old blurred yellow glow.
      const pulse = 1 + Math.sin(fc.time * 14) * 0.06;
      ctx.save();
      ctx.translate(rect.centerX, vh(v, 27));
      ctx.scale(pulse, pulse);
      this.numberPill(ctx, v, 0, 0, `COMBO x${combo}`, vh(v, 4.6), COLORS.yellow);
      ctx.restore();
    }

    drawTabularNumber(ctx, `${sliced} SLICED`, rect.centerX, v.height - vh(v, 3), {
      size: vh(v, 2),
      color: COLORS.muted,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: TRACK.pill,
    });
  }
}
