/**
 * A WAY OFF THE INITIALS SCREEN WITHOUT TYPING A NAME — row 26 of FEEDBACK.md.
 *
 * Before it, the only two exits were typing three letters or standing still
 * through the 16-second deadline, in front of a queue, having already
 * finished playing. A player who does not care about the board now gets off
 * this screen in 0.95s instead of 16, which at a stall is a whole extra turn
 * every few players.
 *
 * The fix is one word: the confirm key reads SKIP while the entry is empty and
 * OK once there is something to confirm. Same key, same place, same single
 * dwell — the word just stops lying about what pressing it will do.
 *
 * It had no test. Found by mutating the ledger's string anchors: `'SKIP'`
 * could be replaced with anything and nothing failed but the check that
 * FEEDBACK.md still quotes it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { okKeyLabel } from '../src/shell/initials.ts';

describe('the initials screen can be left without typing a name', () => {
  test('the confirm key offers SKIP while nothing has been typed', () => {
    assert.equal(
      okKeyLabel('OK', 0),
      'SKIP',
      'an empty entry shows OK, which offers a player who wants to leave ' +
        'nothing but the 16s deadline'
    );
  });

  test('and becomes OK the moment there is something to confirm', () => {
    for (const typed of [1, 2, 3]) {
      assert.equal(
        okKeyLabel('OK', typed),
        'OK',
        `with ${typed} letters typed the key still says SKIP, which reads as ` +
          `"throw away what I just entered"`
      );
    }
  });

  /**
   * It is the SAME key, not an extra one. A second control is a second thing
   * to find and another target competing for the same dwell — and the grid is
   * A-Z plus DEL and OK precisely so nobody has to hunt.
   */
  test('and no other key changes its label', () => {
    for (const key of ['A', 'M', 'Z', 'DEL']) {
      assert.equal(
        okKeyLabel(key, 0),
        key,
        `${key} changes what it says when the entry is empty; only the confirm ` +
          `key is supposed to`
      );
    }
  });

  /**
   * The screen has to USE it. A pure helper nothing calls is a fix that only
   * exists in a test — which is the failure this whole sweep is about.
   */
  test('the screen renders its keys through that helper', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/shell/initials.ts', 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');

    assert.match(
      code,
      /okKeyLabel\(key, this\.letters\.length\)/,
      'the initials screen no longer labels its keys through okKeyLabel, so the ' +
        'tests above are about a function nothing calls'
    );
  });
});

/**
 * AND WHAT THAT EXIT MUST NOT DO: count as an entry time.
 *
 * The screen now records how long a name took to spell, so FEEDBACK.md's
 * initials row can finally be answered with a number instead of an
 * impression. The measurement is only worth having if it measures TYPING.
 * Fold in the 16s deadline and the skips and it reports that entries take
 * about sixteen seconds — which is the backstop's own duration, measured by
 * the players who never typed anything, arguing to keep the backstop that
 * produced the number.
 */
describe('only a real entry counts as an entry time', () => {
  const source = async (): Promise<string> => {
    const { readFile } = await import('node:fs/promises');
    return readFile('src/shell/initials.ts', 'utf8');
  };

  /**
   * DERIVED FROM THE SIGNATURE, not from a list kept here. A fifth reason
   * added to the union would otherwise pass this test while nothing checked
   * whether it should record — which is how the last six enumerated guards in
   * this repo went stale.
   */
  test('every exit states which kind of exit it is', async () => {
    const src = await source();
    const signature = /private finish\(reason: ([^)]+)\):/.exec(src);
    assert.ok(signature, 'finish() must take a named reason');

    const reasons = [...(signature[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    assert.ok(reasons.length >= 2, 'the union should hold every exit kind');

    const calls = [...src.matchAll(/this\.finish\(([^)]*)\)/g)].map((m) => m[1]?.trim() ?? '');
    assert.ok(calls.length >= 4, 'every exit path should be covered');
    for (const arg of calls) {
      assert.ok(
        reasons.some((r) => arg === `'${r}'`),
        `this.finish(${arg}) does not name a reason from the signature`,
      );
    }
  });

  test('the entry time is written only under the completed branch', async () => {
    const src = await source();
    const branch = /if \(reason === 'completed'(.*?)\) \{/.exec(src);
    assert.ok(branch, 'the completed branch must exist by that name');

    const calls = [...src.matchAll(/roundLog\.logInitials\(/g)];
    assert.equal(calls.length, 1, 'exactly one place should record an entry time');
    assert.ok(
      (calls[0]?.index ?? 0) > (branch.index ?? 0),
      'logInitials is called outside the completed branch, so timeouts and ' +
        'skips would be counted as typing times',
    );
  });

  /**
   * A `turn()` sweep dwells at a fixed cadence, so it logged fifteen entries
   * of exactly 5.8s — and the DATA tab then read its own p90 off them and
   * advised shrinking the 16s backstop. Confident, specific, and measured
   * entirely from a robot. The rehearsal is not in sim mode, so real bodies
   * still count.
   */
  test('a simulated entry is not a real one', async () => {
    const src = await source();
    const branch = /if \(reason === 'completed'(.*?)\) \{/.exec(src);
    assert.match(
      branch?.[1] ?? '',
      /isSimEnabled\(\)/,
      'the completed branch must also exclude simulated runs, or a sweep ' +
        'will argue for turning the backstop down on its own dwell speed',
    );
  });

  /**
   * The screen is the only writer. If a game starts logging entry times the
   * distribution stops being about this screen at all.
   */
  test('nothing else in the app records an entry time', async () => {
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

    const writers: string[] = [];
    for (const file of await walk('src')) {
      if (/\.logInitials\(/.test(await readFile(file, 'utf8'))) writers.push(file);
    }
    assert.deepEqual(writers, ['src/shell/initials.ts']);
  });
});
