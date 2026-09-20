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
 * The overlap of two boxes, or `null` when they do not touch.
 *
 * A string drawn outside an active clip is INVISIBLE, not misplaced, and
 * counting it is the third way this measurement lied. Attract's leaderboard
 * rail draws its boards at x beyond the stage and clips to the rail box; the
 * first clip-blind run reported `HIGH SCORES` 350px off a 1024 stage, which
 * is true of the coordinates and false of the screen.
 */
export function intersect(a: Box, b: Box): Box | null {
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.right, b.right);
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return null;
  return { left, right, top, bottom };
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

/* ------------------------------------------------------------------ */
/* The probe that uses the arithmetic above                            */
/* ------------------------------------------------------------------ */

import { runTurn } from './turn';

export interface LayoutReport {
  stage: { w: number; h: number };
  /** Strings whose ink left the safe area, worst first. */
  overflow: Array<{ text: string; px: number }>;
  /** Settled size of the smallest strings, smallest first. */
  smallest: Array<{ text: string; vh: number }>;
  distinct: number;
  insetPx: number;
}

interface LayoutHost {
  audio: unknown;
}

/**
 * Sweep the roster and report what leaves the safe area, or is too small.
 *
 * Run it at 4:3. Everything here is fine at 16:9 and the stall's panel is
 * unknown until setup — the first 4:3 sweep found three real defects and only
 * happened because the pane was the wrong shape by accident.
 *
 * TWO RULES THIS ENCODES, both learned by getting them wrong:
 *
 *   - SIZE IS THE MAXIMUM over a string's life, not the minimum. A score
 *     drawing at 14vh inside a pop-scale is genuinely 1.4vh on its first
 *     frame; reporting that as the size makes every animated string a defect.
 *   - EXTENT IS FOUR CORNERS through the full matrix. `withTilt` rotates
 *     cards, and an axis-aligned box around a rotated one is the only honest
 *     answer to "did any ink leave the stage".
 */
export async function runLayoutSweep(
  host: LayoutHost,
  only?: string[],
  insetVh = 0,
): Promise<LayoutReport> {
  const canvas = document.querySelector('canvas');
  if (!canvas || canvas.width <= 300) {
    throw new Error(
      `runLayoutSweep: the stage is ${canvas?.width ?? 0}x${canvas?.height ?? 0}. ` +
        'It reports 300x150 until the render loop has run once, and every ' +
        'derived figure would be out by that ratio. Drive a few frames first.',
    );
  }
  const W = canvas.width;
  const H = canvas.height;
  const insetPx = (insetVh / 100) * H;

  const maxVh = new Map<string, number>();
  const maxOut = new Map<string, number>();

  const proto = CanvasRenderingContext2D.prototype;
  const orig = proto.fillText;

  // CLIP TRACKING, because a clipped string is invisible rather than wrong.
  //
  // Only rectangular clips are followed, which is what this app uses: every
  // `clip()` here is preceded by a single `rect()`. A non-rectangular clip
  // leaves the previous box in place, which errs toward REPORTING a string
  // rather than hiding one — the safe direction for a probe.
  const origSave = proto.save;
  const origRestore = proto.restore;
  const origRect = proto.rect;
  const origClip = proto.clip;
  // UNBOUNDED, NOT THE STAGE. Seeding the clip with the stage rectangle makes
  // `intersect` clamp every off-stage string back to the edge, and an
  // edge-aligned box overflows the stage by exactly zero — so a clip-aware
  // sweep reported NO overflow anywhere, which is the same false clean bill
  // as before with an extra step. The tell was that every string at a 3.5%
  // inset overflowed by exactly the inset.
  //
  // The clip starts as "everything" and only ever narrows when the app calls
  // `clip()`. Then a string past the edge stays past it.
  const full: Box = { left: -1e9, right: 1e9, top: -1e9, bottom: 1e9 };
  let clip: Box = full;
  const stack: Box[] = [];
  let lastRect: Box | null = null;

  proto.save = function (this: CanvasRenderingContext2D) {
    stack.push(clip);
    return origSave.call(this);
  };
  proto.restore = function (this: CanvasRenderingContext2D) {
    clip = stack.pop() ?? full;
    return origRestore.call(this);
  };
  proto.rect = function (this: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
    const m = this.getTransform();
    lastRect = textBounds(m, x, y, { width: w, ascent: 0, descent: h }, 'left');
    return origRect.call(this, x, y, w, h);
  } as typeof proto.rect;
  proto.clip = function (this: CanvasRenderingContext2D, ...a: never[]) {
    if (lastRect) clip = intersect(clip, lastRect) ?? clip;
    return (origClip as (...z: never[]) => void).call(this, ...a);
  } as typeof proto.clip;
  proto.fillText = function (this: CanvasRenderingContext2D, text: string | number, ...rest: never[]) {
    try {
      const s = String(text);
      if (s.trim()) {
        const x = Number(rest[0] ?? 0);
        const y = Number(rest[1] ?? 0);
        const m = this.getTransform();
        const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 0);

        const vh = drawnVh(m, px, H);
        if (vh > (maxVh.get(s) ?? 0)) maxVh.set(s, vh);

        const tm = this.measureText(s);
        const box = textBounds(
          m,
          x,
          y,
          {
            width: tm.width,
            ascent: tm.actualBoundingBoxAscent || px * 0.8,
            descent: tm.actualBoundingBoxDescent || px * 0.2,
          },
          this.textAlign,
        );
        // Only the visible part of the string can overflow anything.
        const shown = intersect(box, clip);
        const out = shown ? overflowOf(shown, W, H, insetPx) : 0;
        if (out > (maxOut.get(s) ?? 0)) maxOut.set(s, out);
      }
    } catch {
      /* a probe must never break a frame */
    }
    return (orig as (...a: never[]) => void).call(this, text as never, ...rest);
  } as typeof proto.fillText;

  try {
    await runTurn(host as never, only);
  } finally {
    proto.fillText = orig;
    proto.save = origSave;
    proto.restore = origRestore;
    proto.rect = origRect;
    proto.clip = origClip;
  }

  return {
    stage: { w: W, h: H },
    insetPx: Math.round(insetPx),
    distinct: maxVh.size,
    overflow: [...maxOut.entries()]
      .filter(([, px]) => px > 0.5)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([text, px]) => ({ text, px: Math.round(px) })),
    smallest: [...maxVh.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, 12)
      .map(([text, vh]) => ({ text, vh: Number(vh.toFixed(2)) })),
  };
}
