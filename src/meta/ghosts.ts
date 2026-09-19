/**
 * Deterministic ghost replay of the best run per game.
 *
 * PLAN.md §4: "Deterministic replay of the top run per game, played back
 * translucent alongside the live player. Cheap once the sim is fixed-timestep,
 * and it turns a solo run into a race."
 *
 * That last clause is the entire point. A solo player at a stall has nothing to
 * push against until the results screen; a translucent body moving beside them,
 * and a score that is visibly three ahead, is what makes someone step back on.
 *
 * ---------------------------------------------------------------------------
 * STORAGE BUDGET (measured, not guessed — see `ghosts.budget()`)
 *
 * A ghost is two fixed-rate tracks sampled at 10 Hz, both base64 of packed
 * bytes rather than JSON numbers:
 *
 *   score track   2 bytes/sample  (uint16, clamped 0..65535)
 *   pose track   28 bytes/sample  (2-byte visibility mask + 13 joints × 2
 *                                  bytes of 8-bit quantised x/y)
 *
 * The hard round cap is 60 s (PLAN.md §1), so the worst case is 600 samples:
 *
 *   score  600 ×  2 =  1,200 B -> 1,600 base64 chars
 *   pose   600 × 28 = 16,800 B -> 22,400 base64 chars
 *   envelope (initials, versions, timings)        ~   250 chars
 *   ------------------------------------------------------------
 *   worst case per ghost                          ~ 24.5 KB chars
 *   × 7 games                                     ~  172 KB chars
 *
 * localStorage counts UTF-16, so ~344 KB of a typical 5 MB origin quota —
 * under 7%, alongside the leaderboard's few KB. `MAX_GHOST_CHARS` enforces the
 * per-ghost figure independently of that arithmetic: a ghost that overruns it
 * is re-serialised without the pose track (score-only ghosts still race), and
 * one that still overruns is dropped rather than risking the leaderboard's
 * quota.
 *
 * 8-bit quantisation puts each joint within 1/255 of frame width — about 5 px
 * on a 1280-wide camera. For a translucent silhouette read from 3m that is
 * invisible, and it is 4× cheaper than float JSON.
 * ---------------------------------------------------------------------------
 *
 * VERSION DRIFT is handled hard: every stored ghost carries the scoring version
 * of the game that produced it. A ghost recorded before a scoring change is
 * silently DELETED on load, never shown. A ghost racing you on a scale that no
 * longer exists is worse than no ghost — it makes the game look broken to the
 * person playing and to everyone watching.
 */

import { POSE, type Landmark } from '../core/types';
import type { GameId } from './leaderboard';
import type { Projection } from '../engine/projection';
import { COLORS, withAlpha } from '../shell/theme';

/* ------------------------------------------------------------------ *
 * Versioning
 * ------------------------------------------------------------------ */

/** Encoding format. Bump when the byte layout below changes. */
const FORMAT_VERSION = 1;

/**
 * Per-game scoring version. **Bump the entry for a game whenever its scoring
 * changes in any way that makes old numbers non-comparable** — a new multiplier,
 * a changed rep threshold, a different combo rule. Ghosts and their scores are
 * discarded on mismatch.
 */
export const SCORING_VERSION: Record<GameId, number> = {
  sixtyseven: 1,
  fruitninja: 1,
  /**
   * 2: the non-finisher band was FLOORED and capped at 99 so a racer stopped a
   * hand's width from the line (99.9, rounding to 100) could no longer tie a
   * racer who actually crossed with no clock left. See `laneScore`.
   */
  redlight: 2,
  runner: 1,
  posematch: 1,
  rhythm: 1,
  balloonpop: 1,
};

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** Samples per second. 10 Hz + interpolation reads smooth and keeps the budget. */
export const SAMPLE_HZ = 10;
/**
 * Longest round this can record, in seconds.
 *
 * 64 was "60s cap plus headroom for the results overlap", which was right
 * until `game.roundScale` became an operator lever with a range up to 1.5. A
 * scaled 60s game runs 90 seconds, so the buffer filled at 64 and the ghost —
 * the thing the player is racing — visibly froze for the last twenty-six.
 *
 * 96 covers the longest round the console can produce (60 x 1.5) with the same
 * headroom as before. At 10Hz that is 960 score samples, and the pose track is
 * still bounded independently by MAX_GHOST_CHARS, which is what actually
 * protects the storage budget.
 */
export const MAX_SECONDS = 96;
export const MAX_SAMPLES = SAMPLE_HZ * MAX_SECONDS;
/** Per-ghost ceiling, enforced on save. See the budget note above. */
export const MAX_GHOST_CHARS = 40 * 1024;

/**
 * The joints the silhouette is drawn from. Deliberately not all 33: the face
 * and hand detail cost bytes and are invisible as a translucent body at 3m.
 */
export const GHOST_JOINTS: readonly number[] = [
  POSE.NOSE,
  POSE.LEFT_SHOULDER,
  POSE.RIGHT_SHOULDER,
  POSE.LEFT_ELBOW,
  POSE.RIGHT_ELBOW,
  POSE.LEFT_WRIST,
  POSE.RIGHT_WRIST,
  POSE.LEFT_HIP,
  POSE.RIGHT_HIP,
  POSE.LEFT_KNEE,
  POSE.RIGHT_KNEE,
  POSE.LEFT_ANKLE,
  POSE.RIGHT_ANKLE,
];

export const GHOST_JOINT_COUNT = GHOST_JOINTS.length;

/** Edges between GHOST_JOINTS indices (not MediaPipe indices). */
export const GHOST_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 2], // shoulders
  [1, 3], [3, 5], // left arm
  [2, 4], [4, 6], // right arm
  [1, 7], [2, 8], [7, 8], // torso
  [7, 9], [9, 11], // left leg
  [8, 10], [10, 12], // right leg
];

/** Bytes per pose sample: 2-byte visibility mask + 2 bytes per joint. */
const POSE_STRIDE = 2 + GHOST_JOINT_COUNT * 2;

/* ------------------------------------------------------------------ *
 * Stored shape
 * ------------------------------------------------------------------ */

interface StoredGhost {
  f: number; // FORMAT_VERSION
  s: number; // SCORING_VERSION[game] at record time
  game: GameId;
  hz: number;
  n: number; // sample count
  score: number; // final score
  initials: string | null;
  at: number; // epoch ms
  /** base64 uint16be score track. */
  st: string;
  /** base64 pose track, or null when it was dropped to fit the budget. */
  pt: string | null;
}

export interface GhostPose {
  /** Normalised camera-space points, one per GHOST_JOINTS entry. */
  points: Array<{ x: number; y: number }>;
  /** Parallel array: false when that joint was not visible when recorded. */
  visible: boolean[];
}

export interface GhostMeta {
  game: GameId;
  finalScore: number;
  initials: string | null;
  recordedAt: number;
  /** Seconds of recorded run. */
  duration: number;
  sampleCount: number;
  hasPose: boolean;
  /** Length of the stored string, so the operator console can show the budget. */
  bytes: number;
}

/* ------------------------------------------------------------------ *
 * Storage primitives — every access guarded (see meta/leaderboard.ts)
 * ------------------------------------------------------------------ */

const KEY_PREFIX = 'gdg-arcade:ghost:v1:';

function keyFor(game: GameId): string {
  return `${KEY_PREFIX}${game}`;
}

function lsGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(key, value);
    return true;
  } catch {
    // Quota or private mode. The kiosk keeps running; we simply have no ghost.
    return false;
  }
}

function lsRemove(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * Byte packing
 * ------------------------------------------------------------------ */

function toBase64(bytes: Uint8Array): string {
  // Chunked: a single String.fromCharCode.apply on a 17 KB array is fine, but
  // the chunking makes this safe if MAX_SECONDS ever grows.
  let s = '';
  const CHUNK = 0x2000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return typeof btoa === 'function' ? btoa(s) : '';
}

function fromBase64(b64: string): Uint8Array {
  if (typeof atob !== 'function') return new Uint8Array(0);
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function q8(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/* ------------------------------------------------------------------ *
 * Recorder
 * ------------------------------------------------------------------ */

export interface GhostRecorder {
  readonly game: GameId;
  readonly sampleCount: number;
  /**
   * Feed a sample. `t` is seconds since the round started; samples are
   * resampled onto the fixed 10 Hz grid, so calling this every frame (or
   * irregularly) is fine and produces an identical recording either way.
   */
  sample(t: number, score: number, landmarks?: readonly Landmark[] | null): void;
  /** Commits if this beats the stored ghost. Returns true when it was saved. */
  finish(finalScore?: number, initials?: string | null): boolean;
  /** Throw the recording away — a round abandoned mid-way is not a ghost. */
  cancel(): void;
}

class Recorder implements GhostRecorder {
  private scores: number[] = [];
  private poses: Uint8Array;
  private poseWritten = 0;
  private lastPose: Uint8Array | null = null;
  private live = true;
  private lastScore = 0;

  readonly game: GameId;
  private readonly store: GhostStore;
  private readonly wantPose: boolean;

  // Fields written out rather than parameter properties: `node --test` strips
  // TS types rather than compiling them, and parameter properties are the one
  // common TS-ism it cannot handle.
  constructor(game: GameId, store: GhostStore, wantPose: boolean) {
    this.game = game;
    this.store = store;
    this.wantPose = wantPose;
    this.poses = new Uint8Array(wantPose ? MAX_SAMPLES * POSE_STRIDE : 0);
  }

  get sampleCount(): number {
    return this.scores.length;
  }

  sample(t: number, score: number, landmarks?: readonly Landmark[] | null): void {
    if (!this.live) return;
    if (!Number.isFinite(t) || t < 0) return;

    const target = Math.min(MAX_SAMPLES, Math.floor(t * SAMPLE_HZ) + 1);
    if (target <= this.scores.length) return;

    const s = Number.isFinite(score) ? Math.max(0, Math.min(65535, Math.round(score))) : this.lastScore;

    // Fill forward: an irregular frame rate must not shorten the timeline or
    // the ghost drifts out of sync with the live player, which is the one thing
    // a racing ghost cannot do.
    while (this.scores.length < target) {
      const i = this.scores.length;
      this.scores.push(s);
      if (this.wantPose) this.writePose(i, landmarks ?? null);
    }
    this.lastScore = s;
  }

  private writePose(index: number, landmarks: readonly Landmark[] | null): void {
    const off = index * POSE_STRIDE;
    if (off + POSE_STRIDE > this.poses.length) return;

    if (!landmarks || landmarks.length === 0) {
      // Hold the previous frame rather than emitting a zeroed body, which
      // renders as a heap of limbs in the top-left corner.
      if (this.lastPose) this.poses.set(this.lastPose, off);
      this.poseWritten = index + 1;
      return;
    }

    let mask = 0;
    for (let j = 0; j < GHOST_JOINT_COUNT; j++) {
      const lm = landmarks[GHOST_JOINTS[j]!];
      const visible = !!lm && lm.visibility >= 0.2;
      if (visible) mask |= 1 << j;
      this.poses[off + 2 + j * 2] = q8(lm?.x ?? 0);
      this.poses[off + 2 + j * 2 + 1] = q8(lm?.y ?? 0);
    }
    this.poses[off] = mask & 0xff;
    this.poses[off + 1] = (mask >> 8) & 0xff;
    this.lastPose = this.poses.subarray(off, off + POSE_STRIDE);
    this.poseWritten = index + 1;
  }

  finish(finalScore?: number, initials?: string | null): boolean {
    if (!this.live) return false;
    this.live = false;
    const n = this.scores.length;
    if (n < SAMPLE_HZ) return false; // under a second of run is not a race

    const score = Math.max(
      0,
      Math.round(finalScore ?? this.scores[n - 1] ?? 0)
    );
    if (score <= 0) return false;

    const scoreBytes = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      const s = this.scores[i] ?? 0;
      scoreBytes[i * 2] = (s >> 8) & 0xff;
      scoreBytes[i * 2 + 1] = s & 0xff;
    }

    const poseUsed = Math.min(this.poseWritten, n);
    const poseBytes =
      this.wantPose && poseUsed > 0 ? this.poses.subarray(0, poseUsed * POSE_STRIDE) : null;

    return this.store.commit({
      f: FORMAT_VERSION,
      s: SCORING_VERSION[this.game],
      game: this.game,
      hz: SAMPLE_HZ,
      n,
      score,
      initials: initials ?? null,
      at: Date.now(),
      st: toBase64(scoreBytes),
      pt: poseBytes ? toBase64(poseBytes) : null,
    });
  }

  cancel(): void {
    this.live = false;
  }
}

/* ------------------------------------------------------------------ *
 * Playback
 * ------------------------------------------------------------------ */

export class GhostPlayback {
  readonly game: GameId;
  readonly finalScore: number;
  readonly initials: string | null;
  readonly recordedAt: number;
  readonly duration: number;
  readonly sampleCount: number;
  readonly hasPose: boolean;
  /** Stored size in chars, for the budget readout. */
  readonly bytes: number;

  private readonly hz: number;
  private readonly scores: Uint16Array;
  private readonly poses: Uint8Array | null;
  private readonly poseFrames: number;

  constructor(g: StoredGhost, bytes: number) {
    this.game = g.game;
    this.finalScore = g.score;
    this.initials = g.initials;
    this.recordedAt = g.at;
    this.hz = g.hz || SAMPLE_HZ;
    this.sampleCount = g.n;
    this.duration = g.n / this.hz;
    this.bytes = bytes;

    const sb = fromBase64(g.st);
    const n = Math.min(g.n, Math.floor(sb.length / 2));
    this.scores = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      this.scores[i] = ((sb[i * 2] ?? 0) << 8) | (sb[i * 2 + 1] ?? 0);
    }

    this.poses = g.pt ? fromBase64(g.pt) : null;
    this.poseFrames = this.poses ? Math.floor(this.poses.length / POSE_STRIDE) : 0;
    this.hasPose = this.poseFrames > 0;
  }

  /**
   * The ghost's score at `t` seconds into the round.
   *
   * Linearly interpolated then rounded, so a chase bar moves smoothly but the
   * number on screen is always an integer — a score reading "37.4" in a game
   * whose scores are whole reps looks like a bug from the queue.
   *
   * Clamps at both ends: before the start it is 0, after the ghost finished it
   * holds its final score, so a live player who is still going keeps a target.
   */
  scoreAt(t: number): number {
    const n = this.scores.length;
    if (n === 0) return 0;
    if (!Number.isFinite(t) || t <= 0) return this.scores[0] ?? 0;

    const f = t * this.hz;
    if (f >= n - 1) return this.scores[n - 1] ?? 0;

    const i = Math.floor(f);
    const a = this.scores[i] ?? 0;
    const b = this.scores[i + 1] ?? a;
    return Math.round(a + (b - a) * (f - i));
  }

  /** True while the recorded run was still going at `t`. */
  isRunning(t: number): boolean {
    return t >= 0 && t < this.duration;
  }

  /**
   * The silhouette at `t`, interpolated between the 10 Hz samples so the body
   * moves smoothly rather than stepping. Returns null when this ghost has no
   * pose track (score-only, because it had to be shrunk to fit the budget).
   */
  poseAt(t: number): GhostPose | null {
    const poses = this.poses;
    if (!poses || this.poseFrames === 0) return null;

    const f = Math.max(0, Math.min(this.poseFrames - 1, t * this.hz));
    const i = Math.floor(f);
    const j = Math.min(this.poseFrames - 1, i + 1);
    const u = f - i;

    const oa = i * POSE_STRIDE;
    const ob = j * POSE_STRIDE;
    const maskA = (poses[oa] ?? 0) | ((poses[oa + 1] ?? 0) << 8);
    const maskB = (poses[ob] ?? 0) | ((poses[ob + 1] ?? 0) << 8);

    const points: Array<{ x: number; y: number }> = [];
    const visible: boolean[] = [];
    for (let k = 0; k < GHOST_JOINT_COUNT; k++) {
      const ax = (poses[oa + 2 + k * 2] ?? 0) / 255;
      const ay = (poses[oa + 2 + k * 2 + 1] ?? 0) / 255;
      const bx = (poses[ob + 2 + k * 2] ?? 0) / 255;
      const by = (poses[ob + 2 + k * 2 + 1] ?? 0) / 255;
      points.push({ x: ax + (bx - ax) * u, y: ay + (by - ay) * u });
      visible.push(((maskA >> k) & 1) === 1 && ((maskB >> k) & 1) === 1);
    }
    return { points, visible };
  }

  meta(): GhostMeta {
    return {
      game: this.game,
      finalScore: this.finalScore,
      initials: this.initials,
      recordedAt: this.recordedAt,
      duration: this.duration,
      sampleCount: this.sampleCount,
      hasPose: this.hasPose,
      bytes: this.bytes,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

class GhostStore {
  private active: Recorder | null = null;
  private cache = new Map<GameId, GhostPlayback | null>();

  /**
   * Starts recording a run.
   *
   * `pose: false` records score only — a fraction of the bytes, and still a
   * race. Use it for a game whose ghost body would be meaningless (a 3D runner
   * viewed from behind, say).
   */
  record(game: GameId, opts: { pose?: boolean } = {}): GhostRecorder {
    this.active?.cancel();
    const rec = new Recorder(game, this, opts.pose !== false);
    this.active = rec;
    return rec;
  }

  /** Forwards to the run currently being recorded. */
  sample(t: number, score: number, landmarks?: readonly Landmark[] | null): void {
    this.active?.sample(t, score, landmarks);
  }

  /** Forwards to the run currently being recorded. Returns true if it saved. */
  finish(finalScore?: number, initials?: string | null): boolean {
    const saved = this.active?.finish(finalScore, initials) ?? false;
    this.active = null;
    return saved;
  }

  cancel(): void {
    this.active?.cancel();
    this.active = null;
  }

  get recording(): boolean {
    return this.active !== null;
  }

  /**
   * Best stored ghost for a game, or null.
   *
   * Version drift is enforced here and nowhere else: a ghost whose format or
   * scoring version does not match the current build is DELETED and null is
   * returned. Showing it would misrepresent the target the player is chasing.
   */
  load(game: GameId): GhostPlayback | null {
    const cached = this.cache.get(game);
    if (cached !== undefined) return cached;

    const raw = lsGet(keyFor(game));
    if (!raw) {
      this.cache.set(game, null);
      return null;
    }

    let parsed: StoredGhost | null = null;
    try {
      parsed = JSON.parse(raw) as StoredGhost;
    } catch {
      parsed = null;
    }

    if (
      !parsed ||
      parsed.f !== FORMAT_VERSION ||
      parsed.s !== SCORING_VERSION[game] ||
      parsed.game !== game ||
      !parsed.st ||
      !(parsed.n > 0)
    ) {
      lsRemove(keyFor(game));
      this.cache.set(game, null);
      return null;
    }

    let playback: GhostPlayback | null = null;
    try {
      playback = new GhostPlayback(parsed, raw.length);
    } catch {
      lsRemove(keyFor(game));
      playback = null;
    }
    this.cache.set(game, playback);
    return playback;
  }

  /** Internal: writes a ghost if it beats the stored one and fits the budget. */
  commit(g: StoredGhost): boolean {
    const existing = this.load(g.game);
    if (existing && existing.finalScore >= g.score) return false;

    let payload = JSON.stringify(g);
    if (payload.length > MAX_GHOST_CHARS && g.pt) {
      // Score-only still races. Better a smaller ghost than none.
      payload = JSON.stringify({ ...g, pt: null });
    }
    if (payload.length > MAX_GHOST_CHARS) return false;

    if (!lsSet(keyFor(g.game), payload)) {
      // Quota. Retry once without the pose track before giving up — the
      // leaderboard shares this quota and must never be squeezed out by us.
      if (!g.pt) return false;
      const lean = JSON.stringify({ ...g, pt: null });
      if (!lsSet(keyFor(g.game), lean)) return false;
      payload = lean;
    }

    this.cache.delete(g.game);
    return true;
  }

  has(game: GameId): boolean {
    return this.load(game) !== null;
  }

  clear(game: GameId): void {
    lsRemove(keyFor(game));
    this.cache.delete(game);
  }

  clearAll(): void {
    for (const game of Object.keys(SCORING_VERSION) as GameId[]) this.clear(game);
    this.cache.clear();
  }

  /**
   * Actual measured footprint, for the operator console and for verifying the
   * budget note at the top of this file against real recordings.
   */
  budget(): { totalChars: number; perGhost: Array<{ game: GameId; chars: number }>; limitChars: number } {
    const perGhost: Array<{ game: GameId; chars: number }> = [];
    let totalChars = 0;
    for (const game of Object.keys(SCORING_VERSION) as GameId[]) {
      const raw = lsGet(keyFor(game));
      if (!raw) continue;
      perGhost.push({ game, chars: raw.length });
      totalChars += raw.length;
    }
    return {
      totalChars,
      perGhost,
      limitChars: MAX_GHOST_CHARS * Object.keys(SCORING_VERSION).length,
    };
  }
}

export const ghosts = new GhostStore();

/* ------------------------------------------------------------------ *
 * Draw helper
 * ------------------------------------------------------------------ */

export interface GhostDrawOptions {
  /**
   * Defaults to `COLORS.textFaint` — "the faintest thing still legible on the
   * current background", which is the correct token whichever way the art
   * direction goes. Callers normally pass the player's own slot colour.
   */
  color?: string;
  /** Peak opacity of the core stroke. Kept low — this must never outshine the player. */
  alpha?: number;
  /** Core line width in logical px. */
  width?: number;
}

/**
 * Draws a ghost silhouette.
 *
 * NO shadowBlur — the same rule as `drawPose` in engine/skeleton.ts. Canvas
 * charges the blur per stroke, so a blurred ghost would be ~12 blurs per frame
 * on top of everything the live game already draws. Three unblurred passes
 * (wide faint halo, mid, translucent core) read as a glowing ghost from 3m and
 * cost three plain strokes.
 *
 * Deliberately drawn BEFORE the live player so it never occludes them. A ghost
 * that makes your own body harder to see is a downgrade, not a feature.
 */
export function drawGhost(
  ctx: CanvasRenderingContext2D,
  proj: Projection,
  pose: GhostPose,
  opts: GhostDrawOptions = {}
): void {
  const color = opts.color ?? COLORS.textFaint;
  const alpha = opts.alpha ?? 0.35;
  const width = opts.width ?? 10;

  const px = pose.points.map((p) => ({ x: proj.x(p.x), y: proj.y(p.y) }));

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const passes: Array<[number, number]> = [
    [width * 2.6, alpha * 0.22],
    [width * 1.5, alpha * 0.45],
    [width, alpha],
  ];

  for (const [lw, a] of passes) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = withAlpha(color, a);
    ctx.beginPath();
    for (const [i, j] of GHOST_CONNECTIONS) {
      if (!pose.visible[i] || !pose.visible[j]) continue;
      const a1 = px[i];
      const b1 = px[j];
      if (!a1 || !b1) continue;
      ctx.moveTo(a1.x, a1.y);
      ctx.lineTo(b1.x, b1.y);
    }
    ctx.stroke();
  }

  // Head as a single circle, sized off the shoulder span so it scales with the
  // recorded body rather than the screen.
  const head = px[0];
  const ls = px[1];
  const rs = px[2];
  if (head && ls && rs && pose.visible[0]) {
    const span = Math.hypot(ls.x - rs.x, ls.y - rs.y);
    const r = Math.max(width, span * 0.34);
    ctx.fillStyle = withAlpha(color, alpha * 0.5);
    ctx.beginPath();
    ctx.arc(head.x, head.y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}
