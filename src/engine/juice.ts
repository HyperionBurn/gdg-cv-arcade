/**
 * The juice engine.
 *
 * PLAN.md §5, in impact order: screen shake, hit-stop, time dilation,
 * particles, rolling counters, impact popups, chromatic aberration.
 *
 * "Feel is why people play twice." At a stall, where nobody has time to
 * appreciate depth, feel is most of what the game IS.
 *
 * Usage per frame:
 *   const dt = juice.beginFrame(rawDt);   // hit-stop and slow-mo applied
 *   juice.pushTransform(ctx);             // shake
 *   ...draw the world...
 *   juice.popTransform(ctx);
 *   juice.drawOverlays(ctx, v);           // flash, aberration, vignette pulse
 */

import type { Viewport } from './draw';
import { COLORS } from '../shell/theme';

/** Cheap deterministic noise. Random() per frame produces a buzz rather than a
 *  shake — real screen shake needs continuity between frames. */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

export interface ShakeOptions {
  /** 0..1. Added to current trauma, clamped. */
  amount: number;
  /** Seconds. Longer = slower decay. */
  duration?: number;
}

export class Juice {
  /**
   * Trauma model (Eiserloh). Shake magnitude is trauma SQUARED, so small hits
   * barely register and big ones feel enormous — a linear mapping makes
   * everything feel equally mushy.
   */
  private trauma = 0;
  private traumaDecay = 1.8;
  private shakeSeed = Math.random() * 1000;
  private shakeX = 0;
  private shakeY = 0;
  private shakeRot = 0;

  private hitStopUntil = 0;
  private timeScale = 1;
  private timeScaleTarget = 1;
  private timeScaleRecover = 2.5;

  /** Default is INK: a white flash on white paper is nothing. */
  private flashColor: string = COLORS.ink;
  private flashAlpha = 0;
  private flashDecay = 4;

  private aberration = 0;

  private elapsed = 0;

  /* ---------------- triggers ---------------- */

  shake(opts: ShakeOptions | number): void {
    const amount = typeof opts === 'number' ? opts : opts.amount;
    if (typeof opts === 'object' && opts.duration) {
      this.traumaDecay = 1 / opts.duration;
    }
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /**
   * Freeze everything for a few frames. PLAN.md calls this "trivial, enormous"
   * and that is exactly right — it is the cheapest way to make an impact land.
   */
  hitStop(ms: number): void {
    this.hitStopUntil = Math.max(this.hitStopUntil, this.elapsed * 1000 + ms);
  }

  /** Slow-mo. `scale` 0.2 is a dramatic crawl, 0.6 a subtle emphasis. */
  slowMo(scale: number, recoverSpeed = 2.5): void {
    this.timeScale = scale;
    this.timeScaleTarget = 1;
    this.timeScaleRecover = recoverSpeed;
  }

  flash(color: string = COLORS.ink, alpha = 0.7, decay = 4): void {
    this.flashColor = color;
    this.flashAlpha = Math.max(this.flashAlpha, alpha);
    this.flashDecay = decay;
  }

  /** RGB split. Reserved for records and eliminations — constant use reads as
   *  a broken display rather than an effect. */
  chromatic(amount: number): void {
    this.aberration = Math.max(this.aberration, amount);
  }

  /** The standard "something big just happened" bundle. */
  impact(strength = 1, color?: string): void {
    this.shake(0.25 * strength);
    this.hitStop(40 * strength);
    if (color) this.flash(color, 0.25 * strength, 6);
  }

  /** The "new record" bundle. Deliberately over the top. */
  celebrate(color: string): void {
    this.shake(0.6);
    this.hitStop(90);
    this.slowMo(0.35, 1.6);
    this.flash(color, 0.85, 2.5);
    this.chromatic(8);
  }

  /* ---------------- per-frame ---------------- */

  /**
   * @param rawDt real seconds since last frame
   * @returns the dt games should simulate with
   */
  beginFrame(rawDtIn: number): number {
    // Every term below decays by subtracting rate*dt. A negative dt turns all
    // of them into growth, and the screen washes out and never recovers. Guard
    // here as well as in the loop — this class must be safe to drive from a
    // test harness or a replay with an arbitrary clock.
    const rawDt = rawDtIn > 0 ? Math.min(rawDtIn, 0.25) : 0;

    this.elapsed += rawDt;
    const nowMs = this.elapsed * 1000;

    // Trauma decays in real time so a freeze doesn't extend the shake forever.
    this.trauma = Math.max(0, this.trauma - this.traumaDecay * rawDt);

    const t = this.trauma * this.trauma;
    this.shakeSeed += rawDt * 34;
    this.shakeX = noise(this.shakeSeed) * t;
    this.shakeY = noise(this.shakeSeed + 137.13) * t;
    this.shakeRot = noise(this.shakeSeed + 921.7) * t * 0.035;

    this.flashAlpha = Math.max(0, this.flashAlpha - this.flashDecay * rawDt);
    this.aberration = Math.max(0, this.aberration - 18 * rawDt);

    if (this.timeScale < this.timeScaleTarget) {
      this.timeScale = Math.min(
        this.timeScaleTarget,
        this.timeScale + this.timeScaleRecover * rawDt
      );
    }

    if (nowMs < this.hitStopUntil) return 0;
    return rawDt * this.timeScale;
  }

  /** Shake magnitude in pixels scales with viewport so it feels identical on a
   *  laptop preview and a 55" TV. */
  pushTransform(ctx: CanvasRenderingContext2D, v: Viewport, intensity = 1): void {
    ctx.save();
    if (this.trauma <= 0.001) return;
    const maxOffset = v.height * 0.035 * intensity;
    ctx.translate(v.width / 2, v.height / 2);
    ctx.rotate(this.shakeRot * intensity);
    ctx.translate(-v.width / 2 + this.shakeX * maxOffset, -v.height / 2 + this.shakeY * maxOffset);
  }

  popTransform(ctx: CanvasRenderingContext2D): void {
    ctx.restore();
  }

  drawOverlays(ctx: CanvasRenderingContext2D, v: Viewport): void {
    if (this.aberration > 0.05) {
      // INK EDGE BARS, not an RGB fringe.
      //
      // This was two `createLinearGradient`s in `'screen'` composite. DESIGN.md
      // bans gradients and see-through colour outright, and on paper the
      // `screen` blend made it a no-op anyway — white is that operator's
      // identity, so it cost two full-screen fills per frame and drew nothing.
      //
      // The brand-legal equivalent of "the screen just took a hit" is the kit's
      // own vocabulary: hard flat ink bars slamming in from both edges. No
      // blur, no gradient, no transparency, and it reads from the back of a
      // crowd where a subtle fringe never would.
      const w = Math.min(v.width * 0.05, this.aberration * 4);
      ctx.save();
      ctx.fillStyle = COLORS.ink;
      ctx.fillRect(0, 0, w, v.height);
      ctx.fillRect(v.width - w, 0, w, v.height);
      ctx.restore();
    }

    if (this.flashAlpha > 0.002) {
      // Flat colour at layer alpha, NOT `screen` composite with a translucent
      // fill. On paper `screen` is the identity — the flash simply stopped
      // existing when the background flipped to white.
      ctx.save();
      ctx.globalAlpha = Math.min(1, this.flashAlpha);
      ctx.fillStyle = this.flashColor;
      ctx.fillRect(0, 0, v.width, v.height);
      ctx.restore();
    }
  }

  get isFrozen(): boolean {
    return this.elapsed * 1000 < this.hitStopUntil;
  }

  get currentTimeScale(): number {
    return this.timeScale;
  }

  reset(): void {
    this.trauma = 0;
    this.hitStopUntil = 0;
    this.timeScale = 1;
    this.timeScaleTarget = 1;
    this.flashAlpha = 0;
    this.aberration = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Rolling counter                                                     */
/* ------------------------------------------------------------------ */

/**
 * PLAN.md §5: "Score counters roll, never snap."
 *
 * A number that jumps from 12 to 47 reads as a bug. A number that spins up to
 * 47 reads as an achievement, and it buys a moment of drama for free.
 */
export class RollingNumber {
  private display = 0;
  private target = 0;

  /** Explicit field, not a parameter property — see `games/base.ts`. */
  private speed: number;

  constructor(speed = 8) {
    this.speed = speed;
  }

  /**
   * NON-FINITE INPUT IS DROPPED, not stored.
   *
   * This is the last thing standing between a bad score and the literal
   * glyphs "NaN" rendered at 11vh on a television, which is a failure the
   * audience can read from the back of the hall. Once NaN enters `target` it
   * is permanent: every `update` propagates it into `display`, and nothing
   * downstream checks.
   *
   * Cheap insurance on a number computed from division by a body scale that
   * can legitimately be zero for a frame.
   */
  set(value: number, immediate = false): void {
    if (!Number.isFinite(value)) return;
    this.target = value;
    if (immediate) this.display = value;
  }

  add(delta: number): void {
    if (!Number.isFinite(delta)) return;
    this.target += delta;
  }

  update(dt: number): void {
    const diff = this.target - this.display;
    if (Math.abs(diff) < 0.01) {
      this.display = this.target;
      return;
    }
    // Exponential approach plus a floor, so the last few units don't crawl.
    const step = diff * Math.min(1, this.speed * dt);
    const minStep = Math.sign(diff) * Math.min(Math.abs(diff), 30 * dt);
    this.display += Math.abs(step) > Math.abs(minStep) ? step : minStep;
  }

  get value(): number {
    return Math.round(this.display);
  }
  get exact(): number {
    return this.display;
  }
  get isSettled(): boolean {
    return this.display === this.target;
  }

  reset(value = 0): void {
    this.display = value;
    this.target = value;
  }
}

/* ------------------------------------------------------------------ */
/* Impact popups                                                       */
/* ------------------------------------------------------------------ */

interface Popup {
  text: string;
  x: number;
  y: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  /** Estimated half-width, for the spawn-time separation pass. */
  halfW: number;
}

/**
 * Half the width a popup will occupy, without a canvas to measure against.
 *
 * `spawn` has no ctx, and the alternative — measuring at draw time — is too
 * late, because by then the position is already committed. 0.56em per glyph is
 * the measured average for Archivo Black across the digits and capitals these
 * strings are made of; it only has to be close enough to decide whether two
 * labels are in each other's way.
 */
function estimateHalfWidth(text: string, size: number): number {
  return (text.length * size * 0.56) / 2;
}

/** Floating "+3", "COMBO x4", "MISS" text at the point of impact. */
export class PopupLayer {
  private pool: Popup[] = [];

  /**
   * Popups rise, so they must not be spawned where they will travel INTO the
   * HUD. `floorY` is the lowest y a popup may occupy — set it to the bottom of
   * the HUD band and the whole class of "+48 drawn through the score" bugs
   * goes away, without every call site remembering to do the arithmetic.
   *
   * Observed on 67 Speed and Fruit Ninja: `<NEW BEST!>` and `<2 CHAIN!>` were
   * rendering straight through the live score, which on a TV at 3m is the
   * difference between a readable number and a smear.
   */
  floorY = 0;

  spawn(text: string, x: number, y: number, color: string, size: number, life = 0.9): void {
    // Clamp to the safe band, allowing for the full rise distance.
    const rise = size * 1.6 * life;
    let safeY = Math.max(y, this.floorY + rise);

    // SEPARATION. Popups spawn at the point of impact, and impacts cluster:
    // Balloon Pop routinely pops two balloons a few frames and a few tens of
    // pixels apart, and the two labels landed on top of each other as an
    // unreadable smear — "GOLD +58" through "+48". Four events in a second is
    // the game working correctly, so the fix belongs here rather than in a
    // spawn rate limit.
    //
    // Staggering DOWNWARD rather than up is deliberate twice over: up is where
    // `floorY` is protecting the HUD, and since popups rise, a later one
    // starting lower simply follows the earlier one instead of racing it.
    const halfW = estimateHalfWidth(text, size);
    for (let guard = 0; guard < 6; guard++) {
      const clash = this.pool.find(
        (q) =>
          Math.abs(q.x - x) < q.halfW + halfW &&
          Math.abs(q.y - safeY) < (q.size + size) * 0.58
      );
      if (!clash) break;
      safeY = clash.y + (clash.size + size) * 0.58;
    }

    this.pool.push({ text, x, y: safeY, vy: -size * 1.6, life, maxLife: life, color, size, halfW });
    if (this.pool.length > 60) this.pool.shift();
  }

  update(dt: number): void {
    for (let i = this.pool.length - 1; i >= 0; i--) {
      const p = this.pool[i]!;
      p.life -= dt;
      p.y += p.vy * dt;
      p.vy += p.size * 2.2 * dt;
      if (p.life <= 0) this.pool.splice(i, 1);
    }
  }

  draw(ctx: CanvasRenderingContext2D, font: string): void {
    for (const p of this.pool) {
      const t = p.life / p.maxLife;
      // Pop in fast, then fade.
      const scale = t > 0.85 ? 1 + (1 - t) * 6 : 1;
      const alpha = t > 0.3 ? 1 : t / 0.3;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.scale(scale, scale);
      ctx.font = `900 ${p.size}px ${font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // PAPER KNOCKOUT, then the hard ink shadow, then the glyphs.
      //
      // A popup is the one piece of text in this app that does not get to
      // choose its background: it spawns at the point of impact, and
      // `floorY` can push it further onto whatever is there. 67 Speed is the
      // proof — `<NEW BEST!>` and every 10-rep milestone are ink, they land on
      // the rep bar, and that bar turns INK for the yellow player once they
      // pass the record. The biggest celebration in the game rendered as
      // nothing, for one of the two players, exactly when it mattered most.
      // Fruit Ninja's `<2 CHAIN!>` over a dark fruit and Rhythm's judgement
      // words over a note are the same shape of problem.
      //
      // So the glyphs carry their own background with them. A paper stroke is
      // two flat colours and two draw calls — no blur, no plate, no layout
      // change — and it costs nothing on a paper background, where it is
      // invisible by definition. `miter` would spike on tight corners at this
      // weight, hence round joins.
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = p.size * 0.17;
      ctx.strokeStyle = COLORS.paper;
      ctx.strokeText(p.text, 0, p.size * 0.07);
      ctx.strokeText(p.text, 0, 0);

      // Hard ink shadow straight down, not a blur. This ran `shadowBlur = 14`
      // on every popup on every frame, which is the exact pattern that cost
      // 92.8ms/frame in attract mode.
      ctx.fillStyle = COLORS.ink;
      ctx.fillText(p.text, 0, p.size * 0.07);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, 0, 0);
      ctx.restore();
    }
  }

  clear(): void {
    this.pool.length = 0;
  }
}
