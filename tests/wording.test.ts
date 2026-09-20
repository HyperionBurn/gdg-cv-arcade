/**
 * THE WORDS THAT TELL SOMEBODY WHAT TO DO.
 *
 * Two ledger rows whose entire fix is a choice of words, and neither had a
 * test. Found by mutating the ledger's string anchors: replace the string,
 * run the suite, and see whether anything fails except the check that
 * FEEDBACK.md still quotes it. For both of these, nothing did.
 *
 *   13  `<PUMP>`, not `<MOVE>` — the word names the motion that scores
 *       instead of the one that eliminates you.
 *   16  "NEXT PLAYER IN 5" states a fact about the software. The line now
 *       leads with the instruction and carries the number after it.
 *
 * A word is the cheapest thing in a codebase to "tidy" and the most expensive
 * to get wrong at a stall, because it is the only instruction most players
 * read and nobody is there to correct it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { bannerWord } from '../src/games/redlight.ts';
import { handoffLine } from '../src/games/base.ts';

describe('Red Light names the motion that scores', () => {
  test('the go state says PUMP', () => {
    assert.equal(bannerWord('green'), '<PUMP>');
  });

  test('and the stop state says FREEZE', () => {
    assert.equal(bannerWord('red'), '<FREEZE>');
  });

  /**
   * The rejected word, and why. People read "move" and WALKED, which cannot
   * work here: there is no floor space at a stall, and stepping toward the
   * camera changes the body scale every threshold in that game is divided by.
   * So a player following the instruction breaks the game that gave it.
   */
  test('and neither state ever tells anybody to MOVE', () => {
    for (const light of ['red', 'green'] as const) {
      assert.doesNotMatch(
        bannerWord(light),
        /MOVE|WALK|RUN/,
        `the ${light} banner tells a player to travel. There is no floor space at ` +
          `a stall, and walking toward the camera moves the scale every threshold ` +
          `in this game is measured against`
      );
    }
  });

  /** Both states have to be an instruction, not a colour. */
  test('both states are an instruction rather than a light colour', () => {
    for (const light of ['red', 'green'] as const) {
      assert.doesNotMatch(
        bannerWord(light),
        /RED|GREEN/,
        `the ${light} banner names the light instead of what to do about it`
      );
      assert.match(bannerWord(light), /^<[A-Z]+>$/, 'the banner lost the house headline style');
    }
  });
});

describe('the results line asks the player to move, then says how long', () => {
  test('it leads with the instruction', () => {
    const line = handoffLine(5);
    assert.ok(
      line.startsWith('STEP OUT'),
      `the line reads "${line}". A player who has just seen their score is looking ` +
        `at their score, not working out that a countdown is addressed to them`
    );
  });

  test('and still carries the number, after it', () => {
    const line = handoffLine(5);
    const instruction = line.indexOf('STEP OUT');
    const number = line.indexOf('5');
    assert.ok(number > instruction, `the count comes before the instruction in "${line}"`);
    for (const n of [7, 3, 1, 0]) {
      assert.ok(handoffLine(n).includes(String(n)), `the count is missing at ${n}`);
    }
  });

  /**
   * The exact line the report was about. It is still a true statement about
   * the software, which is why it survived so long.
   */
  test('and it is not the bare statement of fact it replaced', () => {
    assert.notEqual(handoffLine(5), 'NEXT PLAYER IN 5');
  });
});

/**
 * Both helpers have to be the ones the screens actually draw. A pure function
 * nothing calls is a fix that exists only in a test — which is the failure
 * this whole sweep of the ledger is about.
 */
describe('and the screens draw these, not their own copies', () => {
  const codeOf = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');

  test('Red Light banners through bannerWord', async () => {
    const { readFile } = await import('node:fs/promises');
    const code = codeOf(await readFile('src/games/redlight.ts', 'utf8'));
    assert.match(code, /const word = bannerWord\(/, 'the banner builds its own word again');
  });

  test('and the results screen draws handoffLine', async () => {
    const { readFile } = await import('node:fs/promises');
    const code = codeOf(await readFile('src/games/base.ts', 'utf8'));
    assert.match(code, /drawText\(ctx, handoffLine\(/, 'the results line is built inline again');
  });
});
