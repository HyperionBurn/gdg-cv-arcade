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
  test('the tuning flag is surfaced too', async () => {
    // `tunables.saveFailed` by name, not a bare `saveFailed` — otherwise this
    // passes on a file that only ever reads the leaderboard's flag, which is
    // exactly the state both surfaces were in before this test existed.
    const readers = await readersOf('tunables.saveFailed', 'src/meta/tunables.ts');
    assert.ok(
      readers.length > 0,
      'nothing surfaces tunables.saveFailed, so a marshal can tune for an hour ' +
        'into a disk that is refusing every write'
    );
  });

  /**
   * And on BOTH surfaces. The `d` overlay is the fast one — a marshal hits `d`
   * mid-queue; the operator console is a deliberate trip. Reporting a dead disk
   * on only one of them means the answer depends on which key you pressed.
   */
  test('both storage readouts cover both flags', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const f of ['src/shell/debug.ts', 'src/shell/operator.ts']) {
      const src = await readFile(f, 'utf8');
      assert.match(src, /leaderboard\.saveFailed/, `${f} stopped reporting score saves`);
      assert.match(src, /tunables\.saveFailed/, `${f} stopped reporting tuning saves`);
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
