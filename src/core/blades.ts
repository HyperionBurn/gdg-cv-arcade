/**
 * Blade tips — the "hands" every swipe game is played with.
 *
 * DESIGN CALL: blades come from POSE WRISTS, not MediaPipe hand landmarks.
 *
 * The stall is framed for full body at 2.5–3m (PLAN.md §9). At that distance a
 * hand is a tiny fraction of the frame and HandLandmarker becomes unreliable,
 * while pose wrists stay solid. Running the hand model as well would also cost
 * another ~10–15ms of inference per frame on top of pose, against a 30fps
 * budget shared with a 60fps render.
 *
 * We lose finger-level precision and gain a game that works at the distance the
 * room actually forces. For a blade rendered as a thick glowing trail on a TV
 * viewed from 3m, precision was never the point.
 *
 * HandLandmarker stays available in the vision worker for the photobooth, where
 * people stand close to the screen.
 *
 * The other half of this module is the swipe SEGMENT. Collision must be tested
 * against the line the hand travelled through since the last frame, never
 * against its current point: at 30fps a fast swipe moves the wrist hundreds of
 * pixels between samples, and point testing simply tunnels through everything.
 */

import { POSE, type Landmark } from './types';
import { COLORS } from '../shell/theme';
import type { TrackedPlayer } from './tracker';

export interface BladePoint {
  x: number;
  y: number;
}

export interface Blade {
  /** Stable per player+hand, so trails don't swap between hands. */
  id: string;
  slot: number;
  side: 'left' | 'right';
  /** Current tip, in SCREEN pixels. */
  x: number;
  y: number;
  /** Previous frame's tip. The segment (px,py)->(x,y) is the cutting edge. */
  px: number;
  py: number;
  /** Pixels per second. */
  speed: number;
  /** Radians, direction of travel. */
  angle: number;
  /** True when moving fast enough to cut. Stops resting hands mowing the field. */
  active: boolean;
  /**
   * Set for the ONE frame after this blade snapped to a new position rather
   * than travelling there — a visibility dropout returning, or a jump too
   * large to be an arm.
   *
   * Consumers that treat the gap between frames as a swipe must ignore that
   * frame entirely. Snapping `px/py` stops the phantom SEGMENT, but a game
   * holding its own per-note "was this hand outside the ring" flag can still
   * be fooled by the snapped position alone.
   */
  reacquired: boolean;
  visible: boolean;
  /** Recent tips, newest last. Drives the trail ribbon. */
  trail: BladePoint[];
}

export interface BladeTunables {
  /**
   * Minimum tip speed to cut, as a fraction of screen height per second.
   * Below this the blade is inert — otherwise a player standing still with
   * their hands up would passively harvest everything that touched them,
   * which removes the entire game.
   */
  activateSpeed: number;
  /** Hysteresis: once active, stay active until below this. */
  deactivateSpeed: number;
  trailLength: number;
  /** Ignore a wrist below this landmark visibility. */
  minVisibility: number;
}

export const DEFAULT_BLADE_TUNABLES: BladeTunables = {
  activateSpeed: 0.55,
  deactivateSpeed: 0.28,
  trailLength: 12,
  minVisibility: 0.4,
};

interface BladeState extends Blade {
  lastSeen: number;
}

/** Maps a normalised landmark into screen pixels. */
export type ProjectFn = (nx: number, ny: number) => BladePoint;

export class BladeTracker {
  private blades = new Map<string, BladeState>();
  /** Set for the frame on which this player's left/right labels exchanged. */
  private forceReacquire = false;
  private tun: BladeTunables;

  constructor(tunables: Partial<BladeTunables> = {}) {
    this.tun = { ...DEFAULT_BLADE_TUNABLES, ...tunables };
  }

  setTunables(patch: Partial<BladeTunables>): void {
    this.tun = { ...this.tun, ...patch };
  }

  getTunables(): Readonly<BladeTunables> {
    return this.tun;
  }

  /**
   * @param players confirmed tracked players
   * @param project normalised camera space -> screen pixels (handles mirroring)
   * @param dt      seconds since last update
   * @param now     performance.now()
   */
  update(
    players: readonly TrackedPlayer[],
    project: ProjectFn,
    dt: number,
    now: number
  ): Blade[] {
    const safeDt = dt > 0 ? dt : 1 / 60;

    for (const player of players) {
      const slot = Math.max(0, player.slot);
      // LABEL SWAP DETECTION, before either blade is updated.
      //
      // MediaPipe's left/right are inferred and subject-relative, so a player
      // turning side-on can have them exchange for a run of frames. Each blade
      // then teleports to the OTHER hand's position — and the segment it
      // sweeps on the way is indistinguishable from a punch.
      //
      // A per-blade distance threshold does not catch this reliably, because
      // the two hands are frequently closer together than any plausible
      // fast-swipe limit. The exchange itself is the signal: both new
      // positions sitting where the other blade was last frame.
      //
      // MEASURED before this, with label swapping enabled: a Rhythm player
      // holding both fists still scored 318 points across fifteen seconds.
      this.forceReacquire = this.labelsExchanged(player, project);

      // Subject-left and subject-right. The projection mirrors, so the blade
      // appears on the side of the screen the player sees their own hand on.
      this.updateOne(player, slot, 'left', POSE.LEFT_WRIST, project, safeDt, now);
      this.updateOne(player, slot, 'right', POSE.RIGHT_WRIST, project, safeDt, now);
      this.forceReacquire = false;
    }

    // Retire blades whose player vanished, so their trail doesn't hang mid-air.
    for (const [key, blade] of this.blades) {
      if (now - blade.lastSeen > 400) this.blades.delete(key);
      else if (now - blade.lastSeen > 0) blade.visible = blade.lastSeen === now;
    }

    return [...this.blades.values()].filter((b) => b.visible);
  }

  /**
   * The furthest a real hand can travel between two samples, in screen pixels.
   *
   * Expressed in torso units so it means the same thing for a child and an
   * adult, and for someone at 2m or 4m. Generous: a hard swipe is ~0.2 torso
   * per frame at 30fps, so 0.9 leaves a wide margin for a genuinely fast arm
   * on a slow frame while still being far below a cross-body label swap.
   */
  /**
   * Have this player's left/right labels just exchanged?
   *
   * True when each incoming wrist is markedly closer to where the OTHER blade
   * was last frame than to where its own was. Requires the hands to be
   * meaningfully apart, since with both hands together the question is
   * meaningless and the answer does not matter.
   */
  private labelsExchanged(player: TrackedPlayer, project: ProjectFn): boolean {
    const prevL = this.blades.get(`${player.id}:left`);
    const prevR = this.blades.get(`${player.id}:right`);
    if (!prevL || !prevR || !prevL.visible || !prevR.visible) return false;

    const lm = player.landmarks;
    const l = lm[POSE.LEFT_WRIST];
    const r = lm[POSE.RIGHT_WRIST];
    if (!l || !r) return false;

    const nl = project(l.x, l.y);
    const nr = project(r.x, r.y);

    const apart = Math.hypot(prevL.x - prevR.x, prevL.y - prevR.y);
    const unit = player.scale.unit;
    const screenH = Math.abs(project(0, 1).y - project(0, 0).y) || 1;
    if (!(unit > 0) || apart < unit * screenH * 0.35) return false;

    const stay = Math.hypot(nl.x - prevL.x, nl.y - prevL.y) + Math.hypot(nr.x - prevR.x, nr.y - prevR.y);
    const swap = Math.hypot(nl.x - prevR.x, nl.y - prevR.y) + Math.hypot(nr.x - prevL.x, nr.y - prevL.y);
    return swap < stay * 0.5;
  }

  private maxTravelPerFrame(player: TrackedPlayer, project: ProjectFn): number {
    const unit = player.scale.unit;
    if (!(unit > 0)) return Infinity;
    const screenH = Math.abs(project(0, 1).y - project(0, 0).y) || 1;
    return unit * screenH * 0.9;
  }

  private updateOne(
    player: TrackedPlayer,
    slot: number,
    side: 'left' | 'right',
    landmarkIndex: number,
    project: ProjectFn,
    dt: number,
    now: number
  ): void {
    const key = `${player.id}:${side}`;
    // Filtered landmarks: the blade tip is a POSITION, and One Euro's whole job
    // is making a position steady. (Contrast RepCounter, which measures
    // oscillation and must read raw.)
    const lm: Landmark | undefined = player.landmarks[landmarkIndex];

    if (!lm || lm.visibility < this.tun.minVisibility) {
      const existing = this.blades.get(key);
      if (existing) existing.visible = false;
      return;
    }

    const p = project(lm.x, lm.y);
    let blade = this.blades.get(key);

    if (!blade) {
      blade = {
        id: key,
        slot,
        side,
        x: p.x,
        y: p.y,
        px: p.x,
        py: p.y,
        speed: 0,
        angle: 0,
        active: false,
        reacquired: true,
        visible: true,
        trail: [{ x: p.x, y: p.y }],
        lastSeen: now,
      };
      this.blades.set(key, blade);
      return;
    }

    // REACQUIRE CLEANLY. If this blade was hidden last frame — the wrist fell
    // below `minVisibility` — then `blade.x/y` are wherever the hand was when
    // it vanished, possibly a long way away. Carrying that forward as `px/py`
    // makes the next frame a swept segment across the gap: a phantom slash
    // through anything in between, one frame of enormous `speed`, and `active`
    // flipping on by itself.
    //
    // This is the best candidate for "the right hand feels murky". The dominant
    // hand is swung harder, so it blurs more, so its `visibility` dips more
    // often — meaning the hand you use most is the one that misbehaves most.
    // The simulator cannot reproduce it at all: its landmarks are always
    // visibility 1.
    const wasHidden = !blade.visible;

    // A JUMP TOO BIG TO BE AN ARM IS NOT AN ARM.
    //
    // A swept segment from the previous position to this one is what turns a
    // fast hand into a slice. It is also what turns a TRACKING ARTIFACT into a
    // slice, and a hidden blade is not the only source of those: MediaPipe's
    // left/right labels are inferred and subject-relative, so a player turning
    // side-on can have them swap for a run of frames. The blade then teleports
    // across the body, and the segment it sweeps on the way passes through
    // whatever is in between.
    //
    // MEASURED with limb swapping enabled: a Rhythm player holding both fists
    // still on the targets scored 67 points without moving. The `sawHand` fix
    // did not catch it, because a hand WAS seen — just the wrong one.
    //
    // A real hand covers about 0.2 torso units between frames at 30fps even
    // when swung hard; a swap moves it across the whole body. Anything past
    // this is treated as a re-acquisition: snap, do not sweep.
    const jump = Math.hypot(p.x - blade.x, p.y - blade.y);
    const teleported = jump > this.maxTravelPerFrame(player, project);

    blade.reacquired = wasHidden || teleported || this.forceReacquire;
    blade.px = blade.reacquired ? p.x : blade.x;
    blade.py = blade.reacquired ? p.y : blade.y;
    blade.x = p.x;
    blade.y = p.y;
    blade.slot = slot;
    blade.visible = true;
    blade.lastSeen = now;
    if (blade.reacquired) {
      // A trail bridging the gap would draw the same phantom slash.
      blade.trail.length = 0;
      blade.trail.push({ x: p.x, y: p.y });
      blade.active = false;
    }

    const dx = blade.x - blade.px;
    const dy = blade.y - blade.py;
    const dist = Math.hypot(dx, dy);
    blade.speed = dist / dt;
    if (dist > 0.5) blade.angle = Math.atan2(dy, dx);

    // Speed thresholds are fractions of screen height, so the feel is identical
    // on a laptop preview and a 55" TV.
    const screenH = Math.max(1, project(0, 1).y - project(0, 0).y);
    const normSpeed = blade.speed / Math.abs(screenH);

    blade.active = blade.active
      ? normSpeed > this.tun.deactivateSpeed
      : normSpeed > this.tun.activateSpeed;

    blade.trail.push({ x: blade.x, y: blade.y });
    while (blade.trail.length > this.tun.trailLength) blade.trail.shift();
  }

  reset(): void {
    this.blades.clear();
  }

  get all(): Blade[] {
    return [...this.blades.values()].filter((b) => b.visible);
  }
}

/* ------------------------------------------------------------------ */
/* Trail rendering                                                     */
/* ------------------------------------------------------------------ */

/**
 * Tapered glowing ribbon along the blade's recent path.
 *
 * Drawn as a series of widening segments rather than one stroked polyline so
 * the trail can taper from nothing at the tail to full width at the tip, which
 * is what sells it as a swing rather than a wire.
 */
export function drawBladeTrail(
  ctx: CanvasRenderingContext2D,
  blade: Blade,
  color: string,
  maxWidth: number
): void {
  const pts = blade.trail;
  if (pts.length < 2) return;

  // FLAT INK RIBBON. No blur, no alpha ramp.
  //
  // This set `shadowColor`/`shadowBlur` and then issued a stroke PER SEGMENT —
  // canvas charges the blur on every one of them, so a 12-point trail paid for
  // 12 blurs per hand per frame, on the two games with the most going on. It
  // also used `globalAlpha` as a colour treatment on a brand colour, which
  // DESIGN.md forbids outright.
  //
  // The taper is now carried entirely by WIDTH, which the geometry already
  // provided. Active vs inactive is a flat state change — full-width ink
  // versus a thin muted line — not an opacity ramp, so the difference reads
  // at 3m instead of being a subtlety lost on a cheap panel.
  const active = blade.active;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = active ? COLORS.ink : COLORS.muted;

  for (let i = 1; i < pts.length; i++) {
    const t = i / (pts.length - 1);
    const a = pts[i - 1]!;
    const b = pts[i]!;
    ctx.lineWidth = Math.max(1, maxWidth * t * (active ? 1 : 0.35));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // The tip is a sticker, so the player can always find their own hand on a
  // busy screen. The old bright-white tip was invisible on paper.
  const r = maxWidth * (active ? 0.62 : 0.4);
  ctx.fillStyle = COLORS.ink;
  ctx.beginPath();
  ctx.arc(blade.x, blade.y, r, 0, Math.PI * 2);
  ctx.fill();

  if (active) {
    ctx.fillStyle = color;
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = Math.max(1, maxWidth * 0.18);
    ctx.beginPath();
    ctx.arc(blade.x, blade.y, r * 0.66, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}
