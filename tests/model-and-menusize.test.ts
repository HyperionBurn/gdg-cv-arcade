/**
 * TWO LEDGER ROWS WHOSE FIX IS A DEFAULT NOBODY CHECKED.
 *
 * Both found by semantically mutating the ledger's identifier anchors: change
 * what the code does, keep it compiling, and see whether anything fails except
 * the check that FEEDBACK.md still quotes the line. For both of these, nothing
 * did.
 *
 *   4   "tracking is a bit wonky"  -> the pose model defaults to `full`, not
 *       `lite`, and is live-switchable.
 *   24  "seven dwell tiles slow down every turn in a queue" -> `shell.menuSize`
 *       trims the menu to the first N AVAILABLE games.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { poseModelChoice } from '../src/games/base.ts';
import { tilesInDisplayOrder, isTileAvailable } from '../src/shell/menu.ts';
import { MENU_TILES } from '../src/shell/menu.ts';
import { tunables } from '../src/meta/tunables.ts';
import { router } from '../src/shell/router.ts';

describe('the pose model defaults to the accurate one', () => {
  beforeEach(() => {
    tunables.reset('vision.poseModel');
  });

  /**
   * `lite` is the cheap model and the tempting default. Every gesture
   * threshold in every game is divided by `scale.unit`, which is computed from
   * these landmarks, so model jitter moves every threshold in the whole arcade
   * simultaneously — which is exactly what the playtest reported.
   */
  test('with nothing overridden it asks for full', () => {
    assert.equal(
      poseModelChoice(),
      'full',
      'the arcade boots on the lite pose model. Every threshold in every game ' +
        'divides by a scale computed from these landmarks, so this is the one ' +
        'setting that makes all seven games wonky at once'
    );
  });

  /**
   * And it stays SWITCHABLE, which is the other half of the row: on a weak
   * booth laptop a marshal has to be able to trade accuracy for frame rate
   * without a rebuild.
   */
  test('and a marshal can still move it in both directions', () => {
    tunables.set('vision.poseModel', 0);
    assert.equal(poseModelChoice(), 'lite');
    tunables.set('vision.poseModel', 2);
    assert.equal(poseModelChoice(), 'heavy');
  });

  test('and out-of-range values clamp rather than returning nonsense', () => {
    tunables.set('vision.poseModel', -5);
    assert.equal(poseModelChoice(), 'lite');
    tunables.set('vision.poseModel', 99);
    assert.equal(poseModelChoice(), 'heavy');
  });
});

/**
 * "Fair mode". Choosing is time nobody is playing, and it is paid by everybody
 * waiting rather than by the person choosing — so a marshal with a long queue
 * can cut the menu to three or four games.
 */
describe('the menu can be trimmed when the queue is long', () => {
  /**
   * A tile is only "available" once the ROUTER has its screen — the menu can
   * never offer a tile that would route nowhere. `main.ts` is what registers
   * them and no test can import it, so they are registered here.
   *
   * Worth knowing rather than working around: without this every tile counts
   * as COMING SOON, `tilesInDisplayOrder` returns an empty list under any
   * limit, and a test written carelessly would read that as "the limit works".
   */
  /** Every enabled tile except the last, so there is genuinely something unavailable. */
  const HELD_BACK = [...MENU_TILES].reverse().find((t) => t.enabled)!;

  beforeEach(() => {
    tunables.reset('shell.menuSize');
    for (const tile of MENU_TILES) {
      if (tile.enabled && tile.id !== HELD_BACK.id) {
        router.register(tile.id, (() => ({})) as never);
      }
    }
  });

  const liveCount = (): number => MENU_TILES.filter(isTileAvailable).length;

  test('zero means all of them', () => {
    assert.equal(tilesInDisplayOrder().length, MENU_TILES.length);
  });

  test('and a limit really trims it', () => {
    for (const n of [3, 4, 5]) {
      tunables.set('shell.menuSize', n);
      assert.equal(
        tilesInDisplayOrder().length,
        n,
        `menuSize ${n} still shows ${tilesInDisplayOrder().length} tiles, so the ` +
          `one lever against a slow queue does nothing`
      );
    }
  });

  /**
   * A SHORT MENU IS PLAYABLE GAMES ONLY. Spending one of three slots on a
   * COMING SOON tile is worse than not trimming at all: the queue pays the
   * dwell and gets a third fewer games.
   */
  test('and never spends a slot on something unplayable', () => {
    // `isTileAvailable`, not a `soon` field — MenuTile has no such property, so
    // asserting `tile.soon !== true` is true of every object ever made. The
    // first version of this test did exactly that and passed on nothing.
    assert.equal(
      isTileAvailable(HELD_BACK),
      false,
      'the held-back tile registered anyway, so there is nothing unavailable to ' +
        'wrongly include and this test cannot fail'
    );

    // A limit LARGER than the number of playable games: the only shape where
    // padding the list with COMING SOON tiles is even possible.
    tunables.set('shell.menuSize', liveCount() + 1);
    const shown = tilesInDisplayOrder();
    assert.equal(
      shown.length,
      liveCount(),
      `a menu limited to ${liveCount() + 1} showed ${shown.length} tiles when only ` +
        `${liveCount()} are playable — it padded the list`
    );
    for (const tile of shown) {
      assert.ok(
        isTileAvailable(tile),
        `a trimmed menu is showing "${tile.id}", which routes nowhere. A COMING ` +
          `SOON tile in one of three slots costs the queue a third of the games ` +
          `and the dwell anyway`
      );
    }
  });

  test('and asking for more than exist is not an error', () => {
    tunables.set('shell.menuSize', 99);
    assert.ok(tilesInDisplayOrder().length > 0, 'an oversized limit emptied the menu');
    assert.ok(tilesInDisplayOrder().length <= MENU_TILES.length);
  });
});
