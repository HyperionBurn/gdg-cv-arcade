/**
 * Unit tests for the live bracket.
 *
 * Pure logic, no DOM, so it runs in Node directly:
 *   npm test
 *
 * Worth having as real tests rather than a browser poke: PLAN.md §4 schedules
 * the bracket as an announced event ("bracket at 2pm") in front of a crowd.
 * A bye in the wrong slot or a winner advancing to the wrong side is not
 * recoverable by restarting the app — someone has already been told they lost
 * to a person they never played.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Match } from '../src/meta/tournament.ts';

/* ------------------------------------------------------------------ *
 * Extensionless-import shim.
 *
 * Node 24 strips TS types natively but still resolves like plain ESM, where
 * `import './theme'` is not a module. The whole of src/ is written for Vite and
 * omits extensions, so the choice is between rewriting thirty source files to
 * suit the test runner, or teaching the test runner to resolve the way Vite
 * does. This is fifteen lines and touches nothing outside tests/.
 *
 * Hooks must be installed before the modules under test load, which is why the
 * import below is dynamic — static imports are hoisted above this call.
 * ------------------------------------------------------------------ */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      try {
        const resolved = fileURLToPath(new URL(specifier, context.parentURL));
        if (existsSync(`${resolved}.ts`)) return next(`${specifier}.ts`, context);
      } catch {
        /* fall through to the default resolver */
      }
    }
    return next(specifier, context);
  },
});

const {
  Tournament,
  bracketSize,
  seedOrder,
  buildMatches,
  resolveByes,
  applyResult,
  clearResult,
  nextPlayable,
  isBracketComplete,
  championId,
  roundName,
  normaliseInitials,
} = await import('../src/meta/tournament.ts');

type TournamentInstance = InstanceType<typeof Tournament>;

/* ------------------------------------------------------------------ *
 * A localStorage stand-in, so persistence is actually exercised.
 * ------------------------------------------------------------------ */

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
}

const g = globalThis as unknown as { localStorage?: MemoryStorage };
g.localStorage = new MemoryStorage();

function ids(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}

function rounds(matches: readonly Match[]): number {
  return matches.length ? matches[matches.length - 1]!.round + 1 : 0;
}

function countByes(matches: readonly Match[]): number {
  return matches.reduce(
    (n, m) => n + (m.slots[0].kind === 'bye' ? 1 : 0) + (m.slots[1].kind === 'bye' ? 1 : 0),
    0
  );
}

/* ------------------------------------------------------------------ *
 * Shape
 * ------------------------------------------------------------------ */

describe('bracketSize', () => {
  test('rounds up to the next power of two, minimum 2', () => {
    assert.equal(bracketSize(1), 2);
    assert.equal(bracketSize(2), 2);
    assert.equal(bracketSize(3), 4);
    assert.equal(bracketSize(5), 8);
    assert.equal(bracketSize(8), 8);
    assert.equal(bracketSize(9), 16);
    assert.equal(bracketSize(11), 16);
    assert.equal(bracketSize(32), 32);
  });
});

describe('seedOrder', () => {
  test('matches the standard 8-bracket', () => {
    assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  });

  test('matches the standard 4- and 16-brackets', () => {
    assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
    assert.deepEqual(
      seedOrder(16),
      [1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]
    );
  });

  test('every pair sums to size + 1 — the invariant byes depend on', () => {
    for (const size of [2, 4, 8, 16, 32]) {
      const o = seedOrder(size);
      assert.equal(o.length, size);
      assert.equal(new Set(o).size, size, `size ${size} repeated a seed`);
      for (let i = 0; i < size; i += 2) {
        assert.equal(o[i]! + o[i + 1]!, size + 1, `size ${size} pair ${i / 2}`);
      }
      // The weaker seed is always second, so a bye can only land in slot 1.
      for (let i = 0; i < size; i += 2) assert.ok(o[i]! < o[i + 1]!);
    }
  });
});

describe('bracket shape', () => {
  const cases: Array<{ n: number; size: number; rounds: number; byes: number; r0: number }> = [
    { n: 2, size: 2, rounds: 1, byes: 0, r0: 1 },
    { n: 3, size: 4, rounds: 2, byes: 1, r0: 2 },
    { n: 5, size: 8, rounds: 3, byes: 3, r0: 4 },
    { n: 8, size: 8, rounds: 3, byes: 0, r0: 4 },
    { n: 11, size: 16, rounds: 4, byes: 5, r0: 8 },
  ];

  for (const c of cases) {
    test(`${c.n} players -> ${c.size}-slot bracket, ${c.rounds} rounds, ${c.byes} byes`, () => {
      const m = buildMatches(ids(c.n));
      assert.equal(m.length, c.size - 1, 'a single-elim bracket has size-1 matches');
      assert.equal(rounds(m), c.rounds);
      assert.equal(countByes(m), c.byes);
      assert.equal(m.filter((x) => x.round === 0).length, c.r0);
      assert.equal(m.filter((x) => x.round === c.rounds - 1).length, 1, 'exactly one final');
    });

    test(`${c.n} players: every entrant appears exactly once in round 0`, () => {
      const m = buildMatches(ids(c.n));
      const seen = new Set<number>();
      for (const match of m) {
        if (match.round !== 0) continue;
        for (const s of match.slots) {
          if (s.kind !== 'player') continue;
          assert.ok(!seen.has(s.playerId), `player ${s.playerId} appears twice`);
          seen.add(s.playerId);
        }
      }
      assert.equal(seen.size, c.n);
    });
  }

  test('rejects an empty entry list without throwing', () => {
    assert.deepEqual(buildMatches([]), []);
  });
});

/* ------------------------------------------------------------------ *
 * Byes
 * ------------------------------------------------------------------ */

describe('byes', () => {
  test('always sit in slot 1, never slot 0 — a BYE on the left reads as a bug', () => {
    for (const n of [3, 5, 6, 7, 9, 11, 13, 15, 17, 23, 31]) {
      const m = buildMatches(ids(n));
      for (const match of m) {
        assert.notEqual(match.slots[0].kind, 'bye', `n=${n} put a bye in slot 0`);
      }
    }
  });

  test('two byes never meet each other', () => {
    for (let n = 2; n <= 64; n++) {
      const m = buildMatches(ids(n));
      for (const match of m) {
        assert.ok(
          !(match.slots[0].kind === 'bye' && match.slots[1].kind === 'bye'),
          `n=${n} paired two byes`
        );
      }
    }
  });

  test('go to the top seeds, in seed order', () => {
    // n=5 in an 8-bracket: seeds 1, 2 and 3 sit out round 1.
    const m = buildMatches(ids(5));
    resolveByes(m);
    const autoWinners = m
      .filter((x) => x.round === 0 && x.auto)
      .map((x) => {
        const s = x.slots[x.winner!];
        return s.kind === 'player' ? s.playerId : -1;
      })
      .sort((a, b) => a - b);
    assert.deepEqual(autoWinners, [1, 2, 3]);
  });

  test('count is exactly size - players for every count up to 64', () => {
    for (let n = 2; n <= 64; n++) {
      assert.equal(countByes(buildMatches(ids(n))), bracketSize(n) - n, `n=${n}`);
    }
  });

  test('auto-advance puts the bye-holder into the right round-1 slot', () => {
    // 3 players: seed 1 byes through, meets the winner of 2 v 3 in the final.
    const m = buildMatches(ids(3));
    resolveByes(m);
    const final = m[m.length - 1]!;
    assert.deepEqual(final.slots[0], { kind: 'player', playerId: 1 });
    assert.equal(final.slots[1].kind, 'pending');
    assert.equal(final.winner, null, 'a bye must not decide the final');
  });

  test('a bye is marked auto and is not counted as a played match', () => {
    const m = buildMatches(ids(3));
    resolveByes(m);
    const autos = m.filter((x) => x.auto);
    assert.equal(autos.length, 1);
    assert.equal(autos[0]!.at, null);
  });

  test('two bye-holders can meet immediately in round 1 (n=5)', () => {
    const m = buildMatches(ids(5));
    resolveByes(m);
    // Seeds 2 and 3 both had byes, so their round-1 match is playable at once.
    const ready = m.filter((x) => x.round === 1 && x.slots.every((s) => s.kind === 'player'));
    assert.equal(ready.length, 1);
    const pair = ready[0]!.slots.map((s) => (s.kind === 'player' ? s.playerId : -1)).sort();
    assert.deepEqual(pair, [2, 3]);
  });
});

/* ------------------------------------------------------------------ *
 * Advancement
 * ------------------------------------------------------------------ */

describe('advancement', () => {
  test('a round-0 winner lands in the correct round-1 slot', () => {
    const m = buildMatches(ids(8));
    resolveByes(m);
    // Round 0 match 0 feeds slot 0 of round 1 match 0; match 1 feeds slot 1.
    assert.ok(applyResult(m, m[0]!.id, 1)); // lower slot wins
    const r1 = m.find((x) => x.round === 1 && x.indexInRound === 0)!;
    assert.deepEqual(r1.slots[0], m[0]!.slots[1]);
    assert.equal(r1.slots[1].kind, 'pending');

    assert.ok(applyResult(m, m[1]!.id, 0));
    assert.deepEqual(r1.slots[1], m[1]!.slots[0]);
  });

  test('odd round-0 matches feed slot 1, even feed slot 0, all the way up', () => {
    const m = buildMatches(ids(16));
    resolveByes(m);
    for (const match of m) {
      if (match.feedsMatch === null) continue;
      assert.equal(match.feedsSlot, match.indexInRound % 2);
      const target = m.find((x) => x.id === match.feedsMatch)!;
      assert.equal(target.round, match.round + 1);
      assert.equal(target.indexInRound, Math.floor(match.indexInRound / 2));
    }
  });

  test('a match is not playable until both feeders have resolved', () => {
    const m = buildMatches(ids(8));
    resolveByes(m);
    const r1 = m.find((x) => x.round === 1)!;
    assert.equal(applyResult(m, r1.id, 0), false, 'reported a result on a pending match');
    assert.equal(r1.winner, null);
  });

  test('reporting the same match twice is rejected', () => {
    const m = buildMatches(ids(4));
    resolveByes(m);
    assert.ok(applyResult(m, m[0]!.id, 0));
    assert.equal(applyResult(m, m[0]!.id, 1), false);
    assert.equal(m[0]!.winner, 0, 'the first result must stand');
  });

  test('nextPlayable walks the bracket in order', () => {
    const m = buildMatches(ids(4));
    resolveByes(m);
    assert.equal(nextPlayable(m)!.id, m[0]!.id);
    applyResult(m, m[0]!.id, 0);
    assert.equal(nextPlayable(m)!.id, m[1]!.id);
    applyResult(m, m[1]!.id, 0);
    assert.equal(nextPlayable(m)!.id, m[2]!.id, 'the final becomes playable');
  });

  test('seed 1 wins out and is the champion, for 2/3/5/8/11', () => {
    for (const n of [2, 3, 5, 8, 11]) {
      const m = buildMatches(ids(n));
      resolveByes(m);
      let guard = 0;
      while (!isBracketComplete(m) && guard++ < 100) {
        const next = nextPlayable(m)!;
        const a = next.slots[0];
        const b = next.slots[1];
        const pa = a.kind === 'player' ? a.playerId : Infinity;
        const pb = b.kind === 'player' ? b.playerId : Infinity;
        applyResult(m, next.id, pa < pb ? 0 : 1); // lower id = better seed
      }
      assert.ok(isBracketComplete(m), `n=${n} never completed`);
      assert.equal(championId(m), 1, `n=${n} crowned the wrong player`);
    }
  });

  test('completion needs exactly n - 1 played matches (byes are free)', () => {
    for (const n of [2, 3, 5, 8, 11, 17, 32]) {
      const m = buildMatches(ids(n));
      resolveByes(m);
      let played = 0;
      let guard = 0;
      while (!isBracketComplete(m) && guard++ < 200) {
        applyResult(m, nextPlayable(m)!.id, 0);
        played++;
      }
      assert.equal(played, n - 1, `n=${n} played ${played}`);
    }
  });

  test('isBracketComplete is false until the final is reported', () => {
    const m = buildMatches(ids(4));
    resolveByes(m);
    applyResult(m, m[0]!.id, 0);
    applyResult(m, m[1]!.id, 0);
    assert.equal(isBracketComplete(m), false);
    assert.equal(championId(m), null);
    // seedOrder(4) is [1,4,2,3], so the final is seed 1 v seed 2 and slot 1 is
    // player 2 — the bracket must never hand the title to the other side.
    applyResult(m, m[2]!.id, 1);
    assert.equal(isBracketComplete(m), true);
    assert.equal(championId(m), 2);
  });

  test('a 1-player bracket completes immediately on the bye', () => {
    const m = buildMatches(ids(1));
    resolveByes(m);
    assert.equal(isBracketComplete(m), true);
    assert.equal(championId(m), 1);
  });
});

/* ------------------------------------------------------------------ *
 * Undo
 * ------------------------------------------------------------------ */

describe('clearResult', () => {
  test('undoes a result and everything downstream of it', () => {
    const m = buildMatches(ids(4));
    resolveByes(m);
    applyResult(m, m[0]!.id, 0);
    applyResult(m, m[1]!.id, 0);
    applyResult(m, m[2]!.id, 0);
    assert.equal(championId(m), 1);

    assert.ok(clearResult(m, m[0]!.id));
    assert.equal(m[0]!.winner, null);
    assert.equal(m[2]!.winner, null, 'the final must be undone too');
    assert.equal(m[2]!.slots[0].kind, 'pending');
    assert.equal(m[2]!.slots[1].kind, 'player', 'the untouched side must survive');
    assert.equal(isBracketComplete(m), false);
  });

  test('refuses to undo an auto-advanced bye', () => {
    const m = buildMatches(ids(3));
    resolveByes(m);
    const bye = m.find((x) => x.auto)!;
    assert.equal(clearResult(m, bye.id), false);
    assert.equal(bye.winner, 0);
  });

  test('the bracket is replayable after an undo', () => {
    const m = buildMatches(ids(4));
    resolveByes(m);
    applyResult(m, m[0]!.id, 0);
    clearResult(m, m[0]!.id);
    assert.ok(applyResult(m, m[0]!.id, 1));
    assert.equal(m[0]!.winner, 1);
  });
});

/* ------------------------------------------------------------------ *
 * Naming
 * ------------------------------------------------------------------ */

describe('roundName', () => {
  test('names the last three rounds from the end', () => {
    assert.equal(roundName(3, 4), 'FINAL');
    assert.equal(roundName(2, 4), 'SEMI-FINAL');
    assert.equal(roundName(1, 4), 'QUARTER-FINAL');
    assert.equal(roundName(0, 4), 'ROUND 1');
    assert.equal(roundName(0, 1), 'FINAL');
  });
});

describe('normaliseInitials', () => {
  test('always yields exactly three glyphs', () => {
    for (const raw of ['ab', 'a', '', 'abcd', 'a b', '!!!', 'xyz']) {
      assert.equal(normaliseInitials(raw).length, 3, `"${raw}"`);
    }
  });

  test('matches the leaderboard rules', () => {
    assert.equal(normaliseInitials('ab'), 'AB-');
    assert.equal(normaliseInitials(''), 'AAA');
    assert.equal(normaliseInitials('a-b-c-d'), 'ABC');
  });
});

/* ------------------------------------------------------------------ *
 * The live tournament + persistence
 * ------------------------------------------------------------------ */

describe('Tournament', () => {
  const fresh = (key: string): TournamentInstance => {
    g.localStorage!.removeItem(key);
    return new Tournament(key);
  };

  test('adds players by initials and seeds them in entry order', () => {
    const t = fresh('t:seed');
    const a = t.addPlayer('ajs')!;
    const b = t.addPlayer('KLM')!;
    assert.equal(a.initials, 'AJS');
    assert.equal(a.seed, 1);
    assert.equal(b.seed, 2);
    assert.equal(t.getPlayers().length, 2);
  });

  test('disambiguates duplicate initials rather than refusing the entry', () => {
    const t = fresh('t:dupe');
    assert.equal(t.addPlayer('AJS')!.label, 'AJS');
    assert.equal(t.addPlayer('AJS')!.label, 'AJS·2');
    assert.equal(t.addPlayer('AJS')!.label, 'AJS·3');
    assert.equal(t.getPlayers().length, 3);
  });

  test('will not start with fewer than two players', () => {
    const t = fresh('t:one');
    t.addPlayer('AAA');
    assert.equal(t.start('sixtyseven'), false);
    assert.equal(t.state, 'lobby');
  });

  test('closes the lobby once started', () => {
    const t = fresh('t:closed');
    t.addPlayer('AAA');
    t.addPlayer('BBB');
    assert.ok(t.start('posematch'));
    assert.equal(t.state, 'running');
    assert.equal(t.addPlayer('CCC'), null);
    assert.equal(t.removePlayer(1), false);
  });

  test('removePlayer re-seeds the remaining entrants', () => {
    const t = fresh('t:remove');
    const a = t.addPlayer('AAA')!;
    t.addPlayer('BBB');
    t.addPlayer('CCC');
    assert.ok(t.removePlayer(a.id));
    assert.deepEqual(
      t.getPlayers().map((p) => [p.initials, p.seed]),
      [['BBB', 1], ['CCC', 2]]
    );
  });

  test('reportScores picks the winner from the scores', () => {
    const t = fresh('t:scores');
    t.addPlayer('AAA');
    t.addPlayer('BBB');
    t.start('sixtyseven');
    const m = t.nextMatch()!;
    assert.ok(t.reportScores(m.id, 12, 40));
    assert.equal(t.champion()!.initials, 'BBB');
    assert.equal(t.state, 'complete');
  });

  test('a dead heat is refused rather than coin-tossed', () => {
    const t = fresh('t:heat');
    t.addPlayer('AAA');
    t.addPlayer('BBB');
    t.start('sixtyseven');
    assert.equal(t.reportCurrent(30, 30), false);
    assert.equal(t.isComplete(), false);
  });

  test('runs an 11-player bracket to a champion', () => {
    const t = fresh('t:eleven');
    for (let i = 0; i < 11; i++) t.addPlayer(String.fromCharCode(65 + i).repeat(3));
    assert.ok(t.start('fruitninja'));

    let played = 0;
    let guard = 0;
    while (!t.isComplete() && guard++ < 50) {
      const m = t.nextMatch()!;
      const [a, b] = t.matchPlayers(m);
      assert.ok(a && b, 'a live match must have two real players');
      // The better seed always wins, so the champion is predictable.
      t.reportScores(m.id, a.seed < b.seed ? 10 : 1, a.seed < b.seed ? 1 : 10);
      played++;
    }
    assert.equal(played, 10, '11 entrants means 10 real matches');
    assert.equal(t.champion()!.seed, 1);
    assert.equal(t.state, 'complete');
  });

  test('undoLast reverses the most recent real result', () => {
    const t = fresh('t:undo');
    for (const n of ['AAA', 'BBB', 'CCC', 'DDD']) t.addPlayer(n);
    t.start('sixtyseven');
    const m0 = t.nextMatch()!;
    t.reportScores(m0.id, 5, 1);
    const m1 = t.nextMatch()!;
    t.reportScores(m1.id, 1, 5);
    assert.ok(t.undoLast());
    assert.equal(t.nextMatch()!.id, m1.id, 'the undone match is next again');
  });

  /* ---------------- persistence ---------------- */

  test('round-trips a mid-bracket state through storage', () => {
    const key = 't:persist';
    const t = fresh(key);
    for (const n of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']) t.addPlayer(n);
    t.start('posematch');
    const first = t.nextMatch()!;
    t.reportScores(first.id, 20, 3);
    const before = t.toRender();

    // Simulate a crash: brand new instance, same key.
    const revived = new Tournament(key);
    const after = revived.toRender();

    assert.equal(after.game, 'posematch');
    assert.equal(after.state, 'running');
    assert.equal(after.playerCount, 5);
    assert.equal(after.size, before.size);
    assert.equal(after.byes, before.byes);
    assert.equal(after.matchesPlayed, 1);
    assert.equal(revived.nextMatch()!.id, t.nextMatch()!.id);
    assert.deepEqual(
      after.rounds.map((r) => r.matches.map((m) => m.slots.map((s) => s.label))),
      before.rounds.map((r) => r.matches.map((m) => m.slots.map((s) => s.label)))
    );
  });

  test('a completed bracket survives a restart with its champion', () => {
    const key = 't:persist-done';
    const t = fresh(key);
    t.addPlayer('AAA');
    t.addPlayer('ZZZ');
    t.start('sixtyseven');
    t.reportCurrent(1, 9);

    const revived = new Tournament(key);
    assert.equal(revived.state, 'complete');
    assert.equal(revived.champion()!.initials, 'ZZZ');
    assert.equal(revived.nextMatch(), null);
  });

  test('a lobby survives a restart', () => {
    const key = 't:persist-lobby';
    const t = fresh(key);
    t.addPlayer('AAA');
    t.addPlayer('BBB');
    const revived = new Tournament(key);
    assert.equal(revived.state, 'lobby');
    assert.equal(revived.getPlayers().length, 2);
    assert.ok(revived.start('sixtyseven'));
  });

  test('corrupt stored data degrades to an empty lobby instead of throwing', () => {
    const key = 't:corrupt';
    g.localStorage!.setItem(key, '{not json at all');
    const t = new Tournament(key);
    assert.equal(t.state, 'lobby');
    assert.equal(t.getPlayers().length, 0);
  });

  test('survives localStorage being absent entirely (private mode)', () => {
    const saved = g.localStorage;
    delete g.localStorage;
    try {
      const t = new Tournament('t:nostorage');
      t.addPlayer('AAA');
      t.addPlayer('BBB');
      assert.ok(t.start('sixtyseven'));
      assert.ok(t.reportCurrent(9, 1));
      assert.equal(t.champion()!.initials, 'AAA');
    } finally {
      g.localStorage = saved;
    }
  });

  test('survives a storage that throws on every access', () => {
    const saved = g.localStorage;
    g.localStorage = new Proxy({} as MemoryStorage, {
      get() {
        return () => {
          throw new Error('QuotaExceededError');
        };
      },
    });
    try {
      const t = new Tournament('t:throwing');
      t.addPlayer('AAA');
      t.addPlayer('BBB');
      assert.ok(t.start('posematch'));
      assert.ok(t.reportCurrent(1, 9));
      assert.equal(t.champion()!.initials, 'BBB');
    } finally {
      g.localStorage = saved;
    }
  });

  test('reset clears storage and reopens the lobby', () => {
    const key = 't:reset';
    const t = fresh(key);
    t.addPlayer('AAA');
    t.addPlayer('BBB');
    t.start('sixtyseven');
    t.reset();
    assert.equal(t.state, 'lobby');
    assert.equal(g.localStorage!.getItem(key), null);
    assert.equal(new Tournament(key).getPlayers().length, 0);
  });

  /* ---------------- render structure ---------------- */

  test('toRender exposes rounds -> matches -> slots with readable labels', () => {
    const t = fresh('t:render');
    for (const n of ['AAA', 'BBB', 'CCC']) t.addPlayer(n);
    t.start('sixtyseven');
    const r = t.toRender();

    assert.equal(r.rounds.length, 2);
    assert.deepEqual(r.rounds.map((x) => x.name), ['SEMI-FINAL', 'FINAL']);
    assert.equal(r.rounds[0]!.matches.length, 2);
    assert.equal(r.rounds[1]!.matches.length, 1);
    assert.equal(r.size, 4);
    assert.equal(r.byes, 1);
    assert.equal(r.matchesTotal, 2, 'the bye is not a match anyone plays');

    const byeMatch = r.rounds[0]!.matches.find((m) => m.slots[1].isBye)!;
    assert.equal(byeMatch.slots[1].label, 'BYE');
    assert.equal(byeMatch.slots[0].label, 'AAA');
    assert.equal(byeMatch.auto, true);

    assert.ok(r.next, 'a running bracket always has a next match');
    assert.equal(r.next!.live, true);
    assert.equal(r.next!.slots[0].label, 'BBB');
    assert.equal(r.next!.slots[1].label, 'CCC');
    assert.equal(r.champion, null);
  });

  test('toRender marks winners, losers and scores after a result', () => {
    const t = fresh('t:render2');
    t.addPlayer('AAA');
    t.addPlayer('BBB');
    t.start('sixtyseven');
    t.reportCurrent(7, 31);
    const m = t.toRender().rounds[0]!.matches[0]!;
    assert.equal(m.done, true);
    assert.deepEqual([m.slots[0].won, m.slots[1].won], [false, true]);
    assert.deepEqual([m.slots[0].lost, m.slots[1].lost], [true, false]);
    assert.deepEqual([m.slots[0].score, m.slots[1].score], [7, 31]);
    assert.equal(t.toRender().champion!.initials, 'BBB');
    assert.equal(t.toRender().next, null);
  });

  /**
   * THE EXPORT HAS TO ANSWER "WHO BEAT WHOM" ON ITS OWN.
   *
   * Scores and tuning had an export and the bracket did not, which was exactly
   * backwards: the other two can be reconstructed by asking people, and an
   * afternoon of results cannot. The runbook's answer to a dead disk used to be
   * to photograph the tab.
   *
   * So the file has to stand alone. A match carrying `slots: [3, 5]` and
   * `winner: 0` is only meaningful next to the player list it was written
   * beside, and somebody opening this at 6pm should not have to join two tables
   * by hand to find out who won.
   */
  test('the export names the people, not just their ids', () => {
    const t = fresh('t:export');
    for (const n of ['AAA', 'BBB', 'CCC', 'DDD']) t.addPlayer(n);
    t.start('sixtyseven');

    // Round 0: AAA beats DDD, BBB beats CCC (standard 1v4 / 2v3 seeding).
    const r0 = t.getMatches().filter((m) => m.round === 0);
    for (const m of r0) t.report(m.id, 0);
    const final = t.getMatches().find((m) => m.round === 1)!;
    t.report(final.id, 1);

    const dump = JSON.parse(t.exportJSON()) as {
      champion: string | null;
      state: string;
      game: string | null;
      players: Array<{ initials: string }>;
      matches: Array<{ names: [string | null, string | null]; winner: string | null; round: number }>;
    };

    assert.equal(dump.champion, t.champion()!.initials);
    assert.equal(dump.state, 'complete');
    assert.equal(dump.game, 'sixtyseven');
    assert.deepEqual(
      dump.players.map((p) => p.initials),
      ['AAA', 'BBB', 'CCC', 'DDD']
    );

    // Every played match says who was in it and who won, in initials.
    for (const m of dump.matches) {
      assert.ok(m.names[0] && m.names[1], `round ${m.round} match has an unnamed slot`);
      assert.ok(m.winner, `round ${m.round} match does not say who won`);
      assert.ok(
        m.names.includes(m.winner),
        `winner ${m.winner} is not one of the two people in the match`
      );
    }

    const finalOut = dump.matches.find((m) => m.round === 1)!;
    assert.equal(finalOut.winner, dump.champion, 'the final disagrees with the champion');
  });

  /**
   * And it must not throw before anyone has played. The DATA tab hides the
   * button until there is a bracket, but a marshal can reach this the instant
   * the first name goes in.
   */
  test('exporting a bracket nobody has played is still valid JSON', () => {
    const t = fresh('t:export-empty');
    const empty = JSON.parse(t.exportJSON()) as { champion: string | null; matches: unknown[] };
    assert.equal(empty.champion, null);
    assert.deepEqual(empty.matches, []);

    t.addPlayer('ZZZ');
    const lobby = JSON.parse(t.exportJSON()) as {
      state: string;
      players: Array<{ initials: string }>;
    };
    assert.equal(lobby.state, 'lobby');
    assert.deepEqual(
      lobby.players.map((p) => p.initials),
      ['ZZZ']
    );
  });

  test('an empty tournament renders without throwing', () => {
    const t = fresh('t:empty');
    const r = t.toRender();
    assert.deepEqual(r.rounds, []);
    assert.equal(r.champion, null);
    assert.equal(r.next, null);
    assert.equal(r.size, 0);
  });

  /**
   * A BLANK FIELD IS NOT A PLAYER.
   *
   * `normaliseInitials('')` returns 'AAA', so ADD on an empty box seeded a
   * phantom entrant. It is not ambiguous — duplicates are suffixed, as the
   * test above shows — but it IS invisible: the marshal is looking at the
   * field they just cleared, not at the bottom of the list. A ghost in the
   * bracket means a real player draws a bye against somebody who is not at the
   * stall, and the bracket is the one store nobody can reconstruct by asking.
   */
  test('an entrant with no name is refused', () => {
    const t = fresh('t:blank');
    assert.equal(t.addPlayer(''), null);
    assert.equal(t.addPlayer('   '), null);
    assert.equal(t.addPlayer('!!!'), null);
    assert.equal(t.addPlayer('-·-'), null);
    assert.equal(t.getPlayers().length, 0, 'a blank ADD seeded a phantom entrant');
  });

  test('but a real name is still added, and still sanitised', () => {
    const t = fresh('t:blank2');
    assert.ok(t.addPlayer(' was '));
    assert.equal(t.getPlayers()[0]!.initials, 'WAS');
  });

});
