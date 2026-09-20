/**
 * THE RUNBOOK TELLS A MARSHAL TO WAIT. THIS CHECKS THEY ARE WAITING FOR
 * SOMETHING.
 *
 * README's failure table answers a red `<CAMERA LOST — RECONNECTING>` bar
 * with: "Push the USB cable back in and **wait**. It is already retrying —
 * 1s, 2s, 4s, 8s, then every 10s, forever. Most USB knocks come back inside
 * two tries."
 *
 * That is a promise made to somebody standing in front of a queue with no way
 * to check it, and it was unguarded. The schedule lived as an inline
 * expression inside `main.ts`, which cannot be imported by a test because it
 * boots the whole app on evaluation — so a change to the base or the cap would
 * have turned the runbook into fiction silently, on exactly the screen a
 * marshal reads when they have no time to read anything.
 *
 * `runbook.test.ts` already guards the SLIDER NAMES the README sends people
 * to, for the same reason and after the same kind of drift. This is the same
 * idea applied to a number: the README is parsed, and the sequence it states
 * is compared against the function the app actually runs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  recoveryDelayMs,
  recoveryElapsedMs,
  RECOVER_CAP_MS,
  RECOVER_QUIET_TRIES,
  cameraBannerText,
} from '../src/core/camera.ts';

const readme = async (): Promise<string> => {
  const { readFile } = await import('node:fs/promises');
  return readFile('README.md', 'utf8');
};

describe('the camera recovery schedule is the one the runbook promises', () => {
  test('it doubles from one second and then flattens', () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map(recoveryDelayMs),
      [1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000]
    );
  });

  /**
   * Parsed out of the README rather than hardcoded here, so the two cannot
   * drift apart in either direction — changing the code fails this, and so
   * does changing the sentence.
   */
  test('and the README states exactly that sequence', async () => {
    const md = await readme();
    const m = /retrying\s*[—-]\s*(\d+)s,\s*(\d+)s,\s*(\d+)s,\s*(\d+)s,\s*then every (\d+)s/.exec(md);
    assert.ok(
      m,
      'the README no longer states a retry sequence for the CAMERA LOST bar. ' +
        'It is the only instruction on that row, and the instruction is to wait.'
    );

    const stated = [m[1], m[2], m[3], m[4]].map((s) => Number(s) * 1000);
    assert.deepEqual(
      stated,
      [1, 2, 3, 4].map(recoveryDelayMs),
      'the README promises a different first four retries than the app performs'
    );
    assert.equal(
      Number(m[5]) * 1000,
      RECOVER_CAP_MS,
      'the README promises a different steady-state retry interval than the cap'
    );
  });

  /**
   * The second half of the same row: "Most USB knocks come back inside two
   * tries." Two tries has to be a short wait, or the sentence is telling
   * somebody to stand still while a queue builds.
   */
  test('two tries is over within three seconds', () => {
    assert.ok(
      recoveryElapsedMs(3) <= 3000,
      `the second retry lands at ${recoveryElapsedMs(3)}ms, so "inside two tries" ` +
        `is a longer wait than the runbook implies`
    );
  });

  /**
   * The NEXT row: "It has been trying for half a minute and it is not coming
   * back on its own." The banner switches from RECONNECTING to PRESS F5 after
   * `RECOVER_QUIET_TRIES` (6) quiet attempts, so attempt 7 is when a human is
   * asked — and that moment has to actually be about half a minute in, or the
   * two rows of the table describe different failures.
   */
  test('and the give-up point really is about half a minute', () => {
    const t = recoveryElapsedMs(7);
    assert.ok(
      t >= 25_000 && t <= 45_000,
      `the banner asks for a human at ${(t / 1000).toFixed(0)}s, which is not ` +
        `"half a minute" — either the backoff or the sentence has moved`
    );
  });

  /** A cap that is not a cap is an unbounded wait. */
  test('it never waits longer than the cap, however long it has been failing', () => {
    for (const n of [9, 20, 100, 5000]) {
      assert.equal(recoveryDelayMs(n), RECOVER_CAP_MS, `attempt ${n} waited longer than the cap`);
    }
  });

  /** Defensive: `recoverTries` is incremented before use, but 0 must not hang. */
  test('and a zeroth attempt is treated as the first', () => {
    assert.equal(recoveryDelayMs(0), recoveryDelayMs(1));
    assert.equal(recoveryDelayMs(-5), recoveryDelayMs(1));
  });
});

/**
 * main.ts must actually USE it. Extracting a schedule into a testable function
 * and leaving the old inline expression in place would be a guard that guards
 * nothing — the exact failure this session already hit once, in a source check
 * that matched its own comment.
 */
describe('the app runs the schedule that is tested', () => {
  test('main.ts asks core/camera for the delay', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/main.ts', 'utf8');

    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');

    assert.match(code, /recoveryDelayMs\s*\(/, 'main.ts no longer calls the tested function');
    assert.doesNotMatch(
      code,
      /Math\.min\(\s*10000\s*,/,
      'main.ts has an inline backoff again, so the tested function is decoration'
    );
  });

  /**
   * Same check for the words. Testing `cameraBannerText` proves nothing if
   * `main.ts` went back to choosing the string itself — the tested function
   * would be decoration and the bar on screen could say anything.
   */
  test('main.ts asks core/camera for the words too', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/main.ts', 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');

    assert.match(code, /cameraBannerText\s*\(/, 'main.ts no longer calls the tested function');
    assert.doesNotMatch(
      code,
      /'<CAMERA LOST/,
      'main.ts spells a bar out again, so the tested function is decoration',
    );
  });
});

/**
 * AND THE WORDS ON THE BAR, WHICH ARE THE OTHER HALF OF THE SAME PROMISE.
 *
 * The schedule above is guarded because it was an inline expression in
 * `main.ts` that no test could import. The three STRINGS README's failure
 * table tells a marshal to act on were sitting in the same file, in the same
 * shape, unguarded — a ternary nobody could reach. Changing any of them, or
 * the threshold between them, would have turned the runbook into fiction on
 * exactly the screen somebody reads when they have no time to read anything.
 *
 * The distinction is the whole point: RECONNECTING means "wait, it is already
 * retrying", PRESS F5 is the admission that waiting has not worked, and
 * VISION OFFLINE is a different fault with different instructions.
 */
describe('the red bar says which fault it is', () => {
  test('a camera that has just gone says to wait', () => {
    assert.equal(cameraBannerText('error', 1), '<CAMERA LOST — RECONNECTING>');
    assert.equal(
      cameraBannerText('error', RECOVER_QUIET_TRIES),
      '<CAMERA LOST — RECONNECTING>',
      'the last quiet try still says wait',
    );
  });

  test('a camera that is not coming back asks for a human', () => {
    assert.equal(cameraBannerText('error', RECOVER_QUIET_TRIES + 1), '<CAMERA LOST — PRESS F5>');
  });

  /**
   * The README promises the give-up point is "half a minute". That number and
   * this threshold are the same fact stated twice, so they are checked
   * against each other rather than both against a literal.
   */
  test('and it waits about half a minute before saying so', () => {
    const ms = recoveryElapsedMs(RECOVER_QUIET_TRIES + 1);
    assert.ok(ms >= 25_000 && ms <= 40_000, `gave up after ${ms}ms, not about half a minute`);
  });

  /**
   * A dead pose worker is not a dead camera, and the README sends the marshal
   * somewhere different for it — including that the shell walks itself back to
   * attract, so the stall is blind rather than frozen.
   */
  test('a dead worker is a different bar, whatever the camera is doing', () => {
    for (const status of ['idle', 'starting', 'live'] as const) {
      assert.equal(cameraBannerText(status, 99), '<VISION OFFLINE — PRESS F5>', status);
    }
  });

  test('the README failure table quotes these three bars exactly', async () => {
    const { readFile } = await import('node:fs/promises');
    // The table escapes the angle brackets for Markdown, so compare against
    // the escaped form rather than stripping it — a bar the README spells
    // differently is a bar the marshal cannot find.
    const readme = await readFile('README.md', 'utf8');
    const bars = [
      cameraBannerText('error', 1),
      cameraBannerText('error', RECOVER_QUIET_TRIES + 1),
      cameraBannerText('live', 0),
    ];
    for (const bar of bars) {
      const escaped = bar.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      assert.ok(
        readme.includes(escaped),
        `README's failure table does not mention ${bar}. A bar with no row is ` +
          'a marshal reading an unfamiliar string with a queue waiting.',
      );
    }
  });
});
