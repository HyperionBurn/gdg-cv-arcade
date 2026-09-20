/**
 * The debug overlay. Press `d`.
 *
 * WHY THIS EXISTS: the first real-camera session produced a list of symptoms —
 * "right hand is murky", "67 is finicky", "saw 1 person as 4", "runner didn't
 * detect movement", "pose match is laggy" — and not one of them could be told
 * apart from the outside. Bad framing, a dropped delegate, a phantom detection
 * and a threshold tuned on a simulator all look identical when the only signal
 * is that the game is not responding.
 *
 * So this shows the pipeline stage by stage, from camera to accepted player, in
 * the order the frame travels. The first row that looks wrong is the fault.
 *
 * AVAILABLE IN PRODUCTION, deliberately. `?sim=1` and the dev harness are not
 * there on the night; a stall at 3pm with a queue is exactly when this is
 * needed, and it costs nothing until switched on.
 */

import { leaderboard } from '../meta/leaderboard';
import { tunables } from '../meta/tunables';
import { tournament } from '../meta/tournament';
import { highlights } from '../meta/highlights';
import { camera } from '../core/camera';
import { vision } from '../core/vision';
import { isSimEnabled } from '../core/simulator';
import { selectCandidates } from '../core/candidates';
import { POSE } from '../core/types';
import { COLORS, FONTS } from './theme';
import type { FrameContext } from './screen';

/** Rolling event log. Small on purpose — this is a HUD, not a console. */
const MAX_EVENTS = 8;
const events: Array<{ t: number; text: string }> = [];

let enabled = false;

export function isDebugVisible(): boolean {
  return enabled;
}

export function toggleDebug(): boolean {
  enabled = !enabled;
  if (enabled) logDebug('debug overlay on');
  return enabled;
}

/**
 * Record something worth seeing later. Deduplicated against the previous entry,
 * because a fault that recurs every frame would otherwise flush the log.
 */
export function logDebug(text: string): void {
  const last = events[events.length - 1];
  if (last && last.text === text) return;
  events.push({ t: performance.now(), text });
  if (events.length > MAX_EVENTS) events.shift();
}

/** Wire the vision stream into the log once, at boot. */
export function watchForDebug(): void {
  vision.subscribeStats((s) => {
    if (s.error) logDebug(`vision error: ${s.error}`);
    if (s.warning) logDebug(`vision: ${s.warning}`);
  });
}

interface Row {
  label: string;
  value: string;
  /** Red when this row is the thing that is wrong. */
  bad?: boolean;
}

/**
 * Pipeline rows, in the order a frame actually travels. Reading top to bottom,
 * the first bad row is the cause and everything under it is a consequence.
 */
function rows(fc: FrameContext): Row[] {
  const cam = camera.getState();
  const vs = vision.getStats();
  const sim = isSimEnabled();
  const out: Row[] = [];

  out.push({ label: 'build', value: __BUILD_STAMP__ });

  // 0. SAY WHEN THERE IS NO CAMERA BY DESIGN.
  //
  // The day-of card sends a marshal to `?sim=1` when the camera dies, and in
  // that mode the three rows below read "idle", "loading" and "0fps 0ms"
  // forever — every one of them true, and together indistinguishable from a
  // pipeline that has failed. Somebody debugging a dead stall does not need a
  // second thing that looks broken.
  if (sim) out.push({ label: 'mode', value: 'SIMULATOR — no camera by design' });

  // 1. Camera.
  const live = camera.isLive();
  out.push({
    label: 'camera',
    value: sim ? 'not used (sim)' : live ? `${cam.width}x${cam.height}` : (cam.error ?? cam.status),
    bad: !live && !sim,
  });

  // 2. Worker + model.
  out.push({
    label: 'vision',
    value: sim
      ? 'not used (sim)'
      : vs.error
        ? vs.error
        : vs.ready
          ? `ready ${vs.delegate ?? '?'}`
          : 'loading',
    bad: !sim && (!!vs.error || (!vs.ready && live)),
  });

  // 3. Inference throughput. CPU fallback is the usual cause of "laggy", and it
  //    is invisible without this row.
  if (!sim) {
    out.push({
      label: 'inference',
      value: `${vs.inferenceFps.toFixed(0)}fps ${vs.inferenceMs.toFixed(0)}ms`,
      bad: vs.ready && live && (vs.inferenceFps < 12 || vs.inferenceMs > 45),
    });
    out.push({
      label: 'latency',
      value: `${vs.latencyMs.toFixed(0)}ms  drop ${vs.dropped}`,
      bad: vs.latencyMs > 160,
    });
  }

  // 4. What MediaPipe returned vs what survived the filters. This is the row
  //    that makes "one person read as four" visible: raw 4, people 1.
  const raw = fc.vision?.poses.length ?? 0;
  const accepted = fc.vision
    ? selectCandidates(fc.vision.poses, {
        maxPlayers: 6,
        minArea: 0.02,
        // Mirrors DEFAULT_TRACKER_OPTIONS: a turned body's bounding box shrinks
        // even though the person has not moved, so `unit` is the second,
        // rotation-stable way in.
        minUnit: 0.085,
        minConfidence: 0.45,
        dedupeTorsos: 0.55,
        minRelativeSize: 0.5,
        aspect: (cam.width || 16) / (cam.height || 9),
      })
    : [];
  out.push({
    label: 'poses',
    value: `raw ${raw} -> people ${accepted.length}`,
    bad: raw > 0 && accepted.length === 0,
  });

  // 5. The nearest body's own numbers, which is what every gesture threshold is
  //    actually measured against.
  const best = accepted[0];
  if (best) {
    out.push({ label: 'torso', value: best.unit.toFixed(3) });
    out.push({ label: 'confid', value: best.confidence.toFixed(2), bad: best.confidence < 0.6 });
    out.push({
      label: 'centre',
      value: `${best.centroid.x.toFixed(2)},${best.centroid.y.toFixed(2)}`,
    });
    // Too close is the framing failure people actually make at a laptop.
    if (best.unit > 0.32) out.push({ label: 'framing', value: 'TOO CLOSE', bad: true });
    else if (best.unit < 0.07) out.push({ label: 'framing', value: 'too far', bad: true });

    // HEADROOM: is there room ABOVE the player for a raised hand?
    //
    // Reported from a playtest as "when I reach up I get height restricted" on
    // a rig framed down to the knees. A low, close camera frames the body
    // beautifully and leaves nothing above the head — so a raised wrist exits
    // the top of the frame, its landmark pins to y=0, and the cursor stops
    // rising however far the hand keeps going. Indistinguishable from a
    // detector bug unless someone can see it.
    //
    // Measured in torso units from the top of the frame to the shoulder line,
    // because that is the space a raised arm has to fit into. A full overhead
    // reach needs ~1.15; below that the top of the screen is unreachable no
    // matter how the cursor is tuned, and the fix is the tripod, not the code.
    const lm = best.pose.landmarks;
    const ls = lm[POSE.LEFT_SHOULDER];
    const rs = lm[POSE.RIGHT_SHOULDER];
    if (ls && rs && best.unit > 0) {
      const headroom = ((ls.y + rs.y) / 2) / best.unit;
      out.push({
        label: 'headroom',
        value: `${headroom.toFixed(2)} torso`,
        bad: headroom < 1.2,
      });
    }
  }

  // 6. Storage. Everything is running from memory only, nothing else says so,
  // and the runbook's answer to four different problems is F5 — which would
  // throw the day away. Same chip in the operator console.
  //
  // One row each, in the order they NOTICE, which is the order they write:
  // tuning on every slider move, the bracket on every reported match, scores
  // only on a submit. So a dead disk surfaces as `tuning` long before a single
  // score would have revealed it.
  //
  // The bracket is the one that cannot be reconstructed — a lost score is a
  // number somebody can tell you again, a lost bracket is who beat whom across
  // a whole afternoon.
  if (tunables.saveFailed) {
    out.push({ label: 'tuning', value: 'NOT SAVING — DO NOT RELOAD', bad: true });
  }
  if (tournament.saveFailed) {
    out.push({ label: 'bracket', value: 'NOT SAVING — DO NOT RELOAD', bad: true });
  }
  if (leaderboard.saveFailed) {
    out.push({ label: 'scores', value: 'NOT SAVING — DO NOT RELOAD', bad: true });
  }

  // 7. The highlight buffer, which until now reported NOTHING anywhere.
  //
  // It is the largest single allocation in the app (18.9 MB across two
  // atlases, plus 2.4 MB of attract reel) and it has a cost guard that can
  // switch itself off without saying so. The failure it guards against is the
  // measured GPU cliff at the top of meta/highlights.ts: past a certain total
  // allocation every blit becomes a readback and one frame costs 448 ms.
  //
  // So a marshal seeing "the replays stopped" and a marshal seeing "the screen
  // stutters" are looking at the same event, and before this row there was no
  // way to tell — the same shape as the storage flags above, and the reason
  // they exist.
  const hs = highlights.stats();
  if (!hs.enabled) {
    out.push({ label: 'replay', value: 'OFF', bad: hs.shedLevel > 0 });
  } else if (hs.shedLevel > 0) {
    out.push({
      label: 'replay',
      value: `SHED x${hs.shedLevel} @ ${hs.shedMeanMs.toFixed(1)}ms`,
      bad: true,
    });
  } else {
    out.push({ label: 'replay', value: `${(hs.bytes / 1048576).toFixed(1)}MB ${hs.avgGrabMs.toFixed(1)}ms` });
  }

  const rs = highlights.reelStats();
  out.push({
    label: 'reel',
    // `filled/slots` is the number that says whether attract has anything to
    // show. 0/4 on a fresh boot is correct; 0/4 an hour in is not.
    value: rs.enabled ? `${rs.filled}/${rs.slots}` : 'OFF',
    bad: !rs.enabled && hs.enabled,
  });

  // 8. Render cost, to separate "the game is slow" from "vision is slow".
  out.push({ label: 'frame', value: `${(fc.dt * 1000).toFixed(1)}ms` , bad: fc.dt > 0.03 });

  return out;
}

export function drawDebugOverlay(fc: FrameContext): void {
  if (!enabled) return;
  const { ctx, v } = fc;

  const pad = Math.max(8, v.height * 0.012);
  const size = Math.max(11, v.height * 0.016);
  const lh = size * 1.5;
  const data = rows(fc);
  const w = Math.max(v.width * 0.24, size * 17);
  const h = pad * 2 + lh * (data.length + Math.min(events.length, MAX_EVENTS) + 1);

  ctx.save();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;

  // Paper plate with a hard ink edge — legible over any playfield, same rule
  // the rest of the app follows.
  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = COLORS.ink;
  ctx.fillRect(w, 0, Math.max(2, size * 0.14), h);
  ctx.fillRect(0, h, w + Math.max(2, size * 0.14), Math.max(2, size * 0.14));

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${size}px ${FONTS.mono}`;

  let y = pad + lh / 2;
  for (const r of data) {
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(r.label, pad, y);
    ctx.fillStyle = r.bad ? COLORS.red : COLORS.ink;
    ctx.fillText(r.value, pad + size * 5.2, y);
    y += lh;
  }

  y += lh * 0.3;
  ctx.font = `500 ${size * 0.92}px ${FONTS.mono}`;
  for (const e of events) {
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(e.text.slice(0, 44), pad, y);
    y += lh;
  }

  ctx.restore();
}
