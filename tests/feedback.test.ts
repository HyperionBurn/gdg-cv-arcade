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
    for (const tok of anchors.matchAll(/`([^`]+)`/g)) {
      const t = tok[1] ?? '';
      if (t.includes('/') && t.endsWith('.ts')) files.push(t);
      else snippets.push(t);
    }
    rows.push({ n: m[1] ?? '', report: m[2] ?? '', files, snippets });
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
      const bodies: string[] = [];
      for (const f of row.files) {
        try {
          bodies.push(await readFile(f, 'utf8'));
        } catch {
          bad.push(`row ${row.n}: ${f} does not exist`);
        }
      }
      for (const s of row.snippets) {
        if (!bodies.some((b) => b.includes(s))) {
          bad.push(`row ${row.n}: "${s}" is gone from ${row.files.join(', ')}`);
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
