/**
 * Skeleton and hand rendering.
 *
 * Used by the rig check (diagnostic, shows confidence) and attract mode
 * (cosmetic, shows a glowing figure that pulls people toward the stall).
 */

import { POSE, POSE_CONNECTIONS, HAND_CONNECTIONS, type Landmark } from '../core/types';
import type { TrackedPlayer } from '../core/tracker';
import type { RawHand } from '../core/types';
import type { Projection } from './projection';
import { COLORS, withAlpha } from '../shell/theme';

export interface SkeletonStyle {
  color: string;
  lineWidth: number;
  jointRadius: number;
  glow: number;
  alpha: number;
  /** Fade limbs by landmark visibility — makes dropout legible at a glance. */
  showConfidence: boolean;
  showJoints: boolean;
}

export const SKELETON_STYLES = {
  diagnostic: {
    lineWidth: 5,
    jointRadius: 5,
    glow: 10,
    alpha: 1,
    showConfidence: true,
    showJoints: true,
  },
  attract: {
    lineWidth: 12,
    jointRadius: 0,
    glow: 40,
    alpha: 0.9,
    showConfidence: false,
    showJoints: false,
  },
} as const;

/**
 * Draws a pose as a glowing skeleton.
 *
 * NO shadowBlur. `style.glow` controls HALO WIDTH, not blur radius.
 *
 * The obvious implementation — set shadowBlur once, then stroke each limb —
 * looks right and is a performance trap: canvas pays the blur per stroke, so a
 * 43px blur is charged ~19 times per person per frame. Measured on attract mode
 * at 4 players / 1080p that was 92.8ms/frame — 10fps, on the screen that runs
 * for eight hours straight.
 *
 * Three unblurred passes (wide faint halo, mid, bright core) read as glow from
 * 3m and cost a fraction of it. The core stays tinted rather than white so a
 * player's slot colour still identifies them in a crowd.
 */
function strokeSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: readonly Landmark[],
  proj: Projection,
  style: SkeletonStyle,
  width: number,
  alpha: number
): void {
  ctx.lineWidth = width;
  for (const [a, b] of POSE_CONNECTIONS) {
    const la = landmarks[a];
    const lb = landmarks[b];
    if (!la || !lb) continue;
    const conf = Math.min(la.visibility, lb.visibility);
    if (conf < 0.2) continue;
    ctx.strokeStyle = withAlpha(
      style.color,
      alpha * (style.showConfidence ? Math.max(0.15, conf) : 1)
    );
    ctx.beginPath();
    ctx.moveTo(proj.x(la.x), proj.y(la.y));
    ctx.lineTo(proj.x(lb.x), proj.y(lb.y));
    ctx.stroke();
  }
}

export function drawPose(
  ctx: CanvasRenderingContext2D,
  landmarks: readonly Landmark[],
  proj: Projection,
  style: SkeletonStyle
): void {
  ctx.save();
  ctx.globalAlpha = style.alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const halo = style.glow;
  if (halo > 0) {
    strokeSkeleton(ctx, landmarks, proj, style, style.lineWidth + halo * 0.9, 0.1);
    strokeSkeleton(ctx, landmarks, proj, style, style.lineWidth + halo * 0.4, 0.2);
  }
  strokeSkeleton(ctx, landmarks, proj, style, style.lineWidth, 1);

  if (style.showJoints) {
    for (let i = 11; i < landmarks.length; i++) {
      const lm = landmarks[i];
      if (!lm || lm.visibility < 0.2) continue;
      ctx.fillStyle = withAlpha(style.color, Math.max(0.2, lm.visibility));
      ctx.beginPath();
      ctx.arc(proj.x(lm.x), proj.y(lm.y), style.jointRadius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Head as a single circle sized from ear spacing — drawing the full face
  // mesh from pose landmarks looks like a bug, not a feature.
  const nose = landmarks[POSE.NOSE];
  const le = landmarks[POSE.LEFT_EAR];
  const re = landmarks[POSE.RIGHT_EAR];
  if (nose && nose.visibility > 0.3) {
    let r = style.lineWidth * 2.2;
    if (le && re && le.visibility > 0.3 && re.visibility > 0.3) {
      const dx = proj.x(le.x) - proj.x(re.x);
      const dy = proj.y(le.y) - proj.y(re.y);
      r = Math.max(r, Math.sqrt(dx * dx + dy * dy) * 0.62);
    }
    const drawHead = (w: number, a: number) => {
      ctx.strokeStyle = withAlpha(
        style.color,
        a * (style.showConfidence ? Math.max(0.2, nose.visibility) : 1)
      );
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.arc(proj.x(nose.x), proj.y(nose.y), r, 0, Math.PI * 2);
      ctx.stroke();
    };
    if (halo > 0) drawHead(style.lineWidth + halo * 0.5, 0.15);
    drawHead(style.lineWidth, 1);
  }

  ctx.restore();
}

export function drawPlayer(
  ctx: CanvasRenderingContext2D,
  player: TrackedPlayer,
  proj: Projection,
  color: string,
  preset: keyof typeof SKELETON_STYLES = 'diagnostic'
): void {
  // The DIAGNOSTIC skeleton always draws in ink.
  //
  // It used to take the caller's player colour, and PLAYER_COLORS[0] is yellow
  // — 1.7:1 against paper, i.e. the one brand pairing that disappears. That
  // made the live figure on the Sept 18 camera-test tool, whose entire job is
  // being readable across a room while someone adjusts a camera, the least
  // readable thing on the screen.
  //
  // Player identity still comes through: the caller draws a coloured ID badge
  // and bounding box (drawTrackDebug). The skeleton itself is structure, and
  // structure is ink.
  const resolved = preset === 'diagnostic' ? COLORS.ink : color;
  drawPose(ctx, player.landmarks, proj, { ...SKELETON_STYLES[preset], color: resolved });
}

export function drawHand(
  ctx: CanvasRenderingContext2D,
  hand: RawHand,
  proj: Projection,
  color: string,
  lineWidth = 4,
  glow = 12
): void {
  ctx.save();
  ctx.lineCap = 'round';

  // Halo passes rather than shadowBlur — see drawPose.
  const pass = (w: number, a: number) => {
    ctx.strokeStyle = withAlpha(color, a);
    ctx.lineWidth = w;
    for (const [i, j] of HAND_CONNECTIONS) {
      const la = hand.landmarks[i];
      const lb = hand.landmarks[j];
      if (!la || !lb) continue;
      ctx.beginPath();
      ctx.moveTo(proj.x(la.x), proj.y(la.y));
      ctx.lineTo(proj.x(lb.x), proj.y(lb.y));
      ctx.stroke();
    }
  };
  if (glow > 0) pass(lineWidth + glow * 0.5, 0.18);
  pass(lineWidth, 1);

  ctx.fillStyle = color;
  for (const lm of hand.landmarks) {
    ctx.beginPath();
    ctx.arc(proj.x(lm.x), proj.y(lm.y), lineWidth * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Bounding box + slot label. Diagnostic only — makes it obvious at a glance
 * whether the tracker is holding identities or swapping them.
 */
export function drawTrackDebug(
  ctx: CanvasRenderingContext2D,
  player: TrackedPlayer,
  proj: Projection,
  color: string
): void {
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (const lm of player.landmarks) {
    if (lm.visibility < 0.3) continue;
    minX = Math.min(minX, lm.x);
    maxX = Math.max(maxX, lm.x);
    minY = Math.min(minY, lm.y);
    maxY = Math.max(maxY, lm.y);
  }

  const x1 = proj.x(minX);
  const x2 = proj.x(maxX);
  const y1 = proj.y(minY);
  const y2 = proj.y(maxY);

  ctx.save();
  ctx.strokeStyle = withAlpha(color, 0.5);
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(Math.min(x1, x2), y1, Math.abs(x2 - x1), y2 - y1);
  ctx.restore();
}
