/**
 * BALLOON POP'S VISIBLE CONTRACT: if you can see it in colour, you can pop it.
 *
 * Two boundaries enforce that, and neither had a test.
 *
 * THE SHOULDER LINE is the game's oldest rule and existed only as a hand-run
 * measurement in README.md ("hand on a balloon below the shoulder line = +0").
 * That cannot be reproduced from the harness: `PoseSimulator` eases a wrist
 * toward a target over several seconds and, as `dev/turn.ts` says outright,
 * "cannot place it at an arbitrary screen point at all". I tried — parking
 * hands high and low and playing out a full round returns the same score both
 * times, because the driving never took effect. A measurement that cannot be
 * re-run is a claim, not a test.
 *
 * THE SHELF is new: the HUD became an opaque band, so a balloon that rises
 * behind it is invisible, and the cull that retires it there shipped today with
 * nothing checking it.
 *
 * `isPoppable` exists so both can be checked directly. Same move, and the same
 * reason, as `laneScore` in redlight.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isPoppable } from '../src/games/balloonpop.ts';

/**
 * Screen coordinates, y growing DOWNWARD, at a 720px-tall viewport:
 * the shelf bottom sits near the top, the shoulder line well below it.
 */
const SHELF = 114; // ~15.8vh, `hudBottom` under hudShelf
const ARM = 400; // a player's shoulder line plus forgiveness

describe('a balloon is poppable exactly while it is visible', () => {
  test('in the band between the shelf and the shoulder line', () => {
    assert.equal(isPoppable(300, ARM, SHELF), true);
    assert.equal(isPoppable(200, ARM, SHELF), true);
    assert.equal(isPoppable(399, ARM, SHELF), true);
  });

  test('not below the shoulder line — that is the grey one', () => {
    assert.equal(isPoppable(401, ARM, SHELF), false);
    assert.equal(isPoppable(600, ARM, SHELF), false);
    // The failure this rule exists for: a player standing normally with their
    // hands at hip height is directly in the flight path. Measured before the
    // rule existed, hands down and motionless scored 36 points in two seconds.
    assert.equal(isPoppable(700, ARM, SHELF), false);
  });

  test('not above the shelf — that one is behind an opaque band', () => {
    assert.equal(isPoppable(113, ARM, SHELF), false);
    assert.equal(isPoppable(0, ARM, SHELF), false);
    assert.equal(isPoppable(-50, ARM, SHELF), false);
  });

  /**
   * Both boundaries are inclusive on the playable side. A balloon exactly on
   * the line is in play, which is the forgiving direction and the one this
   * game's whole brief argues for.
   */
  test('the boundaries themselves are in play', () => {
    assert.equal(isPoppable(ARM, ARM, SHELF), true);
    assert.equal(isPoppable(SHELF, ARM, SHELF), true);
  });

  /**
   * The rule has to hold for any body. `armLine` is the player's own shoulder
   * line, so a tall player standing close and a short player standing back get
   * different numbers and the same behaviour.
   */
  test('it is the player\'s own line, not a fixed height', () => {
    for (const arm of [250, 400, 550, 640]) {
      assert.equal(isPoppable(arm - 1, arm, SHELF), true, `just above ${arm}`);
      assert.equal(isPoppable(arm + 1, arm, SHELF), false, `just below ${arm}`);
    }
  });

  /**
   * Degenerate framing: if a shoulder line is ever measured above the shelf,
   * nothing is poppable rather than everything being poppable. Failing closed
   * is right here — a field that silently pops itself is the bug the arming
   * line was added to prevent.
   */
  test('an impossible band fails closed', () => {
    assert.equal(isPoppable(100, 50, SHELF), false);
    assert.equal(isPoppable(50, 50, 114), false);
  });
});
