/**
 * POPUPS SPAWN AT THE POINT OF IMPACT, AND IMPACTS HAPPEN AT EDGES.
 *
 * `PopupLayer.floorY` has stopped popups rising into the HUD for a long time,
 * with a comment explaining that no call site should have to do that
 * arithmetic. Nobody ever made the same argument sideways.
 *
 * Found in Red Light with five players. Every racer starts at the left edge, so
 * an elimination in the first seconds draws its taunt centred on a marker about
 * 35px in — and GOTCHA!, BUSTED! and TOO SLOW! all lost their left half. That
 * is the one moment the game speaks directly to the person who just went out.
 * The VERTICAL placement of those same taunts had been fixed twice, in detail.
 *
 * Tested here rather than in Red Light because the exposure is shared: Balloon
 * Pop pops balloons at the edges and Fruit Ninja slices there too.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PopupLayer } from '../src/engine/juice.ts';

const SIZE = 30;
const WIDE = 1920;

/** Mirrors `estimateHalfWidth` in juice.ts — the same guess the clamp uses. */
const halfOf = (text: string, size = SIZE): number => (text.length * size * 0.56) / 2;

/** The layer keeps its pool private; the draw is the only public read. */
const spawnedAt = (layer: PopupLayer): Array<{ x: number; text: string }> => {
  const out: Array<{ x: number; text: string }> = [];
  const ctx = {
    save() {},
    restore() {},
    translate(x: number) {
      out.push({ x, text: '' });
    },
    scale() {},
    strokeText(t: string) {
      const last = out[out.length - 1];
      if (last && !last.text) last.text = t;
    },
    fillText() {},
    measureText: () => ({ width: 0 }),
    set font(_v: string) {},
    set textAlign(_v: string) {},
    set textBaseline(_v: string) {},
    set globalAlpha(_v: number) {},
    set lineJoin(_v: string) {},
    set miterLimit(_v: number) {},
    set lineWidth(_v: number) {},
    set strokeStyle(_v: string) {},
    set fillStyle(_v: string) {},
  } as unknown as CanvasRenderingContext2D;
  layer.draw(ctx, 'Archivo');
  return out;
};

describe('popups stay on screen sideways', () => {
  test('a popup at the left edge is pushed fully into view', () => {
    const layer = new PopupLayer();
    layer.width = WIDE;
    layer.spawn('TOO SLOW!', 35, 400, '#ea4335', SIZE);

    const [p] = spawnedAt(layer);
    assert.ok(p, 'nothing was drawn');
    assert.ok(
      p.x - halfOf('TOO SLOW!') >= 0,
      `left edge at ${p.x - halfOf('TOO SLOW!')}, which is off screen`
    );
  });

  test('and at the right edge', () => {
    const layer = new PopupLayer();
    layer.width = WIDE;
    layer.spawn('GOTCHA!', WIDE - 20, 400, '#ea4335', SIZE);

    const [p] = spawnedAt(layer);
    assert.ok(
      p!.x + halfOf('GOTCHA!') <= WIDE,
      `right edge at ${p!.x + halfOf('GOTCHA!')}, past ${WIDE}`
    );
  });

  /**
   * The clamp must not drag a popup that was already fine. A taunt belongs at
   * the thing it is describing, and moving it is a cost paid only to keep it
   * readable.
   */
  test('a popup with room to spare is not moved at all', () => {
    const layer = new PopupLayer();
    layer.width = WIDE;
    layer.spawn('CAUGHT!', 900, 400, '#ea4335', SIZE);
    assert.equal(spawnedAt(layer)[0]!.x, 900);
  });

  /** 0 means "nobody told me the viewport", and must behave as before. */
  test('an unbounded layer does not clamp', () => {
    const layer = new PopupLayer();
    layer.spawn('TOO SLOW!', 5, 400, '#ea4335', SIZE);
    assert.equal(spawnedAt(layer)[0]!.x, 5);
  });

  /**
   * A word wider than the screen cannot satisfy both edges. Centre it, rather
   * than letting the two clamps fight and land on whichever was applied last.
   */
  test('a word wider than the viewport is centred', () => {
    const layer = new PopupLayer();
    layer.width = 100;
    layer.spawn('EVERYBODY OUT!', 5, 400, '#ea4335', SIZE);
    assert.equal(spawnedAt(layer)[0]!.x, 50);
  });

  /**
   * The five-player Red Light case that started this: everyone is eliminated
   * at the start line, so every taunt spawns at the same left-edge x.
   */
  test('five taunts at the start line are all readable', () => {
    const layer = new PopupLayer();
    layer.width = WIDE;
    layer.floorY = 120;
    for (const [i, word] of ['GOTCHA!', 'BUSTED!', 'TOO SLOW!', 'WOBBLED!', 'TWITCHED!'].entries()) {
      layer.spawn(word, 35, 200 + i * 60, '#ea4335', SIZE);
    }

    const drawn = spawnedAt(layer);
    assert.equal(drawn.length, 5);
    for (const p of drawn) {
      assert.ok(p.x - halfOf(p.text) >= 0, `${p.text} still hangs off the left edge`);
      assert.ok(p.x + halfOf(p.text) <= WIDE, `${p.text} hangs off the right edge`);
    }
  });
});
