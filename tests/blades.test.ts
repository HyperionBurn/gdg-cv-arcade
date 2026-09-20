/**
 * THE HANDS EVERY SWIPE GAME IS PLAYED WITH, and they had no tests.
 *
 * A sweep for exported symbols that no test names found `BladeTracker` among
 * them. It is the entire input to Fruit Ninja and half of Balloon Pop: pose
 * WRISTS projected to screen pixels, with a travelled segment, an activity
 * gate and a reacquire flag.
 *
 * Three of its properties are the difference between a game and a mess, and
 * every one of them fails in the same direction — one blade harvesting the
 * whole field at once:
 *
 *   - The CUTTING EDGE is the segment the hand travelled, not where it is.
 *     At 30fps a fast swipe moves a wrist hundreds of pixels between samples,
 *     and point testing tunnels straight through everything in between.
 *   - A hand that SNAPPED rather than travelled must not carry a segment. A
 *     visibility dropout returning across the screen would otherwise cut
 *     everything on the line between where it left and where it came back.
 *   - A RESTING hand does not cut. Without the speed gate a player standing
 *     with their hands up passively harvests anything that touches them,
 *     which removes the game.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BladeTracker, DEFAULT_BLADE_TUNABLES, type Blade } from '../src/core/blades.ts';
import { POSE, POSE_LANDMARK_COUNT } from '../src/core/types.ts';
import type { Landmark } from '../src/core/types.ts';
import type { TrackedPlayer } from '../src/core/tracker.ts';

const W = 1280;
const H = 720;

/** Normalised camera space to screen pixels, unmirrored for legibility. */
const project = (nx: number, ny: number): { x: number; y: number } => ({ x: nx * W, y: ny * H });

interface Wrists {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  vis?: number;
}

function player(w: Wrists, id = 1): TrackedPlayer {
  const lm: Landmark[] = [];
  for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
    lm.push({ x: 0.5, y: 0.5, z: 0, visibility: 1 });
  }
  const vis = w.vis ?? 1;
  lm[POSE.LEFT_WRIST] = { x: w.lx, y: w.ly, z: 0, visibility: vis };
  lm[POSE.RIGHT_WRIST] = { x: w.rx, y: w.ry, z: 0, visibility: vis };
  lm[POSE.LEFT_SHOULDER] = { x: 0.59, y: 0.4, z: 0, visibility: 1 };
  lm[POSE.RIGHT_SHOULDER] = { x: 0.41, y: 0.4, z: 0, visibility: 1 };
  lm[POSE.LEFT_HIP] = { x: 0.56, y: 0.6, z: 0, visibility: 1 };
  lm[POSE.RIGHT_HIP] = { x: 0.44, y: 0.6, z: 0, visibility: 1 };

  return {
    id,
    slot: 0,
    landmarks: lm,
    raw: lm,
    centroid: { x: 0.5, y: 0.5 },
    area: 0.1,
    scale: { unit: 0.2, shoulderWidth: 0.18, torsoHeight: 0.2, valid: true, aspect: 16 / 9 },
    confidence: 1,
    speed: 0,
    age: 30,
    missing: 0,
  } as unknown as TrackedPlayer;
}

const DT = 1 / 30;

/** Step the tracker one frame, returning the left-hand blade. */
function step(tracker: BladeTracker, w: Wrists, t: { now: number }): Blade | undefined {
  t.now += DT * 1000;
  return tracker.update([player(w)], project, DT, t.now).find((b) => b.side === 'left');
}

const REST = { lx: 0.3, ly: 0.5, rx: 0.7, ry: 0.5 };

describe('BladeTracker', () => {
  test('a blade appears where the wrist is', () => {
    const tracker = new BladeTracker();
    const t = { now: 1000 };
    step(tracker, REST, t);
    const b = step(tracker, REST, t);
    assert.ok(b, 'no left blade at all');
    assert.equal(Math.round(b.x), Math.round(0.3 * W));
    assert.equal(Math.round(b.y), Math.round(0.5 * H));
  });

  /**
   * THE CUTTING EDGE. `px,py` must be where the hand WAS, so the segment
   * spans the travel. If this ever collapses to the current point, a fast
   * swipe passes through fruit without touching it.
   */
  test('the segment spans where the hand travelled, not where it is', () => {
    const tracker = new BladeTracker();
    const t = { now: 1000 };
    // 0.03 of the frame, which is 0.15 torso units — a hard swing, and still
    // inside what `maxTravelPerFrame` accepts as an arm rather than a snap.
    step(tracker, { lx: 0.2, ly: 0.5, rx: 0.7, ry: 0.5 }, t);
    const b = step(tracker, { lx: 0.23, ly: 0.5, rx: 0.7, ry: 0.5 }, t);
    assert.ok(b);
    assert.equal(b.reacquired, false, 'a plausible swipe was read as a teleport');
    assert.notEqual(Math.round(b.px), Math.round(b.x), 'the segment has no length');
    assert.equal(Math.round(b.px), Math.round(0.2 * W), 'px is not where the hand was');
    assert.equal(Math.round(b.x), Math.round(0.23 * W));
  });

  /**
   * A RESTING HAND DOES NOT CUT. Without this a player can stand with their
   * arms out and collect the field, which is not a game.
   */
  test('a still hand is inert', () => {
    const tracker = new BladeTracker();
    const t = { now: 1000 };
    let b: Blade | undefined;
    for (let f = 0; f < 10; f++) b = step(tracker, REST, t);
    assert.ok(b);
    assert.equal(b.active, false, 'a motionless hand was cutting');
  });

  /**
   * A REAL SWIPE, WHICH IS SLOWER THAN YOU WOULD GUESS. The first draft of
   * this test moved the wrist 0.12 of the frame per step — 0.6 torso units —
   * and the blade never cut, because that is not a swipe, it is a teleport,
   * and `maxTravelPerFrame` correctly refused it. A real hand covers about
   * 0.2 torso units between frames at 30fps even swung hard, so anything a
   * test asks for above that is testing the snap path by accident.
   */
  test('and a fast one cuts', () => {
    const tracker = new BladeTracker();
    const t = { now: 1000 };
    let b: Blade | undefined;
    let x = 0.2;
    for (let f = 0; f < 6; f++) {
      x += 0.03; // 0.15 torso units per frame: hard, and still an arm
      b = step(tracker, { lx: x, ly: 0.5, rx: 0.9, ry: 0.5 }, t);
    }
    assert.ok(b);
    assert.equal(b.reacquired, false, 'a plausible swipe was read as a teleport');
    assert.equal(b.active, true, 'a fast swipe was not cutting');
  });

  /**
   * The speed gate is hysteretic for the same reason every other gate here
   * is: a hand hovering at the threshold would flicker between cutting and
   * not, in the middle of a swipe.
   */
  test('the activity gate has hysteresis', () => {
    const tun = DEFAULT_BLADE_TUNABLES;
    assert.ok(
      tun.deactivateSpeed < tun.activateSpeed,
      'a single threshold makes a hand at the boundary flicker mid-swipe',
    );
  });

  /**
   * A HAND THAT SNAPPED DID NOT TRAVEL. A dropout returning on the far side
   * of the screen must not leave a segment across everything in between, and
   * the frame must be flagged so a game holding its own "was this hand
   * outside the ring" state ignores it too.
   */
  test('a wrist that vanishes and returns elsewhere does not cut the gap', () => {
    const tracker = new BladeTracker();
    const t = { now: 1000 };
    step(tracker, { lx: 0.15, ly: 0.5, rx: 0.7, ry: 0.5 }, t);
    step(tracker, { lx: 0.15, ly: 0.5, rx: 0.7, ry: 0.5 }, t);

    // Gone: below minVisibility, so the wrist is not observable at all.
    for (let f = 0; f < 4; f++) {
      step(tracker, { lx: 0.15, ly: 0.5, rx: 0.7, ry: 0.5, vis: 0.05 }, t);
    }
    // Back, on the other side of the screen.
    const b = step(tracker, { lx: 0.85, ly: 0.5, rx: 0.7, ry: 0.5 }, t);

    assert.ok(b);
    assert.equal(b.reacquired, true, 'the snap was not flagged');
    assert.equal(
      Math.round(b.px),
      Math.round(b.x),
      'a snapped blade still carried a segment across the screen',
    );
  });

  test('and the flag lasts exactly one frame', () => {
    const tracker = new BladeTracker();
    const t = { now: 1000 };
    step(tracker, { lx: 0.15, ly: 0.5, rx: 0.7, ry: 0.5 }, t);
    for (let f = 0; f < 4; f++) {
      step(tracker, { lx: 0.15, ly: 0.5, rx: 0.7, ry: 0.5, vis: 0.05 }, t);
    }
    const snapped = step(tracker, { lx: 0.85, ly: 0.5, rx: 0.7, ry: 0.5 }, t);
    assert.equal(snapped?.reacquired, true);

    const next = step(tracker, { lx: 0.86, ly: 0.5, rx: 0.7, ry: 0.5 }, t);
    assert.equal(next?.reacquired, false, 'reacquired stuck on past its frame');
  });

  /** Trails must not swap between hands, or the ribbon jumps across the body. */
  test('a blade keeps its identity per player and hand', () => {
    const tracker = new BladeTracker();
    const t = { now: 1000 };
    const first = step(tracker, { lx: 0.3, ly: 0.5, rx: 0.7, ry: 0.5 }, t);
    const later = step(tracker, { lx: 0.4, ly: 0.5, rx: 0.7, ry: 0.5 }, t);
    assert.ok(first && later);
    assert.equal(later.id, first.id);
    assert.equal(later.side, 'left');
  });
});
