/**
 * TWO READOUTS, ONE RACE.
 *
 * Pose Match and Runner each draw an in-playfield "beat this" sticker because
 * PLAN.md §4 wants the thing to beat visible DURING play. The HUD already has
 * a chase line for the same purpose. With a ghost loaded those are genuinely
 * two different races — "3 AHEAD OF BEST" against your own run, "12 TO #4"
 * against the board — and both earn their space.
 *
 * With no ghost loaded, the chase line falls through to the board and renders
 * the IDENTICAL STRING the sticker is already showing. '12 TO #4', twice, a
 * few vh apart, on a screen whose whole job is to be readable from three
 * metres. That is most of the stall's day: a ghost only exists once somebody
 * has set a top run in that game, and it is retired mid-round the moment the
 * gap is out of reach.
 *
 * Runner's own source records moving the sticker down because it was
 * "covering the live thing to beat with a second copy of roughly the same
 * information" — which treated the collision and left the duplication.
 *
 * The precedence now lives in ONE place, `chaseMode`, because a precedence
 * copied into three files is a precedence that will drift. These tests pin the
 * question the subclasses ask it.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { RunnerGame } from '../src/games/runner.ts';
import { leaderboard, type GameId } from '../src/meta/leaderboard.ts';

const GAME: GameId = 'runner' as GameId;

/** Reaches the protected query and the private fields it reads. */
interface Probe {
  playerCount: number;
  ghost: unknown;
  ghostRaceLost: boolean;
  config: { partyMode: boolean; gameId: GameId };
  scoreFor(slot: number): number;
  chaseLineOwnsBoardRank(slot: number): boolean;
}

function game(score: number): Probe {
  const g = new RunnerGame() as unknown as Probe;
  g.playerCount = 1;
  g.ghost = null;
  g.ghostRaceLost = false;
  // `scoreFor` reads the game's own per-slot state; stubbing it keeps this
  // about the precedence rather than about how Runner counts metres.
  g.scoreFor = () => score;
  return g;
}

/** A ghost that is mid-race — the only thing `chaseMode` asks of one here. */
const liveGhost = { scoreAt: () => 0 } as unknown;

describe('the HUD and the playfield never show the same race', () => {
  beforeEach(() => {
    leaderboard.clearAll();
    // Two scores to chase, so the board has a `nextRank` to report.
    leaderboard.submit(GAME, 500, 'AAA', null);
    leaderboard.submit(GAME, 300, 'BBB', null);
  });

  test('with nothing else to say, the HUD owns the board chase', () => {
    const g = game(100);
    assert.equal(
      g.chaseLineOwnsBoardRank(0),
      true,
      'the chase line is showing "N TO #R" and the sticker would repeat it'
    );
  });

  /**
   * The case the sticker exists for. A ghost race and a board race are two
   * different numbers about two different opponents.
   */
  test('but a live ghost hands it back', () => {
    const g = game(100);
    g.ghost = liveGhost;
    assert.equal(g.chaseLineOwnsBoardRank(0), false);
  });

  /**
   * A race you have visibly lost is the opposite of a chase line, so the ghost
   * is retired mid-round — and the board takes the HUD slot back with it.
   */
  test('and takes it again once the ghost race is lost', () => {
    const g = game(100);
    g.ghost = liveGhost;
    g.ghostRaceLost = true;
    assert.equal(g.chaseLineOwnsBoardRank(0), true);
  });

  test('in versus the opponent is the target, so the sticker is free to draw', () => {
    const g = game(100);
    g.playerCount = 2;
    g.scoreFor = (slot: number) => (slot === 0 ? 100 : 80);
    assert.equal(g.chaseLineOwnsBoardRank(0), false);
  });

  test('party mode draws no chase line at all', () => {
    const g = game(100);
    g.config.partyMode = true;
    assert.equal(g.chaseLineOwnsBoardRank(0), false);
  });

  test('a record-pace run is not a board chase', () => {
    const g = game(9999);
    assert.equal(
      g.chaseLineOwnsBoardRank(0),
      false,
      'the HUD is showing <RECORD PACE>, which leaves the board chase unsaid'
    );
  });

  test('and neither is a virgin board', () => {
    leaderboard.clearAll();
    const g = game(100);
    assert.equal(
      g.chaseLineOwnsBoardRank(0),
      false,
      'the HUD is showing <SET THE FIRST SCORE>'
    );
  });
});

/**
 * The precedence must stay in one place. Both subclasses previously derived it
 * themselves — which is how the two readouts came to disagree about whether
 * they were showing the same thing.
 */
describe('neither game re-derives the precedence', () => {
  const read = async (f: string): Promise<string> => {
    const { readFile } = await import('node:fs/promises');
    return readFile(f, 'utf8');
  };

  for (const f of ['src/games/runner.ts', 'src/games/posematch.ts']) {
    test(`${f} asks base.ts instead`, async () => {
      const src = await read(f);

      // CODE, NOT COMMENTS. The first version of this matched the name
      // anywhere in the file and passed with the call DELETED, because the
      // comment above the call still mentioned it — a guard that matches
      // nothing, passing exactly like one that works. Caught by mutating the
      // call away and watching the test stay green.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split(/\r?\n/)
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join(' ');

      assert.match(
        code,
        /this\.chaseLineOwnsBoardRank\s*\(/,
        `${f} draws a "beat this" marker without checking whether the HUD is ` +
          `already showing that exact string`
      );
    });
  }
});
