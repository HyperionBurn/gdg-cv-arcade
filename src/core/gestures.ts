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

import { POSE, type Landmark } from './types.ts';
import type { TrackedPlayer } from './tracker.ts';

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

  public enter: number;
  public exit: number;
  private invert: boolean;

  // Explicit fields, not parameter properties: Node's --test type stripping is
  // strip-only and rejects those, which made this whole module — every gesture
  // detector every game depends on — impossible to unit test.
  constructor(enter: number, exit: number, invert = false) {
    this.enter = enter;
    this.exit = exit;
    this.invert = invert;
  }

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

  private rate: number;

  constructor(rate = 0.02) {
    this.rate = rate;
  }

  /**
   * @param rate optional override for THIS call only, so a caller can slow the
   *   adaptation down without giving up on it entirely. `LaneDetector` needs
   *   exactly that: it must stop chasing a player who is mid-step, but it must
   *   still eventually absorb a player who simply re-planted their feet 15cm
   *   to the left. A hard freeze does the first and never does the second, and
   *   a body stuck outside a frozen reference is a body one twitch away from a
   *   lane change it did not ask for. Omit it and nothing changes.
   */
  update(sample: number, settled: boolean, rate = this.rate): number {
    if (this.value === null) {
      this.value = sample;
    } else if (settled) {
      this.value += (sample - this.value) * rate;
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
   * How far the wrist must rise ABOVE THE MIDDLE OF ITS OWN STROKE to arm a
   * rep, in torso units, and how far it must fall below it to re-arm. The two
   * added together are the peak-to-peak SWING a rep costs, which is the whole
   * anti-cheat — see the note on `ArmPump`.
   */
  upEnter: number;
  upExit: number;
  downEnter: number;
  downExit: number;
  /**
   * How fast the middle of the stroke is learned, per frame at 60Hz.
   *
   * Must be slow compared with a pump — it is a high-pass corner, and a corner
   * near the pump frequency eats the signal it is measuring — but not so slow
   * that a 20-second round is over before it has found the middle.
   *
   * MEASURED, reps in 5s against the number the motion contains, band 0.12:
   *
   *   pump    0.008   0.011   0.016   0.020   0.030   0.040   of
   *   0.5Hz       4       4       4       5       5       5      5
   *   1.5Hz      13      13      13      13      13      13     15
   *   4Hz        33      33      34      35      35      36     40
   *   6Hz        53      54      54      54      54      54     60
   *   4Hz shallow-overhead stroke
   *              23      28      32      33      34      34     40
   *
   * The slow end is flat from 0.008 up, so nothing here is eating a pump; the
   * cost of a SLOW rate is convergence, and it shows up as reps missed in the
   * first seconds of a round. 0.02 (a 0.83s time constant, the same one
   * `Baseline` defaults to) is the first value where every style is at its
   * ceiling, and every cheat below still scores what it scored at 0.008.
   */
  centreRate: number;
  /** Ignore reps faster than this (ms). Physically implausible = cheating. */
  minRepIntervalMs: number;
}

/**
 * Same numbers the game installs — see the table on `REP_GATE` in
 * games/sixtyseven.ts. They are duplicated rather than imported because that
 * module pulls in canvas, audio and the DOM; the value of them matching is that
 * `shell/rigcheck.ts`, whose entire job is telling an operator what the
 * detectors can see, reports the gate the game will actually use.
 */
export const DEFAULT_REP_TUNABLES: RepTunables = {
  upEnter: 0.12,
  upExit: 0.05,
  downEnter: 0.12,
  downExit: 0.05,
  centreRate: 0.02,
  minRepIntervalMs: 60,
};

type ArmState = 'down' | 'up';

/**
 * One arm's up/down cycle, measured AGAINST THE MIDDLE OF ITS OWN STROKE.
 *
 * WHY NOT AGAINST THE SHOULDER. Reported from a human playtest: 67 tracked
 * perfectly with the hands a shoulder width apart or wider — "I can even do a
 * tpose 67" — and scored nothing at all with the hands close together.
 *
 * That is not a coordinate bug and it is not occlusion. It is geometry. How far
 * apart your hands are is set by how far you ABDUCT your upper arms, and upper
 * arm abduction is also the only thing that lifts your wrist above your
 * shoulder: with your elbows at your sides the forearm is SHORTER than the
 * upper arm, so the wrist tops out below the shoulder line no matter how hard
 * you pump. MEASURED, forward kinematics on this repo's own segment ratios
 * (S = 0.40 torso, upper arm 0.55, forearm 0.50) through the real tracker and
 * the real counter, 4Hz for 5s:
 *
 *   hands apart at the top   15cm   29cm   42cm   53cm   61cm   67cm
 *   wrist peak vs shoulder  -0.117 -0.098 -0.043 +0.044 +0.158 +0.291
 *   reps, shoulder-anchored     0      0      0     24     37     37
 *
 * Shoulder width on that body is 39cm. The cliff sits just outside it, which
 * is exactly where the tester put it.
 *
 * AND NO FIXED ANCHOR CAN FIX IT. The two real pumping styles pull the band in
 * opposite directions, and they overlap by less than the noise:
 *
 *                                    wrist top   wrist bottom   swing
 *   hands together, elbows tucked      -0.134       -0.838      0.70
 *   chest-to-overhead, elbows low      +0.062       -0.300      0.36
 *
 * A shoulder-anchored band has to admit the first one's TOP (so `upEnter` <=
 * -0.134) and the second one's BOTTOM (so `downEnter` <= 0.226, measured on the
 * shallowest overhead stroke) — leaving at most 0.09 torso of swing, half of
 * what the gate asks for today and about three times a single wrist's noise.
 * Anchoring to the ELBOW instead inverts the problem and is worse: an overhead
 * pump holds the forearm at a fixed angle, so the wrist sits a CONSTANT 0.250
 * torso above the elbow for the whole stroke and an elbow-anchored gate scores
 * a flat zero.
 *
 * The styles differ only by a DC offset. So the DC offset goes: `centre` learns
 * where the middle of this arm's stroke is and the gates run on the deviation
 * from it. The shoulder is still the raw reference, which is what keeps a jump,
 * a bob or a player standing up out of the signal; only the part that is
 * personal to the style is subtracted.
 *
 * WHAT STILL REJECTS A CHEAT. Exactly what the old note said rejected one: the
 * SWING, `upEnter + downEnter`. It is now 0.24 torso (~12cm) rather than 0.18,
 * because with the height requirement gone the swing is carrying the anti-cheat
 * on its own. Every real style measured swings 0.48-1.08 torso, so the gate
 * sits at half the shallowest real pump and about 4.4x a single wrist's hostile
 * landmark noise. The measured pass/fail distribution is in the note on
 * `REP_GATE` in games/sixtyseven.ts, which is also where the marshal's lever is.
 */
class ArmPump {
  /** Readable so the UI can show the gate the COUNTER is using. */
  state: ArmState = 'down';
  /**
   * -Infinity, not 0. Zero means "a rep happened at the epoch", so if a round's
   * clock starts within `minRepIntervalMs` of zero the FIRST rep of the round
   * is silently swallowed. Measured: the same motion scored 1 rep when counting
   * began at t=33ms and 2 from t=83ms onward.
   */
  private lastRepTime = -Infinity;
  private upGate: Hysteresis;
  private downGate: Hysteresis;
  /** The middle of this arm's stroke, in torso units above the shoulder. */
  private centre = new Baseline();

  private tun: RepTunables;

  constructor(tun: RepTunables) {
    this.tun = tun;
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

    // Screen Y grows downward, so "wrist above shoulder" is a positive value
    // here. Shoulder-relative, so nothing the whole body does — a jump, a bob,
    // a tall player — reaches the gate.
    const aboveShoulder = (shoulder.y - wrist.y) / unit;

    // ALWAYS ADAPTING, deliberately: unlike `VerticalGestures`, there is no
    // "settled" state to gate on. A pump is symmetric about its own middle, so
    // a slow average of it IS the middle; gating the average on the gate's own
    // state would make it track the half of the stroke the state machine
    // happened to be in.
    const centre = this.centre.update(aboveShoulder, true, this.tun.centreRate);
    const rel = aboveShoulder - centre;

    const isUp = this.upGate.update(rel);
    const isDown = this.downGate.update(-rel);

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
    this.centre.reset();
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

  private tun: RepTunables;

  constructor(tun: RepTunables = { ...DEFAULT_REP_TUNABLES }) {
    this.tun = tun;
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

  /**
   * Is this arm currently UP, according to the gate that actually counts?
   *
   * 67's on-screen arm dots used to run their own copy of this test, on
   * FILTERED landmarks and at different thresholds (0.14/0.06 against the
   * counter's raw 0.12/0.04). So the dots could light while the score did not
   * move, or vice versa — and their entire reason for existing, per their own
   * comment, is to tell a player whether the problem is their motion or the
   * camera. A readout that can disagree with the thing it is reporting on is
   * worse than no readout.
   *
   * It matters more now, not less: "up" is no longer a place on the body a
   * player could check against their own shoulder, it is the top of their own
   * stroke. This is the only thing that can honestly report it.
   */
  armUp(side: 'left' | 'right'): boolean {
    return (side === 'left' ? this.left : this.right).state === 'up';
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

  private tun: JumpTunables;

  constructor(tun: JumpTunables = { ...DEFAULT_JUMP_TUNABLES }) {
    this.tun = tun;
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

    // RAW, like RepCounter and MotionEnergy. A jump is a fast transient and
    // One Euro is built to remove exactly that.
    //
    // MEASURED against the real `body` preset at 30Hz: a 0.36s half-sine jump
    // of 0.18 units crosses a half-peak gate at 66.7ms raw and 166.7ms
    // filtered. A hundred milliseconds, on a game whose jump window is
    // documented as 0.37-0.45s — it is very likely the whole of the Runner's
    // "0.100s detection latency", which matches to within a millisecond.
    //
    // Safe because the machinery that makes raw safe is already here:
    // hysteresis on both edges, a `Baseline` for the reference, and a
    // cooldown. ARCHITECTURE.md's own rule says fast transients must read raw;
    // this class simply never did.
    const lm = player.raw;
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
  /**
   * Offset, in torso units, past which the centre reference STOPS FOLLOWING
   * THE BODY. See the note on the class: without it the reference chases the
   * player through the very movement it is measuring.
   */
  holdAt: number;
  /**
   * How long, in seconds, the reference is allowed to stay held before it
   * starts following again. Longer than any deliberate side-step; short enough
   * that a player who simply re-plants their feet is absorbed.
   */
  holdSec: number;
}

export const DEFAULT_LANE_TUNABLES: LaneTunables = {
  enter: 0.55,
  exit: 0.3,
  laneCount: 3,
  holdAt: 0.12,
  holdSec: 2,
};

/**
 * Maps body sideways position to a discrete lane.
 *
 * Calibrates its own centre on the first settled frames, so it does not matter
 * whether the player stands dead centre of the camera — which they never do.
 *
 * THE CENTRE REFERENCE HOLDS STILL WHILE THE BODY IS DISPLACED.
 *
 * It used to adapt on EVERY frame the lane was 0, at 0.02 a call — a ~0.83s
 * time constant at 60Hz. So the reference was chasing the player through the
 * exact movement it exists to measure, and what reached the gate was not "how
 * far did they move" but "how far did they move FASTER than 0.83 seconds".
 * A tester with a tape measure found the consequence: 40-50cm of side-step
 * before Runner would change lane, against a gate nominally set at 17.8cm.
 *
 * MEASURED — peak offset, torso units, for a lateral SHOULDER travel through
 * the real `PoseTracker` at 3m with realistic noise, p10 of 25 trials:
 *
 *   travel     0.4s    0.6s    0.9s    1.2s    1.5s    2.0s
 *    10cm     0.163   0.145   0.131   0.124   0.113   0.098
 *    20cm     0.317   0.284   0.254   0.231   0.211   0.182
 *    25cm     0.436   0.385   0.316   0.286   0.260   0.224
 *    30cm     0.552   0.522   0.470   0.339   0.309   0.266
 *
 * 20cm of real travel — a lean, which is what the same tester asked for — read
 * 0.18-0.32 depending only on how briskly it was taken. Against Runner's
 * `enter` of 0.35 it fired 0 times in 60 at every speed from 0.4s to 2.0s.
 *
 * So the reference now holds still once the body is more than `holdAt` from
 * it, and resumes only after `holdSec` — long enough to cover any deliberate
 * step, short enough that somebody who has simply re-planted their feet 15cm
 * to the left is absorbed within about 3 seconds instead of spending the rest
 * of the round with an off-centre gate. A hard freeze does the first and never
 * does the second, which leaves a body one twitch from a lane it did not ask
 * for; MEASURED, a 15cm re-plant leaves a residual offset of 0.287 that a hard
 * freeze still holds at 0.290 twenty seconds later and this clears by 3s.
 *
 * MEASURED after the change — fire rate, 30 seeds x 2 directions, `enter` 0.35:
 *
 *   20cm of shoulder travel taken in   0.4s   0.6s   0.9s   1.2s   1.6s   2.0s
 *     chasing reference (before)          0%     0%     0%     0%     0%     0%
 *     held reference (after)            100%   100%   100%   100%   100%    97%
 *
 *   and 10cm still fires 0%, at every speed, so a weight-shift is not a lane.
 *
 * WHAT IT COSTS. A held reference no longer suppresses slow postural sway.
 * MEASURED, 6 x 120s of a body ROCKING side to side at 0.35-0.95Hz under
 * HOSTILE noise, peak offset and false lane changes against `enter` 0.35:
 *
 *   rock      +-4cm   +-6cm   +-8cm   +-10cm  +-11cm  +-12cm
 *   before    0.142   0.186   0.229   0.273   0.295   0.317    0 changes throughout
 *   after     0.166   0.224   0.291   0.357   0.389   0.430    0, 0, 0, 2, 8, 66
 *
 * Clean to +-8cm, which is the widest sway this repo documents for a standing
 * body (see `admitSpeedTorsos` in core/tracker.ts). Past +-10cm — a 20cm
 * peak-to-peak sway, which in a three-lane runner is arguably a lane change —
 * it starts firing. `runner.laneEnter` is live on the operator console: 0.40
 * buys back the +-11cm case at the price of needing 22cm instead of 20cm.
 */
export class LaneDetector {
  private centre = new Baseline(0.02);
  private lane = 0;
  private _changed = 0;
  /** Seconds the body has been more than `holdAt` from the reference. */
  private heldSec = 0;
  /** Previous `now`, for dt. Null until a caller passes one. */
  private lastNow: number | null = null;

  private tun: LaneTunables;

  constructor(tun: LaneTunables = { ...DEFAULT_LANE_TUNABLES }) {
    this.tun = tun;
  }

  setTunables(patch: Partial<LaneTunables>): void {
    this.tun = { ...this.tun, ...patch };
  }

  getTunables(): Readonly<LaneTunables> {
    return this.tun;
  }

  /**
   * @param mirrored display is mirrored, so invert so stepping right goes right
   * @param now      milliseconds, for the `holdSec` timer. Omitted, a call is
   *   assumed to be one 60Hz frame — which is exactly what the adaptation
   *   `rate` has always silently assumed, so leaving it out changes nothing.
   */
  update(player: TrackedPlayer, mirrored = true, now?: number): number {
    this._changed = 0;
    // RAW, for the same reason as VerticalGestures. MEASURED: a 0.6-unit lane
    // step over 0.6s crosses the gate at 566.7ms raw and 700ms filtered.
    const lm = player.raw;
    const unit = player.scale.unit;
    if (unit <= 0) return this.lane;

    const x = midX(lm[POSE.LEFT_SHOULDER], lm[POSE.RIGHT_SHOULDER]);
    if (x === null) return this.lane;

    const dt =
      now === undefined || this.lastNow === null
        ? 1 / 60
        : Math.min(0.25, Math.max(0, (now - this.lastNow) / 1000));
    if (now !== undefined) this.lastNow = now;

    // How far the body is from the reference we are ABOUT to decide whether to
    // move. Asking before the update is the whole point: a reference that has
    // already taken a step toward the body cannot tell you the body moved.
    const heldBase = this.centre.current;
    const displaced =
      heldBase === null
        ? 0
        : Math.abs(((x - heldBase) * player.scale.aspect) / unit);

    if (displaced >= this.tun.holdAt) this.heldSec += dt;
    else this.heldSec = 0;
    const holding = displaced >= this.tun.holdAt && this.heldSec <= this.tun.holdSec;

    const base = this.centre.update(x, this.lane === 0 && !holding);
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
    this.heldSec = 0;
    this.lastNow = null;
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

  private windowSize: number;

  constructor(windowSize = 5) {
    this.windowSize = windowSize;
  }

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
      // ASPECT-CORRECTED. Landmark x is normalised by frame WIDTH and y by
      // frame HEIGHT, so the raw pair are not the same physical unit and
      // `sqrt(dx^2 + dy^2)` is not a distance. Uncorrected, this under-read
      // HORIZONTAL movement by the aspect ratio — 1.78x at 16:9 — which is
      // precisely the axis somebody walking through frame moves along.
      //
      // Found by measuring a stroller against attract's stillness gate: it
      // nearly qualified as standing still. The same signal drives Red Light's
      // elimination, so a player who swayed sideways during a red light was
      // under-detected by the same factor.
      const dx = (cur.x - old.x) * player.scale.aspect;
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

  /** Max vertical deviation of wrist from shoulder, in torso units. */
  private tolerance: number;
  /** Min horizontal extension from shoulder, in torso units. */
  private extension: number;
  private holdMs: number;

  constructor(tolerance = 0.35, extension = 0.7, holdMs = 800) {
    this.tolerance = tolerance;
    this.extension = extension;
    this.holdMs = holdMs;
  }

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
