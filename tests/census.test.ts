/**
 * EVERY BANNER IN THE SOURCE EITHER DRAWS, OR SAYS WHY IT DOES NOT.
 *
 * The most productive probe in this repo is `window.__arcade.census()`: run
 * the whole roster with `fillText` patched to COUNT instead of assert, then
 * read the ZEROES. A string that never draws is a mechanic nobody is testing,
 * and on the 20th that question found five real bugs in one sweep — a duck
 * input no harness had ever used, a `<MAX SPEED>` cap above anything a round
 * could reach, a combo clip keyed to a chain that does not occur, and two
 * strings a replay always covered. Every one of them had passing tests. The
 * tests exercised the mechanism; nothing asked whether the trigger fired.
 *
 * The weakness of that sweep is that it is manual, so its result is a thing
 * somebody remembers rather than a thing the suite knows. This test fixes
 * that. It derives every banner literal in `src/`, compares them against the
 * recorded census in `tests/fixtures/census.json`, and requires each one that
 * never drew to carry a REASON here.
 *
 * ── What that buys, concretely ───────────────────────────────────────────
 *
 * A new banner added to a game is in neither list, so this test FAILS until
 * somebody either re-sweeps and sees it draw, or writes down why it cannot.
 * That is the whole discipline the manual sweep had, made automatic, and it
 * also means a stale fixture cannot rot quietly: the next string anybody adds
 * trips it.
 *
 * ── Re-recording the fixture ─────────────────────────────────────────────
 *
 *   1. Open the preview with the pane VISIBLE. A hidden pane collapses the
 *      canvas to 0x0 and every dwell misses; `runTurn` now refuses up front
 *      and says so, because that failure reads exactly like a menu regression
 *      and cost about ten probes to identify.
 *   2. `await __arcade.censusReset()`, then `await __arcade.census([...])` two
 *      games at a time — a full roster exceeds the console's evaluation cap,
 *      and the counts accumulate across calls so batching is free.
 *   3. Do it TWICE: once on the board as it stands, once after
 *      `leaderboard.clearAll()`. See the note on `runs` below — this is not
 *      optional thoroughness, it is the difference between 24 unexplained
 *      strings and 19.
 *
 * ── Why the fixture records two runs ─────────────────────────────────────
 *
 * The first full sweep reported 24 never-drawn banners. Five of them —
 * `<INSTANT REPLAY>`, `<NEW BEST!>`, `<PICK A SIDE>`, `<RECORD>` and
 * `<SET THE FIRST SCORE>` — were not dead at all. They were MASKED by the
 * leaderboard: months of simulated sweeps had left 67 Speed's best at 185,
 * and the simulator scores about 183, so no record or first-score path could
 * ever be taken. Clearing the board drew four of the five from a single game.
 *
 * That is the trap worth remembering about this whole method: a census reads
 * the app IN THE STATE YOU LEFT IT, and persisted state silently removes
 * branches from the sweep. The union of a populated run and a cleared one is
 * the honest coverage figure.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Banners that never drew in the recorded census, each with the condition
 * that would draw it. An entry here is a claim that the string is REACHABLE
 * but not reachable BY THE SIMULATOR — not that it is dead code.
 */
const EXPECTED_ABSENT: Record<string, string> = {
  // ── Failure screens: need a real camera, vision or context failure ──────
  // All seven were verified by hand on the 20th, during the boot-contrast
  // fix — they were rendering ink-on-black at 1.11:1 because an opaque
  // canvas initialises to solid black. They draw; the sim just never fails.
  '<CAMERA ERROR>': 'camera getUserMedia rejects',
  '<CAMERA LOST — PRESS F5>': 'camera track ends and does not recover',
  '<CAMERA LOST — RECONNECTING>': 'camera track ends, retry in flight',
  '<INSECURE CONTEXT>': 'page served over plain http from a non-localhost host',
  '<STARTUP FAILED>': 'the boot sequence throws',
  '<TRY AGAIN>': 'shown beside a failure screen',
  '<VISION OFFLINE — PRESS F5>': 'the pose worker dies and does not restart',

  // ── Rig check: driven on the 20th, and it is live ───────────────────────
  // `router.go('rigcheck')` with a simulated body reaches the screen, reports
  // "LEGS CUT OFF" and offers the fix ("TILT THE LID BACK / RAISE THE
  // CAMERA"), and draws `<FULL BODY OK>` once the body frames. So the screen
  // works; these three are states the SIMULATOR cannot produce.
  //
  // `<T-POSE OK>` is the one that would matter if it were untested, because
  // it gates the marshal's setup. It is not: `TPoseDetector` has its own
  // block in gestures.test.ts, including the aspect correction that once made
  // the ring physically impossible to complete. The simulator drives joint
  // angles and cannot hold a convincing T-pose, which is why the BANNER never
  // draws while the mechanism behind it is covered.
  '<FULL BODY OK>': 'drawn when a simulated body frames; framing varies by sim position',
  '<T-POSE OK>': 'needs a held T-pose; the detector is covered in gestures.test.ts',
  '<STARTING CAMERA>': 'rig check while a real camera opens; sim starts already open',

  // ── Rare by construction, and deliberately so ───────────────────────────
  '<DEAD HEAT>': 'two players finish on exactly the same score',
  // Rare MECHANICALLY, not just in the sim: a chain is the fruit caught by
  // one swipe, and `spawn` emits one or two at a time (fruitninja.ts:677), so
  // a quad needs two whole waves to overlap in space and in flight. This is
  // why the combo CLIP was retuned down to a triple — its old threshold was
  // set to a chain that effectively never occurs, found by this same census.
  '<QUAD!>': 'a four-slice chain; spawn emits 1-2, so it needs two waves to overlap',
  '<FIVE!>': 'a five-slice chain; rarer still, for the same reason',

  // ── Needs a body to go missing, which the simulator never does ──────────
  '<FACE THE CAMERA>': 'an arm stops being seen mid-round',

  // ── Unreachable on THIS roster, and the reason here used to be wrong ─────
  // It said "no body at all during gathering", which sounds plausible and is
  // nothing to do with it. The gathering invite is chosen from CONFIG, not
  // from who is in frame: `maxPlayers > 2` gets "UP TO N PLAYERS" (Red Light,
  // 5 lanes), `supportsVersus` gets "1 OR 2 PLAYERS" (the other six), and
  // this is the fallback for a game that is neither. No game on the roster is
  // neither, so no body in any position can draw it.
  //
  // Kept rather than deleted: it is the else of a total function over config,
  // and a solo-only game added later needs an invite. If one is, this string
  // starts drawing and the "no reason survives the string starting to draw"
  // test below trips, which is the correct outcome.
  //
  // Worth noting how this was caught — the allowlist made me write a reason
  // down, and writing it down is what made it checkable.
  '<STEP INTO THE FRAME>': 'the config fallback; every game is versus or multi-seat',

  // ── Absent BECAUSE a fix works ──────────────────────────────────────────
  // `<WALL!>` fires on a wall HIT. Both drivers now duck, which is exactly
  // the fix the last census bought (`wallhit` 15 -> 0, Rhythm 1077 -> 1864).
  // If this string ever comes back, the duck has regressed.
  '<WALL!>': 'the runner hits a wall; both drivers duck, so zero is the goal',

  // ── The results rank line, covered by the replay stamp instead ──────────
  // `drawRankLine` has five outcomes and the sweep only ever takes the
  // near-miss one. Not a bug: at precisely that moment the instant replay
  // takes the screen, and its stamp draws the SAME WORDS unbracketed —
  // measured at 450 and 421 draws in the cleared-board run. The bracketed
  // literals here are the covered-up path, which is the documented decision.
  '<FIRST ON THE BOARD>': 'empty board at results; the replay stamp covers this moment',
  '<NEW RECORD>': 'a record at results; the replay stamp covers this moment',
  '<RECORD PACE>': 'mid-round, on pace to beat an existing best',
};

/**
 * Cues that never played in the recorded census, each with the condition that
 * would play it. Same rule as the banners: a cue nobody can reach is a
 * mechanic nobody is testing.
 *
 * This list exists because the census collected `audio.play` counts from the
 * first sweep and nothing ever read them. 18 of the 20 names in `SoundName`
 * played; the two that did not are both real and both explainable, and
 * finding that out took driving Red Light by hand.
 */
const EXPECTED_SILENT: Record<string, string> = {
  // Red Light's most dramatic moment, and the simulator is a PERFECT PLAYER:
  // it freezes on red, so nobody is ever caught. Driven by hand on the 20th
  // with a body that holds still and then moves only on red, it fired three
  // times for three racers, so the cue and the mechanic both work.
  eliminate: 'a racer caught moving on red; the sim freezes correctly and is never caught',
  // Absent BECAUSE a fix works, exactly like the `<WALL!>` banner: both
  // drivers duck now. If this starts playing, the duck has regressed.
  wallhit: 'the runner hits a wall; both drivers duck, so zero is the goal',
};

interface Census {
  drawn: string[];
  cues: string[];
  swept: string[];
  runs: { board: string; bracketed: string[] }[];
}

async function loadCensus(): Promise<Census> {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile('tests/fixtures/census.json', 'utf8')) as Census;
}

/**
 * Drop comment lines before scanning. The repo documents heavily, and its doc
 * comments quote banners as examples — `<LIKE THIS>`, `<PLAYER n AHEAD>`,
 * `<GOOD>`. Counting those as drawable strings adds phantom entries that can
 * never draw, which is the fastest way to make an allowlist meaningless.
 */
function codeLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
    })
    .join('\n');
}

async function walk(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    // `src/dev` is probe code. Its own doc comments and its `<all>` sentinel
    // are not things the app draws, and including them put three phantom
    // strings in the first version of this list.
    if (entry.isDirectory()) {
      if (entry.name !== 'dev') out.push(...(await walk(full)));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every banner literal in the app, with the files that hold it.
 *
 * THE RULE IS "SET IN CAPS", NOT A LIST. Banners are the arcade's headline
 * convention: `<ALL CAPS IN ANGLE BRACKETS>`. Deriving them from that shape
 * keeps DOM strings (`<video>`, `<code>`) and prose out without naming any of
 * them, which matters because an enumerated exclusion list is the thing that
 * goes stale the next time somebody adds a tag.
 *
 * Template-composed banners (`<STARTING IN ${n}>`, `<PLAYER ${i} AHEAD>`) are
 * skipped: there is no literal to compare against. The census still SEES them
 * at runtime — `<STARTING IN 1>` and `<PLAYER 2 AHEAD>` are both in the drawn
 * set — they simply cannot be checked from the source side.
 */
async function bannerLiterals(): Promise<Map<string, string[]>> {
  const { readFile } = await import('node:fs/promises');
  // The length bound was 40 in the first draft and silently dropped the two
  // longest banners in the game, including Rhythm's whole control legend.
  // Bounds on a scan window are where this repo keeps losing things.
  const pattern = /(['"`])(<[^<>]{1,120}>)\1/g;
  const found = new Map<string, string[]>();

  for (const file of await walk('src')) {
    const text = codeLines(await readFile(file, 'utf8'));
    for (const match of text.matchAll(pattern)) {
      const literal = match[2];
      const inner = literal.slice(1, -1);
      if (inner.includes('${')) continue;
      if (!/[A-Z]/.test(inner) || /[a-z]/.test(inner)) continue;
      const seen = found.get(literal) ?? [];
      if (!seen.includes(file)) seen.push(file);
      found.set(literal, seen);
    }
  }
  return found;
}

describe('every banner the source can draw is accounted for', () => {
  test('a banner either drew in the census or carries a reason', async () => {
    const census = await loadCensus();
    const drawn = new Set(census.drawn);
    const literals = await bannerLiterals();

    const unexplained: string[] = [];
    for (const [literal, files] of literals) {
      if (drawn.has(literal)) continue;
      if (EXPECTED_ABSENT[literal]) continue;
      unexplained.push(`${literal} (${files.join(', ')})`);
    }

    assert.deepEqual(
      unexplained,
      [],
      'These banners exist in src/ but never drew in the recorded census, and ' +
        'no reason is written down. Either re-record the fixture (see the ' +
        'header) and confirm they draw, or add them to EXPECTED_ABSENT with ' +
        'the condition that would draw them. A banner nobody can reach is a ' +
        'mechanic nobody is testing.\n  ' +
        unexplained.join('\n  '),
    );
  });

  test('no reason outlives the string it explains', async () => {
    const literals = await bannerLiterals();
    const stale = Object.keys(EXPECTED_ABSENT).filter((s) => !literals.has(s));
    assert.deepEqual(
      stale,
      [],
      'EXPECTED_ABSENT explains banners that are no longer in src/. Delete ' +
        'these entries; a reason for a string that does not exist is noise ' +
        'that makes the real entries harder to trust.',
    );
  });

  test('no reason survives the string starting to draw', async () => {
    const census = await loadCensus();
    const drawn = new Set(census.drawn);
    const obsolete = Object.keys(EXPECTED_ABSENT).filter((s) => drawn.has(s));
    assert.deepEqual(
      obsolete,
      [],
      'These banners now DO draw, so their reason is wrong. Remove them from ' +
        'EXPECTED_ABSENT. This matters most for `<WALL!>`: it draws on a wall ' +
        'hit, and it drawing again means the duck fix has regressed.',
    );
  });

  test('the fixture covers the whole roster, on both board states', async () => {
    const census = await loadCensus();
    // Derived from the census itself rather than a second hand-kept list: a
    // roster enumerated in a test is one more thing to forget to update when
    // an eighth game lands.
    assert.equal(census.swept.length, 7, 'the sweep must cover every game');

    const boards = census.runs.map((r) => r.board).sort();
    assert.deepEqual(
      boards,
      ['cleared', 'populated'],
      'The census needs BOTH a populated-board run and a cleared-board run. ' +
        'With only one, persisted scores hide whole branches: the first ' +
        'single-board sweep left five reachable banners looking dead.',
    );

    // The union is what the first test checks, so it must actually be a union.
    const union = new Set(census.runs.flatMap((r) => r.bracketed));
    for (const s of census.drawn) {
      assert.ok(union.has(s), `${s} is in drawn but in neither run`);
    }
  });

  /**
   * THE CUES, which the census counted from the beginning and nobody read.
   *
   * `SoundName` is the complete list of sounds the app can make. Derived from
   * the union type rather than listed here, so a new cue is checked without
   * anybody remembering to update this test.
   */
  test('every sound the app can make either played or says why not', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/engine/audio.ts', 'utf8');
    const union = /export type SoundName =([\s\S]*?);/.exec(src);
    assert.ok(union, 'SoundName is gone or no longer a union');

    const names = [...(union[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1] ?? '');
    assert.ok(names.length >= 15, 'the cue list stopped parsing');

    const census = await loadCensus();
    const played = new Set(census.cues);
    const unexplained = names.filter((n) => !played.has(n) && !EXPECTED_SILENT[n]);
    assert.deepEqual(
      unexplained,
      [],
      'These cues exist but never played in the recorded census and no reason ' +
        'is written down. A cue that cannot be reached is a mechanic nobody ' +
        'is testing — that is how the duck input was found missing.',
    );
  });

  test('no reason survives a cue starting to play', async () => {
    const census = await loadCensus();
    const played = new Set(census.cues);
    const obsolete = Object.keys(EXPECTED_SILENT).filter((c) => played.has(c));
    assert.deepEqual(
      obsolete,
      [],
      'These cues now play, so their reason is wrong. This matters most for ' +
        '`wallhit`: it fires on a wall HIT, and hearing it again means the ' +
        'duck fix has regressed.',
    );
  });

  test('and every silent cue is still a real sound', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/engine/audio.ts', 'utf8');
    for (const cue of Object.keys(EXPECTED_SILENT)) {
      assert.ok(
        src.includes(`case '${cue}'`),
        `${cue} is excused for never playing but has no implementation either, ` +
          'so the reason is covering for dead code',
      );
    }
  });
});
