/**
 * NOTHING TO BEAT IS NOT A LEADERBOARD — row 25 of FEEDBACK.md.
 *
 * Reported from an outside playtest: on a fresh install the menu shows
 * "BE THE FIRST!" on all seven tiles, and a player choosing a game has no idea
 * what a good score looks like during the one moment they are deciding which
 * game to play. A target is most of what makes an arcade score mean anything.
 *
 * The fix is a row in the operator's SCORES tab where a marshal types a real
 * number. It had no test: mutating the ledger's string anchors, `op-entry-row`
 * could be renamed to anything and nothing failed but the check that
 * FEEDBACK.md still quotes it.
 *
 * Three claims, and the second is the one that would rot quietly.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { leaderboard } from '../src/meta/leaderboard.ts';

describe('a marshal can put a target on the board before doors open', () => {
  beforeEach(() => {
    leaderboard.clearAll();
  });

  test('a typed score reaches the board it was typed for', () => {
    leaderboard.submit('sixtyseven', 190, 'GDG', null);
    const board = leaderboard.getBoard('sixtyseven');
    assert.equal(board.length, 1, 'the typed target never reached the board');
    assert.equal(board[0]?.score, 190);
    assert.equal(leaderboard.getBoard('rhythm').length, 0, 'it landed on another game too');
  });

  /**
   * A STAFF TARGET IS NOT A TEAM SCORING.
   *
   * The console submits it with a `null` faction on purpose: adding it to a
   * faction total would tilt the race that the rest of that tab works to keep
   * honest, and the faction band is on screen all day. This is the half of the
   * fix that would go unnoticed if it broke — the target would still appear,
   * the board would still look right, and one faction would simply be ahead.
   */
  test('and it does not tilt the faction race', () => {
    const before = leaderboard.getFactionTotals().reduce((n, f) => n + f.total, 0);
    leaderboard.submit('sixtyseven', 190, 'GDG', null);
    const after = leaderboard.getFactionTotals().reduce((n, f) => n + f.total, 0);
    assert.equal(after, before, 'a staff target was added to a faction total');
  });

  /**
   * NO AUTO-SEEDING, and this is a deliberate refusal rather than a missing
   * feature. Scoring scales here are not comparable — a strong 67 Speed is
   * about 190, a strong Rhythm about 2400, a strong Pose Match single digits —
   * so a "seed sensible defaults" button would be this repo guessing on behalf
   * of a hall it has never seen. The honest way to get a real target is to play
   * a round before doors open and type what you got.
   */
  test('and a fresh install seeds nothing by itself', () => {
    for (const game of [
      'sixtyseven',
      'fruitninja',
      'balloonpop',
      'redlight',
      'posematch',
      'runner',
      'rhythm',
    ] as const) {
      assert.equal(
        leaderboard.getBoard(game).length,
        0,
        `${game} has scores on an empty board, so somebody added a default and ` +
          `every tile is now lying about what a good score is`
      );
    }
    assert.equal(leaderboard.getTotalPlays(), 0, 'an empty board reports plays');
  });
});

/**
 * And the row a marshal types into still exists, with both fields and the
 * button. This one has to read the source: it is DOM built at runtime by a
 * console that needs a document.
 */
describe('the SCORES tab still has somewhere to type it', () => {
  test('an initials field, a score field and an ADD', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/shell/operator.ts', 'utf8');
    const at = src.indexOf("const addRow = el('div', 'op-entry-row')");
    assert.ok(at >= 0, 'the add-a-score row is gone from the SCORES tab');

    const block = src.slice(at, at + 2600);
    assert.match(block, /initialsInput/, 'the row lost its initials field');
    assert.match(block, /scoreInput/, 'the row lost its score field');
    assert.match(block, /button\('op-mini', 'ADD'/, 'the row lost its ADD button');
    assert.match(
      block,
      /leaderboard\.submit\(this\.scoresGame, value, who, null\)/,
      'the typed target no longer submits with a null faction, so it now counts ' +
        'toward a faction total — see the test above for why that matters'
    );
  });
});
