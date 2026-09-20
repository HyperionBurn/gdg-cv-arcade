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

import { isPoppable, popRadius, REACH_HALF_TORSOS } from '../src/games/balloonpop.ts';
import { REACH_HALF_TORSOS as FRUIT_REACH_HALF_TORSOS } from '../src/games/fruitninja.ts';
import { reachBandFor, FULL_STRETCH_TORSOS } from '../src/games/reach.ts';

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

/**
 * THE SAME REACH BUG, IN THE GAME LEAST ABLE TO AFFORD IT.
 *
 * Balloon Pop is the accessible one on the roster — the README's own word —
 * and it carried its own copy of the reach band, with its own tighter 1.25
 * torso half-width and the SAME shift-at-the-edge behaviour Fruit Ninja had.
 * Shifting preserves the band's width, which is twice the reach, so a body
 * near the edge of its slot got the whole 2.5 torso spread on one side of
 * itself. In the game somebody plays precisely because stretching is the thing
 * they cannot do.
 *
 * Both games now share `reach.ts`, which intersects instead of shifting.
 */
describe('balloons rise where the player can actually reach them', () => {
  const W = 1920;
  const H = 1080;
  const UNIT = 0.3 * H;
  const RADIUS = 0.045 * H;
  const SLOT = { x: 0, width: W };

  const band = (cx: number | null): { min: number; max: number } =>
    reachBandFor({
      cx,
      unit: cx === null ? 0 : UNIT,
      rect: SLOT,
      radius: RADIUS,
      halfTorsos: REACH_HALF_TORSOS,
      fallbackInset: 0.15,
    });

  test('nowhere on the screen asks for more than a full stretch', () => {
    const bad: string[] = [];
    for (let f = 0.02; f <= 0.98; f += 0.02) {
      const cx = f * W;
      const b = band(cx);
      const reach = Math.max(Math.abs(b.max - cx), Math.abs(cx - b.min)) / UNIT;
      if (reach > FULL_STRETCH_TORSOS + 1e-9) {
        bad.push(`${(f * 100).toFixed(0)}% across: ${reach.toFixed(2)} torso`);
      }
    }
    assert.deepEqual(bad, [], 'balloons spawn out of reach at:\n  ' + bad.join('\n  '));
  });

  /**
   * And this game asks for LESS than Fruit Ninja does, deliberately. If the two
   * ever converge it is because somebody tidied them together without noticing
   * that one of them is the game for people who cannot stretch.
   */
  test('and it asks for less reach than the crowd-puller does', () => {
    assert.ok(
      REACH_HALF_TORSOS < FRUIT_REACH_HALF_TORSOS,
      `Balloon Pop reaches ${REACH_HALF_TORSOS} torso and Fruit Ninja ` +
        `${FRUIT_REACH_HALF_TORSOS}. The accessible game must not ask for more.`
    );
    assert.ok(REACH_HALF_TORSOS > 0.6, 'the band has collapsed to a column above the player');
  });
});

/**
 * "DECREASE THE RANGE AT WHICH THEY REGISTER AS A STRIKEABLE OBJECT"
 *
 * Row 18 of FEEDBACK.md. The fix made pop slop a FLAT 0.04 torso instead of
 * scaling with balloon size, because a size-proportional rule fired on a
 * three-pixel graze at 720p and punished the small golden balloon twice —
 * smaller AND faster.
 *
 * It had no behavioural test: found by mutation, the constant could be changed
 * to anything and nothing failed but the check that the ledger still quotes
 * it. The measured table in the source is what chose 0.04; these are the two
 * properties that table was chosen FOR.
 */
describe('a balloon pops on contact, not on a graze', () => {
  const H720 = 720;
  const UNIT = 0.3 * H720;
  const GOLDEN_R = 0.035 * H720;
  const BIG_R = 0.063 * H720;

  const margin = (r: number): number => popRadius(r, UNIT) - r;

  test('the forgiveness does not scale with the balloon', () => {
    assert.ok(
      Math.abs(margin(GOLDEN_R) - margin(BIG_R)) < 1e-9,
      `a small balloon gets ${margin(GOLDEN_R).toFixed(1)}px of slop and a big one ` +
        `${margin(BIG_R).toFixed(1)}px. That is the size-proportional rule the report ` +
        `was about, and it punishes the golden balloon twice`
    );
  });

  test('and it is small enough that the hand is really on the balloon', () => {
    // Against the SMALLEST balloon, which is where a fixed margin is worst.
    const ratio = margin(GOLDEN_R) / GOLDEN_R;
    assert.ok(
      ratio < 0.4,
      `the pop radius is ${(ratio * 100).toFixed(0)}% wider than the drawn golden ` +
        `balloon, so it pops with the marker outside it — the graze the report named`
    );
    assert.ok(
      margin(GOLDEN_R) > 2,
      'the slop has gone to nothing; this game is about inclusion and needs some'
    );
  });
});
