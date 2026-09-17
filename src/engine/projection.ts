/**
 * Maps normalised camera space (0..1) to screen pixels.
 *
 * Three things have to be reconciled and getting any of them wrong makes a
 * game feel subtly broken in a way that's very hard to debug from a desk:
 *
 *  1. MIRRORING. The TV is a mirror. If the player raises the hand on their
 *     right, the glow must appear on the right side of the screen as they look
 *     at it. Every consumer-facing coordinate is mirrored; raw tracker space
 *     is not.
 *
 *  2. ASPECT. A 16:9 camera on a 16:9 TV is easy. A 4:3 laptop cam on a 16:9 TV
 *     is not, and one of the two has to give.
 *
 *  3. FIT MODE. 'cover' fills the screen and crops the camera — right for a
 *     backdrop. 'contain' shows the whole camera frame — right for the rig
 *     check, where cropping would hide exactly the framing problem we're
 *     looking for.
 */

import type { Viewport } from './draw';

export type FitMode = 'cover' | 'contain';

export interface ProjectionOptions {
  cameraWidth: number;
  cameraHeight: number;
  fit: FitMode;
  mirrored: boolean;
}

export class Projection {
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private drawW = 0;
  private drawH = 0;

  constructor(
    private v: Viewport,
    private opts: ProjectionOptions
  ) {
    this.recompute();
  }

  update(v: Viewport, opts: Partial<ProjectionOptions> = {}): void {
    this.v = v;
    this.opts = { ...this.opts, ...opts };
    this.recompute();
  }

  private recompute(): void {
    const { cameraWidth: cw, cameraHeight: ch, fit } = this.opts;
    if (cw <= 0 || ch <= 0) {
      this.scale = 1;
      this.drawW = this.v.width;
      this.drawH = this.v.height;
      this.offsetX = 0;
      this.offsetY = 0;
      return;
    }

    const sx = this.v.width / cw;
    const sy = this.v.height / ch;
    this.scale = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);

    this.drawW = cw * this.scale;
    this.drawH = ch * this.scale;
    this.offsetX = (this.v.width - this.drawW) / 2;
    this.offsetY = (this.v.height - this.drawH) / 2;
  }

  /** Normalised camera X (0..1) → screen pixels, mirrored if configured. */
  x(nx: number): number {
    const n = this.opts.mirrored ? 1 - nx : nx;
    return this.offsetX + n * this.drawW;
  }

  y(ny: number): number {
    return this.offsetY + ny * this.drawH;
  }

  /** Normalised length → screen pixels. Use for radii and stroke widths that
   *  should scale with the player's apparent size. */
  len(n: number): number {
    return n * this.drawH;
  }

  point(p: { x: number; y: number }): { x: number; y: number } {
    return { x: this.x(p.x), y: this.y(p.y) };
  }

  /** The rect the camera image occupies on screen. */
  get rect(): { x: number; y: number; width: number; height: number } {
    return { x: this.offsetX, y: this.offsetY, width: this.drawW, height: this.drawH };
  }

  /** Draws the camera feed itself, honouring mirror and fit. */
  drawVideo(
    ctx: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    alpha = 1
  ): void {
    if (video.readyState < 2) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (this.opts.mirrored) {
      ctx.translate(this.v.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, this.offsetX, this.offsetY, this.drawW, this.drawH);
    ctx.restore();
  }
}
