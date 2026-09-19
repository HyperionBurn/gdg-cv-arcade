/**
 * WHOSE POINTS ARE THESE?
 *
 * The faction competition is one of the headline features of the stall, and on
 * the morning of the event it was structurally incapable of producing a real
 * result. The initials screen resolved the faction at MOUNT, from
 * `getLastFaction()` — one value for the whole kiosk — so the first person to
 * play set the default for everybody after them. The attract screen showed
 * exactly what that produces:
 *
 *   BUSINESS 9,357  ·  ENGINEERING 0  ·  CS 0  ·  MEDIA 0
 *
 * Nobody chose that. It is one person's pick, applied to a hundred turns,
 * correctable only by a player noticing a small "hover to change" line under
 * the keyboard and deciding to act on it mid-entry.
 *
 * `getLastFaction`'s own comment says the point is that "repeat players skip
 * the picker". `factionFor` is that, meant literally: a repeat player is
 * somebody whose initials are already on a board, and what they skip is being
 * asked a question they have already answered.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { leaderboard, FACTIONS, type GameId } from '../src/meta/leaderboard.ts';

const GAME: GameId = 'sixtyseven' as GameId;

describe('a faction follows the player, not the kiosk', () => {
  beforeEach(() => {
    leaderboard.clearAll();
  });

  test('somebody who has never played is asked', () => {
    assert.equal(leaderboard.factionFor('ZZZ'), null);
  });

  test('somebody who has played is not asked again', () => {
    leaderboard.submit(GAME, 100, 'WAS', 'ENGINEERING');
    assert.equal(leaderboard.factionFor('WAS'), 'ENGINEERING');
  });

  test('and their neighbour is still asked', () => {
    // The whole bug, in one assertion: one person playing must not answer for
    // the next person in the queue.
    leaderboard.submit(GAME, 100, 'WAS', 'BUSINESS');
    assert.equal(leaderboard.factionFor('AMY'), null);
  });

  test('initials are matched the way the board stores them', () => {
    leaderboard.submit(GAME, 100, 'was', 'MEDIA');
    assert.equal(leaderboard.factionFor('WAS'), 'MEDIA');
    assert.equal(leaderboard.factionFor('was'), 'MEDIA');
    assert.equal(leaderboard.factionFor('  was '), 'MEDIA');
  });

  test('an empty name is nobody', () => {
    leaderboard.submit(GAME, 100, 'AAA', 'SCIENCE');
    assert.equal(leaderboard.factionFor(''), null);
    assert.equal(leaderboard.factionFor('   '), null);
  });

  test('switching allegiance sticks', () => {
    leaderboard.submit(GAME, 100, 'WAS', 'ENGINEERING');
    leaderboard.submit(GAME, 200, 'WAS', 'MEDIA');
    assert.equal(leaderboard.factionFor('WAS'), 'MEDIA', 'the newest entry has to win');
  });

  test('it looks across every game, not just the one being played', () => {
    // Somebody who set their faction on Red Light on day one and comes back to
    // Fruit Ninja on day two has already answered.
    leaderboard.submit('redlight' as GameId, 40, 'BOB', 'COMPUTER SCI');
    assert.equal(leaderboard.factionFor('BOB'), 'COMPUTER SCI');
  });

  test('a faction the club has since deleted means ASK AGAIN', () => {
    // FACTIONS is flagged in leaderboard.ts as a placeholder the club edits
    // between Day 1 and Day 2. A stale value must not be silently reused: the
    // points would go to a bucket the standings screen can never look up, and
    // vanish with no error anywhere. Same rule `getLastFaction` already has.
    leaderboard.submit(GAME, 100, 'OLD', 'QUIDDITCH');
    assert.equal(leaderboard.factionFor('OLD'), null);
  });

  test('every remembered faction is one the picker can actually show', () => {
    for (const f of FACTIONS) {
      leaderboard.submit(GAME, 100, 'FAC', f);
      const got = leaderboard.factionFor('FAC');
      assert.ok(
        got !== null && (FACTIONS as readonly string[]).includes(got),
        `${f} did not survive a round trip`
      );
    }
  });

  test('a player with no faction at all is still asked', () => {
    // `submit` accepts null — the deadline path submits whatever is on screen.
    leaderboard.submit(GAME, 100, 'NUL', null);
    assert.equal(leaderboard.factionFor('NUL'), null);
  });

  test('the totals reflect the people who actually played', () => {
    // The end-to-end shape of the fix: four people, four factions, four
    // buckets — rather than one bucket with everything in it.
    leaderboard.submit(GAME, 10, 'AAA', 'ENGINEERING');
    leaderboard.submit(GAME, 20, 'BBB', 'MEDIA');
    leaderboard.submit(GAME, 30, 'CCC', 'BUSINESS');
    leaderboard.submit(GAME, 40, 'DDD', 'SCIENCE');

    const totals = new Map(leaderboard.getFactionTotals().map((t) => [t.name, t.total]));
    assert.equal(totals.size, 4, `one bucket per faction, got ${JSON.stringify([...totals])}`);
    assert.equal(totals.get('ENGINEERING'), 10);
    assert.equal(totals.get('MEDIA'), 20);
    assert.equal(totals.get('BUSINESS'), 30);
    assert.equal(totals.get('SCIENCE'), 40);
  });
});
