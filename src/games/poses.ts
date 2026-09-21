/**
 * POSE MATCH — pose library and similarity scoring.
 *
 * PLAN.md §3 (Pose Match / Hole in the Wall):
 *   "Detection: cosine similarity on scale- and rotation-normalised landmark
 *    vectors, joint-angle weighted so limb position matters more than absolute
 *    position."
 *   "The pose LIBRARY is the real work. Generate poses procedurally from
 *    joint-angle constraints rather than hand-authoring them, then hand-pick
 *    the funniest."
 *
 * Three halves, in dependency order:
 *
 *   1. The metric. `poseSimilarity()` scores a live body against a set of joint
 *      angles, 0..1.
 *
 *   2. The generator. `generatePoses()` enumerates the legal pose space from
 *      the constraint sets, rejecting anything unachievable, anything too close
 *      to standing still, and anything CONFUSABLE WITH A POSE ALREADY IN THE
 *      SET under the metric itself. `POSES` is the hand-picked nineteen out of
 *      that space, with names, because the names are half the comedy.
 *
 *   3. The renderer. `drawPoseSilhouette()` draws the same joint angles as the
 *      hole in the wall. Metric and silhouette read one representation, so the
 *      shape a player is shown is by construction the shape they are scored
 *      against, and the two cannot drift apart.
 *
 * ---------------------------------------------------------------------------
 * ANGLE CONVENTION — read this before touching anything below
 * ---------------------------------------------------------------------------
 *
 * The body frame matches MediaPipe camera space: +x is toward the SUBJECT'S
 * OWN LEFT (MediaPipe's LEFT_* landmarks have the larger x), and +y is DOWN.
 *
 * Every joint value is the ABSOLUTE DIRECTION, in degrees, of the segment
 * distal to that joint, measured from straight-down and rotating OUTWARD
 * (away from the midline, on that limb's own side):
 *
 *        0° = straight down          90° = straight out to that side
 *      180° = straight up          negative = inward, across the body
 *
 *   dir(side, θ) = { x: side · sin θ, y: cos θ }        side = +1 L, -1 R
 *
 * Absolute rather than parent-relative because that is what the scorer needs:
 * a player's measured limb direction is a camera-space vector, and comparing it
 * to a camera-space target vector is one dot product with nothing to get subtly
 * backwards. The anatomical (parent-relative) elbow and knee angles are
 * recovered by subtraction — see `flexOf()` — and the achievability constraints
 * are written in terms of those.
 *
 * `lean` is the one exception: it is the torso's tilt from vertical, positive
 * toward the subject's left. It moves the limb ROOTS when drawing, but does not
 * rotate the limb angles, which stay absolute.
 */

// EXPLICIT `.ts` EXTENSIONS, like `core/`, so this module is importable by
// `node --test` as well as by Vite.
//
// The library's guarantees — no pose confusable with another, none confusable
// with standing still, every pose scoring the same through a left/right label
// swap — are pure arithmetic over `SEGMENTS`, and they are the kind of thing
// that should be proved in CI rather than only at the stall. `validateLibrary`
// runs at module load and catches the first two; the confusion MARGINS, the
// difficulty ramp and the swap behaviour need a test file, and a test file
// needs to be able to import this one outside a bundler.
import { POSE, POSE_LANDMARK_COUNT, type Landmark } from '../core/types.ts';
import { tunables } from '../meta/tunables.ts';
import type { TrackedPlayer } from '../core/tracker.ts';
import { COLORS } from '../shell/theme.ts';

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ */
/* Representation                                                      */
/* ------------------------------------------------------------------ */

export interface PoseAngles {
  /** Upper-arm direction (shoulder → elbow). */
  shoulderL: number;
  /** Forearm direction (elbow → wrist). */
  elbowL: number;
  shoulderR: number;
  elbowR: number;
  /** Thigh direction (hip → knee). */
  hipL: number;
  /** Shin direction (knee → ankle). */
  kneeL: number;
  hipR: number;
  kneeR: number;
  /** Torso tilt from vertical, positive toward the subject's left. */
  lean: number;
}

export interface PoseDef {
  id: string;
  /** Shown on the wall and in the clear popup. The names are the comedy. */
  name: string;
  angles: PoseAngles;
  /** 0..1, used to pick harder poses as the round ramps. */
  difficulty: number;
}

/** Wrap into (-180, 180]. Elbow angles built by flex routinely overshoot. */
export function wrapDeg(d: number): number {
  const x = (((d + 180) % 360) + 360) % 360 - 180;
  return x <= -180 ? 180 : x;
}

/** Anatomical joint flex: how far the distal segment is bent off the proximal. */
export function flexOf(proximal: number, distal: number): number {
  return wrapDeg(distal - proximal);
}

/* ------------------------------------------------------------------ */
/* The metric                                                          */
/* ------------------------------------------------------------------ */

export type SegmentKey =
  | 'upperArmL' | 'foreArmL' | 'upperArmR' | 'foreArmR'
  | 'thighL' | 'shinL' | 'thighR' | 'shinR'
  | 'torso';

export type SegmentGroup = 'arms' | 'legs' | 'torso';

export interface SegmentSpec {
  key: SegmentKey;
  group: SegmentGroup;
  /** Landmark indices averaged to get the start point. */
  from: readonly number[];
  to: readonly number[];
  /**
   * Weight in the stacked similarity vector. The EFFECTIVE contribution is
   * weight², because the cosine similarity of two vectors whose i-th block is
   * wᵢ·ûᵢ works out to Σwᵢ²(ûᵢ·v̂ᵢ) / Σwᵢ².
   *
   * Arms carry ~64% of the total. That is not a taste call: at a stall the
   * camera frequently cannot see feet at all (PLAN.md §9 lists full-body
   * framing as the critical hardware risk), so anything that leans on legs to
   * decide a pass would behave differently depending on how the laptop lid was
   * angled that morning. Legs are flavour; arms are the game.
   */
  weight: number;
  /** +1 subject-left, -1 subject-right, 0 for the torso. */
  side: 1 | -1 | 0;
  angleOf: (a: PoseAngles) => number;
}

const SHOULDER_MID = [POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER] as const;
const HIP_MID = [POSE.LEFT_HIP, POSE.RIGHT_HIP] as const;

export const SEGMENTS: readonly SegmentSpec[] = [
  { key: 'upperArmL', group: 'arms', from: [POSE.LEFT_SHOULDER], to: [POSE.LEFT_ELBOW], weight: 1.0, side: 1, angleOf: (a) => a.shoulderL },
  { key: 'foreArmL', group: 'arms', from: [POSE.LEFT_ELBOW], to: [POSE.LEFT_WRIST], weight: 0.85, side: 1, angleOf: (a) => a.elbowL },
  { key: 'upperArmR', group: 'arms', from: [POSE.RIGHT_SHOULDER], to: [POSE.RIGHT_ELBOW], weight: 1.0, side: -1, angleOf: (a) => a.shoulderR },
  { key: 'foreArmR', group: 'arms', from: [POSE.RIGHT_ELBOW], to: [POSE.RIGHT_WRIST], weight: 0.85, side: -1, angleOf: (a) => a.elbowR },
  { key: 'thighL', group: 'legs', from: [POSE.LEFT_HIP], to: [POSE.LEFT_KNEE], weight: 0.65, side: 1, angleOf: (a) => a.hipL },
  { key: 'shinL', group: 'legs', from: [POSE.LEFT_KNEE], to: [POSE.LEFT_ANKLE], weight: 0.55, side: 1, angleOf: (a) => a.kneeL },
  { key: 'thighR', group: 'legs', from: [POSE.RIGHT_HIP], to: [POSE.RIGHT_KNEE], weight: 0.65, side: -1, angleOf: (a) => a.hipR },
  { key: 'shinR', group: 'legs', from: [POSE.RIGHT_KNEE], to: [POSE.RIGHT_ANKLE], weight: 0.55, side: -1, angleOf: (a) => a.kneeR },
  { key: 'torso', group: 'torso', from: HIP_MID, to: SHOULDER_MID, weight: 0.7, side: 0, angleOf: (a) => a.lean },
];

/**
 * A limb this far off contributes nothing; everything closer scales linearly
 * between here and a perfect match.
 *
 * This is the generosity dial and it is deliberately wide. At a stall, being
 * let through a wall you half-made feels great, and being rejected on a
 * technicality kills the round — for the player AND for the person next in the
 * queue, who is learning the game from what they see happen.
 */
export const MATCH_TOLERANCE_DEG = 75;
const MATCH_FLOOR = Math.cos(MATCH_TOLERANCE_DEG * DEG);

/**
 * The wall opens at this score.
 *
 * In joint terms: a uniform error of ~37° on EVERY limb still clears. Real
 * misses — an arm down when it should be up, a forearm folded the wrong way —
 * land under 0.35. Every pose in the library is verified to score under 0.66
 * against every other one (see `MAX_CONFUSION`), so the gate is generous
 * without being meaningless: you cannot clear a wall by doing a different pose,
 * and you cannot clear one by standing still.
 *
 * Tuned against the simulator. Re-tune on real bodies at the Sept 22 playtest
 * (PLAN.md §8), where it should be expected to want to go LOWER, not higher.
 */
/**
 * 0.72 -> 0.66.
 *
 * 0.72 left only 0.069 of headroom over the worst confusable pose pair
 * (GOALPOST/FLEX at 0.651) — the tightest safety margin of any constant here,
 * and tuned entirely against a noiseless simulator. Real MediaPipe jitter pulls
 * live scores DOWN, so the error that actually happens at a stall is a correct
 * pose being rejected, not a wrong one being accepted.
 *
 * A player who hit the pose and was told they missed will not try again. A
 * player who scraped through on a sloppy one has a nice time. The asymmetry is
 * not close, so this errs generous — and it is live-tunable if the Sept 22
 * playtest shows walls opening for nothing.
 */
export const PASS_THRESHOLD = 0.66;

/**
 * Live pass threshold — the gate the FIRST wall of a round is judged against.
 *
 * Tuned against a noiseless simulator with only 0.009 headroom over the worst
 * confusable pose pair (GOALPOST/FLEX at 0.651). Real MediaPipe jitter pulls
 * live scores down, so the Sept 22 playtest is expected to want this LOWER —
 * and that has to be possible without a rebuild.
 */
export function passThreshold(): number {
  return tunables.get('posematch.passThreshold', PASS_THRESHOLD);
}

/**
 * The gate the LAST wall of a round is judged against. The difficulty ramp's
 * tolerance axis.
 *
 * THE PROBLEM THIS SOLVES. At 0.66 the wall opens for a player who is 32
 * degrees off on every single joint 94% of the time, and 40 degrees off 75% of
 * the time — measured, not estimated, below. That is the right answer for a
 * stranger's first wall and far too kind for their fifteenth, and it is exactly
 * what the playtester meant by "make the game harder". Time already ramps
 * (WALL_TIME_START -> WALL_TIME_END) and so does pose difficulty; tolerance was
 * the one axis still flat for the whole round.
 *
 * WHY TOLERANCE AND NOT MORE SPEED. MEASURED — seconds from a wall appearing
 * until the score first reaches the gate, for a player who takes 0.35s to
 * react and 0.55s to move, HOSTILE input, 12 poses x 12 reps:
 *
 *                       gate 0.66     gate 0.84
 *   accurate (0 deg)    p99 0.75      p99 0.80
 *   good     (16 deg)   p99 0.75      p99 0.83
 *   rough    (24 deg)   p99 0.78      p99 0.87 (4% never get there)
 *
 * The last wall of a round travels for 1.9s, so time-to-pose is not the binding
 * constraint at either gate and buying difficulty with more speed would only
 * punish reaction time, which is not what this game is about. Tolerance is
 * where the slack actually is.
 *
 * MEASURED — clear rate for a player HOLDING a pose that is `sigma` degrees off
 * on every joint, HOSTILE input, 20 reps x 12 poses = 240 samples per row:
 *
 *   sigma   0.66   0.72   0.78   0.82*  0.84   0.90
 *     8     100    100    100    100    100    100
 *    12     100    100    100    100    100    100
 *    16     100    100    100    100    100     95
 *    20     100    100    100     99     96     78
 *    24     100    100     98     94     90     54
 *    28     100     95     85     77     63     33
 *    32      94     88     73     60     50     20
 *    40      75     58     41     30     21      7
 *                                 (* interpolated)
 *
 * 0.82 is picked off that table. A player who genuinely copies the shape —
 * within about 20 degrees a joint, which is what "I did the pose" looks like —
 * still clears the hardest wall in the round 99% of the time. A player waving
 * roughly in the right direction at 32 degrees drops from 94% to 60%, and one
 * barely in the pose at 40 degrees from 75% to 30%. The thing that gets harder
 * is sloppiness, not the pose.
 *
 * CONFIRMED END TO END, full 60s rounds driven through the real game loop —
 * real pose picks, real travel times, real decaying peak — with the ramp
 * flattened to 0.66 and then left live. Walls cleared out of walls faced:
 *
 *                              ramp flat (before)   ramp live (after)
 *   accurate      (0 deg)          19/19                19/19
 *   a good copy  (22 deg)          19/19                19/19
 *   sloppy       (30 deg)          18/19                14/18
 *   a flail      (45 deg)          12/17                 8/16
 *
 * A round is still a full round for anybody who does the poses, and a round
 * spent waving is now worth about half what it was.
 *
 * It also makes the library's separation guarantee STRICTLY STRONGER as the
 * round goes on: the worst confusable pair sits at 0.651, so headroom over "you
 * cleared by doing a different pose" grows from 0.009 at the first wall to
 * 0.169 at the last. `MAX_CONFUSION` is keyed to the START gate, which is the
 * binding case, and is unchanged.
 *
 * Live-tunable for the same reason the start gate is: if the hall is dark and
 * everybody is scraping through at 70%, the marshal needs to flatten the ramp
 * between plays, not rebuild.
 */
export const PASS_THRESHOLD_END = 0.82;

export function passThresholdEnd(): number {
  return tunables.get('posematch.passThresholdEnd', PASS_THRESHOLD_END);
}

/**
 * The gate for a wall at difficulty `d` (0 = first wall of the round, 1 = last).
 *
 * `Math.max` rather than a straight lerp so that a marshal who drags the START
 * slider above the END one gets a FLAT ramp at the value they chose, not an
 * inverted one where the game gets easier as it goes. Both ends are live
 * sliders and nothing stops them crossing.
 */
export function passThresholdAt(d: number): number {
  const start = passThreshold();
  const end = Math.max(start, passThresholdEnd());
  return start + (end - start) * Math.max(0, Math.min(1, d));
}

/** Below this a landmark is guesswork; ignore the segment rather than fail it. */
const MIN_VISIBILITY = 0.5;

/* ------------------------------------------------------------------ */
/* Left/right label swap                                               */
/* ------------------------------------------------------------------ */

/**
 * LEFT_x <-> RIGHT_x landmark indices; identity for everything on the midline.
 *
 * Derived from POSE rather than listed by hand so a landmark added to the enum
 * cannot be silently left unpaired.
 */
const MIRRORED_LANDMARK: readonly number[] = (() => {
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

/**
 * How much side evidence, in torso units, before we believe the labels.
 *
 * MediaPipe's LEFT_/RIGHT_ are SUBJECT-relative and INFERRED, not observed, so
 * a body turning, crossing its arms or standing at an angle can flip them for a
 * run of frames. Every other detector in the app is immune by construction —
 * `LaneDetector` and `VerticalGestures` read MIDPOINTS, and 67 sums both arms —
 * so this game is the only place a swap changes an answer, and it changes it
 * catastrophically: a swap turns a held pose into its mirror, and the scorer
 * compares direction vectors, so a mirrored limb reads as maximally wrong
 * rather than merely different.
 *
 * MEASURED — what a sustained swap costs, as `poseConfusion(mirror(p), p)`
 * for the shipped library against PASS_THRESHOLD 0.66:
 *
 *   symmetric  (T, TOUCHDOWN, GOALPOST, FLEX, CHICKEN, ORANGUTAN)  1.000  pass
 *   ROBOT                                                          0.276  FAIL
 *   TAXI, TEAPOT, DISCO, ZORRO, BOLT                               0.000  FAIL
 *
 * Half the library, including every pose above difficulty 0.2, becomes
 * unclearable no matter how perfectly the player holds the shape. The wall
 * closes on someone who did exactly what the hole showed them, which is the
 * one failure this game must never produce.
 *
 * THE SIGNAL. A player facing the camera has their own left at the LARGER x
 * (see the angle convention at the top of this file), so
 * `(LEFT_SHOULDER.x - RIGHT_SHOULDER.x) + (LEFT_HIP.x - RIGHT_HIP.x)`,
 * aspect-corrected and in torso units, is strongly positive when the labels
 * are right and strongly negative when they are not.
 *
 * MEASURED over all 12 poses, 60fps, One Euro `poseHold`, frames within 15 of
 * a transition excluded (n = 4278/2807 realistic, 4408/2709 hostile):
 *
 *                       labels correct          labels swapped
 *   realistic body   min +1.273  p50 +1.363   max -1.262  p50 -1.364
 *   hostile body     min +1.161  p50 +1.362   max -1.167  p50 -1.361
 *
 * The two populations are separated by 2.3 torso units with nothing in
 * between. 0.35 sits 3.3x below the smallest legitimate reading, so it cannot
 * be reached by noise, and anything inside ±0.35 is a body too side-on to
 * call — during a transition One Euro blends the two states and the evidence
 * passes through zero (p50 +0.11). Those frames are left AS REPORTED rather
 * than guessed at: the blended skeleton scores badly either way, and `best`
 * is a decaying peak that rides straight over them.
 */
export const SIDE_EVIDENCE_UNITS = 0.35;

/**
 * True when MediaPipe has this body's left and right the wrong way round.
 *
 * Reads the same filtered array `poseSimilarity` scores, so detection and
 * scoring can never disagree about which frame they are looking at.
 */
export function sidesSwapped(player: TrackedPlayer): boolean {
  const lms = player.landmarks;
  const ls = lms[POSE.LEFT_SHOULDER];
  const rs = lms[POSE.RIGHT_SHOULDER];
  const lh = lms[POSE.LEFT_HIP];
  const rh = lms[POSE.RIGHT_HIP];
  if (!ls || !rs || !lh || !rh) return false;
  if (
    Math.min(ls.visibility, rs.visibility, lh.visibility, rh.visibility) < MIN_VISIBILITY
  ) {
    return false;
  }
  const unit = player.scale.unit;
  if (!(unit > 0)) return false;
  const evidence = ((ls.x - rs.x + (lh.x - rh.x)) * player.scale.aspect) / unit;
  return evidence < -SIDE_EVIDENCE_UNITS;
}

/**
 * A segment shorter than this many body units is foreshortened (pointing at the
 * camera) or mis-detected, and its direction is noise. Expressed in
 * `scale.unit` per ARCHITECTURE.md — a raw normalised-frame threshold here
 * would mean something different for every body size.
 */
const MIN_SEGMENT_UNITS = 0.09;
/** Below this fraction of total weight we are not looking at enough body. */
const MIN_COVERAGE = 0.35;

/**
 * Fraction of the ARM weight that must be visible for the arms to be trusted
 * to decide the pose on their own.
 *
 * Arms carry ~64% of the stacked weight, and the comment on SEGMENTS is blunt
 * about why: "Legs are flavour; arms are the game." Arm coverage therefore
 * takes exactly three values in practice, because what drops out is wrists:
 * 1.00 with both forearms seen, 0.79 with one gone, 0.58 with both gone.
 *
 * 0.85 means "anything less than both forearms". Above it the scorer behaves
 * exactly as it always has; at or below it the rest test in REST_MARGIN is
 * also required. When the camera can see less, we demand more — and the
 * threshold sits above 0.79 so that even ONE missing forearm triggers it.
 */
const MIN_ARM_COVERAGE = 0.85;

/**
 * How much better than STANDING STILL the target pose must explain the body
 * before a DEGRADED frame counts as evidence of the pose at all.
 *
 * WHY A RELATIVE TEST AND NOT A HIGHER THRESHOLD. `validateLibrary` proves at
 * module load that no shipped pose scores above 0.55 against `REST_POSE`, and
 * that proof is what stops a wall opening for a player who does nothing — the
 * single worst failure this game has, per REST_POSE's own comment. But the
 * proof assumes the WHOLE body is visible, and the scorer deliberately drops
 * invisible segments from both sides of the ratio. Drop enough of the right
 * ones and the proof evaporates.
 *
 * MEASURED, motionless body, realistic input, 3000 frames x 12 poses. Arm
 * coverage takes exactly three values, because it is the forearms that drop:
 *
 *   both forearms seen   (armCov 1.00)   max idle score  0.458   realistic
 *   one forearm gone     (armCov 0.79)   max idle score  0.614     0.636 hostile
 *   both forearms gone   (armCov 0.58)   max idle score  0.995     0.996 hostile
 *
 * With both forearms unseen, THE FLEX (upper arms at 24 degrees) is
 * indistinguishable from standing at rest (14 degrees) — every remaining
 * segment agrees — so an idle body scored 0.995 against it and cleared the
 * wall. Confirmed end to end: a player who stood still for a full 60s round
 * under realistic input cleared 1 wall of 15 and finished with a score.
 *
 * A coverage floor cannot fix this. Both forearms gone leaves total coverage
 * 0.73 and BOTH LEGS gone leaves 0.72 — and legs out of frame is the normal
 * case at a stall, which the scorer must keep forgiving. The two are
 * indistinguishable by coverage alone.
 *
 * So instead: score REST over exactly the same visible segments and require
 * the target to beat it. That is the library's own guarantee, re-applied to
 * the evidence actually in hand, and it does not care what `passThreshold()`
 * has been tuned to — which matters, because that slider is expected to go
 * DOWN on the day and every absolute margin here shrinks with it.
 *
 * MEASURED, target-minus-rest margin:
 *
 *                       idle body (48000 samples)     held pose (4200)
 *   realistic           p90 -0.573   MAX +0.002       p01 +0.385  p10 +0.656
 *   hostile             p90 -0.566   MAX +0.006       p01 +0.373  p10 +0.650
 *
 * 0.05 sits 8x above the largest margin an idle body ever produced and 7.5x
 * below the first percentile of a real hold. The ~1% of held frames it does
 * reject are frames where the visible limbs genuinely cannot tell the pose
 * from standing still — rejecting those is the correct answer, and `best` is a
 * decaying peak precisely so a handful of unreadable frames costs nothing.
 *
 * ONLY ON DEGRADED FRAMES — see MIN_ARM_COVERAGE. Applied unconditionally it
 * also breaks the live meter, which is this game's second pillar ("the live
 * state teaches it in one attempt"). Halfway into a T-pose the arms are at 45
 * degrees, genuinely equidistant from rest and from the target, so the margin
 * is ~0 and the reading is suppressed; MEASURED, the meter then sat at 0% for
 * the first half of the movement and jumped straight to 83% — past CLOSE
 * entirely, so a player never learns they are getting warmer. Restricting the
 * test to frames where a forearm is missing leaves the meter's normal path
 * completely untouched, because during an ordinary approach both arms are
 * visible.
 *
 * VERIFIED after the change, 60000 idle pose-frames per condition:
 *
 *                    max idle score      frames at/over the gate
 *   realistic            0.461                    0
 *   hostile              0.498                    0
 *
 * (Before: 0.995 and 0.996, and a player who stood still through a full round
 * finished with a score.) The gate is 0.66, so there is 0.16 of headroom — an
 * idle body still cannot clear even if the threshold is tuned down to 0.55,
 * which is the first thing a marshal would try.
 *
 * And the poses stay winnable: every one of the twelve clears on 97.8-100% of
 * frames while genuinely held under HOSTILE input, p10 >= 0.985. The live
 * meter's approach curve is unchanged and monotone — a T-pose reads
 * 30 -> 51 -> 70 -> 86 -> 96 -> 100 across the movement, so NOT YET, CLOSE and
 * <MATCH> all still appear in order.
 *
 * RE-MEASURED when the library went 12 -> 19, because this headroom is set by
 * whichever pose an idle body happens to score best against and seven new
 * candidates is seven new chances to lose it. 59 280 idle pose-frames per
 * condition across six dropout patterns (nothing hidden, either forearm, both
 * forearms, both legs, legs and forearms together):
 *
 *                    max idle score      best-scoring pose
 *   realistic            0.358            THE FLEX, unchanged
 *   hostile              0.365            THE FLEX, unchanged
 *
 * Zero frames at or over the gate in either condition. None of the seven
 * additions comes near THE FLEX's record — the worst of them is THE VOGUE at
 * 0.226 ideal — and that was a selection criterion rather than a happy result.
 * `tests/posematch.test.ts` keeps it that way.
 */
const REST_MARGIN = 0.05;

export interface MatchResult {
  /** 0..1. Compare against PASS_THRESHOLD. */
  score: number;
  /** The underlying cosine similarity, -1..1. Exposed for tuning and tests. */
  cosine: number;
  /** Fraction of total segment weight that was visible enough to score. */
  coverage: number;
  valid: boolean;
  /** Which group is costing the most, for the coaching hint on a miss. */
  worstGroup: SegmentGroup | null;
}

const INVALID: MatchResult = { score: 0, cosine: -1, coverage: 0, valid: false, worstGroup: null };

function meanPoint(
  lms: readonly Landmark[],
  idx: readonly number[],
  flip = false
): { x: number; y: number } | null {
  let sx = 0;
  let sy = 0;
  for (const i of idx) {
    const lm = lms[flip ? MIRRORED_LANDMARK[i] ?? i : i];
    if (!lm || lm.visibility < MIN_VISIBILITY) return null;
    sx += lm.x;
    sy += lm.y;
  }
  return { x: sx / idx.length, y: sy / idx.length };
}

/** Unit direction of one segment in a target pose. */
export function targetDirection(seg: SegmentSpec, a: PoseAngles): { x: number; y: number } {
  if (seg.side === 0) {
    // Torso points hips → shoulders, i.e. upward, tipping toward +x on a
    // positive lean.
    const r = a.lean * DEG;
    return { x: Math.sin(r), y: -Math.cos(r) };
  }
  const r = seg.angleOf(a) * DEG;
  return { x: seg.side * Math.sin(r), y: Math.cos(r) };
}

/** Shared tail of the metric: weighted cosine → 0..1 score. */
function scoreFromCosine(cosine: number): number {
  return Math.max(0, Math.min(1, (cosine - MATCH_FLOOR) / (1 - MATCH_FLOOR)));
}

/**
 * Score a live body against a target pose. 0..1.
 *
 * The metric is a cosine similarity on scale- and translation-normalised
 * landmark vectors, exactly as PLAN.md §3 specifies, and two decisions do all
 * the work:
 *
 *  - The vector is built from SEGMENT DIFFERENCES (bone vectors), not absolute
 *    landmark positions. Differencing removes translation outright: a pose held
 *    at the left of frame and the same pose at the right produce bit-identical
 *    vectors. Nothing about where the player stands can reach the score, which
 *    matters because "stand in the right spot" is a rule nobody at a stall will
 *    read, follow, or forgive.
 *
 *  - Each segment is divided by `scale.unit` and then normalised to unit
 *    length, so only its DIRECTION survives. That is the "joint-angle weighted"
 *    part: limb configuration is the pose, limb length is not. It makes body
 *    size irrelevant by construction rather than by calibration — a 5'2" and a
 *    6'4" player produce identical unit vectors — and it discards limb length,
 *    which MediaPipe gets badly wrong under foreshortening and which would
 *    otherwise leak apparent-size error straight into the score.
 *
 * Low-visibility and degenerate segments are dropped from BOTH sides of the
 * ratio rather than scored as mismatches. Cropped feet are the normal case at a
 * stall, and a player must never be failed for something the camera could not
 * see.
 *
 * The cost of that generosity is that the surviving segments can stop being
 * able to tell the pose apart from STANDING STILL, and the library's
 * whole-body proof that they can does not cover it. `REST_MARGIN` is the
 * guard; the result is `valid: false` when the evidence in hand does not
 * distinguish the two, because "this frame is not readable" is a truer answer
 * than a confident number derived from four visible limbs.
 */
export function poseSimilarity(player: TrackedPlayer, target: PoseAngles): MatchResult {
  const lms = player.landmarks;
  const unit = player.scale.unit;
  const aspect = player.scale.aspect;
  if (!player.scale.valid || unit <= 0) return INVALID;

  // UNDO A LEFT/RIGHT LABEL SWAP BEFORE MEASURING ANYTHING.
  //
  // Every segment below is read by LABEL, and MediaPipe's labels are inferred.
  // When they flip, the scorer measures the player's right arm against the
  // target's left and reports a perfectly-held pose as maximally wrong — see
  // SIDE_EVIDENCE_UNITS for what that costs the shipped library. Reading the
  // landmarks through the mirror map restores the labels the body actually has;
  // the midline segments (torso, and the shoulder/hip midpoints it is built
  // from) are unchanged by it, which is why only the limbs move.
  const flip = sidesSwapped(player);

  let num = 0;
  let den = 0;
  let total = 0;
  /** The same weighted cosine, against standing still. See REST_MARGIN. */
  let restNum = 0;
  /** Arm weight seen vs arm weight that exists. See MIN_ARM_COVERAGE. */
  let armsSeen = 0;
  let armsTotal = 0;
  const groupCost = new Map<SegmentGroup, number>();

  for (const seg of SEGMENTS) {
    const w2 = seg.weight * seg.weight;
    total += w2;
    if (seg.group === 'arms') armsTotal += w2;

    const a = meanPoint(lms, seg.from, flip);
    const b = meanPoint(lms, seg.to, flip);
    if (!a || !b) continue;

    // Translation-normalised (a difference), scale-normalised (÷ unit) and
    // ASPECT-corrected.
    //
    // Without the aspect term a limb's direction reads more vertical than it
    // really is — a true 45 degrees measures 29 at 16:9, an error of up to 16
    // degrees. Horizontal poses (THE T, GOALPOST) and vertical ones
    // (TOUCHDOWN) are immune; every diagonal pose on the roster loses about a
    // sixth of its tolerance per limb. A correct pose still passes, but the
    // live percentage never climbs into the 90s, so the player keeps adjusting
    // a pose they have already hit — which reads as the game lagging.
    //
    // Invisible in the simulator because `applyPose` builds the body from the
    // same isotropic assumption this scorer used: the two agreed with each
    // other and both disagreed with a camera.
    const vx = ((b.x - a.x) * aspect) / unit;
    const vy = (b.y - a.y) / unit;
    const len = Math.hypot(vx, vy);
    if (len < MIN_SEGMENT_UNITS) continue;

    const ux = vx / len;
    const uy = vy / len;

    const t = targetDirection(seg, target);
    const c = ux * t.x + uy * t.y;

    // Standing still, measured over the identical segment set — so the
    // comparison below is like for like no matter which limbs dropped out.
    const rest = targetDirection(seg, REST_POSE);
    restNum += w2 * (ux * rest.x + uy * rest.y);

    num += w2 * c;
    den += w2;
    if (seg.group === 'arms') armsSeen += w2;
    groupCost.set(seg.group, (groupCost.get(seg.group) ?? 0) + w2 * (1 - c));
  }

  const coverage = total > 0 ? den / total : 0;
  if (den <= 0 || coverage < MIN_COVERAGE) return { ...INVALID, coverage };

  const cosine = num / den;
  const score = scoreFromCosine(cosine);

  // ON A DEGRADED FRAME, DOES THIS BEAT STANDING STILL?
  //
  // Not a second threshold on the score — a comparison between two readings of
  // the SAME segments, so it stays honest however few of them survived and
  // whatever the pass threshold has been tuned to. Gated on arm coverage so
  // that an ordinary approach, where both arms are visible, is scored exactly
  // as before and the live meter keeps its full resolution.
  const armCoverage = armsTotal > 0 ? armsSeen / armsTotal : 0;
  if (
    armCoverage < MIN_ARM_COVERAGE &&
    score - scoreFromCosine(restNum / den) < REST_MARGIN
  ) {
    return { ...INVALID, coverage };
  }

  let worstGroup: SegmentGroup | null = null;
  let worst = 0;
  for (const [g, cost] of groupCost) {
    if (cost > worst) {
      worst = cost;
      worstGroup = g;
    }
  }

  return { score, cosine, coverage, valid: true, worstGroup };
}

/**
 * The segments that survive the stall's NORMAL FRAMING.
 *
 * Legs out of frame is not an edge case here — it is what a laptop on a table
 * at a club fair sees, and `poseSimilarity` deliberately drops what the camera
 * could not see rather than failing a player for it. Both legs gone leaves 0.72
 * of total coverage, comfortably over `MIN_COVERAGE`, so the scorer carries on
 * happily with arms and torso alone.
 *
 * Which means the library's separation proof has to hold over THIS set too, not
 * only over a whole body. A pair of poses that differ only below the waist
 * scores 1.000 against each other the moment the legs drop out, and nothing
 * on screen would say why the wall opened.
 */
export const CROPPED_SEGMENT_KEYS: readonly SegmentKey[] = [
  'upperArmL', 'foreArmL', 'upperArmR', 'foreArmR', 'torso',
];

/**
 * What a body holding `held` PERFECTLY would score against a wall asking for
 * `target`. The same arithmetic as `poseSimilarity`, with an ideal body instead
 * of a measured one.
 *
 * This is the function that makes the library trustworthy. Two poses can look
 * completely different to a human and still sit inside each other's tolerance —
 * arms-up-in-a-V at 125° and at 168° are visibly distinct and score 0.85
 * against each other — and a library with a pair like that ships a wall that
 * opens for the wrong pose. Which reads, correctly, as the game being broken.
 *
 * `over` restricts the comparison to a subset of segments, so the same question
 * can be asked of a body the camera can only half see — see
 * `CROPPED_SEGMENT_KEYS`, and `validateLibrary`, which asks it both ways.
 */
export function poseConfusion(
  held: PoseAngles,
  target: PoseAngles,
  over?: readonly SegmentKey[]
): number {
  let num = 0;
  let den = 0;
  for (const seg of SEGMENTS) {
    if (over && !over.includes(seg.key)) continue;
    const w2 = seg.weight * seg.weight;
    const a = targetDirection(seg, held);
    const b = targetDirection(seg, target);
    num += w2 * (a.x * b.x + a.y * b.y);
    den += w2;
  }
  return den > 0 ? scoreFromCosine(num / den) : 0;
}

/**
 * THREE FLAT STATES — red, yellow, green — never a ramp between them.
 *
 * This used to be a continuous red → yellow → green `lerpColor`, which broke
 * two brand rules at once: it put three brand colours in one component, and it
 * interpolated between them, which DESIGN.md forbids outright ("brand colours
 * are always flat, no gradients"). It was also worse information design. A
 * continuous ramp asks a player to judge a *shade* from three metres — nobody
 * can tell 0.58-orange from 0.66-orange, so the signal it appeared to carry was
 * never actually readable.
 *
 * Flat states are readable instantly, and DESIGN.md's own rule tells us what to
 * do about the resolution we lose: "when colour conveys meaning, supplement
 * with text, numbers, or icons." The exact figure lives in the percentage
 * readout and `matchLabel()` next to it, so the player still sees precisely how
 * close they are — as a number, which is legible, rather than as a hue, which
 * is not.
 *
 * Only ONE of these is ever on screen at a time, so the live skeleton stays
 * inside the two-brand-colours-per-component cap.
 *
 * THE GREEN BOUNDARY IS `passThreshold()`, THE LIVE VALUE — not the constant.
 *
 * It used to be the constant, with a comment claiming that was deliberate
 * because "green must mean this would open the wall". That is the right rule
 * and the constant is the wrong way to honour it: the gate `resolveWall`
 * actually applies is `passThreshold()`, which reads the tunable. The registry
 * ships the same 0.66 today, so the two agree until the moment somebody moves
 * the slider — and moving that slider is the single thing it exists for. Both
 * this file and `meta/tunables.ts` say in as many words that the Sept 22
 * playtest is expected to want it LOWER.
 *
 * At 0.55, the first thing a marshal would try, every wall between 0.55 and
 * 0.66 opened while the skeleton stayed yellow and the word underneath it said
 * CLOSE. The player is told they missed by all three channels the design is
 * built on — colour, word and number — and then walks through. That reads as
 * the game being broken in the exact session held to find out whether it is.
 *
 * SAME ARGUMENT, NOW FOR THE RAMP: the gate moves BETWEEN WALLS
 * (`passThresholdAt`), so these take the gate the wall in front of the player
 * is actually being judged against. Defaulting the parameter keeps the promise
 * true for any caller that has no wall — the attract screen, a test — without
 * letting the live game silently fall back to the wrong number.
 */
export const CLOSE_THRESHOLD = 0.45;

export function matchColor(score: number, gate: number = passThreshold()): string {
  if (score >= gate) return COLORS.green;
  if (score >= CLOSE_THRESHOLD) return COLORS.yellow;
  return COLORS.red;
}

/**
 * The word that goes with the colour. Same three states, so a player who cannot
 * separate the hues — a loud hall, a badly calibrated panel, colour blindness —
 * still gets the whole signal.
 *
 * Voice: brackets on the call-to-action, and nothing punishing. "NOT YET" is
 * an instruction to keep moving; "MISS" would be a verdict.
 */
export function matchLabel(score: number, gate: number = passThreshold()): string {
  if (score >= gate) return '<MATCH>';
  if (score >= CLOSE_THRESHOLD) return 'CLOSE';
  return 'NOT YET';
}

/* ------------------------------------------------------------------ */
/* Constraint sets — the space poses are generated from                */
/* ------------------------------------------------------------------ */

/**
 * Upper-arm directions. Deliberately coarse: anything finer than ~40° apart is
 * not distinguishable as a silhouette from 3m, which makes a pose unfair rather
 * than hard.
 */
export const SHOULDER_SET = {
  /** Down and inward, across the body. */
  ACROSS: -30,
  /** Hanging at the side. */
  DOWN: 12,
  /** Just off the side. */
  LOW: 24,
  /** Straight out to the side. */
  OUT: 90,
  /** Out and a little above horizontal. */
  HIGH: 115,
  /** The classic Y arm. */
  DIAG_UP: 142,
  /** Straight overhead. */
  UP: 168,
} as const;

/** Elbow flex, relative to the upper arm. 0 = straight arm. */
export const FLEX_SET = {
  STRAIGHT: 0,
  /** Forearm vertical, hand above the elbow. */
  FOLD_UP: 90,
  /** Forearm vertical, hand below the elbow. */
  FOLD_DOWN: -90,
  /** Hand parked on the hip. */
  ON_HIP: -65,
  /** Bicep curl. */
  CURL: 125,
  /** Forearm in across the belly. */
  TUCK: -70,
  /**
   * Forearm folded back over the head. WAS -145, softened to -135 with
   * WING after a playtest cohort reported the latter half of the ramp as
   * "asking to bend our arms in ways that ain't possible": 145-150° of
   * flexion is legal anatomy but a stretch hold under a two-second
   * deadline, and the shapes only need to read as hands overhead, not
   * to hit the edge of the joint. -135 keeps the silhouette family and
   * lands inside what a relaxed elbow does without effort.
   */
  OVERHEAD: -135,
  /**
   * Same softening as OVERHEAD, was -150. Playtest report: "Mabye dial down
   * the difficulty a bit 😅, thing was asking to bend our arms in ways that
   * ain't possible bahahahaha. just the latter half, first half is good."
   * The first half needed nothing — its poses top out at 125° of flexion —
   * and the latter half is exactly the poses built on this set and OVERHEAD.
   */
  WING: -135,
  /** Forearm swept out horizontal. */
  SWEEP: 120,
  ZIG: -105,
  ZAG: 105,
} as const;

/** Thigh directions. At or above `RAISED_HIP_MIN` a leg is off the floor. */
export const HIP_SET = {
  PLANTED: 6,
  WIDE: 24,
  MARCH: 48,
} as const;

/** Anatomical knee flex. Negative = heel swinging back behind the thigh. */
export const KNEE_FLEX_SET = {
  STRAIGHT: 0,
  TUCK: -42,
} as const;

/** A thigh at or above this is a leg in the air. */
const RAISED_HIP_MIN = 35;
/** Human elbows and knees do not bend past roughly this. */
const MAX_FLEX = 155;

/**
 * No shipped pose may score above this against any other shipped pose, or
 * against standing still. Comfortably under PASS_THRESHOLD, with margin for a
 * real body being noisier than an ideal one.
 *
 * KEYED TO THE ROUND-OPENING GATE, WHICH IS THE BINDING CASE. The tolerance
 * ramps up across a round (`passThresholdAt`), so a pair of poses that cannot
 * pass for each other at the first wall cannot at the fifteenth either —
 * headroom over this only grows, from 0.009 at `PASS_THRESHOLD` to 0.169 at
 * `PASS_THRESHOLD_END` for the library's worst pair. Nothing here may be
 * relaxed on the strength of the raised end of the ramp.
 */
export const MAX_CONFUSION = 0.66;
const MAX_REST_CONFUSION = 0.55;

/** Build one arm from a shoulder direction plus an elbow flex. */
function arm(shoulder: number, flex: number): { shoulder: number; elbow: number } {
  return { shoulder, elbow: wrapDeg(shoulder + flex) };
}

/** Build one leg from a thigh direction plus a knee flex. */
function leg(hip: number, flex: number): { hip: number; knee: number } {
  return { hip, knee: wrapDeg(hip + flex) };
}

export interface PoseParts {
  left: { shoulder: number; elbow: number };
  right: { shoulder: number; elbow: number };
  legL: { hip: number; knee: number };
  legR: { hip: number; knee: number };
  lean?: number;
}

function angles(parts: PoseParts): PoseAngles {
  return {
    shoulderL: parts.left.shoulder,
    elbowL: parts.left.elbow,
    shoulderR: parts.right.shoulder,
    elbowR: parts.right.elbow,
    hipL: parts.legL.hip,
    kneeL: parts.legL.knee,
    hipR: parts.legR.hip,
    kneeR: parts.legR.knee,
    lean: parts.lean ?? 0,
  };
}

const PLANTED = leg(HIP_SET.PLANTED, KNEE_FLEX_SET.STRAIGHT);
const WIDE = leg(HIP_SET.WIDE, KNEE_FLEX_SET.STRAIGHT);
const MARCH = leg(HIP_SET.MARCH, KNEE_FLEX_SET.TUCK);

/**
 * Standing normally, arms at the sides. Not a pose you can be asked for — it is
 * the thing every candidate has to be measurably DIFFERENT from, because a wall
 * that opens when the player does nothing is the single worst failure this game
 * has. It is not even legible as a bug: it just looks like the wall was free.
 */
export const REST_POSE: PoseAngles = angles({
  left: arm(14, -6),
  right: arm(14, -6),
  legL: PLANTED,
  legR: PLANTED,
});

/**
 * The rules from the brief, as code: "achievable by an average person in 2
 * seconds, in a crowded space, wearing normal clothes. Nothing requiring
 * balance or floor contact."
 *
 * Returns a reason rather than a bare false, so a rejected candidate is
 * debuggable instead of silently missing.
 */
export function achievabilityFault(a: PoseAngles): string | null {
  const vals = [a.shoulderL, a.elbowL, a.shoulderR, a.elbowR, a.hipL, a.kneeL, a.hipR, a.kneeR, a.lean];
  if (vals.some((v) => !Number.isFinite(v))) return 'non-finite angle';

  for (const [s, e, side] of [
    [a.shoulderL, a.elbowL, 'L'],
    [a.shoulderR, a.elbowR, 'R'],
  ] as const) {
    if (s < -60 || s > 180) return `${side} shoulder out of range`;
    if (Math.abs(flexOf(s, e)) > MAX_FLEX) return `${side} elbow hyperextended`;
  }

  // One foot off the floor for a beat is a march step. Two is a jump, and a
  // jump cannot be held while a wall arrives.
  const raised = [a.hipL, a.hipR].filter((h) => h >= RAISED_HIP_MIN).length;
  if (raised > 1) return 'both feet off the floor';

  for (const [h, k, side] of [
    [a.hipL, a.kneeL, 'L'],
    [a.hipR, a.kneeR, 'R'],
  ] as const) {
    if (h < -12) return `${side} leg crossed`;
    // Above this the knee is at chest height, which is a balance move.
    if (h > 55) return `${side} knee too high`;
    if (Math.abs(flexOf(h, k)) > 90) return `${side} knee hyperflexed`;
    if (h < RAISED_HIP_MIN && Math.abs(flexOf(h, k)) > 30) return `${side} planted foot bent`;
  }

  if (Math.abs(a.lean) > 22) return 'lean past balance';
  return null;
}

export function isAchievable(a: PoseAngles): boolean {
  return achievabilityFault(a) === null;
}

/**
 * Enumerate the legal pose space and greedily keep a mutually distinguishable
 * subset.
 *
 * This is the generator PLAN.md asks for, and it is not decorative: `POSES`
 * below is assembled from the same constants, validated against the same
 * constraints by the same functions, and this is what you re-run when a
 * playtest says the library needs more or different candidates.
 *
 * Separation is measured in the METRIC's own space (`poseConfusion`), not in
 * raw joint degrees. Two poses 60° apart at the shoulder are miles apart to a
 * human and may still be inside each other's tolerance; degrees are the wrong
 * ruler for the question being asked.
 *
 * @param seeds     poses that must be in the result (the shipped library, when
 *                  you are looking for candidates to ADD to it)
 * @param maxConfusion ceiling on mutual confusability
 */
export function generatePoses(
  seeds: readonly PoseAngles[] = [],
  maxConfusion = MAX_CONFUSION
): PoseAngles[] {
  const shoulders = Object.values(SHOULDER_SET);
  const flexes = Object.values(FLEX_SET);
  const legPairs: Array<{ legL: { hip: number; knee: number }; legR: { hip: number; knee: number } }> = [
    { legL: PLANTED, legR: PLANTED },
    { legL: WIDE, legR: WIDE },
    { legL: MARCH, legR: PLANTED },
  ];

  const kept: PoseAngles[] = [...seeds];
  const added: PoseAngles[] = [];

  const tooClose = (cand: PoseAngles): boolean =>
    kept.some((p) => poseConfusion(p, cand) > maxConfusion || poseConfusion(cand, p) > maxConfusion);

  for (const legs of legPairs) {
    for (const sl of shoulders) {
      for (const fl of flexes) {
        for (const sr of shoulders) {
          for (const fr of flexes) {
            const cand = angles({
              left: arm(sl, fl),
              right: arm(sr, fr),
              legL: legs.legL,
              legR: legs.legR,
            });
            if (!isAchievable(cand)) continue;
            if (poseConfusion(REST_POSE, cand) > MAX_REST_CONFUSION) continue;
            if (tooClose(cand)) continue;
            kept.push(cand);
            added.push(cand);
          }
        }
      }
    }
  }
  return added;
}

/* ------------------------------------------------------------------ */
/* The shipped library                                                 */
/* ------------------------------------------------------------------ */

/**
 * Built through here so every shipped pose is checked against the same
 * constraints the generator uses. Warnings rather than throws: a bad pose
 * definition must never be able to black-screen the stall.
 */
function definePose(id: string, name: string, difficulty: number, parts: PoseParts): PoseDef {
  const a = angles(parts);
  const fault = achievabilityFault(a);
  if (fault) console.warn(`[poses] "${name}" violates a constraint: ${fault}`);
  return { id, name, angles: a, difficulty };
}

/**
 * Nineteen, in increasing difficulty, hand-picked out of the generated space.
 *
 * Selection criteria, in order:
 *   1. Distinguishable from every other pose and from standing still, verified
 *      numerically below rather than by eye.
 *   2. Legible as a SILHOUETTE from 3m — limbs held away from the torso, since
 *      a limb folded across the body disappears into the body in an outline and
 *      the hole stops reading as a shape to copy.
 *   3. Funny, and funnier to watch than to do.
 *
 * Deliberately NOT here: anything whose only difference from another pose is a
 * leg. Legs carry ~27% of the weight and are frequently out of frame, so a
 * leg-only pose (a flamingo next to a T-pose, say) scores 0.97 against the pose
 * it is meant to be distinct from. Leg variation survives as decoration, where
 * it never has to carry the decision.
 *
 * ---------------------------------------------------------------------------
 * THE SEVEN ADDED FOR THE CLUB FAIR, AND WHY THESE SEVEN
 * ---------------------------------------------------------------------------
 *
 * The playtest verdict on this game was "make it harder, more pose variation",
 * so the library went 12 -> 19. Finding seven was not a matter of thinking of
 * seven shapes: the metric's capacity is the binding constraint, and the
 * original twelve had very nearly used it up. A full sweep of the constraint
 * sets (11 006 legal arm/leg/lean combinations) yields only 329 candidates that
 * clear every guard below, and the largest MUTUALLY distinguishable subset of
 * those is seven. Widening the vocabulary does not help — adding a 55-degree
 * shoulder and +-45-degree elbow flexes to the sets raised the candidate count
 * by 76% and the achievable subset size by zero. The wall is the metric, not
 * the imagination.
 *
 * Each of the seven had to clear, all at once:
 *
 *   CONFUSION <= 0.60 against every other pose, WHOLE BODY and LEGS CROPPED.
 *     Worst of the seven is THE CRANE at 0.600 (against THE ORANGUTAN), so the
 *     slackest new pair has 0.060 of headroom under the first wall's 0.66 gate
 *     — 6.7x the 0.009 the shipped library's own worst pair (GOALPOST/FLEX at
 *     0.651) was living on. Legs cropped, the worst of the seven is 0.477.
 *
 *   SILHOUETTE IoU <= 0.70 against every other pose. Confusion is what the
 *     SCORER can tell apart; this is what a PLAYER can, and they are not the
 *     same question. Each pose is rasterised exactly as `drawPoseSilhouette`
 *     normalises it — fit to height, centred on the bounding box — and overlaid
 *     on every other. Worst of the seven is 0.606 (THE RAINBOW against THE
 *     WAITER); for reference the shipped twelve contain GOALPOST/ROBOT at
 *     0.906, which is the same shape with one forearm flipped.
 *
 *   REST CONFUSION <= 0.30, and <= 0.11 with the legs cropped. The idle-body
 *     guard (see REST_MARGIN) has 0.199 of headroom — 0.461 measured max
 *     against a 0.66 gate — and that headroom is set by whichever pose an idle
 *     body scores best against. THE FLEX still holds that record at 0.349; the
 *     worst of the seven is THE VOGUE at 0.226, so the guard is untouched.
 *
 *   LIMBS CLEAR OF THE TORSO by at least 0.05 torso units at every elbow and
 *     wrist, so no hand vanishes into the body in an outline, and a bounding
 *     box at least 0.42 as wide as it is tall — the shipped library's own floor,
 *     set by THE TOUCHDOWN.
 *
 *   ARMS AND A STANCE, NEVER A BALANCE. Every one is reachable standing on two
 *     feet with the legs either planted or apart, so it works for any height at
 *     3m and does not care whether the camera can see the legs at all.
 *
 * DIFFICULTY IS FITTED, NOT GUESSED. The twelve hand-assigned difficulties turn
 * out to be almost exactly a linear function of three measurable things —
 * how far the limbs travel from rest, how much the two arms DISAGREE, and how
 * bent the elbows are:
 *
 *   d = -0.160 + 0.384*(travel/180) + 0.724*(asym/360) + 0.619*(fold/180)
 *
 * which fits the shipped twelve at r = 0.935, RMS residual 0.095. Asymmetry is
 * the single strongest term (r = 0.69 alone), which is the real finding: a pose
 * is hard when your two arms have to do different jobs. The seven below are
 * placed at their FITTED value, nudged by at most 0.078 — inside that residual
 * — to keep the ladder evenly spaced.
 */
export const POSES: readonly PoseDef[] = [
  definePose('t', 'THE T', 0.05, {
    left: arm(SHOULDER_SET.OUT, FLEX_SET.STRAIGHT),
    right: arm(SHOULDER_SET.OUT, FLEX_SET.STRAIGHT),
    legL: PLANTED, legR: PLANTED,
  }),

  definePose('touchdown', 'THE TOUCHDOWN', 0.12, {
    left: arm(SHOULDER_SET.UP, FLEX_SET.STRAIGHT),
    right: arm(SHOULDER_SET.UP, FLEX_SET.STRAIGHT),
    legL: PLANTED, legR: PLANTED,
  }),

  definePose('taxi', 'HAILING A TAXI', 0.2, {
    left: arm(SHOULDER_SET.UP, FLEX_SET.STRAIGHT),
    right: arm(SHOULDER_SET.DOWN, FLEX_SET.STRAIGHT),
    legL: PLANTED, legR: PLANTED,
  }),

  definePose('goalpost', 'THE GOALPOST', 0.3, {
    left: arm(SHOULDER_SET.OUT, FLEX_SET.FOLD_UP),
    right: arm(SHOULDER_SET.OUT, FLEX_SET.FOLD_UP),
    legL: PLANTED, legR: PLANTED,
  }),

  definePose('flex', 'THE FLEX', 0.36, {
    left: arm(SHOULDER_SET.LOW, FLEX_SET.CURL),
    right: arm(SHOULDER_SET.LOW, FLEX_SET.CURL),
    legL: PLANTED, legR: PLANTED,
  }),

  definePose('robot', 'THE ROBOT', 0.44, {
    left: arm(SHOULDER_SET.OUT, FLEX_SET.FOLD_UP),
    right: arm(SHOULDER_SET.OUT, FLEX_SET.FOLD_DOWN),
    legL: PLANTED, legR: PLANTED,
  }),

  definePose('chicken', 'THE CHICKEN', 0.5, {
    left: arm(SHOULDER_SET.HIGH, FLEX_SET.WING),
    right: arm(SHOULDER_SET.HIGH, FLEX_SET.WING),
    legL: PLANTED, legR: PLANTED,
  }),

  // One arm straight out, the other thrown up with the forearm curving across
  // over the head, hips open. The best-separated pose in the whole library —
  // 0.542 confusion and 0.396 IoU against its nearest neighbour — because
  // nothing else combines a horizontal arm with a vertical one.
  definePose('bhangra', 'THE BHANGRA', 0.54, {
    left: arm(SHOULDER_SET.OUT, FLEX_SET.STRAIGHT),
    right: arm(SHOULDER_SET.UP, FLEX_SET.FOLD_UP),
    legL: WIDE, legR: WIDE,
    lean: 10,
  }),

  definePose('teapot', 'THE TEAPOT', 0.58, {
    left: arm(SHOULDER_SET.LOW, FLEX_SET.ON_HIP),
    right: arm(SHOULDER_SET.DIAG_UP, FLEX_SET.STRAIGHT),
    legL: PLANTED, legR: PLANTED,
    lean: -9,
  }),

  // One hand on top of the head, the other elbow bent out from the hip, leaning
  // away from it. Reads as washing your hair and being caught at it.
  definePose('shampoo', 'THE SHAMPOO', 0.62, {
    left: arm(SHOULDER_SET.HIGH, FLEX_SET.CURL),
    right: arm(SHOULDER_SET.DOWN, FLEX_SET.ZAG),
    legL: PLANTED, legR: PLANTED,
    lean: -10,
  }),

  definePose('orangutan', 'THE ORANGUTAN', 0.64, {
    left: arm(SHOULDER_SET.UP, FLEX_SET.OVERHEAD),
    right: arm(SHOULDER_SET.UP, FLEX_SET.OVERHEAD),
    legL: PLANTED, legR: PLANTED,
  }),

  // Both forearms sweeping the same way across the top of the head, one coming
  // down from an arm that is up and one coming up from an arm that is out — an
  // arc over the head with the body offset under one end of it.
  definePose('rainbow', 'THE RAINBOW', 0.66, {
    left: arm(SHOULDER_SET.UP, FLEX_SET.ZAG),
    right: arm(SHOULDER_SET.OUT, FLEX_SET.CURL),
    legL: WIDE, legR: WIDE,
  }),

  // Mast and jib: one arm straight up, the other out on the diagonal with the
  // forearm hanging dead vertical off the elbow like a hook on a cable.
  definePose('crane', 'THE CRANE', 0.69, {
    left: arm(SHOULDER_SET.DIAG_UP, FLEX_SET.WING),
    right: arm(SHOULDER_SET.UP, FLEX_SET.STRAIGHT),
    legL: WIDE, legR: WIDE,
    lean: -10,
  }),

  definePose('disco', 'THE DISCO', 0.72, {
    left: arm(SHOULDER_SET.DIAG_UP, FLEX_SET.STRAIGHT),
    right: arm(SHOULDER_SET.ACROSS, FLEX_SET.TUCK),
    legL: WIDE, legR: WIDE,
    lean: 8,
  }),

  // Both upper arms out on the same diagonal and the forearms pointing at
  // completely different things — the best clearance in the library at 0.29
  // torso units, so every one of those angles survives as an outline.
  definePose('semaphore', 'THE SEMAPHORE', 0.75, {
    left: arm(SHOULDER_SET.DIAG_UP, FLEX_SET.ZAG),
    right: arm(SHOULDER_SET.DIAG_UP, FLEX_SET.ON_HIP),
    legL: WIDE, legR: WIDE,
    lean: -10,
  }),

  // Tray up at head height on one side, the other hand folded down across the
  // belly. The full obsequious bow, minus the bow.
  definePose('waiter', 'THE WAITER', 0.78, {
    left: arm(SHOULDER_SET.UP, FLEX_SET.TUCK),
    right: arm(SHOULDER_SET.OUT, FLEX_SET.OVERHEAD),
    legL: WIDE, legR: WIDE,
  }),

  definePose('zorro', 'THE ZORRO', 0.82, {
    left: arm(SHOULDER_SET.ACROSS, FLEX_SET.SWEEP),
    right: arm(SHOULDER_SET.DIAG_UP, FLEX_SET.STRAIGHT),
    legL: PLANTED, legR: PLANTED,
    lean: 8,
  }),

  definePose('bolt', 'THE LIGHTNING BOLT', 0.93, {
    left: arm(SHOULDER_SET.DIAG_UP, FLEX_SET.ZIG),
    right: arm(SHOULDER_SET.LOW, FLEX_SET.ZAG),
    legL: WIDE, legR: WIDE,
    lean: 10,
  }),

  // The hardest thing in the library by the fitted model, and it is the
  // asymmetry that does it: one arm folded shut straight overhead, the other
  // thrown open low and wide. Nothing about one arm tells you the other.
  definePose('vogue', 'THE VOGUE', 0.97, {
    left: arm(SHOULDER_SET.LOW, FLEX_SET.ZAG),
    right: arm(SHOULDER_SET.UP, FLEX_SET.WING),
    legL: WIDE, legR: WIDE,
  }),
];

/**
 * Ceiling on confusability WITH THE LEGS OUT OF FRAME.
 *
 * The whole-body check below is the conservative one for most pairs, because
 * most poses stand on the same planted legs and those agreeing segments push
 * the score UP: the shipped library's worst pair is 0.651 whole-body and 0.522
 * cropped. But that is a property of the library, not of the metric, and it
 * stops being true the moment somebody adds a pose whose separation lives below
 * the waist — which is precisely the mistake the stall's framing punishes and
 * precisely the one nobody would spot by eye.
 *
 * Same value as MAX_CONFUSION rather than a tighter one: the question is
 * identical ("can holding this open a wall asking for that?"), only the
 * evidence is smaller. Measured worst over the shipped nineteen: 0.522.
 */
const MAX_CROPPED_CONFUSION = MAX_CONFUSION;

/**
 * Library self-check, at module load.
 *
 * Cheap (19 × 19 × 9 dot products, twice) and worth doing every boot rather
 * than in a test file, because the failure it catches is invisible at the
 * stall: a wall that opens for the wrong pose looks exactly like a wall that
 * opened for the right one, and nobody debugging on the day would think to look
 * here.
 *
 * Checked TWICE over, once whole-body and once over `CROPPED_SEGMENT_KEYS`.
 * A stall camera sees legs roughly never, and the scorer drops what it cannot
 * see from both sides of the ratio — so a guarantee that only holds for a whole
 * body is a guarantee that holds in the one framing this game will not be
 * played in.
 */
export function validateLibrary(): string[] {
  const problems: string[] = [];
  const worst = (
    a: PoseAngles,
    b: PoseAngles,
    over?: readonly SegmentKey[]
  ): number => Math.max(poseConfusion(a, b, over), poseConfusion(b, a, over));

  for (const p of POSES) {
    const rest = worst(REST_POSE, p.angles);
    if (rest > MAX_REST_CONFUSION) {
      problems.push(`${p.name} is ${rest.toFixed(2)} confusable with standing still`);
    }
    const cropped = worst(REST_POSE, p.angles, CROPPED_SEGMENT_KEYS);
    if (cropped > MAX_REST_CONFUSION) {
      problems.push(
        `${p.name} is ${cropped.toFixed(2)} confusable with standing still once the legs crop`
      );
    }
  }
  for (let i = 0; i < POSES.length; i++) {
    for (let j = i + 1; j < POSES.length; j++) {
      const a = POSES[i]!;
      const b = POSES[j]!;
      const v = worst(a.angles, b.angles);
      if (v > MAX_CONFUSION) {
        problems.push(`${a.name} and ${b.name} are ${v.toFixed(2)} confusable`);
      }
      const c = worst(a.angles, b.angles, CROPPED_SEGMENT_KEYS);
      if (c > MAX_CROPPED_CONFUSION) {
        problems.push(
          `${a.name} and ${b.name} are ${c.toFixed(2)} confusable once the legs crop`
        );
      }
    }
  }
  return problems;
}

for (const problem of validateLibrary()) console.warn(`[poses] ${problem}`);

/**
 * Pick a pose at roughly the requested difficulty, never repeating anything in
 * `recent`. The no-repeat window is what stops the same pose landing twice in
 * one round — which reads as the game being broken far more than it reads as
 * luck.
 *
 * WITH TWELVE POSES IT COULD NOT KEEP THAT PROMISE. A 60s round is about 15
 * walls at a good pace and 19 at a perfect one, so a twelve-pose library was
 * arithmetically guaranteed to repeat, and a window wide enough to try left so
 * few candidates that the difficulty target stopped choosing anything.
 * MEASURED over 6000 simulated rounds of 15 walls, mean repeats a round and
 * mean |pose difficulty - target|:
 *
 *                 window 6      window 8      window 15
 *   12 poses    3.9 / 0.205   3.5 / 0.249   3.0 / 0.163
 *   19 poses    0.7 / 0.126   0.2 / 0.128   0.0 / 0.127
 *
 * At nineteen the two goals stop competing: the window can be deep enough to
 * eliminate repeats outright AND the targeting is better than it ever was.
 * That is most of what "more pose variation" bought.
 */
export function pickPose(difficulty: number, recent: readonly string[] = []): PoseDef {
  const target = Math.max(0, Math.min(1, difficulty));
  const pool = POSES.filter((p) => !recent.includes(p.id));
  const from = pool.length > 0 ? pool : POSES;

  // Weight by closeness to the target difficulty, with a kernel wide enough
  // that the pick still feels random rather than a fixed ladder.
  let best = from[0]!;
  let bestScore = -Infinity;
  for (const p of from) {
    const score = (1 - Math.abs(p.difficulty - target)) * 2 + Math.random();
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Silhouette geometry                                                 */
/* ------------------------------------------------------------------ */

/**
 * Body proportions in TORSO UNITS (hip centre to shoulder centre = 1) — the
 * same unit `scale.unit` measures, so a drawn silhouette and a real body of any
 * height are directly comparable shapes.
 */
const P = {
  shoulderHalf: 0.40,
  hipHalf: 0.26,
  upperArm: 0.55,
  foreArm: 0.52,
  thigh: 0.68,
  shin: 0.65,
  neck: 0.30,
  headR: 0.27,
  torsoW: 0.62,
  armW: 0.30,
  legW: 0.36,
  beltW: 0.34,
} as const;

export interface PosePoint {
  x: number;
  y: number;
}

export interface PoseSkeleton {
  hipMid: PosePoint;
  shoulderMid: PosePoint;
  head: PosePoint;
  headR: number;
  shoulderL: PosePoint; elbowL: PosePoint; wristL: PosePoint;
  shoulderR: PosePoint; elbowR: PosePoint; wristR: PosePoint;
  hipL: PosePoint; kneeL: PosePoint; ankleL: PosePoint;
  hipR: PosePoint; kneeR: PosePoint; ankleR: PosePoint;
}

function step(from: PosePoint, side: 1 | -1, deg: number, len: number): PosePoint {
  const r = deg * DEG;
  return { x: from.x + side * Math.sin(r) * len, y: from.y + Math.cos(r) * len };
}

/**
 * Joint angles → 2D points, in body-frame torso units with the hip centre at
 * the origin. Same frame and same convention as the scorer, which is why the
 * hole in the wall is guaranteed to be the shape being scored.
 */
export function poseSkeleton(a: PoseAngles): PoseSkeleton {
  const lean = a.lean * DEG;
  const up: PosePoint = { x: Math.sin(lean), y: -Math.cos(lean) };
  // Shoulder/hip axis, perpendicular to the torso, pointing toward +x.
  const across: PosePoint = { x: Math.cos(lean), y: Math.sin(lean) };

  const hipMid: PosePoint = { x: 0, y: 0 };
  const shoulderMid: PosePoint = { x: up.x, y: up.y };
  const head: PosePoint = { x: shoulderMid.x + up.x * P.neck, y: shoulderMid.y + up.y * P.neck };

  const shoulderL: PosePoint = { x: shoulderMid.x + across.x * P.shoulderHalf, y: shoulderMid.y + across.y * P.shoulderHalf };
  const shoulderR: PosePoint = { x: shoulderMid.x - across.x * P.shoulderHalf, y: shoulderMid.y - across.y * P.shoulderHalf };
  const hipL: PosePoint = { x: hipMid.x + across.x * P.hipHalf, y: hipMid.y + across.y * P.hipHalf };
  const hipR: PosePoint = { x: hipMid.x - across.x * P.hipHalf, y: hipMid.y - across.y * P.hipHalf };

  return {
    hipMid, shoulderMid, head, headR: P.headR,
    shoulderL,
    elbowL: step(shoulderL, 1, a.shoulderL, P.upperArm),
    wristL: step(step(shoulderL, 1, a.shoulderL, P.upperArm), 1, a.elbowL, P.foreArm),
    shoulderR,
    elbowR: step(shoulderR, -1, a.shoulderR, P.upperArm),
    wristR: step(step(shoulderR, -1, a.shoulderR, P.upperArm), -1, a.elbowR, P.foreArm),
    hipL,
    kneeL: step(hipL, 1, a.hipL, P.thigh),
    ankleL: step(step(hipL, 1, a.hipL, P.thigh), 1, a.kneeL, P.shin),
    hipR,
    kneeR: step(hipR, -1, a.hipR, P.thigh),
    ankleR: step(step(hipR, -1, a.hipR, P.thigh), -1, a.kneeR, P.shin),
  };
}

/** One capsule of the drawn silhouette. */
export interface PoseBlob {
  a: PosePoint;
  b: PosePoint;
  /** Half-width in torso units. */
  r: number;
}

/**
 * The silhouette as a list of capsules, plus the head, in body-frame torso
 * units. Exported because it is the ONLY description of the shape a player
 * actually sees — `drawPoseSilhouette` and `poseBounds` both read it — and
 * "does this new pose read as a different shape from three metres" is a
 * question about that shape, not about the joint angles behind it.
 */
export function poseBlobs(sk: PoseSkeleton, grow = 0): PoseBlob[] {
  return [
    { a: sk.hipMid, b: sk.shoulderMid, r: P.torsoW / 2 + grow },
    { a: sk.shoulderL, b: sk.shoulderR, r: P.beltW / 2 + grow },
    { a: sk.hipL, b: sk.hipR, r: P.beltW / 2 + grow },
    { a: sk.shoulderL, b: sk.elbowL, r: P.armW / 2 + grow },
    { a: sk.elbowL, b: sk.wristL, r: P.armW / 2 + grow },
    { a: sk.shoulderR, b: sk.elbowR, r: P.armW / 2 + grow },
    { a: sk.elbowR, b: sk.wristR, r: P.armW / 2 + grow },
    { a: sk.hipL, b: sk.kneeL, r: P.legW / 2 + grow },
    { a: sk.kneeL, b: sk.ankleL, r: P.legW / 2 + grow },
    { a: sk.hipR, b: sk.kneeR, r: P.legW / 2 + grow },
    { a: sk.kneeR, b: sk.ankleR, r: P.legW / 2 + grow },
  ];
}

export interface PoseBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
}

/** Bounding box of the drawn silhouette, in torso units. */
export function poseBounds(a: PoseAngles, grow = 0): PoseBounds {
  const sk = poseSkeleton(a);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  const consider = (p: PosePoint, r: number): void => {
    minX = Math.min(minX, p.x - r);
    maxX = Math.max(maxX, p.x + r);
    minY = Math.min(minY, p.y - r);
    maxY = Math.max(maxY, p.y + r);
  };

  for (const b of poseBlobs(sk, grow)) {
    consider(b.a, b.r);
    consider(b.b, b.r);
  }
  consider(sk.head, sk.headR + grow);

  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

export interface SilhouetteOptions {
  /** Centre of the silhouette's bounding box, in screen pixels. */
  cx: number;
  cy: number;
  /** Total silhouette height in screen pixels. */
  height: number;
  color: string;
  /**
   * The display is mirrored (ARCHITECTURE.md, engine/projection.ts), so the
   * subject's left must be drawn on the left of the screen. Default true.
   */
  mirror?: boolean;
  /** Fatten every limb by this many torso units. Used for the hole's rim. */
  grow?: number;
  /**
   * Whole-element opacity. The one alpha the brand allows: fading an entire
   * object in or out over time, never tinting a colour.
   */
  alpha?: number;
}

/**
 * Draw the silhouette as a solid shape, in FLAT colour with no blur.
 *
 * The `glow` option is gone. It set `shadowBlur`, which DESIGN.md forbids
 * ("no blurry drop shadows") and which canvas charges per stroke — this
 * function issues twelve strokes and a fill, so the blur was being paid for
 * thirteen times per wall per frame. The silhouette needs neither: as the rim
 * of a hole cut in a solid ink wall it is already the highest-contrast edge on
 * screen.
 *
 * Built from overlapping filled capsules rather than one winding path, which is
 * why the hole is punched with `destination-out` on an offscreen buffer: an
 * even-odd fill would XOR every overlap back to solid and weld the hips shut.
 */
export function drawPoseSilhouette(
  ctx: CanvasRenderingContext2D,
  a: PoseAngles,
  opts: SilhouetteOptions
): void {
  const grow = opts.grow ?? 0;
  const sk = poseSkeleton(a);
  const bounds = poseBounds(a, grow);
  if (!(bounds.height > 0)) return;

  const unit = opts.height / bounds.height;
  const mirror = opts.mirror !== false ? -1 : 1;
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midY = (bounds.minY + bounds.maxY) / 2;

  const sx = (p: PosePoint): number => opts.cx + mirror * (p.x - midX) * unit;
  const sy = (p: PosePoint): number => opts.cy + (p.y - midY) * unit;

  ctx.save();
  if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;
  // Callers leave shadow state set around these calls; clear it so a limb never
  // inherits a neighbour's blur.
  ctx.shadowBlur = 0;
  ctx.strokeStyle = opts.color;
  ctx.fillStyle = opts.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const b of poseBlobs(sk, grow)) {
    ctx.lineWidth = b.r * 2 * unit;
    ctx.beginPath();
    ctx.moveTo(sx(b.a), sy(b.a));
    ctx.lineTo(sx(b.b), sy(b.b));
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(sx(sk.head), sy(sk.head), (sk.headR + grow) * unit, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}
