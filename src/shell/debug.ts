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

import { camera } from '../core/camera';
import { vision } from '../core/vision';
import { selectCandidates } from '../core/candidates';
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
  const out: Row[] = [];

  out.push({ label: 'build', value: __BUILD_STAMP__ });

  // 1. Camera.
  const live = camera.isLive();
  out.push({
    label: 'camera',
    value: live ? `${cam.width}x${cam.height}` : (cam.error ?? cam.status),
    bad: !live,
  });

  // 2. Worker + model.
  out.push({
    label: 'vision',
    value: vs.error ? vs.error : vs.ready ? `ready ${vs.delegate ?? '?'}` : 'loading',
    bad: !!vs.error || (!vs.ready && live),
  });

  // 3. Inference throughput. CPU fallback is the usual cause of "laggy", and it
  //    is invisible without this row.
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

  // 4. What MediaPipe returned vs what survived the filters. This is the row
  //    that makes "one person read as four" visible: raw 4, people 1.
  const raw = fc.vision?.poses.length ?? 0;
  const accepted = fc.vision
    ? selectCandidates(fc.vision.poses, {
        maxPlayers: 6,
        minArea: 0.02,
        minConfidence: 0.45,
        dedupeTorsos: 0.55,
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
  }

  // 6. Render cost, to separate "the game is slow" from "vision is slow".
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
