/**
 * Shared Canvas 2D drawing helpers — and the GDG brand component library.
 *
 * Everything here assumes a DPR-scaled context whose logical size is the CSS
 * pixel size of the canvas, so games never think about device pixel ratio.
 *
 * THE BRAND, IN ONE PARAGRAPH (see shell/theme.ts for the tokens):
 * white graph paper, black ink, four flat Google colours, heavy Archivo
 * capitals in code brackets, chunky sticker pills with HARD shadows. No blur,
 * no gradients, no see-through colour. If you are about to set `shadowBlur`,
 * you want `stickerPill`, `stickerCard` or `drawText`'s `shadow` instead.
 *
 * The sticker components below exist so that seven game files and three shell
 * screens stop hand-rolling ten slightly different cards. A tile, a badge, a
 * leaderboard row and a button are all the same object at different sizes, and
 * that is the entire reason the brand reads as one system.
 */

import {
  COLORS,
  FONTS,
  GRID_STEP,
  RADIUS,
  SHADOW,
  STROKE,
  TRACK,
  WEIGHT,
  prefersReducedMotion,
  rankColor,
  withAlpha,
} from '../shell/theme';

export interface Viewport {
  width: number;
  height: number;
  dpr: number;
}

/**
 * Sizes a canvas to its CSS box at the device pixel ratio.
 * @returns true when the size actually changed
 */
export function resizeCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): boolean {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);

  if (canvas.width === w && canvas.height === h) return false;

  canvas.width = w;
  canvas.height = h;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return true;
}

export function viewportOf(canvas: HTMLCanvasElement): Viewport {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return {
    width: canvas.width / dpr,
    height: canvas.height / dpr,
    dpr,
  };
}

/** vh units → logical pixels. All sizing goes through this. */
export function vh(v: Viewport, units: number): number {
  return (v.height * units) / 100;
}

/* ================================================================== */
/* Text                                                                */
/* ================================================================== */

export interface TextOptions {
  size: number;
  color?: string;
  font?: string;
  weight?: number | string;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  /**
   * HARD shadow offset, in logical px, straight down. Ink by default.
   * This is the brand's only shadow. See SHADOW in shell/theme.ts.
   */
  shadow?: number;
  shadowColor?: string;
  letterSpacing?: string;
  alpha?: number;
  /**
   * Draw a paper stroke around the glyphs (and their shadow) before filling,
   * so the text survives whatever the playfield puts behind it.
   *
   * FOR TEXT THAT CANNOT CHOOSE ITS BACKGROUND. Balloon Pop is the case: its
   * balloons stay poppable well above the shoulder line, so they rise THROUGH
   * the HUD band and cannot be culled or hidden under a shelf the way Pose
   * Match's wall can — a blue score ends up on a blue balloon. Pose Match's
   * opposite fix, `hudShelf`, is the right one when the playfield behind the
   * HUD is not interactive.
   *
   * On a paper background this is paper on paper: invisible by construction,
   * and two extra `strokeText` calls. So it is safe to leave on everywhere,
   * and it only shows up when it is earning its place.
   */
  knockout?: boolean;
}

export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  opts: TextOptions
): void {
  ctx.save();
  const weight = opts.weight ?? WEIGHT.black;
  const font = opts.font ?? FONTS.display;
  ctx.font = `${weight} ${opts.size}px ${font}`;
  ctx.textAlign = opts.align ?? 'center';
  ctx.textBaseline = opts.baseline ?? 'middle';
  if (opts.letterSpacing) ctx.letterSpacing = opts.letterSpacing;
  if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;

  const color = opts.color ?? COLORS.ink;

  // Callers leave shadow state set on the context around these calls; clear it
  // so a label never inherits a neighbour's blur.
  ctx.shadowBlur = 0;

  // Knockout first, under everything, so it surrounds the shadow too — a paper
  // ring around only the top layer would leave the shadow's silhouette bleeding
  // into whatever is behind.
  if (opts.knockout) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = opts.size * 0.14;
    ctx.strokeStyle = COLORS.paper;
    if (opts.shadow) ctx.strokeText(text, x, y + opts.shadow);
    ctx.strokeText(text, x, y);
  }

  if (opts.shadow) {
    // The brand shadow: the same glyphs, offset straight down, flat ink, no
    // blur. Two fills, no shadow state, effectively free.
    //
    // There is no `glow` branch any more. It was the last `shadowBlur` write in
    // the app, and after the conversion nothing passed it — `glow` on
    // SkeletonStyle is a HALO WIDTH, an unrelated thing that happens to share a
    // name. If you find yourself wanting a blur here, you want `stickerPill`.
    // A SHADOW THE SAME COLOUR AS THE GLYPH IS THE WORD PRINTED TWICE.
    //
    // The shadow exists to lift coloured text off the paper. When the text is
    // already ink and the shadow defaults to ink, the second fill is the same
    // letterforms in the same colour ~0.94vh lower — which from 3m reads as a
    // blurred double image, and was reported at the playtest as "text might be
    // doubled". It hit the largest text in the app.
    //
    // Guarded here rather than only at the call sites, because there were seven
    // of them and nothing stopped an eighth.
    const shadowColor = opts.shadowColor ?? COLORS.ink;
    if (shadowColor !== color) {
      ctx.fillStyle = shadowColor;
      ctx.fillText(text, x, y + opts.shadow);
    }
  }

  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

export function measureText(
  ctx: CanvasRenderingContext2D,
  text: string,
  size: number,
  // Explicitly `string`/`number`: FONTS and WEIGHT are `as const`, so an
  // inferred default would narrow the parameter to that one literal and reject
  // every other value.
  weight: number | string = WEIGHT.black,
  font: string = FONTS.display
): number {
  ctx.save();
  ctx.font = `${weight} ${size}px ${font}`;
  const w = ctx.measureText(text).width;
  ctx.restore();
  return w;
}

/**
 * Largest size at or below `size` that fits `maxWidth`.
 *
 * Every string on these screens is data — a game name, a player's initials, a
 * faction the club might rename the night before — and the TV's resolution is
 * unknown. Overflowing text is the most likely way this looks broken on the
 * day, and it is one measure call to prevent.
 */
export function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  size: number,
  weight: number | string = WEIGHT.black,
  font: string = FONTS.display
): number {
  if (!text) return size;
  const w = measureText(ctx, text, size, weight, font);
  if (w <= maxWidth || w === 0) return size;
  return Math.max(1, size * (maxWidth / w));
}

/**
 * Greedy word wrap to at most `maxLines`.
 *
 * The alternative — shrinking a long string until it fits on one line — is how
 * the most important sentence on a screen ends up at 1.6vh and stops being
 * readable from 3m. Wrapping trades vertical space, which these layouts have,
 * for type size, which they do not.
 */
export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  size: number,
  weight: number | string = WEIGHT.black,
  font: string = FONTS.display,
  maxLines = 2
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  ctx.save();
  ctx.font = `${weight} ${size}px ${font}`;
  const lines: string[] = [];
  let line = words[0] ?? '';
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    const candidate = `${line} ${word}`;
    if (ctx.measureText(candidate).width <= maxWidth || lines.length + 1 >= maxLines) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  ctx.restore();
  return lines;
}

/**
 * TABULAR NUMBERS.
 *
 * DESIGN.md requires numbers in tabular format. Canvas 2D has no
 * `font-feature-settings`, so there is no way to ask the font for `tnum` — the
 * digit advance has to be fixed by hand. Every digit is drawn at the width of
 * '0'; separators keep their natural width.
 *
 * This is not pedantry. A `RollingNumber` counting up in proportional figures
 * changes width on almost every frame, so the score visibly jitters left and
 * right while it settles, and a column of leaderboard scores never lines up.
 * Both are exactly what tabular figures exist to prevent.
 *
 * Use this for every score, timer, rank and points total in the app.
 */
export function drawTabularNumber(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  opts: TextOptions
): void {
  const weight = opts.weight ?? WEIGHT.black;
  const font = opts.font ?? FONTS.display;

  ctx.save();
  ctx.font = `${weight} ${opts.size}px ${font}`;
  if (opts.letterSpacing) ctx.letterSpacing = opts.letterSpacing;
  const digitW = ctx.measureText('0').width;

  const chars = [...text];
  const widths = chars.map((c) => (c >= '0' && c <= '9' ? digitW : ctx.measureText(c).width));
  const total = widths.reduce((a, b) => a + b, 0);
  ctx.restore();

  const align = opts.align ?? 'center';
  let cursor = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;

  // Each glyph is centred in its own fixed-width cell, so '1' sits where '8'
  // would and the number stops dancing as it rolls.
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    const w = widths[i]!;
    drawText(ctx, c, cursor + w / 2, y, { ...opts, align: 'center' });
    cursor += w;
  }
}

/** Width `drawTabularNumber` will occupy. For laying out around a score. */
export function measureTabularNumber(
  ctx: CanvasRenderingContext2D,
  text: string,
  size: number,
  weight: number | string = WEIGHT.black,
  font: string = FONTS.display
): number {
  ctx.save();
  ctx.font = `${weight} ${size}px ${font}`;
  const digitW = ctx.measureText('0').width;
  let total = 0;
  for (const c of text) total += c >= '0' && c <= '9' ? digitW : ctx.measureText(c).width;
  ctx.restore();
  return total;
}

/* ================================================================== */
/* Shape primitives                                                    */
/* ================================================================== */

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Runs `fn` with the canvas rotated about (cx, cy).
 *
 * DESIGN.md allows −14°..+12° on DECORATIVE stickers only. Inputs, tables,
 * dates and numbers stay straight — a tilted score is unreadable and a tilted
 * button looks broken rather than playful.
 */
export function withTilt(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  degrees: number,
  fn: () => void
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.translate(-cx, -cy);
  fn();
  ctx.restore();
}

/* ================================================================== */
/* The sticker system                                                  */
/* ================================================================== */

export interface StickerOptions {
  /** Corner radius in logical px. Defaults to the card radius. */
  radius?: number;
  /** Flat fill. Paper by default. Never a gradient, never translucent. */
  fill?: string;
  /** Outline colour. Ink by default. Pass null for a flat, unoutlined block. */
  outline?: string | null;
  /** Outline width in logical px. Defaults to STROKE.base. */
  outlineWidth?: number;
  /**
   * Hard shadow offset in logical px, straight down, zero blur.
   * Pass 0 for a "flat card" — the brand's way of grouping without emphasis.
   */
  shadow?: number;
  shadowColor?: string;
  alpha?: number;
}

/**
 * The signature element: a sticker. Fully rounded or card-cornered, flat fill,
 * chunky ink outline, and a hard shadow offset straight down with NO blur.
 *
 * Everything visible in this app that is a discrete object — a menu tile, a
 * leaderboard row, a letter key, a badge, a button — is one of these. That is
 * the point: one shape language, three sizes.
 */
export function sticker(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: StickerOptions = {}
): void {
  const radius = Math.min(opts.radius ?? vh(v, RADIUS.card), w / 2, h / 2);
  const drop = opts.shadow ?? vh(v, SHADOW.base);

  ctx.save();
  if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;
  ctx.shadowBlur = 0;

  // The shadow is a second solid shape, not a blur. Drawn first, offset only
  // on Y — the brand is explicit that shadows point straight down.
  if (drop > 0) {
    ctx.fillStyle = opts.shadowColor ?? COLORS.ink;
    roundRect(ctx, x, y + drop, w, h, radius);
    ctx.fill();
  }

  ctx.fillStyle = opts.fill ?? COLORS.paper;
  roundRect(ctx, x, y, w, h, radius);
  ctx.fill();

  const outline = opts.outline === undefined ? COLORS.ink : opts.outline;
  if (outline) {
    ctx.strokeStyle = outline;
    ctx.lineWidth = opts.outlineWidth ?? vh(v, STROKE.base);
    roundRect(ctx, x, y, w, h, radius);
    ctx.stroke();
  }
  ctx.restore();
}

/** A sticker with the card radius. Tiles, panels, leaderboards. */
export function stickerCard(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: StickerOptions = {}
): void {
  sticker(ctx, v, x, y, w, h, { radius: vh(v, RADIUS.card), ...opts });
}

/** A fully rounded sticker. Buttons, badges, rows, inputs. */
export function stickerPill(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: StickerOptions = {}
): void {
  sticker(ctx, v, x, y, w, h, { radius: h / 2, ...opts });
}

export interface LabelPillOptions extends StickerOptions {
  /** Label colour. Ink by default. */
  color?: string;
  size?: number;
  weight?: number | string;
  letterSpacing?: string;
  /** Decorative tilt in degrees. Straight (0) for anything readable. */
  tilt?: number;
  /** Horizontal padding as a multiple of the pill height. */
  padRatio?: number;
}

/**
 * A pill with its label, measured and drawn in one call, centred on (cx, cy).
 * Returns the width it occupied so a caller can lay out around it.
 *
 * This is the single most repeated object in the app — "BE THE FIRST",
 * "COMING SOON", "NEW BEST!", "HOLD STILL" — and having one implementation is
 * what stops six screens drifting into six slightly different badges.
 */
export function labelPill(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  cx: number,
  cy: number,
  label: string,
  h: number,
  opts: LabelPillOptions = {}
): number {
  const size = opts.size ?? h * 0.44;
  const weight = opts.weight ?? WEIGHT.bold;
  const spacing = opts.letterSpacing ?? TRACK.pill;
  const padRatio = opts.padRatio ?? 0.62;

  ctx.save();
  ctx.letterSpacing = spacing;
  const textW = measureText(ctx, label, size, weight, FONTS.body);
  ctx.restore();

  const w = textW + h * padRatio * 2;
  const draw = (): void => {
    stickerPill(ctx, v, cx - w / 2, cy - h / 2, w, h, opts);
    drawText(ctx, label, cx, cy, {
      size,
      color: opts.color ?? COLORS.ink,
      font: FONTS.body,
      weight,
      letterSpacing: spacing,
    });
  };

  if (opts.tilt) withTilt(ctx, cx, cy, opts.tilt, draw);
  else draw();
  return w;
}

/**
 * The brand's ranked-list row: a thin-outlined pill carrying a round rank
 * badge, a name, and a right-aligned tabular number.
 *
 * Empty places are drawn dashed and muted rather than omitted. A leaderboard
 * that renders nothing until someone has played does not say "be the first",
 * it says "broken" — and on the morning of day one every board in the building
 * is empty.
 */
export interface RankedRowOptions {
  rank: number;
  name?: string;
  value?: string;
  /** Highlight the row (the current player's entry, the live leader). */
  accent?: string;
}

export function rankedRow(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: RankedRowOptions
): void {
  const filled = !!opts.name;
  const badgeR = h * 0.34;
  const badgeCx = x + h * 0.58;
  const cy = y + h / 2;
  const nameX = badgeCx + badgeR + h * 0.42;
  const pad = h * 0.5;

  if (!filled) {
    // Dashed, muted, no shadow. Reads as "this place is open".
    ctx.save();
    ctx.setLineDash([h * 0.24, h * 0.18]);
    ctx.strokeStyle = COLORS.muted;
    ctx.lineWidth = vh(v, STROKE.thin);
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.stroke();
    ctx.restore();
  } else {
    stickerPill(ctx, v, x, y, w, h, {
      fill: COLORS.paper,
      outlineWidth: vh(v, opts.accent ? STROKE.base : STROKE.thin),
      outline: opts.accent ?? COLORS.ink,
      shadow: opts.accent ? vh(v, SHADOW.base) : 0,
    });
  }

  // Rank badge. Yellow 1st, blue 2nd, red 3rd, ink after that.
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(badgeCx, cy, badgeR, 0, Math.PI * 2);
  ctx.fillStyle = filled ? rankColor(opts.rank) : COLORS.paper;
  ctx.fill();
  ctx.strokeStyle = filled ? COLORS.ink : COLORS.muted;
  ctx.lineWidth = vh(v, STROKE.thin);
  ctx.stroke();
  ctx.restore();

  drawTabularNumber(ctx, String(opts.rank), badgeCx, cy, {
    size: badgeR * 1.15,
    color: filled ? COLORS.ink : COLORS.muted,
    font: FONTS.body,
    weight: WEIGHT.black,
    letterSpacing: TRACK.number,
  });

  if (!filled) return;

  drawText(ctx, opts.name ?? '', nameX, cy, {
    size: h * 0.44,
    color: COLORS.ink,
    font: FONTS.body,
    weight: WEIGHT.black,
    align: 'left',
    letterSpacing: TRACK.pill,
  });

  if (opts.value !== undefined) {
    drawTabularNumber(ctx, opts.value, x + w - pad, cy, {
      size: h * 0.46,
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.black,
      align: 'right',
      letterSpacing: TRACK.number,
    });
  }
}

/**
 * The brand's decorative shapes, generated rather than loaded.
 *
 * DESIGN.md ships seven flat shapes as `kit/assets/shapes.svg`, but
 * ARCHITECTURE.md rule 2 forbids downloaded art and rule 3 forbids runtime
 * network calls, so they are drawn here instead. Flat brand colour only, never
 * outlined, scattered 2–6 near the edges, kept clear of readable text.
 */
export type DecorKind = 'triangle' | 'circle' | 'halfCircle' | 'capsule' | 'bar' | 'blob';

export function decorShape(
  ctx: CanvasRenderingContext2D,
  kind: DecorKind,
  cx: number,
  cy: number,
  r: number,
  color: string,
  tilt = 0
): void {
  const draw = (): void => {
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = color;
    ctx.beginPath();
    switch (kind) {
      case 'triangle':
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx + r * 0.92, cy + r * 0.7);
        ctx.lineTo(cx - r * 0.92, cy + r * 0.7);
        ctx.closePath();
        break;
      case 'circle':
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        break;
      case 'halfCircle':
        ctx.arc(cx, cy + r * 0.4, r, Math.PI, Math.PI * 2);
        ctx.closePath();
        break;
      case 'capsule':
        roundRect(ctx, cx - r, cy - r * 0.46, r * 2, r * 0.92, r * 0.46);
        break;
      case 'bar':
        ctx.rect(cx - r, cy - r * 0.26, r * 2, r * 0.52);
        break;
      case 'blob':
        // Four arcs at uneven radii. Reads as the kit's organic blob without
        // needing a path from an SVG.
        for (let i = 0; i <= 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          const rr = r * (0.82 + 0.18 * Math.sin(a * 3 + 0.8));
          const px = cx + Math.cos(a) * rr;
          const py = cy + Math.sin(a) * rr;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        break;
    }
    ctx.fill();
    ctx.restore();
  };
  if (tilt) withTilt(ctx, cx, cy, tilt, draw);
  else draw();
}

/* ================================================================== */
/* Surfaces and transitions                                            */
/* ================================================================== */

/**
 * The brand's substrate: white paper, ruled in #ECECEC.
 *
 * DRAWN LIVE, BATCHED INTO A SINGLE `stroke()`, AND DELIBERATELY COARSE.
 * Three faster-looking implementations were measured and rejected; the notes
 * are here so nobody re-litigates them at the venue.
 *
 * Measured at 1920x1080, cost above a plain full-screen fill:
 *
 *   live, 92 hairlines (32px grid), one stroke()          2.44 ms
 *   live, 46 hairlines (64px grid), one stroke()         ~1.20 ms   ← chosen
 *   full-screen bitmap cache, blitted 1:1                 1.15 ms   ← rejected
 *   32x32 tile as a repeating pattern                     0.53 ms   ← rejected
 *
 * The two "faster" options are faster ONLY in isolation. Inside the real
 * render loop both collapsed:
 *
 *  - The full-screen cache measured **31 ms/frame**. It was keyed on canvas
 *    size and `dpr`; `devicePixelRatio` is fractional and not perfectly stable
 *    in a scaled window, so the key flickered, and every flicker reallocated a
 *    2880x1620 backing store and re-stroked the whole grid into it mid-frame.
 *    A cache whose key can flicker is worse than no cache.
 *  - The repeating pattern measured **10 ms/frame**, against 0.53 ms in
 *    isolation. Both it and the blit need `setTransform` to an identity matrix
 *    to stay pixel-exact, and a transform reset plus a texture-sampled
 *    full-screen fill as the first operation of the frame appears to cost the
 *    canvas its fast path for everything drawn afterwards.
 *
 * So: no cache, no pattern, no transform games. Just half as many lines.
 *
 * GRID_STEP is 6vh (~65px at 1080p) rather than the kit's 32px because the kit
 * specifies 32px for a web page read at arm's length. At three metres a 1px
 * rule at 6% contrast is at the edge of being resolvable at all, and a 32px
 * grid resolves as a flat tint — so the coarser grid is both cheaper AND more
 * legible as graph paper, which is the only reason it is on screen.
 *
 * Callers may skip this entirely under frame-budget pressure; see
 * `AttractScreen.showGrid`. Plain paper is a perfectly good background.
 */
export function graphPaper(ctx: CanvasRenderingContext2D, v: Viewport, color = COLORS.grid): void {
  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(0, 0, v.width, v.height);

  const step = vh(v, GRID_STEP);
  if (step < 8) return;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  // One path, one stroke. A stroke per line would be ~46 separate draw calls.
  ctx.beginPath();
  for (let x = step; x < v.width; x += step) {
    const px = Math.round(x) + 0.5;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, v.height);
  }
  for (let y = step; y < v.height; y += step) {
    const py = Math.round(y) + 0.5;
    ctx.moveTo(0, py);
    ctx.lineTo(v.width, py);
  }
  ctx.stroke();
  ctx.restore();
}

export function clearFrame(ctx: CanvasRenderingContext2D, v: Viewport, color = COLORS.paper): void {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, v.width, v.height);
}

/**
 * Screen transition: a HARD WIPE, not a crossfade.
 *
 * A fade is a gradient in time and shows the outgoing screen at partial
 * opacity, which is the "see-through colour" DESIGN.md rules out. A solid ink
 * panel crossing the screen is flat at every instant, reads as deliberate from
 * across a hall, and is the same cost as a fillRect.
 *
 * `t` runs 0→1. `cover` closes the screen, `reveal` opens it.
 * Under `prefers-reduced-motion` this becomes an instant cut — the brand
 * requires it, and a wipe carries no information.
 */
export function wipe(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  t: number,
  mode: 'cover' | 'reveal',
  color = COLORS.ink
): void {
  if (t <= 0 && mode === 'cover') return;
  if (t >= 1 && mode === 'reveal') return;

  if (prefersReducedMotion()) {
    // Instant cut: fully covered or not at all, never a moving band.
    if (mode === 'cover' && t >= 1) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, v.width, v.height);
    }
    return;
  }

  const p = Math.max(0, Math.min(1, t));
  // Cover sweeps in from the left; reveal continues off to the right, so a
  // screen change reads as one continuous movement rather than two events.
  const w = mode === 'cover' ? v.width * p : v.width * (1 - p);
  const x = mode === 'cover' ? 0 : v.width * p;
  if (w <= 0) return;

  ctx.save();
  ctx.shadowBlur = 0;
  ctx.fillStyle = color;
  ctx.fillRect(x, 0, w, v.height);
  // Leading edge in the action colour. One flat bar; makes the wipe feel like
  // a swipe rather than a black rectangle appearing.
  const edge = vh(v, 1.2);
  ctx.fillStyle = COLORS.yellow;
  ctx.fillRect(mode === 'cover' ? x + w - edge : x, 0, edge, v.height);
  ctx.restore();
}

/**
 * Drives the two halves of `wipe` from a screen's own clock.
 *
 * `enter` counts up from mount; `exit` counts up from the moment the screen
 * decided to leave (null while it is staying). Returns `{ t, mode }` to hand
 * straight to `wipe`.
 *
 * Screens fade themselves because `main.ts` and `router.ts` own the swap and
 * are off limits, so the outgoing screen's cover and the incoming screen's
 * reveal meet in the middle.
 */
export function transition(
  enter: number,
  exit: number | null,
  duration: number
): { t: number; mode: 'cover' | 'reveal' } {
  if (duration <= 0) return { t: exit !== null ? 1 : 1, mode: exit !== null ? 'cover' : 'reveal' };
  if (exit !== null) return { t: Math.min(1, exit / duration), mode: 'cover' };
  return { t: Math.min(1, enter / duration), mode: 'reveal' };
}

/**
 * Horizontal progress bar. Grid-coloured track, flat brand-colour fill, ink
 * outline, no blur.
 *
 * Used by nearly every HUD, so converting it here converts every game's timer
 * bar without touching a game file.
 */
export function progressBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  t: number,
  color: string,
  // Kept so the existing call sites compile. Ignored — the brand has no glow.
  _glow = 0
): void {
  ctx.save();
  ctx.shadowBlur = 0;

  ctx.fillStyle = COLORS.grid;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();

  const fill = Math.max(0, Math.min(1, t)) * w;
  if (fill > 0) {
    ctx.save();
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.clip();
    ctx.fillStyle = color;
    roundRect(ctx, x, y, Math.max(fill, h), h, h / 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = Math.max(1, h * 0.22);
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.stroke();
  ctx.restore();
}

/* ================================================================== */
/* Legacy — off-brand, retained so the games still compile             */
/* ================================================================== */


/**
 * A flat disc with an ink outline — the brand's circle.
 *
 * The `glow` parameter is ignored; the signature is kept because three game
 * files call it. Pass `outline: false` via `glowCircleFlat` if you need a
 * bare disc.
 *
 * @deprecated Prefer `sticker` / `labelPill`, or draw a flat arc yourself.
 */
export function glowCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  _glow = 0,
  alpha = 1
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowBlur = 0;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = Math.max(1, r * 0.16);
  ctx.stroke();
  ctx.restore();
}

/**
 * @deprecated A vignette is a gradient, and the brand has no gradients. This
 * is a no-op kept so the game files that call it still compile.
 */
export function vignette(_ctx: CanvasRenderingContext2D, _v: Viewport, _strength = 0.5): void {
  /* intentionally empty — see the deprecation note */
}

/**
 * @deprecated Scanlines are a dark-arcade affectation, not this brand. No-op.
 */
export function scanlines(_ctx: CanvasRenderingContext2D, _v: Viewport, _alpha = 0.04): void {
  /* intentionally empty — see the deprecation note */
}

/**
 * @deprecated Off-brand: a translucent surface. Use `stickerCard`.
 * Kept as a thin wrapper so nothing breaks mid-conversion.
 */
export function panel(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: { radius?: number; fill?: string; border?: string | null; alpha?: number } = {}
): void {
  stickerCard(ctx, v, x, y, w, h, {
    radius: opts.radius,
    fill: opts.fill ?? COLORS.paper,
    outline: opts.border === null ? null : COLORS.ink,
    alpha: opts.alpha,
  });
}

/** @deprecated Use `labelPill`, which measures and draws the label too. */
export function pill(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  _fillAlpha = 0,
  shadow = true
): void {
  stickerPill(ctx, v, x, y, w, h, {
    fill: color,
    outline: COLORS.ink,
    shadow: shadow ? vh(v, SHADOW.base) : 0,
  });
}

/** Re-exported for the one legitimate masking use. See the note in theme.ts. */
export { withAlpha };
