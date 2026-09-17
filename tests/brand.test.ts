/**
 * Brand rules, enforced.
 *
 * The club's kit (gdg-resources/design/DESIGN.md) is prose, and prose does not
 * survive six people editing seven games under deadline. These are the rules
 * that are mechanically checkable, so they get checked.
 *
 * Two of them exist because they were already broken once:
 *
 *  - Flat yellow type on white paper measured 1.7:1 contrast. Legible on a
 *    laptop at arm's length, invisible on a TV across a hall — and yellow is
 *    the brand's action colour, so it is exactly what everyone reaches for.
 *  - The sixth faction rendered in `muted`, which is this kit's *disabled*
 *    colour. An option that looks switched off does not get picked, which
 *    would have silently zeroed a whole faction on day one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  COLORS,
  FACTION_COLORS,
  PLAYER_COLORS,
  RANK_COLORS,
  contrastRatio,
  factionColor,
  factionSplit,
  textColor,
  MIN_CONTRAST,
} from '../src/shell/theme.ts';
import { FACTIONS } from '../src/meta/leaderboard.ts';

const BRAND = [COLORS.yellow, COLORS.blue, COLORS.green, COLORS.red] as const;

describe('palette matches the kit exactly', () => {
  test('the eight tokens are the published hexes', () => {
    assert.equal(COLORS.paper.toUpperCase(), '#FFFFFF');
    assert.equal(COLORS.ink.toUpperCase(), '#111111');
    assert.equal(COLORS.grid.toUpperCase(), '#ECECEC');
    assert.equal(COLORS.muted.toUpperCase(), '#BDBDBD');
    assert.equal(COLORS.yellow.toUpperCase(), '#FBBC04');
    assert.equal(COLORS.blue.toUpperCase(), '#4285F4');
    assert.equal(COLORS.green.toUpperCase(), '#34A853');
    assert.equal(COLORS.red.toUpperCase(), '#EA4335');
  });

  test('rank colours follow the kit: 1st yellow, 2nd blue, 3rd red', () => {
    assert.deepEqual([...RANK_COLORS], [COLORS.yellow, COLORS.blue, COLORS.red]);
  });
});

describe('the yellow rule', () => {
  test('yellow on paper genuinely fails the contrast floor', () => {
    // If this ever passes, the rule below is unnecessary and should be deleted.
    const ratio = contrastRatio(COLORS.yellow, COLORS.paper);
    assert.ok(ratio < MIN_CONTRAST, `yellow on paper is ${ratio.toFixed(2)}:1`);
  });

  test('textColor refuses to return yellow on paper', () => {
    assert.equal(textColor(COLORS.yellow, COLORS.paper), COLORS.ink);
  });

  test('textColor keeps colours that DO have contrast', () => {
    assert.equal(textColor(COLORS.ink, COLORS.paper), COLORS.ink);
    assert.equal(textColor(COLORS.red, COLORS.paper), COLORS.red);
  });

  test('yellow is fine as a SURFACE — ink on yellow passes', () => {
    const ratio = contrastRatio(COLORS.ink, COLORS.yellow);
    assert.ok(ratio >= MIN_CONTRAST, `ink on yellow is ${ratio.toFixed(2)}:1`);
    assert.equal(textColor(COLORS.ink, COLORS.yellow), COLORS.ink);
  });

  test('every brand colour is readable on paper once routed through textColor', () => {
    for (const c of BRAND) {
      const resolved = textColor(c, COLORS.paper);
      const ratio = contrastRatio(resolved, COLORS.paper);
      assert.ok(ratio >= MIN_CONTRAST, `${c} resolved to ${resolved} at ${ratio.toFixed(2)}:1`);
    }
  });

  test('ink text is readable on every brand surface', () => {
    for (const c of BRAND) {
      const ratio = contrastRatio(COLORS.ink, c);
      assert.ok(ratio >= MIN_CONTRAST, `ink on ${c} is only ${ratio.toFixed(2)}:1`);
    }
  });
});

describe('faction identities', () => {
  test('every faction has a colour', () => {
    assert.ok(FACTION_COLORS.length >= FACTIONS.length);
  });

  test('NO faction renders as muted — muted means disabled in this kit', () => {
    // The bug this replaces: the 6th faction fell through to COLORS.muted and
    // read as unavailable, so nobody would have picked it.
    for (let i = 0; i < FACTIONS.length; i++) {
      assert.notEqual(
        factionColor(i),
        COLORS.muted,
        `${FACTIONS[i]} renders as muted (disabled)`
      );
    }
  });

  test('every faction colour is visible against paper', () => {
    for (let i = 0; i < FACTIONS.length; i++) {
      const c = factionColor(i);
      const ratio = contrastRatio(c, COLORS.paper);
      // A swatch is a filled shape with an ink outline, so it needs far less
      // contrast than text — but it must not be white-on-white.
      assert.ok(ratio > 1.2, `${FACTIONS[i]} (${c}) is ${ratio.toFixed(2)}:1 on paper`);
    }
  });

  test('factions without a unique colour get a split, so none is a duplicate-looking dead end', () => {
    const solids = new Map<string, number>();
    for (let i = 0; i < FACTIONS.length; i++) {
      if (factionSplit(i)) continue;
      const c = factionColor(i);
      solids.set(c, (solids.get(c) ?? 0) + 1);
    }
    for (const [color, n] of solids) {
      assert.equal(n, 1, `${color} is used by ${n} factions with no split to tell them apart`);
    }
  });

  test('the split uses the four brand colours', () => {
    const split = factionSplit(5);
    assert.ok(split, 'expected OTHER to have a split');
    assert.deepEqual([...split], [...BRAND]);
  });
});

describe('player colours', () => {
  test('are all distinct — six players must be tellable apart', () => {
    const seen = new Set(PLAYER_COLORS);
    assert.equal(seen.size, PLAYER_COLORS.length);
  });

  test('cover the max party size', () => {
    // Red Light seats 6.
    assert.ok(PLAYER_COLORS.length >= 6);
  });
});
