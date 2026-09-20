/**
 * THE ATTRACT SCREEN NEVER SHOWED ANYBODY PLAYING.
 *
 * PLAN.md §6 lists "looping highlight clips" as part of the foot-traffic
 * engine, and `attract.ts` imported nothing from `meta/highlights.ts`. A clip
 * only ever replayed on the same player's own results screen, seconds after
 * their own round — so the one screen the stall stares at for eight hours, the
 * one whose entire job is pulling a stranger out of a corridor, showed a live
 * silhouette of an empty room and a leaderboard.
 *
 * The blocker was real and is the reason this is tested rather than eyeballed:
 * exactly ONE clip exists. Capture swaps the rolling and saved atlases, so the
 * next capture overwrites the last one. A reel needs a backlog, and a backlog
 * is more canvas backing store on a machine where the measured failure mode is
 * a CLIFF in total allocation — past ~20 MB every blit became a readback and a
 * frame cost 448 ms.
 *
 * So these tests are mostly about the two things that cannot be checked by
 * looking at the screen: what the reel COSTS, and that it gives that cost back
 * first when anything goes wrong.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  highlights,
  DEFAULT_CONFIG,
  REEL_SLOTS,
  REEL_SECONDS,
  REEL_MAX_BYTES,
  MAX_BYTES,
} from '../src/meta/highlights.ts';

/* ------------------------------------------------------------------ *
 * A canvas that records instead of painting
 * ------------------------------------------------------------------ */

interface Blit {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

let costPerBlitMs = 0;

class FakeCtx {
  blits: Blit[] = [];
  imageSmoothingEnabled = true;
  imageSmoothingQuality = 'low';
  fillStyle = '';
  shadowBlur = 0;
  save(): void {}
  restore(): void {}
  fillRect(): void {}
  drawImage(_img: unknown, ...a: number[]): void {
    if (costPerBlitMs > 0) {
      const until = performance.now() + costPerBlitMs;
      while (performance.now() < until) {
        /* the cost guard measures wall clock; this is the only way to spend it */
      }
    }
    if (a.length === 8) {
      this.blits.push({
        sx: a[0]!, sy: a[1]!, sw: a[2]!, sh: a[3]!,
        dx: a[4]!, dy: a[5]!, dw: a[6]!, dh: a[7]!,
      });
    }
  }
}

class FakeCanvas {
  width: number;
  height: number;
  ctx = new FakeCtx();
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  getContext(): FakeCtx {
    return this.ctx;
  }
}

(globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = FakeCanvas;

/** The main canvas the buffer grabs from. */
const source = new FakeCanvas(1600, 900) as unknown as HTMLCanvasElement;

/** A FrameContext with only the fields the reel touches. */
const frame = (now: number): { ctx: FakeCtx; now: number; v: { width: number; height: number } } => ({
  ctx: new FakeCtx(),
  now,
  v: { width: 1920, height: 1080 },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fc = (now: number): any => frame(now);

/** Fills the rolling buffer past the 1.5s floor `capture()` insists on. */
function fill(from = 0, frames = 24): number {
  let now = from;
  for (let i = 0; i < frames; i++) {
    highlights.tick(now);
    now += 1000 / DEFAULT_CONFIG.fps;
  }
  return now;
}

function reset(): void {
  costPerBlitMs = 0;
  highlights.setEnabled(true);
  highlights.setReelEnabled(true);
  highlights.configure({ ...DEFAULT_CONFIG });
  highlights.clearReel();
  highlights.resetStats();
  highlights.attach(source);
}

describe('the attract reel', () => {
  beforeEach(reset);

  test('a captured highlight joins the reel without being asked', () => {
    assert.equal(highlights.reelSize(), 0, 'the reel starts empty');
    fill();
    assert.equal(highlights.capture({ gameId: 'sixtyseven', score: 190 }), true);
    assert.equal(
      highlights.reelSize(),
      1,
      'capture() must enrol. There are two capture paths and there will be ' +
        'more; a reel you have to remember to fill is a reel that is empty on the day'
    );
  });

  /**
   * The ring is the point. Four slots, and the fifth highlight of the
   * afternoon takes the oldest one's place rather than being dropped — a
   * reel that stops updating after four rounds is worse than no reel,
   * because it goes stale without ever looking broken.
   */
  test('it holds four moments and then recycles the oldest', () => {
    let now = 0;
    const scores = [10, 20, 30, 40, 50, 60];
    for (const score of scores) {
      now = fill(now);
      assert.equal(highlights.capture({ gameId: 'balloonpop', score }), true);
    }
    assert.equal(highlights.reelSize(), REEL_SLOTS);
    assert.equal(highlights.reelStats().filled, REEL_SLOTS);
    assert.equal(highlights.reelStats().copies, scores.length);
  });

  /**
   * THE TAIL, NOT THE HEAD.
   *
   * The last two seconds of a top-five run contain the thing that made it a
   * top-five run. The first two contain somebody finding their feet. Checked
   * on the source rectangles because it is invisible in any other way: both
   * versions produce a reel that plays.
   */
  test('it keeps the end of the clip, not the beginning', () => {
    fill(0, 64); // a full ring, so start != 0 and the arithmetic can be wrong
    const before = (highlights as unknown as { reelAtlas: { ctx: FakeCtx } | null }).reelAtlas;
    assert.equal(before, null);

    highlights.capture({ gameId: 'fruitninja', score: 900 });
    const atlas = (highlights as unknown as { reelAtlas: { ctx: FakeCtx } | null }).reelAtlas;
    assert.ok(atlas, 'the reel atlas was never allocated');
    const blits = atlas.ctx.blits;

    const cells = REEL_SECONDS * DEFAULT_CONFIG.fps;
    assert.equal(blits.length, cells, `copied ${blits.length} cells, expected ${cells}`);

    // Every source cell is a whole cell of the main atlas, and the run is
    // contiguous in ring order — the last `cells` frames of a full buffer.
    const cols = Math.ceil(Math.sqrt(DEFAULT_CONFIG.seconds * DEFAULT_CONFIG.fps));
    const idx = blits.map(
      (b) => (b.sy / DEFAULT_CONFIG.height) * cols + b.sx / DEFAULT_CONFIG.width
    );
    for (const i of idx) assert.ok(Number.isInteger(i), `source cell ${i} is not on the grid`);

    const total = DEFAULT_CONFIG.seconds * DEFAULT_CONFIG.fps;
    for (let k = 1; k < idx.length; k++) {
      assert.equal(
        idx[k],
        (idx[k - 1]! + 1) % total,
        `frames ${k - 1} -> ${k} are not consecutive; the copy is reading the wrong cells`
      );
    }
  });

  test('an empty reel draws nothing rather than a hole', () => {
    assert.equal(highlights.renderReel(fc(0), { x: 0, y: 0, w: 640, h: 360 }), null);
  });

  test('a filled reel reports what it drew so the caller can caption it', () => {
    fill();
    highlights.capture({ gameId: 'redlight', score: 296, label: 'NEW RECORD', initials: 'WAS' });
    const meta = highlights.renderReel(fc(0), { x: 0, y: 0, w: 640, h: 360 });
    assert.ok(meta, 'the reel had an entry and drew nothing');
    assert.equal(meta.gameId, 'redlight');
    assert.equal(meta.score, 296);
    assert.equal(meta.initials, 'WAS');
  });

  /**
   * Cycling is owned by the reel, not the caller: how long a moment holds the
   * screen is a property of the footage (`count / fps`), and attract has no
   * business knowing that.
   */
  test('it moves on to the next moment on its own', () => {
    let now = 0;
    for (const id of ['sixtyseven', 'balloonpop'] as const) {
      now = fill(now);
      highlights.capture({ gameId: id, score: 1 });
    }
    assert.equal(highlights.reelSize(), 2);

    const box = { x: 0, y: 0, w: 640, h: 360 };
    const first = highlights.renderReel(fc(0), box);
    assert.ok(first);

    // Still the same entry a fraction of a loop later.
    assert.equal(highlights.renderReel(fc(500), box)?.gameId, first.gameId);

    // Past REEL_LOOPS full plays of a REEL_SECONDS clip, it advances.
    const after = highlights.renderReel(fc(REEL_SECONDS * 2 * 1000 + 50), box);
    assert.ok(after);
    assert.notEqual(after.gameId, first.gameId, 'the reel is stuck on one moment');
  });

  /**
   * A viewport resize between capture and playback must not stretch anyone.
   * A reel entry can outlive one by hours — this screen runs unattended.
   */
  test('footage is letterboxed on the aspect it was captured at', () => {
    fill();
    highlights.capture({ gameId: 'runner', score: 1 });
    const f = frame(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    highlights.renderReel(f as any, { x: 100, y: 50, w: 400, h: 400 });
    const [b] = f.ctx.blits;
    assert.ok(b, 'nothing was drawn into the box');
    // Source is 1600x900, so a square box letterboxes vertically.
    assert.equal(Math.round(b.dw), 400);
    assert.equal(Math.round(b.dh), 225);
    assert.equal(Math.round(b.dy), 50 + Math.round((400 - 225) / 2));
  });

  /**
   * `configure()` calls `release()`, which drops both main atlases. The reel
   * must survive that: its entries are past rounds, and nothing can rebuild
   * them. An operator nudging the buffer size between rushes would otherwise
   * silently wipe the afternoon's highlights.
   */
  test('it survives a reconfigure of the main buffer', () => {
    fill();
    highlights.capture({ gameId: 'rhythm', score: 2400 });
    assert.equal(highlights.reelSize(), 1);
    highlights.configure({ seconds: 6 });
    assert.equal(highlights.reelSize(), 1, 'reconfiguring the buffer wiped the reel');
  });

  /* ---------------- the part that is actually about memory ---------------- */

  test('the reel costs what the note in the source says it costs', () => {
    fill();
    highlights.capture({ gameId: 'poses', score: 9 });
    const s = highlights.reelStats();

    assert.ok(s.bytes > 0, 'the reel reports no allocation at all');
    assert.ok(
      s.bytes <= REEL_MAX_BYTES,
      `the reel is ${(s.bytes / 1048576).toFixed(2)} MB, past its own ceiling`
    );

    // The figure the comment commits to, and the one the cliff table is read
    // against: two main atlases plus the reel.
    const total = highlights.stats().bytes + s.bytes;
    assert.ok(
      total < 24 * 1024 * 1024,
      `total canvas backing store is ${(total / 1048576).toFixed(2)} MB. The ` +
        `measured cliff was at 28 MB and the measured-good configuration was ` +
        `18.9 MB; past 24 this needs re-measuring on the real machine before shipping`
    );
    assert.ok(highlights.stats().bytes <= MAX_BYTES);
  });

  test('turning the reel off gives the memory back', () => {
    fill();
    highlights.capture({ gameId: 'poses', score: 9 });
    assert.ok(highlights.reelStats().bytes > 0);
    highlights.setReelEnabled(false);
    assert.equal(highlights.reelStats().bytes, 0, 'the atlas was kept for a feature nobody is showing');
    assert.equal(highlights.reelSize(), 0);
    assert.equal(highlights.renderReel(fc(0), { x: 0, y: 0, w: 10, h: 10 }), null);
  });

  test('the master switch governs it', () => {
    fill();
    highlights.capture({ gameId: 'poses', score: 9 });
    assert.ok(highlights.reelEnabled);
    highlights.setEnabled(false);
    assert.equal(highlights.reelEnabled, false, 'highlights off must mean the reel is off too');
  });

  /**
   * THE REEL GOES FIRST.
   *
   * The failure at the top of highlights.ts is a cliff in TOTAL allocation, so
   * handing back 2.36 MB can move the whole app back over it. A replay on the
   * results screen is worth more than a loop in a corner, and this is the only
   * shed step that costs nothing a player can see.
   */
  test('it is the first thing dropped when the buffer starts costing too much', () => {
    fill();
    highlights.capture({ gameId: 'poses', score: 9 });
    assert.equal(highlights.reelSize(), 1);
    assert.equal(highlights.stats().shedLevel, 0);

    // GRAB_BUDGET_MS is 4, over a 16-grab window after an 8-grab grace.
    costPerBlitMs = 6;
    fill(1e6, 30);
    costPerBlitMs = 0;

    const s = highlights.stats();
    assert.ok(s.shedLevel >= 1, `the cost guard never fired (mean ${s.avgGrabMs.toFixed(2)}ms)`);
    assert.equal(highlights.reelSize(), 0, 'the reel survived a shed');
    assert.equal(highlights.reelStats().bytes, 0, 'the reel atlas was kept after a shed');
    assert.equal(
      s.shedLevel,
      1,
      'the reel should have absorbed the FIRST shed on its own, without the ' +
        'main buffer also halving its cell'
    );
    assert.equal(highlights.enabled, true, 'shedding the reel must not disable replays');
  });
});

/**
 * A THING THAT CAN SWITCH ITSELF OFF MUST SAY SO SOMEWHERE.
 *
 * Same rule the storage flags earned the hard way: the leaderboard could stop
 * writing to disk and nothing anywhere reported it, so play carried on, scores
 * appeared, and the first reload threw the afternoon away.
 *
 * The highlight buffer is the same shape and larger — 18.9 MB plus the reel,
 * with a cost guard that drops both silently. On the wrong laptop "the replays
 * stopped" and "the screen stutters" are one event, and before these surfaces
 * existed there was no way to tell them apart from outside the process.
 *
 * Source-text guards, like tests/diagnostics.test.ts, because what is being
 * protected is that a HUMAN-VISIBLE surface exists at all — which is not
 * something the module under test can assert about itself.
 */
describe('the shed is visible from outside', () => {
  const read = async (f: string): Promise<string> => {
    const { readFile } = await import('node:fs/promises');
    return readFile(f, 'utf8');
  };

  test('the d overlay reports the buffer, the shed and the reel', async () => {
    const src = await read('src/shell/debug.ts');
    assert.match(src, /from '\.\.\/meta\/highlights'/, 'debug.ts does not read the buffer at all');
    assert.match(src, /shedLevel/, 'the overlay never mentions a shed, which is the whole failure');
    assert.match(src, /label: 'reel'/, 'no reel row, so 0/4 an hour in looks like 0/4 on boot');
  });

  test('the operator console can undo a shed', async () => {
    const src = await read('src/shell/operator.ts');
    assert.match(src, /from '\.\.\/meta\/highlights'/, 'the console cannot see the buffer');
    assert.match(src, /setReelEnabled/, 'no switch for the reel');
    assert.match(src, /setEnabled/, 'no switch for replays');
    assert.match(
      src,
      /shedLevel/,
      'the console shows no shed state, so a marshal cannot tell a laptop that ' +
        'shed from one that was never asked to record'
    );
  });

  /**
   * Re-enabling is an explicit "try again". Clearing the shed level but
   * leaving the reel permanently dead makes the console's own switch a
   * half-measure — and the reel is the first thing the guard takes, so it is
   * the thing most likely to need reviving.
   */
  test('turning replays back on revives the reel', () => {
    costPerBlitMs = 0;
    highlights.setEnabled(true);
    highlights.setReelEnabled(true);
    highlights.configure({ ...DEFAULT_CONFIG });
    highlights.clearReel();
    highlights.attach(source);

    fill();
    highlights.capture({ gameId: 'poses', score: 9 });
    costPerBlitMs = 6;
    fill(2e6, 30);
    costPerBlitMs = 0;
    assert.equal(highlights.reelEnabled, false, 'the guard did not take the reel');

    highlights.setEnabled(true);
    assert.equal(highlights.reelEnabled, true, 'the reel stayed dead after an explicit re-enable');

    fill(3e6);
    assert.equal(highlights.capture({ gameId: 'poses', score: 11 }), true);
    assert.equal(highlights.reelSize(), 1, 'the revived reel does not accept new highlights');
  });
});
