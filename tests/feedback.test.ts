/**
 * THE ONLY INFORMATION IN THIS PROJECT THAT CANNOT BE RE-DERIVED.
 *
 * A measurement can be re-measured. A bug can be re-found by reading the code.
 * But "they had to 67 at a certain angle" is a sentence that existed for a few
 * seconds in a room, and the number it produced looks arbitrary to everyone who
 * reads it afterwards. Twenty-seven constants in this repo are only defensible
 * because somebody stood in front of the camera and said something.
 *
 * FEEDBACK.md is the ledger. These tests make it load-bearing:
 *
 *   1. Every fix named in the ledger still exists in the file it names.
 *   2. Every report quoted in the ledger is still quoted at the fix site, so
 *      the reasoning cannot be deleted and leave the constant looking magic.
 *   3. Every tester quote in `src/` is registered in the ledger. This is the
 *      one that makes "all tester feedback has been implemented" checkable:
 *      you cannot write a new report into a comment without filing it.
 *
 * Rule 3 needs an ignore list, because not every quoted sentence near the word
 * "playtest" is a report — some are UI strings, some are theories being
 * rejected. Each entry carries its reason. A short list is the point: if it
 * grows, rule 3 has stopped meaning anything.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Normalise for comparison: strip comment furniture, fold the several dash and
 * apostrophe characters this repo's prose actually uses into one each, and
 * collapse whitespace. A quote wrapped across three comment lines has to
 * compare equal to the same quote written on one line in a table cell.
 */
const norm = (s: string): string =>
  s
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/^\s*(\/\/+|\/\*+|\*+\/?)/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const readDoc = (): Promise<string> => readFile('FEEDBACK.md', 'utf8');

/** Every `.ts` under src/, recursively. */
async function srcFiles(dir = 'src'): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await srcFiles(p)));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

interface Row {
  n: string;
  report: string;
  files: string[];
  snippets: string[];
  /**
   * Each snippet tied to the file it was written against.
   *
   * The anchor column reads `` `file` · `snippet` ``, and TWO rows carry more
   * than one pair — row 12 spans redlight.ts and menu.ts, row 22 spans
   * rhythm.ts and tunables.ts. Keeping only two flat lists let a snippet be
   * satisfied by the OTHER file in the same row, so a fix could move to the
   * wrong place and the ledger would still read as honest. Row 12 is the menu
   * blurb regression, which has already come back once.
   */
  pairs: Array<{ file: string; snippet: string }>;
}

/** Parses the one pipe table whose header starts with `#`. */
async function ledger(): Promise<Row[]> {
  const md = await readDoc();
  const rows: Row[] = [];
  for (const line of md.split('\n')) {
    const m = /^\|\s*(\d+)\s*\|(.+)\|(.+)\|(.+)\|\s*$/.exec(line);
    if (!m) continue;
    const anchors = m[4] ?? '';
    const files: string[] = [];
    const snippets: string[] = [];
    const pairs: Array<{ file: string; snippet: string }> = [];
    // A file token opens a group; every snippet after it belongs to that file
    // until the next one. Order is the only thing tying them together, which is
    // why this walks the tokens rather than sorting them into two buckets.
    let current = '';
    for (const tok of anchors.matchAll(/`([^`]+)`/g)) {
      const t = tok[1] ?? '';
      if (t.includes('/') && t.endsWith('.ts')) {
        files.push(t);
        current = t;
      } else {
        snippets.push(t);
        if (current) pairs.push({ file: current, snippet: t });
      }
    }
    rows.push({ n: m[1] ?? '', report: m[2] ?? '', files, snippets, pairs });
  }
  return rows;
}

/**
 * Quoted spans in a file, keyed to whether a tester is being cited nearby.
 *
 * NORMALISE THE WHOLE FILE FIRST, then extract. A window-then-extract pass
 * starts mid-quote whenever the window boundary lands inside one, which pairs
 * the closing quote of one report with the opening quote of the next and
 * invents sentences nobody said. That produced four phantom reports on the
 * first run of this test.
 */
function testerQuotes(source: string): string[] {
  const flat = norm(source);
  const out: string[] = [];
  for (const m of flat.matchAll(/"([^"]{8,220})"/g)) {
    const q = (m[1] ?? '').trim();
    if (q.split(' ').length < 2) continue;
    const at = m.index ?? 0;
    const near = flat.slice(Math.max(0, at - 400), at + q.length + 400);
    if (/playtest|tester/.test(near)) out.push(q);
  }
  return out;
}

/**
 * Quoted text near a playtest mention that is NOT a report. Each needs a
 * reason, and the list must stay short enough to read.
 */
const NOT_A_REPORT: ReadonlyArray<readonly [string, string]> = [
  ['position is not the skill being tested here; timing is', 'the theory the report disproved, quoted so the reversal is legible'],
  ['scale.unit is the only correct denominator for a threshold', 'a rule cited from ARCHITECTURE.md, not something a tester said'],
  ['move on green', 'the on-screen instruction that CAUSED report 12, quoted as the defect'],
  ['too far', 'a two-word gloss of report 18, at the same fix site'],
  ['fair mode', 'the name given to the feature in report 24'],
  ['i cannot see your arm', 'an on-screen string the fix added'],
  ['your arm is down', 'an on-screen string the fix added'],
  ['stay where you are', 'prose describing what the new wording means'],
  ['pump your arms', 'prose describing what the new wording means'],
  ['arrest a moving body', 'prose describing what the red light does'],
  ['notice the doll turned', 'prose describing reaction time'],
  ['standing still', 'prose naming the state being calibrated'],
  ['how far did they move', 'prose contrasting two readings of the same signal'],
  ['how far did they move faster than 0.83 seconds', 'the same contrast, other half'],
  ['under 8 seconds total', 'a design target for initials entry, not a report'],
  ['text might be doubled', 'report 5, quoted at three separate fix sites'],
  ['be the first!', 'the on-screen string report 25 is about'],
  ['new record', 'an on-screen string'],
  ['instant replay is dead', 'a line from the known-gaps list, not a report'],
  ['recognise the light changed', 'prose naming the reaction being budgeted for'],
  ['stop a moving body', 'prose naming the second half of that budget'],
  ['hits + combo + accuracy', 'prose describing how Rhythm composes its score'],
  ['no keyboard, no mouse, no operator handoff', 'a rule cited from PLAN.md §6'],
  ["freezes too ' + 'fast", 'report 10, split across a string concatenation in a slider description'],
];

const ignored = (q: string): boolean =>
  NOT_A_REPORT.some(([text]) => norm(text) === q || q.includes(norm(text)));

describe('the tester-feedback ledger is honest', () => {
  test('every row names a file that exists and a fix that is still in it', async () => {
    const rows = await ledger();
    assert.ok(rows.length >= 20, `the ledger parsed ${rows.length} rows; it should have 27`);

    const bad: string[] = [];
    for (const row of rows) {
      if (row.files.length === 0) {
        bad.push(`row ${row.n}: no file in the anchor column`);
        continue;
      }
      const bodies = new Map<string, string>();
      for (const f of row.files) {
        try {
          bodies.set(f, await readFile(f, 'utf8'));
        } catch {
          bad.push(`row ${row.n}: ${f} does not exist`);
        }
      }
      // Every snippet against ITS OWN file. Checking against the union would
      // let a two-file row pass with the fix in the wrong one.
      if (row.snippets.length !== row.pairs.length) {
        bad.push(`row ${row.n}: a snippet appears before any file in the anchor column`);
      }
      for (const { file, snippet } of row.pairs) {
        const body = bodies.get(file);
        if (body === undefined) continue; // already reported as missing
        if (!body.includes(snippet)) {
          bad.push(`row ${row.n}: "${snippet}" is gone from ${file}`);
        }
      }
    }
    assert.deepEqual(bad, [], `the ledger describes fixes that are no longer there:\n  ${bad.join('\n  ')}`);
  });

  /**
   * The report has to survive next to the fix. A constant whose comment has
   * been tidied away is a constant the next person will "simplify".
   */
  test('every quoted report is still quoted at a fix site', async () => {
    const rows = await ledger();
    const all = norm((await Promise.all((await srcFiles()).map((f) => readFile(f, 'utf8')))).join('\n'));

    const lost: string[] = [];
    for (const row of rows) {
      const q = /"([^"]+)"/.exec(row.report);
      if (!q) continue; // rows 9, 15, 19, 26, 27 paraphrase; nothing to check
      const needle = norm(q[1] ?? '');
      if (needle.length >= 8 && !all.includes(needle)) {
        lost.push(`row ${row.n}: "${q[1]}"`);
      }
    }
    assert.deepEqual(
      lost,
      [],
      `these reports are in the ledger but no longer anywhere in src/, so the ` +
        `constants they justify now look arbitrary:\n  ${lost.join('\n  ')}`
    );
  });

  /**
   * THE ONE THAT MAKES THE CLAIM CHECKABLE.
   *
   * A tester quote written into a comment and never filed is feedback that was
   * heard, acted on once, and then lost — which is exactly how the six-player
   * Red Light comments survived the change to five.
   */
  test('no tester quote in src/ is missing from the ledger', async () => {
    // PER LINE, AND WITH NO MINIMUM LENGTH.
    //
    // Scanning the whole document with the same `{8,220}` bound the src scrape
    // uses desynchronises the pairing: a short quote fails the minimum, the
    // regex steps past its opening mark, and every pair after it is built from
    // one report's closing quote and the next one's opening quote. A single
    // `"fixed"` in the prose above the table silently unregistered eleven rows.
    // Per line keeps a wrapped quote from poisoning anything but itself.
    const registered: string[] = [];
    for (const line of (await readDoc()).split('\n')) {
      for (const m of norm(line).matchAll(/"([^"]+)"/g)) registered.push((m[1] ?? '').trim());
    }
    assert.ok(registered.length >= 20, 'FEEDBACK.md stopped quoting any reports at all');

    const unfiled = new Map<string, string>();
    for (const f of await srcFiles()) {
      for (const q of testerQuotes(await readFile(f, 'utf8'))) {
        if (ignored(q)) continue;
        // Either direction: the ledger may quote a longer or shorter form of
        // the same sentence than the comment does.
        if (registered.some((r) => r.includes(q) || q.includes(r))) continue;
        if (!unfiled.has(q)) unfiled.set(q, f);
      }
    }

    const lines = [...unfiled].map(([q, f]) => `${f}: "${q}"`);
    assert.deepEqual(
      lines,
      [],
      `tester feedback lives in a comment but is not in FEEDBACK.md. Add a row, ` +
        `or add it to NOT_A_REPORT with a reason:\n  ${lines.join('\n  ')}`
    );
  });

  /** The ignore list is the escape hatch; an unread escape hatch is a hole. */
  test('every ignored quote carries a reason and is still needed', () => {
    for (const [text, why] of NOT_A_REPORT) {
      assert.ok(why.length > 12, `"${text}" is ignored with no real reason`);
    }
    assert.ok(
      NOT_A_REPORT.length <= 24,
      `the ignore list is ${NOT_A_REPORT.length} long; past ~24 the completeness ` +
        `check has stopped meaning anything`
    );
  });
});


/**
 * A REPORT CAN BE FIXED IN ONE PLACE AND LEFT STANDING IN ANOTHER.
 *
 * Row 12 is "moving my arms like I'm running without running", and the defect
 * behind it was the INSTRUCTION: `MOVE ON GREEN` made testers walk, which
 * cannot work at a stall and rescales the torso unit every threshold in Red
 * Light divides by. `redlight.ts` was fixed — `<PUMP>`, and
 * "DON'T WALK — STAY PUT" — and the ledger's anchor pointed at that file and
 * passed.
 *
 * The MENU still said `MOVE ON GREEN, FREEZE ON RED`. That is where a stranger
 * reads what a game is BEFORE choosing it, so the rejected wording was still
 * the first thing anybody saw, and the ledger could not see it because it was
 * checking the file the fix landed in rather than the words on the screen.
 *
 * Found by measuring type SIZE across a sweep and reading what came back
 * smallest — the menu blurbs, at 1.42vh.
 */
describe('a rejected instruction does not survive somewhere else', () => {
  test('nothing player-facing tells anybody to MOVE ON GREEN', async () => {
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
    for (const f of await walk('src')) {
      const src = await readFile(f, 'utf8');
      // CODE ONLY. redlight.ts quotes the phrase in a comment explaining why
      // it is wrong, which is the opposite of the problem.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split(/\r?\n/)
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n');
      if (/MOVE ON GREEN/i.test(code)) offenders.push(f);
    }

    assert.deepEqual(
      offenders,
      [],
      `the wording the playtest rejected is back on screen in: ${offenders.join(', ')}. ` +
        `Testers read it and WALKED, which rescales the body every threshold in ` +
        `Red Light is measured against.`
    );
  });

  /** And the menu agrees with the game about what the player is asked to do. */
  test('the menu names the same motion the game does', async () => {
    const { readFile } = await import('node:fs/promises');
    // Comments stripped first: the note explaining this fix sits between the
    // id and the blurb and pushed the blurb outside the search window, so the
    // test failed with "Red Light has no menu blurb any more" on code that
    // was correct.
    const menu = (await readFile('src/shell/menu.ts', 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    const m = /id: 'redlight'[\s\S]{0,400}?blurb: '([^']+)'/.exec(menu);
    assert.ok(m, 'Red Light has no menu blurb any more');
    assert.match(
      m[1]!,
      /PUMP/,
      `the menu describes Red Light as "${m[1]}", which does not name the ` +
        `motion that scores. The game says PUMP; the menu is read first.`
    );
  });
});

/**
 * THE FOUR OWED ROWS NAME NUMBERS. THE NUMBERS HAVE TO EXIST.
 *
 * "Still owed to the next playtest" is a table of four questions, each with a
 * knob and a place the number comes from. Three of the four were instrumented
 * because they are countable inside a round; the fourth said lane holding was
 * "an identity question" with no counter, which was true until the tracker
 * grew one — a lane IS an identity, so a racer who stops holding theirs is a
 * reservation that expired.
 *
 * All four now claim to be recorded, and that claim is only worth the code
 * behind it. A rehearsal happens once. If the export is missing a field
 * nobody finds out until the numbers are being read on the train home, and
 * the answer is then "run the club fair again", which is not available.
 */
describe('the numbers the playtest table promises are actually written', () => {
  const owed = async (): Promise<string> => {
    const doc = await readDoc();
    const start = doc.indexOf('## Still owed to the next playtest');
    assert.ok(start > 0, 'the owed table is gone from FEEDBACK.md');
    const end = doc.indexOf('\n## ', start + 1);
    return doc.slice(start, end === -1 ? undefined : end);
  };

  /**
   * Derived from the table rather than listed here: a fifth row added later
   * gets checked without anybody remembering to update this test, which is
   * the failure mode every enumerated guard in this repo has already had.
   */
  test('every field the table names is written by the app', async () => {
    const section = await owed();
    const claimed = [...section.matchAll(/`([a-zA-Z][a-zA-Z0-9]*)`/g)]
      .map((m) => m[1] ?? '')
      // Knob names and file references are not fields. A field is something
      // the round log or an export actually carries, and those are the ones
      // written in the source as object keys.
      .filter((n) => !['TrackGenerator', 'pickKind', 'HARD_DEADLINE_SEC', 'idLost'].includes(n));
    assert.ok(claimed.length >= 6, 'the table stopped naming any fields');

    const { readdir, readFile } = await import('node:fs/promises');
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) out.push(...(await walk(full)));
        else if (e.name.endsWith('.ts')) out.push(full);
      }
      return out;
    };
    let src = '';
    for (const f of await walk('src')) src += await readFile(f, 'utf8');

    const missing = claimed.filter((name) => !src.includes(name));
    assert.deepEqual(
      missing,
      [],
      'FEEDBACK.md promises these fields in the playtest export and nothing in ' +
        'src/ writes them. A rehearsal happens once.',
    );
  });

  /**
   * The identity numbers are added centrally in `logRound`, not by each game's
   * `roundDetail`, precisely so no game can forget them. If that call goes,
   * every row silently loses the Red Light answer while the table still
   * claims it.
   */
  test('identity counts are folded in for every game, not per game', async () => {
    const { readFile } = await import('node:fs/promises');
    const base = await readFile('src/games/base.ts', 'utf8');
    assert.match(
      base,
      /identityStats\(\)/,
      'base.ts no longer asks the tracker for identity counts, so no round row has them',
    );
    for (const key of ['idReserved', 'idReclaimed', 'idLost']) {
      assert.ok(base.includes(key), `${key} is promised by FEEDBACK.md and no longer written`);
    }
  });
});
