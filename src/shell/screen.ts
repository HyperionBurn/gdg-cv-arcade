/**
 * The contract every screen (menu, game, attract, diagnostics) implements.
 *
 * Deliberately tiny. Games are modes inside one app and one camera stream —
 * PLAN.md §1 — so a screen never touches getUserMedia, never owns a canvas,
 * and never runs its own requestAnimationFrame. It just gets told to update
 * and draw.
 */

import type { Viewport } from '../engine/draw';
import type { VisionFrame } from '../core/types';

export interface FrameContext {
  /** Seconds since the app started. */
  time: number;
  /** Seconds since last frame, clamped to avoid spiral-of-death on a stall. */
  dt: number;
  /** performance.now(), for anything measuring wall-clock intervals. */
  now: number;
  v: Viewport;
  ctx: CanvasRenderingContext2D;
  /** Latest vision result. Null before the first inference completes. */
  vision: VisionFrame | null;
}

export interface Screen {
  readonly id: string;
  /** DOM the screen wants alongside the canvas (diagnostic panels, etc). */
  mount?(root: HTMLElement): void | Promise<void>;
  unmount?(): void;
  /** Called once per rendered frame. Simulation and drawing both happen here. */
  render(fc: FrameContext): void;
  /** Screen wants to hand control to another screen. */
  onExit?: (next: string) => void;
}
