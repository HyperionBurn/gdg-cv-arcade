/**
 * CAN THE PLAYER ACTUALLY REACH THE CORNERS?
 *
 * Reported from a playtest, verbatim: "If the bottom shows let's say till my
 * knees… when I reach up I get height restricted… the pointer doesn't fully go
 * with my hand, it stays a little below."
 *
 * That is the hand cursor's reach box failing against a real camera, and it is
 * the single most expensive failure the shell can have: the cursor is how a
 * player chooses a game, so a top row that cannot be reached is a stall where
 * three of the seven tiles are unusable and nobody can say why.
 *
 * The cause is not the arm, it is the FRAME. A laptop lid sits low and close,
 * frames the body nicely and leaves almost nothing above the head, so a raised
 * wrist leaves the picture, its landmark pins at y = 0, and the cursor stops
 * climbing however much further the hand goes. No fixed `reachUp` can fix
 * that: if there are only 0.8 torso units of room above the shoulder line then
 * `dy` can never read below -0.8, and the top of a box built for -1.0 is
 * unreachable by construction.
 *
 * `hover.ts` answers it by measuring the headroom that is actually there and
 * mapping the screen to THAT. These tests are that claim, checked against the
 * framings a stall will really have — including the one that was reported.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { HoverCursor, DWELL, resolveOperatorClick } from '../src/shell/hover.ts';
import { PoseTracker, type TrackedPlayer } from '../src/core/tracker.ts';
import { POSE } from '../src/core/types.ts';
import type { RawPose } from '../src/core/types.ts';
import { makeBody, SCENE_ASPECT } from './scene.ts';

const A = SCENE_ASPECT;
const FPS = 30;

/**
 * A body with one wrist placed by hand.
 *
 * `makeBody` only swings the arms between down and straight out, which is the
 * whole range a bounding box cares about and none of the range a raised hand
 * lives in. `wristY` is in frame heights, absolute.
 */
function bodyWithWrist(spec: { groundY: number; height: number; wristY: number; wristX?: number }): RawPose {
  const pose = makeBody({ x: 0.5, groundY: spec.groundY, height: spec.height, armSpread: 0.35 });
  const lms = pose.landmarks.map((l) => ({ ...l }));
  const shoulder = lms[POSE.RIGHT_SHOULDER]!;
  const x = spec.wristX ?? shoulder.x;
  for (const i of [POSE.RIGHT_WRIST, POSE.RIGHT_PINKY, POSE.RIGHT_INDEX, POSE.RIGHT_THUMB]) {
    lms[i] = { x, y: spec.wristY, z: 0, visibility: 1 };
  }
  // The elbow has to follow or the arm is a broken stick; nothing reads it
  // here, but a scene that could not physically happen is not evidence.
  lms[POSE.RIGHT_ELBOW] = {
    x: (x + shoulder.x) / 2,
    y: (spec.wristY + shoulder.y) / 2,
    z: 0,
    visibility: 1,
  };
  return { landmarks: lms, worldLandmarks: lms };
}

/** A 1080p TV, which is what `HoverState`'s logical pixels are measured in. */
const V = { width: 1920, height: 1080, dpr: 1 };

/** `HoverCursor.update` reads `fc.time` and `fc.v`; nothing else matters here. */
const frameCtx = (t: number): never =>
  ({ time: t, dt: 1 / FPS, now: t * 1000, v: V }) as never;

/**
 * Hold a wrist still and let the filter settle, then report the cursor.
 *
 * The One Euro filter needs frames: reading the cursor on the first one
 * measures the filter's start value, not the mapping.
 */
function settle(
  tracker: PoseTracker,
  cursor: HoverCursor,
  pose: RawPose,
  frames = 90,
  t0 = 0
): { x: number; y: number; present: boolean } {
  let state = { x: 0, y: 0, present: false };
  for (let f = 0; f < frames; f++) {
    const t = t0 + f / FPS;
    const players: TrackedPlayer[] = tracker.update([pose], t);
    const s = cursor.update(frameCtx(t), players[0] ?? null, []);
    // `HoverState` is in logical pixels; everything below reasons in 0..1.
    state = { x: s.x / V.width, y: s.y / V.height, present: s.present };
  }
  return state;
}

/**
 * The framings a stall really produces.
 *
 * `groundY` past 1.0 means the feet are off the bottom of the picture, which
 * is what a low, close lid does. The reported rig was cropped at the KNEES,
 * which is the tightest of these and the one with the least room over the head.
 */
const FRAMINGS = [
  { name: 'full body, camera well back', groundY: 0.97, height: 0.78 },
  { name: 'cropped at the shins', groundY: 1.12, height: 0.95 },
  { name: 'cropped at the knees — the reported rig', groundY: 1.3, height: 1.12 },
  { name: 'cropped at the thigh, very close lid', groundY: 1.5, height: 1.3 },
];

/** `makeBody`'s proportions: shoulders at 0.78 of standing height, torso 0.30. */
const shoulderOf = (f: { groundY: number; height: number }): number =>
  f.groundY - f.height * 0.78;
const torsoOf = (f: { height: number }): number => f.height * 0.3;

/**
 * A wrist at a given `dy` — torso units below the shoulder line, which is the
 * unit the reach box is actually built in. Negative is raised.
 */
const wristAt = (f: { groundY: number; height: number }, dy: number): number =>
  shoulderOf(f) + dy * torsoOf(f);

/**
 * THE BOTTOM OF THE BOX IS THE RAISE GATE, and that is the design.
 *
 * `RAISE_GATE_EXIT` is 0.6 torso units below the shoulder and `REACH_DOWN` is
 * also 0.6, so `rawY` reaches exactly 1.0 on the frame the cursor lets go.
 * There is no band of screen that needs a hand the gate has already dropped.
 */
const GATE_EXIT = 0.6;

describe('the hand cursor can reach the top of the screen', () => {
  for (const f of FRAMINGS) {
    test(`${f.name}`, () => {
      const tracker = new PoseTracker({ maxPlayers: 1, aspect: A, mirrored: true });
      const cursor = new HoverCursor();

      // As high as the player can get it before the wrist leaves the picture.
      // A landmark at y = 0 is ON the top edge; anything above is clamped
      // there by MediaPipe, so this is the most information the camera can
      // ever give us about a raised hand.
      const raised = bodyWithWrist({ groundY: f.groundY, height: f.height, wristY: 0.01 });
      const top = settle(tracker, cursor, raised);

      assert.ok(top.present, 'a raised hand did not even register as a cursor');
      assert.ok(
        top.y <= 0.05,
        `top row unreachable: cursor topped out at y=${top.y.toFixed(3)}`
      );
    });
  }

  test('and the bottom of it', () => {
    // A player points with the hand up — that is the raise gate's whole job —
    // and then lowers it to reach the bottom row. So engage first, then drop.
    const tracker = new PoseTracker({ maxPlayers: 1, aspect: A, mirrored: true });
    const cursor = new HoverCursor();
    const f = FRAMINGS[2]!;

    settle(tracker, cursor, bodyWithWrist({ ...f, wristY: wristAt(f, -0.3) }), 60);
    const low = bodyWithWrist({ ...f, wristY: wristAt(f, GATE_EXIT - 0.05) });
    const bottom = settle(tracker, cursor, low, 90, 2);

    assert.ok(bottom.present, 'a lowered pointing hand stopped being a cursor');
    assert.ok(bottom.y >= 0.9, `bottom row out of reach: y=${bottom.y.toFixed(3)}`);
  });

  test('a hand at rest is not a cursor at all', () => {
    // The other half of the gate, and the more expensive one to get wrong: an
    // arm hanging at the side sits ~1.0 torso below the shoulder, which the
    // reach box would otherwise map to a perfectly live cursor near the bottom
    // of the screen — selecting a game for somebody who has not raised a hand.
    const tracker = new PoseTracker({ maxPlayers: 1, aspect: A, mirrored: true });
    const cursor = new HoverCursor();
    const f = FRAMINGS[2]!;
    const resting = settle(tracker, cursor, bodyWithWrist({ ...f, wristY: wristAt(f, 1.0) }));
    assert.equal(resting.present, false, 'an arm at the side was driving the cursor');
  });

  test('the whole screen is covered, not just its ends', () => {
    // A mapping can hit both extremes and still be useless in between if it
    // saturates. Sweep the wrist down the frame and check the cursor tracks it
    // monotonically across the middle of the screen, where the menu lives.
    const f = FRAMINGS[2]!;
    const tracker = new PoseTracker({ maxPlayers: 1, aspect: A, mirrored: true });
    const cursor = new HoverCursor();

    const ys: number[] = [];
    let t = 0;
    // Top of the picture down to the gate, which is the whole usable box.
    const topDy = (0.01 - shoulderOf(f)) / torsoOf(f);
    for (let i = 0; i <= 8; i++) {
      const dy = topDy + (GATE_EXIT - 0.05 - topDy) * (i / 8);
      const pose = bodyWithWrist({ ...f, wristY: wristAt(f, dy) });
      const s = settle(tracker, cursor, pose, 45, t);
      t += 45 / FPS;
      ys.push(s.y);
    }

    for (let i = 1; i < ys.length; i++) {
      assert.ok(
        ys[i]! >= ys[i - 1]! - 1e-6,
        `cursor went back up as the hand went down: ${ys.map((y) => y.toFixed(2)).join(' ')}`
      );
    }
    const span = ys[ys.length - 1]! - ys[0]!;
    assert.ok(span > 0.7, `the hand crossed the frame and the cursor moved ${span.toFixed(2)}`);
  });
});

describe('the hand cursor can reach both sides', () => {
  test('a hand across the body reaches the far edge', () => {
    const f = FRAMINGS[2]!;
    const tracker = new PoseTracker({ maxPlayers: 1, aspect: A, mirrored: true });
    const cursor = new HoverCursor();

    // REACH_X is 1.7 spans from the shoulder CENTRE, where a span is one
    // shoulder width. An arm is ~1.15 torso units long and the shoulder joint
    // is half a span out, so a fully committed reach is ~1.9 spans: the edge
    // of the screen costs a nearly straight arm, which is the point, and it is
    // inside what a body can do, which is the thing worth checking.
    const span = torsoOf(f) * 0.8;
    const edge = (1.7 * span) / A;

    // Mirrored: the subject's RIGHT hand belongs on the RIGHT of the TV, so
    // reaching out to their right (lower landmark x) must push x toward 1.
    const out = bodyWithWrist({ ...f, wristY: wristAt(f, -0.3), wristX: 0.5 - edge });
    const right = settle(tracker, cursor, out);
    assert.ok(right.x >= 0.9, `right edge unreachable: x=${right.x.toFixed(3)}`);

    const across = bodyWithWrist({ ...f, wristY: wristAt(f, -0.3), wristX: 0.5 + edge });
    const left = settle(tracker, cursor, across, 120, 10);
    assert.ok(left.x <= 0.1, `left edge unreachable: x=${left.x.toFixed(3)}`);
  });
});

/**
 * AND ON A GOOD CAMERA, THE CEILING IS THE THING THAT BINDS.
 *
 * Everything above exercises TIGHT framings, where the measured headroom is
 * smaller than `REACH_UP` and the adaptive shrink decides the box. On a
 * well-placed camera there is more room than `reachUp` needs, the shrink does
 * nothing, and the constant itself sets how far a player has to stretch.
 *
 * That is the case the report came from — "when I reach up I get height
 * restricted, the pointer stays a little below" — and it was the only one with
 * no test. FOUND BY MUTATION: changing `REACH_UP` in `hover.ts` failed nothing
 * in the entire suite except the check that FEEDBACK.md still quotes it. Row 3
 * of the ledger; 1.15 was the anatomical maximum and 1.0 is about 87% of full
 * extension, which is the whole substance of the fix.
 *
 * Pinned from BOTH sides, because both directions are a broken stall: too
 * demanding and the top row needs a locked-out overhead stretch, too small and
 * the cursor pins to the top edge before the arm is up.
 */
describe('a well-framed camera still asks for a comfortable reach', () => {
  /** The framing with room to spare over the head. */
  const F = FRAMINGS[0]!;

  const cursorAt = (dy: number): { x: number; y: number; present: boolean } => {
    const tracker = new PoseTracker();
    const cursor = new HoverCursor();
    return settle(tracker, cursor, bodyWithWrist({ ...F, wristY: wristAt(F, dy) }));
  };

  test('one torso above the shoulder reaches the very top', () => {
    const s = cursorAt(-1.0);
    assert.equal(s.present, true, 'a full raise did not even arm the cursor');
    assert.ok(
      s.y <= 0.03,
      `a wrist one torso above the shoulder puts the cursor at ${(s.y * 100).toFixed(1)}% ` +
        `down the screen, not the top. That is the reported complaint: the top row ` +
        `needs a stretch the player has already made`
    );
  });

  test('and a partial raise has NOT already pinned to the top', () => {
    const s = cursorAt(-0.8);
    assert.equal(s.present, true);
    assert.ok(
      s.y > 0.05,
      `a wrist 0.8 torso up is already at ${(s.y * 100).toFixed(1)}% down the screen. ` +
        `The box has collapsed, so a centimetre of wrist is a big jump of cursor and ` +
        `the top rows are unselectable for the opposite reason`
    );
  });

  /** The ceiling really is the thing being measured here, not the shrink. */
  test('this framing has more headroom than the reach box wants', () => {
    const shoulder = shoulderOf(F);
    const torso = torsoOf(F);
    assert.ok(
      shoulder / torso > 1.2,
      `this framing only has ${(shoulder / torso).toFixed(2)} torso of headroom, so the ` +
        `adaptive shrink is deciding the box and the two tests above are not ` +
        `measuring the constant they claim to`
    );
  });
});

/**
 * AND A PICK STILL TAKES A DELIBERATE HOLD — row 2 of FEEDBACK.md.
 *
 * Reported as selection "might be too fast", alongside landing on games they
 * had not chosen. PLAN.md §6 specified 1.2s; the menu went to 1.5s, because a
 * wrong pick burns a whole turn out of a moving queue and that is the most
 * expensive mistake the shell can make.
 *
 * It had no behavioural test. Found by mutation: `DWELL.deliberate` could be
 * set to anything and nothing in the suite failed except the check that the
 * ledger still quotes it — including, notably, setting it back to the 1.2 the
 * report was about.
 *
 * This lives in the reach file because the body-and-cursor harness is here;
 * driving a dwell needs a real pose, a real tracker and a settled filter, and
 * a second copy of that is how two harnesses drift apart.
 */
describe('a menu pick takes a deliberate hold', () => {
  const F = FRAMINGS[0]!;
  const pose = bodyWithWrist({ ...F, wristY: wristAt(F, -0.5) });

  /**
   * Seconds of steady hover before the target commits, or null if it never
   * did within `hold`.
   */
  function timeToCommit(dwell: number, hold: number): number | null {
    const tracker = new PoseTracker();
    const cursor = new HoverCursor(dwell);
    // Settle first, with no targets, so the filter has caught up and the
    // cursor is already where it is going to sit.
    const warm = 60;
    const at = settle(tracker, cursor, pose, warm);
    assert.equal(at.present, true, 'the cursor never armed, so nothing was being held');

    const target = {
      id: 'tile',
      x: at.x * V.width - 200,
      y: at.y * V.height - 150,
      w: 400,
      h: 300,
    };

    for (let f = 0; f < Math.round(hold * FPS); f++) {
      const t = (warm + f) / FPS;
      const players: TrackedPlayer[] = tracker.update([pose], t);
      const s = cursor.update(frameCtx(t), players[0] ?? null, [target]);
      if (s.committed === 'tile') return f / FPS;
    }
    return null;
  }

  test('holding for the authored dwell commits, and takes about that long', () => {
    const took = timeToCommit(DWELL.deliberate, 4);
    assert.notEqual(took, null, 'a steady hold over a tile never selected it at all');
    assert.ok(
      Math.abs(took! - DWELL.deliberate) < 0.15,
      `a hold committed after ${took!.toFixed(2)}s against an authored ${DWELL.deliberate}s`
    );
  });

  /**
   * AND IT IS BOUNDED ABOVE, which the test before it is not — that one
   * compares the dwell against ITSELF, so it passes at any value. Raising
   * `deliberate` to 2.5s sailed through it.
   *
   * The ceiling is row 24 of the same ledger: "seven dwell tiles slow down
   * every turn in a queue". Choosing is time nobody is playing, and it is paid
   * by everybody waiting, not just by the person choosing. 2s is the most this
   * can cost before that complaint is the live one.
   */
  test('and it is not slow enough to be the other complaint', () => {
    const took = timeToCommit(DWELL.deliberate, 2.0);
    assert.notEqual(
      took,
      null,
      `a tile still had not committed after 2s of steady holding — dwell is ` +
        `${DWELL.deliberate}s. Seven tiles at that price is a queue standing still`
    );
  });

  test('and the 1.2s the report was about does NOT commit', () => {
    const took = timeToCommit(DWELL.deliberate, 1.2);
    assert.equal(
      took,
      null,
      `a tile committed after ${took?.toFixed(2)}s. PLAN.md's original 1.2s is the ` +
        `timing testers reported as too fast, and as landing them on games they ` +
        `had not chosen`
    );
  });

  /**
   * The rule the three dwell times encode: what a mistake COSTS sets how long
   * you have to mean it. A wrong game is a whole turn; a wrong letter is one
   * hover of a DEL sitting right there.
   */
  test('the dwell scale is ordered by what a mistake costs', () => {
    assert.ok(
      DWELL.deliberate > DWELL.standard && DWELL.standard > DWELL.fast,
      `dwell times are ${DWELL.deliberate} / ${DWELL.standard} / ${DWELL.fast}; a menu ` +
        `tile must be the slowest and a letter the quickest`
    );
  });
});

/**
 * THE MARSHAL DRIVES THE SCREEN WITHOUT WALKING INTO FRAME — row 27.
 *
 * Mouse and keyboard are for the OPERATOR only. Nobody in the queue touches
 * the laptop, which is what makes it safe for a click to commit AT ONCE with
 * no dwell — a marshal fixing something mid-queue cannot stand in front of the
 * camera to do it, because they would become a player.
 *
 * No test. Found by semantic mutation of the ledger's identifier anchors:
 * deleting the line that consumes the pending click failed nothing in the suite
 * except the check that FEEDBACK.md still quotes the anchor.
 */
describe('an operator click commits at once, and only once', () => {
  test('a click on a live target commits it immediately', () => {
    const r = resolveOperatorClick(true, { id: 'runner' }, false);
    assert.equal(r.commit, 'runner', 'an operator click no longer selects anything');
    assert.equal(r.pending, false);
  });

  /**
   * THE HAZARD. A click on empty space that stays pending fires later, on
   * whatever the cursor happens to be over by then — including a game tile,
   * in front of a queue. So it is consumed whether or not it lands.
   */
  test('and a click on empty space is spent, not queued', () => {
    const r = resolveOperatorClick(true, null, false);
    assert.equal(r.commit, null, 'clicking nothing selected something');
    assert.equal(
      r.pending,
      false,
      'a click on empty space stayed pending. It will fire on whatever the ' +
        'cursor is over next, which is how a marshal launches a game by accident'
    );
  });

  test('and a click on a locked target is spent too', () => {
    const r = resolveOperatorClick(true, { id: 'photobooth' }, true);
    assert.equal(r.commit, null, 'a locked tile was launched by a click');
    assert.equal(r.pending, false, 'the click survived a locked tile and will fire later');
  });

  test('and no click commits nothing', () => {
    assert.deepEqual(resolveOperatorClick(false, { id: 'runner' }, false), {
      commit: null,
      pending: false,
    });
  });

  /** And the cursor still routes its clicks through it. */
  test('the cursor resolves its clicks through that helper', async () => {
    const { readFile } = await import('node:fs/promises');
    const code = (await readFile('src/shell/hover.ts', 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    assert.match(code, /resolveOperatorClick\(pointer\.clickPending,/, 'the click handling is inline again');
    assert.match(code, /pointer\.clickPending = click\.pending;/, 'the pending flag is no longer written back');
  });
});
