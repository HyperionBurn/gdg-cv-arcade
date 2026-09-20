/**
 * THE PLAYTEST HAS TO PRODUCE NUMBERS, AND NOTHING WAS RECORDING ANY.
 *
 * FEEDBACK.md's "Still owed to the next playtest" table has four open rows and
 * each one names the number to watch. The three exports a marshal can take off
 * the stall — scores, tuning, bracket — carry only what a round ENDED on, so
 * every one of those questions would have been answered by impression.
 *
 * The Runner row is the one that matters most, because it is not an opinion
 * question but a ship decision: "Under ~60%, weight them to near zero and ship
 * lanes + slides." Nobody counts hit rate by obstacle kind by eye while
 * running a queue.
 *
 * These guards are about the log being HARMLESS as much as correct. It is
 * written at the end of a round, on the machine that is running the stall, and
 * the failure that would matter is a diagnostic taking a turn down with it.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { roundLog, parseStored } from '../src/meta/roundlog.ts';
import type { RoundRecord } from '../src/meta/roundlog.ts';

const row = (over: Partial<RoundRecord> = {}): RoundRecord => ({
  at: 1_758_000_000_000,
  game: 'runner',
  players: 1,
  score: 640,
  seconds: 60,
  ...over,
});

describe('the round log', () => {
  beforeEach(() => {
    roundLog.clear();
  });

  test('records a round and reads it back', () => {
    roundLog.add(row({ detail: { lowFaced: 9, lowHit: 4 } }));
    const all = roundLog.all();
    assert.equal(all.length, 1);
    assert.equal(all[0]?.game, 'runner');
    assert.deepEqual(all[0]?.detail, { lowFaced: 9, lowHit: 4 });
  });

  /**
   * The whole point. A hit rate needs a denominator, and it has to survive
   * being written, stored and read back as JSON.
   */
  test('the Runner question is answerable from an export', () => {
    for (const [faced, hit] of [
      [9, 4],
      [11, 7],
      [10, 3],
    ] as const) {
      roundLog.add(row({ detail: { lowFaced: faced, lowHit: hit } }));
    }

    const parsed = JSON.parse(roundLog.exportJSON()) as { rounds: RoundRecord[] };
    const runner = parsed.rounds.filter((r) => r.game === 'runner');
    const faced = runner.reduce((n, r) => n + (r.detail?.lowFaced ?? 0), 0);
    const hit = runner.reduce((n, r) => n + (r.detail?.lowHit ?? 0), 0);

    assert.equal(faced, 30);
    assert.equal(hit, 14);
    // The number FEEDBACK.md asks for: clear rate on jump obstacles.
    assert.equal(Math.round(((faced - hit) / faced) * 100), 53);
  });

  /**
   * A diagnostic must never be able to end a turn. Every one of these is
   * something a half-written game hook could hand it.
   */
  test('junk is dropped rather than thrown', () => {
    const junk = [
      row({ at: NaN }),
      row({ score: Infinity }),
      row({ seconds: NaN }),
      row({ players: NaN }),
      { ...row(), game: '' } as RoundRecord,
      null as unknown as RoundRecord,
      undefined as unknown as RoundRecord,
      'nonsense' as unknown as RoundRecord,
    ];
    for (const j of junk) {
      assert.doesNotThrow(() => roundLog.add(j));
    }
    assert.equal(roundLog.count(), 0, 'a malformed record reached the log');
  });

  test('a non-numeric detail value is dropped without losing the row', () => {
    roundLog.add(row({ detail: { good: 3, bad: 'x' as unknown as number, worse: NaN } }));
    assert.equal(roundLog.count(), 1, 'the whole round was thrown away over one bad counter');
    assert.deepEqual(roundLog.all()[0]?.detail, { good: 3 });
  });

  /**
   * Oldest out, not newest refused. A log that stops recording halfway through
   * the afternoon fails in the direction nobody checks, and the interesting
   * rounds are the ones nearest the question being asked.
   */
  test('it drops the oldest round rather than refusing new ones', () => {
    for (let i = 0; i < 1005; i++) roundLog.add(row({ score: i }));
    assert.equal(roundLog.count(), 1000, 'the cap is not being enforced');
    assert.equal(roundLog.all()[0]?.score, 5, 'it dropped from the wrong end');
    assert.equal(roundLog.all()[999]?.score, 1004, 'it stopped accepting new rounds');
  });

  test('countsByGame gives the operator console something to show', () => {
    roundLog.add(row({ game: 'runner' }));
    roundLog.add(row({ game: 'runner' }));
    roundLog.add(row({ game: 'posematch' }));
    assert.deepEqual(roundLog.countsByGame(), [
      { game: 'runner', rounds: 2 },
      { game: 'posematch', rounds: 1 },
    ]);
  });

  /**
   * ONE-WAY BY CONSTRUCTION.
   *
   * The reason this was safe to add four days from the event is that nothing
   * in the app reads it back — no ranking, no tuning, no gameplay decision. A
   * counter nothing consumes cannot change how anything plays. If an import
   * ever appears outside the console and the dev harness, that property is
   * gone and this stops being a free change.
   */
  test('nothing in the app consumes the log', async () => {
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

    const readers: string[] = [];
    for (const file of await walk('src')) {
      const rel = file.split(/[\\/]/).join('/');
      if (rel === 'src/meta/roundlog.ts') continue;
      const src = await readFile(file, 'utf8');
      if (!/roundLog\./.test(src)) continue;
      // Writing and counting are fine anywhere. Reading the ROWS back is what
      // would make this an input to something.
      if (/roundLog\.(all|exportJSON|initialsStats)\(/.test(src)) readers.push(rel);
    }

    assert.deepEqual(
      readers.filter((f) => f !== 'src/shell/operator.ts' && !f.startsWith('src/dev/')),
      [],
      'something outside the operator console reads the round log back. It is ' +
        'safe precisely because it is write-only to the app — see this note'
    );
  });
});

/**
 * INITIALS ENTRY TIMES, which share this store rather than starting a new one.
 *
 * FEEDBACK.md's initials row asks one question — can the 16s
 * `HARD_DEADLINE_SEC` backstop shrink — and said the number was "not recorded"
 * because initials is a screen and never passes through the round hook. That
 * is a fact about the hook, not about whether the number can be had, and
 * "somebody at the stall can watch for it" is not a plan for a person who is
 * also running the queue.
 */
describe('initials entry times', () => {
  beforeEach(() => {
    roundLog.clear();
  });

  test('reports the shape of real entry times', () => {
    for (const t of [3, 4, 5, 6, 7, 8, 9, 10, 11, 15]) roundLog.logInitials(t);
    const stats = roundLog.initialsStats();
    assert.equal(stats?.count, 10);
    assert.equal(stats?.median, 8);
    assert.equal(stats?.p90, 15);
    assert.equal(stats?.max, 15);
  });

  /**
   * p90 is the one the backstop turns on, and it is the reason a mean would
   * be the wrong summary: nine fast entries and one slow one is exactly the
   * distribution that a mean says is fine and a queue does not.
   */
  test('one slow entry moves p90 and barely moves the median', () => {
    for (const t of [4, 4, 5, 5, 5, 6, 6, 6, 7]) roundLog.logInitials(t);
    const fast = roundLog.initialsStats();
    roundLog.logInitials(15.4);
    const slow = roundLog.initialsStats();

    // p90 lands ON the slow entry: one straggler in ten is exactly what the
    // backstop is sized for, and it shows up here at full value.
    assert.equal(slow?.p90, 15.4);
    // The median stays inside the fast cluster. It shifts by a second because
    // `at()` takes the upper of the two middles on an even count — worth
    // knowing before reading these numbers, and far less than p90's 8.4s jump.
    assert.ok((slow?.median ?? 0) <= 6, 'the median stays with the fast majority');
    assert.ok(
      (slow?.p90 ?? 0) - (fast?.p90 ?? 0) > (slow?.median ?? 0) - (fast?.median ?? 0),
      'p90 must move further than the median, or it is not measuring stragglers',
    );
  });

  test('nothing to report is null, not a zero', () => {
    // A zeroed row reads as "entries take 0s", which would argue for deleting
    // the backstop on the strength of no data at all.
    assert.equal(roundLog.initialsStats(), null);
  });

  test('refuses times that are not times', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 121]) {
      roundLog.logInitials(bad as number);
    }
    assert.equal(roundLog.initialsStats(), null);
  });

  test('the export carries them next to the rounds', () => {
    roundLog.add(row());
    roundLog.logInitials(6.2);
    const parsed = JSON.parse(roundLog.exportJSON()) as {
      rounds: unknown[];
      initialsSeconds: number[];
    };
    assert.equal(parsed.rounds.length, 1);
    assert.deepEqual(parsed.initialsSeconds, [6.2]);
  });
});

/**
 * THE MIGRATION, WHICH PROTECTS DATA THAT IS ALREADY ON THE STALL LAPTOP.
 *
 * This key held a bare array of rounds until entry times joined it. Reading
 * only the new shape would drop every round recorded before the change, in
 * silence, which is the exact failure the store was written to prevent.
 */
describe('reading what is already stored', () => {
  test('a bare array from the old shape still loads its rounds', () => {
    const legacy = JSON.stringify([row(), row({ game: 'rhythm' })]);
    const { rows, initials } = parseStored(legacy);
    assert.equal(rows.length, 2);
    assert.equal(rows[1]?.game, 'rhythm');
    assert.deepEqual(initials, [], 'the old shape carried no entry times');
  });

  test('the new shape loads both halves', () => {
    const stored = JSON.stringify({ rounds: [row()], initials: [4.1, 9.3] });
    const { rows, initials } = parseStored(stored);
    assert.equal(rows.length, 1);
    assert.deepEqual(initials, [4.1, 9.3]);
  });

  test('a corrupt store costs the log, not the boot', () => {
    for (const raw of ['', 'not json', '{"rounds":7}', 'null']) {
      const out = parseStored(raw);
      assert.deepEqual(out, { rows: [], initials: [] }, raw);
    }
  });

  test('a junk entry time is dropped without taking the rounds with it', () => {
    const stored = JSON.stringify({
      rounds: [row()],
      initials: [5, 'nine', null, 1e9, -3, 8],
    });
    const { rows, initials } = parseStored(stored);
    assert.equal(rows.length, 1, 'the rounds must survive a bad entry time');
    assert.deepEqual(initials, [5, 8]);
  });
});
