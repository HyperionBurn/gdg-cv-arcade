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
