/**
 * RUNNER — how far you actually have to move to change lane.
 *
 * REPORTED FROM A HUMAN PLAYTEST, with a tape measure: "jumping and ducking
 * work perfectly. Moving left and right, the min distance I found u have to
 * move is like 40-50 cm (I measured it lol)."
 *
 * The gate was nominally 0.35 torso units, and one torso unit is 51cm of
 * lateral shoulder travel for a 1.7m adult at 3m on a 16:9 camera — so the game
 * was asking for 17.8cm and charging 40-50cm. The missing factor was the CENTRE
 * REFERENCE: it adapted on every frame the lane was 0, at 0.02 a call, a ~0.83s
 * time constant. It was chasing the player through the very movement it
 * existed to measure, so what reached the gate was not "how far did they move"
 * but "how far did they move FASTER than 0.83 seconds".
 *
 * That is a trap the threshold cannot escape. It had already been lowered once,
 * 0.55 -> 0.35, and the floor underneath is a motionless body's own noise.
 *
 * These tests drive the REAL `PoseTracker` with a physically-sized body from
 * tests/scene.ts, so the aspect correction, the scale stabiliser and the
 * landmark noise are all the ones the game runs on. They assert the fix from
 * both sides: a lean must register at any pace, and a body that is standing
 * still — or shifting its weight, which every human at a stall does — must not.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PoseTracker } from '../src/core/tracker.ts';
import { LaneDetector, type LaneTunables } from '../src/core/gestures.ts';
import type { RawPose } from '../src/core/types.ts';
import {
  personAt,
  roughen,
  rng,
  heightAt,
  FOV_WIDTH_PER_METRE,
  SCENE_ASPECT,
  REALISTIC_NOISE,
  HOSTILE_NOISE,
  type NoiseSpec,
} from './scene.ts';
import { LANE_HINT_BASELINE_VH } from '../src/games/runner.ts';
import { SAFE, SHADOW, MIN_LEGIBLE } from '../src/shell/theme.ts';

const FPS = 60;
/** The distance the stall is trimmed for. */
const D = 3;

/** The gate `games/runner.ts` installs. */
const GATE: LaneTunables = { enter: 0.35, exit: 0.22, laneCount: 3, holdAt: 0.12, holdSec: 2 };
/** What the detector did before the reference learned to hold still. */
const CHASING: LaneTunables = { ...GATE, holdAt: Infinity };

/** Normalised x per metre of lateral travel at `D`. */
const NX_PER_M = 1 / (FOV_WIDTH_PER_METRE * D);
/** Torso height of this body in frame heights — `makeBody` puts it at 0.30h. */
const UNIT = heightAt(D) * 0.3;
/**
 * Centimetres of lateral SHOULDER travel in one torso unit of offset.
 *
 * This is the conversion the whole complaint turns on, so it is derived rather
 * than quoted: 51cm, which makes the shipped `enter` of 0.35 a 17.8cm ask.
 */
const CM_PER_TORSO = (UNIT / SCENE_ASPECT / NX_PER_M) * 100;

interface Move {
  /** Centimetres of lateral SHOULDER travel. */
  cm: number;
  /** Seconds the movement takes. */
  sec: number;
  tun: LaneTunables;
  noise: NoiseSpec;
  seed: number;
  dir: 1 | -1;
  /** Seconds of standing still first, so the reference has settled. */
  settle?: number;
}

/** @returns true if the lane changed at any point during or after the move */
function moves(m: Move): boolean {
  const tracker = new PoseTracker({ maxPlayers: 1, aspect: SCENE_ASPECT, minAgeToConfirm: 3 });
  const lanes = new LaneDetector({ ...m.tun });
  const r = rng(m.seed);
  const settleN = Math.round((m.settle ?? 2.5) * FPS);
  const moveN = Math.max(1, Math.round(m.sec * FPS));
  const holdN = Math.round(0.6 * FPS);
  const total = (m.cm / 100) * NX_PER_M * m.dir;

  for (let i = 0; i < settleN + moveN + holdN; i++) {
    const t = i / FPS;
    // Smoothstep, because a person accelerates and decelerates; a linear ramp
    // would be a step the reference could never keep up with and would flatter
    // the detector.
    const k = i < settleN ? 0 : Math.min(1, (i - settleN) / moveN);
    const dx = total * (k * k * (3 - 2 * k));
    const pose: RawPose = roughen(personAt(0.5 + dx, D), m.noise, r);
    const p = tracker.update([pose], t)[0];
    if (!p || !p.scale.valid) continue;
    const lane = lanes.update(p, true, t * 1000);
    if (i >= settleN && lane !== 0) return true;
  }
  return false;
}

/** Lane changes produced by a body that is standing, optionally shifting weight. */
function idle(tun: LaneTunables, noise: NoiseSpec, seconds: number, seed: number, rockCm = 0, hz = 0.5): number {
  const tracker = new PoseTracker({ maxPlayers: 1, aspect: SCENE_ASPECT, minAgeToConfirm: 3 });
  const lanes = new LaneDetector({ ...tun });
  const r = rng(seed);
  let changes = 0;
  for (let i = 0; i < Math.round(seconds * FPS); i++) {
    const t = i / FPS;
    // Two incommensurate components so the sway never sits at a sampling
    // harmonic, which is how a "still" test accidentally becomes a lucky one.
    const rock =
      rockCm > 0
        ? (rockCm / 100) * NX_PER_M *
          (0.72 * Math.sin(t * hz * Math.PI * 2) + 0.28 * Math.sin(t * hz * 2.7 * Math.PI * 2 + 1.1))
        : 0;
    const p = tracker.update([roughen(personAt(0.5 + rock, D), noise, r)], t)[0];
    if (!p || !p.scale.valid) continue;
    lanes.update(p, true, t * 1000);
    if (lanes.changed !== 0) changes++;
  }
  return changes;
}

/** Fraction of trials, both directions, in which the lane changed. */
function rate(cm: number, sec: number, tun: LaneTunables, noise: NoiseSpec, seeds = 8): number {
  let n = 0;
  for (let s = 0; s < seeds; s++) {
    for (const dir of [1, -1] as const) {
      if (moves({ cm, sec, tun, noise, seed: 900 + s * 37 + (dir > 0 ? 0 : 4000), dir })) n++;
    }
  }
  return n / (seeds * 2);
}

const SPEEDS = [0.4, 0.9, 1.6] as const;

describe('Runner lanes — "the min distance is like 40-50cm (I measured it lol)"', () => {
  test('one torso unit really is about half a metre of sideways travel', () => {
    // Everything below is quoted in centimetres, so if this drifts the whole
    // file is quietly measuring something else.
    assert.ok(
      Math.abs(CM_PER_TORSO - 51) < 2,
      `a torso unit is ${CM_PER_TORSO.toFixed(1)}cm of shoulder travel, expected ~51`
    );
  });

  test('THE BUG: a chasing reference ignores a 20cm lean at every pace', () => {
    // Kept as an assertion, not a comment, because "just lower the threshold"
    // is the obvious next move and this is the evidence that it was never the
    // threshold. Same gate, same body, same noise — only the reference policy
    // differs.
    for (const sec of SPEEDS) {
      assert.equal(
        rate(20, sec, CHASING, REALISTIC_NOISE),
        0,
        `a 20cm lean taken in ${sec}s used to register`
      );
    }
    // Even 30cm — most of a side-step — missed once it was taken slowly.
    assert.ok(rate(30, 1.6, CHASING, REALISTIC_NOISE) < 0.5);
  });

  test('a 20cm lean changes lane at every pace a person moves at', () => {
    for (const sec of SPEEDS) {
      assert.equal(rate(20, sec, GATE, REALISTIC_NOISE), 1, `20cm in ${sec}s`);
      assert.equal(rate(20, sec, GATE, HOSTILE_NOISE), 1, `20cm in ${sec}s, hostile`);
    }
  });

  test('a full side-step still works, and so does a very quick one', () => {
    assert.equal(rate(30, 0.4, GATE, HOSTILE_NOISE), 1);
    assert.equal(rate(45, 1.6, GATE, HOSTILE_NOISE), 1);
  });

  test('a 10cm weight-shift is still not a lane change', () => {
    // The gate has to stay a gate. 10cm is a body settling, not a decision.
    for (const sec of SPEEDS) {
      assert.equal(rate(10, sec, GATE, REALISTIC_NOISE), 0, `10cm in ${sec}s fired`);
    }
  });

  test('standing still produces no lane changes at all, over two minutes', () => {
    assert.equal(idle(GATE, REALISTIC_NOISE, 120, 11), 0);
    assert.equal(idle(GATE, HOSTILE_NOISE, 120, 12), 0);
  });

  test('a body shifting its weight +-8cm on the spot produces none either', () => {
    // +-8cm is the widest sway core/tracker.ts documents for a standing body,
    // and it is the number this fix is most exposed to: a held reference no
    // longer averages slow sway away. MEASURED peak offsets, hostile, 120s:
    //
    //   rock     +-4cm   +-6cm   +-8cm   +-10cm  +-12cm
    //   before   0.142   0.186   0.229   0.273   0.317
    //   after    0.166   0.224   0.291   0.357   0.430
    //
    // So +-8cm is clean with 1.20x of headroom and +-10cm is where it starts.
    // Past that the sway is 20cm peak to peak, which in a three-lane runner is
    // arguably a lane change; `runner.laneEnter` is on the operator console.
    for (const hz of [0.35, 0.6, 0.9]) {
      assert.equal(idle(GATE, HOSTILE_NOISE, 90, 21, 8, hz), 0, `+-8cm at ${hz}Hz`);
    }
  });

  test('the reference lets go again once a player has simply re-planted', () => {
    // A hard freeze would fix the detection and strand the player: someone who
    // re-plants their feet 15cm to the left sits permanently off-centre, one
    // twitch from a lane they did not ask for. `holdSec` is what stops that.
    const tracker = new PoseTracker({ maxPlayers: 1, aspect: SCENE_ASPECT, minAgeToConfirm: 3 });
    const lanes = new LaneDetector({ ...GATE });
    const r = rng(5);
    const dx = 0.15 * NX_PER_M;
    let firedLate = false;
    // 2.5s settling, a 0.8s shuffle 15cm to the left, then 8s standing there.
    for (let i = 0; i < Math.round(11.3 * FPS); i++) {
      const t = i / FPS;
      const k = Math.max(0, Math.min(1, (t - 2.5) / 0.8));
      const p = tracker.update(
        [roughen(personAt(0.5 + dx * (k * k * (3 - 2 * k)), D), REALISTIC_NOISE, r)],
        t
      )[0];
      if (!p || !p.scale.valid) continue;
      lanes.update(p, true, t * 1000);
      // Once the reference has caught up, a further lean of the SAME size must
      // still be a lean rather than an instant lane change.
      if (t > 6.5 && lanes.changed !== 0) firedLate = true;
    }
    assert.equal(lanes.current, 0, '15cm is under the gate; the lane must stay centre');
    assert.equal(firedLate, false);
    // And the player can now lean 20cm in EITHER direction and be seen, which
    // is the thing a frozen reference would have taken away on one side.
    for (const dir of [1, -1] as const) {
      assert.equal(
        moves({ cm: 20, sec: 0.9, tun: GATE, noise: REALISTIC_NOISE, seed: 77, dir, settle: 2.5 }),
        true
      );
    }
  });
});

/**
 * AND THE GATE THESE TESTS DRIVE HAS TO BE THE GATE THE GAME SHIPS.
 *
 * `GATE` at the top of this file is a COPY, written out by hand and labelled
 * "the gate `games/runner.ts` installs". Everything above proves that those
 * four numbers behave — that 20cm registers, that a body rocking on the spot
 * does not — and none of it would have noticed the game shipping different
 * ones. `games/runner.ts` cannot be imported here; it pulls in Three.js and a
 * canvas.
 *
 * FOUND BY MUTATION, sweeping every fix in FEEDBACK.md: changing
 * `LANE_ENTER` in the game failed exactly one test in the whole suite — the
 * one that checks the ledger's anchor text still exists. A tester measured
 * this with a tape measure, and the only thing holding the number was a
 * sentence in a document.
 *
 * Row 9 of FEEDBACK.md. Six rows were in this state; see the others.
 */
describe('the gate these tests drive is the gate the game ships', () => {
  test('runner.ts installs exactly the GATE these tests use', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/games/runner.ts', 'utf8');

    // Line scan plus a regex LITERAL, rather than a pattern built from a
    // template string. `new RegExp(`...\d...`)` needs the backslash doubled or
    // the template eats it, and the survivor — `d+` in place of `\d+` — still
    // reads like a number matcher and quietly matches nothing.
    const num = (name: string): number => {
      const line = src.split(/\r?\n/).find((l) => l.trim().startsWith(`const ${name} = `));
      assert.ok(line, `runner.ts no longer declares ${name}`);
      const m = /=\s*(-?\d+(?:\.\d+)?)\s*;/.exec(line);
      assert.ok(m, `${name} is no longer a plain number`);
      return Number(m[1]);
    };

    assert.deepEqual(
      {
        enter: num('LANE_ENTER'),
        exit: num('LANE_EXIT'),
        holdAt: num('LANE_HOLD_AT'),
        holdSec: num('LANE_HOLD_SEC'),
      },
      { enter: GATE.enter, exit: GATE.exit, holdAt: GATE.holdAt, holdSec: GATE.holdSec },
      'the game ships a different lane gate from the one every test above ' +
        'drives, so those results say nothing about what a player gets'
    );
  });

  /**
   * The margins the comment on those constants commits to, so a future re-tune
   * has to argue with the measurements rather than just move a number.
   */
  test('and that gate still clears the measured noise floors', () => {
    // A body rocking +-8cm on the spot reads 0.291 under hostile input.
    assert.ok(
      GATE.enter > 0.291,
      `enter ${GATE.enter} is at or under the worst sway reading (0.291): a ` +
        `player shifting their weight would change lane`
    );
    // A still body's own noise tops out at 0.078, hostile, over 120s.
    assert.ok(GATE.exit > 0.078, `exit ${GATE.exit} is inside the still-body noise floor`);
    assert.ok(
      GATE.holdAt > 0.078 && GATE.holdAt < GATE.exit,
      `holdAt ${GATE.holdAt} must sit above standing noise and below exit, or the ` +
        `reference is still chasing the player through the movement it measures`
    );
  });
});

/**
 * AND THE ONE LINE THAT NAMES THE CONTROL WAS OFF THE EDGE OF THE TV.
 *
 * Everything above measures whether a lane change REGISTERS. This measures
 * whether a player is ever told the control exists. `<STEP LEFT OR RIGHT>` is,
 * in the words of the note at its draw call, "the only place the game names
 * its own control" — and Runner is the one game whose playfield is a
 * full-bleed 3D scene, so there is nothing else to infer it from.
 *
 * It was positioned as an offset from the action-pill row, `y + vh(v, 5.6)`
 * against a row at `v.height - vh(v, 9)`. That is 3.4vh above the bottom edge,
 * and SAFE — the TV overscan margin, the thing theme.ts says nothing a player
 * needs may sit outside — is 3.5. Nobody could see that by reading it, because
 * the number that mattered was the difference of two others.
 *
 * Found by sweeping drawn sizes for a different reason entirely, then checking
 * the arithmetic of a neighbour.
 */
describe('the control hint stays inside the overscan margin', () => {
  /**
   * Archivo bold, 2vh, 0.2em tracking, all caps and angle brackets. MEASURED
   * on the real canvas rather than assumed from the em box: caps sit about
   * 0.69em above the baseline here and the brackets drop only 0.07em, which is
   * most of why the band below is workable at all.
   */
  const ASCENT_VH = 1.39;
  const DESCENT_VH = 0.14;

  /**
   * Where the pills actually END, shadow included — `drawActionPills` centres
   * them 8.25vh above the bottom with a 4.2vh body, and every sticker carries
   * SHADOW.base of lift beneath it. Using the geometric edge instead overstates
   * the free band by two thirds of a vh, which is the mistake that makes this
   * look roomier than it is.
   */
  const PILL_DRAWN_BOTTOM_VH = 8.25 - 4.2 / 2 - SHADOW.base;

  test('the ink sits inside SAFE rather than across it', () => {
    const inkBottom = LANE_HINT_BASELINE_VH - DESCENT_VH;
    assert.ok(
      inkBottom >= SAFE,
      `the control hint bottoms out ${inkBottom.toFixed(2)}vh above the edge ` +
        `and SAFE is ${SAFE}vh, so a panel that crops its signal takes the ` +
        `only line naming this game's control`
    );
  });

  test('and does not climb into the action pills', () => {
    const inkTop = LANE_HINT_BASELINE_VH + ASCENT_VH;
    assert.ok(
      inkTop <= PILL_DRAWN_BOTTOM_VH,
      `the hint reaches ${inkTop.toFixed(2)}vh and the pills' shadow starts ` +
        `at ${PILL_DRAWN_BOTTOM_VH.toFixed(2)}vh — it is drawn over them`
    );
  });

  /**
   * WHY THE SIZE IS STILL UNDER THE READING FLOOR, recorded as a test so the
   * next person does not "fix" it into a collision.
   *
   * This line is 2vh and MIN_LEGIBLE is 3. That looks like an oversight and is
   * not: the band between SAFE and the pills' drawn bottom is under 2vh, and
   * the ink box at the floor is larger than that. Raising the size needs the
   * PILL ROW moved up first, which is a change to the HUD of the one game
   * under a keep-or-cut decision — a deliberate call, not a tidy-up.
   *
   * If this test ever fails because the band grew, the size should go up.
   */
  test('the band is genuinely too tight for MIN_LEGIBLE', () => {
    const band = PILL_DRAWN_BOTTOM_VH - SAFE;
    // Ascent and descent scale with the type size.
    const scale = MIN_LEGIBLE / 2;
    const boxAtFloor = (ASCENT_VH + DESCENT_VH) * scale;
    assert.ok(
      boxAtFloor > band,
      `the band is now ${band.toFixed(2)}vh and the hint at MIN_LEGIBLE needs ` +
        `${boxAtFloor.toFixed(2)}vh — it FITS now, so raise the size to the ` +
        `floor and delete this test`
    );
  });
});
