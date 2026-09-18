/**
 * The gesture detectors, which every game is built on and none of them tested.
 *
 * These are not hypothetical cases. Every describe block below corresponds to a
 * bug that actually shipped in this repo and was found by a human standing in
 * front of a camera, days before the event:
 *
 *   - thresholds compared an x-delta against an isotropic torso unit, so every
 *     sideways gesture was wrong by the aspect ratio (1.78x at 16:9)
 *   - RepCounter re-armed below the ELBOW, a position a pumping arm never
 *     reaches, so the rep gate was effectively impossible to satisfy
 *   - Hysteresis was assumed symmetric, and the inverted form is used for the
 *     gestures where "past the gate" means a SMALLER number
 *
 * They are cheap, they run in Node, and any one of them failing means a game is
 * broken in a way that is very hard to see on screen.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  Hysteresis,
  Baseline,
  MotionEnergy,
  LaneDetector,
  TPoseDetector,
} from '../src/core/gestures.ts';
import { POSE, POSE_LANDMARK_COUNT } from '../src/core/types.ts';
import type { Landmark } from '../src/core/types.ts';
import type { TrackedPlayer } from '../src/core/tracker.ts';

/**
 * A tracked player whose landmarks you can poke.
 *
 * `aspect` defaults to 16:9 because that is what the app runs at, and the whole
 * point of several of these tests is that the aspect must be applied.
 */
function player(mods: (lm: Landmark[]) => void = () => {}, aspect = 16 / 9): TrackedPlayer {
  const lm: Landmark[] = [];
  for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
    lm.push({ x: 0.5, y: 0.5, z: 0, visibility: 1 });
  }
  const set = (i: number, x: number, y: number): void => {
    lm[i] = { x, y, z: 0, visibility: 1 };
  };
  // Shoulders 0.18 apart in x, hips 0.2 below — a torso unit of ~0.2.
  set(POSE.LEFT_SHOULDER, 0.59, 0.4);
  set(POSE.RIGHT_SHOULDER, 0.41, 0.4);
  set(POSE.LEFT_HIP, 0.56, 0.6);
  set(POSE.RIGHT_HIP, 0.44, 0.6);
  set(POSE.LEFT_ELBOW, 0.62, 0.5);
  set(POSE.RIGHT_ELBOW, 0.38, 0.5);
  set(POSE.LEFT_WRIST, 0.64, 0.6);
  set(POSE.RIGHT_WRIST, 0.36, 0.6);
  set(POSE.NOSE, 0.5, 0.3);
  mods(lm);

  return {
    id: 1,
    slot: 0,
    landmarks: lm,
    raw: lm,
    centroid: { x: 0.5, y: 0.5 },
    area: 0.1,
    scale: {
      unit: 0.2,
      shoulderWidth: 0.18 * aspect,
      torsoHeight: 0.2,
      valid: true,
      aspect,
    },
    confidence: 1,
    age: 30,
    missing: 0,
    confirmed: true,
  };
}

describe('Hysteresis', () => {
  test('needs the enter level, then holds until the exit level', () => {
    const h = new Hysteresis(1, 0.5);
    assert.equal(h.update(0.9), false, 'below enter');
    assert.equal(h.update(1.1), true, 'crosses enter');
    assert.equal(h.update(0.7), true, 'between exit and enter: HOLDS');
    assert.equal(h.update(0.4), false, 'below exit: releases');
  });

  test('the inverted form gates on going BELOW', () => {
    // Used where "past the gate" means lower — screen y grows downward, so a
    // wrist raised above a shoulder is a SMALLER number. Getting this backwards
    // silently inverts a whole game.
    const h = new Hysteresis(-1, -0.5, true);
    assert.equal(h.update(0.9), false, 'well above: inactive');
    assert.equal(h.update(-1.1), true, 'drops past enter');
    assert.equal(h.update(-0.7), true, 'between enter and exit: HOLDS');
    assert.equal(h.update(-0.4), false, 'back above exit: releases');
  });

  test('reset clears the latch rather than leaving it open', () => {
    const h = new Hysteresis(1, 0.5);
    h.update(2);
    assert.equal(h.update(0.7), true);
    h.reset();
    assert.equal(h.update(0.7), false, 'a reset gate must not still be open');
  });
});

describe('Baseline', () => {
  test('adopts the first sample instead of easing up from zero', () => {
    // Starting at 0 and easing means the first second of every round is judged
    // against a standing height nobody has.
    const b = new Baseline(0.02);
    assert.equal(b.update(0.42, true), 0.42);
  });

  test('only drifts while settled', () => {
    const b = new Baseline(0.5);
    b.update(0.4, true);
    const moved = b.update(0.8, false);
    assert.equal(moved, 0.4, 'must not learn a height taken mid-jump');
    const settled = b.update(0.8, true);
    assert.ok(settled > 0.4 && settled < 0.8, `expected drift, got ${settled}`);
  });
});

describe('MotionEnergy', () => {
  test('the first sample is zero, not a teleport', () => {
    // There is no previous frame to difference against. Reporting anything but
    // zero makes every detector see a violent flail on the frame a player is
    // first seen — which is exactly when Red Light is deciding who is standing
    // still.
    const m = new MotionEnergy(1);
    assert.equal(m.update(player()), 0);
  });

  test('a motionless body reads zero', () => {
    const m = new MotionEnergy(1);
    const p = player();
    m.update(p);
    assert.equal(m.update(p), 0);
  });

  test('movement reads above zero and scales with distance', () => {
    const m = new MotionEnergy(1);
    m.update(player());
    const small = m.update(player((lm) => (lm[POSE.LEFT_WRIST]!.y += 0.01)));

    const m2 = new MotionEnergy(1);
    m2.update(player());
    const big = m2.update(player((lm) => (lm[POSE.LEFT_WRIST]!.y += 0.04)));

    assert.ok(small > 0, 'a moved landmark must register');
    assert.ok(big > small, `${big} should exceed ${small}`);
  });

  test('reset makes the next sample zero again', () => {
    const m = new MotionEnergy(1);
    m.update(player());
    m.update(player((lm) => (lm[POSE.LEFT_WRIST]!.y += 0.05)));
    m.reset();
    assert.equal(m.update(player()), 0, 'after a dropout the history is stale');
  });
});

describe('LaneDetector — aspect correction', () => {
  /**
   * THE BUG THIS PINS: lane position is a horizontal offset measured in torso
   * units. Landmark x is normalised by frame WIDTH and `unit` is a torso height,
   * i.e. a fraction of frame HEIGHT — so dividing one by the other without
   * scaling x understates every sideways movement by the aspect ratio. Both
   * halves look individually correct, which is what made it survive review.
   *
   * At 16:9 that is 1.78x, and it was reported from a real playtest as "runner
   * didn't detect movement": a genuine side-step read as 0.31 torso units
   * against an `enter` of 0.55, so nothing registered until the player lunged.
   *
   * The numbers below are chosen to straddle the gate. A 0.08 shoulder shift
   * over a 0.2 torso unit is 0.71 corrected (fires) and 0.40 uncorrected (does
   * not). A square aspect is arithmetically identical to the uncorrected code,
   * so this asserts the correction is applied rather than merely present.
   */
  const step = (lm: Landmark[]): void => {
    lm[POSE.LEFT_SHOULDER]!.x += 0.08;
    lm[POSE.RIGHT_SHOULDER]!.x += 0.08;
  };

  /** Settle the centre baseline on a still, centred body. */
  const settled = (aspect: number): LaneDetector => {
    const d = new LaneDetector();
    for (let i = 0; i < 400; i++) d.update(player(() => {}, aspect));
    return d;
  };

  test('a real side-step changes lane at 16:9', () => {
    const d = settled(16 / 9);
    let lane = 0;
    for (let i = 0; i < 5; i++) lane = d.update(player(step, 16 / 9));
    assert.notEqual(lane, 0, 'a 0.71-unit step must cross the 0.55 gate');
  });

  test('the same step does NOT fire without the aspect correction', () => {
    // A square aspect makes the correction a no-op, reproducing the shipped bug.
    const d = settled(1);
    let lane = 0;
    for (let i = 0; i < 5; i++) lane = d.update(player(step, 1));
    assert.equal(lane, 0, 'uncorrected, 0.40 units should not reach the gate');
  });

  test('a centred body stays in the middle lane', () => {
    const d = new LaneDetector();
    let lane = 99;
    for (let i = 0; i < 300; i++) lane = d.update(player());
    assert.equal(lane, 0, 'standing still must not drift between lanes');
  });
});

describe('TPoseDetector', () => {
  /**
   * Wrists level with the shoulders and extended by 0.12 in x.
   *
   * A REAL arm, deliberately. Over a 0.2 torso unit that is 1.07 units
   * corrected and 0.60 uncorrected, which straddles the 0.7 gate — so these
   * tests distinguish "the correction is applied" from "the correction exists".
   * Picking a wider, unrealistic span would clear the gate either way and
   * assert nothing, which is how the bug survived in the first place.
   */
  const tpose = (lm: Landmark[]): void => {
    lm[POSE.LEFT_WRIST] = { x: 0.59 + 0.12, y: 0.4, z: 0, visibility: 1 };
    lm[POSE.RIGHT_WRIST] = { x: 0.41 - 0.12, y: 0.4, z: 0, visibility: 1 };
  };

  test('arms at rest report no progress', () => {
    const d = new TPoseDetector();
    let p = 1;
    for (let i = 0; i < 120; i++) p = d.update(player(), 1000 + i * 16.7);
    assert.equal(p, 0);
  });

  test('a held T-pose fills over the hold and completes', () => {
    const d = new TPoseDetector(0.35, 0.7, 500);
    assert.equal(d.update(player(tpose), 1000), 0, 'starts empty');
    const mid = d.update(player(tpose), 1300);
    assert.ok(mid > 0 && mid < 1, `expected a partial fill, got ${mid}`);
    assert.equal(d.update(player(tpose), 1600), 1, 'completes past the hold');
  });

  test('dropping the arms restarts the hold', () => {
    const d = new TPoseDetector(0.35, 0.7, 500);
    d.update(player(tpose), 1000);
    d.update(player(), 1300);
    assert.equal(d.update(player(tpose), 1600), 0, 'the hold must restart at 0');
  });

  test('the pose is unreachable without aspect correction', () => {
    // `extension` 0.7 uncorrected demands 1.25 torso units of horizontal arm at
    // 16:9 — longer than an arm actually is — so the ring could never complete.
    const d = new TPoseDetector(0.35, 0.7, 500);
    d.update(player(tpose, 1), 1000);
    assert.equal(
      d.update(player(tpose, 1), 1600),
      0,
      'at a square aspect this arm span is below the gate'
    );
  });
});
