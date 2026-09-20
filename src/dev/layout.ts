/**
 * Where a drawn string actually lands on the stage.
 *
 * THIS EXISTS BECAUSE I GOT IT WRONG THREE TIMES IN A ROW.
 *
 * Re-running the 4:3 overflow sweep on the 20th produced three different
 * answers for the same string — `<SAVED!>` at 272px off the right edge, then
 * 17px, then 525px — and none of them were true. The bugs were all in the
 * measuring:
 *
 *   1. Reading the raw `x` passed to `fillText` ignores the canvas transform,
 *      and popups draw inside `juice.pushTransform`. That invented the 272.
 *   2. Applying the transform to a single point still assumes the text is
 *      axis-aligned. `withTilt` ROTATES cards and stickers, and under rotation
 *      `left + width * scaleX` describes nothing. That invented the 525.
 *
 * So the box is computed the only way that survives rotation: take all four
 * corners of the text's own bounding box, push each through the full matrix,
 * and take the extremes. An axis-aligned box around a rotated one is bigger
 * than the glyphs — that is correct for an overflow question, which asks
 * whether any ink left the stage.
 *
 * Kept pure and separate from the probe that uses it, because the arithmetic
 * is the part that was wrong and arithmetic can be tested without a canvas.
 */

/** The six numbers of a DOMMatrix, in canvas order. */
export interface Matrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface TextMetricsLike {
  /** `measureText(s).width`, in the context's own units. */
  width: number;
  /** Distance above the baseline. `actualBoundingBoxAscent` when available. */
  ascent: number;
  /** Distance below the baseline. `actualBoundingBoxDescent` when available. */
  descent: number;
}

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Apply a 2D matrix to a point. */
function apply(m: Matrix2D, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

/**
 * The axis-aligned box a string occupies on the stage, after the transform.
 *
 * `align` shifts the box horizontally the way `textAlign` does; the vertical
 * extent comes from the ascent and descent, which is why they are asked for
 * rather than guessed from the font size — a font's box is not its em size.
 */
export function textBounds(
  m: Matrix2D,
  x: number,
  y: number,
  metrics: TextMetricsLike,
  align: CanvasTextAlign = 'left',
): Box {
  const w = metrics.width;
  const left = align === 'center' ? x - w / 2 : align === 'right' || align === 'end' ? x - w : x;
  const right = left + w;
  const top = y - metrics.ascent;
  const bottom = y + metrics.descent;

  // All four corners, because a rotated box has no shortcut.
  const pts = [
    apply(m, left, top),
    apply(m, right, top),
    apply(m, left, bottom),
    apply(m, right, bottom),
  ];

  return {
    left: Math.min(...pts.map((p) => p.x)),
    right: Math.max(...pts.map((p) => p.x)),
    top: Math.min(...pts.map((p) => p.y)),
    bottom: Math.max(...pts.map((p) => p.y)),
  };
}

/**
 * How far a box escapes a stage, in stage pixels. Zero when it is inside.
 *
 * `inset` is the overscan margin: a TV crops its edges, so "on the stage" is
 * not the same as "safe to read". PLAN.md budgets 3.5% and `SAFE` in theme.ts
 * is the same number in vh.
 */
export function overflowOf(box: Box, stageW: number, stageH: number, inset = 0): number {
  return Math.max(
    0,
    inset - box.left,
    box.right - (stageW - inset),
    inset - box.top,
    box.bottom - (stageH - inset),
  );
}

/**
 * The vertical size of drawn text as a percentage of stage height.
 *
 * Scaled by the matrix, because a popup mid-pop is genuinely smaller than its
 * nominal size — and because reading the nominal size instead is how a score
 * that draws at 14vh got recorded as 1.41vh on the first frame of its
 * scale-up. Callers that want the SETTLED size must take the maximum over a
 * string's life rather than the minimum.
 */
export function drawnVh(m: Matrix2D, fontPx: number, stageH: number): number {
  const verticalScale = Math.hypot(m.c, m.d);
  return ((fontPx * verticalScale) / stageH) * 100;
}
