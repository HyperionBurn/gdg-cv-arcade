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

import { FruitNinjaGame } from '../src/games/fruitninja.ts';
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
  /**
   * ONE HITCH MUST NOT COST THE FEATURE.
   *
   * Found by running a real turn sweep rather than by reading the code: a
   * single 121.6 ms blit carried a 16-grab window's mean to 5.99 ms against a
   * 4 ms budget, and the buffer shed three times in fourteen seconds — reel
   * gone, cell halved, replays off — and stayed off, because a shed is only
   * undone by an operator. A GC pause is not a GPU cliff.
   */
  test('a single bad window is a hitch, not a cliff', () => {
    fill();
    highlights.capture({ gameId: 'poses', score: 9 });

    costPerBlitMs = 6;
    fill(4e6, 24); // grace (8) + one full window (16), all over budget
    costPerBlitMs = 0;
    fill(5e6, 16); // and one clean window, which clears the strike
    fill(6e6, 16);

    assert.equal(
      highlights.stats().shedLevel,
      0,
      'an isolated slow window shed the buffer; strikes are not consecutive'
    );
    assert.equal(highlights.reelSize(), 1, 'the reel was dropped over one hitch');
  });

  /**
   * AND A FAST-FORWARD IS NOT EVIDENCE EITHER.
   *
   * `__arcade.tick()` drives a synthetic clock, so grabs that are 125 ms apart
   * at the stall land microseconds apart with the GPU never idle. Measured on
   * the same machine, same canvas: 0.07 ms mean at the real cadence, 4.20 ms
   * mean under a turn sweep. A full `__arcade.turn()` — the documented way to
   * check the app still works — therefore ended with replays disabled and the
   * reel gone, and the `d` overlay would have said the feature was broken.
   *
   * Capture must keep running under it: the turn sweep is how we know a real
   * round enrols into the reel at all.
   */
  test('a fast-forwarded clock still captures but is never judged', () => {
    highlights.setSynthetic(true);
    costPerBlitMs = 6;
    fill(7e6, 64); // four full windows' worth, every one far over budget
    costPerBlitMs = 0;

    assert.equal(highlights.stats().shedLevel, 0, 'a synthetic run shed the buffer');
    assert.ok(highlights.stats().grabs > 0, 'capture stopped under the fast-forward');
    assert.equal(
      highlights.capture({ gameId: 'poses', score: 9 }),
      true,
      'a round played under the harness could not produce a highlight'
    );
    assert.equal(highlights.reelSize(), 1, 'and it did not reach the reel');

    // Handing the real clock back re-arms the guard rather than judging it on
    // the window the fast-forward just filled.
    highlights.setSynthetic(false);
    costPerBlitMs = 6;
    fill(8e6, 48);
    costPerBlitMs = 0;
    assert.ok(highlights.stats().shedLevel >= 1, 'the guard never came back');
  });

  test('it is the first thing dropped when the buffer starts costing too much', () => {
    fill();
    highlights.capture({ gameId: 'poses', score: 9 });
    assert.equal(highlights.reelSize(), 1);
    assert.equal(highlights.stats().shedLevel, 0);

    // GRAB_BUDGET_MS is 4, over a 16-grab window after an 8-grab grace, and
    // GUARD_STRIKES requires TWO consecutive bad windows: 8 + 16 + 16 = 40.
    costPerBlitMs = 6;
    fill(1e6, 48);
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
    fill(2e6, 48);
    costPerBlitMs = 0;
    assert.equal(highlights.reelEnabled, false, 'the guard did not take the reel');

    highlights.setEnabled(true);
    assert.equal(highlights.reelEnabled, true, 'the reel stayed dead after an explicit re-enable');

    fill(3e6);
    assert.equal(highlights.capture({ gameId: 'poses', score: 11 }), true);
    assert.equal(highlights.reelSize(), 1, 'the revived reel does not accept new highlights');
  });
});


/**
 * "ON A TOP-5 SCORE OR A BIG COMBO" — AND ONLY THE FIRST HALF EXISTED.
 *
 * `captureIfWorthy` fires once, at the end of a round, if the score placed.
 * `isWorthReplaying`'s own comment says "a screen can also call `capture()`
 * directly for a combo or a knockout", and no screen ever did.
 *
 * It matters more now that captures feed the attract reel. Top-5 is common on
 * the morning of day one, when every board is empty, and rare by the afternoon
 * once they fill — so a reel driven by scores alone goes stale exactly as the
 * hall gets busy.
 *
 * Both guards here protect the feature that already worked. `capture()` SWAPS
 * atlases, so the rolling buffer restarts empty: a combo captured in the last
 * seconds of a round would leave less than the 1.5s of footage `capture()`
 * insists on, and the end-of-round replay — the one a player stands and
 * watches — would silently not happen.
 */
interface MomentProbe {
  timeLeft: number;
  roundTotal: number;
  captureMoment(label: string, score: number): boolean;
  capturedThisRound: boolean;
}

function playing(): MomentProbe {
  const g = new FruitNinjaGame() as unknown as MomentProbe;
  g.roundTotal = 60;
  g.timeLeft = 60;
  return g;
}

describe('a big combo is a highlight too', () => {
  beforeEach(() => {
    reset();
    fill();
  });

  test('a moment mid-round reaches the reel', () => {
    const g = playing();
    g.timeLeft = 40;
    assert.equal(g.captureMoment('5-FRUIT SLICE', 420), true);
    assert.equal(highlights.reelSize(), 1);
    assert.equal(highlights.reelStats().showing, 'fruitninja');
  });

  /**
   * THE ONE THAT PROTECTS THE FEATURE THAT ALREADY WORKED. A capture near the
   * end leaves the buffer empty, and the end-of-round replay needs 1.5s of
   * footage — so a player who just set a record would watch nothing.
   */
  test('but never close enough to the end to cost the replay its footage', () => {
    const g = playing();
    g.timeLeft = 2;
    assert.equal(
      g.captureMoment('5-FRUIT SLICE', 420),
      false,
      'a combo in the last seconds stole the end-of-round replay'
    );
    assert.equal(highlights.reelSize(), 0);
  });

  /**
   * Fruit Ninja can throw three big chains in four seconds and each capture
   * discards the last. The reel wants four DIFFERENT moments across a day, not
   * four frames of the same swipe.
   */
  test('and not four times in one swipe', () => {
    const g = playing();
    g.timeLeft = 50;
    assert.equal(g.captureMoment('4-FRUIT SLICE', 100), true);

    // REFILL FIRST. Without this the buffer is empty after the swap and
    // `capture()` refuses on its own, so the test passes whether the spacing
    // guard exists or not — which is exactly what it did until mutating the
    // guard away left it green.
    fill(9e6);
    g.timeLeft = 48; // two seconds later
    assert.equal(
      g.captureMoment('5-FRUIT SLICE', 200),
      false,
      'a second chain two seconds later discarded the first clip'
    );

    fill(9.5e6);
    g.timeLeft = 40; // ten seconds after the first
    assert.equal(g.captureMoment('6-FRUIT SLICE', 300), true, 'the spacing never re-opens');
  });

  /**
   * `capturedThisRound` gates the RESULTS replay. A mid-round clip is not what
   * somebody who just finished wants to watch, and if their score placed the
   * end-of-round capture overwrites it anyway.
   */
  test('a moment does not become the results replay', () => {
    const g = playing();
    g.timeLeft = 40;
    g.capturedThisRound = false;
    g.captureMoment('5-FRUIT SLICE', 420);
    assert.equal(
      g.capturedThisRound,
      false,
      'a mid-round combo would now replay over the player’s own results'
    );
  });

  test('and the spacing resets for the next player', () => {
    const g = playing();
    g.timeLeft = 50;
    assert.equal(g.captureMoment('4-FRUIT SLICE', 100), true);

    // A fresh round: `enter('playing')` clears the timer, which is what stops
    // one player's chain silencing the next player's.
    (g as unknown as { lastMomentAt: number }).lastMomentAt = -Infinity;
    fill(1e7);
    g.timeLeft = 50;
    assert.equal(g.captureMoment('4-FRUIT SLICE', 100), true);
  });
});

/** The game that actually calls it. */
describe('Fruit Ninja asks for a clip on a big chain', () => {
  test('it calls captureMoment, past a quad', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/games/fruitninja.ts', 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    assert.match(code, /this\.captureMoment\s*\(/, 'nothing in Fruit Ninja asks for a clip');
    assert.match(code, /chain\s*>=\s*4/, 'the chain threshold for a clip is gone');
  });
});
