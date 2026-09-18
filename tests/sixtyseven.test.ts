/**
 * 67 SPEED — the rep gate, against bodies that are not facing the camera.
 *
 * REPORTED FROM A HUMAN PLAYTEST: "they had to 67 at a certain angle."
 *
 * The obvious suspect was anisotropy — landmark x is normalised by frame WIDTH
 * and y by HEIGHT, and three other detectors in this repo shipped with an
 * x-delta compared against an isotropic torso unit. These tests exist to pin
 * down that it is NOT that, and to pin the two things it actually is, so that
 * neither can come back:
 *
 *   1. The gate is invariant to body yaw. It must stay invariant — the moment
 *      anything in `ArmPump` starts reading an x coordinate, a turned player is
 *      measured differently from a square one and the complaint returns.
 *   2. The gate is a CLIFF in one dimension: how high the wrist goes relative
 *      to the shoulder. The game sets it deliberately low enough for a modest
 *      pump, and the anti-cheat is carried by the SWING the wrist has to
 *      travel, not by the absolute height. Both halves are asserted here,
 *      because loosening one without the other is how this gets broken.
 *
 * Everything drives the REAL `PoseTracker` and the REAL `RepCounter`, so
 * `scale.unit` is computed the way the game computes it rather than assumed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PoseTracker } from '../src/core/tracker.ts';
import { RepCounter, type RepTunables } from '../src/core/gestures.ts';
import { POSE, POSE_LANDMARK_COUNT } from '../src/core/types.ts';
import type { Landmark, RawPose } from '../src/core/types.ts';

const ASPECT = 16 / 9;
/** Torso height as a fraction of frame height. A body at about 3m. */
const TORSO = 0.2;
const FPS = 60;

/**
 * The gate `games/sixtyseven.ts` installs. Duplicated rather than imported
 * because the game module pulls in canvas, audio and the DOM; if the two ever
 * drift, the "a modest pump counts" test below is what fails, which is the
 * right failure to get.
 */
const GATE: RepTunables = {
  upEnter: 0.04,
  upExit: -0.04,
  downEnter: 0.14,
  downExit: 0.08,
  minRepIntervalMs: 60,
};

interface Body {
  /** Yaw about the body's own vertical axis, in degrees. 0 = facing camera. */
  yaw: number;
  /** Pumps per second. */
  hz: number;
  /** Wrist height at the TOP of the swing, torso units ABOVE the shoulder. */
  peak: number;
  /** Wrist height at the BOTTOM, torso units BELOW the shoulder. */
  trough: number;
  /** Visibility of the subject-right arm — the one a left turn occludes. */
  farVis: number;
}

function defaults(over: Partial<Body> = {}): Body {
  return { yaw: 0, hz: 4, peak: 0.35, trough: 1, farVis: 1, ...over };
}

/**
 * One frame of a body pumping both arms in antiphase.
 *
 * Built in ISOTROPIC units — fractions of frame HEIGHT — and squeezed into
 * MediaPipe's width-normalised x only at the very end, which is exactly what
 * core/simulator.ts does and the only way a synthetic body can catch an
 * anisotropy bug rather than agree with one.
 *
 * A yaw is modelled rigidly: it foreshortens every horizontal offset by
 * cos(yaw) and leaves every vertical one alone, which is what rotating about a
 * vertical axis does.
 */
function frame(b: Body, t: number): RawPose {
  const c = Math.cos((b.yaw * Math.PI) / 180);
  const cx = 0.5;
  const shoulderY = 0.4;
  const hipY = shoulderY + TORSO;

  const lm: Landmark[] = [];
  for (let i = 0; i < POSE_LANDMARK_COUNT; i++) lm.push({ x: cx, y: 0.5, z: 0, visibility: 1 });
  const set = (i: number, xIso: number, y: number, v = 1): void => {
    lm[i] = { x: cx + xIso / ASPECT, y, z: 0, visibility: v };
  };

  const shoulderHalf = 0.12 * c;
  const hipHalf = 0.09 * c;

  set(POSE.NOSE, 0, shoulderY - TORSO * 0.5);
  set(POSE.LEFT_SHOULDER, shoulderHalf, shoulderY);
  set(POSE.RIGHT_SHOULDER, -shoulderHalf, shoulderY, b.farVis);
  set(POSE.LEFT_HIP, hipHalf, hipY);
  set(POSE.RIGHT_HIP, -hipHalf, hipY);
  set(POSE.LEFT_KNEE, hipHalf, hipY + TORSO * 0.7);
  set(POSE.RIGHT_KNEE, -hipHalf, hipY + TORSO * 0.7);
  set(POSE.LEFT_ANKLE, hipHalf, hipY + TORSO * 1.4);
  set(POSE.RIGHT_ANKLE, -hipHalf, hipY + TORSO * 1.4);

  for (const side of [1, -1] as const) {
    const isLeft = side === 1;
    const vis = isLeft ? 1 : b.farVis;
    const wave = Math.sin(t * b.hz * Math.PI * 2 + (isLeft ? 0 : Math.PI));
    const raise = (wave + 1) / 2;
    const top = shoulderY - b.peak * TORSO;
    const bottom = shoulderY + b.trough * TORSO;
    const wy = bottom + (top - bottom) * raise;
    set(
      isLeft ? POSE.LEFT_ELBOW : POSE.RIGHT_ELBOW,
      (shoulderHalf + 0.05 * c) * side,
      (shoulderY + wy) / 2 + 0.02,
      vis
    );
    set(isLeft ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST, (shoulderHalf + 0.04 * c) * side, wy, vis);
  }

  return { landmarks: lm, worldLandmarks: lm, score: 1 };
}

/** Reps counted over `seconds` of that body, through the real pipeline. */
function reps(b: Body, tun: RepTunables = GATE, seconds = 5): number {
  const tracker = new PoseTracker({ maxPlayers: 1, aspect: ASPECT, minAgeToConfirm: 3 });
  const counter = new RepCounter();
  counter.setTunables(tun);
  for (let i = 0; i < Math.round(seconds * FPS); i++) {
    const t = i / FPS;
    const p = tracker.update([frame(b, t)], t)[0];
    if (p) counter.update(p, t * 1000);
  }
  return counter.count;
}

/** Torso height, as the tracker measures it for that body. */
function unitOf(b: Body): number {
  const tracker = new PoseTracker({ maxPlayers: 1, aspect: ASPECT, minAgeToConfirm: 3 });
  let unit = 0;
  for (let i = 0; i < 10; i++) {
    const p = tracker.update([frame(b, i / FPS)], i / FPS)[0];
    if (p) unit = p.scale.unit;
  }
  return unit;
}

describe('67 Speed — "they had to 67 at a certain angle"', () => {
  test('the body unit does not move when the player turns', () => {
    // `scale.unit` is torso HEIGHT, and a yaw is horizontal. If this ever
    // starts depending on the angle, every threshold in the game moves with it.
    const square = unitOf(defaults());
    for (const yaw of [15, 30, 45, 60, 75]) {
      const turned = unitOf(defaults({ yaw }));
      assert.ok(
        Math.abs(turned - square) < 1e-6,
        `unit at ${yaw}deg was ${turned}, square-on it is ${square}`
      );
    }
  });

  test('the same pumping scores the same at every body angle', () => {
    const square = reps(defaults());
    assert.ok(square > 30, `a 4Hz pump for 5s should score ~39, got ${square}`);
    for (const yaw of [15, 30, 45, 60, 75]) {
      assert.equal(
        reps(defaults({ yaw })),
        square,
        `turning ${yaw}deg changed the rep count`
      );
    }
  });

  test('the rep gate survives a shoulder line foreshortened to a quarter', () => {
    // 75deg: shoulder width collapses to 26% of square-on. Nothing in the gate
    // reads it, so the count must not care.
    assert.equal(reps(defaults({ yaw: 75 })), reps(defaults()));
  });

  test('a body turned past 79deg is still a player, and still counts', () => {
    // THIS TEST USED TO ASSERT THE BUG. It is kept, inverted, because the bug
    // is exactly the kind that comes back.
    //
    // `selectCandidates` rejected anything whose BOUNDING BOX was under
    // `minArea` (0.02 of the frame). A bounding box shrinks when a body turns —
    // measured on this exact body at 3m framing:
    //
    //   yaw     0     50     70     75     78     80     85
    //   area  .111   .071   .038   .029   .023   .019   .010
    //   unit  .200   .200   .200   .200   .200   .200   .200
    //
    // `scale.unit` — torso height, the thing that actually means "how near is
    // this person" — is identical at every angle. Only the bbox moves. So a
    // player turned far enough, or standing a step back with their arms in,
    // stopped being a player at all: no reps, no lanes, no game, no message.
    //
    // `selectCandidates` now admits on area OR a rotation-stable `minUnit`, so
    // the count has to survive every angle a person can stand at.
    for (const yaw of [78, 82, 85]) {
      assert.ok(
        reps(defaults({ yaw })) > 30,
        `a body at ${yaw}deg should still count reps`
      );
    }
  });

  /* ---------------- the cliff that was actually being hit ---------------- */

  test('a modest pump counts — the wrist only has to clear the shoulder', () => {
    // Chest to just above the shoulder. This is the player who was getting
    // zero and concluding the game was broken.
    assert.ok(reps(defaults({ peak: 0.05, trough: 0.3 })) > 30);
    assert.ok(reps(defaults({ peak: 0.05, trough: 0.15 })) > 30);
    assert.ok(reps(defaults({ peak: 0.1, trough: 0.4 })) > 30);
  });

  test('a pump that never gets above the shoulder scores nothing', () => {
    // PLAN.md §3: the wrist has to cross ABOVE the shoulder. A big swing that
    // tops out at chin height is still not the move this game is asking for.
    assert.equal(reps(defaults({ peak: 0, trough: 0.5 })), 0);
    assert.equal(reps(defaults({ peak: -0.05, trough: 0.6 })), 0);
  });

  test('tiny twitchy hands still score nothing worth having', () => {
    // The anti-cheat is the SWING — upEnter + downEnter, 0.18 torso — and it is
    // deliberately unchanged from the gate that was too high on the body.
    //
    // The claim is that a twitch cannot COMPETE, not that it is bit-exactly
    // zero: a gate can legitimately let one or two through as it latches, and
    // pinning that to an exact integer only makes this test break every time
    // someone touches the tracker. Five seconds of honest pumping scores ~39,
    // so "under a tenth of that" is the property with teeth.
    const honest = reps(defaults());
    for (const [peak, trough] of [
      [0.02, 0.02],
      [0.05, 0.0],
      [0.1, 0.0],
      [0.0, 0.1],
      [0.03, 0.12],
      [0.02, 0.3],
    ] as const) {
      const n = reps(defaults({ peak, trough }));
      assert.ok(
        n * 10 < honest,
        `peak ${peak} / trough ${trough} scored ${n} in 5s, against ${honest} for a real pump`
      );
    }
  });

  test('the gate lowered the band without widening it', () => {
    // If someone "fixes" a future complaint by dropping upEnter alone, this is
    // what catches it: the swing a rep costs must stay 0.18 torso.
    assert.equal(+(GATE.upEnter + GATE.downEnter).toFixed(4), 0.18);
    // Hysteresis gaps, so neither gate can chatter at its boundary.
    assert.ok(GATE.upEnter - GATE.upExit >= 0.05);
    assert.ok(GATE.downEnter - GATE.downExit >= 0.05);
  });

  /* ---------------- the other half of the angle complaint ---------------- */

  test('an occluded arm stops counting — which is why the HUD has to say so', () => {
    // Not a bug that a threshold can fix: below the visibility gate there is no
    // arm to measure. It is pinned because it is the REASON `drawArmIndicators`
    // grew a third state, and a future change that silently "fixes" the count
    // here would be inventing reps nobody made.
    const both = reps(defaults());
    const one = reps(defaults({ farVis: 0.2 }));
    assert.ok(one > 0, 'the visible arm must still count');
    assert.ok(
      one < both * 0.6,
      `one arm occluded should roughly halve the count: ${both} -> ${one}`
    );
  });
});
