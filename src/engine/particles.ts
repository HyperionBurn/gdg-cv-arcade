/**
 * Pooled particle system.
 *
 * PLAN.md §5: "Particles on every core action." PLAN.md §2: "Frame budget
 * watchdog: auto-drop particle density if we miss frame time."
 *
 * Fixed-capacity pool with zero per-frame allocation. Particles are plain
 * fields in parallel arrays rather than objects — at a few thousand live
 * particles the GC pressure from object churn is a visible stutter on a
 * thermally-throttled laptop at hour four.
 */

import { COLORS } from '../shell/theme';

export interface EmitOptions {
  x: number;
  y: number;
  count: number;
  color: string;
  /** Base speed in px/sec. */
  speed: number;
  speedVariance?: number;
  /** Radians. Omit for a full circle. */
  angle?: number;
  spread?: number;
  size: number;
  sizeVariance?: number;
  life: number;
  lifeVariance?: number;
  gravity?: number;
  drag?: number;
  /** Leaves a motion streak instead of a dot. Good for slices and speed. */
  streak?: boolean;
}

const MAX_PARTICLES = 3000;

export class ParticleSystem {
  private x = new Float32Array(MAX_PARTICLES);
  private y = new Float32Array(MAX_PARTICLES);
  private vx = new Float32Array(MAX_PARTICLES);
  private vy = new Float32Array(MAX_PARTICLES);
  private size = new Float32Array(MAX_PARTICLES);
  private life = new Float32Array(MAX_PARTICLES);
  private maxLife = new Float32Array(MAX_PARTICLES);
  private gravity = new Float32Array(MAX_PARTICLES);
  private drag = new Float32Array(MAX_PARTICLES);
  private streak = new Uint8Array(MAX_PARTICLES);
  private colors: string[] = new Array(MAX_PARTICLES).fill('#fff');
  private alive = new Uint8Array(MAX_PARTICLES);

  private cursor = 0;
  private liveCount = 0;

  /**
   * 0..1 budget multiplier set by the frame watchdog. Halving this halves the
   * particle count everywhere without any game needing to know.
   */
  quality = 1;

  emit(opts: EmitOptions): void {
    const count = Math.max(1, Math.round(opts.count * this.quality));
    for (let i = 0; i < count; i++) {
      const idx = this.claim();
      if (idx < 0) return;

      const angle =
        opts.angle !== undefined
          ? opts.angle + (Math.random() - 0.5) * (opts.spread ?? 0.6)
          : Math.random() * Math.PI * 2;

      const speed = opts.speed + (Math.random() - 0.5) * (opts.speedVariance ?? opts.speed * 0.6);
      const life = opts.life + (Math.random() - 0.5) * (opts.lifeVariance ?? opts.life * 0.4);

      this.x[idx] = opts.x;
      this.y[idx] = opts.y;
      this.vx[idx] = Math.cos(angle) * speed;
      this.vy[idx] = Math.sin(angle) * speed;
      this.size[idx] = Math.max(
        0.5,
        opts.size + (Math.random() - 0.5) * (opts.sizeVariance ?? opts.size * 0.5)
      );
      this.life[idx] = life;
      this.maxLife[idx] = life;
      this.gravity[idx] = opts.gravity ?? 0;
      this.drag[idx] = opts.drag ?? 0.98;
      this.streak[idx] = opts.streak ? 1 : 0;
      this.colors[idx] = opts.color;
      this.alive[idx] = 1;
      this.liveCount++;
    }
  }

  /** Ring-buffer allocation: when full, the oldest particle is recycled. Far
   *  better than dropping the newest, which makes big effects look truncated. */
  private claim(): number {
    for (let attempts = 0; attempts < MAX_PARTICLES; attempts++) {
      const idx = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      if (!this.alive[idx]) return idx;
    }
    const idx = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    return idx;
  }

  update(dt: number): void {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (!this.alive[i]) continue;

      this.life[i]! -= dt;
      if (this.life[i]! <= 0) {
        this.alive[i] = 0;
        this.liveCount--;
        continue;
      }

      this.vy[i]! += this.gravity[i]! * dt;
      const d = Math.pow(this.drag[i]!, dt * 60);
      this.vx[i]! *= d;
      this.vy[i]! *= d;
      this.x[i]! += this.vx[i]! * dt;
      this.y[i]! += this.vy[i]! * dt;
    }
  }

  /**
   * Confetti, not light.
   *
   * On the old dark build these were glowing embers; on paper that reading is
   * gone and chasing it is what produced two bugs at once. Now every particle
   * is a flat brand-colour chip with an ink edge on the larger ones — paper
   * confetti, which is exactly what the sticker kit would throw.
   *
   * Alpha is used ONLY to fade a particle out at the end of its life, which is
   * a change over time rather than a colour treatment, so it stays inside
   * DESIGN.md's ban on see-through colour.
   */
  draw(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';

    // Ink edges are the expensive half, so they are the first thing shed when
    // the frame-budget watchdog pulls quality down.
    const outline = this.quality >= 0.6;

    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (!this.alive[i]) continue;

      const t = this.life[i]! / this.maxLife[i]!;
      // Hold full opacity, then fade only over the last 25% of life.
      ctx.globalAlpha = t > 0.25 ? 1 : t / 0.25;

      const size = this.size[i]! * (0.55 + t * 0.45);
      ctx.fillStyle = this.colors[i]!;

      if (this.streak[i]) {
        // A rectangular chip aligned to travel — a torn strip of paper.
        const vx = this.vx[i]!;
        const vy = this.vy[i]!;
        const speed = Math.hypot(vx, vy);
        if (speed < 1) continue;
        const len = Math.min(size * 5, speed * 0.02);

        ctx.save();
        ctx.translate(this.x[i]!, this.y[i]!);
        ctx.rotate(Math.atan2(vy, vx));
        ctx.fillRect(-len, -size * 0.5, len, size);
        if (outline && size > 3) {
          ctx.strokeStyle = COLORS.ink;
          ctx.lineWidth = 1;
          ctx.strokeRect(-len, -size * 0.5, len, size);
        }
        ctx.restore();
      } else {
        // Square chips, not discs. A circle reads as a glow dot; a square chip
        // reads as cut paper, which is the kit's vocabulary.
        const half = size;
        ctx.fillRect(this.x[i]! - half, this.y[i]! - half, half * 2, half * 2);
        if (outline && size > 3) {
          ctx.strokeStyle = COLORS.ink;
          ctx.lineWidth = 1;
          ctx.strokeRect(this.x[i]! - half, this.y[i]! - half, half * 2, half * 2);
        }
      }
    }

    ctx.restore();
  }

  /**
   * Retained as a no-op.
   *
   * This was an additive bloom pass in `'screen'` composite. White is the
   * identity element for `screen`, so on paper it drew NOTHING while still
   * iterating 3000 slots and issuing two fills per live particle — pure cost,
   * zero pixels, and no error to notice it by. Bloom is also banned outright
   * by DESIGN.md ("no gradients or see-through colours").
   *
   * Kept rather than deleted because `GameBase` and several games call it; the
   * call sites are harmless and removing the method would break them.
   *
   * @deprecated Particles are flat chips now. Delete the call sites.
   */
  drawGlow(_ctx: CanvasRenderingContext2D, _spread = 2.4): void {
    /* intentionally empty — see above */
  }

  get count(): number {
    return this.liveCount;
  }

  clear(): void {
    this.alive.fill(0);
    this.liveCount = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Preset bursts                                                       */
/* ------------------------------------------------------------------ */

export const BURST = {
  /** Fruit slice / balloon pop. */
  splat(ps: ParticleSystem, x: number, y: number, color: string, scale = 1): void {
    ps.emit({
      x, y, count: 26, color,
      speed: 320 * scale, speedVariance: 260 * scale,
      size: 5 * scale, life: 0.7, gravity: 900, drag: 0.94,
    });
  },

  /** Confetti-ish celebration, falls under gravity. */
  celebrate(ps: ParticleSystem, x: number, y: number, colors: readonly string[], scale = 1): void {
    for (const color of colors) {
      ps.emit({
        x, y, count: 18, color,
        speed: 420 * scale, speedVariance: 360 * scale,
        size: 6 * scale, life: 1.5, lifeVariance: 0.8,
        gravity: 620, drag: 0.97, streak: true,
      });
    }
  },

  /** Directional spark, e.g. along a slice path. */
  spark(
    ps: ParticleSystem, x: number, y: number, angle: number, color: string, scale = 1
  ): void {
    ps.emit({
      x, y, count: 14, color, angle, spread: 0.9,
      speed: 520 * scale, speedVariance: 300 * scale,
      size: 3.5 * scale, life: 0.4, gravity: 260, drag: 0.9, streak: true,
    });
  },

  /** Soft upward drift. Used behind the attract-mode silhouette. */
  ambient(ps: ParticleSystem, x: number, y: number, color: string): void {
    ps.emit({
      x, y, count: 1, color,
      angle: -Math.PI / 2, spread: 1.2,
      speed: 40, speedVariance: 30,
      size: 2.5, life: 2.4, lifeVariance: 1.2,
      gravity: -14, drag: 0.995,
    });
  },
} as const;
