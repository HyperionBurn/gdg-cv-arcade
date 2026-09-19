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
