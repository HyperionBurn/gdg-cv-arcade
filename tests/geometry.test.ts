/**
 * Unit tests for the slice geometry.
 *
 * These are pure functions with no DOM, so they run in Node directly:
 *   npm test
 *
 * Worth having as real tests rather than browser pokes: a wrong split is the
 * difference between "I cut that" and "the fruit vanished", and the failure is
 * subtle enough to survive a visual check on a moving object.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeBlob,
  polygonArea,
  polygonCentroid,
  splitConvexPolygon,
  segmentCrossesPolygon,
  pointInConvexPolygon,
  transformPolygon,
  type Point,
} from '../src/games/geometry.ts';

const SQUARE: Point[] = [
  { x: -10, y: -10 },
  { x: 10, y: -10 },
  { x: 10, y: 10 },
  { x: -10, y: 10 },
];

describe('polygonArea', () => {
  test('computes the area of a square', () => {
    assert.equal(polygonArea(SQUARE), 400);
  });

  test('is winding-order independent', () => {
    assert.equal(polygonArea([...SQUARE].reverse()), 400);
  });
});

describe('polygonCentroid', () => {
  test('finds the centre of a square', () => {
    const c = polygonCentroid(SQUARE);
    assert.ok(Math.abs(c.x) < 1e-9, `x was ${c.x}`);
    assert.ok(Math.abs(c.y) < 1e-9, `y was ${c.y}`);
  });

  test('tracks a translated polygon', () => {
    const c = polygonCentroid(transformPolygon(SQUARE, 50, -20, 0));
    assert.ok(Math.abs(c.x - 50) < 1e-9);
    assert.ok(Math.abs(c.y + 20) < 1e-9);
  });
});

describe('splitConvexPolygon', () => {
  test('a cut through the centre conserves total area', () => {
    const halves = splitConvexPolygon(SQUARE, { x: -100, y: 0 }, { x: 100, y: 0 });
    assert.ok(halves, 'expected a split');
    const [a, b] = halves;
    assert.ok(Math.abs(polygonArea(a) + polygonArea(b) - 400) < 1e-6);
  });

  test('a horizontal cut through the centre halves it evenly', () => {
    const halves = splitConvexPolygon(SQUARE, { x: -100, y: 0 }, { x: 100, y: 0 })!;
    assert.ok(Math.abs(polygonArea(halves[0]) - 200) < 1e-6);
    assert.ok(Math.abs(polygonArea(halves[1]) - 200) < 1e-6);
  });

  test('an off-centre cut splits unevenly but still conserves area', () => {
    const halves = splitConvexPolygon(SQUARE, { x: -100, y: 5 }, { x: 100, y: 5 })!;
    const [a, b] = halves.map(polygonArea).sort((x, y) => x - y) as [number, number];
    assert.ok(Math.abs(a - 100) < 1e-6, `smaller half was ${a}`);
    assert.ok(Math.abs(b - 300) < 1e-6, `larger half was ${b}`);
    assert.ok(Math.abs(a + b - 400) < 1e-6);
  });

  test('a diagonal cut conserves area', () => {
    const halves = splitConvexPolygon(SQUARE, { x: -100, y: -100 }, { x: 100, y: 100 })!;
    assert.ok(Math.abs(polygonArea(halves[0]) + polygonArea(halves[1]) - 400) < 1e-6);
  });

  test('returns null when the line misses entirely', () => {
    assert.equal(splitConvexPolygon(SQUARE, { x: -100, y: 50 }, { x: 100, y: 50 }), null);
  });

  test('returns null for a degenerate zero-length line', () => {
    assert.equal(splitConvexPolygon(SQUARE, { x: 0, y: 0 }, { x: 0, y: 0 }), null);
  });

  test('a cut exactly along an edge does not produce a sliver', () => {
    // Grazing the boundary must not yield a degenerate half — those render as
    // visual noise and carry nonsense physics.
    const result = splitConvexPolygon(SQUARE, { x: -100, y: -10 }, { x: 100, y: -10 });
    assert.equal(result, null);
  });

  test('both halves are non-degenerate for every angle through the centre', () => {
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI;
      const p1 = { x: Math.cos(a) * -100, y: Math.sin(a) * -100 };
      const p2 = { x: Math.cos(a) * 100, y: Math.sin(a) * 100 };
      const halves = splitConvexPolygon(SQUARE, p1, p2);
      assert.ok(halves, `angle ${a} produced no split`);
      assert.ok(halves[0].length >= 3 && halves[1].length >= 3);
      assert.ok(polygonArea(halves[0]) > 1, `angle ${a} gave a sliver`);
      assert.ok(polygonArea(halves[1]) > 1, `angle ${a} gave a sliver`);
      assert.ok(Math.abs(polygonArea(halves[0]) + polygonArea(halves[1]) - 400) < 1e-6);
    }
  });

  test('conserves area on generated blobs at many angles', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const blob = makeBlob(40, 9, seed);
      const total = polygonArea(blob);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI;
        const halves = splitConvexPolygon(
          blob,
          { x: Math.cos(a) * -200, y: Math.sin(a) * -200 },
          { x: Math.cos(a) * 200, y: Math.sin(a) * 200 }
        );
        assert.ok(halves, `seed ${seed} angle ${a} did not split`);
        const sum = polygonArea(halves[0]) + polygonArea(halves[1]);
        assert.ok(
          Math.abs(sum - total) < 1e-6,
          `seed ${seed} angle ${a}: ${sum} vs ${total}`
        );
      }
    }
  });
});

describe('makeBlob', () => {
  test('is deterministic for a given seed', () => {
    assert.deepEqual(makeBlob(30, 9, 7), makeBlob(30, 9, 7));
  });

  test('different seeds give different shapes', () => {
    assert.notDeepEqual(makeBlob(30, 9, 7), makeBlob(30, 9, 8));
  });

  test('stays convex — the splitter depends on it', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const poly = makeBlob(40, 9, seed);
      let sign = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        const c = poly[(i + 2) % poly.length]!;
        const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
        if (Math.abs(cross) < 1e-9) continue;
        const cur = cross > 0 ? 1 : -1;
        if (sign === 0) sign = cur;
        else assert.equal(cur, sign, `seed ${seed} is concave at vertex ${i}`);
      }
    }
  });
});

describe('segmentCrossesPolygon', () => {
  test('detects a segment passing straight through', () => {
    assert.ok(segmentCrossesPolygon({ x: -50, y: 0 }, { x: 50, y: 0 }, SQUARE));
  });

  test('rejects a segment that misses', () => {
    assert.ok(!segmentCrossesPolygon({ x: -50, y: 50 }, { x: 50, y: 50 }, SQUARE));
  });

  test('a short flick entirely inside still counts', () => {
    assert.ok(segmentCrossesPolygon({ x: -2, y: 0 }, { x: 2, y: 0 }, SQUARE));
  });

  test('a segment ending just short does not count', () => {
    assert.ok(!segmentCrossesPolygon({ x: -50, y: 0 }, { x: -11, y: 0 }, SQUARE));
  });

  test('THE TUNNELLING CASE: a fast swipe spanning the polygon is caught', () => {
    // This is the whole reason collision is tested as a segment. At 30fps a
    // fast hand jumps hundreds of pixels between samples; testing only the
    // current tip would miss the fruit entirely and the game would feel worst
    // exactly when the player swings hardest.
    const far = segmentCrossesPolygon({ x: -900, y: 0 }, { x: 900, y: 0 }, SQUARE);
    assert.ok(far, 'a swipe that jumped over the polygon was missed');

    // And confirm a point test genuinely would have failed here.
    assert.ok(!pointInConvexPolygon({ x: -900, y: 0 }, SQUARE));
    assert.ok(!pointInConvexPolygon({ x: 900, y: 0 }, SQUARE));
  });
});

describe('transformPolygon', () => {
  test('rotating by 2pi returns the original', () => {
    const t = transformPolygon(SQUARE, 0, 0, Math.PI * 2);
    for (let i = 0; i < SQUARE.length; i++) {
      assert.ok(Math.abs(t[i]!.x - SQUARE[i]!.x) < 1e-9);
      assert.ok(Math.abs(t[i]!.y - SQUARE[i]!.y) < 1e-9);
    }
  });

  test('preserves area under rotation and translation', () => {
    const t = transformPolygon(SQUARE, 123, -45, 0.7);
    assert.ok(Math.abs(polygonArea(t) - 400) < 1e-9);
  });
});
