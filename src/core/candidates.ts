/**
 * Turning raw MediaPipe detections into "how many PEOPLE are in front of the
 * camera", and nothing else.
 *
 * Split out of tracker.ts so it can be tested in Node directly: tracker.ts
 * pulls in the One Euro filter and a chain of extensionless imports that the
 * Node ESM resolver will not follow, which meant the one piece of logic most
 * in need of a test was the one piece that could not have one.
 *
 * It needed one. Asked for six poses, MediaPipe returns overlapping skeletons
 * for a single body to fill the quota, and nothing here rejected them — so the
 * six-player game read one person as four, gave them four lanes and eliminated
 * them four times. The simulator emits exactly as many clean, separated bodies
 * as it is told to, so it can never produce that input.
 *
 * Imports are written with explicit .ts extensions for the same reason.
 */

import { POSE } from './types.ts';
import type { Landmark, RawPose } from './types.ts';

export interface BodyScale {
  /** Shoulder-to-shoulder distance in normalised frame units. */
  shoulderWidth: number;
  /** Shoulder-centre to hip-centre distance. More rotation-stable than width. */
  torsoHeight: number;
  /**
   * The canonical "one body unit" every gesture threshold is expressed in.
   *
   * PLAN.md §2: "A 5'2" player and a 6'4" player produce wildly different pixel
   * deltas for the same jump." A threshold of 0.25 means "a quarter of a torso",
   * which means the same thing for both of them.
   */
  unit: number;
  valid: boolean;
  /**
   * The aspect ratio these measurements were taken in.
   *
   * Carried on the scale so that ANY consumer measuring a horizontal landmark
   * distance can correct it the same way the tracker did. Without it, code
   * outside this file divides a raw normalised-x difference by an
   * aspect-corrected width and gets a ratio that is wrong by exactly the
   * aspect — which is a subtler bug than the original, because both halves
   * look individually reasonable.
   */
  aspect: number;
}

export const TORSO = [
  POSE.LEFT_SHOULDER,
  POSE.RIGHT_SHOULDER,
  POSE.LEFT_HIP,
  POSE.RIGHT_HIP,
] as const;

/**
 * Distance in ISOTROPIC units.
 *
 * Landmark x is normalised by frame width and y by frame height, so x must be
 * scaled by the aspect ratio before the two can be combined. The result is in
 * "fractions of frame height", which is also the unit the renderer thinks in.
 */
export function dist(ax: number, ay: number, bx: number, by: number, aspect: number): number {
  const dx = (ax - bx) * aspect;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

export function midpoint(a: Landmark | undefined, b: Landmark | undefined): { x: number; y: number } | null {
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Torso centroid — far more stable than a whole-skeleton mean, which swings
 *  wildly whenever an arm or leg drops out of frame. */
export function computeCentroid(lms: Landmark[]): { x: number; y: number } {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const idx of TORSO) {
    const lm = lms[idx];
    if (lm && lm.visibility > 0.3) {
      sx += lm.x;
      sy += lm.y;
      n++;
    }
  }
  if (n === 0) return { x: 0.5, y: 0.5 };
  return { x: sx / n, y: sy / n };
}

export function computeArea(lms: Landmark[]): number {
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  let any = false;
  for (const lm of lms) {
    if (lm.visibility < 0.3) continue;
    any = true;
    if (lm.x < minX) minX = lm.x;
    if (lm.x > maxX) maxX = lm.x;
    if (lm.y < minY) minY = lm.y;
    if (lm.y > maxY) maxY = lm.y;
  }
  return any ? (maxX - minX) * (maxY - minY) : 0;
}

export function computeScale(lms: Landmark[], aspect: number): BodyScale {
  const ls = lms[POSE.LEFT_SHOULDER];
  const rs = lms[POSE.RIGHT_SHOULDER];
  const lh = lms[POSE.LEFT_HIP];
  const rh = lms[POSE.RIGHT_HIP];

  const shoulderWidth = ls && rs ? dist(ls.x, ls.y, rs.x, rs.y, aspect) : 0;

  const shoulderMid = midpoint(ls, rs);
  const hipMid = midpoint(lh, rh);
  const torsoHeight =
    shoulderMid && hipMid
      ? dist(shoulderMid.x, shoulderMid.y, hipMid.x, hipMid.y, aspect)
      : 0;

  // Torso height is the preferred unit: it barely changes when someone turns,
  // whereas shoulder width collapses toward zero in profile. Fall back to a
  // scaled shoulder width only when hips aren't visible (seated, cropped frame).
  let unit = torsoHeight;
  if (unit < 0.04) unit = shoulderWidth * 1.4;

  return {
    shoulderWidth,
    torsoHeight,
    unit,
    valid: unit > 0.04,
    aspect,
  };
}

export function computeConfidence(lms: Landmark[]): number {
  let sum = 0;
  for (const idx of TORSO) sum += lms[idx]?.visibility ?? 0;
  return sum / TORSO.length;
}


export interface Candidate {
  pose: RawPose;
  centroid: { x: number; y: number };
  area: number;
  unit: number;
  confidence: number;
}

export interface SelectOptions {
  maxPlayers: number;
  minArea: number;
  minConfidence: number;
  dedupeTorsos: number;
  aspect: number;
  /**
   * A body smaller than this FRACTION of the nearest body is a bystander, not
   * a player. 0 disables the check.
   *
   * Red Light is the case: it takes the six largest bodies, and a spectator
   * standing behind the play area is still a complete, confident, perfectly
   * valid detection. Two players plus three people watching is five racers,
   * three of whom get eliminated for shifting their weight.
   *
   * BE HONEST ABOUT WHAT THIS CAN AND CANNOT DO. Apparent size is inverse to
   * distance, so the ratio between a player at 3m and an onlooker at 6m is
   * 0.5 — but a spectator at 4.5m is 0.67, and TWO REAL PLAYERS at 3m and 4m
   * are 0.75. Those ranges overlap. A threshold high enough to reliably reject
   * the queue will also reject a genuine player standing a step back, which is
   * the worse failure: an onlooker getting a lane is funny, a player being
   * ignored is the game appearing broken.
   *
   * So the default only catches people who are CLEARLY further away, and the
   * real fix on the night is floor tape plus `tracker.minArea` tuned in the
   * actual room. This is a second line of defence, not a substitute for one.
   */
  minRelativeSize: number;
}

/**
 * Raw detections in, distinct people out — largest first.
 *
 * Three gates, in order:
 *   1. AREA. Crowd rejection: someone queueing behind the player is further
 *      away and therefore smaller.
 *   2. CONFIDENCE. MediaPipe fills an unmet pose quota with poorly-visible
 *      extras that are otherwise complete, plausible skeletons.
 *   3. OVERLAP. Several detections of ONE body collapse to the largest.
 */
export function selectCandidates(poses: readonly RawPose[], opts: SelectOptions): Candidate[] {
  const candidates: Candidate[] = poses
    .map((pose) => ({
      pose,
      centroid: computeCentroid(pose.landmarks),
      area: computeArea(pose.landmarks),
      unit: computeScale(pose.landmarks, opts.aspect).unit,
      confidence: computeConfidence(pose.landmarks),
    }))
    .filter((c) => c.area >= opts.minArea && c.confidence >= opts.minConfidence);

  candidates.sort((a, b) => b.area - a.area);

  const distinct: Candidate[] = [];
  for (const c of candidates) {
    const duplicate = distinct.some((kept) => {
      // The larger body's unit, so a ghost drawn slightly small cannot shrink
      // the exclusion zone around the person it is sitting on.
      const unit = Math.max(kept.unit, c.unit, 0.02);
      const d = dist(kept.centroid.x, kept.centroid.y, c.centroid.x, c.centroid.y, opts.aspect);
      return d < unit * opts.dedupeTorsos;
    });
    if (!duplicate) distinct.push(c);
  }

  // Relative-size gate, against the NEAREST body. Runs after dedupe so a ghost
  // cannot set the reference, and after the sort so `distinct[0]` is the
  // largest.
  const nearest = distinct[0];
  const floor = nearest && opts.minRelativeSize > 0 ? nearest.unit * opts.minRelativeSize : 0;
  const present = floor > 0 ? distinct.filter((c) => c.unit >= floor) : distinct;

  return present.slice(0, opts.maxPlayers);
}
