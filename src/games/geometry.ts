/**
 * 2D polygon geometry for sliceable objects.
 *
 * PLAN.md §3: "Splitting a convex polygon along a line segment is ~20 lines and
 * yields two correct halves with correct physics. In 3D the same thing is CSG —
 * hard, and invisible from 3m. The cut-line split IS the mechanic."
 *
 * The reference implementation we looked at point-samples the blade against a
 * bounding circle, which means the cut never actually relates to where you
 * swung. Splitting the real polygon along the real swipe line is the whole
 * difference between "fruit disappears" and "I cut that".
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * Convex blob approximating a fruit. Deterministic given `seed`, so a replay or
 * a ghost reproduces the identical shape.
 */
export function makeBlob(radius: number, sides: number, seed: number): Point[] {
  const pts: Point[] = [];
  // Cheap deterministic hash — no PRNG dependency and stable across reloads.
  const rand = (i: number) => {
    const x = Math.sin(seed * 374.761 + i * 91.437) * 43758.5453;
    return x - Math.floor(x);
  };
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2;
    // Stay near-circular: strong irregularity can make the hull concave, and
    // the splitter assumes convexity.
    const r = radius * (0.86 + rand(i) * 0.28);
    pts.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  }
  return pts;
}

export function polygonArea(poly: readonly Point[]): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

export function polygonCentroid(poly: readonly Point[]): Point {
  let cx = 0;
  let cy = 0;
  let signed = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const cross = a.x * b.y - b.x * a.y;
    signed += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(signed) < 1e-9) {
    // Degenerate — fall back to the vertex mean rather than dividing by ~0.
    let mx = 0;
    let my = 0;
    for (const p of poly) {
      mx += p.x;
      my += p.y;
    }
    return { x: mx / poly.length, y: my / poly.length };
  }
  const f = 1 / (3 * signed);
  return { x: cx * f, y: cy * f };
}

/** Signed side of the infinite line a->b. Positive is left of travel. */
function sideOf(p: Point, a: Point, b: Point): number {
  return (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x);
}

/**
 * Splits a CONVEX polygon along the infinite line through a and b.
 *
 * @returns the two halves, or null if the line misses (everything on one side).
 */
export function splitConvexPolygon(
  poly: readonly Point[],
  a: Point,
  b: Point
): [Point[], Point[]] | null {
  if (poly.length < 3) return null;
  if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) return null;

  const left: Point[] = [];
  const right: Point[] = [];
  let hasLeft = false;
  let hasRight = false;

  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]!;
    const next = poly[(i + 1) % poly.length]!;
    const sc = sideOf(cur, a, b);
    const sn = sideOf(next, a, b);

    // A vertex exactly on the line belongs to both halves — that keeps each
    // half a closed polygon instead of leaving a gap at the cut.
    if (sc >= 0) {
      right.push(cur);
      if (sc > 0) hasRight = true;
    }
    if (sc <= 0) {
      left.push(cur);
      if (sc < 0) hasLeft = true;
    }

    if ((sc > 0 && sn < 0) || (sc < 0 && sn > 0)) {
      const t = sc / (sc - sn);
      const ip: Point = {
        x: cur.x + (next.x - cur.x) * t,
        y: cur.y + (next.y - cur.y) * t,
      };
      left.push(ip);
      right.push(ip);
    }
  }

  if (!hasLeft || !hasRight) return null;
  if (left.length < 3 || right.length < 3) return null;
  return [left, right];
}

function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = sideOf(p3, p1, p2);
  const d2 = sideOf(p4, p1, p2);
  const d3 = sideOf(p1, p3, p4);
  const d4 = sideOf(p2, p3, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

export function pointInConvexPolygon(p: Point, poly: readonly Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const s = sideOf(p, a, b);
    if (Math.abs(s) < 1e-9) continue;
    const cur = s > 0 ? 1 : -1;
    if (sign === 0) sign = cur;
    else if (sign !== cur) return false;
  }
  return true;
}

/**
 * Does the swipe segment actually cross this polygon?
 *
 * Checked as a SEGMENT, not a point. At 30fps a fast hand covers hundreds of
 * pixels between samples; testing the current tip alone tunnels straight
 * through anything smaller than that gap, and the game feels broken in exactly
 * the situation it should feel best — a fast swipe.
 */
export function segmentCrossesPolygon(
  s1: Point,
  s2: Point,
  poly: readonly Point[]
): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if (segmentsIntersect(s1, s2, a, b)) return true;
  }
  // Wholly inside counts too — a short flick that starts and ends within a
  // large fruit should still cut it.
  return pointInConvexPolygon(s1, poly) || pointInConvexPolygon(s2, poly);
}

/** Translates a polygon's points by an offset (used to place a body's shape). */
export function translatePolygon(poly: readonly Point[], dx: number, dy: number): Point[] {
  return poly.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/** Rotates a polygon about the origin. */
export function rotatePolygon(poly: readonly Point[], angle: number): Point[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return poly.map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c }));
}

/** World-space vertices of a body: local polygon rotated then translated. */
export function transformPolygon(
  poly: readonly Point[],
  x: number,
  y: number,
  angle: number
): Point[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return poly.map((p) => ({
    x: x + p.x * c - p.y * s,
    y: y + p.x * s + p.y * c,
  }));
}
