/**
 * POSE MATCH — the library's promises, and the difficulty ramp's.
 *
 * REPORTED FROM A HUMAN PLAYTEST: "PERFECTIONNNNN, honestly I'd say make the
 * game harder. More pose variation also. Best game by far." So the library went
 * 12 -> 19 and the tolerance started ramping across the round — and both of
 * those are changes that can only be made safely if the things the game was
 * already getting right are nailed down first.
 *
 * `validateLibrary()` runs at module load and catches the two worst failures (a
 * wall that opens for the wrong pose, a wall that opens for a player standing
 * still). What it cannot see is everything about a REAL body: filtered
 * landmarks, aspect-squeezed coordinates, a cropped frame, MediaPipe reporting
 * the wrong arm as the left one. Those are the failures that have actually
 * reached this game, and they are what the tests below are for.
 *
 * Five promises, in the order a player meets them:
 *
 *   1. Every pose in the library is DISTINGUISHABLE from every other one and
 *      from standing still — whole-body, and with the legs out of frame, which
 *      is the framing a stall camera actually has.
 *   2. Every pose READS as a different shape, not merely scores as one. Two
 *      poses the metric can separate but a player cannot tell apart from three
 *      metres is a wall nobody can copy.
 *   3. Every pose is CLEARABLE when it is genuinely held — under hostile input,
 *      with the legs cropped, and through a sustained left/right label swap.
 *   4. No pose is clearable by STANDING STILL, and the margin that guarantees
 *      it has not moved.
 *   5. The ramp gets harder in a way a first-timer can still win.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tunables } from '../src/meta/tunables.ts';
import {
  POSES,
  REST_POSE,
  PASS_THRESHOLD,
  PASS_THRESHOLD_END,
  MAX_CONFUSION,
  CROPPED_SEGMENT_KEYS,
  CLOSE_THRESHOLD,
  validateLibrary,
  poseConfusion,
  poseSimilarity,
  poseSkeleton,
  poseBlobs,
  poseBounds,
  passThresholdAt,
  matchColor,
  matchLabel,
  achievabilityFault,
  pickPose,
  type PoseAngles,
  type PoseDef,
} from '../src/games/poses.ts';
import { POSE } from '../src/core/types.ts';
import { holdPose, poseRig, sloppy, REALISTIC, HOSTILE, rng } from './posebody.ts';
import { pct } from './scene.ts';

/**
 * The seven added after the playtest. Held by id rather than by index so the
 * assertions below keep meaning what they say if the ladder is re-ordered.
 */
const ADDED = ['bhangra', 'shampoo', 'rainbow', 'crane', 'semaphore', 'waiter', 'vogue'];

const byId = (id: string): PoseDef => {
  const p = POSES.find((q) => q.id === id);
  assert.ok(p, `no pose "${id}"`);
  return p;
};

/** Worst-case confusability of two poses, over a segment subset or all of them. */
const confuse = (a: PoseAngles, b: PoseAngles, over?: readonly string[]): number =>
  Math.max(
    poseConfusion(a, b, over as never),
    poseConfusion(b, a, over as never)
  );

/* ------------------------------------------------------------------ */
/* 1. Distinguishable — by the scorer                                  */
/* ------------------------------------------------------------------ */

describe('the pose library is internally distinguishable', () => {
  test('validateLibrary is silent, whole body and legs cropped', () => {
    assert.deepEqual(validateLibrary(), []);
  });

  test('every pose is achievable by an average person standing up', () => {
    for (const p of POSES) {
      assert.equal(achievabilityFault(p.angles), null, `${p.name} is not achievable`);
    }
  });

  test('ids and names are unique — the name is how a clear is reported', () => {
    assert.equal(new Set(POSES.map((p) => p.id)).size, POSES.length);
    assert.equal(new Set(POSES.map((p) => p.name)).size, POSES.length);
  });

  test('no pair can clear the other at the round-opening gate', () => {
    // The opening gate is the binding case: the ramp only ever raises it, so a
    // pair that cannot pass for each other at the first wall cannot at the
    // fifteenth either.
    let worst = 0;
    let pair = '';
    for (let i = 0; i < POSES.length; i++) {
      for (let j = i + 1; j < POSES.length; j++) {
        const v = confuse(POSES[i]!.angles, POSES[j]!.angles);
        if (v > worst) {
          worst = v;
          pair = `${POSES[i]!.id}/${POSES[j]!.id}`;
        }
      }
    }
    // MEASURED: goalpost/flex at 0.651, unchanged by the seven additions — the
    // worst pair in the library is one of the originals, and none of the new
    // poses came anywhere near it.
    assert.ok(worst <= MAX_CONFUSION, `${pair} is ${worst.toFixed(3)} confusable`);
    assert.ok(worst < 0.66, `worst pair ${pair} = ${worst.toFixed(3)}`);
  });

  test('the seven new poses keep a comfortable margin, not a hairline one', () => {
    // The shipped twelve got away with 0.009 of headroom on their worst pair.
    // Anything added now has to do better than that or the library is being
    // grown by spending the only safety margin it has.
    for (const id of ADDED) {
      const p = byId(id);
      let worst = 0;
      let other = '';
      for (const q of POSES) {
        if (q.id === p.id) continue;
        const v = Math.max(
          confuse(p.angles, q.angles),
          confuse(p.angles, q.angles, CROPPED_SEGMENT_KEYS)
        );
        if (v > worst) {
          worst = v;
          other = q.id;
        }
      }
      // MEASURED worst of the seven: THE CRANE at 0.600 against THE ORANGUTAN,
      // i.e. 0.060 of headroom — 6.7x what goalpost/flex lives on.
      assert.ok(
        worst <= 0.605,
        `${p.id} is ${worst.toFixed(3)} confusable with ${other}; new poses must stay under 0.605`
      );
    }
  });

  test('the guarantee survives the legs leaving the frame', () => {
    // Both legs gone leaves 0.72 coverage — over MIN_COVERAGE, so the scorer
    // carries on with arms and torso alone and is perfectly happy to open a
    // wall on that evidence. A pose whose separation lives below the waist
    // would be invisible to the whole-body check above.
    let worst = 0;
    let pair = '';
    for (let i = 0; i < POSES.length; i++) {
      for (let j = i + 1; j < POSES.length; j++) {
        const v = confuse(POSES[i]!.angles, POSES[j]!.angles, CROPPED_SEGMENT_KEYS);
        if (v > worst) {
          worst = v;
          pair = `${POSES[i]!.id}/${POSES[j]!.id}`;
        }
      }
    }
    // MEASURED: 0.522 (goalpost/flex again). Legs AGREEING is what pushes the
    // whole-body figure up, so cropping them is the easier case for this
    // library — but that is a property of these nineteen poses, not of the
    // metric, and it is exactly what stops being true when someone adds a
    // flamingo.
    assert.ok(worst <= MAX_CONFUSION, `${pair} is ${worst.toFixed(3)} confusable when cropped`);
    assert.ok(worst < 0.6, `cropped worst pair ${pair} = ${worst.toFixed(3)}`);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Distinguishable — by a person, from three metres                 */
/* ------------------------------------------------------------------ */

/**
 * The drawn silhouette as a bitmap, normalised EXACTLY as `drawPoseSilhouette`
 * normalises it: scaled to a fixed height, centred on its own bounding box.
 *
 * Built from `poseBlobs`, which is the same list the renderer strokes, so this
 * measures the shape a player is shown rather than a second opinion about it.
 * The grid is deliberately coarse — 110 x 64 over a silhouette one unit tall —
 * because the question is what survives a TV at three metres, not what a pixel
 * inspector can tell apart.
 */
const GW = 110;
const GH = 64;
const XR = 1.6;
const YR = 0.62;

function silhouetteBits(a: PoseAngles): Uint8Array {
  const sk = poseSkeleton(a);
  const caps = poseBlobs(sk);
  const bounds = poseBounds(a);
  const u = 1 / bounds.height;
  const mx = (bounds.minX + bounds.maxX) / 2;
  const my = (bounds.minY + bounds.maxY) / 2;

  const distToSeg = (
    px: number, py: number,
    ax: number, ay: number, bx: number, by: number
  ): number => {
    const vx = bx - ax;
    const vy = by - ay;
    const len = vx * vx + vy * vy;
    const t = len > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len)) : 0;
    return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
  };

  const bits = new Uint8Array(GW * GH);
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      const px = (((gx + 0.5) / GW) * 2 * XR - XR) / u + mx;
      const py = (((gy + 0.5) / GH) * 2 * YR - YR) / u + my;
      let on = Math.hypot(px - sk.head.x, py - sk.head.y) <= sk.headR;
      if (!on) {
        for (const c of caps) {
          if (distToSeg(px, py, c.a.x, c.a.y, c.b.x, c.b.y) <= c.r) {
            on = true;
            break;
          }
        }
      }
      if (on) bits[gy * GW + gx] = 1;
    }
  }
  return bits;
}

function overlap(a: Uint8Array, b: Uint8Array): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] || b[i]) union++;
    if (a[i] && b[i]) inter++;
  }
  return union > 0 ? inter / union : 1;
}

describe('the pose library is distinguishable to a person', () => {
  const bits = new Map(POSES.map((p) => [p.id, silhouetteBits(p.angles)] as const));

  test('no two new poses are the same shape wearing different angles', () => {
    // The shipped twelve contain GOALPOST/ROBOT at 0.906 overlap — genuinely
    // the same silhouette with one forearm flipped — which is the standard the
    // additions had to beat rather than match.
    for (const id of ADDED) {
      let worst = 0;
      let other = '';
      for (const q of POSES) {
        if (q.id === id) continue;
        const v = overlap(bits.get(id)!, bits.get(q.id)!);
        if (v > worst) {
          worst = v;
          other = q.id;
        }
      }
      // MEASURED worst of the seven: 0.606, THE RAINBOW against THE WAITER.
      assert.ok(
        worst <= 0.65,
        `${id} overlaps ${other} by ${worst.toFixed(3)} of its silhouette`
      );
    }
  });

  test('every pose holds its limbs clear of its own outline', () => {
    // A hand folded across the chest disappears into the chest in a silhouette,
    // and the hole stops being a shape anybody can copy. The shipped library
    // tolerates it on its three hardest poses (THE DISCO is at -0.40 torso
    // units); nothing added now is allowed to.
    for (const id of ADDED) {
      const sk = poseSkeleton(byId(id).angles);
      let worst = Infinity;
      for (const p of [sk.elbowL, sk.wristL, sk.elbowR, sk.wristR]) {
        const vx = sk.shoulderMid.x - sk.hipMid.x;
        const vy = sk.shoulderMid.y - sk.hipMid.y;
        const len = vx * vx + vy * vy;
        const t = Math.max(0, Math.min(1, ((p.x - sk.hipMid.x) * vx + (p.y - sk.hipMid.y) * vy) / len));
        const d = Math.hypot(p.x - (sk.hipMid.x + vx * t), p.y - (sk.hipMid.y + vy * t));
        worst = Math.min(worst, d - (0.62 / 2 + 0.30 / 2));
      }
      assert.ok(worst >= 0.05, `${id} buries a hand in the torso (clearance ${worst.toFixed(3)})`);
    }
  });

  test('every pose is at least as wide as the narrowest shipped one', () => {
    // THE TOUCHDOWN sets the floor at 0.418 — arms straight up is a tall thin
    // hole and it still reads. Below that the silhouette is a post.
    for (const p of POSES) {
      const b = poseBounds(p.angles);
      assert.ok(b.width / b.height >= 0.41, `${p.id} is ${(b.width / b.height).toFixed(2)} wide`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. Clearable when it is genuinely held                              */
/* ------------------------------------------------------------------ */

describe('a held pose clears its own wall', () => {
  test('under realistic and hostile input, every pose scores over its own gate', () => {
    for (const cond of [REALISTIC, HOSTILE]) {
      for (const p of POSES) {
        const player = holdPose(p.angles, { ...cond, random: rng(11) });
        assert.ok(player, `${p.id}: tracker never admitted the body`);
        const m = poseSimilarity(player, p.angles);
        assert.ok(m.valid, `${p.id}: unreadable frame`);
        // The gate at this pose's own place on the ramp, which for the hard end
        // of the library is the raised one — a pose is no use if it is only
        // clearable at the tolerance it will never actually be asked at.
        const gate = passThresholdAt(p.difficulty);
        assert.ok(m.score >= gate, `${p.id} held scored ${m.score.toFixed(3)} against ${gate.toFixed(2)}`);
      }
    }
  });

  test('a body of any size, anywhere in frame, scores the same', () => {
    // Segment DIFFERENCES kill translation, unit-normalising kills scale. "Stand
    // in the right spot" is a rule nobody at a stall will read or forgive.
    for (const p of POSES) {
      const small = holdPose(p.angles, { height: 0.5, x: 0.2 });
      const big = holdPose(p.angles, { height: 0.92, x: 0.78 });
      assert.ok(small && big, `${p.id}: no player`);
      const a = poseSimilarity(small, p.angles).score;
      const b = poseSimilarity(big, p.angles).score;
      assert.ok(Math.abs(a - b) < 0.01, `${p.id}: ${a.toFixed(3)} vs ${b.toFixed(3)}`);
    }
  });

  test('the legs leaving the frame costs coverage, not the clear', () => {
    // The normal stall framing. Both legs gone is 0.72 coverage; the scorer
    // drops them from both sides of the ratio rather than failing the player.
    const legs = [
      POSE.LEFT_KNEE, POSE.RIGHT_KNEE, POSE.LEFT_ANKLE, POSE.RIGHT_ANKLE,
      POSE.LEFT_HEEL, POSE.RIGHT_HEEL, POSE.LEFT_FOOT_INDEX, POSE.RIGHT_FOOT_INDEX,
    ];
    for (const p of POSES) {
      const player = holdPose(p.angles, { ...HOSTILE, hide: legs, random: rng(5) });
      assert.ok(player, `${p.id}: no player`);
      const m = poseSimilarity(player, p.angles);
      assert.ok(m.valid, `${p.id}: unreadable with legs cropped`);
      assert.ok(m.coverage > 0.7 && m.coverage < 0.8, `${p.id}: coverage ${m.coverage.toFixed(2)}`);
      assert.ok(
        m.score >= passThresholdAt(p.difficulty),
        `${p.id} cropped scored ${m.score.toFixed(3)}`
      );
    }
  });

  test('a sustained left/right label swap does not close the wall', () => {
    // MediaPipe's LEFT_/RIGHT_ are INFERRED and flip for runs of frames. Before
    // the mirror map, a swap turned half the library unclearable no matter how
    // perfectly the player held the shape — the scorer compared the player's
    // right arm against the target's left, so a mirrored limb read as maximally
    // wrong rather than merely different. Seven new poses is seven new chances
    // for that to come back, and five of the seven are asymmetric.
    for (const p of POSES) {
      const straight = holdPose(p.angles, { ...HOSTILE, random: rng(3) });
      const swapped = holdPose(p.angles, { ...HOSTILE, swapLabels: true, random: rng(3) });
      assert.ok(straight && swapped, `${p.id}: no player`);
      const a = poseSimilarity(straight, p.angles);
      const b = poseSimilarity(swapped, p.angles);
      assert.ok(b.valid, `${p.id}: unreadable while swapped`);
      assert.ok(
        b.score >= passThresholdAt(p.difficulty),
        `${p.id} swapped scored ${b.score.toFixed(3)}, straight ${a.score.toFixed(3)}`
      );
    }
  });

  test('a swap that starts mid-hold is ridden out, not reacted to', () => {
    // The real shape of the failure: a body holding still while MediaPipe
    // changes its mind. Detection has to switch over inside the same frame the
    // labels do, or the player watches a held pose fall apart for no reason.
    for (const p of POSES.slice(0, 6)) {
      const rig = poseRig({ ...HOSTILE, random: rng(17) });
      let worstAfter = 1;
      for (let f = 0; f < 90; f++) {
        const player = rig.step(p.angles, f >= 45 ? { swapLabels: true } : {});
        if (!player || f < 40) continue;
        const m = poseSimilarity(player, p.angles);
        // Two frames of grace either side of the switch: One Euro blends the
        // two states across the transition and the blended skeleton is
        // genuinely neither pose. `best` is a decaying peak so it rides over.
        if (f >= 48) worstAfter = Math.min(worstAfter, m.valid ? m.score : 0);
      }
      assert.ok(
        worstAfter >= passThresholdAt(p.difficulty),
        `${p.id}: dropped to ${worstAfter.toFixed(3)} after the labels flipped`
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4. Not clearable by standing still                                  */
/* ------------------------------------------------------------------ */

describe('standing still clears nothing', () => {
  test('an idle body never reaches the gate, however the forearms drop out', () => {
    // The single worst failure this game has, and it is not even legible as a
    // bug — it just looks like the wall was free. It has happened: with both
    // forearms unseen, THE FLEX was indistinguishable from standing at rest and
    // a player who stood still for a full round finished with a score.
    //
    // MEASURED here, 19 poses x 4 dropout patterns x 40 samples: max idle score
    // 0.461 against a 0.66 gate. The seven additions do not move it — the pose
    // an idle body scores best against is still THE FLEX, at 0.349 ideal.
    const r = rng(4242);
    const patterns: Array<readonly number[]> = [
      [],
      [POSE.LEFT_WRIST, POSE.LEFT_PINKY, POSE.LEFT_INDEX, POSE.LEFT_THUMB],
      [POSE.RIGHT_WRIST, POSE.RIGHT_PINKY, POSE.RIGHT_INDEX, POSE.RIGHT_THUMB],
      [
        POSE.LEFT_WRIST, POSE.LEFT_PINKY, POSE.LEFT_INDEX, POSE.LEFT_THUMB,
        POSE.RIGHT_WRIST, POSE.RIGHT_PINKY, POSE.RIGHT_INDEX, POSE.RIGHT_THUMB,
      ],
    ];
    let max = 0;
    let worst = '';
    for (const hide of patterns) {
      for (let rep = 0; rep < 40; rep++) {
        const player = holdPose(REST_POSE, { ...HOSTILE, hide, random: r }, 20);
        if (!player) continue;
        for (const p of POSES) {
          const m = poseSimilarity(player, p.angles);
          const score = m.valid ? m.score : 0;
          if (score > max) {
            max = score;
            worst = `${p.id} (${hide.length} landmarks hidden)`;
          }
        }
      }
    }
    assert.ok(max < PASS_THRESHOLD, `idle body scored ${max.toFixed(3)} against ${worst}`);
    // Keep the headroom, not just the pass. The threshold is a live slider and
    // 0.55 is the first thing a marshal would try.
    assert.ok(max < 0.55, `idle headroom gone: ${max.toFixed(3)} against ${worst}`);
  });

  test('no pose in the library is close to standing still on paper either', () => {
    for (const p of POSES) {
      assert.ok(
        confuse(REST_POSE, p.angles) <= 0.55,
        `${p.id} is ${confuse(REST_POSE, p.angles).toFixed(3)} like standing still`
      );
      assert.ok(
        confuse(REST_POSE, p.angles, CROPPED_SEGMENT_KEYS) <= 0.55,
        `${p.id} is like standing still once the legs crop`
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* 5. The ramp                                                         */
/* ------------------------------------------------------------------ */

describe('the difficulty ramp', () => {
  test('the gate only ever climbs, and starts where it always did', () => {
    assert.equal(passThresholdAt(0), PASS_THRESHOLD);
    assert.equal(passThresholdAt(1), PASS_THRESHOLD_END);
    let last = -1;
    for (let d = 0; d <= 1.0001; d += 0.05) {
      const g = passThresholdAt(d);
      assert.ok(g >= last, `gate went backwards at ${d.toFixed(2)}`);
      last = g;
    }
    // Out of range must clamp rather than extrapolate — `wallDifficulty` is a
    // sum of two terms and the cleared-count one has no natural ceiling.
    assert.equal(passThresholdAt(-1), PASS_THRESHOLD);
    assert.equal(passThresholdAt(5), PASS_THRESHOLD_END);
  });

  test('the raised gate never rises above what a held pose actually scores', () => {
    // The end of the ramp is only fair if hitting the shape still clears it.
    assert.ok(PASS_THRESHOLD_END < 0.95, 'no room left for a real body');
    assert.ok(PASS_THRESHOLD_END > CLOSE_THRESHOLD, 'the gate must stay above CLOSE');
    for (const p of POSES) {
      const player = holdPose(p.angles, { ...HOSTILE, random: rng(23) });
      assert.ok(player);
      assert.ok(
        poseSimilarity(player, p.angles).score >= PASS_THRESHOLD_END,
        `${p.id} cannot clear the last wall of a round even held perfectly`
      );
    }
  });

  test('the ramp widens the gap between the gate and the worst confusable pair', () => {
    // The whole reason a rising gate is safe: "you cleared by doing a different
    // pose" gets HARDER as the round goes on, never easier.
    let worst = 0;
    for (let i = 0; i < POSES.length; i++) {
      for (let j = i + 1; j < POSES.length; j++) {
        worst = Math.max(worst, confuse(POSES[i]!.angles, POSES[j]!.angles));
      }
    }
    assert.ok(passThresholdAt(0) - worst > 0, 'the first wall is already unsafe');
    assert.ok(
      passThresholdAt(1) - worst > 0.15,
      `the last wall only has ${(passThresholdAt(1) - worst).toFixed(3)} of headroom`
    );
  });

  test('the last wall of a round is still winnable by someone copying the shape', () => {
    // THE POINT OF THE WHOLE CHANGE, and the thing it must not cost: the queue
    // is full of people who have never done this. A player within ~20 degrees a
    // joint has done the pose as far as anyone watching is concerned, and the
    // hardest wall in the round has to agree.
    //
    // MEASURED, clear rate at the end-of-round gate, HOSTILE input:
    //   16 deg  100%     24 deg  ~94%     32 deg  ~60%     40 deg  ~30%
    // against, at the opening gate: 100% / 100% / 94% / 75%. Sloppiness is what
    // got harder, not the pose.
    const r = rng(808);
    const rate = (sigma: number, gate: number): number => {
      let hit = 0;
      let n = 0;
      for (let rep = 0; rep < 8; rep++) {
        for (const p of POSES) {
          const player = holdPose(sloppy(p.angles, sigma, r), { ...HOSTILE, random: r }, 32);
          n++;
          if (!player) continue;
          const m = poseSimilarity(player, p.angles);
          if (m.valid && m.score >= gate) hit++;
        }
      }
      return hit / n;
    };

    const end = passThresholdAt(1);
    const good = rate(16, end);
    const rough = rate(24, end);
    const flail = rate(40, end);

    assert.ok(good > 0.97, `a good copy only clears the last wall ${(good * 100).toFixed(0)}%`);
    assert.ok(rough > 0.85, `a rough copy only clears the last wall ${(rough * 100).toFixed(0)}%`);
    // And it has to actually BE harder, or the ramp is decoration.
    assert.ok(flail < 0.55, `a flail still clears the last wall ${(flail * 100).toFixed(0)}%`);
    assert.ok(
      rate(40, passThresholdAt(0)) > flail + 0.2,
      'the first and last walls of a round are the same difficulty'
    );
  });

  test('the first wall of a round is gentle', () => {
    // A stranger's first wall must be the easiest thing in the game. Repeated
    // because `pickPose` is random and the promise is about the distribution.
    const easy = new Set(['t', 'touchdown', 'taxi', 'goalpost', 'flex']);
    let gentle = 0;
    for (let i = 0; i < 500; i++) if (easy.has(pickPose(0, []).id)) gentle++;
    assert.ok(gentle / 500 > 0.9, `only ${gentle / 5}% of opening walls were an easy pose`);
    assert.equal(passThresholdAt(0), PASS_THRESHOLD, 'the first wall uses the shipped tolerance');
  });

  test('a round of fifteen walls is varied and ramps', () => {
    // The ladder has to be usable, not merely sorted: with twelve poses a
    // fifteen-wall round FORCED three repeats however the no-repeat window was
    // set. MEASURED over 2000 simulated rounds with nineteen: 0.00 repeats and
    // a mean difficulty-target error of 0.127, down from 0.163.
    let repeats = 0;
    let err = 0;
    let rising = 0;
    const rounds = 2000;
    for (let round = 0; round < rounds; round++) {
      const recent: string[] = [];
      const seen: string[] = [];
      let first = 0;
      let last = 0;
      for (let w = 0; w < 15; w++) {
        const target = Math.min(1, (w / 14) * 0.9 + w * 0.035);
        const p = pickPose(target, recent);
        err += Math.abs(p.difficulty - target);
        if (seen.includes(p.id)) repeats++;
        seen.push(p.id);
        recent.push(p.id);
        if (recent.length > Math.max(3, POSES.length - 4)) recent.shift();
        if (w < 3) first += p.difficulty / 3;
        if (w >= 12) last += p.difficulty / 3;
      }
      if (last > first) rising++;
    }
    assert.ok(repeats / rounds < 0.05, `${(repeats / rounds).toFixed(2)} repeats per round`);
    assert.ok(err / (rounds * 15) < 0.16, `difficulty targeting is ${(err / (rounds * 15)).toFixed(3)} off`);
    assert.ok(rising / rounds > 0.99, `only ${((rising / rounds) * 100).toFixed(1)}% of rounds got harder`);
  });

  test('green still means the wall will open, at every point on the ramp', () => {
    // The rule the CLOSE_THRESHOLD comment is built on: the player is told the
    // same thing by the colour, the word and the number, and all three have to
    // agree with the gate the wall is actually judged at. A ramping gate is
    // exactly how that gets broken.
    for (const d of [0, 0.25, 0.5, 0.75, 1]) {
      const gate = passThresholdAt(d);
      assert.equal(matchLabel(gate, gate), '<MATCH>');
      assert.equal(matchLabel(gate - 0.001, gate), 'CLOSE');
      assert.notEqual(matchColor(gate, gate), matchColor(gate - 0.001, gate));
      // And a score that is green at the opening gate must NOT read green at a
      // wall that has moved past it.
      if (d > 0) assert.equal(matchLabel(PASS_THRESHOLD, gate), 'CLOSE');
    }
  });
});

/* ------------------------------------------------------------------ */
/* Live meter                                                          */
/* ------------------------------------------------------------------ */

test('the live meter climbs all the way, so a player learns from it', () => {
  // The game's second pillar: "the live state teaches it in one attempt." A
  // meter that sits at 0 and jumps straight to a pass teaches nothing, and that
  // is a real regression mode — applying the rest-margin guard unconditionally
  // once produced exactly that. NOT YET, CLOSE and <MATCH> must all appear, in
  // order, on the way into every pose.
  const lerp = (a: PoseAngles, b: PoseAngles, t: number): PoseAngles => {
    const out = {} as Record<string, number>;
    for (const k of Object.keys(a)) {
      out[k] = (a as never as Record<string, number>)[k]! +
        ((b as never as Record<string, number>)[k]! - (a as never as Record<string, number>)[k]!) * t;
    }
    return out as never as PoseAngles;
  };

  for (const p of POSES) {
    const rig = poseRig({ ...REALISTIC, random: rng(61) });
    const seen: string[] = [];
    const gate = passThresholdAt(p.difficulty);
    for (let f = 0; f < 150; f++) {
      const u = Math.max(0, Math.min(1, (f / 60 - 0.4) / 0.9));
      const player = rig.step(lerp(REST_POSE, p.angles, u * u * (3 - 2 * u)));
      if (!player || f < 30) continue;
      const m = poseSimilarity(player, p.angles);
      const label = m.valid ? matchLabel(m.score, gate) : 'NOT YET';
      if (seen[seen.length - 1] !== label) seen.push(label);
    }
    assert.ok(seen.includes('CLOSE'), `${p.id}: the meter never said CLOSE on the way in`);
    assert.ok(seen.includes('<MATCH>'), `${p.id}: the meter never reached <MATCH>`);
    assert.ok(
      seen.indexOf('CLOSE') < seen.indexOf('<MATCH>'),
      `${p.id}: the meter went green before it went yellow`
    );
  }
});

/* ------------------------------------------------------------------ */
/* Percentiles, printed rather than asserted                           */
/* ------------------------------------------------------------------ */

test('held-pose score distribution, for the record', () => {
  // Not a gate — a printout, so the numbers quoted in poses.ts can be checked
  // against the code rather than trusted.
  const r = rng(1);
  const scores: number[] = [];
  for (let rep = 0; rep < 4; rep++) {
    for (const p of POSES) {
      const player = holdPose(p.angles, { ...HOSTILE, random: r }, 32);
      if (!player) continue;
      const m = poseSimilarity(player, p.angles);
      scores.push(m.valid ? m.score : 0);
    }
  }
  assert.ok(scores.length > 60);
  assert.ok(pct(scores, 0.01) > PASS_THRESHOLD_END, `p01 of a held pose is ${pct(scores, 0.01).toFixed(3)}`);
});
