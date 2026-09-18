/**
 * Gesture state machines.
 *
 * PLAN.md §2: "Every gesture is a state machine with separate enter/exit
 * thresholds, never a bare comparison. A naive `wrist.y < shoulder.y` check
 * fires 30 times a second at the boundary."
 *
 * Two rules hold everywhere in this file:
 *
 *  1. HYSTERESIS. Entering a state and leaving it use different thresholds.
 *     Without the gap, any signal sitting near the boundary chatters.
 *
 *  2. BODY-RELATIVE THRESHOLDS. Every distance is divided by `scale.unit`
 *     (torso height) before comparison, so `0.25` means "a quarter of a torso"
 *     for a 5'2" player and a 6'4" player alike.
 *
 * Every tunable here is surfaced in the operator console, because these WILL
 * need adjusting on the day — different bodies, different lighting, different
 * camera height than we tested with.
 */

import { POSE, type Landmark } from './types';
import type { TrackedPlayer } from './tracker';

/* ------------------------------------------------------------------ */
/* Primitive                                                           */
/* ------------------------------------------------------------------ */

/**
 * A boolean gate with separate enter/exit thresholds.
 *
 * `enter` and `exit` are compared with `>=` by default; set `invert` when the
 * signal decreases into the active state (screen Y grows downward, so "up" is
 * a smaller number and needs inverting).
 */
export class Hysteresis {
  private active = false;
  private _justEntered = false;
  private _justExited = false;

  constructor(
    public enter: number,
    public exit: number,
    private invert = false
  ) {}

  update(value: number): boolean {
    const v = this.invert ? -value : value;
    const enter = this.invert ? -this.enter : this.enter;
    const exit = this.invert ? -this.exit : this.exit;

    this._justEntered = false;
    this._justExited = false;

    if (!this.active && v >= enter) {
      this.active = true;
      this._justEntered = true;
    } else if (this.active && v < exit) {
      this.active = false;
      this._justExited = true;
    }
    return this.active;
  }

  get isActive(): boolean {
    return this.active;
  }
  get justEntered(): boolean {
    return this._justEntered;
  }
  get justExited(): boolean {
    return this._justExited;
  }

  reset(): void {
    this.active = false;
    this._justEntered = false;
    this._justExited = false;
  }
}

/**
 * Slowly-adapting baseline for "where is this landmark when the player is at
 * rest". Needed because we cannot assume the player stands in the same spot,
 * or that the camera is level.
 *
 * Only adapts while `settled` is true, so a two-second crouch doesn't
 * gradually redefine standing height.
 */
export class Baseline {
  private value: number | null = null;

  constructor(private rate = 0.02) {}

  update(sample: number, settled: boolean): number {
    if (this.value === null) {
      this.value = sample;
    } else if (settled) {
      this.value += (sample - this.value) * this.rate;
    }
    return this.value;
  }

  get current(): number | null {
    return this.value;
  }

  reset(): void {
    this.value = null;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function vis(lm: Landmark | undefined, min = 0.4): lm is Landmark {
  return !!lm && lm.visibility >= min;
}

function midY(a: Landmark | undefined, b: Landmark | undefined): number | null {
  if (!vis(a) || !vis(b)) return null;
  return (a.y + b.y) / 2;
}

function midX(a: Landmark | undefined, b: Landmark | undefined): number | null {
  if (!vis(a) || !vis(b)) return null;
  return (a.x + b.x) / 2;
}

/* ------------------------------------------------------------------ */
/* 67 Speed — arm pump rep counter                                     */
/* ------------------------------------------------------------------ */

export interface RepTunables {
  /**
   * How far above the shoulder the wrist must rise to arm a rep, in torso
   * units. PLAN.md §3: "rep counts only if the wrist crosses above shoulder
   * AND below elbow — kills the tiny-twitchy-hands exploit."
   */
  upEnter: number;
  upExit: number;
  /** How far below the elbow the wrist must drop to re-arm. */
  downEnter: number;
  downExit: number;
  /** Ignore reps faster than this (ms). Physically implausible = cheating. */
  minRepIntervalMs: number;
}

export const DEFAULT_REP_TUNABLES: RepTunables = {
  upEnter: 0.12,
  upExit: 0.04,
  downEnter: 0.06,
  downExit: 0.0,
  minRepIntervalMs: 60,
};

type ArmState = 'down' | 'up';

class ArmPump {
  private state: ArmState = 'down';
  private lastRepTime = 0;
  private upGate: Hysteresis;
  private downGate: Hysteresis;

  constructor(private tun: RepTunables) {
    this.upGate = new Hysteresis(tun.upEnter, tun.upExit);
    this.downGate = new Hysteresis(tun.downEnter, tun.downExit);
  }

  setTunables(t: RepTunables): void {
    this.tun = t;
    this.upGate.enter = t.upEnter;
    this.upGate.exit = t.upExit;
    this.downGate.enter = t.downEnter;
    this.downGate.exit = t.downExit;
  }

  /** @returns true on the frame a rep completes */
  update(
    wrist: Landmark | undefined,
    shoulder: Landmark | undefined,
    elbow: Landmark | undefined,
    unit: number,
    now: number
  ): boolean {
    if (!vis(wrist) || !vis(shoulder) || !vis(elbow) || unit <= 0) return false;

    // Screen Y grows downward, so "wrist above shoulder" is a positive value here.
    const aboveShoulder = (shoulder.y - wrist.y) / unit;

    // RE-ARM BELOW THE SHOULDER, NOT BELOW THE ELBOW.
    //
    // This used to require `wrist.y - elbow.y > 0.06` — the wrist physically
    // beneath the elbow. Nobody pumps that way at speed: a fast pump is
    // bent-armed, hand travelling chest-to-overhead with the elbow below the
    // hand throughout. The down gate never opened, the arm latched at 'up', and
    // reps only counted on the occasional full downward extension. That is
    // exactly the "finnicky" that was reported.
    //
    // The simulator could not show it, because its pump swings hip-to-overhead
    // with the elbow pinned to the midpoint — so the wrist is below the elbow
    // at every trough BY CONSTRUCTION. "4Hz x 5s = exactly 40 reps" was
    // validating a motion no human makes: full extension at 4Hz is about 1.2m
    // of travel per rep.
    //
    // Dropping to the shoulder line keeps the anti-cheat intact: the swing from
    // `downEnter` to `upEnter` is still ~0.42 torso units (~20cm), so
    // quarter-height twitching still scores zero.
    const belowShoulder = (wrist.y - shoulder.y) / unit;

    const isUp = this.upGate.update(aboveShoulder);
    const isDown = this.downGate.update(belowShoulder);

    if (this.state === 'down' && isUp) {
      this.state = 'up';
      if (now - this.lastRepTime >= this.tun.minRepIntervalMs) {
        this.lastRepTime = now;
        return true;
      }
    } else if (this.state === 'up' && isDown) {
      this.state = 'down';
    }
    return false;
  }

  reset(): void {
    this.state = 'down';
    this.lastRepTime = 0;
    this.upGate.reset();
    this.downGate.reset();
  }
}

/**
 * Counts arm pumps for the 67 game. Both arms counted independently and summed,
 * which is what makes the alternating motion feel natural rather than forcing a
 * strict left-right order.
 */
export class RepCounter {
  private left: ArmPump;
  private right: ArmPump;
  private _count = 0;
  private _justCounted = 0;
  /** Rolling rep rate in reps/sec, drives the audio pitch ramp. */
  private repTimes: number[] = [];

  constructor(private tun: RepTunables = { ...DEFAULT_REP_TUNABLES }) {
    this.left = new ArmPump(tun);
    this.right = new ArmPump(tun);
  }

  setTunables(patch: Partial<RepTunables>): void {
    this.tun = { ...this.tun, ...patch };
    this.left.setTunables(this.tun);
    this.right.setTunables(this.tun);
  }

  getTunables(): Readonly<RepTunables> {
    return this.tun;
  }

  update(player: TrackedPlayer, now: number): number {
    // RAW landmarks, deliberately.
    //
    // One Euro is a low-pass filter, and a fast arm pump IS high-frequency
    // motion — exactly what it is built to remove. Measured against the pose
    // simulator at 4 pumps/sec, the 'body' preset compressed a ±0.55 torso-unit
    // swing down to ±0.03, so the wrist never crossed the shoulder and the rep
    // count sat at zero. The same attenuation would hit a real player.
    //
    // Smoothing was there to stop threshold chatter, and this detector already
    // solves that properly: hysteresis gaps on both gates plus minRepIntervalMs.
    // MotionEnergy reads raw for the same reason.
    const lm = player.raw;
    const unit = player.scale.unit;
    this._justCounted = 0;

    if (
      this.left.update(
        lm[POSE.LEFT_WRIST], lm[POSE.LEFT_SHOULDER], lm[POSE.LEFT_ELBOW], unit, now
      )
    ) {
      this._count++;
      this._justCounted++;
      this.repTimes.push(now);
    }
    if (
      this.right.update(
        lm[POSE.RIGHT_WRIST], lm[POSE.RIGHT_SHOULDER], lm[POSE.RIGHT_ELBOW], unit, now
      )
    ) {
      this._count++;
      this._justCounted++;
      this.repTimes.push(now);
    }

    const cutoff = now - 1500;
    while (this.repTimes.length && this.repTimes[0]! < cutoff) this.repTimes.shift();

    return this._justCounted;
  }

  get count(): number {
    return this._count;
  }
  get justCounted(): number {
    return this._justCounted;
  }
  /** Reps per second over the last 1.5s. */
  get rate(): number {
    return this.repTimes.length / 1.5;
  }

  reset(): void {
    this._count = 0;
    this._justCounted = 0;
    this.repTimes = [];
    this.left.reset();
    this.right.reset();
  }
}

/* ------------------------------------------------------------------ */
/* Jump / crouch                                                       */
/* ------------------------------------------------------------------ */

export interface JumpTunables {
  /** Rise above baseline, in torso units, to register a jump. */
  jumpEnter: number;
  jumpExit: number;
  /** Drop below baseline to register a crouch. */
  crouchEnter: number;
  crouchExit: number;
  /** Baseline adaptation rate while standing. */
  baselineRate: number;
  /** Minimum ms between jumps — stops a single hop double-firing. */
  cooldownMs: number;
}

export const DEFAULT_JUMP_TUNABLES: JumpTunables = {
  jumpEnter: 0.16,
  jumpExit: 0.07,
  crouchEnter: 0.18,
  crouchExit: 0.08,
  baselineRate: 0.03,
  cooldownMs: 250,
};

export class VerticalGestures {
  private baseline = new Baseline();
  private jumpGate: Hysteresis;
  private crouchGate: Hysteresis;
  private lastJump = 0;
  private lastCrouch = 0;

  private _jumped = false;
  private _crouched = false;

  constructor(private tun: JumpTunables = { ...DEFAULT_JUMP_TUNABLES }) {
    this.jumpGate = new Hysteresis(tun.jumpEnter, tun.jumpExit);
    this.crouchGate = new Hysteresis(tun.crouchEnter, tun.crouchExit);
    this.baseline = new Baseline(tun.baselineRate);
  }

  setTunables(patch: Partial<JumpTunables>): void {
    this.tun = { ...this.tun, ...patch };
    this.jumpGate.enter = this.tun.jumpEnter;
    this.jumpGate.exit = this.tun.jumpExit;
    this.crouchGate.enter = this.tun.crouchEnter;
    this.crouchGate.exit = this.tun.crouchExit;
  }

  getTunables(): Readonly<JumpTunables> {
    return this.tun;
  }

  update(player: TrackedPlayer, now: number): void {
    this._jumped = false;
    this._crouched = false;

    const lm = player.landmarks;
    const unit = player.scale.unit;
    if (unit <= 0) return;

    // Hip centre is the most reliable vertical reference. Head bobs when you
    // look around; feet leave the frame entirely at close range.
    const hip = midY(lm[POSE.LEFT_HIP], lm[POSE.RIGHT_HIP]);
    if (hip === null) return;

    const settled = !this.jumpGate.isActive && !this.crouchGate.isActive;
    const base = this.baseline.update(hip, settled);

    // Positive = hips higher than baseline = airborne.
    const delta = (base - hip) / unit;

    const jumping = this.jumpGate.update(delta);
    const crouching = this.crouchGate.update(-delta);

    if (jumping && this.jumpGate.justEntered && now - this.lastJump >= this.tun.cooldownMs) {
      this.lastJump = now;
      this._jumped = true;
    }
    if (crouching && this.crouchGate.justEntered && now - this.lastCrouch >= this.tun.cooldownMs) {
      this.lastCrouch = now;
      this._crouched = true;
    }
  }

  /** True only on the frame the jump starts. */
  get jumped(): boolean {
    return this._jumped;
  }
  get crouched(): boolean {
    return this._crouched;
  }
  /** True for the whole duration, for hold-to-slide mechanics. */
  get isAirborne(): boolean {
    return this.jumpGate.isActive;
  }
  get isCrouching(): boolean {
    return this.crouchGate.isActive;
  }

  reset(): void {
    this.baseline.reset();
    this.jumpGate.reset();
    this.crouchGate.reset();
    this.lastJump = 0;
    this.lastCrouch = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Lanes                                                               */
/* ------------------------------------------------------------------ */

export interface LaneTunables {
  /** Sideways offset from centre, in torso units, to commit to a side lane. */
  enter: number;
  /** Must come back inside this to return to centre. The gap is the hysteresis. */
  exit: number;
  laneCount: number;
}

export const DEFAULT_LANE_TUNABLES: LaneTunables = {
  enter: 0.55,
  exit: 0.3,
  laneCount: 3,
};

/**
 * Maps body sideways position to a discrete lane.
 *
 * Calibrates its own centre on the first settled frames, so it does not matter
 * whether the player stands dead centre of the camera — which they never do.
 */
export class LaneDetector {
  private centre = new Baseline(0.02);
  private lane = 0;
  private _changed = 0;

  constructor(private tun: LaneTunables = { ...DEFAULT_LANE_TUNABLES }) {}

  setTunables(patch: Partial<LaneTunables>): void {
    this.tun = { ...this.tun, ...patch };
  }

  getTunables(): Readonly<LaneTunables> {
    return this.tun;
  }

  /** @param mirrored display is mirrored, so invert so stepping right goes right */
  update(player: TrackedPlayer, mirrored = true): number {
    this._changed = 0;
    const lm = player.landmarks;
    const unit = player.scale.unit;
    if (unit <= 0) return this.lane;

    const x = midX(lm[POSE.LEFT_SHOULDER], lm[POSE.RIGHT_SHOULDER]);
    if (x === null) return this.lane;

    const base = this.centre.update(x, this.lane === 0);
    // ASPECT-CORRECTED. Landmark x is normalised by frame WIDTH and `unit` is a
    // torso height, i.e. a fraction of frame HEIGHT — so dividing one by the
    // other without scaling x understates every sideways movement by the aspect
    // ratio. At 16:9 that is 1.78x: a real 25cm side-step read as 0.31 torso
    // units against an `enter` of 0.55, so nothing registered until the player
    // lunged. Reported as "runner didn't detect movement".
    //
    // The simulator hid it twice over: it builds an isotropic body in
    // anisotropic space, and its lane offset is ~2 torso units of step, which
    // clears even a 1.78x-inflated threshold.
    let offset = ((x - base) * player.scale.aspect) / unit;
    if (mirrored) offset = -offset;

    const prev = this.lane;
    const max = Math.floor(this.tun.laneCount / 2);

    if (this.lane === 0) {
      if (offset > this.tun.enter) this.lane = Math.min(1, max);
      else if (offset < -this.tun.enter) this.lane = Math.max(-1, -max);
    } else if (this.lane > 0) {
      if (offset < this.tun.exit) this.lane = 0;
    } else {
      if (offset > -this.tun.exit) this.lane = 0;
    }

    if (this.lane !== prev) this._changed = this.lane - prev;
    return this.lane;
  }

  get current(): number {
    return this.lane;
  }
  /** Non-zero on the frame the lane changes; sign is the direction. */
  get changed(): number {
    return this._changed;
  }

  reset(): void {
    this.centre.reset();
    this.lane = 0;
    this._changed = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Motion energy — Red Light, Green Light                              */
/* ------------------------------------------------------------------ */

/**
 * Per-player movement magnitude, normalised by body size.
 *
 * Deliberately reads RAW landmarks, not filtered ones: One Euro exists to
 * suppress small fast movement, which is precisely the signal this needs.
 */
export class MotionEnergy {
  private prev: Landmark[] | null = null;
  private window: number[] = [];

  constructor(private windowSize = 5) {}

  update(player: TrackedPlayer): number {
    const lms = player.raw;
    const unit = player.scale.unit;

    if (!this.prev || unit <= 0) {
      this.prev = lms.map((l) => ({ ...l }));
      return 0;
    }

    let sum = 0;
    let n = 0;
    for (let i = 0; i < lms.length; i++) {
      const cur = lms[i]!;
      const old = this.prev[i];
      if (!old || cur.visibility < 0.4) continue;
      const dx = cur.x - old.x;
      const dy = cur.y - old.y;
      sum += Math.sqrt(dx * dx + dy * dy);
      n++;
    }

    this.prev = lms.map((l) => ({ ...l }));
    const energy = n > 0 ? sum / n / unit : 0;

    this.window.push(energy);
    if (this.window.length > this.windowSize) this.window.shift();

    return this.window.reduce((s, v) => s + v, 0) / this.window.length;
  }

  reset(): void {
    this.prev = null;
    this.window = [];
  }
}

/* ------------------------------------------------------------------ */
/* T-pose — calibration confirm                                        */
/* ------------------------------------------------------------------ */

/**
 * Arms out horizontally, held. Used to confirm "yes, I'm the player" without
 * anyone touching the laptop.
 *
 * Chosen over a wave because it's unambiguous, it's a pose rather than a
 * motion (so it survives a dropped frame), and nobody does it by accident.
 */
export class TPoseDetector {
  private heldSince = 0;

  constructor(
    /** Max vertical deviation of wrist from shoulder, in torso units. */
    private tolerance = 0.35,
    /** Min horizontal extension from shoulder, in torso units. */
    private extension = 0.7,
    private holdMs = 800
  ) {}

  /** @returns 0..1 progress toward confirmation */
  update(player: TrackedPlayer, now: number): number {
    const lm = player.landmarks;
    const unit = player.scale.unit;
    if (unit <= 0) {
      this.heldSince = 0;
      return 0;
    }

    const ls = lm[POSE.LEFT_SHOULDER];
    const rs = lm[POSE.RIGHT_SHOULDER];
    const lw = lm[POSE.LEFT_WRIST];
    const rw = lm[POSE.RIGHT_WRIST];

    if (!vis(ls) || !vis(rs) || !vis(lw) || !vis(rw)) {
      this.heldSince = 0;
      return 0;
    }

    const leftFlat = Math.abs(lw.y - ls.y) / unit < this.tolerance;
    const rightFlat = Math.abs(rw.y - rs.y) / unit < this.tolerance;
    // Aspect-corrected for the same reason as LaneDetector. Uncorrected, an
    // `extension` of 0.7 demanded 1.25 torso units of horizontal arm at 16:9 —
    // longer than an arm actually is (~1.07), so the T-pose was physically
    // unreachable and its ring could never complete.
    const aspect = player.scale.aspect;
    const leftOut = (Math.abs(lw.x - ls.x) * aspect) / unit > this.extension;
    const rightOut = (Math.abs(rw.x - rs.x) * aspect) / unit > this.extension;

    if (leftFlat && rightFlat && leftOut && rightOut) {
      if (this.heldSince === 0) this.heldSince = now;
      return Math.min(1, (now - this.heldSince) / this.holdMs);
    }

    this.heldSince = 0;
    return 0;
  }

  reset(): void {
    this.heldSince = 0;
  }
}
