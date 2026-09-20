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


/**
 * THE INSTRUCTION WAS SMALLER THAN THE SIZE THE CODE CALLS UNREADABLE.
 *
 * `menu.ts` holds the blurb at 2.4vh and wraps it rather than shrinking it,
 * under a comment saying it "was being drawn at 1.6vh — 17px on a 1080p TV,
 * unreadable from 3m and therefore not doing its job at all", and anticipating
 * that "on a 4:3 panel — where the tiles are 30% narrower — shrink-to-fit
 * would put it there again".
 *
 * It did. MEASURED on the menu, one line per tile, by instrumenting the real
 * render path:
 *
 *   16:9   2.40vh   as designed, two lines
 *   4:3    1.42vh   BELOW the figure the comment calls unreadable
 *
 * The wrap was capped at two lines, so a long blurb in a narrow tile still
 * overflowed and the shrink-to-fit fallback fired anyway. A third line lets
 * each line be shorter, so the width-driven fit does not have to shrink:
 * 4:3 goes to 2.24vh and 16:9 is untouched, because at 16:9 nothing needs the
 * third line.
 *
 * The cap is the other half. Allowing three lines overshot — the title is
 * fitted to the same narrow tile and lands at 2.24vh, so the blurb came out
 * BIGGER than the name of the game, and a stranger scanning seven tiles picks
 * by name.
 */
describe('the menu blurb stays readable and stays subordinate', () => {
  const menuSrc = async (): Promise<string> => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/shell/menu.ts', 'utf8');
    return src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
  };

  test('it may wrap to three lines, not two', async () => {
    const code = await menuSrc();
    const m = /wrapText\(ctx, t\.blurb,[^)]*?,\s*(\d+)\s*,\s*TRACK\.body\)/.exec(code);
    assert.ok(m, 'the blurb no longer wraps through wrapText');
    assert.equal(
      m[1],
      '3',
      `the blurb wraps to ${m[1]} lines. At two, a long blurb in a 4:3 tile ` +
        `overflows and the shrink-to-fit fallback takes it to 1.42vh — below ` +
        `the 1.6vh this file calls unreadable from 3m.`
    );
  });

  test('and never renders larger than the game it describes', async () => {
    const code = await menuSrc();
    assert.match(
      code,
      /if \(blurbSize > titleSize\)[\s\S]{0,120}?blurbSize = titleSize/,
      'the blurb can be bigger than the tile title again, which inverts the ' +
        'one hierarchy a stranger scanning seven tiles depends on'
    );
  });

  /**
   * Every blurb shares one fitted size, so the LONGEST one sets it for all
   * seven. A blurb that grows past the current longest shrinks every other
   * game's instruction to pay for itself.
   */
  test('no blurb is longer than the longest one measured against', async () => {
    const longest = MENU_TILES.reduce((m, t) => Math.max(m, t.blurb.length), 0);
    assert.ok(
      longest <= 34,
      `the longest blurb is now ${longest} characters. The tiles share one ` +
        `fitted size, so this shrinks every other game's instruction too — ` +
        `the sizes above were measured against 34.`
    );
  });
});
