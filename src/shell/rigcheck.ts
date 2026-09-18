/**
 * RIG CHECK — the Sept 18 camera test tool.
 *
 * PLAN.md §8: "Camera hardware test — laptop cam vs iPhone Continuity. Do this
 * first." PLAN.md §9 rates "camera can't frame full body" as the only CRITICAL
 * risk alongside wifi.
 *
 * This screen exists to answer, in the actual room, with the actual TV:
 *
 *   1. Is the whole body in frame, or are the legs cut off?
 *   2. How far back does the player have to stand?
 *   3. Which camera is better — built-in or iPhone Continuity?
 *   4. Does the tracker hold identities when two people cross?
 *   5. Do the gesture detectors actually fire for different body types?
 *   6. Is inference fast enough on this laptop?
 *
 * Deliberately uses ordinary DOM controls rather than hand-hover: this is a
 * tool for us during setup, not a player-facing screen.
 *
 * BRAND: operator-facing, so the visual stakes are lower than a game — but the
 * framing verdict is the whole product here and it has to be readable from
 * wherever the person adjusting the camera is standing, which is not in front
 * of the laptop. So it is the LOUDEST thing the brand can make: a full sticker
 * card whose FILL is the verdict colour, carrying ink capitals. Flat green,
 * flat red and flat yellow cannot hold text on paper at that distance, so the
 * colour has to be the surface, not the type.
 *
 * Nothing here blurs. The three `shadowBlur` sites this replaced were the
 * verdict box, the T-pose ring and — worst — the gesture chips, where it was
 * set inside a helper called once per chip per frame. Canvas charges blur per
 * draw call, so that is four blurred strokes a frame for a halo nobody asked
 * for, on the one screen whose whole job is to tell us whether this laptop is
 * fast enough.
 */

import { camera, type CameraDevice } from '../core/camera';
import { vision } from '../core/vision';
import { PoseTracker } from '../core/tracker';
import { isSimEnabled } from '../core/simulator';
import {
  RepCounter,
  VerticalGestures,
  LaneDetector,
  MotionEnergy,
  TPoseDetector,
} from '../core/gestures';
import { POSE } from '../core/types';
import { Projection } from '../engine/projection';
import { drawPlayer, drawTrackDebug } from '../engine/skeleton';
import {
  clearFrame,
  drawTabularNumber,
  drawText,
  stickerCard,
  stickerPill,
  vh,
  progressBar,
} from '../engine/draw';
import { COLORS, PLAYER_COLORS, FONTS, SHADOW, STROKE, TRACK, WEIGHT } from './theme';
import type { Screen, FrameContext } from './screen';

interface FramingVerdict {
  ok: boolean;
  headline: string;
  detail: string;
  color: string;
}

export class RigCheckScreen implements Screen {
  readonly id = 'rigcheck';

  private tracker = new PoseTracker({ maxPlayers: 2, mirrored: true });
  private proj: Projection | null = null;
  private panel: HTMLElement | null = null;
  private devices: CameraDevice[] = [];

  // One gesture set per tracked slot, so two people can be tested at once.
  private reps = [new RepCounter(), new RepCounter()];
  private vertical = [new VerticalGestures(), new VerticalGestures()];
  private lanes = [new LaneDetector(), new LaneDetector()];
  /**
   * The panel's own copy of what it has told the worker.
   *
   * `renderPanel()` rewrites `innerHTML` wholesale, so without these the
   * `selected` attributes reverted to their literals on every redraw — and the
   * panel redraws whenever Video or Skeleton is toggled. The operator would
   * switch to the `full` model, toggle the skeleton to look at something, and
   * the dropdown would silently say `lite` while the worker kept running
   * `full`. Worse for the player count, which hardcoded `selected` on "2":
   * picking "2" after a redraw fires no `change` event at all, so it sticks.
   *
   * On the screen whose entire purpose is knowing what the rig is doing.
   */
  private poseModel: 'lite' | 'full' = 'lite';
  private numPoses = 2;

  /** Last energy per slot, sampled on inference only. See the MOTION readout. */
  private energy = [0, 0, 0, 0, 0, 0];

  private motion = [new MotionEnergy(), new MotionEnergy()];
  private tpose = new TPoseDetector();

  private showVideo = true;
  private showSkeleton = true;
  private lastFrameId = -1;

  /** Flash markers so you can see a gesture fire from across the room. */
  private flash = { jump: 0, crouch: 0, rep: 0, lane: 0 };

  async mount(root: HTMLElement): Promise<void> {
    this.panel = document.createElement('div');
    this.panel.className = 'rig-panel';
    root.appendChild(this.panel);

    // Guarded like every other vision consumer. Without this the screen hangs
    // on <STARTING CAMERA> forever under ?sim=1, where there is no camera to
    // start — which made the Sept 18 camera-test tool the one screen nobody
    // could exercise in development.
    if (!isSimEnabled()) {
      await vision.start({ mode: 'pose', numPoses: 2, poseModel: 'lite' });
    }

    this.devices = await camera.listDevices();
    this.renderPanel();
  }

  unmount(): void {
    this.panel?.remove();
    this.panel = null;
  }

  private renderPanel(): void {
    if (!this.panel) return;
    const cam = camera.getState();
    const stats = vision.getStats();

    const deviceOptions = this.devices
      .map(
        (d) =>
          `<option value="${d.deviceId}" ${d.deviceId === cam.deviceId ? 'selected' : ''}>${
            d.isLikelyExternal ? '📱 ' : '💻 '
          }${d.label}</option>`
      )
      .join('');

    this.panel.innerHTML = `
      <div class="rig-row"><strong>RIG CHECK</strong></div>
      <div class="rig-row">
        <label>Camera</label>
        <select id="rig-device">${deviceOptions}</select>
      </div>
      <div class="rig-row">
        <label>Pose model</label>
        <select id="rig-model">
          <option value="lite" ${this.poseModel === 'lite' ? 'selected' : ''}>lite (fast)</option>
          <option value="full" ${this.poseModel === 'full' ? 'selected' : ''}>full (accurate)</option>
        </select>
      </div>
      <div class="rig-row">
        <label>Track up to</label>
        <select id="rig-players">
          <option value="1" ${this.numPoses === 1 ? 'selected' : ''}>1 player</option>
          <option value="2" ${this.numPoses === 2 ? 'selected' : ''}>2 players</option>
          <option value="6" ${this.numPoses === 6 ? 'selected' : ''}>6 players</option>
        </select>
      </div>
      <div class="rig-row">
        <button id="rig-video">Video: ${this.showVideo ? 'on' : 'off'}</button>
        <button id="rig-skel">Skeleton: ${this.showSkeleton ? 'on' : 'off'}</button>
      </div>
      <div class="rig-row">
        <button id="rig-reset">Reset counters</button>
      </div>
      <hr>
      <div class="rig-stat"><span>resolution</span><b>${cam.width}×${cam.height}</b></div>
      <div class="rig-stat"><span>delegate</span><b>${stats.delegate ?? '—'}</b></div>
      <div class="rig-stat"><span>inference</span><b id="rig-fps">—</b></div>
      <div class="rig-stat"><span>latency</span><b id="rig-lat">—</b></div>
      <div class="rig-stat"><span>dropped</span><b id="rig-drop">—</b></div>
      <div class="rig-stat"><span>camera</span><b id="rig-cam">—</b></div>
      <div class="rig-stat"><span>vision</span><b id="rig-ready">—</b></div>
      <div class="rig-fault" id="rig-fault"></div>
      <div class="rig-stat"><span>build</span><b>${__BUILD_STAMP__}</b></div>
      <hr>
      <div class="rig-note">
        Stand back until <b>FULL BODY</b> shows green, then mark the floor with tape.
        Try both cameras. Cross over with a second person to test identity hold.
      </div>
    `;

    this.panel.querySelector<HTMLSelectElement>('#rig-device')?.addEventListener('change', (e) => {
      void camera.switchTo((e.target as HTMLSelectElement).value);
    });
    this.panel.querySelector<HTMLSelectElement>('#rig-model')?.addEventListener('change', (e) => {
      this.poseModel = (e.target as HTMLSelectElement).value as 'lite' | 'full';
      void vision.setConfig({ poseModel: this.poseModel });
    });
    this.panel.querySelector<HTMLSelectElement>('#rig-players')?.addEventListener('change', (e) => {
      const n = parseInt((e.target as HTMLSelectElement).value, 10);
      this.numPoses = n;
      this.tracker.setOptions({ maxPlayers: n });
      void vision.setConfig({ numPoses: n });
    });
    this.panel.querySelector('#rig-video')?.addEventListener('click', () => {
      this.showVideo = !this.showVideo;
      this.renderPanel();
    });
    this.panel.querySelector('#rig-skel')?.addEventListener('click', () => {
      this.showSkeleton = !this.showSkeleton;
      this.renderPanel();
    });
    this.panel.querySelector('#rig-reset')?.addEventListener('click', () => {
      for (const r of this.reps) r.reset();
      for (const v of this.vertical) v.reset();
      for (const l of this.lanes) l.reset();
      this.tracker.reset();
    });
  }

  private updateLiveStats(): void {
    if (!this.panel) return;
    const s = vision.getStats();
    const cam = camera.getState();
    const fps = this.panel.querySelector('#rig-fps');
    const lat = this.panel.querySelector('#rig-lat');
    const drop = this.panel.querySelector('#rig-drop');
    if (fps) fps.textContent = `${s.inferenceFps.toFixed(0)} fps / ${s.inferenceMs.toFixed(0)}ms`;
    if (lat) lat.textContent = `${s.latencyMs.toFixed(0)}ms`;
    if (drop) drop.textContent = String(s.dropped);

    // THE WHOLE POINT OF A DIAGNOSTIC SCREEN IS THAT IT NAMES THE FAULT.
    //
    // This panel showed delegate, fps, latency and dropped — every one of which
    // reads "—" or "0" whether the vision worker failed to load a model, the
    // camera never went live, or the player is simply standing out of frame.
    // Three completely different problems, one indistinguishable readout, and
    // the canvas behind it just says NO PLAYER DETECTED. `stats.error` was
    // being collected and never shown anywhere.
    const camEl = this.panel.querySelector('#rig-cam');
    const readyEl = this.panel.querySelector('#rig-ready');
    const fault = this.panel.querySelector('#rig-fault');
    if (camEl) camEl.textContent = camera.isLive() ? `live ${cam.width}×${cam.height}` : cam.status;
    if (readyEl) readyEl.textContent = s.ready ? `ready (${s.delegate ?? '?'})` : 'NOT READY';

    if (fault) {
      // Ordered by what has to be true first: no camera means the fps reading
      // is meaningless, and no worker means framing advice is premature.
      const msg = cam.error
        ? `CAMERA: ${cam.error}`
        : !camera.isLive()
          ? `CAMERA: ${cam.status} — no frames are being captured`
          : s.error
            ? `VISION: ${s.error}`
            : !s.ready
              ? 'VISION: worker has not finished loading the model'
              : s.inferenceFps < 1
                ? 'VISION: model loaded but no frames are coming back'
                : (s.warning ?? '');
      fault.textContent = msg;
      (fault as HTMLElement).style.display = msg ? 'block' : 'none';
    }
  }

  /**
   * The actual point of this screen. Answers "can the camera see the whole
   * player" in terms an operator can act on while standing in the room.
   */
  private judgeFraming(player: ReturnType<PoseTracker['getPrimary']>): FramingVerdict {
    if (!player) {
      // Not a failure, just nothing to report yet — so it gets ink on paper
      // rather than one of the four brand colours, which all mean something
      // specific on this screen.
      return {
        ok: false,
        headline: 'NO PLAYER DETECTED',
        detail: 'STEP INTO THE CAMERA VIEW',
        color: COLORS.ink,
      };
    }

    const lm = player.landmarks;
    const head = (lm[POSE.NOSE]?.visibility ?? 0) > 0.5;
    const leftAnkle = (lm[POSE.LEFT_ANKLE]?.visibility ?? 0) > 0.5;
    const rightAnkle = (lm[POSE.RIGHT_ANKLE]?.visibility ?? 0) > 0.5;
    const feet = leftAnkle || rightAnkle;

    // In-frame check. A landmark can be "visible" (confident) while sitting
    // outside 0..1, i.e. MediaPipe extrapolating past the frame edge.
    const inFrame = (i: number) => {
      const l = lm[i];
      return !!l && l.x > 0.02 && l.x < 0.98 && l.y > 0.02 && l.y < 0.98;
    };
    const headIn = inFrame(POSE.NOSE);
    const feetIn = inFrame(POSE.LEFT_ANKLE) || inFrame(POSE.RIGHT_ANKLE);

    const torso = player.scale.torsoHeight;

    // Capitals throughout: DESIGN.md has no lowercase headings, and the detail
    // line is read across a room too. Each one still names the next action.
    if (!head || !headIn) {
      return {
        ok: false,
        headline: 'HEAD OUT OF FRAME',
        detail: 'TILT THE CAMERA DOWN, OR STEP BACK',
        color: COLORS.red,
      };
    }
    if (!feet || !feetIn) {
      return {
        ok: false,
        headline: 'LEGS CUT OFF',
        detail:
          torso > 0.28
            ? 'TOO CLOSE — STEP BACK ABOUT A METRE'
            : 'TILT THE LID BACK / RAISE THE CAMERA',
        color: COLORS.red,
      };
    }
    if (torso > 0.30) {
      return {
        ok: true,
        headline: 'FULL BODY — TIGHT',
        detail: 'WORKS, BUT NO HEADROOM FOR JUMPING. STEP BACK A LITTLE.',
        color: COLORS.yellow,
      };
    }
    if (torso < 0.09) {
      return {
        ok: true,
        headline: 'FULL BODY — DISTANT',
        detail: 'TRACKING WILL GET NOISY THIS FAR OUT. STEP IN IF YOU CAN.',
        color: COLORS.yellow,
      };
    }
    // Was 'FULL BODY ✓'. The tick is decoration the brand does not use, and
    // Archivo is not guaranteed to carry U+2713 — a missing-glyph box on the
    // one line that says "this rig is good" would be an unfortunate way to
    // find that out in the room on the 18th.
    return {
      ok: true,
      headline: '<FULL BODY OK>',
      detail: 'GOOD FRAMING. TAPE THE FLOOR HERE AND LOCK THE LID ANGLE.',
      color: COLORS.green,
    };
  }

  render(fc: FrameContext): void {
    const { ctx, v, now } = fc;
    clearFrame(ctx, v);

    // FIRST, not last. This used to be the closing statement of `render`,
    // after several early returns — including the camera-error one below. So
    // the side panel's fault banner, the one thing on this screen that NAMES
    // what is wrong, stayed blank in exactly the situation it was written for:
    // the canvas saying CAMERA ERROR or hanging on <STARTING CAMERA>.
    this.updateLiveStats();

    const cam = camera.getState();

    if (cam.status === 'error') {
      drawText(ctx, '<CAMERA ERROR>', v.width / 2, v.height / 2 - vh(v, 4), {
        size: vh(v, 5),
        color: COLORS.red,
        shadow: vh(v, SHADOW.lifted),
      });
      drawText(ctx, cam.error ?? '', v.width / 2, v.height / 2 + vh(v, 2), {
        size: vh(v, 2.2),
        color: COLORS.muted,
        font: FONTS.body,
        weight: WEIGHT.medium,
      });
      return;
    }

    // In sim mode there is no camera to go live, but the synthetic skeleton and
    // every gesture readout still work — which is the whole point of being able
    // to develop this screen without hardware.
    if (cam.status !== 'live' && !isSimEnabled()) {
      drawText(ctx, '<STARTING CAMERA>', v.width / 2, v.height / 2, {
        size: vh(v, 4),
        color: COLORS.ink,
      });
      return;
    }

    if (!this.proj) {
      this.proj = new Projection(v, {
        cameraWidth: cam.width,
        cameraHeight: cam.height,
        fit: 'contain', // must see the WHOLE frame — cropping would hide the bug
        mirrored: true,
      });
    } else {
      this.proj.update(v, { cameraWidth: cam.width, cameraHeight: cam.height });
    }

    if (this.showVideo) {
      this.proj.drawVideo(ctx, camera.getVideo(), 0.45);
    }

    // Only step the tracker on genuinely new inference results, otherwise the
    // One Euro filter sees duplicate samples and over-smooths.
    let players = this.tracker.getPlayers();
    if (fc.vision && fc.vision.frameId !== this.lastFrameId) {
      this.lastFrameId = fc.vision.frameId;
      players = this.tracker.update(fc.vision.poses, fc.time);

      for (const p of players) {
        const slot = p.slot >= 0 && p.slot < 2 ? p.slot : 0;
        const before = this.reps[slot]!.count;
        this.reps[slot]!.update(p, now);
        if (this.reps[slot]!.count !== before) this.flash.rep = now;

        this.vertical[slot]!.update(p, now);
        if (this.vertical[slot]!.jumped) this.flash.jump = now;
        if (this.vertical[slot]!.crouched) this.flash.crouch = now;

        this.lanes[slot]!.update(p, true);
        if (this.lanes[slot]!.changed !== 0) this.flash.lane = now;

        // Keep the value. It used to be discarded here and the detector
        // stepped a SECOND time from the draw path, once per rendered frame —
        // see `energy` below.
        this.energy[slot] = this.motion[slot]!.update(p);
      }
    }

    for (const p of players) {
      const color = PLAYER_COLORS[Math.max(0, p.slot) % PLAYER_COLORS.length]!;
      if (this.showSkeleton) drawPlayer(ctx, p, this.proj, color, 'diagnostic');
      drawTrackDebug(ctx, p, this.proj, color);
    }

    this.drawFramingVerdict(fc, players.length);
    this.drawGesturePanel(fc, players);
  }

  private drawFramingVerdict(fc: FrameContext, playerCount: number): void {
    const { ctx, v, now } = fc;
    const primary = this.tracker.getPrimary();
    const verdict = this.judgeFraming(primary);

    const boxH = vh(v, 13);
    const boxW = Math.min(v.width * 0.62, vh(v, 90));
    const x = (v.width - boxW) / 2;
    const y = vh(v, 3);

    // THE VERDICT IS THE SURFACE, NOT THE OUTLINE.
    //
    // This was a translucent dark panel with a coloured, blurred border and
    // coloured type inside it. Both the tint and the blur are out, and once the
    // panel is paper a green or yellow HEADLINE on it is barely legible at all,
    // let alone from the far side of the room while you are holding a tripod.
    // So the card is filled with the verdict colour and the type on it is ink —
    // the same inversion `drawTargetMarker` makes in games/base.ts.
    const neutral = !primary;
    stickerCard(ctx, v, x, y, boxW, boxH, {
      radius: vh(v, 1.6),
      fill: neutral ? COLORS.paper : verdict.color,
      outline: COLORS.ink,
      outlineWidth: vh(v, STROKE.thick),
      shadow: vh(v, SHADOW.lifted),
    });

    drawText(ctx, verdict.headline, v.width / 2, y + boxH * 0.34, {
      size: vh(v, 4.2),
      color: COLORS.ink,
      letterSpacing: '0.04em',
    });
    drawText(ctx, verdict.detail, v.width / 2, y + boxH * 0.68, {
      size: vh(v, 2),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: TRACK.pill,
    });

    if (primary) {
      const torso = primary.scale.torsoHeight;
      // Tabular: every figure on this line moves continuously while somebody
      // walks backwards looking at it, and proportional digits make the whole
      // string shuffle sideways as they do.
      drawTabularNumber(
        ctx,
        `TORSO ${(torso * 100).toFixed(0)}% OF FRAME · UNIT ${primary.scale.unit.toFixed(3)} · TRACKING ${playerCount}`,
        v.width / 2,
        y + boxH + vh(v, 2.6),
        {
          size: vh(v, 1.6),
          color: COLORS.muted,
          font: FONTS.mono,
          weight: WEIGHT.bold,
          letterSpacing: TRACK.number,
        }
      );

      // T-pose ring — verifies the calibration confirm gesture works for this
      // body before we rely on it in the real flow.
      const t = this.tpose.update(primary, now);
      if (t > 0) {
        const cx = v.width / 2;
        const cy = y + boxH + vh(v, 8);
        const r = vh(v, 2.5);
        const w = vh(v, 1);
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.lineWidth = w;
        // Grid for the empty track, flat brand colour for the filled arc. The
        // track used to be blue at 25% — a tint of a brand colour — and the arc
        // wore a blur to compensate for how weak that made it look.
        ctx.strokeStyle = COLORS.grid;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = t >= 1 ? COLORS.green : COLORS.blue;
        ctx.beginPath();
        ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        drawText(ctx, t >= 1 ? '<T-POSE OK>' : 'HOLD T-POSE', cx, cy + r + vh(v, 2.4), {
          size: vh(v, 1.6),
          color: t >= 1 ? COLORS.ink : COLORS.muted,
          font: FONTS.mono,
          weight: WEIGHT.bold,
          letterSpacing: TRACK.pill,
        });
      }
    }
  }

  /** Live gesture readout — proves the detectors fire for this body and this
   *  camera height before we trust them in a game. */
  private drawGesturePanel(fc: FrameContext, players: ReturnType<PoseTracker['getPlayers']>): void {
    const { ctx, v, now } = fc;
    if (players.length === 0) return;

    const pad = vh(v, 3);
    const rowH = vh(v, 3.2);
    let y = v.height - pad - rowH * 5;

    /**
     * One detector's state, as a sticker pill.
     *
     * FIRING NOW is a flat brand fill with ink type on it and a hard shadow;
     * idle is the brand's empty slot — paper, muted outline, muted type, flat
     * on the page. The difference has to be obvious in peripheral vision, since
     * the whole point is to catch a gesture firing while you are looking at the
     * person, not the screen. A fill/no-fill flip does that better than the
     * blurred halo it replaces, and it costs two fills instead of a per-call
     * blur charged four times a frame.
     */
    const chip = (label: string, value: string, active: boolean, color: string) => {
      const w = vh(v, 26);
      const x = pad;
      const h = rowH * 0.85;

      stickerPill(ctx, v, x, y, w, h, {
        fill: active ? color : COLORS.paper,
        outline: active ? COLORS.ink : COLORS.muted,
        outlineWidth: vh(v, active ? STROKE.base : STROKE.thin),
        shadow: active ? vh(v, SHADOW.base) : 0,
      });

      drawText(ctx, label, x + vh(v, 1.6), y + h / 2, {
        size: vh(v, 1.7),
        color: active ? COLORS.ink : COLORS.muted,
        align: 'left',
        font: FONTS.mono,
        weight: WEIGHT.bold,
        letterSpacing: TRACK.pill,
      });
      drawTabularNumber(ctx, value, x + w - vh(v, 1.6), y + h / 2, {
        size: vh(v, 1.7),
        color: active ? COLORS.ink : COLORS.muted,
        align: 'right',
        font: FONTS.mono,
        weight: WEIGHT.black,
        letterSpacing: TRACK.number,
      });
      y += rowH;
    };

    const recent = (t: number) => now - t < 220;
    const g0 = this.vertical[0]!;
    const l0 = this.lanes[0]!;
    const r0 = this.reps[0]!;

    chip('JUMP', g0.isAirborne ? 'AIRBORNE' : '—', recent(this.flash.jump) || g0.isAirborne, COLORS.green);
    chip('CROUCH', g0.isCrouching ? 'DOWN' : '—', recent(this.flash.crouch) || g0.isCrouching, COLORS.yellow);
    chip('LANE', ['LEFT', 'CENTRE', 'RIGHT'][l0.current + 1] ?? '—', recent(this.flash.lane), COLORS.blue);
    chip('REPS (67)', `${r0.count}  ${r0.rate.toFixed(1)}/s`, recent(this.flash.rep), COLORS.red);

    // Motion energy bar — the Red Light, Green Light signal.
    //
    // READ, never stepped. `MotionEnergy` diffs consecutive RAW samples over a
    // short window, so it must be advanced exactly once per INFERENCE. This
    // line used to call `update()` itself, from the draw path, once per
    // rendered frame — at 60fps render against ~30fps inference that feeds it
    // one real sample and one duplicate, halving the reported energy and
    // making the red threshold essentially untrippable. On the one screen
    // whose entire job is to tell an operator whether the detector can see
    // movement.
    //
    // Indexed by the PLAYER'S slot rather than a fixed 0, too: `players` is in
    // insertion order, so with two people in frame the readout was pairing one
    // person's detector with another person's body — and the two-person
    // crossover test is exactly what this screen advertises.
    const readSlot = Math.max(0, Math.min(this.energy.length - 1, players[0]!.slot));
    const energy = Math.min(1, (this.energy[readSlot] ?? 0) * 12);
    drawText(ctx, 'MOTION', pad, y + rowH * 0.42, {
      size: vh(v, 1.7),
      color: COLORS.muted,
      align: 'left',
      font: FONTS.mono,
      weight: WEIGHT.bold,
      letterSpacing: TRACK.pill,
    });
    // `progressBar` is already on-brand — grid track, flat fill, ink outline,
    // no blur. Its trailing glow argument is ignored; passed as 0 so nothing
    // here reads as if a halo were still intended.
    progressBar(
      ctx, pad + vh(v, 9), y + rowH * 0.2, vh(v, 17), vh(v, 0.9),
      energy, energy > 0.35 ? COLORS.red : COLORS.green, 0
    );
  }
}
