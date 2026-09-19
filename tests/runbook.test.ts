/**
 * THE RUNBOOK IS READ UNDER PRESSURE AND CANNOT BE WRONG.
 *
 * README.md's day-of card and its "numbers that have never seen a real body"
 * table are what somebody works from while holding a laptop in a loud room. A
 * stale figure there is worse than a stale comment in the source, because the
 * person reading it has no way to check and no time to.
 *
 * It had already drifted. `moveEnter` was documented at 0.85 and is 1.1 — the
 * one constant whose risk column reads "too low and everyone is out in two
 * seconds, unrecoverable at a stall", so the table was understating the safe
 * value on exactly the number where being wrong costs most. Nothing caught it
 * because nothing was looking.
 *
 * These tests look. They cover the two kinds of claim that can go stale
 * silently — a constant's value, and the NAME of a control a marshal is told
 * to reach for. Measured findings (reaction-time cliffs, score tables) are a
 * different kind of claim: they can only be re-measured, not checked, and they
 * are dated in the README for that reason.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { tunables } from '../src/meta/tunables.ts';
import { DEFAULT_REDLIGHT_TUNABLES } from '../src/games/redlight.ts';

const readme = async (): Promise<string> => {
  const { readFile } = await import('node:fs/promises');
  return readFile('README.md', 'utf8');
};

describe('the runbook matches the code', () => {
  /**
   * Every `**SLIDER NAME**` the README tells a marshal to reach for has to be
   * a real `label:` in tunables.ts.
   *
   * I got four of five wrong writing that table, guessing them from the
   * constant names: it is MATCH THRESHOLD not PASS THRESHOLD, PUNCH LATENCY
   * not INPUT LATENCY, ASSUMED LANE-STEP TIME and ASSUMED RECOVERY. A wrong
   * label is worse than no label — it sends somebody hunting for a control
   * that does not exist, at the one moment they have no time to hunt.
   */
  test('every slider the README names really exists', async () => {
    const md = await readme();
    const labels = new Set(tunables.list().map((t) => t.label));

    // `slider: **NAME**` and `sliders: **A**, **B**`
    const named = new Set<string>();
    for (const m of md.matchAll(/sliders?:\s*\*\*([^*]+)\*\*(?:,\s*\*\*([^*]+)\*\*)?/g)) {
      if (m[1]) named.add(m[1].trim());
      if (m[2]) named.add(m[2].trim());
    }

    assert.ok(named.size > 0, 'the README stopped naming any sliders at all');

    const missing = [...named].filter((n) => !labels.has(n));
    assert.deepEqual(
      missing,
      [],
      `the README sends a marshal to a control that does not exist. Real ` +
        `labels: ${[...labels].sort().join(', ')}`
    );
  });

  /**
   * The specific constants the risk table quotes, against their real source of
   * truth rather than against a copy.
   */
  test('the risk table quotes the real value of moveEnter', async () => {
    const md = await readme();
    const m = /`moveEnter = ([0-9.]+)/.exec(md);
    assert.ok(m, 'the moveEnter row is gone from the risk table');
    assert.equal(
      Number(m[1]),
      DEFAULT_REDLIGHT_TUNABLES.moveEnter,
      'README and DEFAULT_REDLIGHT_TUNABLES disagree about the Red Light ' +
        'move threshold'
    );
  });

  test('the risk table quotes the real punch latency', async () => {
    const md = await readme();
    const m = /`inputLatencySec = ([0-9.]+)/.exec(md);
    assert.ok(m, 'the inputLatencySec row is gone from the risk table');

    const spec = tunables.list().find((t) => t.key === 'rhythm.inputLatencySec');
    assert.ok(spec, 'rhythm.inputLatencySec is no longer a tunable');
    assert.equal(Number(m[1]), spec.default);
  });

  /**
   * The claim the table makes ABOUT ITSELF: that every constant on it can be
   * changed without a rebuild. That is the whole reason the list is useful on
   * a playtest day, and it is only true while each one has a slider.
   */
  test('every risky constant is still reachable without a rebuild', async () => {
    const keys = tunables.list().map((t) => t.key);
    for (const k of [
      'hover.reachX',
      'redlight.moveEnter',
      'posematch.passThreshold',
      'rhythm.inputLatencySec',
      'runner.laneStepTime',
      'runner.recoveryTime',
    ]) {
      assert.ok(keys.includes(k), `${k} is on the playtest list but is not a slider`);
    }
  });
});
