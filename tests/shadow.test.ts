/**
 * "TEXT MIGHT BE DOUBLED" — row 5 of FEEDBACK.md.
 *
 * A shadow the same colour as its glyph IS the word printed twice. Reported
 * from a playtest, and fixed centrally in `drawText` rather than at the call
 * sites, because the call sites are where it kept coming back.
 *
 * The guard had no test. Found by a semantic mutation of the ledger's
 * identifier anchors: turning `if (shadowColor !== color)` into `if (true)` —
 * which restores the exact bug — failed nothing in the whole suite except the
 * check that FEEDBACK.md still quotes the line.
 *
 * `brand.test.ts` scans CALL SITES for colours and blur. Nothing looked at what
 * `drawText` actually puts on the canvas, which is where this decision lives.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { drawText } from '../src/engine/draw.ts';
import { COLORS } from '../src/shell/theme.ts';

interface Painted {
  text: string;
  x: number;
  y: number;
  fill: string;
}

/** Records every fillText with the colour that was set for it. */
function paintsOf(opts: Parameters<typeof drawText>[4]): Painted[] {
  const out: Painted[] = [];
  let fill = '';
  const ctx = {
    save() {},
    restore() {},
    translate() {},
    scale() {},
    strokeText() {},
    fillText(text: string, x: number, y: number) {
      out.push({ text, x, y, fill });
    },
    measureText: (t: string) => ({ width: t.length * 10 }),
    set font(_v: string) {},
    set textAlign(_v: string) {},
    set textBaseline(_v: string) {},
    set letterSpacing(_v: string) {},
    set fillStyle(v: string) {
      fill = v;
    },
    get fillStyle() {
      return fill;
    },
    set strokeStyle(_v: string) {},
    set lineWidth(_v: number) {},
    set lineJoin(_v: string) {},
    set shadowBlur(_v: number) {},
    set globalAlpha(_v: number) {},
  } as unknown as CanvasRenderingContext2D;

  drawText(ctx, 'SCORE', 100, 100, opts);
  return out;
}

describe('a shadow is never the word printed twice', () => {
  test('an ink glyph with the default ink shadow is painted ONCE', () => {
    const paints = paintsOf({ size: 40, color: COLORS.ink, shadow: 4 });
    assert.equal(
      paints.length,
      1,
      `ink text drew ${paints.length} copies of itself. The default shadow colour ` +
        `is ink, and an ink shadow under an ink glyph is the doubling the report ` +
        `was about`
    );
  });

  test('and an explicit same-colour shadow is refused too', () => {
    const paints = paintsOf({
      size: 40,
      color: COLORS.red,
      shadow: 4,
      shadowColor: COLORS.red,
    });
    assert.equal(paints.length, 1, 'a red shadow under a red glyph was drawn');
  });

  /**
   * The shadow is not simply gone. A contrasting one is the house style and
   * the thing that makes a headline read from the back of a hall — a guard
   * that only checked the doubling case would be satisfied by deleting the
   * feature.
   */
  test('but a contrasting shadow is still drawn, once, underneath', () => {
    const paints = paintsOf({ size: 40, color: COLORS.yellow, shadow: 4, shadowColor: COLORS.ink });
    assert.equal(paints.length, 2, 'a contrasting shadow is no longer drawn at all');

    const [shadow, glyph] = paints as [Painted, Painted];
    assert.equal(shadow.fill, COLORS.ink, 'the first paint is not the shadow');
    assert.equal(glyph.fill, COLORS.yellow, 'the glyph is not painted last, so it is underneath');
    assert.ok(shadow.y > glyph.y, 'the shadow is not below the glyph');
  });

  /**
   * And the offset is capped at 8% of the type size. At 15% an offset copy
   * reads as a second word rather than a lift, which is the same complaint
   * arriving through a different door — it was fixed for same-colour shadows
   * and left open for contrasting ones, where the attract screen's game title
   * sat in red over its own ink copy.
   */
  test('and a contrasting shadow cannot drift far enough to read as a second word', () => {
    const size = 34;
    const paints = paintsOf({ size, color: COLORS.red, shadow: 99, shadowColor: COLORS.ink });
    assert.equal(paints.length, 2);
    const drop = paints[0]!.y - paints[1]!.y;
    assert.ok(
      drop <= size * 0.08 + 1e-9,
      `a ${size}px glyph was given a ${drop.toFixed(1)}px shadow offset, ` +
        `${((drop / size) * 100).toFixed(0)}% of its size. Past about 8% it stops ` +
        `being a lift and starts being the word printed twice`
    );
  });
});
