/**
 * Unit tests for ghost recording, playback and version drift.
 *
 * Runs headless: the recorder, the byte packing and `scoreAt` are pure, and
 * only `drawGhost` needs a canvas.
 *
 * Three things here are worth proving rather than eyeballing:
 *
 *  1. The STORAGE BUDGET. The header of ghosts.ts claims ~24.5 KB for a
 *     worst-case 60-second run. That claim gets checked against a real
 *     recording, because a ghost that quietly eats the leaderboard's quota
 *     loses two days of scores and nobody notices until the stall is packed up.
 *  2. VERSION DRIFT. A ghost recorded under old scoring must be deleted, not
 *     shown. A silently-wrong target is worse than no target.
 *  3. TIMELINE FIDELITY. The ghost has to stay in sync with a live player
 *     whatever the frame rate did, or the race it exists to create is a lie.
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Landmark } from '../src/core/types.ts';

/* Same extensionless-import shim as tests/tournament.test.ts — see the comment
 * there. Hooks must be installed before the module under test loads, hence the
 * dynamic import below. */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      try {
        const resolved = fileURLToPath(new URL(specifier, context.parentURL));
        if (existsSync(`${resolved}.ts`)) return next(`${specifier}.ts`, context);
      } catch {
        /* fall through */
      }
    }
    return next(specifier, context);
  },
});

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

const {
  ghosts,
  SCORING_VERSION,
  SAMPLE_HZ,
  MAX_GHOST_CHARS,
  MAX_SECONDS,
  GHOST_JOINTS,
  GHOST_JOINT_COUNT,
  GHOST_CONNECTIONS,
} = await import('../src/meta/ghosts.ts');

const KEY = (game: string): string => `gdg-arcade:ghost:v1:${game}`;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** A 33-landmark pose whose ghost joints sit on a predictable curve. */
function poseAt(t: number): Landmark[] {
  const lm: Landmark[] = [];
  for (let i = 0; i < 33; i++) {
    lm.push({ x: 0.5, y: 0.5, z: 0, visibility: 1 });
  }
  for (let j = 0; j < GHOST_JOINT_COUNT; j++) {
    const idx = GHOST_JOINTS[j]!;
    lm[idx] = {
      x: 0.1 + 0.8 * ((j / GHOST_JOINT_COUNT + t * 0.1) % 1),
      y: 0.05 + j * 0.07,
      z: 0,
      visibility: 1,
    };
  }
  return lm;
}

/** Records a run of `seconds` at `fps`, scoring one point per second. */
function recordRun(
  game: Parameters<typeof ghosts.record>[0],
  seconds: number,
  fps = 60,
  opts: { pose?: boolean; score?: (t: number) => number } = {}
): boolean {
  const rec = ghosts.record(game, opts.pose === false ? { pose: false } : {});
  const scoreOf = opts.score ?? ((t: number) => Math.floor(t));
  const frames = Math.round(seconds * fps);
  for (let i = 0; i <= frames; i++) {
    const t = i / fps;
    rec.sample(t, scoreOf(t), opts.pose === false ? null : poseAt(t));
  }
  return rec.finish();
}

/* ------------------------------------------------------------------ *
 * Shape and constants
 * ------------------------------------------------------------------ */

describe('ghost joint set', () => {
  test('every connection references a real joint', () => {
    for (const [a, b] of GHOST_CONNECTIONS) {
      assert.ok(a >= 0 && a < GHOST_JOINT_COUNT, `bad edge start ${a}`);
      assert.ok(b >= 0 && b < GHOST_JOINT_COUNT, `bad edge end ${b}`);
      assert.notEqual(a, b);
    }
  });

  test('joint indices are unique and within the 33-landmark pose', () => {
    assert.equal(new Set(GHOST_JOINTS).size, GHOST_JOINT_COUNT);
    for (const i of GHOST_JOINTS) assert.ok(i >= 0 && i < 33);
  });
});

/* ------------------------------------------------------------------ *
 * Record -> load round trip
 * ------------------------------------------------------------------ */

describe('record / load', () => {
  beforeEach(() => {
    g.localStorage = new MemoryStorage();
    ghosts.clearAll();
  });

  test('a run round-trips and reports its own duration and score', () => {
    assert.ok(recordRun('sixtyseven', 10));
    const ghost = ghosts.load('sixtyseven');
    assert.ok(ghost, 'expected a stored ghost');
    assert.equal(ghost.finalScore, 10);
    assert.ok(Math.abs(ghost.duration - 10) <= 1 / SAMPLE_HZ, `duration ${ghost.duration}`);
    assert.equal(ghost.sampleCount, 10 * SAMPLE_HZ + 1);
    assert.equal(ghost.hasPose, true);
  });

  test('scoreAt reproduces the recorded curve', () => {
    recordRun('sixtyseven', 20, 60, { score: (t) => Math.round(t * 3) });
    const ghost = ghosts.load('sixtyseven')!;
    for (let t = 0; t <= 20; t += 0.5) {
      assert.ok(
        Math.abs(ghost.scoreAt(t) - Math.round(t * 3)) <= 1,
        `t=${t} gave ${ghost.scoreAt(t)} not ~${Math.round(t * 3)}`
      );
    }
  });

  test('scoreAt always returns an integer', () => {
    recordRun('sixtyseven', 6, 60, { score: (t) => Math.round(t * 7) });
    const ghost = ghosts.load('sixtyseven')!;
    for (let t = 0; t < 6; t += 0.037) {
      assert.equal(Number.isInteger(ghost.scoreAt(t)), true, `t=${t}`);
    }
  });

  test('scoreAt clamps at both ends so a live player always has a target', () => {
    recordRun('sixtyseven', 5);
    const ghost = ghosts.load('sixtyseven')!;
    assert.equal(ghost.scoreAt(-3), 0);
    assert.equal(ghost.scoreAt(0), 0);
    assert.equal(ghost.scoreAt(999), ghost.finalScore);
    assert.equal(ghost.isRunning(2), true);
    assert.equal(ghost.isRunning(99), false);
  });

  test('scoreAt is monotonic for a monotonic run', () => {
    recordRun('sixtyseven', 15, 60, { score: (t) => Math.round(t * 2.7) });
    const ghost = ghosts.load('sixtyseven')!;
    let prev = -1;
    for (let t = 0; t <= 15; t += 0.01) {
      const s = ghost.scoreAt(t);
      assert.ok(s >= prev, `went backwards at t=${t}: ${prev} -> ${s}`);
      prev = s;
    }
  });

  test('an irregular frame rate produces the same timeline as a steady one', () => {
    recordRun('sixtyseven', 12, 60, { score: (t) => Math.round(t * 4) });
    const steady = ghosts.load('sixtyseven')!;
    const steadyCurve = Array.from({ length: 120 }, (_, i) => steady.scoreAt(i / 10));

    g.localStorage = new MemoryStorage();
    ghosts.clearAll();

    // A stuttering 12 -> 60 fps run, the shape a real frame-budget wobble has.
    const rec = ghosts.record('sixtyseven');
    let t = 0;
    let i = 0;
    while (t <= 12) {
      rec.sample(t, Math.round(t * 4), poseAt(t));
      t += i++ % 7 === 0 ? 1 / 12 : 1 / 60;
    }
    rec.finish();

    const jittery = ghosts.load('sixtyseven')!;
    const jitteryCurve = Array.from({ length: 120 }, (_, k) => jittery.scoreAt(k / 10));
    for (let k = 0; k < steadyCurve.length; k++) {
      assert.ok(
        Math.abs(steadyCurve[k]! - jitteryCurve[k]!) <= 1,
        `sample ${k}: ${steadyCurve[k]} vs ${jitteryCurve[k]}`
      );
    }
  });

  test('poses round-trip within the 8-bit quantisation tolerance', () => {
    recordRun('sixtyseven', 8);
    const ghost = ghosts.load('sixtyseven')!;
    for (const t of [0, 1.5, 3.3, 7.9]) {
      const got = ghost.poseAt(t);
      assert.ok(got, `no pose at ${t}`);
      const want = poseAt(t);
      for (let j = 0; j < GHOST_JOINT_COUNT; j++) {
        const w = want[GHOST_JOINTS[j]!]!;
        const p = got.points[j]!;
        // 1/255 quantisation plus up to half a 10 Hz interpolation step.
        assert.ok(Math.abs(p.x - w.x) < 0.06, `t=${t} joint ${j} x ${p.x} vs ${w.x}`);
        assert.ok(Math.abs(p.y - w.y) < 0.02, `t=${t} joint ${j} y ${p.y} vs ${w.y}`);
        assert.equal(got.visible[j], true);
      }
    }
  });

  test('an invisible joint is marked not-visible so no limb is drawn to it', () => {
    const rec = ghosts.record('sixtyseven');
    for (let i = 0; i <= 120; i++) {
      const lm = poseAt(i / 60);
      lm[GHOST_JOINTS[12]!]!.visibility = 0; // right ankle out of frame
      rec.sample(i / 60, i, lm);
    }
    rec.finish();
    const pose = ghosts.load('sixtyseven')!.poseAt(1)!;
    assert.equal(pose.visible[12], false);
    assert.equal(pose.visible[0], true);
  });

  test('pose: false records a score-only ghost', () => {
    assert.ok(recordRun('runner', 10, 60, { pose: false }));
    const ghost = ghosts.load('runner')!;
    assert.equal(ghost.hasPose, false);
    assert.equal(ghost.poseAt(3), null);
    assert.equal(ghost.finalScore, 10);
    assert.ok(ghost.bytes < 2500, `score-only ghost was ${ghost.bytes} chars`);
  });
});

/* ------------------------------------------------------------------ *
 * What must NOT be saved
 * ------------------------------------------------------------------ */

describe('rejection', () => {
  beforeEach(() => {
    g.localStorage = new MemoryStorage();
    ghosts.clearAll();
  });

  test('a run under a second is not a race and is dropped', () => {
    assert.equal(recordRun('sixtyseven', 0.5), false);
    assert.equal(ghosts.load('sixtyseven'), null);
  });

  test('a zero score is dropped, like the leaderboard drops it', () => {
    assert.equal(recordRun('sixtyseven', 10, 60, { score: () => 0 }), false);
    assert.equal(ghosts.has('sixtyseven'), false);
  });

  test('only the best run is kept', () => {
    recordRun('sixtyseven', 10, 60, { score: (t) => Math.round(t * 5) }); // 50
    assert.equal(ghosts.load('sixtyseven')!.finalScore, 50);

    // A worse run must not replace it.
    assert.equal(recordRun('sixtyseven', 10, 60, { score: (t) => Math.round(t) }), false);
    assert.equal(ghosts.load('sixtyseven')!.finalScore, 50);

    // A better one must.
    assert.equal(recordRun('sixtyseven', 10, 60, { score: (t) => Math.round(t * 9) }), true);
    assert.equal(ghosts.load('sixtyseven')!.finalScore, 90);
  });

  test('cancel() throws the recording away', () => {
    const rec = ghosts.record('sixtyseven');
    for (let i = 0; i <= 600; i++) rec.sample(i / 60, i, poseAt(i / 60));
    rec.cancel();
    assert.equal(rec.finish(), false);
    assert.equal(ghosts.has('sixtyseven'), false);
  });

  test('starting a new recording cancels the previous one', () => {
    const first = ghosts.record('sixtyseven');
    for (let i = 0; i <= 300; i++) first.sample(i / 60, 999, poseAt(i / 60));
    ghosts.record('fruitninja');
    assert.equal(first.finish(), false);
    assert.equal(ghosts.has('sixtyseven'), false);
  });

  test('samples after finish() are ignored', () => {
    recordRun('sixtyseven', 5);
    const before = ghosts.load('sixtyseven')!.sampleCount;
    ghosts.sample(99, 100000);
    assert.equal(ghosts.load('sixtyseven')!.sampleCount, before);
  });
});

/* ------------------------------------------------------------------ *
 * Version drift — the whole reason ghosts carry a version
 * ------------------------------------------------------------------ */

describe('version drift', () => {
  beforeEach(() => {
    g.localStorage = new MemoryStorage();
    ghosts.clearAll();
  });

  test('a ghost from an older scoring version is discarded, not shown', () => {
    recordRun('balloonpop', 8);
    // Deliberately NOT via ghosts.has(): that would warm the in-process cache,
    // and the real scenario is a NEW build reading an OLD row on boot.
    assert.ok(g.localStorage!.getItem(KEY('balloonpop')), 'expected a stored row');

    // The scoring rule changes and the build bumps the version.
    const original = SCORING_VERSION.balloonpop;
    SCORING_VERSION.balloonpop = original + 1;
    try {
      assert.equal(ghosts.load('balloonpop'), null, 'a stale ghost was served');
      assert.equal(
        g.localStorage!.getItem(KEY('balloonpop')),
        null,
        'a stale ghost must be deleted, not just hidden'
      );
    } finally {
      SCORING_VERSION.balloonpop = original;
    }
  });

  test('a ghost from a newer scoring version is discarded too (downgrade)', () => {
    const original = SCORING_VERSION.redlight;
    SCORING_VERSION.redlight = original + 5;
    recordRun('redlight', 8);
    SCORING_VERSION.redlight = original;
    try {
      assert.equal(ghosts.load('redlight'), null);
      assert.equal(g.localStorage!.getItem(KEY('redlight')), null);
    } finally {
      SCORING_VERSION.redlight = original;
    }
  });

  test('a ghost from an older FORMAT version is discarded', () => {
    recordRun('posematch', 8);
    const raw = JSON.parse(g.localStorage!.getItem(KEY('posematch'))!) as Record<string, unknown>;
    raw.f = 0;
    g.localStorage!.setItem(KEY('posematch'), JSON.stringify(raw));
    ghosts.clearAll(); // drop the in-memory cache, not the row
    g.localStorage!.setItem(KEY('posematch'), JSON.stringify(raw));

    assert.equal(ghosts.load('posematch'), null);
    assert.equal(g.localStorage!.getItem(KEY('posematch')), null);
  });

  test('corrupt JSON is discarded without throwing', () => {
    g.localStorage!.setItem(KEY('rhythm'), 'not json at all {{{');
    assert.equal(ghosts.load('rhythm'), null);
    assert.equal(g.localStorage!.getItem(KEY('rhythm')), null);
  });

  test('a ghost filed under the wrong game is discarded', () => {
    recordRun('sixtyseven', 8);
    const raw = g.localStorage!.getItem(KEY('sixtyseven'))!;
    g.localStorage!.setItem(KEY('fruitninja'), raw);
    assert.equal(ghosts.load('fruitninja'), null);
  });
});

/* ------------------------------------------------------------------ *
 * Storage budget — the numbers in the ghosts.ts header, checked
 * ------------------------------------------------------------------ */

describe('storage budget', () => {
  before(() => {
    g.localStorage = new MemoryStorage();
    ghosts.clearAll();
  });

  test('a worst-case 60s run stays inside the per-ghost ceiling', () => {
    assert.ok(recordRun('sixtyseven', 60, 60, { score: (t) => Math.round(t * 60) }));
    const chars = g.localStorage!.getItem(KEY('sixtyseven'))!.length;
    console.log(
      `      [budget] 60s pose+score ghost = ${chars} chars ` +
        `(${(chars / 1024).toFixed(1)} KB, ${((chars / MAX_GHOST_CHARS) * 100).toFixed(1)}% of the cap)`
    );
    assert.ok(chars < MAX_GHOST_CHARS, `${chars} exceeded the ${MAX_GHOST_CHARS} cap`);
    // The header claims ~24.5 KB. Hold it to that, not just to the hard cap.
    assert.ok(chars < 26 * 1024, `${chars} chars blows the documented ~24.5 KB budget`);
  });

  test('a full board of seven ghosts stays well inside a 5 MB quota', () => {
    const games = ['sixtyseven', 'fruitninja', 'redlight', 'runner', 'posematch', 'rhythm', 'balloonpop'] as const;
    g.localStorage = new MemoryStorage();
    ghosts.clearAll();
    for (const game of games) {
      assert.ok(recordRun(game, 60, 60, { score: (t) => Math.round(t * 60) }), `${game} did not save`);
    }
    const b = ghosts.budget();
    console.log(
      `      [budget] 7 ghosts = ${b.totalChars} chars ` +
        `(~${((b.totalChars * 2) / 1024).toFixed(0)} KB as UTF-16, ` +
        `${(((b.totalChars * 2) / (5 * 1024 * 1024)) * 100).toFixed(1)}% of a 5 MB quota)`
    );
    assert.equal(b.perGhost.length, 7);
    assert.ok(b.totalChars < 200 * 1024, `${b.totalChars} chars is over the documented budget`);
    assert.ok(b.totalChars < b.limitChars);
  });

  test('a run longer than the cap does not grow the recording without bound', () => {
    g.localStorage = new MemoryStorage();
    ghosts.clearAll();
    // 5 minutes — impossible under the 60s turn cap, but a stuck round must not
    // be able to allocate its way through the quota.
    assert.ok(recordRun('sixtyseven', 300, 30, { score: (t) => Math.round(t) }));
    const chars = g.localStorage!.getItem(KEY('sixtyseven'))!.length;
    assert.ok(chars < MAX_GHOST_CHARS, `${chars} chars from a 300s run`);
    // Against the CONSTANT, not a literal. This read `<= 64.1` and broke the
    // moment MAX_SECONDS was raised to cover a 1.5x-scaled round — which is a
    // legitimate change, so the test should have been tracking the cap rather
    // than a copy of it.
    assert.ok(ghosts.load('sixtyseven')!.duration <= MAX_SECONDS + 0.1);
  });
});

/* ------------------------------------------------------------------ *
 * Storage failure — the kiosk must never go down for this
 * ------------------------------------------------------------------ */

describe('storage failure', () => {
  test('survives localStorage being absent entirely (private mode)', () => {
    const saved = g.localStorage;
    delete g.localStorage;
    try {
      ghosts.clearAll();
      assert.equal(recordRun('sixtyseven', 10), false);
      assert.equal(ghosts.load('sixtyseven'), null);
      assert.equal(ghosts.has('sixtyseven'), false);
      assert.deepEqual(ghosts.budget().perGhost, []);
    } finally {
      g.localStorage = saved;
      ghosts.clearAll();
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
      ghosts.clearAll();
      assert.equal(recordRun('sixtyseven', 10), false);
      assert.equal(ghosts.load('sixtyseven'), null);
    } finally {
      g.localStorage = saved;
      ghosts.clearAll();
    }
  });

  test('clear and clearAll remove rows without throwing', () => {
    g.localStorage = new MemoryStorage();
    ghosts.clearAll();
    recordRun('sixtyseven', 5);
    recordRun('fruitninja', 5);
    assert.equal(ghosts.budget().perGhost.length, 2);
    ghosts.clear('sixtyseven');
    assert.equal(ghosts.budget().perGhost.length, 1);
    ghosts.clearAll();
    assert.equal(ghosts.budget().totalChars, 0);
  });
});
