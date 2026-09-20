/**
 * A WAY OFF THE INITIALS SCREEN WITHOUT TYPING A NAME — row 26 of FEEDBACK.md.
 *
 * Before it, the only two exits were typing three letters or standing still
 * through the 16-second deadline, in front of a queue, having already
 * finished playing. A player who does not care about the board now gets off
 * this screen in 0.95s instead of 16, which at a stall is a whole extra turn
 * every few players.
 *
 * The fix is one word: the confirm key reads SKIP while the entry is empty and
 * OK once there is something to confirm. Same key, same place, same single
 * dwell — the word just stops lying about what pressing it will do.
 *
 * It had no test. Found by mutating the ledger's string anchors: `'SKIP'`
 * could be replaced with anything and nothing failed but the check that
 * FEEDBACK.md still quotes it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { okKeyLabel } from '../src/shell/initials.ts';

describe('the initials screen can be left without typing a name', () => {
  test('the confirm key offers SKIP while nothing has been typed', () => {
    assert.equal(
      okKeyLabel('OK', 0),
      'SKIP',
      'an empty entry shows OK, which offers a player who wants to leave ' +
        'nothing but the 16s deadline'
    );
  });

  test('and becomes OK the moment there is something to confirm', () => {
    for (const typed of [1, 2, 3]) {
      assert.equal(
        okKeyLabel('OK', typed),
        'OK',
        `with ${typed} letters typed the key still says SKIP, which reads as ` +
          `"throw away what I just entered"`
      );
    }
  });

  /**
   * It is the SAME key, not an extra one. A second control is a second thing
   * to find and another target competing for the same dwell — and the grid is
   * A-Z plus DEL and OK precisely so nobody has to hunt.
   */
  test('and no other key changes its label', () => {
    for (const key of ['A', 'M', 'Z', 'DEL']) {
      assert.equal(
        okKeyLabel(key, 0),
        key,
        `${key} changes what it says when the entry is empty; only the confirm ` +
          `key is supposed to`
      );
    }
  });

  /**
   * The screen has to USE it. A pure helper nothing calls is a fix that only
   * exists in a test — which is the failure this whole sweep is about.
   */
  test('the screen renders its keys through that helper', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/shell/initials.ts', 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');

    assert.match(
      code,
      /okKeyLabel\(key, this\.letters\.length\)/,
      'the initials screen no longer labels its keys through okKeyLabel, so the ' +
        'tests above are about a function nothing calls'
    );
  });
});
