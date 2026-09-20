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
