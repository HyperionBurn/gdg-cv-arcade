/**
 * Bodies in a KNOWN JOINT POSE, for the Pose Match tests.
 *
 * NOT a test file (no `.test.ts`), so `node --test "tests/*.test.ts"` skips it.
 *
 * WHY THIS EXISTS RATHER THAN `core/simulator.ts`. The simulator is the right
 * tool in the browser and it is where the numbers in `poses.ts` were measured,
 * but it imports its dependencies without file extensions, so `node --test`
 * cannot load it. The forward kinematics below are a deliberate RE-STATEMENT of
 * `simulator.applyPose` against the convention documented on `SimJointPose` —
 * the same relationship `applyPose` itself has to `poses.ts`. Two independent
 * implementations of the same convention is the point: if the scorer and the
 * body builder shared a function, "the silhouette a player is shown is the
 * shape they are scored against" would be true by construction and therefore
 * never actually tested.
 *
 * PROPORTIONS AND ASPECT, exactly as `tests/scene.ts` states them: everything
 * is laid out in ISOTROPIC units and squeezed in x by the aspect LAST, because
 * that is what MediaPipe reports and because a builder that skipped the squeeze
 * would agree with any consumer that made the same mistake. That is not
 * hypothetical here — `poseSimilarity` shipped without an aspect correction for
 * exactly that reason.
 */

import { POSE, POSE_LANDMARK_COUNT } from '../src/core/types.ts';
import type { Landmark, RawPose } from '../src/core/types.ts';
import { PoseTracker, type TrackedPlayer } from '../src/core/tracker.ts';
import type { PoseAngles } from '../src/games/poses.ts';
import { SCENE_ASPECT, rng, gauss } from './scene.ts';

const DEG = Math.PI / 180;

export interface PoseBodyOptions {
  /** Body centre-line, normalised across frame WIDTH. */
  x?: number;
  /** Hip height, normalised across frame HEIGHT. */
  hipY?: number;
  /** Standing height in frame heights. Segment lengths scale off this. */
  height?: number;
  aspect?: number;
  /**
   * Per-landmark positional sigma in frame HEIGHTS, applied isotropically IN
   * PIXELS — see `roughen` in scene.ts. `simulator.REALISTIC` is 0.004,
   * `HOSTILE` 0.007.
   */
  noise?: number;
  /** Landmarks whose visibility is forced below the scorer's 0.5 floor. */
  hide?: readonly number[];
  /** Multiplies every visibility, like a room whose lighting dips. */
  lightingDip?: number;
  /**
   * Report this body with MediaPipe's LEFT_/RIGHT_ labels the wrong way round,
   * the way a turning or arm-crossing body really does for runs of frames.
   */
  swapLabels?: boolean;
  /** Gaussian error added to every joint angle, in degrees. A sloppy player. */
  jointSigma?: number;
  /** Deterministic source. Tests that depend on noise must not depend on the clock. */
  random?: () => number;
}

/** Every LEFT_x <-> RIGHT_x index pair; identity on the midline. */
const MIRRORED: readonly number[] = (() => {
  const map = Array.from({ length: POSE_LANDMARK_COUNT }, (_, i) => i);
  for (const key of Object.keys(POSE)) {
    if (!key.startsWith('LEFT_')) continue;
    const l = (POSE as Record<string, number>)[key];
    const r = (POSE as Record<string, number>)[key.replace('LEFT_', 'RIGHT_')];
    if (l === undefined || r === undefined) continue;
    map[l] = r;
    map[r] = l;
  }
  return map;
})();

/** Joint angles, jittered by `sigma` degrees on every joint. A sloppy player. */
export function sloppy(a: PoseAngles, sigma: number, r: () => number): PoseAngles {
  if (sigma <= 0) return a;
  const j = (v: number): number => v + gauss(r) * sigma;
  return {
    shoulderL: j(a.shoulderL), elbowL: j(a.elbowL),
    shoulderR: j(a.shoulderR), elbowR: j(a.elbowR),
    hipL: j(a.hipL), kneeL: j(a.kneeL),
    hipR: j(a.hipR), kneeR: j(a.kneeR),
    // The torso is a whole-body sway, not a limb, and people control it much
    // better than they control an elbow. A third of the limb error.
    lean: a.lean + gauss(r) * sigma * 0.33,
  };
}

/**
 * One body holding `pose`, as MediaPipe would report it.
 *
 * All 33 landmarks, because `computeArea` reads every one of them and the
 * tracker's `minArea` gate is keyed on the bounding box.
 */
export function poseBody(pose: PoseAngles, opts: PoseBodyOptions = {}): RawPose {
  const aspect = opts.aspect ?? SCENE_ASPECT;
  const h = opts.height ?? 0.72;
  const cx = opts.x ?? 0.5;
  const hipY = opts.hipY ?? 0.6;
  const r = opts.random ?? Math.random;
  const a = opts.jointSigma ? sloppy(pose, opts.jointSigma, r) : pose;

  // Segment lengths copied from `simulator.applyPose`, which picks them to keep
  // the sim body's feet on its own ground line. Lengths are cosmetic to the
  // scorer — it normalises every segment to unit length — but they decide
  // whether a segment clears `MIN_SEGMENT_UNITS`, so they must be plausible.
  const torso = h * 0.3;
  const lean = a.lean * DEG;
  const upX = Math.sin(lean);
  const upY = -Math.cos(lean);
  const acrossX = Math.cos(lean);
  const acrossY = Math.sin(lean);
  const shoulderHalf = torso * 0.4;
  const hipHalf = torso * 0.26;
  const upperArm = torso * 0.55;
  const foreArm = torso * 0.52;
  const thigh = torso * 0.78;
  const shin = torso * 0.75;
  const neck = torso * 0.53;

  const lms: Landmark[] = new Array(POSE_LANDMARK_COUNT);
  const set = (i: number, x: number, y: number): void => {
    lms[i] = { x, y, z: 0, visibility: 1 };
  };

  const smx = cx + upX * torso;
  const smy = hipY + upY * torso;
  const headX = smx + upX * neck;
  const headY = smy + upY * neck;

  set(POSE.NOSE, headX, headY);
  set(POSE.LEFT_EYE_INNER, headX + 0.008, headY - 0.008);
  set(POSE.LEFT_EYE, headX + 0.014, headY - 0.008);
  set(POSE.LEFT_EYE_OUTER, headX + 0.02, headY - 0.008);
  set(POSE.RIGHT_EYE_INNER, headX - 0.008, headY - 0.008);
  set(POSE.RIGHT_EYE, headX - 0.014, headY - 0.008);
  set(POSE.RIGHT_EYE_OUTER, headX - 0.02, headY - 0.008);
  set(POSE.LEFT_EAR, headX + 0.028, headY);
  set(POSE.RIGHT_EAR, headX - 0.028, headY);
  set(POSE.MOUTH_LEFT, headX + 0.012, headY + 0.018);
  set(POSE.MOUTH_RIGHT, headX - 0.012, headY + 0.018);

  set(POSE.LEFT_HIP, cx + acrossX * hipHalf, hipY + acrossY * hipHalf);
  set(POSE.RIGHT_HIP, cx - acrossX * hipHalf, hipY - acrossY * hipHalf);

  for (const side of [1, -1] as const) {
    const isLeft = side === 1;
    const shoulderDeg = isLeft ? a.shoulderL : a.shoulderR;
    const elbowDeg = isLeft ? a.elbowL : a.elbowR;
    const hipDeg = isLeft ? a.hipL : a.hipR;
    const kneeDeg = isLeft ? a.kneeL : a.kneeR;

    const sx = smx + acrossX * shoulderHalf * side;
    const sy = smy + acrossY * shoulderHalf * side;
    set(isLeft ? POSE.LEFT_SHOULDER : POSE.RIGHT_SHOULDER, sx, sy);

    const sr = shoulderDeg * DEG;
    const ex = sx + side * Math.sin(sr) * upperArm;
    const ey = sy + Math.cos(sr) * upperArm;
    const er = elbowDeg * DEG;
    const wx = ex + side * Math.sin(er) * foreArm;
    const wy = ey + Math.cos(er) * foreArm;
    set(isLeft ? POSE.LEFT_ELBOW : POSE.RIGHT_ELBOW, ex, ey);
    set(isLeft ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST, wx, wy);
    set(isLeft ? POSE.LEFT_PINKY : POSE.RIGHT_PINKY, wx + 0.01 * side, wy - 0.01);
    set(isLeft ? POSE.LEFT_INDEX : POSE.RIGHT_INDEX, wx + 0.014 * side, wy - 0.014);
    set(isLeft ? POSE.LEFT_THUMB : POSE.RIGHT_THUMB, wx + 0.006 * side, wy - 0.006);

    const hx = cx + acrossX * hipHalf * side;
    const hy = hipY + acrossY * hipHalf * side;
    const hr = hipDeg * DEG;
    const kx = hx + side * Math.sin(hr) * thigh;
    const ky = hy + Math.cos(hr) * thigh;
    const kr = kneeDeg * DEG;
    const ax = kx + side * Math.sin(kr) * shin;
    const ay = ky + Math.cos(kr) * shin;
    set(isLeft ? POSE.LEFT_KNEE : POSE.RIGHT_KNEE, kx, ky);
    set(isLeft ? POSE.LEFT_ANKLE : POSE.RIGHT_ANKLE, ax, ay);
    set(isLeft ? POSE.LEFT_HEEL : POSE.RIGHT_HEEL, ax - 0.008 * side, ay + 0.006);
    set(isLeft ? POSE.LEFT_FOOT_INDEX : POSE.RIGHT_FOOT_INDEX, ax + 0.018 * side, ay + 0.008);
  }

  for (let i = 0; i < POSE_LANDMARK_COUNT; i++) if (!lms[i]) set(i, cx, hipY);

  // ---- ANISOTROPY, LAST. See the header. ----
  for (const l of lms) l.x = cx + (l.x - cx) / aspect;

  // Sensor noise is roughly the same number of PIXELS on both axes, and x is
  // normalised by the wider dimension, so the same error is a SMALLER number
  // in x by exactly the aspect ratio.
  const n = opts.noise ?? 0;
  if (n > 0) for (const l of lms) {
    l.x += (gauss(r) * n) / aspect;
    l.y += gauss(r) * n;
  }
  if (opts.lightingDip) for (const l of lms) l.visibility *= 1 - opts.lightingDip;
  for (const i of opts.hide ?? []) if (lms[i]) lms[i]!.visibility = 0.1;

  // The LABEL SWAP, last of all: MediaPipe's LEFT_/RIGHT_ are inferred, and
  // when they flip the whole limb set is reported under the wrong names while
  // the midline landmarks stay put. Swapping INDICES is exactly that.
  if (opts.swapLabels) {
    const swapped: Landmark[] = new Array(POSE_LANDMARK_COUNT);
    for (let i = 0; i < POSE_LANDMARK_COUNT; i++) swapped[i] = lms[MIRRORED[i] ?? i]!;
    return { landmarks: swapped, worldLandmarks: swapped, score: 1 };
  }

  return { landmarks: lms, worldLandmarks: lms, score: 1 };
}

/** Matches `simulator.REALISTIC` closely enough to compare numbers with it. */
export const REALISTIC: PoseBodyOptions = { noise: 0.004 };
/** Matches `simulator.HOSTILE`: a body off-centre, in light that keeps changing. */
export const HOSTILE: PoseBodyOptions = { noise: 0.007, lightingDip: 0.35, x: 0.38 };

/**
 * Frames a track needs before it is ADMITTED as a player.
 *
 * The stillness gate is `minSpeedSpanSec + admitStillSec` on top of
 * `minAgeToConfirm`, which at 60fps is about 27 frames. See `tests/aspect.ts`
 * for the same constant derived from the other direction.
 */
export const SETTLE_FRAMES = 40;

/**
 * Hold `pose` in front of a tracker for `frames` frames and hand back the
 * filtered player. One Euro is a low-pass filter, so a held pose has to be held
 * for a while before the filtered skeleton is actually in it — which is the
 * real behaviour this game lives on (`filterPreset: 'poseHold'`).
 */
export function holdPose(
  pose: PoseAngles,
  opts: PoseBodyOptions = {},
  frames = SETTLE_FRAMES
): TrackedPlayer | null {
  const tracker = new PoseTracker({ maxPlayers: 1, filterPreset: 'poseHold' });
  let out: TrackedPlayer | null = null;
  for (let i = 0; i <= frames; i++) {
    const found = tracker.update([poseBody(pose, opts)], i / 60);
    out = found[0] ?? out;
  }
  return out;
}

/** A tracker plus a step function, for tests that need to change the body mid-run. */
export function poseRig(
  opts: PoseBodyOptions = {}
): { step: (pose: PoseAngles, over?: PoseBodyOptions) => TrackedPlayer | null } {
  const tracker = new PoseTracker({ maxPlayers: 1, filterPreset: 'poseHold' });
  let t = 0;
  let last: TrackedPlayer | null = null;
  return {
    step(pose: PoseAngles, over: PoseBodyOptions = {}): TrackedPlayer | null {
      t += 1 / 60;
      const found = tracker.update([poseBody(pose, { ...opts, ...over })], t);
      last = found[0] ?? null;
      return last;
    },
  };
}

export { rng, gauss };
