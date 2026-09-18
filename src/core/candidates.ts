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

/**
 * Visibility below which a landmark is MediaPipe guessing rather than seeing.
 *
 * MediaPipe always returns all 33 landmarks — an occluded hip is not omitted,
 * it is extrapolated and shipped with a low visibility score. Anything that
 * treats those coordinates as an observation is reading a guess.
 */
export const VISIBLE = 0.3;

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
   * True when `unit` came from landmarks MediaPipe actually SAW.
   *
   * `valid` only says the number is big enough to divide by. `reliable` says
   * it is worth believing: both shoulders and at least one hip above `VISIBLE`,
   * and a torso height rather than the shoulder-width fallback.
   *
   * WHY THIS EXISTS. Every gesture threshold in every game is divided by
   * `unit`, so a bad reading does not break one thing, it moves all of them at
   * once — which is what "tracking is a bit wonky" sounds like from the other
   * side of the camera. The two ways a reading goes bad are both silent:
   *
   *   - the hips are occluded (a table, a queue, the player's own arms) and
   *     MediaPipe guesses them somewhere up near the waist. MEASURED on a
   *     synthetic body with the hips guessed 88% of the way to the shoulders:
   *     `unit` reads 0.089 instead of 0.262, a 66% collapse, and every
   *     threshold in the app triples.
   *   - the hips are gone entirely, so `unit` falls back to shoulder width —
   *     which collapses with cos(yaw). MEASURED: at 70 degrees of turn the
   *     fallback under-reads by 2.6x, at 85 degrees by 10.2x.
   *
   * Nothing downstream can tell either case from a player who genuinely
   * stepped closer. `PoseTracker` uses this flag to HOLD the last believable
   * unit instead, which took the worst error over a hips-lost episode from
   * 84% to 3.8%.
   */
  reliable: boolean;
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
    if (lm && lm.visibility > VISIBLE) {
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
    if (lm.visibility < VISIBLE) continue;
    any = true;
    if (lm.x < minX) minX = lm.x;
    if (lm.x > maxX) maxX = lm.x;
    if (lm.y < minY) minY = lm.y;
    if (lm.y > maxY) maxY = lm.y;
  }
  return any ? (maxX - minX) * (maxY - minY) : 0;
}

/**
 * Torso height divided by shoulder width for a body facing the camera.
 *
 * MEASURED on the shared body model (`tests/scene.ts`, whose segment ratios
 * are copied from `simulator.buildSkeleton`, which in turn matches standard
 * anthropometry): torsoHeight 0.2617, shoulderWidth 0.2094, ratio 1.250.
 * Published adult figures put biacromial breadth at 0.22-0.245 of stature and
 * acromion-to-hip-joint at 0.28-0.29, i.e. 1.18-1.27 — so 1.25 sits inside the
 * real spread and the previous 1.4 sat 12% outside it.
 *
 * This is a LAST RESORT and it is only approximately right for any particular
 * person. It also collapses with cos(yaw). `reliable` exists so the tracker
 * knows not to trust a unit that came from here.
 */
const SHOULDER_TO_TORSO = 1.25;

/** The lower bound on a usable body unit. Below this, nothing is divisible. */
const MIN_UNIT = 0.04;

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
  if (unit < MIN_UNIT) unit = shoulderWidth * SHOULDER_TO_TORSO;

  // The GEOMETRY above is deliberately unchanged: MediaPipe's extrapolated
  // hips are usually roughly right and throwing them away would be worse than
  // using them. What is new is saying out loud when they were a guess, so a
  // consumer that cannot afford a wrong answer can hold its last good one.
  const seen = (lm: Landmark | undefined): boolean => !!lm && lm.visibility > VISIBLE;
  const reliable =
    torsoHeight >= MIN_UNIT && seen(ls) && seen(rs) && (seen(lh) || seen(rh));

  return {
    shoulderWidth,
    torsoHeight,
    unit,
    valid: unit > MIN_UNIT,
    reliable,
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
  /** See `BodyScale.reliable` — whether `unit` is worth comparing against. */
  reliable: boolean;
  confidence: number;
  /** True when this detection sits on a body the tracker already knows. */
  anchored: boolean;
}

/**
 * A body the caller is already tracking, and how far it may plausibly have
 * moved since the last frame.
 *
 * `r` is in the isotropic units `dist()` returns (fractions of frame HEIGHT),
 * because only the tracker knows how long it has been blind and how big the
 * body is. Selection just does the geometry.
 */
export interface KeepAnchor {
  x: number;
  y: number;
  r: number;
}

/**
 * Where a player is allowed to stand, bounding the TORSO CENTROID in normalised
 * frame coordinates.
 *
 * THIS IS A LATERAL GATE. USE `minUnit` FOR DEPTH.
 *
 * The obvious idea is floor tape: bound y, because someone further away stands
 * higher in frame. It does not work, and it is worth knowing why before
 * somebody tries it at the stall. A camera on a tripod sits at about chest
 * height, and a standing adult's torso centre is also at about chest height —
 * so the torso centroid sits almost exactly ON the lens axis and barely moves
 * with distance at all. MEASURED, camera at 1.1m, person 1.7m:
 *
 *   distance      2.0m    2.4m    3.0m    4.0m    5.0m    7.0m
 *   feet y       1.217   1.084   0.950   0.814   0.732   0.637
 *   centroid y   0.392   0.397   0.400   0.402   0.402   0.402
 *   scale.unit   0.393   0.327   0.262   0.196   0.157   0.112
 *
 * The centroid spans 0.010 across the whole room and is not even monotone — it
 * turns around at about 4.5m. A y band tight enough to mean anything is
 * narrower than the landmark noise, and one loose enough to be safe excludes
 * nobody. `scale.unit` spans 3.5x over the same range and is rotation-stable,
 * so DEPTH belongs to `minUnit` (absolute: "no further than the tape") and
 * `minRelativeSize` (relative: "not far behind whoever is nearest").
 *
 * What the zone is genuinely good for is the other axis: somebody leaning in
 * from the SIDE of frame, whom no size test can reject because MediaPipe
 * reports them at full size.
 *
 * Whole frame by default. The marshal narrows it in the actual room, which is
 * the only place it can be set correctly.
 */
export interface PlayZone {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export const FULL_FRAME_ZONE: PlayZone = { x0: -0.5, x1: 1.5, y0: -0.5, y1: 1.5 };

/** See `SelectOptions.minUnit`. Shared so every caller gates identically. */
export const DEFAULT_MIN_UNIT = 0.085;

function inZone(c: { x: number; y: number }, z: PlayZone): boolean {
  return c.x >= z.x0 && c.x <= z.x1 && c.y >= z.y0 && c.y <= z.y1;
}

export interface SelectOptions {
  maxPlayers: number;
  minArea: number;
  /**
   * Torso size, in frame heights, that admits a body the AREA gate rejected.
   *
   * `minArea` is documented as a distance filter and it is not one. A bounding
   * box spans every visible landmark, so it shrinks with ORIENTATION and with
   * arms held in, not only with distance. MEASURED on one body at a fixed 3m,
   * turning on the spot:
   *
   *   yaw      0     50     70     75     78     80     85
   *   area   .121   .078   .041   .031   .025   .021   .011
   *   unit   .262   .262   .262   .262   .262   .262   .262
   *
   * Past about 80 degrees the player was rejected OUTRIGHT — no reps, no lane,
   * nothing on screen to say why — while standing in exactly the same place.
   * Reported from the games track; the complaint it explains is "they had to
   * 67 at a certain angle".
   *
   * `unit` is torso height and is invariant to yaw to four decimal places, so
   * it is the honest answer to "how near is this person". 0.085 is the
   * rotation-stable equivalent of `minArea` 0.02: area goes as 1/d^2 and unit
   * as 1/d, so the crossover distance is the same one — about 8m, which is
   * past the back wall of any room this runs in.
   *
   * THE READING MUST BE RELIABLE. Admitting on torso size alone would
   * otherwise let in the one body the area gate was genuinely catching: a
   * person leaning in from the SIDE of frame. MediaPipe extrapolates the
   * landmarks it cannot see rather than omitting them, so a body whose torso
   * is mostly outside the frame still reports a full-size `unit` — MEASURED,
   * a body centred at x = -0.05 reports area 0.011 and unit 0.262, i.e. a
   * confident full-size torso that is not in the room. `reliable` is false
   * there and true at every yaw above, so it separates the two cases exactly.
   *
   * IT IS AN OR WITH `minArea`, SO IT ONLY EVER ADMITS. That is deliberate —
   * its job is to save a body the area gate wrongly rejected — but it means it
   * is not a depth limit on its own. A marshal moving the play area's back
   * line has to raise BOTH: `minArea` to the box a body on the tape reads, and
   * `minUnit` to the torso it reads. Then the pair means "no further than the
   * tape, whichever way you are facing".
   *
   * 0 disables, leaving the area gate alone.
   *
   * OPTIONAL, unlike its siblings, purely so that adding it did not break the
   * one other caller (`shell/debug.ts`, which is not this track's file). It
   * defaults to the value the tracker uses, so the debug readout keeps showing
   * the same number of people the tracker sees — which is the entire point of
   * that readout.
   */
  minUnit?: number;
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
  /**
   * Bodies the caller is already tracking. Detections landing on one of these
   * are EXEMPT from the relative-size gate and the zone, and are kept ahead of
   * strangers when the list is cut to `maxPlayers`.
   *
   * WHY. `maxPlayers` is 1 for every solo game and every shell screen, so this
   * function returns exactly one body and the tracker matches its one track
   * against it. Ranking put the biggest BOUNDING BOX first, and a stranger
   * walking behind the player with their arms swinging has a bigger bounding
   * box than the player standing still — MEASURED: a 3m player with their arms
   * down has bbox area 0.141, a 4m walker with their arms out has 0.213, 51%
   * more, and the walker still wins out to 4.7m. So the single body handed to
   * the tracker was the STRANGER, and the player's own detection was discarded
   * before matching could see it. The player's track then either aged out and
   * died — new id, new lane, score gone — or, worse, matched the stranger
   * inside the old 0.25 radius and carried on silently as them.
   *
   * With this list the player's detection cannot be dropped in favour of a
   * transient, whatever shape they are making.
   */
  keep?: readonly KeepAnchor[];
  /** Where a body must be standing to count. Defaults to the whole frame. */
  zone?: PlayZone;
}

/**
 * Raw detections in, distinct people out — NEAREST first.
 *
 * Gates, in order:
 *   1. SIZE. Someone queueing behind the player is further away and therefore
 *      smaller — by bounding box, or by torso if turning has collapsed the box
 *      while the person stayed put. See `minUnit`.
 *   2. CONFIDENCE. MediaPipe fills an unmet pose quota with poorly-visible
 *      extras that are otherwise complete, plausible skeletons.
 *   3. OVERLAP. Several detections of ONE body collapse to the largest.
 *   4. RELATIVE SIZE. A body far smaller than the nearest one is a spectator.
 *   5. ZONE. A body standing outside the play area is not playing.
 * Bodies named in `opts.keep` skip 4 and 5 — see the note there.
 *
 * "NEAREST" IS TORSO SIZE, NOT BOUNDING-BOX AREA. The bounding box spans every
 * visible landmark, so it doubles when a player raises their arms and halves
 * when they put them down: MEASURED on one body at a fixed 3m, bbox area runs
 * 0.121 with the arms down and 0.378 with them out, a 3.1x swing, while the
 * torso unit holds at 0.262 to four decimal places. Ordering by area therefore
 * ranked people by what they were DOING rather than where they were standing,
 * and handed first place — the one slot a 1P game gets — to whoever happened
 * to be waving. Torso size is monotone in distance and nothing else.
 */
export function selectCandidates(poses: readonly RawPose[], opts: SelectOptions): Candidate[] {
  const zone = opts.zone ?? FULL_FRAME_ZONE;
  const keep = opts.keep ?? [];
  const minUnit = opts.minUnit ?? DEFAULT_MIN_UNIT;

  const candidates: Candidate[] = poses
    .map((pose) => {
      const centroid = computeCentroid(pose.landmarks);
      const scale = computeScale(pose.landmarks, opts.aspect);
      return {
        pose,
        centroid,
        area: computeArea(pose.landmarks),
        unit: scale.unit,
        reliable: scale.reliable,
        confidence: computeConfidence(pose.landmarks),
        anchored: keep.some(
          (k) => dist(k.x, k.y, centroid.x, centroid.y, opts.aspect) <= k.r
        ),
      };
    })
    .filter(
      (c) =>
        (c.area >= opts.minArea || (c.reliable && minUnit > 0 && c.unit >= minUnit)) &&
        c.confidence >= opts.minConfidence
    );

  candidates.sort((a, b) => b.unit - a.unit);

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
  // largest TORSO — which is the body actually nearest the camera, whatever
  // shape anyone is making with their arms.
  const nearest = distinct[0];
  const floor = nearest && opts.minRelativeSize > 0 ? nearest.unit * opts.minRelativeSize : 0;
  const present = distinct.filter(
    (c) => c.anchored || ((floor === 0 || c.unit >= floor) && inZone(c.centroid, zone))
  );

  // Known bodies first, so cutting the list to `maxPlayers` can never discard
  // the person we are already playing with in favour of somebody passing.
  present.sort((a, b) => Number(b.anchored) - Number(a.anchored) || b.unit - a.unit);

  return present.slice(0, opts.maxPlayers);
}
