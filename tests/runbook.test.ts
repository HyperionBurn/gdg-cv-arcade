/**
 * THE RUNBOOK IS READ UNDER PRESSURE AND CANNOT BE WRONG.
 *
 * README.md's day-of card and its "numbers that have never seen a real body"
 * table are what somebody works from while holding a laptop in a loud room. A
 * stale figure there is worse than a stale comment in the source, because the
 * person reading it has no way to check and no time to.
 *
 * It had already drifted. `moveEnter` was documented at 0.85 and is 1.1 — the
 * one constant whose risk column reads "too low and everyone is out in two
 * seconds, unrecoverable at a stall", so the table was understating the safe
 * value on exactly the number where being wrong costs most. Nothing caught it
 * because nothing was looking.
 *
 * These tests look. They cover the two kinds of claim that can go stale
 * silently — a constant's value, and the NAME of a control a marshal is told
 * to reach for. Measured findings (reaction-time cliffs, score tables) are a
 * different kind of claim: they can only be re-measured, not checked, and they
 * are dated in the README for that reason.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { tunables } from '../src/meta/tunables.ts';
import { DEFAULT_REDLIGHT_TUNABLES } from '../src/games/redlight.ts';

const readme = async (): Promise<string> => {
  const { readFile } = await import('node:fs/promises');
  return readFile('README.md', 'utf8');
};

describe('the runbook matches the code', () => {
  /**
   * Every `**SLIDER NAME**` the README tells a marshal to reach for has to be
   * a real `label:` in tunables.ts.
   *
   * I got four of five wrong writing that table, guessing them from the
   * constant names: it is MATCH THRESHOLD not PASS THRESHOLD, PUNCH LATENCY
   * not INPUT LATENCY, ASSUMED LANE-STEP TIME and ASSUMED RECOVERY. A wrong
   * label is worse than no label — it sends somebody hunting for a control
   * that does not exist, at the one moment they have no time to hunt.
   */
  test('every slider the README names really exists', async () => {
    const md = await readme();
    const labels = new Set(tunables.list().map((t) => t.label));

    // `slider: **NAME**` and `sliders: **A**, **B**`
    const named = new Set<string>();
    for (const m of md.matchAll(/sliders?:\s*\*\*([^*]+)\*\*(?:,\s*\*\*([^*]+)\*\*)?/g)) {
      if (m[1]) named.add(m[1].trim());
      if (m[2]) named.add(m[2].trim());
    }

    assert.ok(named.size > 0, 'the README stopped naming any sliders at all');

    const missing = [...named].filter((n) => !labels.has(n));
    assert.deepEqual(
      missing,
      [],
      `the README sends a marshal to a control that does not exist. Real ` +
        `labels: ${[...labels].sort().join(', ')}`
    );
  });

  /**
   * The specific constants the risk table quotes, against their real source of
   * truth rather than against a copy.
   */
  test('the risk table quotes the real value of moveEnter', async () => {
    const md = await readme();
    const m = /`moveEnter = ([0-9.]+)/.exec(md);
    assert.ok(m, 'the moveEnter row is gone from the risk table');
    assert.equal(
      Number(m[1]),
      DEFAULT_REDLIGHT_TUNABLES.moveEnter,
      'README and DEFAULT_REDLIGHT_TUNABLES disagree about the Red Light ' +
        'move threshold'
    );
  });

  test('the risk table quotes the real punch latency', async () => {
    const md = await readme();
    const m = /`inputLatencySec = ([0-9.]+)/.exec(md);
    assert.ok(m, 'the inputLatencySec row is gone from the risk table');

    const spec = tunables.list().find((t) => t.key === 'rhythm.inputLatencySec');
    assert.ok(spec, 'rhythm.inputLatencySec is no longer a tunable');
    assert.equal(Number(m[1]), spec.default);
  });

  /**
   * The claim the table makes ABOUT ITSELF: that every constant on it can be
   * changed without a rebuild. That is the whole reason the list is useful on
   * a playtest day, and it is only true while each one has a slider.
   */
  test('every risky constant is still reachable without a rebuild', async () => {
    const keys = tunables.list().map((t) => t.key);
    for (const k of [
      'hover.reachX',
      'redlight.moveEnter',
      'posematch.passThreshold',
      'rhythm.inputLatencySec',
      'runner.laneStepTime',
      'runner.recoveryTime',
    ]) {
      assert.ok(keys.includes(k), `${k} is on the playtest list but is not a slider`);
    }
  });
});


/**
 * THE BUTTONS A MARSHAL IS SENT TO, UNDER PRESSURE.
 *
 * `runbook.test.ts` already guards the SLIDER names, because four of the five
 * in that table were wrong when it was written — guessed from constant names
 * rather than read off the console. The BUTTON names had the same exposure and
 * no guard at all, and they are worse to get wrong: a slider you cannot find
 * costs a minute of hunting, while EXPORT SCORES JSON is, in the README's own
 * words, "the only copy".
 *
 * Both directions on purpose. A name the README promises and the console lacks
 * sends somebody hunting at the one moment they have no time; a destructive or
 * export button the console has and the README never names is a control nobody
 * reaches for when it matters.
 */
const DAY_OF_BUTTONS: ReadonlyArray<readonly [string, string]> = [
  ['EXPORT SCORES JSON', 'the only copy of the whole event; packing-up step 1'],
  ['EXPORT TUNING JSON', 'the handover between the 24th and the 26th'],
  ['EXPORT BRACKET JSON', 'first thing to press on a NOT SAVING chip — the one store nobody can reconstruct'],
  ['PANIC', 'the answer to "a game is behaving strangely and you need it back"'],
  ['CLEAR EVERYTHING', 'named as the thing that loses the day; has to be the real label to be feared'],
  ['RESET ALL TUNING', 'pressed before the doors open, so day 2 does not inherit day 1 experiments'],
  ['RESET BRACKET', 'the other half of that pre-doors reset'],
  ['TURN REPLAYS ON', 'undoes a cost-guard shed, which is otherwise permanent'],
];

describe('the console has every button the runbook names', () => {
  const operator = async (): Promise<string> => {
    const { readFile } = await import('node:fs/promises');
    return readFile('src/shell/operator.ts', 'utf8');
  };

  test('every day-of button really exists in the console', async () => {
    const src = await operator();
    const missing = DAY_OF_BUTTONS.filter(([name]) => !src.includes(name)).map(
      ([name, why]) => `${name} (${why})`
    );
    assert.deepEqual(
      missing,
      [],
      `the runbook sends a marshal to controls that do not exist:` +
        missing.map((m) => ` ${m}`).join(';')
    );
  });

  test('and the runbook still names every one of them', async () => {
    const md = await readme();
    const unlisted = DAY_OF_BUTTONS.filter(([name]) => !md.includes(name)).map(
      ([name, why]) => `${name} (${why})`
    );
    assert.deepEqual(
      unlisted,
      [],
      `these controls exist and the day-of card no longer mentions them:` +
        unlisted.map((m) => ` ${m}`).join(';')
    );
  });

  /**
   * The two-step confirm is the only thing standing between a knocked mouse
   * and the day. Anything that can destroy data has to go through it rather
   * than being a plain button.
   */
  test('nothing destructive is a single click', async () => {
    const src = await operator();
    const loose: string[] = [];
    for (const name of ['CLEAR EVERYTHING', 'RESET ALL TUNING', 'RESET BRACKET']) {
      const i = src.indexOf(`'${name}'`);
      if (i < 0) continue;
      // Walk back to the call that owns this label.
      const before = src.slice(Math.max(0, i - 400), i);
      const call = before.lastIndexOf('confirmable(');
      const plain = before.lastIndexOf('button(');
      if (call < 0 || plain > call) loose.push(name);
    }
    assert.deepEqual(
      loose,
      [],
      `these destroy data on a single click: ${loose.join(', ')}`
    );
  });
});


/**
 * A GHOST IS A SAVED RUN, SO CLEARING A BOARD HAS TO CLEAR IT.
 *
 * `ghosts.clearAll()` existed with ZERO call sites anywhere in the tree, and
 * the console's two clear buttons wiped the boards and the faction totals and
 * left every recorded run in place.
 *
 * The result contradicts itself on screen, and it was seen that way: after
 * pressing CLEAR EVERYTHING the leaderboard rail says BE THE FIRST! while the
 * HUD races the player against "1 BEHIND BEST" — a best that is on no board
 * and belongs to nobody. It also MASKS the day-one chase line: a live ghost
 * outranks the board in the chase precedence, so `<SET THE FIRST SCORE>` never
 * appeared until the ghosts went too.
 *
 * It matters at setup. The morning of the 24th starts with whatever the rig
 * check and the demo rounds left behind, and CLEAR EVERYTHING is the button
 * for making the stall look untouched.
 */
describe('clearing a board clears the runs recorded against it', () => {
  const operatorSrc = async (): Promise<string> => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/shell/operator.ts', 'utf8');
    return src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
  };

  test('CLEAR EVERYTHING clears the ghosts too', async () => {
    const code = await operatorSrc();
    const at = code.indexOf("'CLEAR EVERYTHING'");
    assert.ok(at > 0, 'the CLEAR EVERYTHING button is gone');
    const span = code.slice(at, at + 400);
    assert.match(span, /leaderboard\.clearAll\(\)/, 'it no longer clears the boards');
    assert.match(
      span,
      /ghosts\.clearAll\(\)/,
      'it leaves every recorded run behind, so the first player of the day ' +
        'races a ghost whose score is on no board'
    );
  });

  test('and so does clearing one board', async () => {
    const code = await operatorSrc();
    const at = code.indexOf('CONFIRM — CLEAR THIS BOARD');
    assert.ok(at > 0, 'the per-board clear is gone');
    const span = code.slice(Math.max(0, at - 200), at + 300);
    assert.match(span, /leaderboard\.clearGame\(/, 'it no longer clears that board');
    assert.match(span, /ghosts\.clear\(/, 'it leaves that game’s recorded run behind');
  });

  /** The confirm text is what a marshal reads before committing. */
  test('and the confirmation says what it is about to destroy', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/shell/operator.ts', 'utf8');
    assert.match(
      src,
      /CONFIRM — WIPE ALL BOARDS \+ FACTIONS \+ GHOSTS/,
      'the confirm promises less than the button does'
    );
  });
});


/**
 * THE REST OF THE RISK TABLE.
 *
 * "The numbers that have never seen a real body" lists five constants a
 * marshal is expected to tune on a playtest day. Two of them were already
 * checked here — `moveEnter` because it had ALREADY drifted, documented at
 * 0.85 against a real 1.1, on the one row whose risk column reads
 * "unrecoverable at a stall"; and the punch latency because it is 61% of the
 * perfect window.
 *
 * The other three were not, and a wrong number on this table is worse than a
 * wrong number in a comment: it is read by somebody standing in a loud room
 * deciding which way to drag a slider, and every row of it is a number they
 * cannot check.
 */
describe('the rest of the risk table is the code', () => {
  test('the reach box is the figure the README sends a marshal to tune', async () => {
    const md = await readme();
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/shell/hover.ts', 'utf8');

    const stated = /`REACH_X = ([\d.]+)`/.exec(md);
    assert.ok(stated, 'the README stopped quoting REACH_X, the tune it calls highest-value');

    // Source-parsed rather than imported: REACH_X is not exported, and the
    // point is what the file says, not what a re-export says.
    const real = /^const REACH_X = ([\d.]+);/m.exec(src);
    assert.ok(real, 'REACH_X is gone from hover.ts');
    assert.equal(
      Number(stated[1]),
      Number(real[1]),
      `the README calls this the highest-value tune of the playtest and quotes ` +
        `${stated[1]}; hover.ts uses ${real[1]}`
    );
  });

  test('and so is the pose match threshold', async () => {
    const md = await readme();
    const { PASS_THRESHOLD } = await import('../src/games/poses.ts');

    const stated = /\| `([\d.]+)` match threshold \|/.exec(md);
    assert.ok(stated, 'the README stopped quoting the match threshold');
    assert.equal(
      Number(stated[1]),
      PASS_THRESHOLD,
      `the README quotes ${stated[1]} and says it has "only 0.07 headroom over ` +
        `the worst confusable pair"; poses.ts uses ${PASS_THRESHOLD}. The headroom ` +
        `claim is only true of one of them.`
    );
  });

  /**
   * That headroom figure is itself a claim: the README says 0.07 over the
   * worst confusable pair, and poses.ts names that pair at 0.651. If either
   * moves, the sentence a marshal reads before lowering the gate is wrong.
   */
  test('and the headroom it claims over the worst pair is real', async () => {
    const md = await readme();
    const { PASS_THRESHOLD } = await import('../src/games/poses.ts');
    const { readFile } = await import('node:fs/promises');
    const poses = await readFile('src/games/poses.ts', 'utf8');

    const worst = /GOALPOST\/FLEX at ([\d.]+)/.exec(poses);
    assert.ok(worst, 'poses.ts no longer names its worst confusable pair');

    const claimed = /only \*?\*?([\d.]+)\*?\*? headroom over the worst confusable pair/i.exec(md);
    assert.ok(claimed, 'the README stopped stating the headroom');

    const actual = PASS_THRESHOLD - Number(worst[1]);
    assert.ok(
      Math.abs(actual - Number(claimed[1])) < 0.005,
      `the README claims ${claimed[1]} of headroom; the gate is ${PASS_THRESHOLD} ` +
        `and the worst pair is ${worst[1]}, so the real headroom is ${actual.toFixed(3)}`
    );
  });
});


/**
 * AN INFERRED SLIDER IS A RANGE NOBODY CHOSE.
 *
 * `tunables.get(key, fallback)` registers a spec on the fly when the key is
 * unknown, and `inferSpec` says so in its own description: "The range here is
 * inferred, not designed — declare it in meta/tunables.ts to get a sane range
 * and a real description of what breaks."
 *
 * Two keys were living on one, and both are gates:
 *
 *   posematch.passThresholdEnd   inferred 0 - 3.28 on a similarity score that
 *                                cannot exceed 1. Most of that slider made
 *                                every wall unpassable.
 *   rhythm.hitRadiusTorsos       inferred 0 - 1.2, where 0.3625 is the
 *                                measured gap between the nearest two targets
 *                                for one hand. Past that a single fist
 *                                position is live for several of them, which
 *                                is the playtest report that produced the
 *                                constant in the first place.
 *
 * A marshal dragging a slider trusts its ends. An inferred range is four times
 * the current value in whichever direction happens to be positive, and it has
 * no description of what breaks.
 */
describe('no slider is running on an invented range', () => {
  /**
   * READ FROM SOURCE, not from the registry. `tunables.list()` in a test only
   * contains the DECLARED specs — an inferred one appears when a game calls
   * `get` with an unknown key at runtime, which no test does. My first version
   * checked `.inferred` on the live registry and passed vacuously.
   */
  test('every tunables.get call site has a declared spec', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(p)));
        else if (e.name.endsWith('.ts')) out.push(p);
      }
      return out;
    };

    const declared = new Set(tunables.list().map((t) => t.key));
    const undeclared = new Set<string>();
    for (const f of await walk('src')) {
      if (f.endsWith('tunables.ts')) continue;
      const src = await readFile(f, 'utf8');
      for (const m of src.matchAll(/tunables\.get\(\s*'([\w.]+)'/g)) {
        if (!declared.has(m[1]!)) undeclared.add(`${m[1]} (${f})`);
      }
    }

    assert.deepEqual(
      [...undeclared],
      [],
      `these keys are read at runtime with no declared spec, so inferSpec ` +
        `makes a range up \u2014 four times the current value, with no description ` +
        `of what breaks: ${[...undeclared].join(', ')}`
    );
  });

  /**
   * And the two gates specifically: a similarity score is 0..1, so a slider
   * that goes past 1 is a slider with a dead half.
   */
  test('the pose gates cannot be dragged past a reachable score', () => {
    for (const key of ['posematch.passThreshold', 'posematch.passThresholdEnd']) {
      const spec = tunables.list().find((t) => t.key === key);
      assert.ok(spec, `${key} is not a slider`);
      assert.ok(
        spec.max <= 1,
        `${key} goes up to ${spec.max}; a pose similarity cannot exceed 1, so ` +
          `everything above it makes the wall unpassable`
      );
    }
  });

  /**
   * And the punch reach stays under the measured target spacing. This is the
   * one constant in Rhythm a tester's complaint produced directly.
   */
  test('punch reach cannot be dragged into swallowing its neighbours', () => {
    const spec = tunables.list().find((t) => t.key === 'rhythm.hitRadiusTorsos');
    assert.ok(spec, 'PUNCH REACH is not a slider, so the playtest cannot retune it');
    assert.ok(
      spec.max < 0.3625,
      `PUNCH REACH goes up to ${spec.max}. Targets for one hand are 0.3625 ` +
        `apart, so at or above that a single fist position is live for more ` +
        `than one of them — the "target that is far away" report, restored.`
    );
  });
});


/**
 * THE HIT RADIUS IS ON THE RISK TABLE NOW, SO IT IS A CLAIM LIKE THE REST.
 *
 * It is the one Rhythm constant a tester's words produced directly, and until
 * 2026-09-20 it had no declared slider at all — so the playtest it exists for
 * could not retune it without a rebuild. The row states both the value and the
 * cliff, and both are derived from the code.
 */
describe('the hit radius row is the code', () => {
  test('the README quotes the value the game ships', async () => {
    const md = await readme();
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/games/rhythm.ts', 'utf8');

    const stated = /`HIT_RADIUS_TORSOS = ([\d.]+)`/.exec(md);
    assert.ok(stated, 'the README stopped quoting the hit radius');
    const real = /^const HIT_RADIUS_TORSOS = ([\d.]+);/m.exec(src);
    assert.ok(real, 'HIT_RADIUS_TORSOS is gone from rhythm.ts');
    assert.equal(Number(stated[1]), Number(real[1]));
  });

  /**
   * The cliff the row is about: the slider must stop below the measured gap
   * between the nearest two targets, or the report that produced the constant
   * comes back through the console.
   */
  test('and the slider it names stops below the cliff it names', async () => {
    const md = await readme();
    const gap = /sit \*\*([\d.]+)\*\* apart/.exec(md);
    assert.ok(gap, 'the README stopped stating the target spacing');

    const spec = tunables.list().find((t) => t.key === 'rhythm.hitRadiusTorsos');
    assert.ok(spec, 'PUNCH REACH is not a slider');
    assert.ok(
      spec.max < Number(gap[1]),
      `the README says targets are ${gap[1]} apart and the slider goes to ` +
        `${spec.max}. A marshal can drag it into the state the playtest complained about.`
    );
  });
});
