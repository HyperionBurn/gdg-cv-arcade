/**
 * THE POOL, which is fixed-capacity precisely so a two-day stall cannot drift.
 *
 * `particles.ts` is one of the modules no test imported. Its header explains
 * why it is written the way it is: parallel typed arrays rather than objects,
 * because "at a few thousand live particles the GC pressure from object churn
 * is a visible stutter on a thermally-throttled laptop at hour four". Hour
 * four is the middle of the second day of the fair.
 *
 * Allocation is a ring: when the pool is full the OLDEST particle is
 * recycled, which the code notes is far better than dropping the newest
 * because that makes big effects look truncated. That is right, and it is
 * also the one place the bookkeeping can come apart — recycling a slot that
 * is already alive must not count it as a second particle.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ParticleSystem, BURST } from '../src/engine/particles.ts';

const MAX = 3000;

const burst = (ps: ParticleSystem, count: number, life = 1): void => {
  ps.emit({ x: 100, y: 100, count, color: '#fff', speed: 50, size: 3, life });
};

describe('ParticleSystem', () => {
  test('an emit produces particles', () => {
    const ps = new ParticleSystem();
    burst(ps, 40);
    assert.equal(ps.count, 40);
  });

  test('particles die when their life runs out', () => {
    const ps = new ParticleSystem();
    burst(ps, 40, 0.5);
    ps.update(0.25);
    assert.equal(ps.count, 40, 'they died early');
    ps.update(0.5);
    assert.equal(ps.count, 0, 'they outlived their life');
  });

  /**
   * THE CAP IS THE WHOLE POINT. Emitting past capacity recycles rather than
   * growing, so the live count can never exceed the pool.
   */
  test('emitting past capacity never exceeds the pool', () => {
    const ps = new ParticleSystem();
    for (let i = 0; i < 10; i++) burst(ps, 1000, 60);
    assert.ok(ps.count <= MAX, `count ran to ${ps.count}, past the ${MAX} cap`);
  });

  /**
   * AND THE COUNT MUST MATCH REALITY, not just stay under the cap. A recycled
   * slot was already alive and already counted; counting it again drifts the
   * total upward permanently, because it is only ever decremented once when
   * it finally dies.
   *
   * Nothing reads `count` today, which is why this was invisible. It is
   * exactly the accessor a particle row on the `d` overlay would use, and a
   * diagnostic that reports a number nobody can reach is worse than no row.
   */
  test('the count matches the particles that are really alive', () => {
    const ps = new ParticleSystem();
    // Fill the pool, then keep going so the ring wraps and recycles.
    for (let i = 0; i < 5; i++) burst(ps, 1000, 60);
    const reported = ps.count;

    // Age everything out. However many were really alive, that many deaths
    // bring the pool to empty — so a reported count above the truth survives
    // as a non-zero remainder.
    ps.update(120);
    assert.equal(
      ps.count,
      0,
      `after every particle expired the pool still claims ${ps.count} alive; ` +
        `it reported ${reported} before`,
    );
  });

  /**
   * `quality` is the frame watchdog's single lever: PLAN.md §2 asks for
   * "auto-drop particle density if we miss frame time", and halving this
   * halves the density everywhere without any game knowing.
   */
  test('quality scales emission without games knowing', () => {
    const full = new ParticleSystem();
    burst(full, 100);

    const half = new ParticleSystem();
    half.quality = 0.5;
    burst(half, 100);

    assert.equal(full.count, 100);
    assert.equal(half.count, 50);
  });

  /** Even at zero quality an effect must show SOMETHING, or a cue vanishes. */
  test('quality never silences an effect completely', () => {
    const ps = new ParticleSystem();
    ps.quality = 0;
    burst(ps, 100);
    assert.ok(ps.count >= 1, 'an effect disappeared entirely at zero quality');
  });

  test('clear empties the pool', () => {
    const ps = new ParticleSystem();
    burst(ps, 200, 60);
    ps.clear();
    assert.equal(ps.count, 0);
  });

  /**
   * The BURST presets are what games actually call. They only have to be
   * bounded and non-empty — the look is a design question, not a test one.
   */
  test('every burst preset emits and stays inside the pool', () => {
    for (const fire of [
      (ps: ParticleSystem) => BURST.splat(ps, 10, 10, '#fff'),
      (ps: ParticleSystem) => BURST.celebrate(ps, 10, 10, ['#fff', '#000']),
      (ps: ParticleSystem) => BURST.spark(ps, 10, 10, 0, '#fff'),
      (ps: ParticleSystem) => BURST.ambient(ps, 10, 10, '#fff'),
    ]) {
      const ps = new ParticleSystem();
      fire(ps);
      assert.ok(ps.count > 0, 'a preset emitted nothing');
      assert.ok(ps.count <= MAX, 'a preset overflowed the pool');
    }
  });
});
