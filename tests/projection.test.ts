/**
 * THE MAPPING EVERY HAND, CURSOR AND SKELETON GOES THROUGH, and no test
 * imported it.
 *
 * A sweep for modules that no test imports turned up eight. Most are drawing
 * or a worker entry point. `projection.ts` is pure arithmetic used by every
 * consumer-facing coordinate in the app, and its own header says getting any
 * of the three reconciliations wrong "makes a game feel subtly broken in a
 * way that's very hard to debug from a desk" — which is exactly the kind of
 * thing that should not be discovered at a club fair.
 *
 * The three are mirroring, aspect and fit mode, and each has a specific
 * failure that reaches a player:
 *
 *   - MIRRORING wrong: the player raises their right hand and the glow appears
 *     on the left. Every menu dwell is then aimed at the wrong tile.
 *   - FIT wrong on the rig check: 'cover' crops the camera, which hides
 *     precisely the framing problem the rig check exists to show.
 *   - A DEGENERATE camera size produces NaN offsets, and NaN coordinates draw
 *     nothing at all — a blank screen with no error.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Projection } from '../src/engine/projection.ts';
import type { Viewport } from '../src/engine/draw.ts';

const view = (width: number, height: number): Viewport => ({ width, height, dpr: 1 });

/** A 16:9 stage, the shape the stall actually runs at. */
const STAGE = view(1600, 900);

const proj = (opts: Partial<Parameters<typeof Projection.prototype.update>[1]> = {}, v = STAGE) =>
  new Projection(v, {
    cameraWidth: 1600,
    cameraHeight: 900,
    fit: 'cover',
    mirrored: false,
    ...opts,
  });

describe('Projection', () => {
  test('a matching camera and stage map straight through', () => {
    const p = proj();
    assert.equal(p.x(0), 0);
    assert.equal(p.x(1), 1600);
    assert.equal(p.y(0), 0);
    assert.equal(p.y(1), 900);
  });

  /**
   * THE TV IS A MIRROR. A player who raises the hand on their right must see
   * the glow on the right as they look at it. Mirrored x is the same point
   * measured from the other edge.
   */
  test('mirroring reflects about the centre', () => {
    const plain = proj({ mirrored: false });
    const mirror = proj({ mirrored: true });
    for (const nx of [0, 0.25, 0.5, 0.75, 1]) {
      assert.equal(mirror.x(nx), plain.x(1 - nx), `nx=${nx}`);
    }
  });

  test('and the centre is the one point it does not move', () => {
    assert.equal(proj({ mirrored: true }).x(0.5), proj({ mirrored: false }).x(0.5));
  });

  /** Vertical is never mirrored: nobody stands on their head. */
  test('mirroring leaves y alone', () => {
    assert.equal(proj({ mirrored: true }).y(0.3), proj({ mirrored: false }).y(0.3));
  });

  /**
   * A 4:3 laptop camera on a 16:9 TV is the case that actually turns up, and
   * the two fit modes disagree on purpose.
   */
  describe('a 4:3 camera on a 16:9 stage', () => {
    const opts = { cameraWidth: 1200, cameraHeight: 900 };

    test('cover fills the stage, cropping the camera', () => {
      const r = proj({ ...opts, fit: 'cover' }).rect;
      assert.ok(r.width >= STAGE.width, 'cover left a horizontal gap');
      assert.ok(r.height >= STAGE.height, 'cover left a vertical gap');
      assert.ok(r.height > STAGE.height, 'a 4:3 source must overflow vertically to fill 16:9');
    });

    test('contain shows the whole camera, letterboxing the stage', () => {
      const r = proj({ ...opts, fit: 'contain' }).rect;
      assert.ok(r.width <= STAGE.width, 'contain overflowed horizontally');
      assert.ok(r.height <= STAGE.height, 'contain overflowed vertically');
      assert.ok(r.width < STAGE.width, 'a 4:3 source must leave side bars on 16:9');
    });

    /**
     * The rig check uses 'contain' precisely because cropping would hide the
     * framing problem it exists to show — a player whose legs are cut off.
     * Both modes must keep the image centred, or the bars land on one side.
     */
    test('both modes keep the image centred', () => {
      for (const fit of ['cover', 'contain'] as const) {
        const r = proj({ ...opts, fit }).rect;
        const left = r.x;
        const right = STAGE.width - (r.x + r.width);
        const top = r.y;
        const bottom = STAGE.height - (r.y + r.height);
        assert.ok(Math.abs(left - right) < 1e-9, `${fit} is off-centre horizontally`);
        assert.ok(Math.abs(top - bottom) < 1e-9, `${fit} is off-centre vertically`);
      }
    });

    /** Aspect must be preserved, or every body on screen is stretched. */
    test('neither mode distorts the picture', () => {
      for (const fit of ['cover', 'contain'] as const) {
        const r = proj({ ...opts, fit }).rect;
        assert.ok(
          Math.abs(r.width / r.height - opts.cameraWidth / opts.cameraHeight) < 1e-9,
          `${fit} changed the aspect ratio`,
        );
      }
    });
  });

  /**
   * A camera reports 0x0 until its metadata loads, and that is a real frame
   * the app renders. Dividing by it gives NaN offsets, and NaN coordinates
   * draw nothing — a blank screen with no error anywhere to explain it.
   */
  test('a camera with no size yet falls back to the stage', () => {
    for (const [cw, ch] of [
      [0, 0],
      [0, 900],
      [1600, 0],
    ]) {
      const p = proj({ cameraWidth: cw, cameraHeight: ch });
      assert.equal(Number.isFinite(p.x(0.5)), true, `x went non-finite at ${cw}x${ch}`);
      assert.equal(Number.isFinite(p.y(0.5)), true, `y went non-finite at ${cw}x${ch}`);
      assert.deepEqual(p.rect, { x: 0, y: 0, width: STAGE.width, height: STAGE.height });
    }
  });

  test('point maps both axes the same way the pair does', () => {
    const p = proj({ mirrored: true });
    const got = p.point({ x: 0.3, y: 0.7 });
    assert.deepEqual(got, { x: p.x(0.3), y: p.y(0.7) });
  });

  /**
   * `len` is deliberately measured against the drawn HEIGHT rather than the
   * width, so a radius scales with a body's apparent size and stays round
   * whatever the letterboxing is doing.
   */
  test('len scales with the drawn height, so radii stay round', () => {
    const p = proj({ cameraWidth: 1200, cameraHeight: 900, fit: 'contain' });
    assert.equal(p.len(1), p.rect.height);
    assert.equal(p.len(0.5), p.rect.height / 2);
  });

  test('a resized stage remaps without being rebuilt', () => {
    const p = proj();
    assert.equal(p.x(1), 1600);
    p.update(view(800, 450));
    assert.equal(p.x(1), 800, 'the projection kept the old stage width');
    assert.equal(p.y(1), 450);
  });
});
