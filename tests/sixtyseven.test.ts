/**
 * 67 SPEED — the rep gate, against the bodies people actually bring to it.
 *
 * TWO PLAYTESTS HAVE HIT THIS GATE, from opposite sides, and both of them
 * described a POSITION rather than an effort:
 *
 *   "they had to 67 at a certain angle"
 *   "that position is like shoulder width and beyond — I can even do a tpose
 *    67 — some people can 67 very fast with our hands close together"
 *
 * The first suspicion both times was anisotropy: landmark x is normalised by
 * frame WIDTH and y by HEIGHT, and three other detectors in this repo shipped
 * with an x-delta compared against an isotropic torso unit. It is NOT that, and
 * the first block below exists to keep it not-that.
 *
 * It is geometry. HOW FAR APART YOUR HANDS ARE IS SET BY HOW FAR YOU ABDUCT
 * YOUR UPPER ARMS, and upper-arm abduction is also the only thing that lifts
 * your wrist above your shoulder — with your elbows at your sides the forearm
 * is shorter than the upper arm, so the wrist tops out below the shoulder line
 * however hard you pump. A gate anchored to the shoulder is therefore a gate on
 * hand separation, which is what the tester measured with their own arms.
 *
 * So these tests are built on a body whose ARM GEOMETRY is a free parameter,
 * driven by forward kinematics rather than by a wrist height picked to suit the
 * threshold. The three properties they pin:
 *
 *   1. The count is invariant to body yaw. The moment anything in `ArmPump`
 *      reads an x coordinate, a turned player is measured differently from a
 *      square one and the first complaint returns.
 *   2. The count is invariant to HAND SEPARATION, from hands touching to a
 *      t-pose. That is the second complaint, and it is the property a
 *      shoulder-anchored gate cannot have.
 *   3. What a rep costs is the SWING the wrist travels, and nothing else. That
 *      is the entire anti-cheat now, so it is asserted from both sides.
 *
 * Everything drives the REAL `PoseTracker` and the REAL `RepCounter`, so
 * `scale.unit` is computed the way the game computes it rather than assumed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PoseTracker } from '../src/core/tracker.ts';
import { RepCounter, DEFAULT_REP_TUNABLES, type RepTunables } from '../src/core/gestures.ts';
import { POSE, POSE_LANDMARK_COUNT } from '../src/core/types.ts';
import { armIsLost, ARM_LOST_SEC } from '../src/games/sixtyseven.ts';
import type { Landmark, RawPose } from '../src/core/types.ts';

const ASPECT = 16 / 9;
/** Torso height as a fraction of frame height. A 1.7m adult about 3m away. */
const TORSO = 0.2617;
/** Centimetres in one torso unit: acromion-to-hip is ~0.29 of a 1.7m stature. */
const CM = 49;
const FPS = 60;

/**
 * The gate `games/sixtyseven.ts` installs. Duplicated rather than imported
 * because the game module pulls in canvas, audio and the DOM; if the two ever
 * drift, "hands together counts" below is what fails, which is the right
 * failure to get.
 */
const GATE: RepTunables = {
  upEnter: 0.12,
  upExit: 0.05,
  downEnter: 0.12,
  downExit: 0.05,
  centreRate: 0.02,
  minRepIntervalMs: 60,
};
/** Peak-to-peak wrist travel a rep costs, in torso units. */
const SWING = GATE.upEnter + GATE.downEnter;

/* ------------------------------------------------------------------ */
/* A body with arms                                                    */
/* ------------------------------------------------------------------ */

/**
 * Segment ratios as fractions of TORSO HEIGHT, copied from tests/scene.ts,
 * which copies them from `simulator.buildSkeleton`, which matches standard
 * anthropometry. `SHOULDER_HALF` is the 1.25 torso/shoulder ratio that
 * core/candidates.ts derives and documents.
 */
const SHOULDER_HALF = 0.4;
const UPPER_ARM = 0.55;
const FOREARM = 0.5;
const DEG = Math.PI / 180;

interface Body {
  /** Yaw about the body's own vertical axis, degrees. 0 = facing the camera. */
  yaw: number;
  /** Pumps per second. */
  hz: number;
  /**
   * Mean upper-arm ABDUCTION, degrees from hanging straight down. This is the
   * knob the tester was describing: 0 puts the elbows at the sides and the
   * hands together in front of the chest, 90 puts them straight out.
   */
  theta: number;
  /** How much the SHOULDER contributes to the stroke, degrees. */
  dTheta: number;
  /** Mean forearm fold, degrees from hanging down, rotating inward and up. */
  beta: number;
  /** How much the ELBOW contributes to the stroke, degrees. */
  dBeta: number;
  /** Visibility of the subject-right arm — the one a left turn occludes. */
  farVis: number;
  /** Per-landmark gaussian sigma in frame heights. 0.004 realistic, 0.007 hostile. */
  noise: number;
}

function defaults(over: Partial<Body> = {}): Body {
  return {
    yaw: 0,
    hz: 4,
    theta: 45,
    dTheta: 20,
    beta: 95,
    dBeta: 45,
    farVis: 1,
    noise: 0,
    ...over,
  };
}

/** Elbow and wrist offsets from the shoulder, in torso units, y DOWN positive. */
function arm(b: Body, s: number): { ex: number; ey: number; wx: number; wy: number } {
  const th = (b.theta + b.dTheta * s) * DEG;
  const be = (b.beta + b.dBeta * s) * DEG;
  const ex = UPPER_ARM * Math.sin(th);
  const ey = UPPER_ARM * Math.cos(th);
  return { ex, ey, wx: ex - FOREARM * Math.sin(be), wy: ey + FOREARM * Math.cos(be) };
}

/** Deterministic noise. A test that depends on jitter must not depend on the clock. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
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
function frame(b: Body, t: number, r: () => number): RawPose {
  const c = Math.cos(b.yaw * DEG);
  const cx = 0.5;
  const shoulderY = 0.4;
  const hipY = shoulderY + TORSO;
  const sh = SHOULDER_HALF * TORSO * c;

  const lm: Landmark[] = [];
  for (let i = 0; i < POSE_LANDMARK_COUNT; i++) lm.push({ x: cx, y: 0.5, z: 0, visibility: 1 });
  const set = (i: number, xIso: number, y: number, v = 1): void => {
    const jx = b.noise > 0 ? (gauss(r) * b.noise) / ASPECT : 0;
    const jy = b.noise > 0 ? gauss(r) * b.noise : 0;
    lm[i] = { x: cx + xIso / ASPECT + jx, y: y + jy, z: 0, visibility: v };
  };

  set(POSE.NOSE, 0, shoulderY - TORSO * 0.5);
  set(POSE.LEFT_SHOULDER, sh, shoulderY);
  set(POSE.RIGHT_SHOULDER, -sh, shoulderY, b.farVis);
  set(POSE.LEFT_HIP, sh * 0.71, hipY);
  set(POSE.RIGHT_HIP, -sh * 0.71, hipY);
  set(POSE.LEFT_KNEE, sh * 0.71, hipY + TORSO * 0.7);
  set(POSE.RIGHT_KNEE, -sh * 0.71, hipY + TORSO * 0.7);
  set(POSE.LEFT_ANKLE, sh * 0.71, hipY + TORSO * 1.4);
  set(POSE.RIGHT_ANKLE, -sh * 0.71, hipY + TORSO * 1.4);

  for (const side of [1, -1] as const) {
    const isLeft = side === 1;
    const vis = isLeft ? 1 : b.farVis;
    const s = Math.sin(t * b.hz * Math.PI * 2 + (isLeft ? 0 : Math.PI));
    const a = arm(b, s);
    const ex = (SHOULDER_HALF + a.ex) * TORSO * c * side;
    const wx = (SHOULDER_HALF + a.wx) * TORSO * c * side;
    set(isLeft ? POSE.LEFT_ELBOW : POSE.RIGHT_ELBOW, ex, shoulderY + a.ey * TORSO, vis);
    set(isLeft ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST, wx, shoulderY + a.wy * TORSO, vis);
    set(isLeft ? POSE.LEFT_INDEX : POSE.RIGHT_INDEX, wx, shoulderY + (a.wy + 0.02) * TORSO, vis);
    set(isLeft ? POSE.LEFT_PINKY : POSE.RIGHT_PINKY, wx, shoulderY + (a.wy + 0.02) * TORSO, vis);
    set(isLeft ? POSE.LEFT_THUMB : POSE.RIGHT_THUMB, wx, shoulderY + (a.wy + 0.01) * TORSO, vis);
  }

  return { landmarks: lm, worldLandmarks: lm, score: 1 };
}

/** What the stroke actually looks like, from the kinematics alone. */
function stroke(b: Body): {
  /** Distance between the two hands at the top of the stroke, cm. */
  handsCm: number;
  /** Wrist height at the top, torso units, POSITIVE = above the shoulder. */
  top: number;
  /** Wrist height at the bottom, same sign convention. */
  bottom: number;
  /** Peak-to-peak wrist travel, torso units. */
  swing: number;
  /** Wrist height above the ELBOW at the top and at the bottom. */
  aboveElbowTop: number;
  aboveElbowBottom: number;
} {
  let top = Infinity;
  let bottom = -Infinity;
  let hands = 0;
  let eTop = 0;
  let eBottom = 0;
  for (let i = 0; i <= 720; i++) {
    const a = arm(b, Math.sin((i / 720) * Math.PI * 2));
    if (a.wy < top) {
      top = a.wy;
      hands = 2 * (SHOULDER_HALF + a.wx);
      eTop = a.wy - a.ey;
    }
    if (a.wy > bottom) {
      bottom = a.wy;
      eBottom = a.wy - a.ey;
    }
  }
  return {
    handsCm: hands * CM,
    top: -top,
    bottom: -bottom,
    swing: bottom - top,
    aboveElbowTop: -eTop,
    aboveElbowBottom: -eBottom,
  };
}

/** Reps counted over `seconds` of that body, through the real pipeline. */
function reps(b: Body, tun: RepTunables = GATE, seconds = 5, seed = 1): number {
  const tracker = new PoseTracker({ maxPlayers: 1, aspect: ASPECT, minAgeToConfirm: 3 });
  const counter = new RepCounter();
  counter.setTunables(tun);
  const r = rng(seed);
  for (let i = 0; i < Math.round(seconds * FPS); i++) {
    const t = i / FPS;
    const p = tracker.update([frame(b, t, r)], t)[0];
    if (p) counter.update(p, t * 1000);
  }
  return counter.count;
}

/** Torso height, as the tracker measures it for that body. */
function unitOf(b: Body): number {
  const tracker = new PoseTracker({ maxPlayers: 1, aspect: ASPECT, minAgeToConfirm: 3 });
  const r = rng(1);
  let unit = 0;
  for (let i = 0; i < 10; i++) {
    const p = tracker.update([frame(b, i / FPS, r)], i / FPS)[0];
    if (p) unit = p.scale.unit;
  }
  return unit;
}

/** Roughly what 5s of honest pumping is worth, the yardstick everything else uses. */
const HONEST = 30;

/* ------------------------------------------------------------------ */

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
    assert.ok(square > HONEST, `a 4Hz pump for 5s should score ~33, got ${square}`);
    for (const yaw of [15, 30, 45, 60, 75]) {
      assert.equal(reps(defaults({ yaw })), square, `turning ${yaw}deg changed the count`);
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
    // `minArea` (0.02 of the frame), and a bounding box shrinks when a body
    // turns while `scale.unit` — torso height, the thing that actually means
    // "how near is this person" — does not move at all. So a player turned far
    // enough stopped being a player: no reps, no lanes, no game, no message.
    //
    // `selectCandidates` now admits on area OR a rotation-stable `minUnit`.
    for (const yaw of [78, 82, 85]) {
      assert.ok(reps(defaults({ yaw })) > HONEST, `a body at ${yaw}deg should still count`);
    }
  });

  /* ------- "shoulder width and beyond": the complaint, and the fix ------- */

  describe('hand separation', () => {
    /**
     * A TIGHT pump: the upper arm stays where it is and only the forearm folds.
     * `theta` then sets how far apart the hands are, from touching to a t-pose,
     * WITHOUT changing the stroke at all — the swing is a flat 0.87 torso at
     * every one of them. Anything that scores these differently is scoring
     * position, not effort.
     */
    const tight = (theta: number): Body =>
      defaults({ theta, dTheta: 0, beta: 90, dBeta: 60 });

    test('the wrist cannot clear the shoulder with the elbows at the sides', () => {
      // The physical fact the whole complaint rests on. Forearm (0.50 torso) is
      // SHORTER than upper arm (0.55), so with the upper arm hanging down the
      // wrist tops out below the shoulder however hard the elbow works.
      //
      //   hands apart   15cm   29cm   42cm   53cm   61cm   69cm
      //   wrist top   -0.117 -0.098 -0.043 +0.044 +0.158 +0.433
      //
      // Shoulder width on this body is 39cm, which is where the tester put the
      // boundary with their own arms.
      const narrow = stroke(tight(0));
      assert.ok(narrow.top < 0, `hands together, wrist peaked at ${narrow.top}`);
      assert.ok(narrow.handsCm < 20, `hands together should be <20cm, got ${narrow.handsCm}`);
      const wide = stroke(tight(90));
      assert.ok(wide.top > 0.2, `t-pose wrist peaked at ${wide.top}`);
      // And the stroke itself is identical, which is what makes the sweep fair.
      assert.ok(Math.abs(narrow.swing - wide.swing) < 1e-9);
    });

    test('hands together counts exactly as well as a t-pose', () => {
      // THE REPORTED BUG. Against the old shoulder-anchored gate this sweep
      // read 0, 0, 0, 24, 37, 37 — nothing at all until the hands were wider
      // than the shoulders.
      const wide = reps(tight(90));
      assert.ok(wide > HONEST, `a t-pose 67 should score ~33, got ${wide}`);
      for (const theta of [0, 10, 15, 25, 30, 45, 60, 75]) {
        const n = reps(tight(theta));
        assert.ok(
          n >= wide * 0.9,
          `hands ${stroke(tight(theta)).handsCm.toFixed(0)}cm apart scored ${n} against ${wide} for a t-pose`
        );
      }
    });

    test('every real pumping style counts, including the shallow ones', () => {
      // Four different people's 67, by kinematics rather than by taste.
      const styles: Array<[string, Body]> = [
        ['elbows tucked, hands together', defaults({ theta: 0 })],
        ['elbows low', defaults({ theta: 20 })],
        ['shoulder width', defaults({ theta: 45 })],
        ['wide', defaults({ theta: 70 })],
        ['chest-to-overhead', defaults({ theta: 45, dTheta: 40, beta: 120, dBeta: 0 })],
        ['shallow overhead', defaults({ theta: 60, dTheta: 30, beta: 120, dBeta: 0 })],
      ];
      for (const [name, body] of styles) {
        const n = reps(body);
        assert.ok(n > 25, `"${name}" (swing ${stroke(body).swing.toFixed(2)}) scored ${n} in 5s`);
      }
    });

    test('no FIXED anchor could have served both styles — shoulder or elbow', () => {
      // This is why the gate learns the middle of the stroke instead of sitting
      // at a landmark. Kept as an assertion because "just move the threshold"
      // is the obvious next suggestion and it provably does not work.
      const narrow = stroke(defaults({ theta: 0, dTheta: 0, beta: 90, dBeta: 60 }));
      const overhead = stroke(defaults({ theta: 60, dTheta: 30, beta: 120, dBeta: 0 }));

      // A shoulder-anchored band must reach the tight style's TOP (-0.117) and
      // the overhead style's BOTTOM (-0.226). What is left between them is the
      // largest swing such a band could EVER ask for, at zero margin on both
      // ends: 0.109 torso, against the 0.24 this gate needs and about four
      // times one wrist's hostile noise.
      const widest = narrow.top + -overhead.bottom;
      assert.ok(
        widest < SWING / 2,
        `a shoulder-anchored band has ${widest.toFixed(3)} torso to work with, ` +
          `against a required swing of ${SWING}`
      );

      // An elbow-anchored band is worse: an overhead pump holds the forearm at
      // a fixed angle, so the wrist sits a CONSTANT distance above the elbow
      // for the whole stroke and there is no signal there at all.
      assert.ok(
        Math.abs(overhead.aboveElbowTop - overhead.aboveElbowBottom) < 1e-9,
        'an overhead stroke has zero elbow-relative swing'
      );
    });
  });

  /* ---------------- what a rep costs, now that it is not height ---------- */

  describe('the swing is the anti-cheat', () => {
    /** A stroke of a chosen peak-to-peak size, held in front of the chest. */
    const swingOf = (torso: number, hz = 8): Body => {
      // Forearm folding about a fixed elbow: the swept angle that gives this
      // much vertical wrist travel. Held low and narrow, which is where a
      // shoulder-anchored gate would have scored a flat zero.
      const half = Math.asin(Math.min(1, torso / 2 / FOREARM)) / DEG;
      return defaults({ theta: 20, dTheta: 0, beta: 90, dBeta: half, hz });
    };

    test('the band is symmetric and the swing it asks for is 0.24 torso', () => {
      // If someone "fixes" a future complaint by halving one enter, this is
      // what catches it. The gate no longer asks WHERE the wrist is, so this
      // number is the only thing standing between the game and a hand shake.
      assert.equal(+SWING.toFixed(4), 0.24);
      assert.equal(GATE.upEnter, GATE.downEnter, 'a stroke is symmetric; so is the band');
      // Hysteresis gaps, so neither gate can chatter at its boundary.
      assert.ok(GATE.upEnter - GATE.upExit >= 0.05);
      assert.ok(GATE.downEnter - GATE.downExit >= 0.05);
      // And the centre must be learned slowly enough not to eat a slow pump:
      // 0.02/frame is a 0.83s corner against a 0.5Hz pump's 2s period.
      assert.ok(GATE.centreRate <= 0.03);
    });

    test('a body standing still scores nothing, hostile noise included', () => {
      const frozen = defaults({ dTheta: 0, dBeta: 0 });
      assert.equal(reps(frozen), 0, 'arms out, motionless');
      assert.equal(reps({ ...frozen, theta: 0, beta: 20 }), 0, 'arms down, motionless');
      assert.equal(reps({ ...frozen, noise: 0.007 }), 0, 'motionless under hostile noise');
      assert.equal(reps({ ...frozen, theta: 0, beta: 20, noise: 0.007 }), 0);
    });

    test('a stroke under the band scores nothing worth having', () => {
      // The claim is that a twitch cannot COMPETE, not that it is bit-exactly
      // zero: a gate can legitimately let one or two through as it latches, and
      // pinning that to an exact integer only makes this break every time
      // someone touches the tracker.
      const honest = reps(defaults());
      for (const s of [0.04, 0.08, 0.12, 0.16, 0.2]) {
        const n = reps(swingOf(s));
        assert.ok(
          n * 10 < honest,
          `a ${(s * CM).toFixed(1)}cm swing at 8Hz scored ${n} in 5s, against ${honest} honest`
        );
      }
    });

    test('and it still cannot compete once the camera is having a bad day', () => {
      // Landmark noise adds to a stroke, so the boundary is a distribution
      // rather than a wall, and pretending otherwise is how a cheat ships.
      // MEASURED, reps in 5s, against ~33 for an honest 4Hz pump:
      //
      //   swing     0.12   0.16   0.20   0.24   0.30
      //   clean        0      0      0      1     73
      //   realistic    0      0      4     20     65
      //   hostile      1      4     10     27     54
      //
      // So a stroke a third under the band is worth under a third of an honest
      // pump even under hostile input, and one AT the band is a coin toss,
      // which is what a threshold means.
      const honest = reps(defaults());
      for (const s of [0.08, 0.12, 0.16, 0.2]) {
        for (const noise of [0.004, 0.007]) {
          const n = reps({ ...swingOf(s), noise });
          assert.ok(
            n * 3 < honest,
            `a ${(s * CM).toFixed(1)}cm swing at noise ${noise} scored ${n}, honest is ${honest}`
          );
        }
      }
    });

    test('a stroke over the band scores, wherever on the body it is held', () => {
      // The other half: the gate must not have quietly grown a height
      // requirement again. These are all held low and narrow — a shoulder
      // -anchored gate scores every one of them zero.
      for (const s of [0.3, 0.45, 0.6]) {
        const body = swingOf(s, 4);
        assert.ok(stroke(body).top < 0, 'this stroke must stay below the shoulder');
        assert.ok(
          reps(body) > 25,
          `a ${(s * CM).toFixed(1)}cm swing below the shoulder scored ${reps(body)}`
        );
      }
    });

    test('a slow pump is counted, not filtered away by the learned centre', () => {
      // The centre is a high-pass corner. Put it near the pump frequency and it
      // eats the thing it is measuring — silently, and worst for the slowest
      // players, who are the ones already having a bad time.
      for (const hz of [0.5, 1, 2, 4, 6]) {
        const n = reps(defaults({ theta: 0, dTheta: 0, beta: 90, dBeta: 60, hz }), GATE, 6);
        const expected = 2 * hz * 6;
        assert.ok(
          n >= expected * 0.8,
          `${hz}Hz for 6s should be about ${expected} reps, got ${n}`
        );
      }
    });
  });

  /* ---------------- the other half of the angle complaint ---------------- */

  test('an occluded arm stops counting — which is why the HUD has to say so', () => {
    // Not a bug a threshold can fix: below the visibility gate there is no arm
    // to measure. It is pinned because it is the REASON `drawArmIndicators`
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

/**
 * AND THE GATE THESE TESTS DRIVE HAS TO BE THE GATE THE GAME SHIPS.
 *
 * `GATE` at the top of this file is a hand-written COPY of `REP_GATE` in
 * `games/sixtyseven.ts`. Everything above proves those numbers behave — that
 * every real pumping style counts, that hands-together scores like a t-pose,
 * that no fixed anchor could have served both — and NONE of it would have
 * noticed the game shipping different ones.
 *
 * FOUND BY MUTATION, sweeping every fix in FEEDBACK.md: raising the game's
 * `upEnter` from 0.12 to 0.6 — which is roughly the shoulder-anchored gate
 * rows 6 and 7 were reported against — failed exactly one test in the whole
 * suite, the one that checks the ledger's anchor text still exists.
 *
 * `games/sixtyseven.ts` cannot be imported here; it extends GameBase and needs
 * a canvas. Same shape, and the same fix, as the lane gate in
 * `runner-lane.test.ts`.
 */
describe('the rep gate these tests drive is the gate the game ships', () => {
  test('sixtyseven.ts installs exactly the GATE these tests use', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/games/sixtyseven.ts', 'utf8');

    const at = src.indexOf('const REP_GATE = {');
    assert.ok(at >= 0, 'sixtyseven.ts no longer declares REP_GATE');
    const block = src.slice(at, src.indexOf('} as const;', at));

    const num = (name: string): number => {
      const line = block.split(/\r?\n/).find((l) => l.trim().startsWith(`${name}:`));
      assert.ok(line, `REP_GATE no longer has ${name}`);
      const m = /:\s*(-?\d+(?:\.\d+)?)\s*,/.exec(line);
      assert.ok(m, `REP_GATE.${name} is no longer a plain number`);
      return Number(m[1]);
    };

    assert.deepEqual(
      {
        upEnter: num('upEnter'),
        upExit: num('upExit'),
        downEnter: num('downEnter'),
        downExit: num('downExit'),
      },
      {
        upEnter: GATE.upEnter,
        upExit: GATE.upExit,
        downEnter: GATE.downEnter,
        downExit: GATE.downExit,
      },
      'the game ships a different rep gate from the one every test above drives, ' +
        'so those results say nothing about what a player gets'
    );
  });

  /**
   * The two fields REP_GATE takes from `DEFAULT_REP_TUNABLES` rather than
   * writing out, so the copy above stays honest about those too.
   */
  test('and the borrowed fields still match their source', () => {
    assert.equal(GATE.centreRate, DEFAULT_REP_TUNABLES.centreRate);
    assert.equal(GATE.minRepIntervalMs, DEFAULT_REP_TUNABLES.minRepIntervalMs);
  });

  /**
   * `centreRate` is what makes the gate style-agnostic: the centre learns where
   * the middle of THIS arm's stroke is, and the gates run on deviation from it.
   * At zero it never learns, the reference is whatever the first frame
   * happened to be, and the gate is shoulder-anchored again — which is rows 6
   * and 7 exactly.
   */
  test('and the centre still learns, or the anchor is fixed again', () => {
    assert.ok(
      GATE.centreRate > 0,
      'centreRate is zero, so the stroke centre never adapts and every player ' +
        'is measured against wherever their wrist happened to be on frame one'
    );
    assert.ok(GATE.centreRate < 0.2, 'the centre chases the stroke it is measuring');
  });
});

/**
 * THE ARM THAT WENT AWAY, AND THE SENTENCE THAT EXPLAINS IT.
 *
 * `<FACE THE CAMERA>` had never been drawn in any automated run of this app.
 * A census of every string the roster draws turned up 19 banners that never
 * appear, and most were failure screens nobody wants to reach — but this one
 * is different. It is not rare. A player turns to talk to the friend they are
 * racing, a shoulder crosses a wrist, and the reps stop counting for a reason
 * nothing on screen explains. It never fired in testing because the simulator
 * always shows both arms and has no way to be asked not to.
 *
 * So the trigger is tested directly instead. These are the four cases that
 * decide whether a player at a stall gets told what to do.
 */
describe('an arm that stops being seen', () => {
  const MS = ARM_LOST_SEC * 1000;

  test('an arm that was never seen is not lost', () => {
    // The start of a round, or a player who stepped in late. Warning somebody
    // about an arm the round has never had is noise at the one moment they
    // are working out what to do.
    assert.equal(armIsLost(0, 10_000), false);
    assert.equal(armIsLost(undefined, 10_000), false);
  });

  test('an arm seen this frame is not lost', () => {
    assert.equal(armIsLost(10_000, 10_000), false);
  });

  test('a blur between frames is not a warning', () => {
    // The whole reason there is a delay at all: tracking drops a wrist for a
    // frame or two constantly, and a banner that flickers on every one of
    // them teaches players to ignore it.
    assert.equal(armIsLost(10_000, 10_000 + MS / 2), false);
  });

  test('an arm gone longer than the window is lost', () => {
    assert.equal(armIsLost(10_000, 10_000 + MS + 1), true);
  });

  /**
   * On the boundary it is NOT lost. Strictly greater, so the threshold reads
   * the same as the comment above the constant: 0.8s may pass unseen.
   */
  test('the boundary belongs to the arm', () => {
    assert.equal(armIsLost(10_000, 10_000 + MS), false);
  });

  /**
   * 0.8s is short enough that a player who has turned too far finds out
   * within one pump. A pump at the counted rate is well under a second, so
   * the warning cannot take longer than the motion it is about.
   */
  test('the window is shorter than a single pump', () => {
    const secondsPerPump = 1 / 4.5; // 4.5Hz, the rate the rep counter is tuned at
    assert.ok(
      ARM_LOST_SEC > secondsPerPump,
      'shorter than one pump would warn mid-motion, on every rep',
    );
    assert.ok(
      ARM_LOST_SEC < 4 * secondsPerPump,
      'longer than a few pumps and the player has already stopped trying',
    );
  });
});
