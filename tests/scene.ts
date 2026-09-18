/**
 * Adversarial scenes for the tracker tests, built by hand.
 *
 * NOT a test file (no `.test.ts`), so `node --test "tests/*.test.ts"` skips it.
 *
 * WHY THIS EXISTS RATHER THAN `core/simulator.ts`. The simulator emits exactly
 * as many clean, well-separated, evenly-lit bodies as it is told to, all the
 * same size, all standing in the middle of the frame. The failures this track
 * is about are all the other shape: several detections of ONE body, a stranger
 * WALKING behind a standing player, a watcher two metres back, two players
 * whose paths cross, a player turning until their shoulders vanish. The
 * simulator cannot produce any of those, and the one bug that reached a real
 * camera — Red Light reading one person as four — is exactly the bug it could
 * never have caught.
 *
 * PROPORTIONS AND ASPECT. Bodies are laid out in ISOTROPIC units (a shoulder
 * half-width of 0.12h is the same physical length as a torso segment of 0.12h)
 * and squeezed in x by the aspect LAST, which is precisely what
 * `simulator.buildSkeleton` does and precisely what MediaPipe reports. A scene
 * builder that skipped the squeeze would agree with any consumer that made the
 * same mistake, which is how three aspect bugs survived in this repo.
 *
 * Segment ratios are copied from `simulator.buildSkeleton` so measurements
 * taken here are comparable with the numbers the rest of the app is tuned on.
 */

import { POSE, POSE_LANDMARK_COUNT } from '../src/core/types.ts';
import type { Landmark, RawPose } from '../src/core/types.ts';

/** The frame shape everything here is laid out in. Matches `SIM_ASPECT`. */
export const SCENE_ASPECT = 16 / 9;

/**
 * Physical geometry the scenes are reasoned in, so "a passer-by at 1.4 m/s"
 * can be turned into landmark units instead of guessed.
 *
 * A 60-degree horizontal FOV webcam (the common default) at distance d metres
 * sees a frame 2*d*tan(30deg) = 1.155*d metres wide, therefore
 * 1.155*d/aspect = 0.65*d metres tall at 16:9. Every conversion below is that
 * one fact.
 */
export const FOV_WIDTH_PER_METRE = 2 * Math.tan((30 * Math.PI) / 180); // 1.1547

/** Frame height in metres at distance `d`. One "frame height" of body = this. */
export function frameHeightMetres(d: number, aspect = SCENE_ASPECT): number {
  return (FOV_WIDTH_PER_METRE * d) / aspect;
}

/**
 * Standing height in frame-heights for a person of `stature` metres at `d`
 * metres. A 1.7m adult at 3m on a 16:9 60-degree camera stands 0.87 frame
 * heights tall, which is what a player filling a stall's frame looks like.
 */
export function heightAt(d: number, stature = 1.7, aspect = SCENE_ASPECT): number {
  return stature / frameHeightMetres(d, aspect);
}

/**
 * Horizontal speed in normalised-x per second for someone moving `mps` metres
 * per second across the frame at distance `d`.
 */
export function lateralNormX(mps: number, d: number): number {
  return mps / (FOV_WIDTH_PER_METRE * d);
}

/** Camera on a tripod at chest height, which is how the stall is set up. */
export const CAMERA_HEIGHT_M = 1.1;
/** The distance the camera is trimmed for, and where that puts a player's feet. */
const TRIM_DISTANCE_M = 3;
const TRIM_GROUND_Y = 0.95;

/**
 * Where a person's FEET land in frame, for someone standing `d` metres away.
 *
 * A real camera is a projection, not a sideways-scrolling backdrop: everybody
 * further away is HIGHER in frame, converging on the horizon. That vertical
 * separation is most of the distance between a player and the person walking
 * behind them, so a scene that puts every body on the same ground line makes
 * crowd rejection look far harder than it is — and a scene that ignores it
 * entirely makes the y axis of every centroid distance meaningless.
 */
export function groundYAt(d: number, aspect = SCENE_ASPECT): number {
  const halfV = Math.atan(Math.tan((30 * Math.PI) / 180) / aspect);
  const tilt =
    Math.atan(CAMERA_HEIGHT_M / TRIM_DISTANCE_M) -
    Math.atan((TRIM_GROUND_Y - 0.5) * 2 * Math.tan(halfV));
  return 0.5 + Math.tan(Math.atan(CAMERA_HEIGHT_M / d) - tilt) / (2 * Math.tan(halfV));
}

/** One standing person at `x`, `d` metres away, correctly sized and placed. */
export function personAt(x: number, d: number, extra: Partial<BodySpec> = {}): RawPose {
  return makeBody({ x, height: heightAt(d), groundY: groundYAt(d), ...extra });
}

/** Deterministic RNG. Tests that depend on noise must not depend on the clock. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller on a seeded source, matching the simulator's gaussian noise. */
export function gauss(r: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface BodySpec {
  /** Body centre-line, normalised across frame WIDTH. */
  x: number;
  /** Feet, normalised across frame HEIGHT. Further away = higher up the frame. */
  groundY?: number;
  /** Full standing height in FRAME HEIGHTS. `heightAt()` turns metres into this. */
  height?: number;
  /**
   * Radians about the vertical axis. 0 faces the camera, PI/2 is full profile.
   * Shoulder width collapses with cos(yaw); torso height does not. That
   * difference is the whole reason `scale.unit` prefers torso height.
   */
  yaw?: number;
  /** 0 = arms at the sides, 1 = arms straight out. Swings the bbox, not the torso. */
  armSpread?: number;
  /** Uniform landmark visibility. */
  visibility?: number;
  /** Visibility of the hips alone — the landmarks whose loss breaks `unit`. */
  hipVisibility?: number;
  aspect?: number;
}

/**
 * One plausible standing body. All 33 landmarks, because `computeArea` reads
 * every one of them and a half-built skeleton would understate the bbox that
 * `minArea` and the old `getPrimary` are keyed on.
 */
export function makeBody(spec: BodySpec): RawPose {
  const aspect = spec.aspect ?? SCENE_ASPECT;
  const h = spec.height ?? 0.72;
  const ground = spec.groundY ?? 0.95;
  const yaw = spec.yaw ?? 0;
  const spread = spec.armSpread ?? 0;
  const vis = spec.visibility ?? 1;
  const cx = spec.x;
  const turn = Math.cos(yaw);

  const hipY = ground - h * 0.48;
  const shoulderY = ground - h * 0.78;
  const headY = ground - h * 0.94;
  const shoulderHalf = h * 0.12;
  const hipHalf = h * 0.085;
  const upperArm = h * 0.165;
  const foreArm = h * 0.15;

  const lms: Landmark[] = new Array(POSE_LANDMARK_COUNT);
  /** Takes ISOTROPIC coordinates; the aspect squeeze happens once, at the end. */
  const set = (i: number, x: number, y: number, v = vis): void => {
    lms[i] = { x, y, z: 0, visibility: v };
  };

  // Head cluster.
  set(POSE.NOSE, cx, headY);
  set(POSE.LEFT_EYE_INNER, cx + h * 0.012 * turn, headY - h * 0.012);
  set(POSE.LEFT_EYE, cx + h * 0.022 * turn, headY - h * 0.014);
  set(POSE.LEFT_EYE_OUTER, cx + h * 0.032 * turn, headY - h * 0.014);
  set(POSE.RIGHT_EYE_INNER, cx - h * 0.012 * turn, headY - h * 0.012);
  set(POSE.RIGHT_EYE, cx - h * 0.022 * turn, headY - h * 0.014);
  set(POSE.RIGHT_EYE_OUTER, cx - h * 0.032 * turn, headY - h * 0.014);
  set(POSE.LEFT_EAR, cx + h * 0.042 * turn, headY - h * 0.008);
  set(POSE.RIGHT_EAR, cx - h * 0.042 * turn, headY - h * 0.008);
  set(POSE.MOUTH_LEFT, cx + h * 0.018 * turn, headY + h * 0.022);
  set(POSE.MOUTH_RIGHT, cx - h * 0.018 * turn, headY + h * 0.022);

  // Torso. The hips carry their own visibility so a scene can drop them.
  const hipVis = spec.hipVisibility ?? vis;
  set(POSE.LEFT_SHOULDER, cx + shoulderHalf * turn, shoulderY);
  set(POSE.RIGHT_SHOULDER, cx - shoulderHalf * turn, shoulderY);
  set(POSE.LEFT_HIP, cx + hipHalf * turn, hipY, hipVis);
  set(POSE.RIGHT_HIP, cx - hipHalf * turn, hipY, hipVis);

  // Arms. `spread` rotates them from straight down to straight out, which is
  // what makes the bounding box — and nothing about the torso — double.
  const armAngle = (spread * Math.PI) / 2;
  const ex = Math.sin(armAngle) * upperArm;
  const ey = Math.cos(armAngle) * upperArm;
  const wx = ex + Math.sin(armAngle) * foreArm;
  const wy = ey + Math.cos(armAngle) * foreArm;
  for (const side of [1, -1] as const) {
    const s = side === 1 ? POSE.LEFT_SHOULDER : POSE.RIGHT_SHOULDER;
    const elbow = side === 1 ? POSE.LEFT_ELBOW : POSE.RIGHT_ELBOW;
    const wrist = side === 1 ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST;
    const pinky = side === 1 ? POSE.LEFT_PINKY : POSE.RIGHT_PINKY;
    const index = side === 1 ? POSE.LEFT_INDEX : POSE.RIGHT_INDEX;
    const thumb = side === 1 ? POSE.LEFT_THUMB : POSE.RIGHT_THUMB;
    const root = cx + side * shoulderHalf * turn;
    set(elbow, root + side * ex * turn, shoulderY + ey);
    set(wrist, root + side * wx * turn, shoulderY + wy);
    set(pinky, root + side * (wx + h * 0.02) * turn, shoulderY + wy + h * 0.02);
    set(index, root + side * (wx + h * 0.028) * turn, shoulderY + wy + h * 0.018);
    set(thumb, root + side * (wx + h * 0.012) * turn, shoulderY + wy + h * 0.012);
  }

  // Legs.
  for (const side of [1, -1] as const) {
    const knee = side === 1 ? POSE.LEFT_KNEE : POSE.RIGHT_KNEE;
    const ankle = side === 1 ? POSE.LEFT_ANKLE : POSE.RIGHT_ANKLE;
    const heel = side === 1 ? POSE.LEFT_HEEL : POSE.RIGHT_HEEL;
    const toe = side === 1 ? POSE.LEFT_FOOT_INDEX : POSE.RIGHT_FOOT_INDEX;
    const root = cx + side * hipHalf * turn;
    set(knee, root, hipY + h * 0.25);
    set(ankle, root, ground - h * 0.03);
    set(heel, root - side * h * 0.012 * turn, ground);
    set(toe, root + side * h * 0.03 * turn, ground - h * 0.008);
  }

  for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
    if (!lms[i]) set(i, cx, hipY);
  }

  // ---- ANISOTROPY, LAST. See the header. ----
  for (const l of lms) l.x = cx + (l.x - cx) / aspect;

  return { landmarks: lms, worldLandmarks: lms };
}

export interface NoiseSpec {
  /**
   * Per-landmark positional sigma, in normalised units OF FRAME HEIGHT.
   * REALISTIC is 0.004.
   */
  noise?: number;
  /** Per-frame chance a wrist drops below the visibility threshold. */
  dropout?: number;
  /** Multiplies every landmark's visibility — a room whose lighting changes. */
  lightingDip?: number;
  aspect?: number;
}

/**
 * A NEW pose with camera ugliness applied. Never mutates its input.
 *
 * ISOTROPIC IN PIXELS, matching `simulator.roughen`. A sensor's landmark
 * jitter is roughly the same number of PIXELS on both axes, and landmark x is
 * normalised by frame WIDTH, so the same pixel error is a SMALLER number in x
 * than in y by exactly the aspect ratio. Adding the same sigma to both is a
 * camera whose horizontal noise is 1.78x its vertical noise, and no such
 * camera exists.
 */
export function roughen(pose: RawPose, spec: NoiseSpec, r: () => number): RawPose {
  const n = spec.noise ?? 0;
  const nx = n / (spec.aspect ?? SCENE_ASPECT);
  const drop = spec.dropout ?? 0;
  const dip = spec.lightingDip ?? 0;
  const lms = pose.landmarks.map((l) => ({
    x: l.x + (n > 0 ? gauss(r) * nx : 0),
    y: l.y + (n > 0 ? gauss(r) * n : 0),
    z: l.z,
    visibility: dip > 0 ? l.visibility * (1 - dip) : l.visibility,
  }));
  if (drop > 0) {
    for (const idx of [POSE.LEFT_WRIST, POSE.RIGHT_WRIST, POSE.LEFT_INDEX, POSE.RIGHT_INDEX]) {
      if (r() < drop) lms[idx]!.visibility = 0.1;
    }
  }
  return { landmarks: lms, worldLandmarks: lms };
}

/** Matches `simulator.REALISTIC` — a plausible 3m webcam. */
export const REALISTIC_NOISE: NoiseSpec = { noise: 0.004, dropout: 0.03 };
/** Matches `simulator.HOSTILE` — the stall on a bad day. */
export const HOSTILE_NOISE: NoiseSpec = { noise: 0.007, dropout: 0.06, lightingDip: 0.35 };

/** p-th percentile of a sample, 0..1. Sorts a copy. */
export function pct(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
  return s[i]!;
}

/** p10/p50/p90/p99 plus the extreme, which is the number that ships. */
export function spread(values: readonly number[]): {
  p10: number; p50: number; p90: number; p99: number; max: number;
} {
  return {
    p10: pct(values, 0.1),
    p50: pct(values, 0.5),
    p90: pct(values, 0.9),
    p99: pct(values, 0.99),
    max: Math.max(...values),
  };
}
