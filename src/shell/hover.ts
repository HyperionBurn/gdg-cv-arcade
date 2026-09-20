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
import { roundRect, vh } from '../engine/draw';
import { COLORS, EASE } from './theme';
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
  /**
   * Menu tiles. 1.2 -> 1.5.
   *
   * PLAN.md §6 specified 1.2s, and testers reported selection "might be too
   * fast" while also landing on games they had not chosen. A wrong pick costs
   * a whole turn from a queue, which is the most expensive mistake the shell
   * can make, so this one buys the most from the extra 300ms.
   */
  deliberate: 1.5,
  /** Faction tiles. Six big targets, and it can be changed next time. */
  standard: 1.1,
  /**
   * Letter grid. 0.7 -> 0.95.
   *
   * 28 targets packed tight with DEL and OK among them: the densest grid in the
   * app and the easiest place to commit a letter while merely passing over it.
   * Still the shortest dwell, because a wrong letter costs one hover of a DEL
   * sitting right there rather than a whole turn.
   */
  fast: 0.95,
} as const;

/* ------------------------------------------------------------------ */
/* Operator mouse override                                             */
/* ------------------------------------------------------------------ */

/**
 * How long after the last mouse movement the pointer keeps control.
 *
 * The mouse TAKES OVER rather than merging, and hands back on its own. A
 * marshal nudges the trackpad, drives the shell, and two and a half seconds
 * later the cursor belongs to whoever is standing in front of the camera again
 * — with no mode to remember, no key to press, and nothing to leave switched on
 * by accident in front of a queue.
 */
const POINTER_HOLD_MS = 2500;

/**
 * Operator mouse input, shared by every cursor in the app.
 *
 * PLAN.md §6 says "no keyboard, no mouse, no operator handoff", and for the
 * PLAYER that is still true — nobody in the queue touches the laptop. But the
 * marshal running the stall has to be able to back out of a stuck screen, pick
 * a game to demo, or fix a typo'd name without walking into frame and waving at
 * their own TV. Requested directly after the first playtest.
 *
 * A click commits immediately: an operator who is already pointing at a button
 * should not have to hold still for 1.2 seconds to press it.
 */
const pointer = {
  /** Normalised 0..1 across the canvas. */
  x: 0.5,
  y: 0.5,
  /** `performance.now()` of the last movement. */
  movedAt: -Infinity,
  /** Set by mousedown, consumed by the first cursor that acts on it. */
  clickPending: false,
  installed: false,
};

/** True while the mouse is driving. */
function pointerActive(): boolean {
  return performance.now() - pointer.movedAt < POINTER_HOLD_MS;
}

/**
 * Attach the listeners once, lazily, on the first cursor built.
 *
 * On `window` rather than the canvas so a click anywhere counts, and passive so
 * it can never delay a frame.
 */
function installPointer(): void {
  if (pointer.installed || typeof window === 'undefined') return;
  pointer.installed = true;

  const update = (e: MouseEvent): void => {
    const canvas = document.querySelector('canvas');
    const r = canvas?.getBoundingClientRect();
    const w = r?.width || window.innerWidth;
    const h = r?.height || window.innerHeight;
    const left = r?.left ?? 0;
    const top = r?.top ?? 0;
    pointer.x = clamp01((e.clientX - left) / Math.max(1, w));
    pointer.y = clamp01((e.clientY - top) / Math.max(1, h));
    pointer.movedAt = performance.now();
  };

  window.addEventListener('mousemove', update, { passive: true });
  window.addEventListener('mousedown', (e) => {
    update(e);
    pointer.clickPending = true;
  });
}

/**
 * Live multiplier on every dwell time. 1 is the authored feel.
 *
 * See `HoverCursor.dwellTime` for why this is a scale rather than a number of
 * seconds: the grids differ by design, and an absolute override flattens them.
 */
function dwellScale(): number {
  return tunables.get('hover.dwellScale', 1);
}

/** Half-width of the reach box, in shoulder widths. ~91% of full extension. */
const REACH_X = 1.7;
/**
 * Reach above the shoulder line, in torso heights.
 *
 * 1.15 -> 1.0, from a playtest report: "when I reach up I get height
 * restricted, the pointer doesn't fully go with my hand, it stays a little
 * below."
 *
 * 1.15 is not an arbitrary number — it is the ANATOMICAL MAXIMUM. Standard
 * proportions put shoulder-to-wrist at ~0.332 of stature and shoulder-to-hip
 * (this file's torso unit) at ~0.288, so a fully extended arm straight
 * overhead reaches 0.332/0.288 = 1.15 torso units above the shoulder line and
 * not one millimetre further. Mapping that to the top of the screen means the
 * top pixel costs a locked-out overhead stretch, and every comfortable reach
 * lands short — exactly as reported. Reaching also ELEVATES the shoulder
 * girdle, which shrinks the measured offset further.
 *
 * `REACH_X` was already set to ~91% of full extension for precisely this
 * reason; the vertical axis never got the same treatment. 1.0 is ~87%.
 */
const REACH_UP = 1.0;

/**
 * Smallest vertical reach the cursor will ever map the screen to.
 *
 * `REACH_UP` shrinks to fit the camera's real headroom (see `sample`), and
 * without a floor a badly tilted camera would collapse it toward zero, turning
 * a centimetre of wrist movement into half the screen. Below this the framing
 * is the thing to fix, not the gain.
 */
const REACH_UP_FLOOR = 0.7;

/**
 * Torso units of margin kept between the top of the frame and the top of the
 * reach box, so the cursor reaches the top of the screen just BEFORE the wrist
 * leaves the picture rather than just after.
 */
const HEADROOM_MARGIN = 0.12;
/**
 * Reach below the shoulder line, in torso heights.
 *
 * 1.05 -> 0.6, and this one was a latent bug rather than a feel preference.
 *
 * The cursor is only live while the hand is RAISED, and the raise gate lets go
 * at `RAISE_GATE_EXIT` = 0.6 torso units below the shoulder. So 0.6 is the
 * largest downward offset that can ever be observed with a live cursor — and
 * at 1.05 the bottom of the screen was mapped to 1.05, a position at which the
 * cursor has already switched itself off. Measured: everything below
 * (0.6 + 1.15) / 2.2 = 0.795 of screen height was physically unreachable, i.e.
 * the bottom FIFTH of the display, including the lower edge of the bottom row
 * of menu tiles.
 *
 * Matching this to the gate makes the whole screen reachable and nothing else
 * changes: an arm at rest still sits at ~1.0, well outside the gate.
 */
const REACH_DOWN = 0.6;

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

/**
 * How long the cursor tolerates losing the wrist before it gives up the dwell.
 *
 * WITHOUT THIS, A REAL CAMERA CANNOT SELECT A GAME. `sample()` returns null
 * whenever wrist visibility dips under `WRIST_MIN_VISIBILITY`, and the null
 * path used to reset `progress` to 0 AND restamp `acquiredAt`, which imposes a
 * further `SETTLE_GRACE_SEC` before filling may resume. So each momentary
 * dropout cost the full dwell plus 0.45s.
 *
 * MEASURED against a simulated body with realistic wrist dropouts: a player
 * holding a steady hand on a tile for ten seconds reached 17% dwell and NEVER
 * committed, against ~2s to commit with a clean body. This is the app's only
 * input device.
 *
 * The simulator could not show it until today — `lm()` defaults visibility to
 * 1 and every call site took the default, so no landmark had ever been
 * anything but perfectly visible.
 *
 * 0.3s is comfortably longer than the few-frame dropouts MediaPipe produces at
 * 3m, and far shorter than the time it takes to lower an arm and mean it.
 */
const LOST_GRACE_SEC = 0.3;

/**
 * How long the pointing hand may be missing before the cursor considers
 * following the OTHER hand.
 *
 * The hand-swap hysteresis (`HAND_SWAP_MARGIN`) governs a deliberate swap —
 * raise the other arm higher and the cursor moves across. But a DROPOUT
 * bypassed it entirely: `if (!rightOk) this.side = 'left'` switched on a
 * single missing frame.
 *
 * The other hand is, by definition, the one the player is NOT pointing with —
 * it is down by their side. So one dropped frame teleported the cursor from
 * the tile to the bottom of the screen and cancelled the dwell.
 *
 * MEASURED with realistic dropouts before this: the cursor wandered over
 * 388x616 px of a 519x932 canvas while the player held a hand perfectly
 * still, and the dwell never passed 17%. Only 6 frames in 420 were actually
 * "no hand" — the rest was the cursor ping-ponging between two hands.
 */
const SIDE_SWAP_GRACE_SEC = 0.35;

/** Progress bleeds off this many times faster than it fills. */
const CANCEL_SPEED = 3;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/**
 * What a pending operator mouse click does this frame.
 *
 * A marshal needs to drive the screen without walking into frame — row 27 of
 * FEEDBACK.md. Mouse and keyboard are for the OPERATOR only; nobody in the
 * queue touches the laptop, which is what makes it safe for a click to commit
 * AT ONCE with no dwell.
 *
 * THE PENDING FLAG IS CLEARED WHETHER OR NOT THE CLICK LANDS. That is the
 * whole reason this is a function rather than two lines: a click on empty
 * space that stays pending fires later, on whatever the cursor happens to be
 * over by then — including a game tile, in front of a queue. It is one deleted
 * assignment away and reads like a tidy-up.
 */
export function resolveOperatorClick(
  pending: boolean,
  hovered: { id: string } | null,
  locked: boolean
): { commit: string | null; pending: boolean } {
  if (!pending) return { commit: null, pending: false };
  return { commit: hovered && !locked ? hovered.id : null, pending: false };
}

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

  /** When the wrist was lost, or -1 while it is held. See LOST_GRACE_SEC. */
  private lostSince = -1;
  /** When the POINTING hand went missing. See SIDE_SWAP_GRACE_SEC. */
  private sideLostSince = -1;

  private graceId: string | null = null;
  private graceAt = -1;
  private graceProgress = 0;

  private state: HoverState = { ...IDLE_STATE };
  private commitAt = -10;
  private commitX = 0;
  private commitY = 0;

  private dwell: number;

  constructor(dwell: number = DWELL.deliberate) {
    this.dwell = dwell;
    installPointer();
  }

  /**
   * Live dwell time, so queue pressure can be traded against misclicks.
   *
   * A SCALE, not an absolute. It used to be `get('hover.dwellDeliberate',
   * this.dwell)` — but a registered tunable's default beats the caller's
   * fallback, so the registry's 1.2s was returned for EVERY cursor regardless
   * of what it was constructed with. The letter grid asks for 0.7s and its
   * targets carry that explicitly, so keys still committed on time, but the
   * cancel drain divides by this number and was running 40% slow on the one
   * grid where people most often change their mind.
   *
   * One knob that multiplies every dwell is also what the operator actually
   * wants at the stall: "the queue is long, make all of this faster".
   */
  private get dwellTime(): number {
    return this.dwell * dwellScale();
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
      // A BRIEF dropout is not the player leaving. Hold everything as it was
      // and report the cursor as still present, so the ring does not visibly
      // collapse and refill on every flicker. See LOST_GRACE_SEC.
      if (this.lostSince < 0) this.lostSince = fc.time;
      if (this.state.present && fc.time - this.lostSince < LOST_GRACE_SEC) {
        return this.state;
      }

      // Genuinely gone. Cancel cleanly: a dwell that survived the player
      // walking away would fire at whoever steps in next.
      this.hoveredId = null;
      this.progress = 0;
      this.latchedId = null;
      this.state = { ...IDLE_STATE };
      return this.state;
    }

    // Back within the grace window — carry on as if nothing happened. In
    // particular do NOT restamp `acquiredAt`, which would re-impose the settle
    // grace and make a flickering wrist permanently unable to select.
    const hadBriefDropout = this.lostSince >= 0 && this.state.present;
    this.lostSince = -1;

    // Transition from absent to present starts the settle grace.
    if ((!this.state.present && !hadBriefDropout) || this.needsResettle) {
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

    // AN OPERATOR CLICK COMMITS AT ONCE, with no dwell.
    //
    // Consumed here whether or not it lands on a target, so a click on empty
    // space cannot queue itself up and fire later on whatever the cursor
    // happens to be over — including a game tile, in front of a queue.
    const click = resolveOperatorClick(pointer.clickPending, hovered, locked);
    pointer.clickPending = click.pending;
    if (click.commit !== null) {
      this.progress = 0;
      this.dwellTicks = 0;
      this.latchedId = click.commit;
      committed = click.commit;
      this.commitAt = fc.time;
      this.commitX = x;
      this.commitY = y;
      audio.play('select');
    }

    if (!committed && canFill && hovered) {
      // A target's own dwell is scaled too, so the operator's one knob reaches
      // the letter grid and the faction tiles as well as the menu.
      const dwell = hovered.dwell !== undefined ? hovered.dwell * dwellScale() : this.dwellTime;
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

    // THE MOUSE WINS WHILE IT IS MOVING. Unfiltered: a mouse is already a
    // precise pointing device, and running it through a smoother built to
    // steady a waving arm at three metres would only make it feel broken.
    if (pointerActive()) {
      this.fx.reset();
      this.fy.reset();
      return { x: pointer.x, y: pointer.y };
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

    // The hand we are already pointing with, dropping out. Hold rather than
    // jump — see SIDE_SWAP_GRACE_SEC. Returning null here is deliberate: the
    // caller's LOST_GRACE_SEC then preserves the dwell through the gap.
    const activeOk = this.side === 'left' ? leftOk : rightOk;
    const otherOk = this.side === 'left' ? rightOk : leftOk;
    if (!activeOk) {
      if (this.sideLostSince < 0) this.sideLostSince = time;
      if (!otherOk || time - this.sideLostSince < SIDE_SWAP_GRACE_SEC) return null;
      this.swapTo(this.side === 'left' ? 'right' : 'left');
      this.sideLostSince = -1;
    } else {
      this.sideLostSince = -1;
    }

    if (left && right && leftOk && rightOk) {
      const diff = (right.y - left.y) / spanY; // >0 when the left wrist is higher
      if (this.side === 'right' && diff > HAND_SWAP_MARGIN) this.swapTo('left');
      else if (this.side === 'left' && -diff > HAND_SWAP_MARGIN) this.swapTo('right');
    }

    const wrist = this.side === 'left' ? left : right;
    if (!wrist) return null;

    const scx = (ls.x + rs.x) / 2;
    const scy = (ls.y + rs.y) / 2;
    // SHOULDER WIDTH COLLAPSES WITH cos(yaw), so a player glancing sideways
    // gets a twitchier cursor on the one control everybody uses to pick a game.
    // MEASURED: 0.2094 face-on, 0.0716 at 70deg — 2.9x more sensitive — and
    // already 1.4x at a casual 45deg glance.
    //
    // Floored with the rotation-stable torso unit. 0.80 is the MEASURED face-on
    // shoulderWidth/torsoHeight ratio, so a square-on player sees no change at
    // all and a turned one stops accelerating.
    const spanX = Math.max(scale.shoulderWidth, scale.unit * 0.8, 0.03);

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

    // THE REACH BOX SHRINKS TO FIT THE CAMERA'S ACTUAL HEADROOM.
    //
    // A laptop camera — which is what this will mostly run on — sits low and
    // close. It frames the body nicely and leaves almost nothing above the
    // head, so a raised wrist exits the top of the picture, its landmark pins
    // to y = 0, and the cursor stops climbing however far the hand keeps going.
    // Reported from a playtest as "when I reach up I get height restricted, the
    // pointer stays a little below my hand", on a rig cropped at the knees.
    //
    // No fixed `reachUp` can fix that, because the limit is the frame rather
    // than the arm: if there are only 0.8 torso units above the shoulder line,
    // then dy can never read below -0.8 and the top of a box built for -1.0 is
    // unreachable by construction. So measure the room that is actually there
    // and map the screen to THAT, leaving a small margin so the cursor tops out
    // just before the wrist disappears.
    //
    // On a well-placed camera there is more headroom than `reachUp` needs and
    // this changes nothing at all.
    const headroom = scy / spanY;
    const effectiveUp = Math.max(
      REACH_UP_FLOOR,
      Math.min(reachUp, headroom - HEADROOM_MARGIN)
    );

    const rawX = 0.5 - dx / (2 * reachX);
    const rawY = (dy + effectiveUp) / (effectiveUp + reachDown);

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
