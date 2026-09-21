import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POSES } from '../src/games/poses.ts';

/**
 * THE COMFORT CEILING: 135 DEGREES OF ELBOW FLEXION.
 *
 * Playtest report: "Mabye dial down the difficulty a bit 😅, thing was asking
 * to bend our arms in ways that ain't possible bahahahaha. just the latter
 * half, first half is good." The first half poses top out at 125°; the
 * offenders were the five built on WING (-150 → 150°) and OVERHEAD (-145 →
 * 145°), both softened to -135.
 *
 * MAX_FLEX (155) is the anatomical LIMIT — what achievabilityFault enforces.
 * This is a different number: what an ordinary person holds WITHOUT EFFORT
 * under a two-second deadline. 135 is a standard bicep curl; 150 is "touch your
 * collarbone from an overhead arm", which a playtest cohort of ordinary
 * students reported as impossible-in-practice even though it is
 * legal-anatomy.
 *
 * This guard exists because nothing else catches a revert: the suite stays
 * green with WING back at -150 (verified by mutation) — the shapes remain
 * distinguishable, achievable, and safe; only the PEOPLE break.
 */
const COMFORT_FLEX = 135;

test('no pose demands more than 135 degrees of elbow flexion', () => {
  for (const p of POSES) {
    const a = p.angles;
    const flexOf = (sh: number, el: number): number =>
      Math.abs(((el - sh + 540) % 360) - 180);
    const worst = Math.max(flexOf(a.shoulderL, a.elbowL), flexOf(a.shoulderR, a.elbowR));
    assert.ok(
      worst <= COMFORT_FLEX,
      `${p.name} demands ${worst.toFixed(0)}° of elbow flexion — over the ${COMFORT_FLEX}° comfort ceiling. Playtest report: "asking to bend our arms in ways that ain't possible". Soften the FLEX_SET entry or re-pick the pose.`
    );
  }
});

