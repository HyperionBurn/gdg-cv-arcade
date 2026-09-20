/**
 * THE PROBE THAT DECIDES WHAT THE CENSUS SEES.
 *
 * `census.test.ts` guards the app against banners nobody can reach. This
 * guards the thing that produced its data. A classifier that quietly stops
 * recognising a banner does not fail anything — it just shrinks the recorded
 * set, and every banner it drops then looks like a NEW string the next time
 * somebody sweeps, or worse, looks explained when it never appeared.
 *
 * Small surface on purpose. The counting itself needs a real canvas, so the
 * property that matters most — that the prototype patch is always removed —
 * is checked structurally here and was verified live in the browser: after a
 * sweep whose outer call timed out mid-run, `fillText` was confirmed back to
 * its original implementation because the restore is in a `finally`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isBracketed } from '../src/dev/census.ts';

describe('the census classifier', () => {
  test('recognises the banner convention', () => {
    for (const s of ['<PUMP>', '<FREEZE>', '<STARTING IN 3>', '<PLAYER 2 AHEAD>']) {
      assert.equal(isBracketed(s), true, s);
    }
  });

  test('ignores ordinary drawn text', () => {
    // Scores and clock readings are the overwhelming majority of what a sweep
    // collects — 4581 distinct strings in the production run.
    for (const s of ['184', 'SCORE', '1-2P', '', ' ', 'REPS (67)']) {
      assert.equal(isBracketed(s), false, JSON.stringify(s));
    }
  });

  /**
   * A bracket on one side only is not a banner. Getting this wrong would pull
   * fragments of `drawTabularNumber` output into the recorded set, and that
   * draws glyph by glyph.
   */
  test('needs both ends', () => {
    assert.equal(isBracketed('<PUMP'), false);
    assert.equal(isBracketed('PUMP>'), false);
    assert.equal(isBracketed('a <PUMP> b'), false);
  });

  /**
   * `<>` is two characters of nothing. Counting it would put an empty entry
   * in the allowlist that no source literal can ever match, which is the kind
   * of row that makes a reviewer stop trusting the rest of the list.
   */
  test('an empty pair is not a banner', () => {
    assert.equal(isBracketed('<>'), false);
    assert.equal(isBracketed('<'), false);
    assert.equal(isBracketed('>'), false);
  });

  test('a single character between brackets is', () => {
    assert.equal(isBracketed('<X>'), true);
  });
});

/**
 * THE PATCH MUST ALWAYS COME OFF.
 *
 * `runCensus` replaces `CanvasRenderingContext2D.prototype.fillText` and
 * `host.audio.play` for the length of a sweep. A leaked patch slows every
 * later frame and, worse, keeps counting during manual play, which quietly
 * poisons the next report with numbers nobody asked for.
 *
 * It has to survive the sweep THROWING, which is not hypothetical: a full
 * roster exceeds the dev console's evaluation cap, so the outer call is
 * routinely cut off mid-run. Verified live on the 20th — after exactly that,
 * `fillText` was back to its original implementation.
 */
describe('the census probe cleans up after itself', () => {
  const source = async (): Promise<string> => {
    const { readFile } = await import('node:fs/promises');
    return readFile('src/dev/census.ts', 'utf8');
  };

  test('the restore is in a finally, not after the await', async () => {
    const src = await source();
    const body = src.slice(src.indexOf('export async function runCensus'));
    const fin = body.indexOf('} finally {');
    assert.ok(fin > 0, 'runCensus no longer restores in a finally');

    for (const restore of ['proto.fillText = origFill', 'host.audio.play = origPlay']) {
      const at = body.indexOf(restore);
      assert.ok(at > 0, `${restore} is gone, so that patch leaks`);
      assert.ok(at > fin, `${restore} runs outside the finally, so a throw leaks it`);
    }
  });

  /**
   * The store lives on `globalThis` so an HMR reload of this very file cannot
   * silently empty it mid-sweep. That is the second-instance trap this repo
   * has hit three times, and a probe is the file most likely to be edited
   * while it is running.
   */
  test('the store survives this module being reloaded', async () => {
    const src = await source();
    assert.match(
      src,
      /globalThis/,
      'the census store went back to module scope, so editing this file ' +
        'mid-sweep empties it and the report reads as "nothing draws"',
    );
  });
});
