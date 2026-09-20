/**
 * RED LIGHT'S ELIMINATION RULE.
 *
 * The worst thing this stall can do is eliminate somebody who was standing
 * still, in front of their friends, with no way for a marshal to give the
 * round back. `redlight.ts`'s own header puts it as the difference between
 * "funny" and "infuriating".
 *
 * Until now that rule was covered by two things, neither of which pins it. The
 * smoke probe drives a real round and asserts individual judging, but it is
 * deliberately tolerant — "one honest player being caught is within the
 * signal's real spread" — because it runs against a noisy detector. And
 * README.md records "0 false eliminations in a full 45s round", measured once,
 * months of commits ago.
 *
 * `judgeRedLight` is the decision itself, so the three properties that matter
 * can be checked exactly rather than sampled.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { judgeRedLight, DEFAULT_REDLIGHT_TUNABLES } from '../src/games/redlight.ts';

const FRAME = 1 / 60;
const BREACH = 0.3;

const step = (
  breach: number,
  moving: boolean,
  judging = true,
  settled = true
): ReturnType<typeof judgeRedLight> =>
  judgeRedLight(breach, { moving, judging, settled, dt: FRAME, breachSec: BREACH });

describe('nobody is eliminated for standing still', () => {
  /**
   * THE PROPERTY THE WHOLE GAME RESTS ON. A detector at 3m under hall lighting
   * produces brief excursions above the threshold; a person who is actually
   * moving produces sustained ones. Resetting on every still frame is what
   * tells those apart, and it is one line that would be easy to "simplify"
   * into a decaying counter by someone who did not know why.
   */
  test('a breach resets completely on a single still frame', () => {
    let breach = 0;
    // Noise: two moving frames, one still, forever. Never accumulates.
    for (let i = 0; i < 600; i++) {
      const moving = i % 3 !== 2;
      const r = step(breach, moving);
      breach = r.breach;
      assert.equal(r.eliminate, false, `eliminated on frame ${i} of noise`);
    }
    assert.ok(breach < BREACH, 'noise accumulated into a real breach');
  });

  test('but sustained movement does eliminate, at the stated time', () => {
    let breach = 0;
    let firedAt = -1;
    for (let i = 0; i < 600; i++) {
      const r = step(breach, true);
      breach = r.breach;
      if (r.eliminate) {
        firedAt = (i + 1) * FRAME;
        break;
      }
    }
    assert.ok(firedAt > 0, 'continuous movement was never judged');
    // Within one frame of breachSec, and never EARLY.
    assert.ok(firedAt >= BREACH, `fired at ${firedAt}s, before breachSec`);
    assert.ok(firedAt < BREACH + FRAME * 2, `fired late at ${firedAt}s`);
  });

  /**
   * The near-miss that is nearly a breach. Somebody who moves for almost long
   * enough and stops has to survive — that is the moment the game is played
   * for.
   */
  test('stopping just short survives, and survives the next light too', () => {
    let breach = 0;
    const framesJustShort = Math.floor(BREACH / FRAME) - 1;
    for (let i = 0; i < framesJustShort; i++) {
      const r = step(breach, true);
      breach = r.breach;
      assert.equal(r.eliminate, false);
    }
    // Stop.
    const stopped = step(breach, false);
    assert.equal(stopped.eliminate, false);
    assert.equal(stopped.breach, 0, 'a stop must clear the debt, not bank it');
  });
});

describe('the grace window', () => {
  test('movement before judging opens is never an elimination', () => {
    let breach = 0;
    for (let i = 0; i < 600; i++) {
      const r = step(breach, true, /* judging */ false);
      breach = r.breach;
      assert.equal(r.eliminate, false, `judged during the grace on frame ${i}`);
    }
  });

  /**
   * Reaction time is not disobedience. Moving inside the grace is the near
   * miss the game celebrates, so the flag has to be raised there and NOT once
   * judging has opened — by then it is a foul, not a near miss.
   */
  test('moving inside the grace is a near miss, not after', () => {
    assert.equal(step(0, true, false).nearMiss, true);
    assert.equal(step(0, false, false).nearMiss, false);
    assert.equal(step(0, true, true).nearMiss, false);
  });

  test('the breach clock still runs during the grace', () => {
    // So somebody who never stops is judged promptly once it opens, rather
    // than being handed the grace period twice.
    const r = step(0, true, false);
    assert.ok(r.breach > 0);
  });
});

describe('a player who just walked in', () => {
  /**
   * Walking into frame must never mean walking straight out of the round.
   * `settle` is the immunity, and while it holds the breach must be CARRIED,
   * not cleared — clearing it would hand a repeat offender a fresh start every
   * time the tracker blinked.
   */
  test('is immune, and their breach is carried rather than reset', () => {
    const r = step(0.25, true, true, /* settled */ false);
    assert.equal(r.eliminate, false);
    assert.equal(r.breach, 0.25, 'immunity must not clear an existing breach');
    assert.equal(r.nearMiss, false);
  });

  test('and is judged normally the moment the immunity expires', () => {
    // A breach one frame short of the limit: immune, it is carried untouched;
    // settled, the same frame takes it over and fires.
    const nearly = BREACH - FRAME / 2;
    assert.equal(step(nearly, true, true, false).eliminate, false);
    const r = step(nearly, true, true, true);
    assert.ok(r.breach > nearly);
    assert.equal(r.eliminate, true);
  });
});


/**
 * THE THRESHOLD TABLE IN THE COMMENTS IS THE ONLY EXPLANATION OF THIS NUMBER.
 *
 * Red Light's elimination threshold is the constant the runbook describes as
 * "too low and everyone is out in two seconds, unrecoverable at a stall". It
 * is not one number but three, combined affinely:
 *
 *   threshold = moveEnter + min(quiet, moveEnter x quietCeiling) x quietMult
 *
 * Two comments describing it had gone stale in different ways. One still
 * described a PURE MULTIPLE model the code had stopped using, and reasoned
 * about a value of 2.0 while the constant was 1.6. The other stated the fitted
 * line as "1.1 + 1.45x" with per-regime landings, where the shipped slope is
 * 1.6 and the hostile figure had been computed without the ceiling.
 *
 * Nobody could have caught either by reading: both are internally consistent
 * and only wrong against a constant several hundred lines away. So the table
 * is recomputed here from the constants themselves.
 */
describe('the elimination threshold lands where its comment says', () => {
  const { moveEnter, quietMult, quietCeiling } = DEFAULT_REDLIGHT_TUNABLES;
  const thresholdFor = (noiseFloor: number): number =>
    moveEnter + Math.min(noiseFloor, moveEnter * quietCeiling) * quietMult;

  /**
   * The three noise regimes the design was fitted against, with the window
   * each one's threshold has to land in — still p90 below it, moving p10
   * above. Hostile has no window: the two distributions have crossed.
   */
  const REGIMES: ReadonlyArray<readonly [string, number, number, number]> = [
    ['clean', 0.27, 0.4, 4.1],
    ['realistic', 2.28, 3.5, 5.2],
  ];

  for (const [name, floor, lo, hi] of REGIMES) {
    test(`${name} noise puts the threshold inside its window`, () => {
      const t = thresholdFor(floor);
      assert.ok(
        t >= lo && t <= hi,
        `a ${name} room's noise floor of ${floor} gives a threshold of ` +
          `${t.toFixed(2)}, outside the ${lo}-${hi} window. Below it, a still ` +
          `player is eliminated; above it, a moving one is never caught.`
      );
    });
  }

  /** The ceiling is what stops a hostile room from running away entirely. */
  test('and the ceiling caps what a hostile room can claim is still', () => {
    const cap = moveEnter * quietCeiling;
    assert.ok(
      thresholdFor(3.89) === moveEnter + cap * quietMult,
      'a hostile floor is no longer capped, so somebody flailing through the ' +
        'lobby can train the detector to ignore them'
    );
  });

  /**
   * And the numbers written in the file are the numbers the file computes.
   * This is the guard the two stale comments needed: the table is parsed out
   * of the source and checked against the constants.
   */
  test('the table in the source is recomputed, not remembered', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/games/redlight.ts', 'utf8');

    // PARSE FROM THE HEADER, not by pattern alone. My first version matched
    // `(clean|realistic)` anywhere and found the PERCENTILE table thirty lines
    // earlier — "clean still 0.23 0.28 0.35" — and reported 0.35 as a claimed
    // threshold. redlight.ts has several tables and they all start with the
    // same two words.
    const header = src.indexOf('regime      noise floor   threshold');
    assert.ok(header > 0, 'the threshold table has moved or lost its header');
    const table = src.slice(header, header + 400);

    const rows = [...table.matchAll(/\/\/\s+(clean|realistic)\s+([\d.]+)(?:\s*->\s*[\d.]+)?\s+([\d.]+)\s/g)];
    assert.ok(rows.length >= 2, 'the threshold table is gone from redlight.ts');

    for (const [, name, floorText, statedText] of rows) {
      const real = thresholdFor(Number(floorText));
      assert.ok(
        Math.abs(real - Number(statedText)) < 0.05,
        `the ${name} row claims a threshold of ${statedText} for a floor of ` +
          `${floorText}; the constants give ${real.toFixed(2)}`
      );
    }
  });
});


/**
 * THE STOPPING BUDGET IS QUOTED FOUR TIMES AND THREE OF THEM HAD DRIFTED.
 *
 * `graceSec + breachSec` is how long a player has to stop after the light
 * turns. redlight.ts stated it in four places and they disagreed with each
 * other: 0.85s, 1.05s, 1.2s — and the file HEADER, describing the one number
 * it says is "not tuning", called the grace 400ms when the constant is 750.
 *
 * Every one of them was correct when it was written. `graceSec` went 0.55 ->
 * 0.75 from the playtest's "red light freezes too fast", and `breachSec` went
 * 0.30 -> 0.45 independently; each change updated its own comment and none
 * updated the others.
 *
 * So the budget is computed here and the file is made to agree with it.
 */
describe('the stopping budget is what the file says it is', () => {
  const { graceSec, breachSec, energyTau } = DEFAULT_REDLIGHT_TUNABLES;
  const budget = graceSec + breachSec;

  const source = async (): Promise<string> => {
    const { readFile } = await import('node:fs/promises');
    return readFile('src/games/redlight.ts', 'utf8');
  };

  test('every "graceSec + breachSec = Ns" in the file is the real sum', async () => {
    const src = await source();
    const quoted = [...src.matchAll(/graceSec \+ breachSec[^.\n]*?=\s*([\d.]+)s/g)].map((m) =>
      Number(m[1])
    );
    assert.ok(quoted.length > 0, 'the file stopped stating the stopping budget');

    const wrong = quoted.filter((q) => Math.abs(q - budget) > 0.005);
    assert.deepEqual(
      wrong,
      [],
      `the file quotes ${wrong.join(', ')}s for a budget that is ` +
        `${budget.toFixed(2)}s (graceSec ${graceSec} + breachSec ${breachSec})`
    );
  });

  /**
   * The header is the first thing anybody reads about this game, and it names
   * the grace as the one thing that is not tuning.
   */
  test('and the header quotes the real grace period', async () => {
    const src = await source();
    const m = /`graceSec` \((\d+)ms\) of red/.exec(src);
    assert.ok(m, 'the header stopped naming the grace period');
    assert.equal(
      Number(m[1]),
      Math.round(graceSec * 1000),
      `the header says ${m[1]}ms; graceSec is ${graceSec * 1000}ms. It calls ` +
        `this the one number that is not tuning.`
    );
  });

  /**
   * And the settling subtraction: judging at exactly `graceSec` would spend
   * part of the grace on the smoother still reporting the flail.
   */
  test('and the effective grace after settling is the one quoted', async () => {
    const src = await source();
    const m = /turn a (\d+)ms grace into a (\d+)ms one/.exec(src);
    assert.ok(m, 'the settling note stopped quoting the grace it costs');
    assert.equal(Number(m[1]), Math.round(graceSec * 1000), 'the stated grace is not graceSec');
    assert.equal(
      Number(m[2]),
      Math.round((graceSec - energyTau * 3) * 1000),
      `judging at graceSec leaves ${((graceSec - energyTau * 3) * 1000).toFixed(0)}ms, ` +
        `not the ${m[2]}ms quoted`
    );
  });
});


/**
 * A NUMBER DERIVED FROM CONSTANTS MUST BE CURRENT, OR SAY WHICH ONES MADE IT.
 *
 * `quietCeiling x moveEnter` is quoted twice in redlight.ts, in two arguments
 * about why a frozen player used to be eliminated. Both said 1.615, and one of
 * them said "with the shipped numbers". The shipped numbers are 2.3 and 1.1,
 * so the product is 2.53; 1.615 is 1.9 x 0.85, the pair from an earlier
 * design.
 *
 * The arguments are still worth keeping — they explain why the ceiling now
 * bounds the learned floor rather than the threshold — but a historical figure
 * presented as current is worse than no figure, because the second one claimed
 * the product sat BELOW a noise floor of ~2 when today it sits above it. The
 * sentence argued for its own conclusion using numbers that no longer support
 * it.
 *
 * So: either the product is today's, or the comment names the constants it was
 * computed from. That is the rule this checks.
 */
describe('a derived number is current or dated', () => {
  const { moveEnter, quietCeiling } = DEFAULT_REDLIGHT_TUNABLES;

  test('every quoted quietCeiling x moveEnter is right or says whose it is', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/games/redlight.ts', 'utf8');
    const product = moveEnter * quietCeiling;

    const quotes = [
      ...src.matchAll(/`(?:quietCeiling \* moveEnter|moveEnter \* quietCeiling)`[^\n]{0,80}?([\d.]+)/g),
    ];
    assert.ok(quotes.length > 0, 'the file stopped quoting the ceiling product');

    const bad: string[] = [];
    for (const m of quotes) {
      const stated = Number(m[1]);
      if (Math.abs(stated - product) < 0.005) continue;
      // Otherwise it must name the constants it came from, within the sentence.
      const after = src.slice(m.index ?? 0, (m.index ?? 0) + 260);
      if (/quietCeiling [\d.]+, moveEnter [\d.]+/.test(after)) continue;
      bad.push(String(stated));
    }
    assert.deepEqual(
      bad,
      [],
      `these are quoted as the ceiling product without saying they are ` +
        `historical: ${bad.join(', ')}. Today it is ${product.toFixed(2)} ` +
        `(quietCeiling ${quietCeiling} x moveEnter ${moveEnter}).`
    );
  });

  /**
   * AND THE CURRENT ONE HAS TO BE STATED SOMEWHERE.
   *
   * "Current or dated" is satisfied if EVERY quote is dated — and then the
   * file never says what the product is today, so moving a constant breaks
   * nothing and a reader has to do the arithmetic themselves. Mutating
   * `quietCeiling` to 3.0 passed until this was added.
   */
  test('and the file states what the product is today', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/games/redlight.ts', 'utf8');
    const product = moveEnter * quietCeiling;

    const m = /Today the same product is ([\d.]+)/.exec(src);
    assert.ok(
      m,
      'nothing says what `quietCeiling x moveEnter` is NOW, so both quotes ' +
        'are historical and the current value is left to the reader'
    );
    assert.ok(
      Math.abs(Number(m[1]) - product) < 0.005,
      `the file says the product is ${m[1]} today; the constants give ` +
        `${product.toFixed(2)}`
    );
  });
});
