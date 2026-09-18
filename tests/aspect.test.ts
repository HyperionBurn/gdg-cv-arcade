/**
 * The camera aspect reaches every tracker, not just the one that asked.
 *
 * MediaPipe normalises x by frame WIDTH and y by frame HEIGHT, so landmark
 * space is anisotropic and every body measurement is wrong by exactly the
 * aspect ratio unless it is corrected. `GameBase` pushed the real aspect into
 * its tracker every frame. The four SHELL trackers — attract, menu, initials,
 * rigcheck — never did, so they ran at the 16:9 default forever.
 *
 * On a 4:3 webcam that is a 33% error in `scale.shoulderWidth`, which is the
 * denominator of the hand cursor's reach box: the control every visitor uses to
 * choose a game would have been a third too twitchy sideways, and nothing in
 * the app would have said so.
 *
 * These tests pin the contract that fixed it: a tracker follows the live camera
 * unless its owner has deliberately pinned an aspect.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PoseTracker,
  setCameraAspect,
  getCameraAspect,
  DEFAULT_TRACKER_OPTIONS,
} from '../src/core/tracker.ts';
import { POSE, POSE_LANDMARK_COUNT } from '../src/core/types.ts';
import type { Landmark, RawPose } from '../src/core/types.ts';

/** A plausible upright body centred at (cx, cy). Shoulders are horizontal. */
function body(cx = 0.5, cy = 0.5, shoulderHalf = 0.09, torso = 0.2): RawPose {
  const landmarks: Landmark[] = [];
  for (let i = 0; i < POSE_LANDMARK_COUNT; i++) {
    landmarks.push({ x: cx, y: cy, z: 0, visibility: 1 });
  }
  const set = (i: number, x: number, y: number): void => {
    landmarks[i] = { x, y, z: 0, visibility: 1 };
  };
  set(POSE.LEFT_SHOULDER, cx + shoulderHalf, cy - torso / 2);
  set(POSE.RIGHT_SHOULDER, cx - shoulderHalf, cy - torso / 2);
  set(POSE.LEFT_HIP, cx + shoulderHalf * 0.7, cy + torso / 2);
  set(POSE.RIGHT_HIP, cx - shoulderHalf * 0.7, cy + torso / 2);
  return { landmarks, worldLandmarks: landmarks, score: 1 };
}

/**
 * Run enough frames for the track to be ADMITTED, then return it.
 *
 * Long enough to cover the stillness gate, not just `minAgeToConfirm`: a body
 * now has to be seen standing still for `minSpeedSpanSec + admitStillSec`
 * before it counts as a player, which at 30fps is about 14 frames. See
 * `admitSpeedTorsos` in tracker.ts for why.
 */
const SETTLE_FRAMES = 30;

function settle(tracker: PoseTracker, pose: RawPose): ReturnType<PoseTracker['update']>[0] {
  let out = tracker.update([pose], 0);
  for (let i = 1; i <= SETTLE_FRAMES; i++) out = tracker.update([pose], i / 30);
  return out[0];
}

test('a still body is admitted well inside the settle window', () => {
  // Pins the promise the helper above relies on, and the one a player makes
  // when they walk up and stop: under half a second, not two.
  const tracker = new PoseTracker({ maxPlayers: 1 });
  const pose = body();
  let first = -1;
  for (let i = 0; i <= 60; i++) {
    if (tracker.update([pose], i / 30).length > 0) {
      first = i;
      break;
    }
  }
  assert.ok(first >= 0 && first <= 16, `admitted at frame ${first}, expected <= 16`);
  assert.ok(
    DEFAULT_TRACKER_OPTIONS.minAgeToConfirm > 0,
    'minAgeToConfirm is still the floor under the stillness gate'
  );
});

describe('camera aspect reaches every tracker', () => {
  beforeEach(() => {
    setCameraAspect(16 / 9);
  });

  test('defaults to 16:9, the common webcam shape', () => {
    assert.equal(getCameraAspect(), 16 / 9);
  });

  test('a tracker that was never told an aspect follows the camera', () => {
    setCameraAspect(4 / 3);
    const tracker = new PoseTracker({ maxPlayers: 1 });
    const player = settle(tracker, body());
    assert.ok(player, 'expected a confirmed player');
    assert.equal(player.scale.aspect, 4 / 3);
  });

  test('changing the camera changes what an unpinned tracker measures', () => {
    const tracker = new PoseTracker({ maxPlayers: 1 });
    const wide = settle(tracker, body());
    const wideWidth = wide.scale.shoulderWidth;

    setCameraAspect(4 / 3);
    const narrow = settle(new PoseTracker({ maxPlayers: 1 }), body());

    // Shoulder width is almost entirely horizontal, so it scales with the
    // aspect the measurement is taken in. This is the number that was silently
    // wrong on every shell screen.
    const ratio = wideWidth / narrow.scale.shoulderWidth;
    assert.ok(
      Math.abs(ratio - (16 / 9) / (4 / 3)) < 1e-6,
      `shoulder width should scale with aspect; got ratio ${ratio}`
    );
  });

  test('an owner that pins an aspect is not overridden by the camera', () => {
    const tracker = new PoseTracker({ maxPlayers: 1, aspect: 1 });
    setCameraAspect(4 / 3);
    const player = settle(tracker, body());
    assert.equal(player.scale.aspect, 1, 'an explicit aspect must win');
  });

  test('setOptions pins too, so GameBase keeps full control', () => {
    const tracker = new PoseTracker({ maxPlayers: 1 });
    tracker.setOptions({ aspect: 2 });
    setCameraAspect(4 / 3);
    const player = settle(tracker, body());
    assert.equal(player.scale.aspect, 2);
  });

  test('a nonsense aspect is ignored rather than propagated', () => {
    // A camera that has not started yet reports 0x0, and 0/0 is NaN. One NaN
    // reaching `scale.unit` makes every gesture threshold in the app compare
    // against NaN, which is false for everything: no game would respond to any
    // movement at all, with nothing on screen to say why.
    for (const bad of [0, -1, NaN, Infinity, 1e9]) {
      setCameraAspect(bad);
      assert.equal(getCameraAspect(), 16 / 9, `${bad} must not be adopted`);
    }
  });
});
