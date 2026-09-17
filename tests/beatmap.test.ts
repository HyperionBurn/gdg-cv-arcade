/**
 * Unit tests for the Rhythm Punch chart generator.
 *
 * Pure functions, no DOM, so they run in Node directly:
 *   npm test
 *
 * Worth having as real tests rather than browser pokes for the same reason the
 * slice geometry is: an unfair chart is invisible in a visual check. Two notes
 * for the same hand 200ms apart look completely normal on screen and are simply
 * impossible to play, and the player reads that as "I am bad at this" rather
 * than "the game asked for something nobody can do".
 *
 * A stall round is 60s at 126bpm, so the shapes under test are ~32 bars.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateBeatmap,
  validateBeatmap,
  noteDensity,
  handForSlot,
  laneXForSlot,
  gradeFor,
  TIMING,
  MAX_PUNCHES_PER_BAR,
  MIN_SAME_HAND_BEATS,
  type Beatmap,
  type PunchNote,
  type WallNote,
} from '../src/games/beatmap.ts';

/** The shape the game actually asks for: 60s round, 126bpm, 4/4. */
const ROUND = { seed: 1, bpm: 126, bars: 32, leadInBeats: 6 };

function chart(seed: number): Beatmap {
  return generateBeatmap({ ...ROUND, seed });
}

function punches(map: Beatmap): PunchNote[] {
  return map.notes.filter((n): n is PunchNote => n.kind === 'punch');
}

function walls(map: Beatmap): WallNote[] {
  return map.notes.filter((n): n is WallNote => n.kind === 'wall');
}

/** Every seed a stall would ever see in a day, and then some. */
const SEEDS = Array.from({ length: 200 }, (_, i) => i * 7919 + 13);

/* ------------------------------------------------------------------ */

describe('determinism', () => {
  test('the same seed produces an identical chart', () => {
    assert.deepEqual(chart(42), chart(42));
  });

  test('the same seed is identical across repeated calls in sequence', () => {
    // Catches a generator that leaks state between calls — a module-level RNG
    // would pass the test above and fail this one.
    const a = chart(7);
    chart(999);
    chart(1234);
    const b = chart(7);
    assert.deepEqual(a, b);
  });

  test('different seeds produce different charts', () => {
    const a = chart(1);
    const b = chart(2);
    assert.notDeepEqual(a.notes, b.notes);
  });

  test('seeds are well spread — no two of 200 collide', () => {
    const seen = new Set<string>();
    for (const seed of SEEDS) {
      seen.add(JSON.stringify(chart(seed).notes.map((n) => [n.time, n.kind])));
    }
    assert.equal(seen.size, SEEDS.length, 'two seeds generated the same note layout');
  });
});

/* ------------------------------------------------------------------ */

describe('the three invariants', () => {
  test('validateBeatmap finds nothing wrong with 200 seeds', () => {
    for (const seed of SEEDS) {
      const problems = validateBeatmap(chart(seed));
      assert.deepEqual(problems, [], `seed ${seed}: ${problems.map((p) => p.reason).join('; ')}`);
    }
  });

  test('NO IMPOSSIBLE PAIRS: one hand is never asked for two notes at once', () => {
    for (const seed of SEEDS) {
      const map = chart(seed);
      for (const hand of ['left', 'right'] as const) {
        const mine = punches(map).filter((n) => n.hand === hand);
        for (let i = 1; i < mine.length; i++) {
          const gap = mine[i]!.time - mine[i - 1]!.time;
          assert.ok(
            gap >= map.minSameHandSeconds - 1e-9,
            `seed ${seed}: ${hand} hand asked for notes ${gap.toFixed(3)}s apart`
          );
        }
      }
    }
  });

  test('same-hand windows therefore never overlap, so a hit is never ambiguous', () => {
    const map = chart(3);
    assert.ok(
      map.minSameHandSeconds > TIMING.good * 2,
      `same-hand gap ${map.minSameHandSeconds} must exceed two good windows (${TIMING.good * 2})`
    );
  });

  test('NO DUCK OVER A PUNCH: every punch clears every wall window', () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const map = chart(seed);
      for (const wall of walls(map)) {
        for (const punch of punches(map)) {
          const gap = Math.abs(punch.time - wall.time);
          assert.ok(
            gap >= map.wallGuardSeconds - 1e-9,
            `seed ${seed}: punch ${punch.id} is ${gap.toFixed(3)}s from wall ${wall.id}`
          );
          checked++;
        }
      }
    }
    assert.ok(checked > 10000, `only ${checked} punch/wall pairs were compared`);
  });

  test('the wall guard is wider than a duck window plus a hit window', () => {
    const map = chart(5);
    assert.ok(
      map.wallGuardSeconds > TIMING.wall + TIMING.good,
      `guard ${map.wallGuardSeconds} vs ${TIMING.wall + TIMING.good}`
    );
  });

  test('two walls are never close enough to run together', () => {
    for (const seed of SEEDS) {
      const map = chart(seed);
      const w = walls(map);
      for (let i = 1; i < w.length; i++) {
        assert.ok(
          w[i]!.time - w[i - 1]!.time >= map.barSeconds * 3 - 1e-9,
          `seed ${seed}: walls ${w[i - 1]!.id}/${w[i]!.id} are ${(w[i]!.time - w[i - 1]!.time).toFixed(2)}s apart`
        );
      }
    }
  });

  test('nothing arrives before the lead-in, so nothing is un-telegraphed', () => {
    for (const seed of SEEDS) {
      const map = chart(seed);
      const leadIn = map.leadInBeats * map.beatSeconds;
      for (const note of map.notes) {
        assert.ok(note.time >= leadIn - 1e-9, `seed ${seed}: note ${note.id} at ${note.time}s`);
      }
    }
  });

  test('notes come out sorted by time with ids matching their index', () => {
    for (const seed of SEEDS.slice(0, 50)) {
      const map = chart(seed);
      for (let i = 0; i < map.notes.length; i++) {
        assert.equal(map.notes[i]!.id, i);
        if (i > 0) assert.ok(map.notes[i]!.time >= map.notes[i - 1]!.time);
      }
    }
  });
});

/* ------------------------------------------------------------------ */

describe('difficulty ramp', () => {
  test('bar difficulty is strictly increasing', () => {
    for (const seed of SEEDS.slice(0, 50)) {
      const map = chart(seed);
      for (let i = 1; i < map.bars.length; i++) {
        assert.ok(
          map.bars[i]!.difficulty > map.bars[i - 1]!.difficulty,
          `seed ${seed}: bar ${i} difficulty ${map.bars[i]!.difficulty} <= bar ${i - 1}`
        );
      }
    }
  });

  test('it spans the full range', () => {
    const map = chart(11);
    assert.equal(map.bars[0]!.difficulty, 0);
    assert.equal(map.bars[map.bars.length - 1]!.difficulty, 1);
  });

  test('requested punches per bar never decrease', () => {
    for (const seed of SEEDS.slice(0, 50)) {
      const map = chart(seed);
      for (let i = 1; i < map.bars.length; i++) {
        assert.ok(
          map.bars[i]!.targetPunches >= map.bars[i - 1]!.targetPunches,
          `seed ${seed}: bar ${i} asked for fewer punches than bar ${i - 1}`
        );
      }
    }
  });

  test('the last third is denser than the first third in every seed', () => {
    for (const seed of SEEDS) {
      const map = chart(seed);
      const third = Math.floor(map.bars.length / 3);
      const early = map.bars.slice(0, third).reduce((s, b) => s + b.punches, 0);
      const late = map.bars.slice(-third).reduce((s, b) => s + b.punches, 0);
      assert.ok(late > early, `seed ${seed}: first third ${early} punches, last third ${late}`);
    }
  });

  test('the opening bar is always survivable — at most one punch, never a wall', () => {
    for (const seed of SEEDS) {
      const map = chart(seed);
      assert.ok(map.bars[0]!.punches <= 1, `seed ${seed}: opening bar had ${map.bars[0]!.punches}`);
      assert.equal(map.bars[0]!.wall, false);
    }
  });

  test('the final bar never holds a wall', () => {
    // Ending on an unrecoverable wall is a sour last impression, and the
    // results screen lands two seconds later.
    for (const seed of SEEDS) {
      const map = chart(seed);
      assert.equal(map.bars[map.bars.length - 1]!.wall, false, `seed ${seed}`);
    }
  });
});

/* ------------------------------------------------------------------ */

describe('density bounds', () => {
  test('no bar exceeds the physical ceiling', () => {
    for (const seed of SEEDS) {
      const map = chart(seed);
      for (const bar of map.bars) {
        assert.ok(
          bar.punches <= MAX_PUNCHES_PER_BAR,
          `seed ${seed}: bar ${bar.index} holds ${bar.punches} punches`
        );
      }
    }
  });

  test('overall note density stays in the playable band', () => {
    let min = Infinity;
    let max = -Infinity;
    for (const seed of SEEDS) {
      const d = noteDensity(chart(seed));
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
    // Below ~0.6/s the round is boring; above ~1.6/s a first-timer at a stall
    // is just flailing. Both ends are asserted so a generator change that
    // quietly doubles or halves the workload fails here.
    assert.ok(min >= 0.6, `sparsest chart was ${min.toFixed(2)} notes/sec`);
    assert.ok(max <= 1.6, `densest chart was ${max.toFixed(2)} notes/sec`);
  });

  test('peak same-hand rate stays under two punches a second', () => {
    for (const seed of SEEDS) {
      const map = chart(seed);
      // Same-hand separation is what actually bounds one arm's workload.
      assert.ok(1 / map.minSameHandSeconds <= 1.2, `seed ${seed}`);
      assert.equal(MIN_SAME_HAND_BEATS * map.beatSeconds, map.minSameHandSeconds);
    }
  });

  test('every chart has both hands, and roughly evenly', () => {
    for (const seed of SEEDS) {
      const map = chart(seed);
      const left = punches(map).filter((n) => n.hand === 'left').length;
      const right = punches(map).length - left;
      assert.ok(left > 0 && right > 0, `seed ${seed}: ${left}L / ${right}R`);
      const skew = Math.abs(left - right) / (left + right);
      assert.ok(skew < 0.25, `seed ${seed}: hand skew ${(skew * 100).toFixed(0)}%`);
    }
  });

  test('every chart has walls, but not too many', () => {
    for (const seed of SEEDS) {
      const map = chart(seed);
      const n = walls(map).length;
      assert.ok(n >= 3 && n <= 9, `seed ${seed} produced ${n} walls`);
    }
  });

  test('a 60s round produces a chart that fills it', () => {
    const map = chart(17);
    assert.ok(map.durationSeconds > 58 && map.durationSeconds < 66, `${map.durationSeconds}s`);
  });
});

/* ------------------------------------------------------------------ */

describe('patterns are physically sane', () => {
  test('a double is exactly one left and one right at the same instant', () => {
    for (const seed of SEEDS.slice(0, 60)) {
      const map = chart(seed);
      const byTime = new Map<number, PunchNote[]>();
      for (const n of punches(map)) {
        const list = byTime.get(n.time) ?? [];
        list.push(n);
        byTime.set(n.time, list);
      }
      for (const [time, list] of byTime) {
        assert.ok(list.length <= 2, `seed ${seed}: ${list.length} punches at ${time}s`);
        if (list.length === 2) {
          assert.ok(list.every((n) => n.double), `seed ${seed}: simultaneous pair not flagged double`);
          assert.notEqual(list[0]!.hand, list[1]!.hand, `seed ${seed}: two notes for one hand at ${time}s`);
        }
      }
    }
  });

  test('left targets sit left of centre and right targets right', () => {
    // The whole colour-coding gag only works if position agrees with hand.
    for (const seed of SEEDS.slice(0, 60)) {
      for (const n of punches(chart(seed))) {
        if (n.hand === 'left') assert.ok(n.x < 0, `seed ${seed}: left note at x ${n.x}`);
        else assert.ok(n.x > 0, `seed ${seed}: right note at x ${n.x}`);
      }
    }
  });

  test('targets stay inside the lane and the strike zone', () => {
    for (const seed of SEEDS.slice(0, 60)) {
      for (const n of punches(chart(seed))) {
        assert.ok(Math.abs(n.x) <= 1);
        assert.ok(n.y >= 0 && n.y <= 1);
      }
    }
  });
});

/* ------------------------------------------------------------------ */

describe('2P mirroring', () => {
  test('slot 1 gets the opposite hand and the mirrored position', () => {
    const map = chart(23);
    for (const n of punches(map)) {
      assert.equal(handForSlot(n, 0), n.hand);
      assert.notEqual(handForSlot(n, 1), n.hand);
      assert.equal(laneXForSlot(n, 0), n.x);
      assert.equal(laneXForSlot(n, 1), -n.x);
    }
  });

  test('the mirrored hand still matches the mirrored side of the lane', () => {
    // This is the property that must hold, not the flip itself: whichever slot
    // you are, the target on the left of your lane is your left fist.
    for (const n of punches(chart(29))) {
      for (const slot of [0, 1]) {
        const hand = handForSlot(n, slot);
        const x = laneXForSlot(n, slot);
        assert.equal(hand === 'left', x < 0, `slot ${slot} note ${n.id}`);
      }
    }
  });

  test('both slots get identical workload counts, so versus is fair', () => {
    const map = chart(31);
    const p = punches(map);
    assert.equal(p.filter((n) => handForSlot(n, 0) === 'left').length, p.filter((n) => handForSlot(n, 1) === 'right').length);
  });
});

/* ------------------------------------------------------------------ */

describe('gradeFor', () => {
  test('grades the windows as documented', () => {
    assert.equal(gradeFor(0), 'perfect');
    assert.equal(gradeFor(TIMING.perfect), 'perfect');
    assert.equal(gradeFor(-TIMING.perfect), 'perfect');
    assert.equal(gradeFor(TIMING.perfect + 0.001), 'great');
    assert.equal(gradeFor(TIMING.great), 'great');
    assert.equal(gradeFor(TIMING.great + 0.001), 'good');
    assert.equal(gradeFor(TIMING.good), 'good');
    assert.equal(gradeFor(TIMING.good + 0.001), null);
    assert.equal(gradeFor(-TIMING.good - 0.001), null);
  });

  test('is symmetric — early and late are judged the same', () => {
    for (let d = 0; d < 0.5; d += 0.005) {
      assert.equal(gradeFor(d), gradeFor(-d), `asymmetric at ${d}`);
    }
  });

  test('every window clears the ~0.1s detection latency floor', () => {
    // README: the Runner measured 0.100s +/- 0.001 of end-to-end latency, and
    // pose inference quantises input to ~33ms on top. A window tighter than
    // that is not a skill test, it is a coin flip.
    assert.ok(TIMING.perfect > 0.1);
    assert.ok(TIMING.good > 3 * TIMING.perfect * 0.9);
  });
});

/* ------------------------------------------------------------------ */

describe('option handling', () => {
  test('a one-bar chart does not divide by zero', () => {
    const map = generateBeatmap({ seed: 1, bars: 1 });
    assert.equal(map.bars.length, 1);
    assert.deepEqual(validateBeatmap(map), []);
  });

  test('a very long chart stays valid', () => {
    const map = generateBeatmap({ seed: 2, bars: 400 });
    assert.deepEqual(validateBeatmap(map), []);
  });

  test('tempo changes keep the invariants — the separations are floored in seconds', () => {
    for (const bpm of [60, 90, 126, 160, 200, 260]) {
      const map = generateBeatmap({ seed: 3, bpm, bars: 40 });
      assert.deepEqual(
        validateBeatmap(map),
        [],
        `bpm ${bpm}: ${validateBeatmap(map).map((p) => p.reason).join('; ')}`
      );
      assert.ok(map.minSameHandSeconds > TIMING.good * 2, `bpm ${bpm} same-hand gap too tight`);
      assert.ok(map.wallGuardSeconds > TIMING.wall + TIMING.good, `bpm ${bpm} wall guard too tight`);
    }
  });

  test('intensity below 1 lowers the ceiling without breaking the ramp', () => {
    const easy = generateBeatmap({ ...ROUND, seed: 5, intensity: 0.5 });
    const full = generateBeatmap({ ...ROUND, seed: 5, intensity: 1 });
    assert.ok(easy.notes.length < full.notes.length);
    assert.deepEqual(validateBeatmap(easy), []);
    for (let i = 1; i < easy.bars.length; i++) {
      assert.ok(easy.bars[i]!.difficulty >= easy.bars[i - 1]!.difficulty);
    }
  });

  test('a negative or fractional seed still produces a valid chart', () => {
    for (const seed of [-1, -99999, 0.5, 3.7]) {
      assert.deepEqual(validateBeatmap(generateBeatmap({ ...ROUND, seed })), [], `seed ${seed}`);
    }
  });
});
