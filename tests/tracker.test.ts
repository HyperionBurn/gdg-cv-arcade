/**
 * Tracker tests — specifically, how many PEOPLE a set of detections becomes.
 *
 * These exist because of a real-camera failure that no simulator test could
 * have produced: Red Light, the only game that asks MediaPipe for six poses,
 * read ONE person as FOUR. It gave them four lanes and eliminated them four
 * times.
 *
 * The simulator generates exactly as many clean, well-separated skeletons as it
 * is told to, so "several overlapping detections of one body" is a shape of
 * input it can never emit. Real MediaPipe emits it constantly: asked for six
 * poses it will return low-confidence extras stacked on the person it already
 * found, to fill the quota.
 *
 * So the input is built by hand here. Pure functions, no DOM, no camera.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { selectCandidates } from '../src/core/candidates.ts';
import { POSE } from '../src/core/types.ts';
import type { Landmark, RawPose } from '../src/core/types.ts';

/**
 * A plausible standing body centred on (cx, cy).
 *
 * `height` is the shoulder-to-hip distance in normalised units, which is what
 * `computeScale` calls the torso unit — the yardstick every threshold in the
 * tracker is expressed in.
 */
function body(cx: number, cy: number, height = 0.22, visibility = 1): RawPose {
  const lms: Landmark[] = [];
  for (let i = 0; i < 33; i++) lms.push({ x: cx, y: cy, z: 0, visibility });

  const halfShoulder = height * 0.62 * 0.5;
  const set = (i: number, x: number, y: number) => {
    lms[i] = { x, y, z: 0, visibility };
  };

  set(POSE.LEFT_SHOULDER, cx - halfShoulder, cy - height / 2);
  set(POSE.RIGHT_SHOULDER, cx + halfShoulder, cy - height / 2);
  set(POSE.LEFT_HIP, cx - halfShoulder * 0.7, cy + height / 2);
  set(POSE.RIGHT_HIP, cx + halfShoulder * 0.7, cy + height / 2);
  set(POSE.NOSE, cx, cy - height * 0.9);
  set(POSE.LEFT_ANKLE, cx - halfShoulder * 0.7, cy + height * 1.6);
  set(POSE.RIGHT_ANKLE, cx + halfShoulder * 0.7, cy + height * 1.6);

  return { landmarks: lms, worldLandmarks: [] };
}

/** Defaults matching DEFAULT_TRACKER_OPTIONS, so the test tracks the shipped values. */
function people(poses: RawPose[], maxPlayers = 6): number {
  return selectCandidates(poses, {
    maxPlayers,
    minArea: 0.02,
    minUnit: 0.085,
    minConfidence: 0.45,
    dedupeTorsos: 0.55,
    minRelativeSize: 0.5,
    aspect: 16 / 9,
  }).length;
}

describe('PoseTracker — duplicate detections of one body', () => {
  test('one clean detection is one player', () => {
    assert.equal(people([body(0.5, 0.5)]), 1);
  });

  test('four stacked detections of one body are ONE player', () => {
    // The reported failure. MediaPipe returned several skeletons for a single
    // person; every one passed the area filter, so the tracker created four.
    const poses = [
      body(0.5, 0.5),
      body(0.505, 0.502),
      body(0.497, 0.501),
      body(0.503, 0.498),
    ];
    assert.equal(people(poses), 1, 'stacked detections must collapse to one body');
  });

  test('two people standing side by side stay TWO players', () => {
    // The failure the fix must not cause. Centroids one shoulder width apart is
    // the closest two real players will ever stand, and merging them would be
    // worse than the ghost it is meant to remove.
    const gap = 0.22 * 1.15; // ~1.15 torso units apart
    assert.equal(
      people([body(0.5 - gap / 2, 0.5), body(0.5 + gap / 2, 0.5)]),
      2,
      'adjacent players must not be merged'
    );
  });

  test('six genuinely separated people are six players', () => {
    const poses = [0.1, 0.24, 0.38, 0.52, 0.66, 0.8].map((x) => body(x, 0.5, 0.12));
    assert.equal(people(poses), 6);
  });

  test('a low-confidence phantom is rejected outright', () => {
    // MediaPipe fills its quota with poorly-visible extras. A real body and a
    // ghost far enough away to survive dedupe still must not become two.
    assert.equal(
      people([body(0.5, 0.5), body(0.15, 0.5, 0.22, 0.1)]),
      1,
      'low visibility must not count as a person'
    );
  });

  test('a spectator clearly further back does not get a lane', () => {
    // Red Light takes the six largest bodies, and an onlooker behind the play
    // area is a complete, confident, valid detection. Two players plus three
    // watchers was five racers, three of whom get eliminated for shifting
    // their weight.
    const player = body(0.4, 0.5, 0.22);
    const watcher = body(0.75, 0.45, 0.09); // ~0.41 of the player: much further back
    assert.equal(people([player, watcher]), 1, 'a distant onlooker is not a player');
  });

  test('a real player standing a step back is STILL a player', () => {
    // The failure the bystander gate must not cause. Apparent size is inverse
    // to distance, so two genuine players at 3m and 4m are already at 0.75 —
    // rejecting one of those is far worse than letting an onlooker in, because
    // a player being ignored reads as the game being broken.
    assert.equal(
      people([body(0.35, 0.5, 0.22), body(0.7, 0.5, 0.165)]),
      2,
      'a player one step back must not be culled'
    );
  });

  test('a body too small to be in the play zone is ignored', () => {
    // Crowd rejection: people queueing behind the player are further away and
    // therefore smaller.
    assert.equal(people([body(0.5, 0.5), body(0.2, 0.5, 0.012)]), 1);
  });
});
