/**
 * Multi-person identity persistence.
 *
 * PLAN.md §2: "MediaPipe's multi-pose output gives you N skeletons per frame
 * with no stable IDs between frames. For any 2P game, player 1 and player 2
 * will swap the moment they cross."
 *
 * MediaPipe hands us an unordered array each frame. Index 0 is not the same
 * human it was last frame. This module:
 *   - matches detections to existing tracks by centroid proximity
 *   - keeps a track alive briefly through occlusion and dropout
 *   - rejects the crowd by locking onto the largest (= nearest) N bodies
 *   - computes per-body scale so thresholds are body-relative, not pixels
 *   - runs a dedicated One Euro filter per track
 */

import { LandmarkFilter, type FilterPreset } from './filter';
import { POSE, POSE_LANDMARK_COUNT, type Landmark, type RawPose } from './types';

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

export interface TrackedPlayer {
  /** Stable for the lifetime of this human being in frame. */
  id: number;
  /**
   * Screen-ordered slot: 0 is leftmost as the player sees themselves on the TV.
   * This is what 2P split-screen games index by.
   */
  slot: number;
  /** One Euro filtered landmarks. Use these for everything. */
  landmarks: Landmark[];
  /** Unfiltered, for velocity work that needs raw signal (Red Light). */
  raw: Landmark[];
  centroid: { x: number; y: number };
  /** Bounding-box area — our proxy for "how close to the camera". */
  area: number;
  scale: BodyScale;
  /** Mean visibility of torso landmarks. */
  confidence: number;
  /** Frames this track has existed. */
  age: number;
  /** Consecutive frames without a matching detection. */
  missing: number;
  /** True once the track has survived long enough to be trusted. */
  confirmed: boolean;
}

export interface TrackerOptions {
  /** How many people we care about. 1 for solo, 2 for duels, 6 for Red Light. */
  maxPlayers: number;
  /** Frames a track must survive before games see it. Kills detection flicker. */
  minAgeToConfirm: number;
  /** Frames a track survives unmatched before deletion. ~0.5s at 30fps. */
  maxMissingFrames: number;
  /**
   * Max centroid movement (normalised units) that still counts as the same
   * person. Too high and two crossing players swap; too low and anyone moving
   * fast gets a new identity mid-run.
   */
  matchRadius: number;
  /** Ignore detections smaller than this bbox area — background bystanders. */
  minArea: number;
  /** Display is mirrored, so slot ordering has to be flipped to match. */
  mirrored: boolean;
  filterPreset: FilterPreset;
  /**
   * Camera aspect ratio (width / height).
   *
   * MediaPipe normalises x by frame WIDTH and y by frame HEIGHT, so on any
   * non-square frame the landmark space is ANISOTROPIC: 0.1 in x is 1.78x the
   * physical length of 0.1 in y at 16:9. A Euclidean distance computed across
   * both axes in that space is not a distance, and every body measurement here
   * is exactly such a distance.
   *
   * Consequences before this was fixed:
   *   - shoulder width (nearly all horizontal) was under-reported by ~1.78x
   *     relative to torso height (nearly all vertical), so the two were not
   *     comparable even though the code used one as a fallback for the other
   *   - `scale.unit` drifted as a player TURNED, because rotation moves length
   *     between the two axes — and the entire purpose of the unit is to be
   *     invariant to everything except body size
   *
   * Set from `camera.getState()`. 16:9 is the overwhelmingly common webcam
   * default and a safe fallback.
   */
  aspect: number;
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  maxPlayers: 1,
  minAgeToConfirm: 3,
  maxMissingFrames: 15,
  matchRadius: 0.25,
  minArea: 0.02,
  mirrored: true,
  filterPreset: 'body',
  aspect: 16 / 9,
};

interface InternalTrack extends TrackedPlayer {
  filter: LandmarkFilter;
}

const TORSO = [
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
function dist(ax: number, ay: number, bx: number, by: number, aspect: number): number {
  const dx = (ax - bx) * aspect;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function midpoint(a: Landmark | undefined, b: Landmark | undefined): { x: number; y: number } | null {
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Torso centroid — far more stable than a whole-skeleton mean, which swings
 *  wildly whenever an arm or leg drops out of frame. */
function computeCentroid(lms: Landmark[]): { x: number; y: number } {
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

function computeArea(lms: Landmark[]): number {
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

function computeScale(lms: Landmark[], aspect: number): BodyScale {
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

function computeConfidence(lms: Landmark[]): number {
  let sum = 0;
  for (const idx of TORSO) sum += lms[idx]?.visibility ?? 0;
  return sum / TORSO.length;
}

export class PoseTracker {
  private tracks: InternalTrack[] = [];
  private nextId = 1;
  private opts: TrackerOptions;

  constructor(options: Partial<TrackerOptions> = {}) {
    this.opts = { ...DEFAULT_TRACKER_OPTIONS, ...options };
  }

  setOptions(patch: Partial<TrackerOptions>): void {
    this.opts = { ...this.opts, ...patch };
  }

  getOptions(): Readonly<TrackerOptions> {
    return this.opts;
  }

  /** Wipe all identities. Call between rounds so a new player starts clean. */
  reset(): void {
    this.tracks = [];
  }

  /**
   * @param poses raw detections for this frame
   * @param t     timestamp in SECONDS (One Euro wants seconds)
   */
  update(poses: readonly RawPose[], t: number): TrackedPlayer[] {
    // 1. Reject anything too small to be a player standing in the zone. This is
    //    the crowd-rejection mechanism from PLAN.md §9 — people queueing behind
    //    the player are further away, therefore smaller.
    const candidates = poses
      .map((p) => ({
        pose: p,
        centroid: computeCentroid(p.landmarks),
        area: computeArea(p.landmarks),
      }))
      .filter((c) => c.area >= this.opts.minArea);

    // 2. Keep only the largest N — nearest to camera wins.
    candidates.sort((a, b) => b.area - a.area);
    const chosen = candidates.slice(0, this.opts.maxPlayers);

    // 3. Greedy nearest-centroid matching. O(n*m), and n,m <= 6 here, so the
    //    Hungarian algorithm would be ceremony for no gain.
    const unmatchedTracks = new Set(this.tracks);
    const used = new Set<number>();

    interface Pair {
      track: InternalTrack;
      idx: number;
      d: number;
    }
    const pairs: Pair[] = [];

    for (const track of this.tracks) {
      for (let i = 0; i < chosen.length; i++) {
        const c = chosen[i]!;
        const d = dist(
          track.centroid.x, track.centroid.y,
          c.centroid.x, c.centroid.y,
          this.opts.aspect
        );
        if (d <= this.opts.matchRadius) pairs.push({ track, idx: i, d });
      }
    }
    pairs.sort((a, b) => a.d - b.d);

    for (const pair of pairs) {
      if (!unmatchedTracks.has(pair.track) || used.has(pair.idx)) continue;
      unmatchedTracks.delete(pair.track);
      used.add(pair.idx);
      this.updateTrack(pair.track, chosen[pair.idx]!, t);
    }

    // 4. Unmatched detections become new tracks, if we have room.
    for (let i = 0; i < chosen.length; i++) {
      if (used.has(i)) continue;
      if (this.tracks.length >= this.opts.maxPlayers) continue;
      this.tracks.push(this.createTrack(chosen[i]!, t));
    }

    // 5. Age out tracks that didn't match. Keeping them alive briefly is what
    //    lets someone survive a moment of occlusion without losing their run.
    for (const track of unmatchedTracks) {
      track.missing++;
      track.age++;
    }
    this.tracks = this.tracks.filter((tr) => tr.missing <= this.opts.maxMissingFrames);

    // 6. Assign screen-ordered slots. Only confirmed tracks get a slot so a
    //    flickering false positive can't shunt player 1 into player 2's half.
    const confirmed = this.tracks.filter((tr) => tr.confirmed && tr.missing === 0);
    confirmed.sort((a, b) =>
      this.opts.mirrored ? b.centroid.x - a.centroid.x : a.centroid.x - b.centroid.x
    );
    confirmed.forEach((tr, i) => {
      tr.slot = i;
    });

    return this.tracks.filter((tr) => tr.confirmed);
  }

  private createTrack(
    c: { pose: RawPose; centroid: { x: number; y: number }; area: number },
    t: number
  ): InternalTrack {
    const filter = new LandmarkFilter(POSE_LANDMARK_COUNT, this.opts.filterPreset);
    const landmarks: Landmark[] = [];
    filter.apply(c.pose.landmarks, t, landmarks);

    return {
      id: this.nextId++,
      slot: -1,
      landmarks,
      raw: c.pose.landmarks,
      centroid: c.centroid,
      area: c.area,
      scale: computeScale(c.pose.landmarks, this.opts.aspect),
      confidence: computeConfidence(c.pose.landmarks),
      age: 1,
      missing: 0,
      confirmed: this.opts.minAgeToConfirm <= 1,
      filter,
    };
  }

  private updateTrack(
    track: InternalTrack,
    c: { pose: RawPose; centroid: { x: number; y: number }; area: number },
    t: number
  ): void {
    track.raw = c.pose.landmarks;
    track.filter.apply(c.pose.landmarks, t, track.landmarks);
    track.centroid = c.centroid;
    track.area = c.area;
    track.scale = computeScale(track.landmarks, this.opts.aspect);
    track.confidence = computeConfidence(c.pose.landmarks);
    track.age++;
    track.missing = 0;
    if (track.age >= this.opts.minAgeToConfirm) track.confirmed = true;
  }

  /** All confirmed players, screen-ordered. */
  getPlayers(): TrackedPlayer[] {
    return this.tracks.filter((tr) => tr.confirmed);
  }

  /** The nearest/largest player. What every solo game uses. */
  getPrimary(): TrackedPlayer | null {
    const players = this.getPlayers();
    if (players.length === 0) return null;
    let best = players[0]!;
    for (const p of players) if (p.area > best.area) best = p;
    return best;
  }

  /** The player occupying a given split-screen half. */
  getBySlot(slot: number): TrackedPlayer | null {
    return this.getPlayers().find((p) => p.slot === slot) ?? null;
  }
}
