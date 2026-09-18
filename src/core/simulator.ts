/**
 * Synthetic pose source. Development and demo only.
 *
 * Enabled with ?sim=1 — it replaces the camera + MediaPipe entirely with a
 * procedurally animated skeleton.
 *
 * This does NOT substitute for the human playtests in PLAN.md §8. It cannot
 * tell us whether a threshold is right for a 6'4" person under hall lighting,
 * which is the whole point of those sessions. What it does do:
 *
 *   - lets game logic, scoring, HUD and round flow be verified without a camera
 *   - reproduces a 2-player crossing on demand, which is fiddly to stage live
 *   - gives the stall a demo mode if the camera dies mid-event
 *   - makes the whole app runnable on a machine with no webcam at all
 *
 * The skeleton is intentionally crude. It only needs to be kinematically
 * plausible enough to drive the detectors.
 */

import { POSE_LANDMARK_COUNT, POSE, type Landmark, type RawPose, type VisionFrame } from './types';

export interface SimPlayer {
  /** Horizontal centre, normalised 0..1. */
  x: number;
  /** Ground line, normalised 0..1. */
  groundY: number;
  /** Body height as a fraction of frame height. */
  height: number;
  /** Arm pumps per second. 0 = arms down. */
  pumpRate: number;
  /** Phase offset so two sim players don't move identically. */
  phase: number;
  /**
   * Pump reach, 0..1. 1 = full arm raise well above the shoulder.
   * Values around 0.3 mimic someone twitching their hands without really
   * lifting them — the motion RepCounter's anti-cheat is meant to reject.
   */
  amplitude: number;
  jumping: boolean;
  crouching: boolean;
  /** -1, 0, 1 */
  lane: number;
  /** General fidget, drives Red Light motion energy. */
  jitter: number;
  /**
   * Horizontal hand sweeps per second. Drives the swipe games (Fruit Ninja).
   * 0 = off, and pumpRate takes over.
   */
  swipeRate: number;
  /** Sweep width as a fraction of frame width. */
  swipeWidth: number;
  /**
   * Pins BOTH wrists to an exact point in normalised camera space, overriding
   * every other arm motion. This is what makes hand-target games testable
   * deterministically — you can put a hand exactly on a balloon and assert it
   * pops, rather than sweeping and hoping.
   */
  handTarget: { x: number; y: number } | null;
  /**
   * Pins ONE wrist at a time, in normalised camera space. Overrides
   * `handTarget`, the swipe sweep and the flail for that side only; the other
   * arm keeps doing whatever it was doing.
   *
   * `handTarget` moves both wrists together, which is all a balloon or a fruit
   * ever needs. Rhythm Punch cannot be tested with it at all: the entire
   * mechanic is "the CORRECT hand", and the assertion that matters most —
   * that the wrong fist on a target scores nothing — requires putting one
   * wrist exactly on a note while the other is demonstrably somewhere else.
   * With both wrists pinned together, every note is trivially hit by the
   * correct hand and the rejection path is never exercised.
   *
   * Sides are SUBJECT-relative, matching POSE.LEFT_WRIST: `left` is the
   * player's own left hand. The display mirrors, so it appears on the left of
   * the screen as they look at it, and camera-x = 1 - screen-x.
   */
  wristTargets: { left: { x: number; y: number } | null; right: { x: number; y: number } | null };
  /**
   * Voluntary whole-body movement, 0..1. The Red Light signal: 1 is someone
   * flailing hard to gain ground, ~0.3 is someone shifting their weight.
   *
   * Scaled by `height`, so two sim players of very different sizes moving
   * "equally hard" produce the same body-normalised motion energy. Without
   * that, a test for "a big person is not punished" would only be testing
   * the simulator.
   */
  motion: number;
  /** Flail frequency, Hz. */
  motionRate: number;
  /**
   * Player has stopped dead. Stops `motion`, `pumpRate` AND `swipeRate`.
   *
   * It used to govern `motion` only, on the reasoning that pump and swipe
   * "belong to other games". That made `setFrozen` a lie in the one case it
   * exists for: a Red Light body driven by `setPump` — which is how both
   * `smoke.ts` and every hand-written probe drive it — kept pumping its arms
   * while nominally frozen. MEASURED: a "frozen" pumping body read an energy
   * of 5.02 against a threshold of 4.23 and was eliminated every time, while
   * the same body with `setPump(0)` read 2.26 and survived. That looked
   * exactly like Red Light judging every player collectively instead of
   * individually, and it is not — it was the simulator.
   *
   * A human who freezes stops everything. No game needs a frozen player who
   * is still swinging.
   *
   * Implemented by stopping `motionClock`, not by zeroing the amplitude: a
   * human who freezes holds the pose they were in, they do not snap back to a
   * neutral stance. Zeroing was the first implementation, and it teleported
   * the whole body by a tenth of a torso in a single frame — which read to
   * MotionEnergy as a violent flail at the exact instant the player stopped,
   * a simulator artifact that looked exactly like a real Red Light bug.
   *
   * `jitter` deliberately continues. A real frozen human still produces
   * landmark noise, and a freeze detector tuned against a perfectly
   * motionless skeleton would be tuned far too tight for the hall.
   */
  frozen: boolean;
  /** Advances only while not frozen. Drives `motion`. */
  motionClock: number;
  /**
   * Advances only while not frozen. Drives the pump and swipe waves.
   *
   * Separate from `motionClock` because the two run at different rates and
   * share no phase; both stop together when the player freezes.
   */
  driveClock: number;
  /**
   * Drives the whole body into an arbitrary joint configuration, overriding
   * arms, legs and torso lean. Null = the procedural motion above.
   *
   * Pose Match needs a sim player that can be put INTO a target pose and
   * scored against it, and - the part that actually matters - the SAME pose at
   * a different body size and a different place in frame, so the scale and
   * translation normalisation can be asserted numerically rather than assumed.
   */
  pose: SimJointPose | null;
}

/**
 * Joint angles, in degrees, for `SimPlayer.pose`.
 *
 * Structurally identical to `PoseAngles` in games/poses.ts, and deliberately
 * NOT imported from it: core must not depend on a game. Structural typing means
 * a real `PoseAngles` is assignable here anyway, so a test can feed a library
 * pose straight in.
 *
 * Convention, matching games/poses.ts exactly: each value is the ABSOLUTE
 * direction of the segment distal to that joint, measured from straight-down
 * and rotating outward on that limb's own side. 0 = down, 90 = straight out to
 * the side, 180 = up, negative = inward across the body. `lean` tilts the
 * torso, positive toward the subject's left; it moves the limb roots without
 * rotating the limb angles.
 */
export interface SimJointPose {
  shoulderL: number;
  elbowL: number;
  shoulderR: number;
  elbowR: number;
  hipL: number;
  kneeL: number;
  hipR: number;
  kneeR: number;
  lean?: number;
}

function makePlayer(x: number, phase = 0): SimPlayer {
  return {
    x,
    groundY: 0.95,
    height: 0.72,
    pumpRate: 0,
    phase,
    amplitude: 1,
    jumping: false,
    crouching: false,
    lane: 0,
    jitter: 0.002,
    swipeRate: 0,
    swipeWidth: 0.5,
    handTarget: null,
    wristTargets: { left: null, right: null },
    motion: 0,
    motionRate: 3.2,
    frozen: false,
    motionClock: 0,
    driveClock: 0,
    pose: null,
  };
}

function lm(x: number, y: number, visibility = 1): Landmark {
  return { x, y, z: 0, visibility };
}

/**
 * The synthetic frame's aspect ratio.
 *
 * The simulator lays skeletons out in the same anisotropic normalised space
 * MediaPipe uses, so it has to declare an aspect for body measurements to mean
 * anything. 16:9 matches the default capture request in core/camera.ts.
 */
export const SIM_ASPECT = 16 / 9;

/**
 * How unlike a camera the synthetic body is allowed to be.
 *
 * The simulator's bodies are noiseless, perfectly symmetric and always fully
 * visible. Real MediaPipe output is none of those things, and every single bug
 * this project has shipped to a camera lived in that gap — a stale blade
 * position on reacquire, a rep gate that assumed a limb never drops out, a
 * tracker that had never seen two detections of one person.
 *
 * OFF BY DEFAULT, deliberately. The regression sweep asserts exact figures
 * ("4Hz x 5s = exactly 40 reps") and those are worth keeping deterministic.
 * Turn it on to ask a different question: does this still work when the input
 * is ugly?
 */
export interface SimRealism {
  /**
   * Per-landmark positional noise, in normalised units, 1 sigma.
   *
   * MediaPipe at ~3m on a 1280x720 feed wanders a few pixels frame to frame
   * even on a still subject; 0.004 is about 3px of frame height. This is the
   * number the One Euro filter exists to absorb.
   */
  noise: number;
  /**
   * Chance per frame that a wrist drops below the visibility threshold.
   *
   * Real hands blur when swung and vanish behind torsos. This is what made
   * "the right hand feels murky" a real report and an unreproducible one.
   */
  dropout: number;
  /**
   * Extra dropout multiplier on the subject's dominant side.
   *
   * ~90% of people lead with the right, swing it harder, and blur it more. A
   * symmetric simulator can never produce an asymmetric complaint.
   */
  dominantBias: number;
  /**
   * Chance per frame that the model swaps this body's left and right limbs.
   *
   * MediaPipe genuinely does this. Its left/right are SUBJECT-relative and
   * inferred, so a person turning side-on, crossing their arms, or standing at
   * an angle can flip the labels for a run of frames. Anything that tracks a
   * specific limb — 67's per-arm gates, Rhythm's fist colours, the hover
   * cursor's chosen hand — sees a teleport.
   */
  limbSwap: number;
  /**
   * How far out of frame the body drifts, as a fraction of frame width.
   *
   * MediaPipe returns all 33 landmarks ALWAYS, extrapolating the ones it
   * cannot see — so an off-centre player yields confident coordinates outside
   * 0..1 rather than missing ones. Standing too close or off to one side is
   * the single most common framing mistake at a stall, and the simulator has
   * never produced a body that was anything but perfectly centred.
   */
  edgeBias: number;
  /**
   * Global visibility floor, for a room where the lights change.
   *
   * A hall's lighting is not constant: a projector, a door opening, someone
   * standing between the player and a window. Scales every landmark's
   * confidence, so gates keyed on visibility see the whole body get less
   * certain at once rather than one limb at a time.
   */
  lightingDip: number;
}

export const NO_REALISM: SimRealism = {
  noise: 0,
  dropout: 0,
  dominantBias: 1,
  limbSwap: 0,
  edgeBias: 0,
  lightingDip: 0,
};

/**
 * A plausible 3m webcam. Not calibrated against a specific camera — it exists
 * to make the input UGLY in the ways real input is ugly, not to predict a
 * particular sensor.
 */
export const REALISTIC: SimRealism = {
  noise: 0.004,
  dropout: 0.03,
  dominantBias: 2.5,
  limbSwap: 0.004,
  edgeBias: 0,
  lightingDip: 0,
};

/**
 * The stall on a bad day: a player standing off-centre and half out of frame,
 * in light that keeps changing, turning enough to confuse the model.
 */
export const HOSTILE: SimRealism = {
  noise: 0.007,
  dropout: 0.06,
  dominantBias: 3,
  limbSwap: 0.02,
  edgeBias: 0.22,
  lightingDip: 0.35,
};

/**
 * Every LEFT_/RIGHT_ landmark pair, for the limb-swap model.
 *
 * Built from POSE rather than listed by hand so a landmark added to the enum
 * cannot be silently left unswapped.
 */
const MIRRORED_PAIRS: ReadonlyArray<readonly [number, number]> = Object.keys(POSE)
  .filter((k) => k.startsWith('LEFT_'))
  .map((k) => [
    (POSE as Record<string, number>)[k]!,
    (POSE as Record<string, number>)[k.replace('LEFT_', 'RIGHT_')]!,
  ])
  .filter((pair): pair is [number, number] => pair[0] !== undefined && pair[1] !== undefined);

/** Box-Muller, so noise is gaussian rather than uniform like `jitter`. */
function gauss(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class PoseSimulator {
  players: SimPlayer[] = [makePlayer(0.5)];
  private frameId = 0;
  private jumpT = 0;
  private autoPump = false;

  /**
   * How camera-like the output should be. See SimRealism. Off by default so
   * the deterministic regression figures stay deterministic.
   */
  /**
   * REALISTIC by default, not NO_REALISM.
   *
   * A clean skeleton is the one input the app will never receive. Defaulting to
   * it meant every smoke sweep, every turn sweep and every hand-typed probe
   * tested the easy case unless someone remembered to opt in — and the bugs
   * that actually reached the playtest were all noise-dependent: a motionless
   * player eliminated in ten seconds, a race that never advanced, a cursor that
   * teleported on a dropped frame. Every one of them passed a clean sweep.
   *
   * `NO_REALISM` is still there to isolate a mechanic from its noise while
   * debugging, which is a deliberate act and should read as one at the call
   * site. `HOSTILE` is the stress case.
   */
  realism: SimRealism = { ...REALISTIC };

  /** Latched left/right label swap. See SimRealism.limbSwap. */
  private swapped = false;
  /** Slow oscillation driving `lightingDip`. */
  private lightPhase = 0;

  /** Cycles through a scripted demo so the stall has something to show. */
  auto = false;
  private autoTime = 0;

  setPlayerCount(n: number): void {
    while (this.players.length < n) {
      this.players.push(makePlayer(this.players.length === 1 ? 0.3 : 0.7, Math.PI * this.players.length));
    }
    while (this.players.length > n) this.players.pop();

    // RE-SPACE AFTER BOTH LOOPS, not just while growing.
    //
    // Shrinking used to leave everyone where the larger layout had put them, so
    // going 6 -> 1 (a Red Light round, then anything else) stranded the only
    // player at x = 1/7 = 0.14 — hard against the left edge of the frame, where
    // `edgeBias` is strongest and a body-anchored play area runs off screen.
    //
    // Measured as Rhythm Punch scoring 0 on ACTIVE play while passing every
    // other check, but only ever when something else had run first. It looked
    // exactly like cross-game state corruption in the game, and it was one
    // stale number in the simulator.
    this.players.forEach((p, i) => {
      p.x = (i + 1) / (this.players.length + 1);
    });
  }

  /**
   * Make a clean skeleton look like one a camera produced.
   *
   * Two effects, both chosen because a real failure hid behind their absence:
   *
   *  - GAUSSIAN POSITION NOISE on every landmark. The filter presets, the
   *    hysteresis gaps and the dwell timers all exist to absorb this, and
   *    without it none of them are ever actually exercised.
   *  - VISIBILITY DROPOUT on the wrists, biased toward the dominant side. A
   *    blade whose landmark vanishes and returns was sweeping a segment across
   *    the gap — a phantom slash through anything between — and that bug was
   *    reported from a camera as "the right hand feels murky" while being
   *    literally unreproducible here, because sim landmarks are always
   *    visibility 1.
   *
   * Applied AFTER the aspect squeeze, and the position noise is scaled DOWN in
   * x by the same aspect — see the note on `nx`. A real sensor's jitter is a
   * roughly constant number of pixels in both axes, which in a width-normalised
   * x and a height-normalised y is a SMALLER number horizontally.
   */
  private roughen(landmarks: Landmark[]): void {
    const r = this.realism;
    if (r.noise <= 0 && r.dropout <= 0 && r.limbSwap <= 0 && r.lightingDip <= 0) return;

    if (r.noise > 0) {
      // ISOTROPIC IN PIXELS, NOT IN LANDMARK SPACE.
      //
      // A real sensor's landmark jitter is roughly the same number of PIXELS in
      // both axes. Landmark x is normalised by frame WIDTH and y by HEIGHT, so
      // the same pixel error is a SMALLER number in x than in y — by exactly
      // the aspect ratio. This ran after the anisotropy squeeze and added the
      // same magnitude to both, which is a camera whose horizontal noise is
      // 1.78x its vertical noise. No such camera exists.
      //
      // It went unnoticed while the consumers were themselves missing their
      // aspect correction — two errors cancelling. Fixing `MotionEnergy` (and
      // the detectors before it) exposed this one: Red Light's measured
      // still-energy jumped 41% overnight, which was the simulator's phantom
      // horizontal noise finally being counted at full weight.
      const nx = r.noise / SIM_ASPECT;
      for (const l of landmarks) {
        if (!l) continue;
        l.x += gauss() * nx;
        l.y += gauss() * r.noise;
      }
    }

    // LIGHTING. Scales every landmark's confidence at once, which is how a
    // room dims — not one limb at a time.
    this.lightPhase += 0.02;
    if (r.lightingDip > 0) {
      const dip = 1 - r.lightingDip * (0.5 + 0.5 * Math.sin(this.lightPhase));
      for (const l of landmarks) {
        if (l) l.visibility *= dip;
      }
    }

    // LEFT/RIGHT CONFUSION. MediaPipe's sides are inferred and subject-
    // relative, so a body turning side-on can have them flip for a run of
    // frames. Latched rather than per-frame: a single-frame flicker is noise,
    // a sustained swap is what actually happens and what actually breaks
    // anything tracking a specific limb.
    if (r.limbSwap > 0) {
      if (this.swapped) {
        if (Math.random() < r.limbSwap * 1.5) this.swapped = false;
      } else if (Math.random() < r.limbSwap) {
        this.swapped = true;
      }
      if (this.swapped) {
        for (const [a, b] of MIRRORED_PAIRS) {
          const la = landmarks[a];
          const lb = landmarks[b];
          if (la && lb) {
            landmarks[a] = lb;
            landmarks[b] = la;
          }
        }
      }
    }

    if (r.dropout > 0) {
      // Subject-RIGHT is the dominant side for most people.
      const sides: Array<[number, number]> = [
        [POSE.RIGHT_WRIST, r.dropout * r.dominantBias],
        [POSE.RIGHT_INDEX, r.dropout * r.dominantBias],
        [POSE.LEFT_WRIST, r.dropout],
        [POSE.LEFT_INDEX, r.dropout],
      ];
      for (const [idx, chance] of sides) {
        const l = landmarks[idx];
        if (l && Math.random() < chance) l.visibility = 0.1;
      }
    }
  }

  /**
   * No `t` parameter any more: every wave in here is driven by the player's own
   * `motionClock`/`driveClock`, which stop when that player freezes. Taking the
   * global clock was what let a frozen body keep pumping.
   */
  private buildSkeleton(p: SimPlayer): RawPose {
    const landmarks: Landmark[] = new Array(POSE_LANDMARK_COUNT);

    const h = p.height;
    const jitterX = (Math.random() - 0.5) * p.jitter;
    const jitterY = (Math.random() - 0.5) * p.jitter;

    // Vertical offset from jumping / crouching.
    let lift = 0;
    if (p.jumping) lift = Math.sin(Math.min(Math.PI, this.jumpT * Math.PI)) * h * 0.22;
    const squash = p.crouching ? h * 0.2 : 0;

    // Red Light "advancing": a whole-body flail plus out-of-phase limb swing.
    //
    // Amplitudes are proportional to `h` so the resulting MotionEnergy — which
    // divides by torso height — comes out the same for a small and a large
    // player at the same `motion`. Frequencies are deliberately incommensurate
    // so the signal never sits still at a sampling harmonic.
    //
    // Driven by motionClock, which STOPS when the player freezes, so freezing
    // holds the current pose rather than snapping back to neutral.
    const w = p.motionClock * p.motionRate * Math.PI * 2 + p.phase;
    const swayX = p.motion * h * 0.042 * Math.sin(w);
    const swayY = p.motion * h * 0.028 * Math.sin(w * 1.7 + 0.9);
    const flail = p.motion * h * 0.1 * Math.sin(w * 1.3 + 2.1);

    const laneOffset = p.lane * h * 0.34;
    // EDGE BIAS. A body pushed toward the frame edge; landmarks past 0..1 are
    // MediaPipe extrapolating a limb it cannot see, which is exactly what it
    // does rather than omitting them.
    const cx = p.x + laneOffset + jitterX + swayX + this.realism.edgeBias;
    const ground = p.groundY - lift + jitterY + swayY;

    const hipY = ground - h * 0.48 + squash * 0.5;
    const shoulderY = ground - h * 0.78 + squash;
    const headY = ground - h * 0.94 + squash;

    const shoulderHalf = h * 0.12;
    const hipHalf = h * 0.085;

    // Head cluster.
    landmarks[POSE.NOSE] = lm(cx, headY);
    landmarks[POSE.LEFT_EYE_INNER] = lm(cx + 0.008, headY - 0.008);
    landmarks[POSE.LEFT_EYE] = lm(cx + 0.014, headY - 0.008);
    landmarks[POSE.LEFT_EYE_OUTER] = lm(cx + 0.02, headY - 0.008);
    landmarks[POSE.RIGHT_EYE_INNER] = lm(cx - 0.008, headY - 0.008);
    landmarks[POSE.RIGHT_EYE] = lm(cx - 0.014, headY - 0.008);
    landmarks[POSE.RIGHT_EYE_OUTER] = lm(cx - 0.02, headY - 0.008);
    landmarks[POSE.LEFT_EAR] = lm(cx + 0.028, headY);
    landmarks[POSE.RIGHT_EAR] = lm(cx - 0.028, headY);
    landmarks[POSE.MOUTH_LEFT] = lm(cx + 0.012, headY + 0.018);
    landmarks[POSE.MOUTH_RIGHT] = lm(cx - 0.012, headY + 0.018);

    landmarks[POSE.LEFT_SHOULDER] = lm(cx + shoulderHalf, shoulderY);
    landmarks[POSE.RIGHT_SHOULDER] = lm(cx - shoulderHalf, shoulderY);

    // Arms. Each side oscillates in antiphase so the motion reads as a pump.
    //
    // Wrist position is interpolated directly between two poses rather than
    // solved through joint angles. Forward kinematics here was subtly wrong in
    // a way that made the wrist never clear the shoulder, so the rep detector
    // correctly scored zero and the bug looked like a game bug. Direct
    // interpolation makes the extremes obvious and checkable by eye.
    //
    // `amplitude` below 1 produces a deliberately SHORT pump — used to verify
    // that the anti-cheat in RepCounter rejects small twitchy motion.
    const torsoH = hipY - shoulderY;

    for (const side of [1, -1] as const) {
      const isLeft = side === 1;
      const sx = cx + shoulderHalf * side;
      // p.driveClock, not the global `t`: it stops when this player freezes.
      const wave = Math.sin(
        p.driveClock * p.pumpRate * Math.PI * 2 + p.phase + (isLeft ? 0 : Math.PI)
      );
      const raise = p.pumpRate > 0 ? ((wave + 1) / 2) * p.amplitude : 0;

      // Down: wrist beside the hip. Up: well clear of the shoulder.
      const downY = hipY;
      const upY = shoulderY - torsoH * 0.55;
      let wy = downY + (upY - downY) * raise;

      // Arm swings outward as it rises.
      const downX = sx + h * 0.02 * side;
      const upX = sx + h * 0.1 * side;
      let wx = downX + (upX - downX) * raise;

      if (p.swipeRate > 0) {
        // Horizontal sweep at chest height — the Fruit Ninja motion.
        const sweep = Math.sin(
          p.driveClock * p.swipeRate * Math.PI * 2 + p.phase + (isLeft ? 0 : Math.PI)
        );
        wx = cx + sweep * p.swipeWidth * 0.5;
        wy = shoulderY + torsoH * 0.15;
      }

      if (p.handTarget) {
        wx = p.handTarget.x;
        wy = p.handTarget.y;
      }

      // Flail the arms in antiphase on top of whatever else they are doing.
      // Only ~10 of the 33 landmarks get this, which keeps the mean landmark
      // speed in the same ballpark as a real body where the torso barely moves.
      if (flail !== 0 && !p.handTarget) {
        wy += flail * side;
        wx += flail * 0.4 * side;
      }

      // Per-hand pin. Applied last so it wins over the sweep, the both-hands
      // target and the flail — see SimPlayer.wristTargets. The elbow below
      // still solves from it, so the arm stays kinematically plausible.
      const wristPin = isLeft ? p.wristTargets.left : p.wristTargets.right;
      if (wristPin) {
        wx = wristPin.x;
        wy = wristPin.y;
      }

      // Elbow trails between shoulder and wrist, bowed outward.
      const ex = (sx + wx) / 2 + h * 0.05 * side;
      const ey = (shoulderY + wy) / 2 + h * 0.03;

      landmarks[isLeft ? POSE.LEFT_ELBOW : POSE.RIGHT_ELBOW] = lm(ex, ey);
      landmarks[isLeft ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST] = lm(wx, wy);
      landmarks[isLeft ? POSE.LEFT_PINKY : POSE.RIGHT_PINKY] = lm(wx + 0.01 * side, wy - 0.01);
      landmarks[isLeft ? POSE.LEFT_INDEX : POSE.RIGHT_INDEX] = lm(wx + 0.014 * side, wy - 0.014);
      landmarks[isLeft ? POSE.LEFT_THUMB : POSE.RIGHT_THUMB] = lm(wx + 0.006 * side, wy - 0.006);
    }

    landmarks[POSE.LEFT_HIP] = lm(cx + hipHalf, hipY);
    landmarks[POSE.RIGHT_HIP] = lm(cx - hipHalf, hipY);

    const kneeY = hipY + h * 0.24 - squash * 0.3;
    const ankleY = ground - h * 0.02;
    landmarks[POSE.LEFT_KNEE] = lm(cx + hipHalf, kneeY);
    landmarks[POSE.RIGHT_KNEE] = lm(cx - hipHalf, kneeY);
    landmarks[POSE.LEFT_ANKLE] = lm(cx + hipHalf, ankleY);
    landmarks[POSE.RIGHT_ANKLE] = lm(cx - hipHalf, ankleY);
    landmarks[POSE.LEFT_HEEL] = lm(cx + hipHalf - 0.008, ankleY + 0.006);
    landmarks[POSE.RIGHT_HEEL] = lm(cx - hipHalf + 0.008, ankleY + 0.006);
    landmarks[POSE.LEFT_FOOT_INDEX] = lm(cx + hipHalf + 0.018, ankleY + 0.008);
    landmarks[POSE.RIGHT_FOOT_INDEX] = lm(cx - hipHalf - 0.018, ankleY + 0.008);

    if (p.pose) this.applyPose(landmarks, p.pose, cx, hipY, h);

    // ---- MAKE THE BODY ANISOTROPIC, LAST ----
    //
    // Everything above is built in ISOTROPIC units: a shoulder half-width of
    // `h * 0.12` means the same physical distance as a torso segment of
    // `h * 0.12`. That is how a body actually works, and it is the only way
    // this code stays readable.
    //
    // It is NOT how MediaPipe reports one. Landmark x is normalised by frame
    // WIDTH and y by frame HEIGHT, so on a 16:9 camera the same physical
    // distance is 1.78x SMALLER in x than in y. A simulator that skips this
    // step emits bodies no camera can produce — and, far worse, bodies that
    // agree with any consumer making the same mistake.
    //
    // That is not hypothetical. It hid three real bugs until a camera found
    // them: LaneDetector and TPoseDetector compared a horizontal distance
    // against a torso height, and poseSimilarity measured limb angles, all
    // without correcting for aspect. Every one passed here with full marks,
    // because the sim was wrong in exactly the same direction. A 45-degree
    // limb really did measure 45 degrees — to two wrongs agreeing.
    //
    // One squeeze about the body's true centre, after all the geometry
    // including `applyPose`, so nothing upstream has to think about it.
    for (let i = 0; i < landmarks.length; i++) {
      const l = landmarks[i];
      if (l) l.x = p.x + (l.x - p.x) / SIM_ASPECT;
    }

    this.roughen(landmarks);

    return { landmarks, worldLandmarks: landmarks };
  }

  /**
   * Forward kinematics from joint angles, overwriting the procedural limbs.
   *
   * Written against the convention documented on `SimJointPose` rather than
   * importing the game's kinematics, so "the simulator and the scorer agree" is
   * something the tests PROVE - drive the sim into a pose, assert the score is
   * ~1 - instead of something guaranteed by sharing a function and therefore
   * never actually checked.
   *
   * Segment LENGTHS here are cosmetic: the scorer normalises every segment to
   * unit length, so they are picked to keep the sim body's feet on its own
   * ground line, not to match any silhouette proportions.
   */
  private applyPose(
    landmarks: Landmark[],
    pose: SimJointPose,
    cx: number,
    hipY: number,
    h: number
  ): void {
    const DEG = Math.PI / 180;
    const torso = h * 0.3;
    const lean = (pose.lean ?? 0) * DEG;

    // Torso axis, and the shoulder/hip axis perpendicular to it.
    const upX = Math.sin(lean);
    const upY = -Math.cos(lean);
    const acrossX = Math.cos(lean);
    const acrossY = Math.sin(lean);

    const shoulderHalf = torso * 0.4;
    const upperArm = torso * 0.55;
    const foreArm = torso * 0.52;
    const thigh = torso * 0.78;
    const shin = torso * 0.75;
    const neck = torso * 0.53;

    const smx = cx + upX * torso;
    const smy = hipY + upY * torso;

    // Head rides the torso, so a lean tips the whole figure.
    const headX = smx + upX * neck;
    const headY = smy + upY * neck;
    landmarks[POSE.NOSE] = lm(headX, headY);
    landmarks[POSE.LEFT_EYE_INNER] = lm(headX + 0.008, headY - 0.008);
    landmarks[POSE.LEFT_EYE] = lm(headX + 0.014, headY - 0.008);
    landmarks[POSE.LEFT_EYE_OUTER] = lm(headX + 0.02, headY - 0.008);
    landmarks[POSE.RIGHT_EYE_INNER] = lm(headX - 0.008, headY - 0.008);
    landmarks[POSE.RIGHT_EYE] = lm(headX - 0.014, headY - 0.008);
    landmarks[POSE.RIGHT_EYE_OUTER] = lm(headX - 0.02, headY - 0.008);
    landmarks[POSE.LEFT_EAR] = lm(headX + 0.028, headY);
    landmarks[POSE.RIGHT_EAR] = lm(headX - 0.028, headY);
    landmarks[POSE.MOUTH_LEFT] = lm(headX + 0.012, headY + 0.018);
    landmarks[POSE.MOUTH_RIGHT] = lm(headX - 0.012, headY + 0.018);

    for (const side of [1, -1] as const) {
      const isLeft = side === 1;
      const shoulderDeg = isLeft ? pose.shoulderL : pose.shoulderR;
      const elbowDeg = isLeft ? pose.elbowL : pose.elbowR;
      const hipDeg = isLeft ? pose.hipL : pose.hipR;
      const kneeDeg = isLeft ? pose.kneeL : pose.kneeR;

      const sx = smx + acrossX * shoulderHalf * side;
      const sy = smy + acrossY * shoulderHalf * side;
      landmarks[isLeft ? POSE.LEFT_SHOULDER : POSE.RIGHT_SHOULDER] = lm(sx, sy);

      const sr = shoulderDeg * DEG;
      const ex = sx + side * Math.sin(sr) * upperArm;
      const ey = sy + Math.cos(sr) * upperArm;

      const er = elbowDeg * DEG;
      const wx = ex + side * Math.sin(er) * foreArm;
      const wy = ey + Math.cos(er) * foreArm;

      landmarks[isLeft ? POSE.LEFT_ELBOW : POSE.RIGHT_ELBOW] = lm(ex, ey);
      landmarks[isLeft ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST] = lm(wx, wy);
      landmarks[isLeft ? POSE.LEFT_PINKY : POSE.RIGHT_PINKY] = lm(wx + 0.01 * side, wy - 0.01);
      landmarks[isLeft ? POSE.LEFT_INDEX : POSE.RIGHT_INDEX] = lm(wx + 0.014 * side, wy - 0.014);
      landmarks[isLeft ? POSE.LEFT_THUMB : POSE.RIGHT_THUMB] = lm(wx + 0.006 * side, wy - 0.006);

      const hipLm = landmarks[isLeft ? POSE.LEFT_HIP : POSE.RIGHT_HIP];
      const hx = hipLm ? hipLm.x : cx;
      const hy = hipLm ? hipLm.y : hipY;

      const hr = hipDeg * DEG;
      const kx = hx + side * Math.sin(hr) * thigh;
      const ky = hy + Math.cos(hr) * thigh;

      const kr = kneeDeg * DEG;
      const ax = kx + side * Math.sin(kr) * shin;
      const ay = ky + Math.cos(kr) * shin;

      landmarks[isLeft ? POSE.LEFT_KNEE : POSE.RIGHT_KNEE] = lm(kx, ky);
      landmarks[isLeft ? POSE.LEFT_ANKLE : POSE.RIGHT_ANKLE] = lm(ax, ay);
      landmarks[isLeft ? POSE.LEFT_HEEL : POSE.RIGHT_HEEL] = lm(ax - 0.008 * side, ay + 0.006);
      landmarks[isLeft ? POSE.LEFT_FOOT_INDEX : POSE.RIGHT_FOOT_INDEX] = lm(ax + 0.018 * side, ay + 0.008);
    }
  }

  /** @param t seconds */
  step(t: number, dt: number): VisionFrame {
    for (const p of this.players) {
      if (p.frozen) continue;
      p.motionClock += dt;
      p.driveClock += dt;
    }

    if (this.jumpT > 0) {
      this.jumpT += dt * 2.6;
      if (this.jumpT >= 1) {
        this.jumpT = 0;
        for (const p of this.players) p.jumping = false;
      }
    }

    if (this.auto) this.runAutoScript(t, dt);

    return {
      poses: this.players.map((p) => this.buildSkeleton(p)),
      hands: [],
      captureTime: performance.now(),
      inferenceMs: 0,
      frameId: this.frameId++,
    };
  }

  /** Scripted loop: idle, pump, jump, crouch, lane-change, repeat. */
  private runAutoScript(_t: number, dt: number): void {
    this.autoTime += dt;
    const cycle = this.autoTime % 16;

    for (const p of this.players) {
      if (cycle < 2) {
        p.pumpRate = 0;
        p.jitter = 0.002;
      } else if (cycle < 8) {
        // Ramp the rate so the pitch ramp and rate readout are visible.
        p.pumpRate = 1.5 + (cycle - 2) * 0.45;
        p.jitter = 0.004;
      } else if (cycle < 10) {
        p.pumpRate = 0;
        if (!p.jumping && Math.floor(cycle * 2) % 2 === 0) this.triggerJump();
      } else if (cycle < 12) {
        p.crouching = true;
      } else {
        p.crouching = false;
        p.lane = cycle < 13.5 ? -1 : cycle < 15 ? 1 : 0;
      }
    }
  }

  triggerJump(): void {
    if (this.jumpT > 0) return;
    this.jumpT = 0.001;
    for (const p of this.players) p.jumping = true;
  }

  /** Horizontal sweeping, for swipe games. */
  setSwipe(rate: number, width = 0.5): void {
    for (const p of this.players) {
      p.swipeRate = rate;
      p.swipeWidth = width;
    }
  }

  /**
   * Pins both wrists to a point in normalised camera space (or clears it).
   * Note the display is mirrored, so screen-x = 1 - camera-x.
   */
  setHandTarget(target: { x: number; y: number } | null): void {
    for (const p of this.players) p.handTarget = target;
  }

  /**
   * Pins ONE wrist of ONE sim player, or releases it with null.
   *
   * Per-hand and per-player because the assertions Rhythm Punch needs are all
   * asymmetric: the right fist on a left-hand target must score nothing while
   * the left fist is somewhere else entirely, and in versus the two players
   * have to be able to hit and miss independently. `setHandTarget` can stage
   * neither.
   *
   * @param side   subject-relative, so `left` is the player's own left hand
   * @param target normalised CAMERA space — the display mirrors, so
   *               camera-x = 1 - screen-x. See `setHandTarget`.
   */
  setWristTarget(
    index: number,
    side: 'left' | 'right',
    target: { x: number; y: number } | null
  ): void {
    const p = this.players[index];
    if (!p) return;
    p.wristTargets[side] = target;
    // A pinned wrist is being placed, not swung. Leaving the pump running
    // would have the arm animation fight the pin every frame, exactly as
    // setPose already guards against.
    if (target) p.pumpRate = 0;
  }

  /** Same wrist on every sim player. Convenient for 1P tests. */
  setWristTargetAll(side: 'left' | 'right', target: { x: number; y: number } | null): void {
    for (let i = 0; i < this.players.length; i++) this.setWristTarget(i, side, target);
  }

  /** Releases every pinned wrist, on every player. */
  clearWristTargets(): void {
    for (const p of this.players) p.wristTargets = { left: null, right: null };
  }

  /**
   * Voluntary movement for ONE sim player — the Red Light control.
   *
   * Per-player rather than global because the whole point of Red Light is six
   * people making six independent decisions, and the interesting cases (one
   * freezes, one keeps going, one stops 300ms late) cannot be staged at all
   * with a global setter.
   *
   * @param motion 0..1, 1 being a full flail
   * @param rate   flail frequency in Hz
   */
  setMotion(index: number, motion: number, rate = 3.2): void {
    const p = this.players[index];
    if (!p) return;
    p.motion = Math.max(0, Math.min(1, motion));
    p.motionRate = rate;
    p.frozen = false;
  }

  setMotionAll(motion: number, rate = 3.2): void {
    for (let i = 0; i < this.players.length; i++) this.setMotion(i, motion, rate);
  }

  /**
   * Stop one player dead, or release them. Sensor jitter continues, and the
   * held pose is kept rather than reset — see `SimPlayer.frozen`. This is the
   * passing/failing pair for Red Light: `setFrozen(i, true)` has to survive a
   * red light, and leaving them moving has to not.
   */
  setFrozen(index: number, frozen: boolean): void {
    const p = this.players[index];
    if (p) p.frozen = frozen;
  }

  freezeAll(frozen: boolean): void {
    for (const p of this.players) p.frozen = frozen;
  }

  /**
   * Body height as a fraction of frame height. Lets a round mix a short and a
   * tall player so body-scale normalisation can actually be asserted.
   */
  setHeight(index: number, height: number): void {
    const p = this.players[index];
    if (p) p.height = Math.max(0.2, Math.min(0.95, height));
  }

  /**
   * Sets the lane the GAME will see, rather than a raw camera-space offset.
   *
   * `SimPlayer.lane` is in raw camera space, but every consumer (the tracker
   * and `LaneDetector`) runs mirrored, because the TV is mirrored — a player
   * stepping to their own right appears at a SMALLER x in the camera image.
   * Setting `p.lane = 1` directly therefore produces lane -1 in game, which is
   * a confusing thing for a test to have to know. This helper takes the game's
   * sign convention and inverts for you.
   */
  setLane(lane: number): void {
    const clamped = Math.max(-1, Math.min(1, Math.round(lane)));
    for (const p of this.players) p.lane = -clamped;
  }

  /** Hold or release a crouch on every sim player. Drives slide/duck gestures. */
  setCrouch(on: boolean): void {
    for (const p of this.players) p.crouching = on;
  }

  /**
   * Drive one sim player into an arbitrary joint configuration, or release it
   * back to the procedural motion with null.
   *
   * Per-player, because the assertions that matter for Pose Match are
   * comparative: the same pose on a short player and a tall one, or on a player
   * at the left of frame and one at the right, must score identically. A global
   * setter cannot stage either of those.
   */
  setPose(index: number, pose: SimJointPose | null): void {
    const p = this.players[index];
    if (!p) return;
    p.pose = pose;
    // A posed body is holding still, not pumping. Leaving these on would have
    // the arm animation fight the pose every frame.
    if (pose) {
      p.pumpRate = 0;
      p.swipeRate = 0;
      p.handTarget = null;
    }
  }

  setPoseAll(pose: SimJointPose | null): void {
    for (let i = 0; i < this.players.length; i++) this.setPose(i, pose);
  }

  /**
   * Horizontal position in normalised camera space. Pairs with `setHeight` for
   * the scale- and translation-invariance checks.
   */
  setPosition(index: number, x: number): void {
    const p = this.players[index];
    if (p) p.x = Math.max(0.05, Math.min(0.95, x));
  }

  setPump(rate: number, amplitude = 1): void {
    this.autoPump = rate > 0;
    for (const p of this.players) {
      p.pumpRate = rate;
      p.amplitude = amplitude;
    }
  }

  get pumping(): boolean {
    return this.autoPump;
  }
}

export const simulator = new PoseSimulator();

/** True when ?sim=1 is present. */
export function isSimEnabled(): boolean {
  return new URLSearchParams(location.search).has('sim');
}
