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
import { GAME_SEATS } from '../src/meta/games.ts';

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
  test('are all distinct — every player must be tellable apart', () => {
    const seen = new Set(PLAYER_COLORS);
    assert.equal(seen.size, PLAYER_COLORS.length);
  });

  /**
   * THE ONE THAT WAS MISSING, AND THE BUG IT WOULD HAVE CAUGHT.
   *
   * `PLAYER_COLORS` ended `...ink, muted` so that it would be six long, because
   * Red Light seated six. But `redlight.ts` draws an eliminated lane with
   * `out ? COLORS.muted : r.color` — so the sixth player's marker, chip and
   * progress bar were the byte-identical grey the game uses for YOU ARE OUT,
   * under a HUD reading 6/6 STILL IN. Two of the five other players could not
   * tell whether the sixth was still in the round.
   *
   * The length assertion that used to live here actively caused it: it demanded
   * a sixth entry and the palette had none to give, so one was borrowed from
   * the disabled colour. Red Light seats five now, and the rule that holds is
   * the semantic one, not the count.
   */
  test('none of them is the disabled colour', () => {
    for (const c of PLAYER_COLORS) {
      assert.notEqual(
        c,
        COLORS.muted,
        'a live player is drawn in the colour this kit reserves for disabled — ' +
          'and in Red Light, for eliminated'
      );
    }
  });

  /**
   * The roster can only be as long as this array: a lane's identity IS its
   * entry. Asserted against the real game configs rather than a number, so
   * raising `maxPlayers` anywhere without a colour to go with it fails here.
   */
  test('cover the largest party on the roster', () => {
    const biggest = Math.max(...Object.values(GAME_SEATS));
    assert.ok(
      PLAYER_COLORS.length >= biggest,
      `a game seats ${biggest} but there are only ${PLAYER_COLORS.length} identities`
    );
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
   * SCOPE, and the claim that stopped being true.
   *
   * This started out catching the `color:` draw option, which is where every
   * one of the 25 original offences lived, with a note saying the remaining
   * uncaught cases "are all genuine disabled states". That was true when it
   * was written and is not a claim a comment can keep making on its own.
   *
   * It was already false. `GRADE_COLORS` in rhythm.ts is a colour MAP, and
   * `good` pointed at `COLORS.muted`; the map feeds both a `popups.spawn` and
   * a `drawText`, so the `<GOOD>` flash and the `+N` for a good hit were both
   * 1.88:1 on paper. The irony is that `drawGradeFlash` special-cases `miss`
   * out of the map with a comment explaining, correctly, that quiet is not the
   * same as invisible — and left the identical problem one line away.
   *
   * So maps are checked now too. What is still NOT caught is a muted colour
   * bound to a local (`const color = out ? COLORS.muted : r.color`), and those
   * remaining cases genuinely are disabled states today: an eliminated racer's
   * chip and lane, a stunned hand marker, an unarmed balloon. Verify that
   * rather than trusting this sentence — it is the kind of claim that rots.
   */
  const setsMutedText = (line: string): boolean =>
    /(?<!shadow)[Cc]olor:\s*COLORS\.muted\b/.test(line) ||
    /[Cc]olor:.*\?.*:\s*COLORS\.muted\b/.test(line) ||
    // `popups.spawn(text, x, y, color, size)` takes its colour positionally,
    // which is how "OOF" — the only word telling a Pose Match player they
    // missed the wall — ended up at 1.9:1 on top of the white hole they
    // failed to fit through.
    /popups\.spawn\(.*COLORS\.muted/.test(line);

  /**
   * A colour MAP whose values are drawn as text.
   *
   * `const GRADE_COLORS: Record<Grade, string> = { good: COLORS.muted }` is a
   * `color:`-shaped bug that never writes the word `color`. Flagging any
   * object-literal property bound to muted is blunt — a map of FILL colours
   * would trip it too — but there is exactly one such map in this app and the
   * allowlist is right there for the next one.
   */
  const isMutedInColourMap = (line: string, prev: string[]): boolean => {
    if (!/^\s*\w+:\s*COLORS\.muted,?\s*$/.test(line)) return false;
    // Only inside something that looks like a colour table.
    return prev.some((l) => /(COLORS|COLOR|PALETTE|_COLORS)\b.*=\s*\{|Record<[^>]*,\s*string>/.test(l));
  };

  /**
   * PER-FILE EXEMPTION WAS THE HOLE, NOT THE REGEX.
   *
   * This used to be `Record<string, string>` and the loop did
   * `if (rel in ALLOWED) continue` — so allowlisting rhythm.ts for its grey
   * dust particles exempted all 1,800 other lines of rhythm.ts. That is how
   * `GRADE_COLORS.good = COLORS.muted` sat there: a legitimate exemption for
   * one thing became blanket permission for the file.
   *
   * Proven, not assumed: reverting the `good` fix under the old guard left the
   * suite green.
   *
   * So the allowance is a COUNT. A new muted string in an exempted file
   * changes the number and fails, and the number going DOWN fails too, which
   * is the stale-entry check the test below used to do separately.
   */
  const ALLOWED: Record<string, { why: string; count: number }> = {
    'src/games/base.ts': {
      why: 'the ghost skeleton — a ghost is meant to be faint',
      count: 1,
    },
    'src/engine/draw.ts': {
      why: 'an EMPTY leaderboard row — the kit’s dashed empty slot',
      count: 1,
    },
    'src/games/rhythm.ts': {
      why: 'grey dust particles on a missed note',
      count: 1,
    },
    'src/shell/menu.ts': {
      why: 'a feature-flagged-off tile and its shadow, which ARE disabled',
      count: 4,
    },
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
    const found = new Map<string, number>();
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
        const prev = lines.slice(Math.max(0, i - 8), i);
        if (!setsMutedText(line) && !isMutedInColourMap(line, prev)) continue;
        found.set(rel, (found.get(rel) ?? 0) + 1);
        if (rel in ALLOWED) continue;
        offenders.push(`${rel}:${i + 1}`);
      }
    }

    // An exempted file is allowed EXACTLY what it was exempted for.
    for (const [rel, { why, count }] of Object.entries(ALLOWED)) {
      const n = found.get(rel) ?? 0;
      assert.equal(
        n,
        count,
        n > count
          ? `${rel} has ${n} muted-text uses but is only exempted for ${count} ` +
            `(${why}). A new one has been added — fix it, or raise the count and ` +
            `say why.`
          : `${rel} has ${n} muted-text uses and is exempted for ${count}. The ` +
            `exemption is stale; lower the count or drop the entry.`
      );
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
    // A stale allowlist entry is permission nobody asked for. The count
    // assertion in the test above now catches that from both directions — too
    // many AND too few — so all this has to check is that the file still
    // exists to be exempted.
    return Promise.all(
      Object.keys(ALLOWED).map(async (rel) => {
        const { access } = await import('node:fs/promises');
        await access(rel);
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

      // AND THE SAME COLOUR BOUND TO A LOCAL, which is how it actually got in.
      //
      // The versus results screen drew the winning score as
      //
      //     const color = PLAYER_COLORS[slot]!;
      //     ...
      //     color: won ? color : COLORS.ink,
      //
      // and `PLAYER_COLORS[0]` is yellow. Sampled off the canvas, the glyphs of
      // a winning player-one score were 251,188,4 on paper — 1.7:1, on the most
      // celebrated number the app draws. The rule above never saw it, because
      // the literal is thirty lines away from the draw.
      //
      // The muted guard further down documents the identical blind spot and
      // leaves it open. This closes it for yellow: find the locals that hold a
      // possibly-yellow colour, then look for those NAMES in a draw's `color:`.
      const bound = new Map<string, number>();
      for (let i = 0; i < lines.length; i++) {
        const m = /\b(?:const|let)\s+(\w+)\s*=[^;]*?(PLAYER_COLORS|GAME_COLORS|gameColor\(|factionColor\(|COLORS\.yellow\b)/.exec(
          lines[i] ?? ''
        );
        if (m?.[1]) bound.set(m[1], i);
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const m = /\bcolor:\s*(.+)$/.exec(line);
        if (!m?.[1]) continue;
        if (line.includes('textColor(') || line.includes('playerTextStyle(')) continue;

        // Which of the tracked locals does this expression mention?
        const used = [...bound.keys()].find((name) =>
          new RegExp(`\\b${name}\\b`).test(m[1] as string)
        );
        if (!used) continue;
        // Only when the binding is ABOVE the use and reasonably close, so an
        // unrelated `color` in another function does not get blamed.
        const at = bound.get(used) ?? -1;
        if (at < 0 || at > i || i - at > 60) continue;

        const near = lines.slice(Math.max(0, i - 8), i).join('\n');
        if (!/\b(drawText|drawTabularNumber)\(/.test(near)) continue;

        offenders.push(`${rel}:${i + 1} (via local \`${used}\`)`);
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

/* ------------------------------------------------------------------ */
/* The DOM layer obeys the same kit                                    */
/* ------------------------------------------------------------------ */

/**
 * EVERY GUARD IN THIS FILE SCANS THE TYPESCRIPT, AND THE APP IS NOT ONLY CANVAS.
 *
 * The operator console, the rig check and the boot screen are real DOM with
 * real CSS, and `styles.css` sat outside every rule here. It went through the
 * whole paper conversion carrying five `color: var(--yellow)` rules — the
 * wordmark, the WARN chip's value, every section heading, and the highlight
 * that marks a tunable a previous marshal changed — all of them 1.7:1 on the
 * paper they now sit on, and one `color: var(--muted)` on the rig check's stat
 * labels at 1.88:1.
 *
 * Same rule, same reasoning, different file extension: yellow is a SURFACE.
 * `background: var(--yellow)` with ink on top is always available and is what
 * these became.
 */
describe('styles.css obeys the same colour rules as the canvas', () => {
  const css = async (): Promise<string[]> => {
    const { readFile } = await import('node:fs/promises');
    // `\r?\n`, not `\n`: this repo checks out CRLF on Windows, and a stray
    // carriage return left at the head of the NEXT line is enough to make
    // every `^`-anchored rule below silently match nothing.
    return (await readFile('src/styles.css', 'utf8')).split(/\r?\n/);
  };

  test('nothing sets TEXT in yellow', async () => {
    const bad = (await css())
      .map((line, i) => [i + 1, line.trim()] as const)
      .filter(([, l]) => /^color:\s*var\(--yellow\)/.test(l));
    assert.deepEqual(
      bad,
      [],
      'yellow is 1.7:1 on paper — use `background: var(--yellow)` with ink on top'
    );
  });

  test('nothing sets TEXT in muted', async () => {
    const bad = (await css())
      .map((line, i) => [i + 1, line.trim()] as const)
      .filter(([, l]) => /^color:\s*var\(--muted\)/.test(l));
    assert.deepEqual(bad, [], 'muted is 1.88:1 and means DISABLED — use --text-faint');
  });

  /**
   * The console was authored against a dark panel and converted to paper in
   * pieces. A white fill on a white surface is not a card, and a 14%-white
   * border is not an edge — on the BRACKET tab that meant ADD, the control the
   * tab is built around, had no edges at all.
   */
  test('no white-on-white fills or borders survive the paper conversion', async () => {
    const bad = (await css())
      .map((line, i) => [i + 1, line.trim()] as const)
      .filter(([, l]) => /^(background|border[^:]*):.*rgba\(255,\s*255,\s*255/.test(l));
    assert.deepEqual(bad, [], 'invisible against --paper');
  });

  /** DESIGN.md: shadows are hard and point straight down. No blur, anywhere. */
  test('no blurred effects', async () => {
    const bad = (await css())
      .map((line, i) => [i + 1, line.trim()] as const)
      .filter(([, l]) => /^(backdrop-filter|filter):.*blur\(/.test(l));
    assert.deepEqual(bad, []);
  });
});

/* ------------------------------------------------------------------ */
/* Text is measured in the font it is drawn in                         */
/* ------------------------------------------------------------------ */

/**
 * `fitText` AND `wrapText` TAKE THE FONT AS ARGUMENTS. `drawText` TAKES IT AS
 * OPTIONS. NOTHING MAKES THE TWO AGREE.
 *
 * A caller has to repeat the size, the weight, the family and the letter
 * spacing, and every one of the four is silent when it is wrong — the text
 * simply renders wider than the box it was measured against. Twelve call sites
 * had it wrong, including the widest tracking in the kit on the initials
 * winner headline, and one that measured in Archivo BLACK at display weight
 * while drawing in Archivo BOLD at body.
 *
 * It surfaced only because the typeface was fixed: every one of those numbers
 * had been tuned against Helvetica, which is narrower than Archivo, so the app
 * looked fine while being measured wrongly throughout.
 *
 * `drawText`'s `maxWidth` has nothing to repeat — it measures after the font
 * and the spacing are already on the context. So the rule is: if you are
 * fitting text that has letter spacing, use `maxWidth`.
 *
 * `fitText` itself stays, for the callers that need the NUMBER rather than a
 * draw (a layout that sizes a box around text, say). Those are fine as long as
 * they pass the spacing.
 */
describe('fitted text is measured the way it is drawn', () => {
  /**
   * Path check that does not depend on the platform separator.
   *
   * This was `file.endsWith(...)` against a `sep` constant that had been
   * escaped as if it were going into a regex, so on Windows it held four
   * backslashes and matched nothing. draw.ts was therefore never actually
   * skipped; the older guard survived only because draw.ts's own fitText
   * calls mention `letterSpacing` and were skipped by the content rule.
   *
   * A test whose exclusion silently does nothing is worse than no
   * exclusion, because it reads as deliberate.
   */
  const isDrawTs = (file: string): boolean =>
    file.split(/[\\/]/).join('/').endsWith('engine/draw.ts');
  const read = async (): Promise<Array<{ file: string; lines: string[] }>> => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(full)));
        else if (full.endsWith('.ts')) out.push(full);
      }
      return out;
    };
    const files = await walk('src');
    return Promise.all(
      files.map(async (file) => ({
        file,
        lines: (await readFile(file, 'utf8')).split(/\r?\n/),
      }))
    );
  };

  /**
   * EVERY `fitText` CALL STATES THE SPACING IT MEASURED AGAINST.
   *
   * The first version of this guard looked for `letterSpacing` within a few
   * lines of the call, and it was vacuous for the form that matters most:
   *
   *     let titleSize = vh(v, 3.6);
   *     for (const t of MENU_TILES) titleSize = Math.min(titleSize, fitText(...));
   *     // ...130 lines later...
   *     drawText(ctx, tile.title, cx, y, { size: titleSize, letterSpacing: TRACK.h2 });
   *
   * That is all seven menu tile titles, and no regex can follow the variable.
   * Proven vacuous by reverting the fix and watching the suite stay green.
   *
   * So the rule is mechanical instead: pass the argument, always, even when it
   * is `'0px'`. An author who has to type it has to look up what the draw
   * uses, which is the entire failure being guarded against. Three more real
   * cases fell out of this the moment it was enforced — the initials faction
   * line (drawn at TRACK.number) and both of the menu's labelPill badges
   * (labelPill defaults to TRACK.pill).
   *
   * Prefer `drawText`'s `maxWidth` where the size is used once. `fitText` is
   * for the cases that need the NUMBER: a size shared across several elements,
   * or a box measured around the text.
   */
  test('every fitText call says what spacing it measured against', async () => {
    const offenders: string[] = [];

    for (const { file, lines } of await read()) {
      if (isDrawTs(file)) continue; // the definition
      const text = lines.join('\n');
      let from = 0;
      for (;;) {
        const at = text.indexOf('fitText(', from);
        if (at === -1) break;
        from = at + 8;

        // Walk to the matching close paren so a multi-line call is one string.
        let depth = 0;
        let i = at + 'fitText'.length;
        for (; i < text.length; i++) {
          if (text[i] === '(') depth++;
          else if (text[i] === ')') {
            depth--;
            if (depth === 0) break;
          }
        }
        const call = text.slice(at, i + 1);
        if (/TRACK\.|'0px'|"0px"|letterSpacing/.test(call)) continue;

        const line = text.slice(0, at).split('\n').length;
        offenders.push(`${file}:${line}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "fitText's last argument is the letter spacing, and omitting it measures " +
        'the string narrower than it will be drawn. Pass what the draw uses — ' +
        "or `'0px'` if it genuinely uses none."
    );
  });

  /**
   * ONE TEXT-FITTING HELPER, AND IT LIVES IN draw.ts.
   *
   * `hover.ts` had grown its own `fitTextSize` — the same six lines as
   * `fitText`, with the same letterSpacing blind spot, and completely
   * invisible to the guard above because that scans for the NAME `fitText`.
   * Its two callers both drew with tracking it never measured.
   *
   * A duplicate of a function whose whole problem is "the caller has to
   * remember four things" is the worst possible thing to have two of, so the
   * rule is structural: the measuring and fitting primitives live in
   * `engine/draw.ts` and nowhere else. ARCHITECTURE.md already says draw.ts is
   * the drawing API; this makes it true rather than aspirational.
   */
  test('nothing outside engine/draw.ts defines a text-fitting helper', async () => {
    const offenders: string[] = [];
    for (const { file, lines } of await read()) {
      if (isDrawTs(file)) continue;
      lines.forEach((line, i) => {
        if (/export function (fit|measure)\w*(Text|Size|Number)\s*\(/.test(line)) {
          offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 60)}`);
        }
      });
    }
    assert.deepEqual(
      offenders,
      [],
      'text measuring and fitting belongs in engine/draw.ts — a second copy ' +
        'is a second place to forget the letter spacing'
    );
  });

  /**
   * The engine side of the same rule. If either helper loses its spacing
   * parameter the twelve call sites above go quietly wrong again, and the
   * guard above would still pass because it only looks at `fitText`.
   */
  test('the measurement helpers still accept letter spacing', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/engine/draw.ts', 'utf8');

    for (const fn of ['measureText', 'fitText', 'wrapText']) {
      const at = src.indexOf(`export function ${fn}(`);
      assert.ok(at > 0, `${fn} is gone`);
      const sig = src.slice(at, src.indexOf('{', src.indexOf(')', at)));
      assert.match(sig, /letterSpacing/, `${fn} no longer takes letterSpacing`);
    }

    assert.match(src, /maxWidth\?: number;/, 'drawText lost its maxWidth option');
  });
});


/**
 * THE OVERSCAN SAFE AREA WAS A CONSTANT NOTHING OBEYED.
 *
 * theme.ts: "TV overscan safe area, in vh, on every edge. Consumer TVs still
 * crop 3-5% of the signal and the stall will not get to choose the panel."
 * `SAFE` is 3.5 — and the HUD's own edge furniture was inset a bare 3.
 *
 * MEASURED at 1024x768 by recording every drawn string's extent against the
 * safe box: the round clock sat at x = 23 against a boundary of 27, and screen
 * shake — up to height x 0.035, which is 27px — carried it to 10. On a panel
 * that crops, the first digit of the round timer is what goes.
 *
 * Nothing anywhere checked `SAFE` was used. This is a source guard rather than
 * a rendered measurement because the values are vh literals in a draw call, and
 * a literal is exactly what went wrong.
 */
describe('the HUD respects the overscan safe area', () => {
  const hud = async (): Promise<string> => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/games/base.ts', 'utf8');
    return src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
  };

  test('the clock and the progress bar are inset by SAFE, not a literal', async () => {
    const code = await hud();
    // ANCHOR ON THE CLOCK, not on `progressBar(` — there are two calls and
    // indexOf finds the OTHER one, 1080 lines earlier. That is the third time
    // today a guard of mine read a different piece of code than I meant.
    const at = code.indexOf('this.timeLeft.toFixed(1)');
    assert.ok(at > 0, 'the HUD no longer draws a round clock');
    const span = code.slice(Math.max(0, at - 500), at + 200);
    assert.match(
      span,
      /const inset = vh\(v, SAFE\)/,
      'the HUD clock and bar are back on a hardcoded inset. SAFE is 3.5 and ' +
        'they were 3 — half a vh inside the boundary, before shake moves them'
    );
    assert.doesNotMatch(
      span,
      /progressBar\(\s*ctx,\s*vh\(v,\s*3\)/,
      'the progress bar starts inside the safe area again'
    );
  });

  test('and so does the chase line, which is flush to a slot edge', async () => {
    const code = await hud();
    const at = code.indexOf('const chaseX =');
    assert.ok(at > 0, 'the chase line no longer computes an x');
    assert.match(
      code.slice(at, at + 160),
      /vh\(v, SAFE\)/,
      'in a one-slot layout rect.width is the whole screen, so a 3vh inset ' +
        "puts the chase line's right edge past the overscan boundary"
    );
  });
});
