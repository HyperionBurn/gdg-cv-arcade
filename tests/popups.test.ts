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

import { PopupLayer, RollingNumber } from '../src/engine/juice.ts';

const SIZE = 30;
const WIDE = 1920;

/**
 * HOW MUCH WIDER THE REAL GLYPHS ARE THAN `estimateHalfWidth` GUESSES.
 *
 * `spawn` has no context, so it guessed `length * size * 0.56`. MEASURED in
 * the browser against Archivo at the sizes these popups actually use, that is
 * 14-31% too small on every string in the app:
 *
 *   <BLADES OUT!>  est 246  real 299   x1.22
 *   <DOUBLE!>      est 217  real 275   x1.27
 *   GOTCHA!        est  90  real 118   x1.31
 *   x5             est  31  real  36   x1.18
 *
 * So the fake below deliberately reports a width the ESTIMATE WOULD GET
 * WRONG. A clamp that still relies on the guess cannot pass these tests; only
 * one that measures can.
 */
const REAL_RATIO = 1.22;

/** The real drawn half-width, which is what has to stay on screen. */
const halfOf = (text: string, size = SIZE): number =>
  (text.length * size * 0.56 * REAL_RATIO) / 2;

/** What `spawn`'s context-free guess would have said. Kept to show the gap. */
const guessedHalfOf = (text: string, size = SIZE): number => (text.length * size * 0.56) / 2;

/** The layer keeps its pool private; the draw is the only public read. */
const spawnedAt = (layer: PopupLayer): Array<{ x: number; text: string }> => {
  const out: Array<{ x: number; text: string }> = [];
  let fontSize = SIZE;
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
    measureText: (t: string) => ({ width: t.length * fontSize * 0.56 * REAL_RATIO }),
    set font(v: string) {
      fontSize = Number(/(\d+(?:\.\d+)?)px/.exec(v)?.[1] ?? SIZE);
    },
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

/** Records every `ctx.scale()` a popup applies, frame by frame. */
const scaleOverLife = (frames: number): number[] => {
  const layer = new PopupLayer();
  layer.spawn('X', 500, 400, '#111111', SIZE, 0.9);
  const seen: number[] = [];
  const ctx = {
    save() {}, restore() {}, translate() {},
    scale(s: number) { seen.push(s); },
    strokeText() {}, fillText() {},
    measureText: () => ({ width: 0 }),
    set font(_v: string) {}, set textAlign(_v: string) {}, set textBaseline(_v: string) {},
    set globalAlpha(_v: number) {}, set lineJoin(_v: string) {}, set miterLimit(_v: number) {},
    set lineWidth(_v: number) {}, set strokeStyle(_v: string) {}, set fillStyle(_v: string) {},
  } as unknown as CanvasRenderingContext2D;
  for (let i = 0; i < frames; i++) {
    layer.update(1 / 60);
    layer.draw(ctx, 'Archivo');
  }
  return seen;
};

/**
 * THE POP WENT THE WRONG WAY AND ENDED IN A JUMP CUT.
 *
 * `t` runs 1 -> 0 over a popup's life, so `1 + (1 - t) * 6` grew from 1.11 to
 * 1.89 over eight frames and then snapped back to 1 in one. Measured:
 *
 *   1.111 1.222 1.333 1.444 1.556 1.667 1.778 1.889 1 1 1 ...
 *
 * A 47% shrink in a single frame, on every popup in the app, under a comment
 * reading "Pop in fast, then fade".
 */
describe('a popup pops in and settles', () => {
  test('it starts big and shrinks, never the reverse', () => {
    const s = scaleOverLife(20);
    assert.ok(s.length > 10, 'the popup did not survive long enough to measure');
    assert.ok(s[0]! > 1.2, `first frame is ${s[0]}, so there is no pop at all`);
    for (let i = 1; i < s.length; i++) {
      assert.ok(
        s[i]! <= s[i - 1]! + 1e-9,
        `scale grew from ${s[i - 1]} to ${s[i]} at frame ${i}; the pop is inverted`
      );
    }
  });

  test('and never jumps', () => {
    const s = scaleOverLife(20);
    for (let i = 1; i < s.length; i++) {
      const step = Math.abs(s[i]! - s[i - 1]!);
      assert.ok(
        step < 0.2,
        `scale stepped ${step.toFixed(3)} between frames ${i - 1} and ${i} ` +
          `(${s[i - 1]} -> ${s[i]}); that is a visible jump cut, not an ease`
      );
    }
  });

  test('it settles at exactly 1 and stays there', () => {
    const s = scaleOverLife(30);
    assert.equal(s[s.length - 1], 1, 'the popup never returns to its true size');
  });
});

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

/**
 * THE CLAMP WAS DEFEATED BY THE POP IT SHARES A FUNCTION WITH.
 *
 * `spawn` positions a popup so its SETTLED width fits, and `draw` then scales
 * it up for the first fifteen percent of its life. So the guarantee was only
 * ever "the word is on screen from frame nine", and frame one to eight is
 * exactly when a player is looking at an elimination taunt.
 *
 * MEASURED, 'TOO SLOW!' at size 30 spawned 35px into a 1920 viewport, worst
 * left edge across the whole life:
 *
 *   overshoot 1.90   -62.6   off screen, the original bug in miniature
 *   overshoot 1.35    +5.4   on screen for every frame
 *
 * The 1.90 was never a designed number — it is where the old inverted ramp
 * happened to end up, preserved by a fix that was careful about the shape and
 * took the peak on trust. These tests assert the invariant over the WHOLE life
 * rather than at spawn, which is the thing that was never checked.
 */
describe('a popup is on screen for every frame it exists', () => {
  /** Widest drawn extent over a popup's whole life, in viewport pixels. */
  const extent = (text: string, x: number, width: number): { left: number; right: number } => {
    const layer = new PopupLayer();
    layer.width = width;
    layer.spawn(text, x, 400, '#ea4335', SIZE);

    let left = Infinity;
    let right = -Infinity;
    let scale = 1;
    let tx = 0;
    const ctx = {
      save() {}, restore() {},
      translate(px: number) { tx = px; },
      scale(s: number) { scale = s; },
      strokeText(t: string) {
        const hw = halfOf(t) * scale;
        left = Math.min(left, tx - hw);
        right = Math.max(right, tx + hw);
      },
      fillText() {},
      measureText: (t: string) => ({ width: t.length * SIZE * 0.56 * REAL_RATIO }),
      set font(_v: string) {}, set textAlign(_v: string) {}, set textBaseline(_v: string) {},
      set globalAlpha(_v: number) {}, set lineJoin(_v: string) {}, set miterLimit(_v: number) {},
      set lineWidth(_v: number) {}, set strokeStyle(_v: string) {}, set fillStyle(_v: string) {},
    } as unknown as CanvasRenderingContext2D;

    for (let f = 0; f < 60; f++) {
      layer.draw(ctx, 'Archivo');
      layer.update(1 / 60);
    }
    return { left, right };
  };

  test('including while it is still popping in, at the left edge', () => {
    const { left } = extent('TOO SLOW!', 35, WIDE);
    assert.ok(
      left >= 0,
      `the word reaches ${left.toFixed(1)} during the pop, which is off screen — ` +
        `the clamp reserved the settled width and the draw scaled past it`
    );
  });

  test('and at the right edge', () => {
    const { right } = extent('GOTCHA!', WIDE - 20, WIDE);
    assert.ok(right <= WIDE, `the word reaches ${right.toFixed(1)}, past ${WIDE}`);
  });

  /**
   * THE COST OF THE GUARANTEE, held to the thing that actually matters.
   *
   * My first version of this asserted a pixel budget and failed at 72.5px
   * against a made-up threshold of 37.8 — a number with no argument behind it,
   * which is the same mistake as the 1.9 overshoot one directory over.
   *
   * What a taunt has to do is name the right racer. So the invariant is that
   * the clamped word still COVERS the point it was spawned at: a player
   * looking at their own marker sees the word on it, however far its centre
   * had to move to stay on screen. Reserving the peak costs 26.5px more than
   * reserving the settled width (81.0 -> 107.5 for this word), and the word is
   * 151px wide, so it still lands squarely over the racer.
   */
  test('and the taunt still covers the racer it names', () => {
    const layer = new PopupLayer();
    layer.width = WIDE;
    layer.spawn('TOO SLOW!', 35, 400, '#ea4335', SIZE);
    const placed = spawnedAt(layer)[0]!.x;
    const hw = halfOf('TOO SLOW!');
    assert.ok(
      placed - hw <= 35 && 35 <= placed + hw,
      `the taunt sits at ${placed.toFixed(1)} ± ${hw.toFixed(1)} and no longer ` +
        `covers the racer at 35 — it is naming empty floor`
    );
  });
});


/**
 * THE SEPARATION CHECK IS THE ONE THING THE ESTIMATE STILL DECIDES.
 *
 * `draw` measures and clamps exactly now, so an under-reserving estimate no
 * longer pushes a word off the screen. It still decides whether two labels are
 * considered to be in each other's way — and under-reserving there lets two
 * that really do overlap slip past the check and land on each other, which is
 * the smear the separation exists to prevent.
 *
 * These two spawn 130px apart at size 30. `GOTCHA!` is 7 glyphs:
 *
 *   at 0.56em  half = 58.8   sum 117.6   130 > 117.6  ->  NOT staggered
 *   at 0.68em  half = 71.4   sum 142.8   130 < 142.8  ->  staggered
 *
 * So this gap is chosen to sit between the guess and the truth. It is the
 * only place the constant is observable, and without it the estimate can be
 * reverted with every test still green — which is exactly what happened when
 * this was mutated.
 */
describe('the separation check uses a width that is not too small', () => {
  test('two labels that really overlap are staggered apart', () => {
    const layer = new PopupLayer();
    layer.width = WIDE;
    layer.spawn('GOTCHA!', 500, 400, '#ea4335', SIZE);
    layer.spawn('GOTCHA!', 630, 400, '#ea4335', SIZE);

    const ys: number[] = [];
    const ctx = {
      save() {}, restore() {},
      translate(_x: number, y: number) { ys.push(y); },
      scale() {}, strokeText() {}, fillText() {},
      measureText: (t: string) => ({ width: t.length * SIZE * 0.56 * REAL_RATIO }),
      set font(_v: string) {}, set textAlign(_v: string) {}, set textBaseline(_v: string) {},
      set globalAlpha(_v: number) {}, set lineJoin(_v: string) {}, set miterLimit(_v: number) {},
      set lineWidth(_v: number) {}, set strokeStyle(_v: string) {}, set fillStyle(_v: string) {},
    } as unknown as CanvasRenderingContext2D;
    layer.draw(ctx, 'Archivo');

    assert.equal(ys.length, 2, 'both popups should be drawn');
    assert.notEqual(
      ys[0],
      ys[1],
      `both labels sit at y=${ys[0]}. 130px apart at size 30 they overlap by ` +
        `13px of real glyphs, and the separation check missed it — the width ` +
        `estimate is back to one that is too small`
    );
  });

  /** And two that genuinely do not overlap are left where they were put. */
  test('but two that are clear of each other are not moved', () => {
    const layer = new PopupLayer();
    layer.width = WIDE;
    layer.spawn('GOTCHA!', 400, 400, '#ea4335', SIZE);
    layer.spawn('GOTCHA!', 900, 400, '#ea4335', SIZE);

    const ys: number[] = [];
    const ctx = {
      save() {}, restore() {},
      translate(_x: number, y: number) { ys.push(y); },
      scale() {}, strokeText() {}, fillText() {},
      measureText: (t: string) => ({ width: t.length * SIZE * 0.56 * REAL_RATIO }),
      set font(_v: string) {}, set textAlign(_v: string) {}, set textBaseline(_v: string) {},
      set globalAlpha(_v: number) {}, set lineJoin(_v: string) {}, set miterLimit(_v: number) {},
      set lineWidth(_v: number) {}, set strokeStyle(_v: string) {}, set fillStyle(_v: string) {},
    } as unknown as CanvasRenderingContext2D;
    layer.draw(ctx, 'Archivo');
    assert.equal(ys[0], ys[1], 'a popup 500px away was staggered for nothing');
  });
});

/**
 * THE SCORE COUNTER, which is the other thing in this file that reaches a TV.
 *
 * `RollingNumber` eases a displayed score toward its target so a jump from
 * 180 to 215 counts up instead of snapping. It is untested, and two of its
 * properties are load-bearing well outside this file.
 *
 * FIRST, THE NaN GUARD. Its own comment calls it "the last thing standing
 * between a bad score and the literal glyphs NaN rendered at 11vh on a
 * television", and it is right: once NaN reaches `target` every `update`
 * propagates it into `display` and nothing downstream checks. Scores here are
 * computed from division by a body scale that is legitimately zero for a
 * frame, so this is a real input, not a hypothetical one.
 *
 * SECOND, ROUNDING. `value` is `Math.round(display)`, and the versus results
 * screen draws THAT while deciding the winner from the raw score. Those agree
 * only because every game returns an integer — see the trap note in HANDOFF.
 * These tests pin the rounding half of that pair.
 */
describe('RollingNumber', () => {
  test('a settled counter reads exactly what it was set to', () => {
    const n = new RollingNumber(10);
    n.set(215, true);
    assert.equal(n.value, 215);
    assert.equal(n.isSettled, true);
  });

  test('it counts toward a new score rather than snapping', () => {
    const n = new RollingNumber(10);
    n.set(0, true);
    n.set(200);
    n.update(1 / 60);
    assert.ok(n.exact > 0, 'it did not move');
    assert.ok(n.exact < 200, 'it snapped instead of counting');
  });

  test('and it always arrives', () => {
    const n = new RollingNumber(10);
    n.set(0, true);
    n.set(200);
    for (let f = 0; f < 600; f++) n.update(1 / 60);
    assert.equal(n.value, 200);
    assert.equal(n.isSettled, true, 'a counter still crawling at the results screen');
  });

  /**
   * The floor exists so the last few units do not crawl: a pure exponential
   * approach spends a visible second creeping the final digit, which on a
   * results screen looks like the game has hung.
   */
  test('the last few points do not crawl', () => {
    const n = new RollingNumber(10);
    n.set(0, true);
    n.set(3);
    let frames = 0;
    while (!n.isSettled && frames < 600) {
      n.update(1 / 60);
      frames++;
    }
    assert.ok(frames < 30, `a three-point climb took ${frames} frames`);
  });

  /**
   * THE ONE THAT REACHES THE TELEVISION. A body scale can legitimately be zero
   * for a frame, so a score divided by it arrives here as NaN or Infinity.
   * Dropped rather than stored — once it is in `target` it is permanent.
   */
  test('a bad number never reaches the display', () => {
    const n = new RollingNumber(10);
    n.set(120, true);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      n.set(bad);
      n.update(1 / 60);
      assert.equal(Number.isFinite(n.value), true, `${bad} reached the display`);
      assert.equal(n.value, 120, `${bad} moved the score`);
    }
  });

  test('and neither does a bad increment', () => {
    const n = new RollingNumber(10);
    n.set(50, true);
    n.add(Number.NaN);
    n.add(Number.POSITIVE_INFINITY);
    for (let f = 0; f < 60; f++) n.update(1 / 60);
    assert.equal(n.value, 50);
  });

  /**
   * `value` rounds and the versus screen draws it while deciding the winner
   * from the unrounded score. Two scores that round together while differing
   * would show the same number with a crown on one of them; the reason that
   * cannot happen today is that every game returns a whole number, which this
   * pins from the other side.
   */
  test('value rounds, so equal display can hide unequal input', () => {
    const a = new RollingNumber(10);
    const b = new RollingNumber(10);
    a.set(18.6, true);
    b.set(19.4, true);
    assert.equal(a.value, 19);
    assert.equal(b.value, 19);
    assert.notEqual(a.exact, b.exact, 'exact is what a decision should use');
  });
});
