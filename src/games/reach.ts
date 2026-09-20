/**
 * Where a game may put something a player has to reach for.
 *
 * Fruit Ninja and Balloon Pop both throw objects through a band measured from
 * the player's own body rather than at a fraction of the slot rect. That fix
 * came from a playtest report — row 20 of FEEDBACK.md — and each game grew its
 * own copy of the geometry, with its own half-width and its own bug.
 *
 * ---------------------------------------------------------------------------
 * WHY IT INTERSECTS RATHER THAN SHIFTS
 *
 * Both copies used to SHIFT the band at a slot edge instead of shrinking it,
 * so that a player standing off to one side still got a full-width spread —
 * all of it, the reasoning went, on the side they can reach. The first half of
 * that worked. The second did not: shifting preserves the band's WIDTH, which
 * is twice the reach, so a body pressed against an edge got the whole spread
 * on one side of itself.
 *
 * MEASURED on a 1920x1080 screen with a 324px torso, at Fruit Ninja's 1.45,
 * as the worst reach the band asks of the player by body position:
 *
 *   0.10 -> 2.51 torso   0.20 -> 1.91   0.30..0.70 -> 1.45   0.80 -> 1.91   0.90 -> 2.51
 *
 * against a full stretch of 1.57. So the one thing this band exists to prevent
 * came back for anybody not standing near the middle. The distribution tables
 * in both games are not wrong — they were measured on a CENTRED body, which is
 * the one case that was always fine.
 *
 * An off-centre player now trades SPREAD for reachability. Half a band they
 * can reach beats a full one they cannot, which is the whole content of the
 * report — and it matters most in Balloon Pop, which the README calls the
 * accessible one and which is the game somebody plays when stretching is the
 * thing they cannot do.
 */

/** A full stretch, in torso units. Nothing should ever be placed beyond it. */
export const FULL_STRETCH_TORSOS = 1.57;

export interface ReachBandOpts {
  /** Screen-space body centre, or null before a body is anchored. */
  cx: number | null;
  /** Torso height in screen pixels. Zero means not measured yet. */
  unit: number;
  rect: { x: number; width: number };
  /** Half-size of the thing being placed, so it lands fully inside the slot. */
  radius: number;
  /** Half-width of the band, in torso units. Per game. */
  halfTorsos: number;
  /**
   * Fraction of the slot inset on each side, used only until a body is
   * anchored — the first frame or two of a round.
   */
  fallbackInset: number;
}

export function reachBandFor(opts: ReachBandOpts): { min: number; max: number } {
  const { cx, unit, rect, radius, halfTorsos, fallbackInset } = opts;
  const lo = rect.x + radius;
  const hi = rect.x + rect.width - radius;

  if (cx === null || unit <= 0) {
    return {
      min: rect.x + rect.width * fallbackInset,
      max: rect.x + rect.width * (1 - fallbackInset),
    };
  }

  const half = unit * halfTorsos;
  // Inside the player's reach AND inside the slot. Both are hard limits.
  const min = Math.max(lo, cx - half);
  const max = Math.min(hi, cx + half);
  return { min: Math.min(min, max), max: Math.max(min, max) };
}
