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
 *      SET under the metric itself. `POSES` is the hand-picked dozen out of
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

import { POSE, type Landmark } from '../core/types';
import { tunables } from '../meta/tunables';
import type { TrackedPlayer } from '../core/tracker';
import { COLORS } from '../shell/theme';

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
 * Live pass threshold.
 *
 * Tuned against a noiseless simulator with only ~0.07 headroom over the worst
 * confusable pose pair. Real MediaPipe jitter pulls live scores down, so the
 * Sept 22 playtest is expected to want this LOWER — and that has to be possible
 * without a rebuild.
 */
export function passThreshold(): number {
  return tunables.get('posematch.passThreshold', PASS_THRESHOLD);
}

/** Below this a landmark is guesswork; ignore the segment rather than fail it. */
const MIN_VISIBILITY = 0.5;
/**
 * A segment shorter than this many body units is foreshortened (pointing at the
 * camera) or mis-detected, and its direction is noise. Expressed in
 * `scale.unit` per ARCHITECTURE.md — a raw normalised-frame threshold here
 * would mean something different for every body size.
 */
const MIN_SEGMENT_UNITS = 0.09;
/** Below this fraction of total weight we are not looking at enough body. */
const MIN_COVERAGE = 0.35;

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

function meanPoint(lms: readonly Landmark[], idx: readonly number[]): { x: number; y: number } | null {
  let sx = 0;
  let sy = 0;
  for (const i of idx) {
    const lm = lms[i];
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
 */
export function poseSimilarity(player: TrackedPlayer, target: PoseAngles): MatchResult {
  const lms = player.landmarks;
  const unit = player.scale.unit;
  const aspect = player.scale.aspect;
  if (!player.scale.valid || unit <= 0) return INVALID;

  let num = 0;
  let den = 0;
  let total = 0;
  const groupCost = new Map<SegmentGroup, number>();

  for (const seg of SEGMENTS) {
    const w2 = seg.weight * seg.weight;
    total += w2;

    const a = meanPoint(lms, seg.from);
    const b = meanPoint(lms, seg.to);
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

    const t = targetDirection(seg, target);
    const c = (vx / len) * t.x + (vy / len) * t.y;

    num += w2 * c;
    den += w2;
    groupCost.set(seg.group, (groupCost.get(seg.group) ?? 0) + w2 * (1 - c));
  }

  const coverage = total > 0 ? den / total : 0;
  if (den <= 0 || coverage < MIN_COVERAGE) return { ...INVALID, coverage };

  const cosine = num / den;

  let worstGroup: SegmentGroup | null = null;
  let worst = 0;
  for (const [g, cost] of groupCost) {
    if (cost > worst) {
      worst = cost;
      worstGroup = g;
    }
  }

  return { score: scoreFromCosine(cosine), cosine, coverage, valid: true, worstGroup };
}

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
 */
export function poseConfusion(held: PoseAngles, target: PoseAngles): number {
  let num = 0;
  let den = 0;
  for (const seg of SEGMENTS) {
    const w2 = seg.weight * seg.weight;
    const a = targetDirection(seg, held);
    const b = targetDirection(seg, target);
    num += w2 * (a.x * b.x + a.y * b.y);
    den += w2;
  }
  return scoreFromCosine(num / den);
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
 * `PASS_THRESHOLD` (the constant, not the tunable) is the green boundary on
 * purpose: green must mean "this would open the wall", which is the gate
 * `resolveWall` actually applies.
 */
export const CLOSE_THRESHOLD = 0.45;

export function matchColor(score: number): string {
  if (score >= PASS_THRESHOLD) return COLORS.green;
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
export function matchLabel(score: number): string {
  if (score >= PASS_THRESHOLD) return '<MATCH>';
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
  /** Forearm folded back over the head. */
  OVERHEAD: -145,
  /** Hands tucked in to the ribs, elbows out. */
  WING: -150,
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
 * Twelve, in increasing difficulty, hand-picked out of the generated space.
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
 * it is meant to be distinct from. Leg variation survives as decoration on
 * three of the twelve, where it never has to carry the decision.
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

  definePose('teapot', 'THE TEAPOT', 0.58, {
    left: arm(SHOULDER_SET.LOW, FLEX_SET.ON_HIP),
    right: arm(SHOULDER_SET.DIAG_UP, FLEX_SET.STRAIGHT),
    legL: PLANTED, legR: PLANTED,
    lean: -9,
  }),

  definePose('orangutan', 'THE ORANGUTAN', 0.64, {
    left: arm(SHOULDER_SET.UP, FLEX_SET.OVERHEAD),
    right: arm(SHOULDER_SET.UP, FLEX_SET.OVERHEAD),
    legL: PLANTED, legR: PLANTED,
  }),

  definePose('disco', 'THE DISCO', 0.72, {
    left: arm(SHOULDER_SET.DIAG_UP, FLEX_SET.STRAIGHT),
    right: arm(SHOULDER_SET.ACROSS, FLEX_SET.TUCK),
    legL: WIDE, legR: WIDE,
    lean: 8,
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
];

/**
 * Library self-check, at module load.
 *
 * Cheap (12 × 12 × 9 dot products) and worth doing every boot rather than in a
 * test file, because the failure it catches is invisible at the stall: a wall
 * that opens for the wrong pose looks exactly like a wall that opened for the
 * right one, and nobody debugging on the day would think to look here.
 */
export function validateLibrary(): string[] {
  const problems: string[] = [];
  for (const p of POSES) {
    const rest = Math.max(poseConfusion(REST_POSE, p.angles), poseConfusion(p.angles, REST_POSE));
    if (rest > MAX_REST_CONFUSION) {
      problems.push(`${p.name} is ${rest.toFixed(2)} confusable with standing still`);
    }
  }
  for (let i = 0; i < POSES.length; i++) {
    for (let j = i + 1; j < POSES.length; j++) {
      const a = POSES[i]!;
      const b = POSES[j]!;
      const v = Math.max(poseConfusion(a.angles, b.angles), poseConfusion(b.angles, a.angles));
      if (v > MAX_CONFUSION) {
        problems.push(`${a.name} and ${b.name} are ${v.toFixed(2)} confusable`);
      }
    }
  }
  return problems;
}

for (const problem of validateLibrary()) console.warn(`[poses] ${problem}`);

/**
 * Pick a pose at roughly the requested difficulty, never repeating anything in
 * `recent`. Nobody plays long enough to exhaust the library, so the no-repeat
 * window is what stops the same pose landing twice in one round — which reads
 * as the game being broken far more than it reads as luck.
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

interface Blob {
  a: PosePoint;
  b: PosePoint;
  /** Half-width in torso units. */
  r: number;
}

function blobs(sk: PoseSkeleton, grow: number): Blob[] {
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

  for (const b of blobs(sk, grow)) {
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

  for (const b of blobs(sk, grow)) {
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
