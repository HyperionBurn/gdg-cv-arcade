/**
 * EVERY ABANDONED ENTRY USED TO BE A PERSON CALLED AAA.
 *
 * SKIP makes leaving without a name one dwell instead of a sixteen-second
 * wait. That is the right call for a queue and it was asked for directly in
 * the playtest — but the cheaper an exit is, the more people take it, and
 * every one of those wrote 'AAA' onto a board that persists across BOTH DAYS.
 *
 * The damage is worst exactly when it is least visible: on the morning of day
 * one every board is empty, so nearly every score places, so nearly every
 * skipper lands on the board. By the afternoon the leaderboard is a column of
 * identical rows that read like one prolific player, which undercuts the
 * single thing it exists to create.
 *
 * None of this was tested. The whole suite passed with the default changed.
 *
 * Two of these tests are about the SECOND bug, which the rename surfaced
 * rather than caused: `personalBest` and `factionFor` both identify a player
 * by their initials string, so a shared marker makes every anonymous player
 * the same person. That was already true of 'AAA' — a skipper was being told
 * their personal best was the best score any skipper had ever set.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { leaderboard, ANONYMOUS, type GameId } from '../src/meta/leaderboard.ts';

const GAME: GameId = 'sixtyseven' as GameId;

describe('a skipped entry is not a person', () => {
  beforeEach(() => {
    leaderboard.clearAll();
  });

  test('an empty entry is stored as the anonymous marker', () => {
    const r = leaderboard.submit(GAME, 100, '', null);
    assert.equal(r.storedInitials, ANONYMOUS);
    assert.equal(ANONYMOUS, '---');
  });

  /**
   * The marker is not a new vocabulary. `padEnd(3, '-')` already writes it:
   * the 16s deadline firing on a half-typed 'W' stores 'W--'. So '-' already
   * means "nothing was given here" everywhere else on the board.
   */
  test('a partial entry is still padded, and is still a name', () => {
    const r = leaderboard.submit(GAME, 100, 'W', null);
    assert.equal(r.storedInitials, 'W--');
    assert.notEqual(r.storedInitials, ANONYMOUS);
  });

  test('the score still counts — it is a target even without a name', () => {
    leaderboard.submit(GAME, 500, '', null);
    const top = leaderboard.getTop(GAME);
    assert.equal(top.length, 1);
    assert.equal(top[0]!.score, 500);
    assert.equal(top[0]!.initials, ANONYMOUS);
    assert.equal(leaderboard.previewRank(GAME, 400).rank, 2, 'the anonymous score stopped being a target');
  });

  /**
   * A corrupt or empty stored value must not come back as a plausible name
   * either. `cleanInitials` runs on the way IN from storage as well as on
   * submit, and 'AAA' there was a stored record claiming somebody played.
   */
  test('garbage from storage becomes the marker, not a name', () => {
    const r = leaderboard.submit(GAME, 100, '!!!@@@', null);
    assert.equal(r.storedInitials, ANONYMOUS);
  });

  test('an emoji name cannot reach the board screen', () => {
    const r = leaderboard.submit(GAME, 100, '\u{1F600}\u{1F600}', null);
    assert.equal(r.storedInitials, ANONYMOUS);
  });
});

describe('two people who both declined are not the same person', () => {
  beforeEach(() => {
    leaderboard.clearAll();
  });

  /**
   * The lie this prevents: the second skipper of the afternoon is told they
   * have a personal best of 900, which is a stranger's score, on a screen
   * that has no way to walk it back.
   */
  test('a skipper is never told they beat themselves', () => {
    leaderboard.submit(GAME, 900, '', null);
    const second = leaderboard.submit(GAME, 100, '', null);
    assert.equal(
      second.personalBest,
      null,
      `the second anonymous player was told their personal best is ` +
        `${second.personalBest}, which is the first one's score`
    );
  });

  test('but a named player still gets one', () => {
    leaderboard.submit(GAME, 900, 'WAS', null);
    const again = leaderboard.submit(GAME, 100, 'WAS', null);
    assert.equal(again.personalBest, 900);
  });

  /**
   * `factionFor` identifies a returning player the same way, so it needs the
   * same rule. Nothing reaches it today — the letter grid cannot type '-' —
   * but an invariant with one enforcement point is a coincidence.
   */
  test('and a skipper does not inherit a stranger faction', () => {
    leaderboard.submit(GAME, 900, '', 'ENGINEERING');
    assert.equal(leaderboard.factionFor(ANONYMOUS), null);
  });

  test('while a returning named player still keeps theirs', () => {
    leaderboard.submit(GAME, 900, 'WAS', 'ENGINEERING');
    assert.equal(leaderboard.factionFor('WAS'), 'ENGINEERING');
  });
});

/**
 * The screen and the board must agree about what a skip means. They did not:
 * initials.ts substituted its own 'AAA' before calling submit, so the payoff
 * sticker and the leaderboard a few seconds later were two different answers
 * to the same question, produced by two different files.
 */
describe('the screen does not keep its own idea of a default name', () => {
  test('initials.ts defers to the board sanitiser', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/shell/initials.ts', 'utf8');

    // CODE, NOT PROSE. The first version of this matched the string anywhere
    // in the file, failed on the comment explaining the fix, and then printed
    // all 37 KB of the file as the diff — which is its own small lesson about
    // asserting on whole documents.
    //
    // Block comments are blanked rather than deleted so the line numbers in
    // the failure message still point at the real line.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\r\n]/g, ' '));

    const offenders = code
      .split(/\r?\n/)
      .map((l, i) => [i + 1, l.replace(/\/\/.*$/, '')] as const)
      .filter(([, l]) => /['"]AAA['"]/.test(l))
      .map(([n, l]) => `${n}: ${l.trim()}`);

    assert.deepEqual(
      offenders,
      [],
      'initials.ts has a local default name again. cleanInitials in ' +
        'meta/leaderboard.ts is the single definition of what an initials ' +
        'string may be, and an empty entry is one of the cases it defines. ' +
        offenders.join(' | ')
    );
  });
});
