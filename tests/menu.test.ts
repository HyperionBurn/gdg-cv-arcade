/**
 * The menu's shape, and the one setting that changes it.
 *
 * `shell.menuSize` — "fair mode" — came out of an outside playtest whose second
 * most valuable note was that seven dwell tiles slow down every turn in a
 * queue. Choosing is dwell time, and dwell time on a menu is time nobody is
 * playing.
 *
 * What is worth testing here is not that a number gets smaller. It is that the
 * SHAPE the menu falls back to stays sane at every count, because the layout
 * code divides by it: a shape with a zero row, a shape shorter than the tiles
 * it has to hold, or a shape that leaves a hole in the middle of the grid all
 * produce a broken menu at a stall rather than a failed test here.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { rowShape, MENU_TILES } from '../src/shell/menu.ts';
import { GAME_SEATS } from '../src/meta/games.ts';

describe('menu row shape', () => {
  const COUNTS = [1, 2, 3, 4, 5, 6, 7];

  test('every count is seated, and none is over-seated by a whole row', () => {
    for (const n of COUNTS) {
      const shape = rowShape(n);
      const seats = shape.reduce((a, b) => a + b, 0);
      assert.ok(seats >= n, `${n} tiles do not fit in ${JSON.stringify(shape)}`);
      // A shape with a whole empty row would draw a blank band across the
      // screen. One or two spare seats in the last row is the normal case.
      const last = shape[shape.length - 1] ?? 0;
      assert.ok(
        seats - n < last,
        `${n} tiles leave a whole empty row in ${JSON.stringify(shape)}`
      );
    }
  });

  test('no row is empty and no row is wider than the widest', () => {
    for (const n of COUNTS) {
      const shape = rowShape(n);
      assert.ok(shape.length > 0, `${n} produced no rows`);
      for (const row of shape) {
        assert.ok(row >= 1, `${n} produced an empty row: ${JSON.stringify(shape)}`);
        assert.ok(Number.isInteger(row), `${n} produced a fractional row`);
      }
    }
  });

  /**
   * The hand cursor is the reason this matters more than it looks.
   *
   * `layout()` gives every row the WIDEST row's cell width so short rows stay
   * centred rather than stretching. A shape whose rows differ by more than one
   * therefore wastes a lot of width on the short row — and width is target
   * size, which is the whole point of a short menu.
   */
  test('rows are balanced to within one tile', () => {
    for (const n of COUNTS) {
      const shape = rowShape(n);
      assert.ok(
        Math.max(...shape) - Math.min(...shape) <= 1,
        `${n} is unbalanced: ${JSON.stringify(shape)}`
      );
    }
  });

  /**
   * Fair mode must actually buy something. Fewer tiles across a row is what
   * makes each one wider, and a wider tile is a target a lagging filter
   * overshoots into rather than past — the same argument the gutter doubling
   * was made on.
   */
  test('fewer games really do mean bigger tiles', () => {
    // As a fraction of the grid: width is 1/widest row, height is 1/rows.
    // Both come straight out of `layout()`.
    const areaOf = (n: number): number => {
      const shape = rowShape(n);
      return (1 / Math.max(...shape)) * (1 / shape.length);
    };

    // NON-DECREASING, not strictly increasing, and the difference is a real
    // property of the grid rather than slack in the test. Five games cannot
    // beat three-per-row-in-two-rows, so five and six share a shape; four and
    // two share a row width. What must never happen is the opposite — adding a
    // game making the targets BIGGER — which is what this catches.
    for (let n = 7; n > 1; n--) {
      assert.ok(
        areaOf(n - 1) >= areaOf(n),
        `${n - 1} games give a SMALLER target than ${n}: ` +
          `${JSON.stringify(rowShape(n - 1))} vs ${JSON.stringify(rowShape(n))}`
      );
    }

    // The headline number, so a regression in the middle of the curve is
    // legible rather than just "monotonic broke".
    assert.ok(areaOf(4) >= areaOf(7) * 1.9, 'fair mode barely changes the target');
  });

  test('the full roster still gets the hand-tuned 4 + 3', () => {
    assert.deepEqual([...rowShape(MENU_TILES.length)], [4, 3]);
  });

  /**
   * The slider's ceiling has to be the roster's size. Below it, the last games
   * become unreachable with no way for a marshal to notice; above it, the
   * setting silently does nothing at its top end.
   */
  test('the tunable can offer every game and no more', async () => {
    const { tunables } = await import('../src/meta/tunables.ts');
    const entry = tunables.list().find((t) => t.key === 'shell.menuSize');
    assert.ok(entry, 'shell.menuSize is gone');
    assert.equal(entry.max, MENU_TILES.length);
    assert.equal(entry.default, 0, 'fair mode must be OFF unless a marshal asks');
    assert.equal(
      MENU_TILES.length,
      Object.keys(GAME_SEATS).length,
      'a game exists that the menu cannot show'
    );
  });
});
