/**
 * Dwell-to-select hand cursor — the only input device at the stall.
 *
 * PLAN.md §6: "Hand-hover menu — dwell 1.2s. No keyboard, no mouse, no
 * operator handoff." Nobody touches the laptop, so this file is the entire
 * input layer for the shell. If it is unreliable, the stall is unreliable.
 *
 * Three design calls, all of which are load-bearing:
 *
 * 1. IT IS DRIVEN BY POSE WRISTS, NOT HAND LANDMARKS.
 *    PLAN.md §9 requires ~2.5–3m of clear depth so the camera can frame a
 *    whole body. At that distance a hand is a few dozen pixels across and
 *    MediaPipe's hand model drops out constantly, while the pose model's
 *    wrist keypoint stays rock solid because it is inferred from the whole
 *    arm. A cursor that vanishes whenever the hand model blinks is worse than
 *    no cursor. So: POSE.LEFT_WRIST / POSE.RIGHT_WRIST, whichever is raised
 *    higher, with hysteresis on the swap so level hands don't flip-flop.
 *
 * 2. THE CURSOR IS BODY-RELATIVE, NOT CAMERA-RELATIVE.
 *    This is the non-obvious one. At 3m a standing adult's wrist sweeps only
 *    about a third of the camera's width, so mapping camera space straight
 *    through `Projection` would confine the cursor to the middle third of the
 *    TV and make the outer menu tiles physically unreachable. Instead the
 *    wrist is measured as an offset from the shoulder centre, divided by body
 *    scale — horizontally in shoulder widths, vertically in torso heights,
 *    per the ARCHITECTURE.md rule that every threshold is divided by a body
 *    unit. Full arm extension then reaches the screen edge for a 5'2" player
 *    and a 6'4" player alike, at any distance.
 *
 *    Using shoulder width for X and torso height for Y also sidesteps an
 *    aspect-ratio trap: landmark X is normalised by frame WIDTH and Y by frame
 *    HEIGHT, so a single scalar `unit` cannot correctly denominate both.
 *
 * 3. THE DISPLAY IS MIRRORED. The player's right hand must appear on the right
 *    of the TV as they look at it (see `engine/projection.ts`). In camera space
 *    the subject's right hand sits at a LOWER x than their shoulder centre, so
 *    the horizontal offset is negated on the way to screen space.
 *
 * Smoothing: the tracker already One Euro filters landmarks with the `body`
 * preset, which is deliberately loose (beta 0.6) so fast gestures survive. The
 * body-relative gain above multiplies landmark noise by roughly 8x, so the
 * cursor gets its own second filter using the `handPrecise` preset semantics —
 * "rock steady when held still so the dwell timer doesn't wobble off a tile.
 * Lag is fine here." It is applied AFTER the gain, which is where the noise
 * actually is.
 */

import { FILTER_PRESETS, OneEuro } from '../core/filter';
import { tunables } from '../meta/tunables';
import { POSE } from '../core/types';
import type { TrackedPlayer } from '../core/tracker';
import { audio } from '../engine/audio';
import { measureText, roundRect, vh } from '../engine/draw';
import { COLORS, EASE, FONTS } from './theme';
import type { FrameContext } from './screen';

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/**
 * Dwell times, in seconds.
 *
 * One number does not fit every grid. The cost of a mis-select is what sets
 * it: launching the wrong game burns a whole turn from a queue, picking the
 * wrong letter costs one hover of a DEL that is sitting right there.
 */
export const DWELL = {
  /** Menu tiles. PLAN.md §6's 1.2s — a wrong pick costs a turn. */
  deliberate: 1.2,
  /** Faction tiles. Six big targets, and it can be changed next time. */
  standard: 0.9,
  /** Letter grid. 28 targets, DEL is adjacent, and the queue is waiting. */
  fast: 0.7,
} as const;

/** Half-width of the reach box, in shoulder widths. ~91% of full extension. */
const REACH_X = 1.7;
/** Reach above the shoulder line, in torso heights. */
const REACH_UP = 1.15;
/** Reach below the shoulder line. Arms at rest park the cursor off the tiles. */
const REACH_DOWN = 1.05;

/**
 * How much higher the other wrist must be before the cursor swaps hands, in
 * torso heights. Without this the cursor strobes between hands held level.
 */
const HAND_SWAP_MARGIN = 0.18;

/** A wrist below this visibility is not trusted to drive the cursor. */
const WRIST_MIN_VISIBILITY = 0.35;

/**
 * THE RAISED-HAND GATE.
 *
 * Wrist height relative to the shoulder line, in torso heights, that counts as
 * "pointing". Positive is BELOW the shoulder (screen y grows downward).
 *
 * Without this, a person standing with their arms at their sides still produced
 * a live, dwell-eligible cursor: the reach box mapped all the way down to
 * `REACH_DOWN` (1.05 torsos below the shoulder), which IS hip height, which is
 * exactly where a relaxed arm hangs. Measured on the menu with a body making no
 * gesture at all — dwell climbed 0.25 -> 0.53 -> 0.81 and LAUNCHED A GAME in
 * under two seconds.
 *
 * That is the worst possible failure at a stall: the person it happens to is by
 * definition the one hesitating because they have not understood the interface
 * yet, and the machine responds by shoving them into a 60-second round in front
 * of their friends for no visible reason.
 *
 * Hysteresis so a wrist hovering near the boundary cannot flicker the cursor
 * in and out.
 */
const RAISE_GATE_ENTER = 0.35;
const RAISE_GATE_EXIT = 0.6;

/**
 * Dwell is ignored for this long after the cursor is (re)acquired.
 *
 * The One Euro filter and the body-scale estimate both need a moment to settle,
 * and during that settle the cursor visibly sweeps across the screen from
 * wherever it was. Measured: it crossed two unrelated tiles and accumulated up
 * to 0.36 progress on one of them before arriving at the intended target. A
 * sweep is not an intention, so it must not be able to select anything.
 */
const SETTLE_GRACE_SEC = 0.45;

/**
 * Ticks sounded across a dwell fill, before `select` lands as the last and
 * highest note. Three is enough to read as "it is counting" without turning a
 * 1.2s hold into a machine-gun.
 */
const DWELL_TICKS = 3;

/**
 * Hysteresis on target containment, in vh. You must be INSIDE a target to
 * acquire it, but only inside this padded rect to keep it. A bare rect test
 * cancels the dwell on a single noisy frame at the boundary.
 */
const EXIT_PAD_VH = 1.6;

/**
 * If the cursor leaves a target and returns to the SAME one within this many
 * seconds, the dwell resumes rather than restarting. Covers a dropped
 * inference frame without ever letting progress leak to a different target.
 */
const REACQUIRE_GRACE = 0.14;

/** Progress bleeds off this many times faster than it fills. */
const CANCEL_SPEED = 3;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface HoverTarget {
  id: string;
  /** Screen-space rect, logical px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Default true. A disabled target still shows feedback but never commits. */
  enabled?: boolean;
  /** Per-target dwell override. Defaults to the cursor's dwell. */
  dwell?: number;
}

export interface HoverState {
  /** False when nobody is in frame, or no wrist is trustworthy. */
  present: boolean;
  /** Cursor position in logical px. Meaningless when `present` is false. */
  x: number;
  y: number;
  /** Target currently under the cursor, enabled or not. */
  hovered: string | null;
  /** Dwell fill, 0..1. */
  progress: number;
  /** Set for exactly ONE frame, on the frame the dwell completes. */
  committed: string | null;
  /** True when the hovered target is disabled — drives the "locked" look. */
  locked: boolean;
}

const IDLE_STATE: HoverState = {
  present: false,
  x: 0,
  y: 0,
  hovered: null,
  progress: 0,
  committed: null,
  locked: false,
};

/* ------------------------------------------------------------------ */
/* Cursor                                                              */
/* ------------------------------------------------------------------ */

export class HoverCursor {
  /**
   * Test hook. Forces the cursor to a normalised screen position (0..1 in both
   * axes) and reports it as present, bypassing pose sampling entirely.
   *
   * The simulator can raise and lower arms but cannot place a wrist at an
   * arbitrary point, so there is no other way to assert "dwell commits at
   * 1.2s and not at 1.1s" deterministically. Null in every real code path.
   */
  override: { x: number; y: number } | null = null;

  private fx = new OneEuro({ ...FILTER_PRESETS.handPrecise });
  private fy = new OneEuro({ ...FILTER_PRESETS.handPrecise });

  private side: 'left' | 'right' = 'right';
  /** True while a wrist is raised past the gate. Hysteretic. */
  private raised = false;
  /** fc.time when the cursor last became live, for the settle grace. */
  private acquiredAt = -Infinity;
  /** Set when something teleported the cursor; update() restamps the grace. */
  private needsResettle = false;
  private hoveredId: string | null = null;
  private progress = 0;

  /**
   * After a commit the cursor is latched to that target and cannot fire again
   * until it leaves. Otherwise holding still on a tile re-selects it forever.
   */
  private latchedId: string | null = null;

  /**
   * How many dwell ticks have already sounded for the current fill.
   *
   * The dwell ring fills silently for its whole 1.2s and then fires `select` —
   * so the one control every player uses on every turn (pick a game, then three
   * letters, maybe a faction) gave no audible sign it was working until it was
   * already done. The round countdown, which is the same "counting down to a
   * commit" idea, ticks every second. Rising pitch is PLAN.md §5's own
   * highest-value audio pattern and is already the language used for combos.
   *
   * Quiet reinforcement only: the ring still carries the whole message with the
   * speakers off, which is the rule for every cue in this app.
   */
  private dwellTicks = 0;

  private graceId: string | null = null;
  private graceAt = -1;
  private graceProgress = 0;

  private state: HoverState = { ...IDLE_STATE };
  private commitAt = -10;
  private commitX = 0;
  private commitY = 0;

  constructor(private dwell: number = DWELL.deliberate) {}

  /** Live dwell time, so queue pressure can be traded against misclicks. */
  private get dwellTime(): number {
    return tunables.get('hover.dwellDeliberate', this.dwell);
  }

  setDwell(seconds: number): void {
    this.dwell = seconds;
  }

  /** Current state, for screens that need it outside of `update`. */
  get last(): Readonly<HoverState> {
    return this.state;
  }

  /**
   * Wipes dwell progress and the commit latch. Call when the set of targets
   * changes wholesale (phase change), so a half-filled dwell from the old
   * layout cannot complete against a new target that happens to share an id.
   */
  reset(): void {
    this.hoveredId = null;
    this.progress = 0;
    this.latchedId = null;
    this.graceId = null;
    this.graceAt = -1;
    this.state = { ...IDLE_STATE };
  }

  /**
   * One frame of cursor logic.
   *
   * @param player the primary tracked player, or null when nobody is in frame
   * @param targets the live hit set — rebuild it each frame, it is not retained
   */
  update(
    fc: FrameContext,
    player: TrackedPlayer | null,
    targets: readonly HoverTarget[]
  ): HoverState {
    const point = this.sample(player, fc.time);

    if (!point) {
      // Losing the player must cancel cleanly. A dwell that survives the
      // player walking away would fire at whoever steps in next.
      this.hoveredId = null;
      this.progress = 0;
      this.latchedId = null;
      this.state = { ...IDLE_STATE };
      return this.state;
    }

    // Transition from absent to present starts the settle grace.
    if (!this.state.present || this.needsResettle) {
      this.needsResettle = false;
      this.acquiredAt = fc.time;
      this.progress = 0;
      this.hoveredId = null;
      this.graceId = null;
    }

    const x = point.x * fc.v.width;
    const y = point.y * fc.v.height;
    const pad = vh(fc.v, EXIT_PAD_VH);

    // Containment with hysteresis: keep the current target while inside its
    // padded rect, otherwise acquire whatever the bare rect test finds.
    let hovered: HoverTarget | null = null;
    const current = this.hoveredId ? find(targets, this.hoveredId) : null;
    if (current && inside(current, x, y, pad)) {
      hovered = current;
    } else {
      for (const t of targets) {
        if (inside(t, x, y, 0)) {
          hovered = t;
          break;
        }
      }
    }

    const hoveredId = hovered?.id ?? null;

    if (hoveredId !== this.hoveredId) {
      // Remember where we were, so a one-frame dropout can be forgiven.
      if (this.hoveredId) {
        this.graceId = this.hoveredId;
        this.graceAt = fc.time;
        this.graceProgress = this.progress;
      }

      if (hoveredId && hoveredId === this.graceId && fc.time - this.graceAt <= REACQUIRE_GRACE) {
        this.progress = this.graceProgress;
      } else {
        this.progress = 0;
      }
      this.dwellTicks = Math.floor(this.progress * (DWELL_TICKS + 1));

      if (this.latchedId && this.latchedId !== hoveredId) this.latchedId = null;

      this.hoveredId = hoveredId;

      if (hovered) {
        // Sound is reinforcement only — the ring and the tile wash carry the
        // same information with the speaker off (PLAN.md §5).
        audio.play('hover', hovered.enabled === false ? 0.6 : 1);
      }
    }

    // A cursor that has just appeared is still settling — the filter sweeps in
    // from wherever it was, and a sweep is not an intention.
    const settling = fc.time - this.acquiredAt < SETTLE_GRACE_SEC;

    const locked = !!hovered && hovered.enabled === false;
    const canFill = !!hovered && !locked && !settling && this.latchedId !== hovered.id;

    let committed: string | null = null;

    if (canFill && hovered) {
      const dwell = hovered.dwell ?? this.dwellTime;
      this.progress += fc.dt / Math.max(0.05, dwell);

      // Three ticks across the fill, climbing in pitch, then `select` lands on
      // top as the fourth and highest. Counted rather than timed so it behaves
      // the same for a tile with a shorter custom dwell.
      const wantTicks = Math.min(DWELL_TICKS, Math.floor(this.progress * (DWELL_TICKS + 1)));
      while (this.dwellTicks < wantTicks) {
        this.dwellTicks++;
        audio.play('tick', 0.9 + this.dwellTicks * 0.18);
      }

      if (this.progress >= 1) {
        this.progress = 0;
        this.dwellTicks = 0;
        this.latchedId = hovered.id;
        committed = hovered.id;
        this.commitAt = fc.time;
        this.commitX = x;
        this.commitY = y;
        audio.play('select');
      }
    } else {
      this.progress = Math.max(0, this.progress - (fc.dt / this.dwellTime) * CANCEL_SPEED);
      // Re-arm as the ring drains, so a cancelled-then-retried dwell ticks
      // again instead of filling in silence.
      this.dwellTicks = Math.min(
        this.dwellTicks,
        Math.floor(this.progress * (DWELL_TICKS + 1))
      );
    }

    this.state = {
      present: true,
      x,
      y,
      hovered: hoveredId,
      progress: this.progress,
      committed,
      locked,
    };
    return this.state;
  }

  /* ---------------- sampling ---------------- */

  /**
   * Wrist → normalised screen position (0..1), or null when there is nothing
   * trustworthy to point with.
   */
  private sample(player: TrackedPlayer | null, time: number): { x: number; y: number } | null {
    if (this.override) {
      // Still runs through the filter so the test exercises the real path.
      return {
        x: clamp01(this.fx.filter(this.override.x, time)),
        y: clamp01(this.fy.filter(this.override.y, time)),
      };
    }

    if (!player) return null;

    const lm = player.landmarks;
    const ls = lm[POSE.LEFT_SHOULDER];
    const rs = lm[POSE.RIGHT_SHOULDER];
    if (!ls || !rs || Math.min(ls.visibility, rs.visibility) < 0.4) return null;

    const scale = player.scale;
    if (!scale.valid) return null;

    const left = lm[POSE.LEFT_WRIST];
    const right = lm[POSE.RIGHT_WRIST];
    const leftOk = !!left && left.visibility >= WRIST_MIN_VISIBILITY;
    const rightOk = !!right && right.visibility >= WRIST_MIN_VISIBILITY;
    if (!leftOk && !rightOk) return null;

    // Pick the raised hand, with hysteresis. Y grows downward, so "higher"
    // is the smaller value.
    const spanY = Math.max(scale.unit, 0.04);
    if (!leftOk) this.side = 'right';
    else if (!rightOk) this.side = 'left';
    else if (left && right) {
      const diff = (right.y - left.y) / spanY; // >0 when the left wrist is higher
      if (this.side === 'right' && diff > HAND_SWAP_MARGIN) this.swapTo('left');
      else if (this.side === 'left' && -diff > HAND_SWAP_MARGIN) this.swapTo('right');
    }

    const wrist = this.side === 'left' ? left : right;
    if (!wrist) return null;

    const scx = (ls.x + rs.x) / 2;
    const scy = (ls.y + rs.y) / 2;
    const spanX = Math.max(scale.shoulderWidth, 0.03);

    // MIRRORED: the subject's right hand is at a lower camera x and must land
    // on the right of the TV, so the horizontal offset is negated.
    //
    // The numerator is aspect-corrected to match `spanX`, which is. Landmark x
    // is normalised by frame WIDTH and y by frame HEIGHT, so a raw x-difference
    // divided by an isotropic shoulder width is wrong by exactly the aspect
    // ratio — and both halves look individually fine, which is what makes it
    // easy to miss. `dy` needs no correction: it is vertical over vertical.
    const dx = ((wrist.x - scx) * scale.aspect) / spanX;
    const dy = (wrist.y - scy) / spanY;

    // Read per-frame through the operator console. README flags this reach box
    // as the single highest-value thing to tune at the Sept 19 playtest: too
    // generous and the corner tiles need an uncomfortable stretch, too tight
    // and the cursor pins to the screen edges. Both are unrecoverable without
    // live adjustment, because they are anthropometric guesses.
    const reachX = tunables.get('hover.reachX', REACH_X);
    const reachUp = tunables.get('hover.reachUp', REACH_UP);
    const reachDown = tunables.get('hover.reachDown', REACH_DOWN);

    // THE RAISED-HAND GATE. An arm hanging at rest sits ~1.0 torso below the
    // shoulder, which the reach box would otherwise map to a perfectly live
    // cursor near the bottom of the screen. Require a deliberate raise.
    this.raised = this.raised ? dy < RAISE_GATE_EXIT : dy < RAISE_GATE_ENTER;
    if (!this.raised) return null;

    const rawX = 0.5 - dx / (2 * reachX);
    const rawY = (dy + reachUp) / (reachUp + reachDown);

    // Clamp with headroom BEFORE filtering so the filter has somewhere to
    // settle at the edges, then hard-clamp after so edge targets stay hittable.
    const fx = this.fx.filter(clamp(rawX, -0.2, 1.2), time);
    const fy = this.fy.filter(clamp(rawY, -0.2, 1.2), time);

    return { x: clamp01(fx), y: clamp01(fy) };
  }

  /** Swapping hands teleports the cursor, so cancel anything in flight. */
  private swapTo(side: 'left' | 'right'): void {
    this.side = side;
    // A swap teleports the cursor across the screen; treat it as a fresh
    // acquisition so the sweep cannot select anything on its way.
    this.needsResettle = true;
    this.fx.reset();
    this.fy.reset();
    this.progress = 0;
    this.hoveredId = null;
    this.graceId = null;
  }

  /* ---------------- drawing ---------------- */

  /**
   * The cursor itself. Draw it last, over everything.
   *
   * Reads as three things from 3m: where your hand is (the dot), that the
   * machine is counting (the ring filling), and that it fired (the burst).
   */
  draw(fc: FrameContext): void {
    const { ctx, v, time } = fc;

    // Commit burst outlives the cursor by a moment, so draw it either way.
    const since = time - this.commitAt;
    if (since >= 0 && since < 0.45) {
      const t = EASE.out(since / 0.45);
      const r = vh(v, 3.4) + vh(v, 9) * t;
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = vh(v, 0.7) * (1 - t);
      ctx.beginPath();
      ctx.arc(this.commitX, this.commitY, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    const s = this.state;
    if (!s.present) return;

    const r = vh(v, 3.4);
    const color = s.locked ? COLORS.red : s.progress > 0 ? COLORS.yellow : COLORS.blueBright;

    ctx.save();
    ctx.translate(s.x, s.y);

    // Track. Flat muted — the kit's "this slot is open" colour.
    ctx.strokeStyle = COLORS.muted;
    ctx.lineWidth = vh(v, 0.65);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();

    // Fill.
    if (s.progress > 0) {
      // Ink backing arc under the brand-colour arc: the sticker outline, on a
      // curve. Does the job the blur used to do, with no blur.
      ctx.lineCap = 'round';
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = vh(v, 1.5);
      ctx.beginPath();
      ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + s.progress * Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = color;
      ctx.lineWidth = vh(v, 0.9);
      ctx.beginPath();
      ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + s.progress * Math.PI * 2);
      ctx.stroke();
    }

    // Core. Shrinks as the dwell fills — the "grabbed" state, legible even if
    // the ring itself is too thin to read across the room.
    const grab = 1 - s.progress * 0.55;
    // Core as a sticker: hard ink shadow straight down, flat fill, ink outline.
    ctx.fillStyle = COLORS.ink;
    ctx.beginPath();
    ctx.arc(0, vh(v, 0.5), r * 0.34 * grab, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = vh(v, 0.4);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.34 * grab, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Four claws closing in on the core. This is the bit that reads as
    // "something is about to happen" from the back of a crowd.
    if (s.progress > 0) {
      ctx.strokeStyle = color;
      ctx.lineWidth = vh(v, 0.5);
      ctx.lineCap = 'round';
      const gap = r * (1.35 - 0.5 * s.progress);
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        const cx = Math.cos(a);
        const cy = Math.sin(a);
        ctx.beginPath();
        ctx.moveTo(cx * gap, cy * gap);
        ctx.lineTo(cx * (gap + r * 0.42), cy * (gap + r * 0.42));
        ctx.stroke();
      }
    }

    if (s.locked) {
      ctx.strokeStyle = COLORS.red;
      ctx.lineWidth = vh(v, 0.6);
      ctx.beginPath();
      ctx.moveTo(-r * 0.5, -r * 0.5);
      ctx.lineTo(r * 0.5, r * 0.5);
      ctx.stroke();
    }

    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Shared shell UI helpers                                             */
/* ------------------------------------------------------------------ */

/**
 * Wash a target with its dwell progress. A ring on the hand says "counting";
 * this says "counting THIS ONE", which is the part that matters when seven
 * tiles are on screen and the player is three metres away.
 */
export function drawDwellFill(
  ctx: CanvasRenderingContext2D,
  t: HoverTarget,
  radius: number,
  color: string,
  progress: number
): void {
  if (progress <= 0) return;

  // FLAT FILL, NOT 'screen' COMPOSITE.
  //
  // This used `globalCompositeOperation = 'screen'` with a translucent brand
  // colour. On the old near-black background that read as a glow; on paper it
  // is a LITERAL NO-OP — white is the identity element for `screen`, so the
  // dwell fill stopped existing the moment the background flipped, and the
  // whole touch-free selection lost its "counting THIS one" feedback with no
  // error anywhere.
  //
  // Flat yellow (the brand's action colour) with a hard ink leading edge. The
  // ink edge is what actually reads at 3m — flat yellow on paper is low
  // contrast on its own, which is the same reason yellow never carries text.
  ctx.save();
  roundRect(ctx, t.x, t.y, t.w, t.h, radius);
  ctx.clip();

  ctx.fillStyle = color;
  ctx.fillRect(t.x, t.y, t.w * progress, t.h);

  const edge = Math.max(2, t.w * 0.012);
  ctx.fillStyle = COLORS.ink;
  ctx.fillRect(t.x + t.w * progress - edge, t.y, edge, t.h);
  ctx.restore();
}

/**
 * Largest size at or below `size` that fits `maxWidth`.
 *
 * Every string on these screens is data — a game name, a player's initials, a
 * faction the club might rename the night before — and a TV's resolution is
 * unknown. Overflowing text is the most likely way this looks broken on the
 * day, and it is one measure call to prevent.
 */
export function fitTextSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  size: number,
  weight: number | string = 700,
  font: string = FONTS.display
): number {
  if (!text) return size;
  const w = measureText(ctx, text, size, weight, font);
  if (w <= maxWidth || w === 0) return size;
  return Math.max(1, size * (maxWidth / w));
}

/* ------------------------------------------------------------------ */

function find(targets: readonly HoverTarget[], id: string): HoverTarget | null {
  for (const t of targets) if (t.id === id) return t;
  return null;
}

function inside(t: HoverTarget, x: number, y: number, pad: number): boolean {
  return x >= t.x - pad && x <= t.x + t.w + pad && y >= t.y - pad && y <= t.y + t.h + pad;
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function clamp01(n: number): number {
  return clamp(n, 0, 1);
}
