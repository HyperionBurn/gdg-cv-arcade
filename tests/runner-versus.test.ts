/**
 * THE RUNNER, WITH TWO PEOPLE IN IT.
 *
 * This was the last solo-only game on the roster, and the reason was
 * structural rather than deliberate: every piece of per-player state was a
 * field on the screen class. One lane detector, one track, one clock, one
 * streak. Nothing about the design was single-player — the generator already
 * proves each segment clearable, collision is per-body, score is per-body —
 * there was simply exactly one of each.
 *
 * The refactor that fixed it is mechanical and therefore exactly the kind that
 * quietly gets one field wrong. These tests pin the two properties that would
 * ruin a race if they were:
 *
 *   1. BOTH RUNNERS GET THE SAME COURSE. Two independently seeded generators
 *      would be two different races, and "I got the easy one" ends it as a
 *      contest before it starts.
 *   2. AND SEPARATE DESTRUCTION. `cell.destroyed` is what stops one obstacle
 *      being hit twice. Shared rows would mean the leader clips a barrier and
 *      deletes it out from under the player behind — clearing the course for
 *      whoever is losing.
 *
 * Those two pull in opposite directions, which is why it is worth a test: the
 * cheap way to get (1) is to share the array, and that is exactly what breaks
 * (2).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RunnerGame } from '../src/games/runner.ts';
import { GameBase, type GameConfig } from '../src/games/base.ts';
import { validateRows, type TrackRow } from '../src/games/runner-world.ts';

/**
 * A round, without a canvas.
 *
 * `onStart` is the whole of what this file tests and it touches no rendering,
 * so it can be called directly. Everything else about the game needs a real
 * WebGL context and belongs in the browser harness (`src/dev/turn.ts`).
 */
function started(): RunnerGame {
  const g = new RunnerGame();
  (g as unknown as { playerCount: number }).playerCount = 2;
  (g as unknown as { onStart(n: number): void }).onStart(2);
  return g;
}

const rowsOf = (g: RunnerGame, slot: number): TrackRow[] => g.debugRows(slot);

describe('Runner — two runners, one race', () => {
  test('both runners are dealt the same course', () => {
    const g = started();
    const a = rowsOf(g, 0);
    const b = rowsOf(g, 1);

    assert.ok(a.length > 0, 'no track was generated at all');
    assert.equal(a.length, b.length, 'different numbers of rows');

    for (let i = 0; i < a.length; i++) {
      const ra = a[i]!;
      const rb = b[i]!;
      assert.equal(ra.z, rb.z, `row ${i} is at a different distance`);
      assert.deepEqual(
        ra.cells.map((c) => `${c.lane}:${c.kind}`),
        rb.cells.map((c) => `${c.lane}:${c.kind}`),
        `row ${i} has different obstacles`
      );
    }
  });

  test('but they are not the SAME course object', () => {
    // The cheap way to make two tracks identical is to hand both players the
    // same array. It passes the test above and loses the race.
    const g = started();
    assert.notEqual(rowsOf(g, 0), rowsOf(g, 1), 'both runners share one row array');
    const a = rowsOf(g, 0);
    const b = rowsOf(g, 1);
    for (let i = 0; i < a.length; i++) {
      assert.notEqual(a[i], b[i], `row ${i} is one shared object`);
      if (a[i]!.cells.length > 0) {
        assert.notEqual(a[i]!.cells[0], b[i]!.cells[0], `row ${i} shares a cell`);
      }
    }
  });

  test('one runner smashing an obstacle leaves the other runner’s intact', () => {
    const g = started();
    const a = rowsOf(g, 0);
    const b = rowsOf(g, 1);

    const i = a.findIndex((r) => r.cells.length > 0);
    assert.ok(i >= 0, 'the generated course has no obstacles in it');

    a[i]!.cells[0]!.destroyed = true;
    a[i]!.resolved = true;

    assert.equal(b[i]!.cells[0]!.destroyed, false, 'the leader cleared the course for the loser');
    assert.equal(b[i]!.resolved, false);
  });

  test('both courses are clearable, not just the first one', () => {
    // `selfTestGeneration` already proves the generator's output is clearable.
    // What this checks is that seeding it twice did not produce a second track
    // that skipped the feasibility pass.
    const g = started();
    for (const slot of [0, 1]) {
      const report = g.debugValidate(slot);
      assert.equal(
        report.ok,
        true,
        `slot ${slot} has an unclearable row at index ${report.failedIndex} of ${report.rowsChecked}`
      );
      assert.ok(report.rowsChecked > 0, `slot ${slot} validated an empty course`);
    }
  });

  test('a fresh round deals a DIFFERENT course', () => {
    // Same seed for both players, new seed every round. A stall running the
    // same course for eight hours is a stall where the third player has
    // memorised it.
    const first = started();
    const layout = (g: RunnerGame): string =>
      rowsOf(g, 0)
        .map((r) => `${r.z}|${r.cells.map((c) => `${c.lane}:${c.kind}`).join(',')}`)
        .join(';');

    const seen = new Set<string>();
    seen.add(layout(first));
    for (let i = 0; i < 6; i++) seen.add(layout(started()));

    assert.ok(seen.size > 1, 'every round generated an identical track');
  });

  test('every seat starts from zero', () => {
    // The specific failure this catches: a field left on the class instead of
    // moved into the per-seat struct still resets, but only once, so the
    // SECOND player inherits whatever the first left behind.
    const g = started();
    for (const slot of [0, 1]) {
      const d = g.debugState(slot);
      assert.equal(d.distance, 0, `slot ${slot} distance`);
      assert.equal(d.bonus, 0, `slot ${slot} bonus`);
      assert.equal(d.score, 0, `slot ${slot} score`);
      assert.equal(d.streak, 0, `slot ${slot} streak`);
      assert.equal(d.hits, 0, `slot ${slot} hits`);
      assert.equal(d.penalty, 0, `slot ${slot} penalty`);
      assert.equal(d.clock, 0, `slot ${slot} clock`);
      assert.equal(d.lane, 0, `slot ${slot} lane`);
      assert.equal(d.laneX, 0, `slot ${slot} laneX`);
      assert.equal(d.momentum, 1, `slot ${slot} momentum`);
    }
  });

  test('a second round does not inherit the first', () => {
    const g = started();
    // Bank some progress on slot 1 only, the seat most likely to be forgotten.
    const s = (g as unknown as { slots: Array<Record<string, number>> }).slots[1]!;
    s.distance = 420;
    s.streak = 7;
    s.hits = 3;

    (g as unknown as { onStart(n: number): void }).onStart(2);

    const d = g.debugState(1);
    assert.equal(d.distance, 0);
    assert.equal(d.streak, 0);
    assert.equal(d.hits, 0);
  });

  test('the game says it seats two, and the base agrees', () => {
    const g = new RunnerGame();
    const cfg = (g as unknown as { config: GameConfig }).config;
    assert.equal(cfg.maxPlayers, 2);
    assert.equal(cfg.supportsVersus, true);
    assert.equal(cfg.fullBleedSlots, true, 'two 3D tracks need a hard divider');
    assert.ok(g instanceof GameBase);
  });

  test('scoring reads the seat it was asked about', () => {
    // `scoreFor(slot)` ignoring its argument is the exact bug Red Light
    // shipped with, and it is invisible until a second person plays.
    const g = started();
    const slots = (g as unknown as { slots: Array<Record<string, number>> }).slots;
    slots[0]!.distance = 100;
    slots[0]!.bonus = 5;
    slots[1]!.distance = 40;
    slots[1]!.bonus = 0;

    const score = (slot: number): number =>
      (g as unknown as { scoreFor(s: number): number }).scoreFor(slot);
    assert.equal(score(0), 105);
    assert.equal(score(1), 40);
  });

  test('an out-of-range seat scores zero rather than throwing', () => {
    const g = started();
    const score = (slot: number): number =>
      (g as unknown as { scoreFor(s: number): number }).scoreFor(slot);
    assert.equal(score(5), 0);
  });
});

describe('Runner — the generator still proves its own work', () => {
  test('a seeded course passes the feasibility validator', () => {
    const g = started();
    const report = validateRows(g.debugRows(0));
    assert.equal(report.ok, true, `unclearable at row ${report.failedIndex}`);
  });
});
