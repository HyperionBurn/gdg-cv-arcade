/**
 * TWO COPIES OF EVERY DRIVER, AND ONE COMMENT ASKING SOMEBODY TO REMEMBER.
 *
 * `smoke.ts` mounts each game directly and plays it; `turn.ts` walks the whole
 * shell and plays it again. Both need to know how to play, and each keeps its
 * own driver. turn.ts says so in a comment — "These mirror the drivers in
 * smoke.ts; keep the two in step" — which is an instruction to a human and was
 * the only thing holding them together.
 *
 * They drifted the moment one was touched. Updating the Rhythm probe in
 * smoke.ts to duck walls changed nothing at all, because `turn()` runs its own
 * copy, and the sweep that was supposed to prove the fix kept reporting zero.
 *
 * ---------------------------------------------------------------------------
 * HOW THE UNDERLYING BUG WAS FOUND, because the method generalises
 *
 * Not by reading the code. By COUNTING AUDIO CUES over a full seven-game
 * sweep and looking for any that never played:
 *
 *   before   wallhit 15   duck 0     rhythm scored 1077 / 898
 *   after    wallhit  0   duck 15    rhythm scored 1864 / 1560
 *
 * Walls are one of Rhythm's two scoring paths, and the simulated player was
 * hitting every single one. Every automated check passed the whole time,
 * because nothing asserted the duck path was reachable — the same shape as a
 * combo clip whose threshold could never fire, found the same afternoon.
 *
 * A cue that never plays is a mechanic nobody is testing. That is worth
 * re-running by hand after any change to the probes.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const read = async (f: string): Promise<string> => {
  const { readFile } = await import('node:fs/promises');
  return readFile(f, 'utf8');
};

/** Comments stripped, so a guard cannot be satisfied by prose about itself. */
const codeOf = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

describe('both harnesses play the game the same way', () => {
  test('each one ducks the walls in Rhythm', async () => {
    for (const f of ['src/dev/smoke.ts', 'src/dev/turn.ts']) {
      const code = codeOf(await read(f));
      assert.match(
        code,
        /setCrouch\??\.?\(\s*!!\s*wall\s*\)/,
        `${f} never ducks, so its Rhythm round hits every wall in the chart ` +
          `and half the game's scoring is untested`
      );
    }
  });

  /**
   * The same window in both, or one harness ducks and the other is a frame
   * early for the rest of the event. Extracted rather than restated, so the
   * test cannot agree with itself while the code disagrees.
   */
  test('and they agree on when to start ducking', async () => {
    const windows: string[] = [];
    for (const f of ['src/dev/smoke.ts', 'src/dev/turn.ts']) {
      const code = codeOf(await read(f));
      const m = /kind === 'wall'[\s\S]{0,160}?delta > (-?[\d.]+) && x\.delta < ([\d.]+)/.exec(code);
      assert.ok(m, `${f} has no wall-duck window to compare`);
      windows.push(`${m[1]}..${m[2]}`);
    }
    assert.equal(
      windows[0],
      windows[1],
      `the two harnesses duck over different windows (${windows.join(' vs ')}), ` +
        `so one of them is testing a game the other is not`
    );
  });

  /**
   * THE RUNNER HAD NO DRIVER AT ALL, AND SCORED 600 ANYWAY.
   *
   * Both harnesses called `triggerJump()` ONCE, in the open-loop setup, and
   * then never again. The simulated runner stood in the centre lane and walked
   * into every obstacle in it for the whole round — and because distance
   * accrues from the world scrolling, it still scored ~600 and every check
   * stayed green. Jump and slide, which is most of this game, had never been
   * exercised by automation.
   *
   * Found by the same method as the Rhythm walls: counting something that
   * should vary and never did. The round log's first output was a 100% hit
   * rate on every obstacle kind, on both runners —
   *
   *   before   lowHit 4/4    highHit 4/4   blockHit 1/1   scored 602 / 588
   *   after    lowHit 0/4    highHit 0/3   blockHit 0/0   scored 934 / 983
   *
   * The driver body is duplicated character for character rather than shared,
   * because these two files deliberately keep their own drivers — so this
   * compares the copies directly instead of trusting a comment asking somebody
   * to remember.
   */
  test('the Runner driver is the same in both, character for character', async () => {
    const bodies: string[] = [];
    for (const f of ['src/dev/smoke.ts', 'src/dev/turn.ts']) {
      const src = await read(f);
      const start = src.indexOf('/* RUNNER-DRIVER-BODY-START */');
      const end = src.indexOf('/* RUNNER-DRIVER-BODY-END */');
      assert.ok(start >= 0 && end > start, `${f} has no marked Runner driver body`);
      bodies.push(src.slice(start, end).replace(/\r\n/g, '\n').trim());
    }
    assert.equal(
      bodies[0],
      bodies[1],
      'the two Runner drivers have drifted. They are duplicated on purpose; ' +
        'keeping them identical is what stops one harness playing a game the ' +
        'other cannot'
    );
    assert.ok((bodies[0]?.length ?? 0) > 400, 'the marked body looks empty');
  });

  /** The tuning either side of that body has to match too. */
  test('and they agree on the Runner lead times', async () => {
    const leads: string[] = [];
    for (const f of ['src/dev/smoke.ts', 'src/dev/turn.ts']) {
      const code = codeOf(await read(f));
      const got = ['JUMP_LEAD_SEC', 'SLIDE_LEAD_SEC', 'SLIDE_HOLD_SEC', 'BLOCK_LEAD_SEC'].map(
        (k) => `${k}=${new RegExp(`const ${k} = ([^;]+);`).exec(code)?.[1]?.trim() ?? 'MISSING'}`
      );
      leads.push(got.join(' '));
    }
    assert.ok(!leads[0]?.includes('MISSING'), `smoke.ts is missing a lead constant: ${leads[0]}`);
    assert.equal(leads[0], leads[1], `the two harnesses time the Runner differently:\n  ${leads.join('\n  ')}`);
  });

  /**
   * A closed-loop driver exists for exactly the games where mashing is not
   * competent play. If one harness has a driver the other lacks, that game is
   * being played well in one sweep and flailed through in the other — and the
   * two will disagree about scores for reasons nobody will look for.
   */
  test('and they close the loop on the same games', async () => {
    const smoke = codeOf(await read('src/dev/smoke.ts'));
    const turn = codeOf(await read('src/dev/turn.ts'));

    // smoke.ts: `id: 'x'` blocks that also contain a `drive:`.
    const smokeDriven = new Set<string>();
    for (const block of smoke.split(/\n\s*\{\s*\n\s*id:/)) {
      const id = /^\s*'([a-z]+)'/.exec(block)?.[1];
      if (id && /\bdrive:/.test(block)) smokeDriven.add(id);
    }

    // turn.ts: keys of the DRIVE record.
    const turnDriven = new Set<string>();
    const driveBlock = /const DRIVE[\s\S]*?\n\};/.exec(turn)?.[0] ?? '';
    for (const m of driveBlock.matchAll(/^\s{2}([a-z]+):\s*\(/gm)) turnDriven.add(m[1]!);

    assert.ok(smokeDriven.size > 0, 'no closed-loop drivers found in smoke.ts');
    assert.ok(turnDriven.size > 0, 'no closed-loop drivers found in turn.ts');

    const onlySmoke = [...smokeDriven].filter((g) => !turnDriven.has(g)).sort();
    const onlyTurn = [...turnDriven].filter((g) => !smokeDriven.has(g)).sort();
    assert.deepEqual(
      { onlySmoke, onlyTurn },
      { onlySmoke: [], onlyTurn: [] },
      `one harness plays a game properly and the other flails through it`
    );
  });
});

/**
 * THE MOST SOCIAL GAME ON THE ROSTER RAN SOLO IN EVERY CHECK EVER MADE.
 *
 * `turn()` puts THREE bodies in frame for Red Light and then picked JUST ME on
 * the mode screen, so the round locked to one player with two strangers
 * standing in it. Red Light seats five, scores per lane, and ends on
 * `<FINAL STANDINGS>` — none of which any automated check had ever rendered.
 *
 * Found by counting never-drawn strings across a full sweep: `<FINAL
 * STANDINGS>` appeared zero times, and the SOLO near-miss line `1 OFF SEVENTH`
 * appeared instead, which is what gave it away.
 */
describe('the sweep plays Red Light the way the stall will', () => {
  test('it picks ALL OF US, not JUST ME', async () => {
    const code = codeOf(await read('src/dev/turn.ts'));
    assert.match(
      code,
      /game === 'redlight'\s*\?\s*'mode:open'/,
      `turn() chooses the mode card, and for Red Light it must choose the party ` +
        `one — otherwise three bodies stand in a round only one of them is playing`
    );
  });

  /**
   * The body count and the mode choice have to agree. Three bodies with JUST
   * ME selected is the bug that was there; one body with ALL OF US selected
   * would be the mirror of it.
   */
  test('and puts more than one body in frame for it', async () => {
    const code = codeOf(await read('src/dev/turn.ts'));
    assert.match(
      code,
      /game === 'redlight'\s*\?\s*3/,
      'Red Light is seated for five and the sweep no longer brings a crowd'
    );
  });
});

/**
 * ANYTHING WITH MODULE-LEVEL STATE BELONGS ON `__arcade`.
 *
 * `main.ts` already explains why for `highlights`: a dev-console
 * `import('/src/meta/highlights.ts')` does not reach the app's instance,
 * because Vite appends an HMR timestamp to module URLs it has reloaded, so a
 * bare import resolves to a SECOND, freshly-constructed module. Its counters
 * are all zero and it looks exactly like the feature being dead.
 *
 * That caught me on `tournament` today. Checking a bracket through a dynamic
 * import reported `start()` succeeding and `active` true — on a module the app
 * has never seen. The only tell was the console DOM disagreeing with it, and
 * what I ended up trusting was `localStorage` read back by hand.
 *
 * And `operatorConsole()` has carried the comment "for `window.__arcade` and
 * tests" since it was written, while neither used it. Driving the console meant
 * synthesising a KeyboardEvent with `code: 'Backquote'`, which tests the hotkey
 * rather than the thing behind it — and silently does nothing when the
 * anti-lean guard rejects the chord.
 *
 * Both are on the handle now, and this is here so the next singleton does not
 * have to be discovered the same way.
 */
describe('the dev handle reaches the real singletons', () => {
  test('the stateful modules are all on it', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/main.ts', 'utf8');

    const at = src.indexOf('__arcade = {');
    assert.ok(at > 0, 'the dev handle is gone');
    const block = src.slice(at, src.indexOf('\n  };', at));

    for (const name of [
      'router', 'camera', 'vision', 'audio', 'simulator',
      'highlights', 'tournament', 'leaderboard', 'tunables', 'ghosts',
    ]) {
      assert.match(
        block,
        new RegExp('(^|[^\w.])' + name + '\s*,'),
        `\`${name}\` holds module-level state and is not on \`__arcade\`, so the ` +
          `only way to inspect it from a console is a dynamic import — which ` +
          `under Vite can hand back a different instance entirely`
      );
    }

    assert.match(
      block,
      /get operator\(\)/,
      'the operator console is off the handle again, so driving it means ' +
        'synthesising a Backquote chord that the anti-lean guard may reject'
    );
  });

  /** And the claim in `operator.ts` is true rather than aspirational. */
  test('and operatorConsole is actually used by it', async () => {
    const { readFile } = await import('node:fs/promises');
    const op = await readFile('src/shell/operator.ts', 'utf8');
    const main = await readFile('src/main.ts', 'utf8');

    const at = op.indexOf('export function operatorConsole(');
    assert.ok(at > 0, 'operatorConsole is gone');
    const note = op.slice(Math.max(0, at - 200), at);
    if (/__arcade/.test(note)) {
      assert.match(
        main,
        /operatorConsole\(\)/,
        'operatorConsole says it exists for `window.__arcade` and nothing there ' +
          'calls it. Either wire it or stop claiming it'
      );
    }
  });
});
