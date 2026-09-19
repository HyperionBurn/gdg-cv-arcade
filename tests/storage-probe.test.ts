/**
 * THE PROBE THAT RUNS BEFORE ANYTHING HAS BEEN LOST.
 *
 * Three stores raise `saveFailed` when a write is refused, which is the right
 * signal at the wrong time: none of them can notice until something has already
 * gone — the first slider move, the first reported match, the first submitted
 * score.
 *
 * The condition actually worth catching is a profile that was never going to
 * allow storage: locked-down, managed, or a private window somebody opened
 * without thinking. It is present from load, fixable in ten seconds at 9am, and
 * not fixable at 3pm without throwing away the morning.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { probeStorage } from '../src/meta/storage.ts';

type Store = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
};

const withStorage = <T>(impl: Store | undefined, fn: () => T): T => {
  const g = globalThis as { localStorage?: unknown };
  const had = 'localStorage' in g;
  const prev = g.localStorage;
  if (impl === undefined) delete g.localStorage;
  else g.localStorage = impl;
  try {
    return fn();
  } finally {
    if (had) g.localStorage = prev;
    else delete g.localStorage;
  }
};

/** A localStorage that works. */
const working = (): Store & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
};

describe('the boot storage probe', () => {
  test('a working localStorage passes', () => {
    assert.equal(
      withStorage(working(), () => probeStorage()),
      true
    );
  });

  test('it cleans up after itself', () => {
    const s = working();
    withStorage(s, () => probeStorage());
    assert.deepEqual([...s.map.keys()], [], 'the probe left a key behind');
  });

  test('a private-mode store that throws on write fails', () => {
    const s = working();
    const thrower: Store = {
      ...s,
      setItem: () => {
        const e = new Error('quota');
        e.name = 'QuotaExceededError';
        throw e;
      },
    };
    assert.equal(
      withStorage(thrower, () => probeStorage()),
      false
    );
  });

  /**
   * THE CASE A READ COULD NEVER HAVE CAUGHT.
   *
   * Some locked-down profiles accept `setItem` silently and discard it. A probe
   * that only watched for a thrown exception would call that healthy, and the
   * first anyone would know is a reload with nothing in it. Reading the value
   * back is the whole reason this is a probe and not a try/catch.
   */
  test('a store that accepts a write and discards it fails', () => {
    const swallower: Store = {
      getItem: () => null,
      setItem: () => {
        /* accepted, and quietly dropped */
      },
      removeItem: () => {},
    };
    assert.equal(
      withStorage(swallower, () => probeStorage()),
      false
    );
  });

  /** And one that hands back somebody else's value is not working either. */
  test('a store that returns the wrong value fails', () => {
    const liar: Store = {
      getItem: () => 'not-the-token',
      setItem: () => {},
      removeItem: () => {},
    };
    assert.equal(
      withStorage(liar, () => probeStorage()),
      false
    );
  });

  test('no localStorage at all fails rather than throwing', () => {
    assert.equal(
      withStorage(undefined, () => probeStorage()),
      false
    );
  });

  /**
   * A probe that took the kiosk down would be worse than the problem it is
   * looking for, so every accessor is allowed to throw.
   */
  test('it never throws, whatever the store does', () => {
    for (const impl of [
      { getItem: () => { throw new Error('x'); }, setItem: () => {}, removeItem: () => {} },
      { getItem: () => null, setItem: () => {}, removeItem: () => { throw new Error('x'); } },
    ] as Store[]) {
      assert.doesNotThrow(() => withStorage(impl, () => probeStorage()));
      assert.equal(
        withStorage(impl, () => probeStorage()),
        false
      );
    }
  });
});
