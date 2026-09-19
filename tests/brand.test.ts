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

/* ------------------------------------------------------------------ */
/* Muted is DISABLED, not "secondary"                                  */
/* ------------------------------------------------------------------ */

/**
 * BRAND.md gives `muted` exactly one job: "placeholders, disabled, empty
 * slots". It measures 1.88:1 on paper — barely half this project's own
 * MIN_CONTRAST of 3 — so anything set in it on a television three metres away
 * is not dim, it is gone.
 *
 * It had spread to 25 live, player-facing strings: every game's tagline on the
 * screen a stranger reads first, the round clock, "COMBO ×1.25" (the feedback
 * the playtest singled out as the best in the game), "NEXT PLAYER IN 4",
 * "<STEP LEFT OR RIGHT>" — the Runner's only statement of its own control —
 * the replay's "NEW RECORD" kicker, and Red Light's "OUT". Each one was a
 * local, reasonable-looking decision to make something secondary, and colour
 * is the wrong axis for that: hierarchy here is SIZE and WEIGHT, which is what
 * BRAND.md means by keeping the kit's ratios.
 *
 * So the rule is mechanical now. A `color: COLORS.muted` in the source is a
 * claim that the thing is disabled or empty, and every remaining one is listed
 * below with why.
 */
describe('muted is the disabled colour, and nothing else', () => {
  /**
   * One line of source that sets TEXT in muted.
   *
   * `fill`, `outline`, `stroke` and `shadowColor` in muted are the brand's
   * empty-slot treatment and are correct, so they are excluded. The ternary
   * form is included because it is the one that actually spread: `color:
   * active ? COLORS.ink : COLORS.muted` reads as a tidy two-state style, and
   * it is how the Runner's JUMP and SLIDE labels ended up legible only while
   * the player was already doing the thing they were there to teach.
   *
   * SCOPE, stated honestly: this catches the `color:` draw option, which is
   * where every one of the 25 offences lived. It does not catch a muted colour
   * bound to a local (`const color = out ? COLORS.muted : r.color`) or passed
   * positionally, and those remaining few are all genuine disabled states —
   * an eliminated racer's chip, a stunned hand marker, the shadow under a
   * dead key. A guard that covered everything would need a type checker; a
   * guard that covers the shape the bug actually took is worth having today.
   */
  const setsMutedText = (line: string): boolean =>
    /(?<!shadow)[Cc]olor:\s*COLORS\.muted\b/.test(line) ||
    /[Cc]olor:.*\?.*:\s*COLORS\.muted\b/.test(line) ||
    // `popups.spawn(text, x, y, color, size)` takes its colour positionally,
    // which is how "OOF" — the only word telling a Pose Match player they
    // missed the wall — ended up at 1.9:1 on top of the white hole they
    // failed to fit through.
    /popups\.spawn\(.*COLORS\.muted/.test(line);

  const ALLOWED: Record<string, string> = {
    'src/games/base.ts': 'the ghost skeleton — a ghost is meant to be faint',
    'src/engine/draw.ts': 'an EMPTY leaderboard row — the kit’s dashed empty slot',
    'src/games/rhythm.ts': 'grey dust particles on a missed note',
    'src/shell/menu.ts': 'a feature-flagged-off tile, which IS disabled',
  };

  test('muted genuinely fails the contrast floor it kept being used under', () => {
    assert.ok(
      contrastRatio(COLORS.muted, COLORS.paper) < MIN_CONTRAST,
      'if this ever passes, the rule below can be relaxed'
    );
  });

  test('no player-facing text is drawn in it', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(p)));
        else if (e.name.endsWith('.ts')) out.push(p);
      }
      return out;
    };

    const offenders: string[] = [];
    for (const file of await walk('src')) {
      // `join` gives backslashes on Windows; the allowlist is written the way
      // the repo writes paths.
      // `join` gives backslashes on Windows; the allowlist is written the way
      // the repo writes paths.
      const rel = file.split(/[\\/]/).join('/');
      const src = await readFile(file, 'utf8');
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!setsMutedText(line)) continue;
        if (rel in ALLOWED) continue;
        offenders.push(`${rel}:${i + 1}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `muted is the DISABLED colour (1.88:1 on paper). Use ink and make it ` +
        `secondary by size and weight, or add the file to ALLOWED with a reason:\n  ` +
        offenders.join('\n  ')
    );
  });

  test('every file on the allowlist still actually uses it', () => {
    // A stale allowlist entry is permission nobody asked for.
    return Promise.all(
      Object.keys(ALLOWED).map(async (rel) => {
        const { readFile } = await import('node:fs/promises');
        const src = await readFile(rel, 'utf8');
        assert.ok(
          src.split('\n').some((line) => setsMutedText(line)),
          `${rel} no longer sets muted text — drop it from ALLOWED`
        );
      })
    );
  });
});

/* ------------------------------------------------------------------ */
/* Yellow is a surface                                                 */
/* ------------------------------------------------------------------ */

/**
 * `textColor` exists so nobody has to remember the yellow rule, and it only
 * helps where it is actually called.
 *
 * The mode screen prints the game's own colour as its header, which for two of
 * the seven games — the Runner and Rhythm Punch — is flat yellow. On paper
 * that is 1.7:1: legible on a laptop at arm's length and gone on a TV across a
 * hall. It shipped that way for about twenty minutes and the fix is one call,
 * which is exactly the kind of thing a guard is for.
 */
describe('yellow never carries text', () => {
  test('no drawn text takes a brand colour without routing it through textColor', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(p)));
        else if (e.name.endsWith('.ts')) out.push(p);
      }
      return out;
    };

    const offenders: string[] = [];
    for (const file of await walk('src')) {
      const rel = file.split(/[\\/]/).join('/');
      const lines = (await readFile(file, 'utf8')).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // A colour that MIGHT be yellow. `gameColor` and `factionColor` both
        // return it for some inputs, which is what makes this worth checking:
        // nobody writes `COLORS.yellow` as a label colour on purpose, they
        // write `gameColor(id)` and two of the seven games happen to be it.
        if (!/\bcolor:\s*(COLORS\.yellow\b|gameColor\(|factionColor\()/.test(line)) continue;
        if (line.includes('textColor(')) continue;

        // ONLY INSIDE A DRAW CALL. The same expression in a plain data object
        // is fine and common — `factionStandings()` carries a raw faction
        // colour that its consumer routes through `textColor` at the point of
        // drawing, and rigcheck's verdict colour is a FILL, which is exactly
        // what yellow is for. Looking back a few lines for the call is cruder
        // than a parser and precise enough to catch the shape that has
        // actually gone wrong.
        const near = lines.slice(Math.max(0, i - 6), i).join('\n');
        if (!/\b(drawText|drawTabularNumber)\(/.test(near)) continue;

        offenders.push(`${rel}:${i + 1}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'yellow on paper is 1.7:1. Wrap it in textColor(), or make it a fill and ' +
        `put ink on top:\n  ${offenders.join('\n  ')}`
    );
  });

  test('and textColor really does refuse it', () => {
    assert.notEqual(textColor(COLORS.yellow), COLORS.yellow);
    assert.equal(textColor(COLORS.yellow), COLORS.ink);
  });
});
