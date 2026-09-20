/**
 * "SENS IS LOW FOR SELECTING, MIGHT PICK THE WRONG GAME" — row 1 of FEEDBACK.md.
 *
 * The hover cursor's One Euro `beta` was 0.008, which is almost no speed
 * adaptation at all: the cutoff stayed near its 0.6Hz floor (tau ~265ms) even
 * during a fast reach, so the cursor lagged behind the hand and then overshot
 * as it caught up. It went to 0.25.
 *
 * That fix had no behavioural test. Found by mutation, sweeping every row of
 * the ledger: `beta` could be set back to 0.008 and nothing in the suite failed
 * except the check that FEEDBACK.md still quotes the value.
 *
 * ---------------------------------------------------------------------------
 * A STEP IS THE WRONG SHAPE, and the first version of this file used one.
 *
 * With a step the input's derivative spikes for a single frame and is zero
 * afterwards, so the speed coefficient barely engages and BOTH presets measure
 * slow — 367ms to cover the move on the shipped one. A reach across a menu is
 * a RAMP: the hand holds a high velocity for a third of a second, which is
 * precisely the regime `beta` exists for. Measured over a 0.35s reach:
 *
 *                 lag during the move    settle after it stops    rest jitter
 *   beta 0.008          165 ms                   933 ms             0.675%
 *   beta 0.25           120 ms                   667 ms             0.677%
 *
 * The last column is the point of the fix as much as the first two: the
 * preset's claim is that the hold is as steady as before and only the journey
 * changed. It is a free win rather than a trade, and that is worth asserting
 * rather than assuming.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { OneEuro, FILTER_PRESETS } from '../src/core/filter.ts';

const FPS = 30;
const DT = 1 / FPS;

const PRECISE = FILTER_PRESETS.handPrecise;
/** What the report was about, kept so these tests can show they can see it. */
const REPORTED_BAD = { ...PRECISE, beta: 0.008 };

/** A fast reach across the menu: constant velocity, then hold. */
const TRAVEL_SEC = 0.35;

function reach(params: typeof PRECISE): { lagSec: number; settleSec: number } {
  const f = new OneEuro(params);
  let t = 0;
  // Settle at rest first, so this is not measuring the filter's cold start.
  for (let i = 0; i < 30; i++, t += DT) f.filter(0, t);

  const v = 1 / TRAVEL_SEC;
  const n = Math.round(TRAVEL_SEC / DT);
  const lags: number[] = [];
  for (let i = 1; i <= n; i++, t += DT) {
    const x = Math.min(1, v * (i * DT));
    const y = f.filter(x, t);
    // Time-lag: the output sits where the hand was `y / v` seconds into the
    // move, so the difference is how far behind the hand the cursor is.
    // Second half only — the first is still the filter accelerating.
    if (i > n / 2) lags.push(i * DT - y / v);
  }
  const lagSec = lags.reduce((a, b) => a + b, 0) / Math.max(1, lags.length);

  let settleSec = Infinity;
  for (let i = 0; i < 200; i++, t += DT) {
    if (Math.abs(f.filter(1, t) - 1) < 0.02) {
      settleSec = (i + 1) * DT;
      break;
    }
  }
  return { lagSec, settleSec };
}

/** Peak-to-peak wobble while the hand is held still under landmark noise. */
function restJitter(params: typeof PRECISE): number {
  const f = new OneEuro(params);
  let t = 0;
  let seed = 12345;
  const noise = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff - 0.5) * 0.02; // +-1% of the axis, per frame
  };

  for (let i = 0; i < 60; i++, t += DT) f.filter(0.5 + noise(), t);

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 180; i++, t += DT) {
    const y = f.filter(0.5 + noise(), t);
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  return hi - lo;
}

describe('the hover cursor arrives quickly and still holds still', () => {
  test('the cursor is not trailing the hand across the menu', () => {
    const { lagSec } = reach(PRECISE);
    assert.ok(
      lagSec < 0.15,
      `the cursor runs ${(lagSec * 1000).toFixed(0)}ms behind the hand during a reach. ` +
        `That trailing is what a player reads as low sensitivity, and it is what ` +
        `puts the ring over the wrong tile`
    );
  });

  test('and it stops moving soon after the hand does', () => {
    const { settleSec } = reach(PRECISE);
    assert.ok(
      settleSec < 0.8,
      `the cursor is still catching up ${(settleSec * 1000).toFixed(0)}ms after the hand ` +
        `stopped. The dwell has to start over when it arrives, on top of an ` +
        `already deliberate 1.5s hold`
    );
  });

  /**
   * THE CONTROL. If the reported settings do not measure worse here, this
   * harness cannot see the thing it claims to check and the two tests above
   * are worth nothing.
   */
  test('and the settings the report was about really do measure worse', () => {
    const good = reach(PRECISE);
    const bad = reach(REPORTED_BAD);
    assert.ok(
      bad.lagSec > good.lagSec * 1.25,
      `beta 0.008 measured ${(bad.lagSec * 1000).toFixed(0)}ms of lag against ` +
        `${(good.lagSec * 1000).toFixed(0)}ms — this harness is not measuring lag`
    );
    assert.ok(
      bad.settleSec > good.settleSec * 1.25,
      `beta 0.008 settled in ${(bad.settleSec * 1000).toFixed(0)}ms against ` +
        `${(good.settleSec * 1000).toFixed(0)}ms`
    );
  });

  /**
   * The other half, and the reason `beta` cannot simply be raised until the
   * lag goes away: the dwell ring has to sit on a tile for a second and a half
   * without wandering off it.
   */
  test('a held hand does not wobble the dwell off its tile', () => {
    const jitter = restJitter(PRECISE);
    assert.ok(
      jitter < 0.012,
      `a still hand moves the cursor ${(jitter * 100).toFixed(2)}% of the axis under ` +
        `ordinary landmark noise; the dwell ring will wander off the tile it is filling`
    );
  });

  test('and it is no less steady than the settings it replaced', () => {
    const now = restJitter(PRECISE);
    const before = restJitter(REPORTED_BAD);
    assert.ok(
      now <= before * 1.2,
      `rest jitter went from ${(before * 100).toFixed(3)}% to ${(now * 100).toFixed(3)}%. ` +
        `The speed coefficient is supposed to cost nothing while the hand is still, ` +
        `which is what makes this a free win rather than a trade`
    );
  });

  test('the blade preset still tracks faster than the menu cursor', () => {
    assert.ok(
      FILTER_PRESETS.handFast.beta > PRECISE.beta,
      'a blade tip must track faster than a menu cursor, or the presets have been swapped'
    );
  });
});
