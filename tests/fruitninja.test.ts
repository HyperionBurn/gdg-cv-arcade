/**
 * FRUIT NINJA'S BOMBS.
 *
 * The game had no test file of its own. Its slice geometry is thoroughly
 * covered by `geometry.test.ts` — area conserved across 30 shapes and 12 cut
 * angles, convexity across 60 seeds, fast-swipe tunnelling — and everything
 * else about it was resting on measurements recorded once in README.md.
 *
 * What the bomb rules protect is the game's whole character. ARCHITECTURE.md's
 * "What good means here" ends with "failure should be funny, never punishing",
 * and a bomb is the only way to fail here. Three separate decisions keep it a
 * punchline rather than a penalty, and each is the kind somebody could undo
 * while tidying up without knowing what it was for.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { bombPenalty, reachBandFor, FULL_STRETCH_TORSOS } from '../src/games/fruitninja.ts';

const BUDGET = 12; // BOMB_TIME_BUDGET_SEC
const PENALTY = 8; // BOMB_TIME_PENALTY

describe('a bad round cannot be deleted by bombs', () => {
  /**
   * The cap is the point. Eight seconds a bomb against a 60s round means three
   * unlucky swings would take 24 — and a run of them would end the round
   * outright, which is not funny, it is just over.
   */
  test('total time lost is capped however many bombs are hit', () => {
    let bombSeconds = 0;
    let timeLeft = 60;
    let spent = 0;

    for (let i = 0; i < 20; i++) {
      const r = bombPenalty(timeLeft, bombSeconds, false);
      bombSeconds = r.bombSeconds;
      timeLeft = r.timeLeft;
      spent += r.spend;
    }

    assert.ok(spent <= BUDGET + 1e-9, `bombs took ${spent}s, budget is ${BUDGET}`);
    assert.equal(bombSeconds, BUDGET);
  });

  test('the last bomb inside the budget takes only what is left of it', () => {
    // 8 + 8 would be 16 against a budget of 12, so the second takes 4.
    const first = bombPenalty(60, 0, false);
    assert.equal(first.spend, PENALTY);

    const second = bombPenalty(first.timeLeft, first.bombSeconds, false);
    assert.equal(second.spend, BUDGET - PENALTY);
    assert.equal(second.bombSeconds, BUDGET);
  });

  test('and once it is gone, bombs cost the clock nothing', () => {
    const r = bombPenalty(30, BUDGET, false);
    assert.equal(r.spend, 0);
    assert.equal(r.timeLeft, 30, 'the clock moved after the budget was spent');
    assert.equal(r.bombSeconds, BUDGET);
  });

  /**
   * They are not FREE at that point — `BOMB_STUN_MS` still applies, and that
   * is deliberate. This only asserts that the cost stops coming out of the
   * clock, which is the part that could delete a round.
   */
  test('a bomb never ends the round outright', () => {
    for (const timeLeft of [8, 3, 1, 0.7, 0.6]) {
      const r = bombPenalty(timeLeft, 0, false);
      assert.ok(r.timeLeft >= 0.6, `clock hit ${r.timeLeft} from ${timeLeft}`);
    }
  });
});

describe('in versus a bomb costs the clock nothing at all', () => {
  /**
   * The clock is SHARED. Charging it punishes the opponent for a mistake they
   * did not make — measured at two bombs on one side taking 24s off a 45s
   * round for both players. The penalty in versus is the per-slot blade stun,
   * which lands only on the person who swung.
   */
  test('no time is taken, and no budget is consumed', () => {
    const r = bombPenalty(45, 0, true);
    assert.equal(r.spend, 0);
    assert.equal(r.timeLeft, 45);
    assert.equal(r.bombSeconds, 0, 'versus must not spend the solo budget');
  });

  test('not even after many bombs', () => {
    let timeLeft = 45;
    let bombSeconds = 0;
    for (let i = 0; i < 10; i++) {
      const r = bombPenalty(timeLeft, bombSeconds, true);
      timeLeft = r.timeLeft;
      bombSeconds = r.bombSeconds;
    }
    assert.equal(timeLeft, 45, 'a shared clock was charged for one player');
  });
});

describe('the readout matches what was actually taken', () => {
  /**
   * `detonate` shows `-Ns` when time was taken and `<BLADES OUT!>` when it was
   * not, keyed off the same `spend`. A bomb that says it took 8 seconds and
   * took 4 is worse than one that says nothing.
   */
  test('spend is exactly the difference it made to the clock', () => {
    for (const [timeLeft, already] of [
      [60, 0],
      [60, 6],
      [60, BUDGET],
      [5, 0],
    ] as const) {
      const r = bombPenalty(timeLeft, already, false);
      const actual = timeLeft - r.timeLeft;
      // Equal unless the 0.6s floor clamped it, in which case it took less.
      assert.ok(
        Math.abs(actual - r.spend) < 1e-9 || r.timeLeft === 0.6,
        `reported ${r.spend}s but the clock moved ${actual}s`
      );
    }
  });
});

/**
 * "I LEGIT COULDN'T REACH MOST" OF THE FRUIT — row 20 of FEEDBACK.md.
 *
 * The fix was to throw fruit through a band measured from the player's own
 * body rather than at a fraction of the slot rect. `REACH_HALF_TORSOS` is the
 * half-width of that band, and it had NO behavioural test at all: found by
 * mutation, changing it failed nothing in the suite except the check that the
 * ledger still quotes it.
 *
 * Writing the test found the report coming back. The band shifted rather than
 * shrank at a slot edge, which preserves its WIDTH — 2 x 1.45 torso — so a
 * body near the edge got the whole 2.9 torso spread on one side of itself.
 * Measured before the fix, by body position across a 1920x1080 screen:
 *
 *   0.10 -> 2.51 torso   0.20 -> 1.91   0.30..0.70 -> 1.45   0.80 -> 1.91   0.90 -> 2.51
 *
 * against a full stretch of 1.57. Centred players were fine, which is why the
 * distribution table in the source — measured on a centred body — reads 0%
 * beyond a full stretch and missed it.
 */
describe('fruit is thrown where the player can actually reach it', () => {
  const W = 1920;
  const H = 1080;
  const UNIT = 0.3 * H;
  const RADIUS = 0.06 * H;
  const SLOT = { x: 0, width: W };

  /** Farthest the band asks a body at `cx` to reach, in torso units. */
  const worstReach = (cx: number): number => {
    const b = reachBandFor({ cx, unit: UNIT, rect: SLOT, radius: RADIUS });
    return Math.max(Math.abs(b.max - cx), Math.abs(cx - b.min)) / UNIT;
  };

  test('nowhere on the screen asks for more than a full stretch', () => {
    const bad: string[] = [];
    for (let f = 0.02; f <= 0.98; f += 0.02) {
      const reach = worstReach(f * W);
      if (reach > FULL_STRETCH_TORSOS + 1e-9) {
        bad.push(`${(f * 100).toFixed(0)}% across: ${reach.toFixed(2)} torso`);
      }
    }
    assert.deepEqual(
      bad,
      [],
      'the band asks for more than a full stretch at these body positions, ' +
        'which is the complaint this band exists to answer:\n  ' + bad.join('\n  ')
    );
  });

  test('a centred player still gets the full spread', () => {
    const b = reachBandFor({ cx: W / 2, unit: UNIT, rect: SLOT, radius: RADIUS });
    assert.ok(
      (b.max - b.min) / UNIT > 2.5,
      `a centred player's band is only ${((b.max - b.min) / UNIT).toFixed(2)} torso wide; ` +
        `the reach limit has been tightened into a shrunken game`
    );
  });

  /**
   * The cost of the fix, stated rather than hidden: an edge player trades
   * spread for reachability. Half a band they can reach beats a full one they
   * cannot, but it must not collapse to a single point either.
   */
  test('and a player at the very edge still gets a band, not a spot', () => {
    for (const f of [0.03, 0.97]) {
      const b = reachBandFor({ cx: f * W, unit: UNIT, rect: SLOT, radius: RADIUS });
      assert.ok(
        (b.max - b.min) / UNIT > 1.0,
        `at ${(f * 100).toFixed(0)}% across the band is ${((b.max - b.min) / UNIT).toFixed(2)} ` +
          `torso wide — every fruit arrives in the same place`
      );
    }
  });

  test('no body anchored yet falls back to the slot, not to nothing', () => {
    const b = reachBandFor({ cx: null, unit: 0, rect: SLOT, radius: RADIUS });
    assert.ok(b.max > b.min, 'the pre-anchor band is empty, so no fruit can spawn');
    assert.ok(b.min > 0 && b.max < W, 'the pre-anchor band runs off the slot');
  });
});
