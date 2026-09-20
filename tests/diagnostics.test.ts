/**
 * "ABSENT ON PURPOSE" IS A STATE, AND EVERY HEALTH READOUT HAS TO KNOW IT.
 *
 * The day-of card's answer to a dead webcam is `?sim=1`. So the moment a
 * marshal most needs the diagnostics is the moment there is deliberately no
 * camera — and a readout that only knows `live` and `broken` will report the
 * fallback as a catastrophe.
 *
 * This happened three times in one afternoon, on three surfaces, and each time
 * I found it by looking at the screen rather than by reasoning about the code:
 *
 *   shell/debug.ts     the `d` overlay: camera idle, vision loading,
 *                      inference 0fps 0ms
 *   shell/rigcheck.ts  a RED box reading "CAMERA: idle — no frames are being
 *                      captured", plus vision NOT READY and resolution 0×0
 *   shell/operator.ts  the CAMERA tab: STATUS IDLE and two buttons inviting a
 *                      marshal to restart a camera nobody asked for
 *
 * Every line of that was true. Together they say the rig is broken, to the one
 * person who came to the screen to find out whether it is.
 *
 * The fix is the same everywhere: say SIMULATOR — no camera by design, report
 * the camera and the worker as "not used (sim)", and show `—` rather than a
 * zero, because a zero invites a fix and a dash does not.
 *
 * So: a file that renders camera or vision HEALTH must also consult
 * `isSimEnabled`. Geometry is exempt and deliberately not matched here — four
 * screens read `cam.width || 1280` to build a Projection, which is a fallback
 * that is already correct under sim.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/** Reading these into user-visible text is a health claim. */
const HEALTH = [
  /\.status\b/,
  /\.ready\b/,
  /inferenceFps/,
  /inferenceMs/,
  /latencyMs/,
  /\bdropped\b/,
];

/** Putting a value in front of a human. */
const RENDERS = [
  /textContent\s*=/,
  /\baddKV\(/,
  /drawText\(/,
  /\bvalue:/,
  /\blabel:/,
  /push\(\s*\{/,
];

describe('diagnostics know the simulator is not a fault', () => {
  const read = async (): Promise<Array<{ file: string; src: string }>> => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(full)));
        else if (full.endsWith('.ts')) out.push(full);
      }
      return out;
    };
    const files = await walk('src');
    return Promise.all(
      files.map(async (file) => ({
        file: file.split(/[\\/]/).join('/'),
        src: await readFile(file, 'utf8'),
      }))
    );
  };

  test('anything reporting camera or vision health consults isSimEnabled', async () => {
    const offenders: string[] = [];

    for (const { file, src } of await read()) {
      // The modules that OWN the state are the ones being reported on.
      if (file === 'src/core/camera.ts' || file === 'src/core/vision.ts') continue;
      // The simulator itself, and the probes that drive it.
      if (file.startsWith('src/core/simulator') || file.startsWith('src/dev/')) continue;

      const touchesState = /camera\.getState\(\)|vision\.getStats\(\)|camera\.isLive\(\)/.test(src);
      if (!touchesState) continue;

      const lines = src.split(/\r?\n/);
      const reportsHealth = lines.some(
        (l) => HEALTH.some((h) => h.test(l)) && RENDERS.some((r) => r.test(l))
      );
      if (!reportsHealth) continue;

      if (!/isSimEnabled/.test(src)) offenders.push(file);
    }

    assert.deepEqual(
      offenders,
      [],
      'this file puts camera or vision health in front of a human without ' +
        'knowing about `?sim=1`, where the honest answer is "not used (sim)" ' +
        'and not a fault'
    );
  });

  /**
   * The three that were fixed have to STAY fixed, and they have to agree.
   * A marshal who reads "no camera by design" on one screen and "CAMERA: idle"
   * on another learns nothing except that the rig is untrustworthy.
   */
  test('the three surfaces all say the same thing', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const f of ['src/shell/debug.ts', 'src/shell/rigcheck.ts', 'src/shell/operator.ts']) {
      const src = await readFile(f, 'utf8');
      assert.match(src, /isSimEnabled/, `${f} stopped checking for the simulator`);
      assert.match(
        src,
        /SIMULATOR — no camera by design/,
        `${f} no longer says what mode it is in`
      );
    }
  });

  /**
   * A FOURTH SURFACE, AND THE SWEEP ABOVE PASSED IT VACUOUSLY.
   *
   * `operator.ts` contains `isSimEnabled` — down in the CAMERA tab — so the
   * file-level check for "reports health without knowing about `?sim=1`" was
   * satisfied by a different part of the same file. The header's INFER chip
   * meanwhile covered BOTH reasons the worker might be missing with a single
   * string and a question mark: `OFFLINE (SIM?)`, in the yellow that means
   * probably fine.
   *
   * Only one of the two is fine. Under `?sim=1` there is no worker by design.
   * Without it, a worker that never came up means no pose is ever detected,
   * every game sits on its STEP IN screen, and the stall is dead for the whole
   * queue — and the chip handed a marshal the reassuring reading at exactly
   * that moment.
   *
   * Found by opening the console in the PRODUCTION build and reading it, which
   * is what a marshal does when they suspect something is wrong.
   */
  test('the INFER chip does not hedge about why the worker is missing', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/shell/operator.ts', 'utf8');

    const at = src.indexOf('if (vs.ready) {');
    assert.ok(at >= 0, 'the live strip no longer branches on vision readiness');
    // The next chip after the INFER chain. Anchored on the bare label because
    // `this.chip(` and `'CAMERA',` sit on separate lines in this file, and an
    // anchor that spans the break silently finds nothing.
    const end = src.indexOf("'CAMERA',", at);
    assert.ok(end > at, 'could not find the end of the INFER branch');

    // Comments stripped: this branch is now explained by a long note that
    // names `isSimEnabled` and quotes the string it replaced, and a guard must
    // not be able to pass by reading the prose about itself.
    const code = src
      .slice(at, end)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');

    assert.match(
      code,
      /isSimEnabled\(\)/,
      'the INFER chip is back to one string for both cases. It has the answer ' +
        'available — the CAMERA tab in the same file has used isSimEnabled() ' +
        'for this since it was written'
    );
    assert.match(
      code,
      /this\.chip\(\s*'INFER'[^;]*'bad'\s*\)/,
      'a vision worker that is not running OUTSIDE sim mode means nothing will ' +
        'ever be detected. That is not a warning, it is a dead stall, and the ' +
        'chip has to be the colour that says so'
    );
  });

  /**
   * The general form of it. A diagnostic that guesses is worse than one that
   * says nothing: it spends the marshal's trust on a coin flip.
   */
  test('no readout guesses at sim mode with a question mark', async () => {
    const offenders: string[] = [];
    for (const { file, src } of await read()) {
      if (file.startsWith('src/dev/')) continue;
      // Comments blanked rather than deleted, so the line numbers in a failure
      // message still point at the offending line. Needed because the note
      // explaining the fix QUOTES the string it removed, and the first run of
      // this guard duly reported the comment describing it.
      src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .split(/\r?\n/)
        .map((l) => l.replace(/\/\/.*$/, ''))
        .forEach((line, i) => {
          if (/['"`][^'"`]*SIM\?/.test(line)) offenders.push(`${file}:${i + 1}`);
        });
    }
    assert.deepEqual(
      offenders,
      [],
      'a user-facing string hedges about the simulator. The app knows which it ' +
        'is: call isSimEnabled() and say so'
    );
  });

  /**
   * A NEW RED CHIP IS A NEW THING A MARSHAL HAS TO LOOK UP.
   *
   * README's "If something is wrong" table is the card somebody reads with a
   * queue in front of them, and it is the reason `runbook.test.ts` exists —
   * four of its five slider labels had drifted before anybody checked. The
   * INFER chip now has two states that mean opposite things, so both belong in
   * that table, spelled the way the code spells them.
   */
  test('the day-of card explains both states of the INFER chip', async () => {
    const { readFile } = await import('node:fs/promises');
    const md = await readFile('README.md', 'utf8');
    const src = await readFile('src/shell/operator.ts', 'utf8');

    const start = md.indexOf('### If something is wrong');
    assert.ok(start >= 0, 'the README no longer has a failure table');
    // Bounded by the next heading, not by a character count. The table is
    // ~3,200 characters and the window was 12,000, so it read 8,000 characters
    // of unrelated README — and a chip string mentioned anywhere in that span
    // would have satisfied this while the table said nothing. There is already
    // one such mention elsewhere in the file, in the production-build notes.
    const next = md.indexOf('\n### ', start + 10);
    const table = md.slice(start, next > start ? next : undefined);
    assert.ok(table.length < 8000, `the failure table is ${table.length} chars; heading lost?`);

    // Both strings, taken from the code rather than retyped here, so the two
    // cannot drift apart without this failing.
    const states = [...src.matchAll(/this\.chip\(\s*'INFER',\s*'([^']+)'/g)].map((m) => m[1]!);
    const notFps = states.filter((s) => !/fps/.test(s));
    assert.ok(
      notFps.length >= 2,
      `expected the worker-missing chip to have both a sim and a non-sim state, found ${notFps.join(', ') || 'none'}`
    );
    for (const s of notFps) {
      assert.ok(
        table.includes(s),
        `the operator console can show "INFER ${s}" and the day-of failure ` +
          `table never mentions it, so a marshal reading a red chip has nowhere to look`
      );
    }
  });
});

/**
 * A FLAG NOBODY READS IS A FAILURE NOBODY SEES.
 *
 * `leaderboard.saveFailed` was set on every storage failure and read by
 * nothing. The board keeps working from memory — right behaviour, and exactly
 * why it is invisible: play carries on, scores appear, ranks are correct, and
 * the first reload discards the lot.
 *
 * That is worse here than it sounds, because the runbook's answer to four
 * separate problems is F5. A marshal following their own card while storage is
 * quietly failing throws the day away and has no way to know they did.
 */
describe('a silent save failure is not silent', () => {
  const readersOf = async (flag: string, owner: string): Promise<string[]> => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(p)));
        else if (p.endsWith('.ts')) out.push(p);
      }
      return out;
    };
    const found: string[] = [];
    for (const file of await walk('src')) {
      // `[\\/]`, not `[\/]` — see the note in the leaderboard test below.
      const rel = file.split(/[\\/]/).join('/');
      if (rel === owner) continue;
      if ((await readFile(file, 'utf8')).includes(flag)) found.push(rel);
    }
    return found;
  };

  /**
   * Tuning saves on EVERY slider move; the board only on a submit. So a dead
   * disk shows up here an hour before the first score would reveal it, which
   * is the whole reason it gets its own flag rather than relying on the
   * leaderboard to notice.
   */
  /**
   * The stores that persist, all of which had the same defect at a different
   * stage: the leaderboard set a flag nothing read, tunables had no flag at
   * all, and the tournament's `lsSet` returned a boolean that `save()` threw
   * away.
   *
   * THE LIST USED TO BE ONLY THIS, and its comment said naming them
   * individually made adding a fourth store "a deliberate choice rather than
   * something this suite quietly stops covering". It did not do that. A fourth
   * store — the round log — was added on 20 September, and nothing here
   * failed; it was simply not covered, and the `d` overlay never reported it
   * while the operator console did. Exactly the split this suite exists to
   * prevent, arriving through the list rather than through the code.
   *
   * So the set is DERIVED from the source below and checked against this list.
   * The deliberate-choice property is real now: add a store and this fails
   * until somebody names it here and wires it to both readouts.
   */
  const STORES = [
    { flag: 'tunables.saveFailed', owner: 'src/meta/tunables.ts' },
    { flag: 'tournament.saveFailed', owner: 'src/meta/tournament.ts' },
    { flag: 'leaderboard.saveFailed', owner: 'src/meta/leaderboard.ts' },
    { flag: 'roundLog.saveFailed', owner: 'src/meta/roundlog.ts' },
  ];

  test('every store that CAN fail to save is on the list above', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const found: string[] = [];
    for (const f of await readdir('src/meta')) {
      if (!f.endsWith('.ts')) continue;
      const src = await readFile(join('src/meta', f), 'utf8');
      if (!/^\s*saveFailed\s*=/m.test(src)) continue;
      // The exported singleton is what the readouts actually name.
      const m = /export const (\w+) = new \w+\(/.exec(src);
      assert.ok(m, `src/meta/${f} has a saveFailed flag but no exported singleton to read it from`);
      found.push(`${m[1]}.saveFailed`);
    }

    assert.deepEqual(
      found.sort(),
      STORES.map((s) => s.flag).sort(),
      'a persisted store is missing from STORES, so nothing below checks that ' +
        'its failure reaches a marshal. Add it here AND to both readouts'
    );
  });

  for (const { flag, owner } of STORES) {
    // The qualified name, not a bare `saveFailed` — otherwise this passes on a
    // file that only ever reads a DIFFERENT store's flag, which is exactly the
    // state both surfaces were in before this test existed.
    test(`${flag} reaches a human`, async () => {
      const readers = await readersOf(flag, owner);
      assert.ok(
        readers.length > 0,
        `nothing surfaces ${flag}, so that store can be silently discarding ` +
          'every write while the stall looks perfectly healthy'
      );
    });
  }

  /**
   * And on BOTH surfaces. The `d` overlay is the fast one — a marshal hits `d`
   * mid-queue; the operator console is a deliberate trip. Reporting a dead disk
   * on only one of them means the answer depends on which key you pressed.
   */
  test('both storage readouts cover every store', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const f of ['src/shell/debug.ts', 'src/shell/operator.ts']) {
      const src = await readFile(f, 'utf8');
      for (const { flag } of STORES) {
        assert.ok(src.includes(flag), `${f} stopped reporting ${flag}`);
      }
    }
  });

  /**
   * The bracket is the one that cannot be reconstructed. A lost score is a
   * number somebody can tell you again; a lost bracket is who beat whom across
   * a whole afternoon, and the file header says surviving a mid-event crash is
   * the entire reason it persists.
   */
  test('a refused bracket write sets the flag', async () => {
    const { Tournament } = await import('../src/meta/tournament.ts');
    const store = new Map<string, string>();
    let refuse = false;

    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => void store.delete(k),
      setItem: (k: string, v: string) => {
        if (refuse) {
          const e = new Error('quota');
          e.name = 'QuotaExceededError';
          throw e;
        }
        store.set(k, v);
      },
    };

    try {
      const t = new Tournament('test-bracket');
      t.addPlayer('AAA');
      assert.equal(t.saveFailed, false, 'a working write must not raise the flag');

      refuse = true;
      t.addPlayer('BBB');
      assert.equal(t.saveFailed, true, 'a refused bracket write went unnoticed');

      // And it must clear, or one blip at 10am reads as a dead disk all day.
      refuse = false;
      t.addPlayer('CCC');
      assert.equal(t.saveFailed, false, 'the flag never clears once set');
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  test('saveFailed is read somewhere outside the leaderboard', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...(await walk(p)));
        else if (p.endsWith('.ts')) out.push(p);
      }
      return out;
    };

    const readers: string[] = [];
    for (const file of await walk('src')) {
      // `[\\/]`, not `[\/]`. On Windows `join` gives backslashes, so matching
      // only forward slashes leaves `rel` unchanged, the comparison below never
      // fires, and leaderboard.ts counts itself as a reader — the test passes
      // while checking nothing. Same escaping slip as the draw.ts exclusion in
      // brand.test.ts, which also silently did nothing.
      const rel = file.split(/[\\/]/).join('/');
      if (rel === 'src/meta/leaderboard.ts') continue; // where it is SET
      if (/saveFailed/.test(await readFile(file, 'utf8'))) readers.push(rel);
    }

    assert.ok(
      readers.length > 0,
      'nothing surfaces leaderboard.saveFailed, so a stall whose scores have ' +
        'stopped persisting looks identical to one whose scores are fine — ' +
        'until somebody reloads'
    );
  });
});
