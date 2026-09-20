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

import { roundLog } from '../src/meta/roundlog.ts';
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
      if (/roundLog\.(all|exportJSON)\(/.test(src)) readers.push(rel);
    }

    assert.deepEqual(
      readers.filter((f) => f !== 'src/shell/operator.ts' && !f.startsWith('src/dev/')),
      [],
      'something outside the operator console reads the round log back. It is ' +
        'safe precisely because it is write-only to the app — see this note'
    );
  });
});
