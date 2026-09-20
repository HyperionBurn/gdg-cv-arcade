/**
 * THE ARITHMETIC THAT WAS WRONG THREE TIMES.
 *
 * Re-running the 4:3 overflow sweep on the 20th gave three different answers
 * for the same string — 272px off the stage, then 17px, then 525px — and none
 * were true. Every error was in the measuring, not the app, and every one of
 * them is a case below:
 *
 *   - the transform ignored entirely (popups draw inside `pushTransform`)
 *   - the transform applied to one point, which still assumes the text is
 *     axis-aligned when `withTilt` rotates cards and stickers
 *   - the nominal font size read instead of the drawn one, so a score that
 *     draws at 14vh inside a pop-scale recorded as 1.41vh on its first frame
 *
 * A probe that reports a number nobody can reproduce is worse than no probe,
 * so the arithmetic lives on its own and is tested without a canvas.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { textBounds, overflowOf, drawnVh, type Matrix2D } from '../src/dev/layout.ts';

const IDENTITY: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
/** 100 wide, 10 above the baseline, 4 below — a plausible line of display text. */
const M = { width: 100, ascent: 10, descent: 4 };

const near = (got: number, want: number, msg: string): void => {
  assert.ok(Math.abs(got - want) < 1e-6, `${msg}: got ${got}, wanted ${want}`);
};

describe('textBounds', () => {
  test('left-aligned text starts where it is drawn', () => {
    const b = textBounds(IDENTITY, 50, 200, M, 'left');
    near(b.left, 50, 'left');
    near(b.right, 150, 'right');
    near(b.top, 190, 'top');
    near(b.bottom, 204, 'bottom');
  });

  test('centre and right alignment shift the box, not the width', () => {
    const c = textBounds(IDENTITY, 50, 200, M, 'center');
    near(c.left, 0, 'centre left');
    near(c.right, 100, 'centre right');

    const r = textBounds(IDENTITY, 150, 200, M, 'right');
    near(r.left, 50, 'right-aligned left');
    near(r.right, 150, 'right-aligned right');
  });

  /**
   * THE 272. A popup drawn at x=500 inside a transform that has already
   * translated the world is not at 500.
   */
  test('a translate moves the box', () => {
    const m: Matrix2D = { ...IDENTITY, e: 300, f: -20 };
    const b = textBounds(m, 50, 200, M, 'left');
    near(b.left, 350, 'left');
    near(b.right, 450, 'right');
    near(b.top, 170, 'top');
  });

  test('a scale grows the box about the origin', () => {
    const m: Matrix2D = { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 };
    const b = textBounds(m, 50, 200, M, 'left');
    near(b.left, 100, 'left');
    near(b.right, 300, 'right');
    near(b.bottom, 408, 'bottom');
  });

  /**
   * THE 525, AND THE WHOLE REASON THIS FUNCTION PROJECTS FOUR CORNERS.
   *
   * Rotate a quarter turn and the string's WIDTH becomes vertical extent.
   * `left + width * scaleX` would still report a 100-wide box lying flat,
   * which is why the tilted cards measured as leaving the stage.
   */
  test('a quarter turn puts the width on the other axis', () => {
    // cos90 = 0, sin90 = 1.
    const m: Matrix2D = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 };
    const b = textBounds(m, 0, 0, { width: 100, ascent: 0, descent: 0 }, 'left');
    near(b.left, 0, 'left');
    near(b.right, 0, 'right');
    near(b.top, 0, 'top');
    near(b.bottom, 100, 'bottom');
  });

  /**
   * A 45 degree tilt TRADES width for height, it does not simply add. A 100 by
   * 20 box comes back 84.9 square: narrower than the string is long, and four
   * times taller than it is tall.
   *
   * I asserted "wider than the string" first and it failed, correctly — the
   * intuition that rotation makes things bigger is wrong for a wide, short
   * box. What matters is that neither axis can be derived from the other, and
   * `left + width * scaleX` (scaleX is 1 here) would report a flat 100-wide
   * box and miss the vertical extent completely.
   */
  test('and a 45 degree tilt trades width for height', () => {
    const k = Math.SQRT1_2;
    const m: Matrix2D = { a: k, b: k, c: -k, d: k, e: 0, f: 0 };
    const b = textBounds(m, 0, 0, { width: 100, ascent: 20, descent: 0 }, 'left');
    const width = b.right - b.left;
    const height = b.bottom - b.top;

    assert.ok(width < 100, `a tilted wide box is narrower, not wider; got ${width.toFixed(1)}`);
    assert.ok(
      height > 80,
      `and far taller than its own 20; got ${height.toFixed(1)}. A naive ` +
        'axis-aligned box would have missed this entirely',
    );

    // EXACT, because "narrower and taller" is satisfied by a box that is also
    // wrong. Projecting only the two OPPOSITE corners passes both assertions
    // above while reporting left 14.1 / right 70.7 — a 56.6-wide box instead
    // of an 84.9-wide one. Found by mutating this function, which is the
    // whole argument for doing it.
    const k2 = Math.SQRT1_2;
    near(b.left, 0, 'the bottom-left corner is the leftmost point');
    near(b.right, 120 * k2, 'and the top-right corner is the rightmost');
    near(b.top, -20 * k2, 'top');
    near(b.bottom, 100 * k2, 'bottom');
  });
});

describe('overflowOf', () => {
  const stage = { w: 1024, h: 768 };

  test('a box inside the stage does not overflow', () => {
    const b = { left: 10, right: 200, top: 10, bottom: 50 };
    assert.equal(overflowOf(b, stage.w, stage.h), 0);
  });

  test('it reports the worst edge, whichever it is', () => {
    assert.equal(overflowOf({ left: -30, right: 200, top: 10, bottom: 50 }, stage.w, stage.h), 30);
    assert.equal(overflowOf({ left: 10, right: 1100, top: 10, bottom: 50 }, stage.w, stage.h), 76);
    assert.equal(overflowOf({ left: 10, right: 200, top: -5, bottom: 50 }, stage.w, stage.h), 5);
    assert.equal(overflowOf({ left: 10, right: 200, top: 10, bottom: 800 }, stage.w, stage.h), 32);
  });

  /**
   * A TV crops its edges, so "on the stage" and "safe to read" are different
   * questions. The inset is the overscan budget.
   */
  test('the overscan inset makes the safe area smaller than the stage', () => {
    const b = { left: 5, right: 200, top: 50, bottom: 90 };
    assert.equal(overflowOf(b, stage.w, stage.h), 0, 'it is on the stage');
    assert.equal(overflowOf(b, stage.w, stage.h, 27), 22, 'and not inside the safe area');
  });
});

describe('drawnVh', () => {
  test('an untransformed string is its nominal size', () => {
    near(drawnVh(IDENTITY, 76.8, 768), 10, '76.8px of 768 is 10vh');
  });

  /**
   * THE 1.41. A score drawn at 14vh inside a pop-scale really is small on the
   * first frame — the number is right and reading it as the settled size is
   * what was wrong. Callers take the MAXIMUM over a string's life.
   */
  test('a mid-pop string is genuinely smaller than its nominal size', () => {
    const tenth: Matrix2D = { a: 0.1, b: 0, c: 0, d: 0.1, e: 0, f: 0 };
    near(drawnVh(tenth, 76.8, 768), 1, 'a tenth of the way through the pop');
  });

  test('and rotation does not change how tall it is', () => {
    const k = Math.SQRT1_2;
    const rot: Matrix2D = { a: k, b: k, c: -k, d: k, e: 0, f: 0 };
    near(drawnVh(rot, 76.8, 768), 10, 'a tilted string is still 10vh tall');
  });
});
