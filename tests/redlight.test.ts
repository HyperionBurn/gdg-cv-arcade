/**
 * RED LIGHT'S ELIMINATION RULE.
 *
 * The worst thing this stall can do is eliminate somebody who was standing
 * still, in front of their friends, with no way for a marshal to give the
 * round back. `redlight.ts`'s own header puts it as the difference between
 * "funny" and "infuriating".
 *
 * Until now that rule was covered by two things, neither of which pins it. The
 * smoke probe drives a real round and asserts individual judging, but it is
 * deliberately tolerant — "one honest player being caught is within the
 * signal's real spread" — because it runs against a noisy detector. And
 * README.md records "0 false eliminations in a full 45s round", measured once,
 * months of commits ago.
 *
 * `judgeRedLight` is the decision itself, so the three properties that matter
 * can be checked exactly rather than sampled.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { judgeRedLight } from '../src/games/redlight.ts';

const FRAME = 1 / 60;
const BREACH = 0.3;

const step = (
  breach: number,
  moving: boolean,
  judging = true,
  settled = true
): ReturnType<typeof judgeRedLight> =>
  judgeRedLight(breach, { moving, judging, settled, dt: FRAME, breachSec: BREACH });

describe('nobody is eliminated for standing still', () => {
  /**
   * THE PROPERTY THE WHOLE GAME RESTS ON. A detector at 3m under hall lighting
   * produces brief excursions above the threshold; a person who is actually
   * moving produces sustained ones. Resetting on every still frame is what
   * tells those apart, and it is one line that would be easy to "simplify"
   * into a decaying counter by someone who did not know why.
   */
  test('a breach resets completely on a single still frame', () => {
    let breach = 0;
    // Noise: two moving frames, one still, forever. Never accumulates.
    for (let i = 0; i < 600; i++) {
      const moving = i % 3 !== 2;
      const r = step(breach, moving);
      breach = r.breach;
      assert.equal(r.eliminate, false, `eliminated on frame ${i} of noise`);
    }
    assert.ok(breach < BREACH, 'noise accumulated into a real breach');
  });

  test('but sustained movement does eliminate, at the stated time', () => {
    let breach = 0;
    let firedAt = -1;
    for (let i = 0; i < 600; i++) {
      const r = step(breach, true);
      breach = r.breach;
      if (r.eliminate) {
        firedAt = (i + 1) * FRAME;
        break;
      }
    }
    assert.ok(firedAt > 0, 'continuous movement was never judged');
    // Within one frame of breachSec, and never EARLY.
    assert.ok(firedAt >= BREACH, `fired at ${firedAt}s, before breachSec`);
    assert.ok(firedAt < BREACH + FRAME * 2, `fired late at ${firedAt}s`);
  });

  /**
   * The near-miss that is nearly a breach. Somebody who moves for almost long
   * enough and stops has to survive — that is the moment the game is played
   * for.
   */
  test('stopping just short survives, and survives the next light too', () => {
    let breach = 0;
    const framesJustShort = Math.floor(BREACH / FRAME) - 1;
    for (let i = 0; i < framesJustShort; i++) {
      const r = step(breach, true);
      breach = r.breach;
      assert.equal(r.eliminate, false);
    }
    // Stop.
    const stopped = step(breach, false);
    assert.equal(stopped.eliminate, false);
    assert.equal(stopped.breach, 0, 'a stop must clear the debt, not bank it');
  });
});

describe('the grace window', () => {
  test('movement before judging opens is never an elimination', () => {
    let breach = 0;
    for (let i = 0; i < 600; i++) {
      const r = step(breach, true, /* judging */ false);
      breach = r.breach;
      assert.equal(r.eliminate, false, `judged during the grace on frame ${i}`);
    }
  });

  /**
   * Reaction time is not disobedience. Moving inside the grace is the near
   * miss the game celebrates, so the flag has to be raised there and NOT once
   * judging has opened — by then it is a foul, not a near miss.
   */
  test('moving inside the grace is a near miss, not after', () => {
    assert.equal(step(0, true, false).nearMiss, true);
    assert.equal(step(0, false, false).nearMiss, false);
    assert.equal(step(0, true, true).nearMiss, false);
  });

  test('the breach clock still runs during the grace', () => {
    // So somebody who never stops is judged promptly once it opens, rather
    // than being handed the grace period twice.
    const r = step(0, true, false);
    assert.ok(r.breach > 0);
  });
});

describe('a player who just walked in', () => {
  /**
   * Walking into frame must never mean walking straight out of the round.
   * `settle` is the immunity, and while it holds the breach must be CARRIED,
   * not cleared — clearing it would hand a repeat offender a fresh start every
   * time the tracker blinked.
   */
  test('is immune, and their breach is carried rather than reset', () => {
    const r = step(0.25, true, true, /* settled */ false);
    assert.equal(r.eliminate, false);
    assert.equal(r.breach, 0.25, 'immunity must not clear an existing breach');
    assert.equal(r.nearMiss, false);
  });

  test('and is judged normally the moment the immunity expires', () => {
    // A breach one frame short of the limit: immune, it is carried untouched;
    // settled, the same frame takes it over and fires.
    const nearly = BREACH - FRAME / 2;
    assert.equal(step(nearly, true, true, false).eliminate, false);
    const r = step(nearly, true, true, true);
    assert.ok(r.breach > nearly);
    assert.equal(r.eliminate, true);
  });
});
