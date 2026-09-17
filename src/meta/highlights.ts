/**
 * Rolling highlight buffer and instant replay.
 *
 * PLAN.md §4: "Rolling ~8s frame buffer. On a top-5 score or a big combo,
 * export a clip. No email, no QR — it just **plays back instantly on screen**
 * with the score stamped on it while the next player steps up."
 *
 * ---------------------------------------------------------------------------
 * WHY drawImage AND NOT MediaRecorder
 *
 * Both were considered. `captureStream()` + `MediaRecorder` is the obvious
 * route and it is wrong here, for four reasons that have nothing to do with
 * micro-optimisation:
 *
 *  1. There is no rolling window. MediaRecorder produces a forward-only stream.
 *     Getting the LAST 8 seconds means either `timeslice` chunks that cannot be
 *     concatenated into a playable WebM without rewriting the container (the
 *     first chunk carries the header; later chunks are not independently
 *     decodable), or restarting the recorder on a timer and living with a seam.
 *  2. It runs a VP8/VP9 encoder continuously for eight hours on the laptop that
 *     is also running MediaPipe inference and the game. The encode is off the
 *     main thread, but the capture and the CPU contention are not free, and the
 *     frame-budget watchdog has no way to shed it.
 *  3. Playback needs a `<video>` element composited over the canvas. The whole
 *     architecture is one canvas, one render loop (ARCHITECTURE.md rule 4), and
 *     a DOM video layer with its own timing is a new class of bug on a screen
 *     nobody can debug at a stall.
 *  4. Blob memory grows until explicitly dropped, and "explicitly dropped"
 *     across an eight-hour session with an unknown number of aborted rounds is
 *     exactly the kind of thing that leaks.
 *
 * Periodic downscaled `drawImage` into a fixed atlas has none of those
 * properties. It is a texture blit, the memory is allocated once and never
 * grows, the capture rate is a single number the watchdog can turn down, and
 * playback is `drawImage` back the other way inside the existing render loop.
 *
 * ---------------------------------------------------------------------------
 * MEMORY CEILING — explicit and enforced
 *
 * Frames are tiled into ONE canvas ("atlas") rather than kept as N separate
 * canvases or ImageData buffers: one allocation, no per-frame GC churn, and a
 * ring buffer that reuses the same pixels forever.
 *
 * Default: 256×144 cells, 8 fps, 8 s => 64 frames in an 8×8 grid = 2048×1152.
 *
 *     2048 × 1152 × 4 bytes           =  9.44 MB per atlas
 *     × 2 atlases (rolling + saved)   = 18.87 MB total, fixed
 *
 * Exactly two atlases exist for the life of the process. Capturing a highlight
 * SWAPS them — the saved clip becomes read-only and the old saved atlas becomes
 * the new rolling buffer — so a capture allocates nothing and there is no third
 * copy. `MAX_BYTES` clamps `configure()`, so an operator changing the buffer on
 * a weaker laptop can never accidentally grow it past the ceiling.
 *
 * ---------------------------------------------------------------------------
 * WHY 256×144 AND NOT 320×180 — a measured cliff, not a preference
 *
 * 320×180 was tried first because a sharper replay is a better replay. Measured
 * on this machine, blitting a 1600×900 canvas into each:
 *
 *   cell     atlas        total     mean      p50    p90    p99      max
 *   256×144  2048×1152   18.9 MB   0.73 ms   0.7    0.9    1.4 ms   3.7 ms
 *   320×180  2560×1440   28.1 MB  11.06 ms   0.7    1.7  448.1 ms  1408 ms
 *
 * Same p50. The larger pair falls off a cliff in the tail: past roughly 20 MB of
 * canvas backing store the browser stops keeping these GPU-resident, and every
 * blit becomes a readback. A 448 ms frame at a stall is the screen freezing.
 *
 * This is why the capture cost is also measured AT RUNTIME (`GRAB_BUDGET_MS`
 * below) and sheds itself: the cliff is a property of the GPU and the driver,
 * and the laptop at the stall is not this one.
 * ---------------------------------------------------------------------------
 */

import { vh, drawTabularNumber, drawText, measureText, stickerPill } from '../engine/draw';
import { COLORS, FONTS, SHADOW, STROKE, TRACK, WEIGHT } from '../shell/theme';
import { leaderboard, type GameId } from './leaderboard';
import type { FrameContext } from '../shell/screen';

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

export interface HighlightConfig {
  /** Length of the rolling window. PLAN.md says ~8s. */
  seconds: number;
  /** Capture rate. 8 fps is a legible replay and a 7.5-frame amortisation gap. */
  fps: number;
  /** Cell width in px. */
  width: number;
  /** Cell height in px. */
  height: number;
}

export const DEFAULT_CONFIG: HighlightConfig = {
  seconds: 8,
  fps: 8,
  width: 256,
  height: 144,
};

/**
 * Hard ceiling across BOTH atlases. Set just above the measured-good 18.9 MB
 * and well below the 28 MB configuration that fell off the cliff.
 */
export const MAX_BYTES = 24 * 1024 * 1024;

/**
 * If the mean grab cost over a window exceeds this, the buffer sheds itself:
 * first by halving the cell, then by switching off. See the cliff table above —
 * on the wrong GPU a blit becomes a readback and costs hundreds of ms, and
 * `particles.quality` will not catch it because the watchdog reacts to frames
 * already missed rather than preventing them.
 */
const GRAB_BUDGET_MS = 4;
/** Grabs per measurement window. ~2 s at 8 fps. */
const GUARD_WINDOW = 16;
/** Grabs ignored after a (re)allocation, while textures warm up. */
const GUARD_GRACE = 8;

/** A score in the top N of its board is worth replaying. PLAN.md §4: top-5. */
export const REPLAY_RANK = 5;

/**
 * Below this `particles.quality` the buffer halves its capture rate; below
 * `QUALITY_OFF` it stops entirely. The watchdog only drops quality when frames
 * are already being missed, and a replay is a nice-to-have while a smooth game
 * is not.
 */
const QUALITY_HALF = 0.75;
const QUALITY_OFF = 0.5;

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface ClipMeta {
  gameId: GameId | null;
  score: number;
  /** Shown above the score, e.g. 'NEW RECORD' or '12× COMBO'. */
  label: string;
  initials: string | null;
  /** 1-based leaderboard place, when known. */
  rank: number | null;
  color: string;
  at: number;
}

export interface HighlightStats {
  /** Frames grabbed since boot. */
  grabs: number;
  /** Mean cost of one grab, ms. */
  avgGrabMs: number;
  maxGrabMs: number;
  /** Mean cost per RENDERED frame — the number that must stay under 2 ms. */
  amortisedMsPerFrame: number;
  /** Render frames observed, for the amortisation denominator. */
  framesSeen: number;
  /** Fixed allocation, bytes. */
  bytes: number;
  /** Cells per atlas. */
  frames: number;
  /** Frames currently held in the rolling buffer. */
  buffered: number;
  atlas: { width: number; height: number; cols: number; rows: number };
  enabled: boolean;
  /** Frames where capture was skipped because `particles.quality` was low. */
  skipped: number;
  /** 0 = full, 1 = cell halved by the cost guard, 2+ = capture switched off. */
  shedLevel: number;
  /** The mean grab cost that triggered the last shed, ms. 0 if never shed. */
  shedMeanMs: number;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface Atlas {
  canvas: AnyCanvas;
  ctx: AnyCtx;
  cols: number;
  rows: number;
}

interface Clip {
  atlas: Atlas;
  /** Ring index of the oldest frame. */
  start: number;
  count: number;
  fps: number;
  /** Ring size and cell size AT CAPTURE TIME. A clip must not be read through a
   *  config that has changed under it — the cost guard can re-`configure()`. */
  frames: number;
  cw: number;
  ch: number;
  srcAspect: number;
  meta: ClipMeta;
}

/* ------------------------------------------------------------------ *
 * Allocation
 * ------------------------------------------------------------------ */

function makeCanvas(w: number, h: number): AnyCanvas | null {
  try {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  } catch {
    return null;
  }
}

function makeAtlas(cols: number, rows: number, cw: number, ch: number): Atlas | null {
  const canvas = makeCanvas(cols * cw, rows * ch);
  if (!canvas) return null;
  // `alpha: false` halves nothing on memory but avoids a per-blit blend, and
  // the source canvas is opaque anyway.
  const ctx = canvas.getContext('2d', { alpha: false }) as AnyCtx | null;
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx, cols, rows };
}

/* ------------------------------------------------------------------ *
 * The buffer
 * ------------------------------------------------------------------ */

class Highlights {
  private config: HighlightConfig = { ...DEFAULT_CONFIG };
  private frames = 0;
  private cols = 1;
  private rows = 1;

  private rolling: Atlas | null = null;
  private spare: Atlas | null = null;
  private allocFailed = false;

  private source: HTMLCanvasElement | null = null;
  private write = 0;
  private buffered = 0;
  private lastGrab = -Infinity;
  private srcAspect = 16 / 9;

  private clip: Clip | null = null;

  private _quality = 1;
  private _enabled = true;

  constructor() {
    // Grid up front so `stats()` reports the real ceiling before the first
    // frame — the operator console reads it at boot, not after a round.
    this.regrid();
  }

  /* -- measurement -- */
  private grabs = 0;
  private grabTotal = 0;
  private grabMax = 0;
  private framesSeen = 0;
  private skipped = 0;

  /* -- runtime cost guard -- */
  private window: number[] = [];
  private grace = GUARD_GRACE;
  private shedLevel = 0;
  private shedMeanMs = 0;

  /* -- playback -- */
  private playStart = 0;
  private playing = false;
  private loops = 0;
  private maxLoops = 2;

  /**
   * Point the buffer at the main canvas. Called once from `main.ts`; everything
   * else is a no-op until it is.
   */
  attach(canvas: HTMLCanvasElement | null): void {
    this.source = canvas;
    // Allocate both atlases now, at boot, rather than lazily on the first grab.
    // 18 MB of canvas appearing mid-round is exactly the frame hitch the
    // watchdog would then punish us for. Measured at ~17 ms on this laptop.
    if (canvas) this.ensure();
  }

  /** Clamped to `MAX_BYTES`. Returns the config actually applied. */
  configure(patch: Partial<HighlightConfig>): HighlightConfig {
    const next: HighlightConfig = {
      seconds: Math.max(1, Math.min(20, patch.seconds ?? this.config.seconds)),
      fps: Math.max(2, Math.min(30, patch.fps ?? this.config.fps)),
      width: Math.max(64, Math.min(640, Math.round(patch.width ?? this.config.width))),
      height: Math.max(36, Math.min(360, Math.round(patch.height ?? this.config.height))),
    };

    // Shrink the cell until two atlases fit the ceiling. Dropping resolution
    // beats dropping seconds — a 4-second replay stops being a replay.
    let frames = Math.max(1, Math.round(next.seconds * next.fps));
    let cols = Math.ceil(Math.sqrt(frames));
    let rows = Math.ceil(frames / cols);
    let guard = 0;
    while (2 * cols * next.width * rows * next.height * 4 > MAX_BYTES && guard++ < 16) {
      next.width = Math.max(64, Math.round(next.width * 0.85));
      next.height = Math.max(36, Math.round(next.height * 0.85));
      if (next.width === 64 && next.height === 36) {
        next.fps = Math.max(2, next.fps - 1);
        frames = Math.max(1, Math.round(next.seconds * next.fps));
        cols = Math.ceil(Math.sqrt(frames));
        rows = Math.ceil(frames / cols);
      }
    }

    this.config = next;
    this.regrid();
    this.release();
    return { ...next };
  }

  private regrid(): void {
    this.frames = Math.max(1, Math.round(this.config.seconds * this.config.fps));
    this.cols = Math.ceil(Math.sqrt(this.frames));
    this.rows = Math.ceil(this.frames / this.cols);
  }

  /** Frees both atlases. They are lazily rebuilt on the next tick. */
  release(): void {
    this.rolling = null;
    this.spare = null;
    this.clip = null;
    this.allocFailed = false;
    this.write = 0;
    this.buffered = 0;
    this.lastGrab = -Infinity;
    this.playing = false;
    this.window.length = 0;
    this.grace = GUARD_GRACE;
  }

  private ensure(): boolean {
    if (this.rolling && this.spare) return true;
    if (this.allocFailed) return false;
    if (this.frames === 0) this.regrid();
    const a = makeAtlas(this.cols, this.rows, this.config.width, this.config.height);
    const b = makeAtlas(this.cols, this.rows, this.config.width, this.config.height);
    if (!a || !b) {
      // No canvas, no replay. Never a thrown frame.
      this.allocFailed = true;
      return false;
    }
    this.rolling = a;
    this.spare = b;
    return true;
  }

  get enabled(): boolean {
    return this._enabled && !this.allocFailed;
  }

  /** Operator console. Re-enabling also clears a shed the cost guard applied. */
  setEnabled(on: boolean): void {
    this._enabled = on;
    if (!on) {
      this.playing = false;
      return;
    }
    this.shedLevel = 0;
    this.shedMeanMs = 0;
    this.window.length = 0;
    this.grace = GUARD_GRACE;
  }

  /**
   * `particles.quality` from the frame-budget watchdog. Below 0.75 the capture
   * rate halves; below 0.5 capture stops. The watchdog is already shedding
   * work because frames are being missed — a replay must not be the reason.
   */
  setQuality(q: number): void {
    this._quality = Number.isFinite(q) ? Math.max(0, Math.min(1, q)) : 1;
  }

  /**
   * Call once per rendered frame, AFTER the frame has been drawn. Cheap when it
   * decides not to grab: one subtraction and a compare.
   */
  tick(now: number, quality?: number): void {
    this.framesSeen++;
    if (quality !== undefined) this.setQuality(quality);
    if (!this._enabled || !this.source) return;
    if (this._quality < QUALITY_OFF) {
      this.skipped++;
      return;
    }

    // `main.ts`'s `__arcade.tick()` harness runs a synthetic clock forward and
    // then hands back to real time, so `now` genuinely does go backwards in
    // this app. Without this the buffer stops capturing for however long the
    // synthetic run was — silently, and only in the mode used to verify it.
    if (now < this.lastGrab) this.lastGrab = -Infinity;

    const fps = this._quality < QUALITY_HALF ? this.config.fps / 2 : this.config.fps;
    const interval = 1000 / fps;
    if (now - this.lastGrab < interval) return;
    // Snap forward rather than accumulate: after a stall we want the next frame
    // now, not a burst of catch-up grabs on the frame that was already slow.
    this.lastGrab = now;

    this.grab();
  }

  private grab(): void {
    if (!this.ensure()) return;
    const src = this.source;
    const atlas = this.rolling;
    if (!src || !atlas) return;
    if (src.width === 0 || src.height === 0) return;

    const t0 = performance.now();
    const { width: cw, height: ch } = this.config;
    const col = this.write % atlas.cols;
    const row = Math.floor(this.write / atlas.cols);

    try {
      atlas.ctx.drawImage(src, 0, 0, src.width, src.height, col * cw, row * ch, cw, ch);
    } catch {
      // A tainted or zero-sized source must not kill the loop.
      this.allocFailed = true;
      return;
    }

    this.srcAspect = src.width / src.height;
    this.write = (this.write + 1) % this.frames;
    this.buffered = Math.min(this.frames, this.buffered + 1);

    const cost = performance.now() - t0;
    this.grabs++;
    this.grabTotal += cost;
    if (cost > this.grabMax) this.grabMax = cost;
    this.guard(cost);
  }

  /**
   * Runtime cost guard. Sheds resolution, then gives up entirely.
   *
   * Deliberately its own mechanism rather than leaning on `particles.quality`:
   * the frame-budget watchdog responds to frames that have ALREADY been missed,
   * and the failure mode here is a single 400 ms blit, not a gentle slide.
   */
  private guard(cost: number): void {
    if (this.grace > 0) {
      this.grace--;
      return;
    }
    this.window.push(cost);
    if (this.window.length < GUARD_WINDOW) return;

    const mean = this.window.reduce((a, b) => a + b, 0) / this.window.length;
    this.window.length = 0;
    if (mean <= GRAB_BUDGET_MS) return;

    this.shedLevel++;
    this.shedMeanMs = mean;
    if (this.shedLevel === 1) {
      // Half the cell is a quarter of the pixels. Costs the buffered footage,
      // which is a fair price for not freezing the screen.
      this.configure({
        width: Math.max(64, Math.round(this.config.width / 2)),
        height: Math.max(36, Math.round(this.config.height / 2)),
      });
    } else {
      this._enabled = false;
      this.playing = false;
    }
  }

  /* ---------------- capture ---------------- */

  /**
   * True when this score is worth a replay: a top-5 place on its board.
   * A screen can also call `capture()` directly for a combo or a knockout.
   */
  isWorthReplaying(game: GameId, score: number): boolean {
    if (!(score > 0)) return false;
    const r = leaderboard.previewRank(game, score);
    return r.rank !== null && r.rank <= REPLAY_RANK;
  }

  /**
   * Freezes the rolling window into the saved clip.
   *
   * Swaps the two atlases rather than copying: zero allocation, and the rolling
   * buffer immediately resumes into what used to be the saved atlas. Returns
   * false when there is not enough buffered footage to be worth showing.
   */
  capture(meta: Partial<ClipMeta> = {}): boolean {
    if (!this.enabled) return false;
    if (!this.rolling || !this.spare) return false;
    // Under ~1.5s of footage is a flicker, not a replay.
    if (this.buffered < Math.max(4, Math.round(this.config.fps * 1.5))) return false;

    const saved = this.rolling;
    const start = (this.write - this.buffered + this.frames) % this.frames;

    this.clip = {
      atlas: saved,
      start,
      count: this.buffered,
      fps: this.config.fps,
      frames: this.frames,
      cw: this.config.width,
      ch: this.config.height,
      srcAspect: this.srcAspect,
      meta: {
        gameId: meta.gameId ?? null,
        score: meta.score ?? 0,
        label: meta.label ?? 'HIGHLIGHT',
        initials: meta.initials ?? null,
        rank: meta.rank ?? null,
        color: meta.color ?? COLORS.yellow,
        at: Date.now(),
      },
    };

    // The spare becomes the live ring. Its pixels are last session's clip and
    // get overwritten frame by frame; `buffered` starting at 0 means none of
    // them can be shown.
    this.rolling = this.spare;
    this.spare = saved;
    this.write = 0;
    this.buffered = 0;
    return true;
  }

  /** Convenience: capture only when the score earns it. */
  captureIfWorthy(game: GameId, score: number, meta: Partial<ClipMeta> = {}): boolean {
    if (!this.isWorthReplaying(game, score)) return false;
    const r = leaderboard.previewRank(game, score);
    return this.capture({
      gameId: game,
      score,
      rank: r.rank,
      label: r.isRecord ? 'NEW RECORD' : `#${r.rank ?? '?'} TODAY`,
      ...meta,
    });
  }

  hasClip(): boolean {
    return this.clip !== null;
  }

  clipMeta(): ClipMeta | null {
    return this.clip ? { ...this.clip.meta } : null;
  }

  /** Seconds of footage in the saved clip. */
  clipDuration(): number {
    return this.clip ? this.clip.count / this.clip.fps : 0;
  }

  discard(): void {
    this.clip = null;
    this.playing = false;
  }

  /* ---------------- playback ---------------- */

  /** Starts the replay. `loops` defaults to 2 — about 16s, one queue turnover. */
  play(now: number, loops = 2): boolean {
    if (!this.clip) return false;
    this.playStart = now;
    this.playing = true;
    this.loops = 0;
    this.maxLoops = Math.max(1, loops);
    return true;
  }

  stop(): void {
    this.playing = false;
  }

  get isPlaying(): boolean {
    return this.playing && this.clip !== null;
  }

  /**
   * Draws the current replay frame full-bleed with the score stamped on it.
   * Returns true while the replay is still running, so a screen can do:
   *
   *     if (!highlights.render(fc)) this.showNormalResults(fc);
   */
  render(fc: FrameContext, opts: { rect?: { x: number; y: number; w: number; h: number } } = {}): boolean {
    const clip = this.clip;
    if (!this.playing || !clip) return false;

    const { ctx, v } = fc;
    const elapsed = (fc.now - this.playStart) / 1000;
    const dur = clip.count / clip.fps;
    if (dur <= 0) {
      this.playing = false;
      return false;
    }

    this.loops = Math.floor(elapsed / dur);
    if (this.loops >= this.maxLoops) {
      this.playing = false;
      return false;
    }

    const local = elapsed - this.loops * dur;
    const frame = Math.min(clip.count - 1, Math.floor(local * clip.fps));
    const idx = (clip.start + frame) % clip.frames;
    const col = idx % clip.atlas.cols;
    const row = Math.floor(idx / clip.atlas.cols);
    const cw = clip.cw;
    const ch = clip.ch;

    // Letterbox using the aspect the frames were captured at, so a viewport
    // resize between capture and playback does not stretch anyone.
    const box = opts.rect ?? { x: 0, y: 0, w: v.width, h: v.height };
    const boxAspect = box.w / box.h;
    let dw = box.w;
    let dh = box.h;
    if (clip.srcAspect > boxAspect) dh = box.w / clip.srcAspect;
    else dw = box.h * clip.srcAspect;
    const dx = box.x + (box.w - dw) / 2;
    const dy = box.y + (box.h - dh) / 2;

    ctx.save();
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    try {
      ctx.drawImage(clip.atlas.canvas as CanvasImageSource, col * cw, row * ch, cw, ch, dx, dy, dw, dh);
    } catch {
      this.playing = false;
      ctx.restore();
      return false;
    }
    ctx.restore();

    // The scanline pass that used to sit here is gone. It had already been
    // reduced to a no-op in engine/draw.ts — scanlines are a dark-arcade
    // affectation, not this brand — so the call was doing nothing but claiming
    // in a comment that it was hiding the upscale.
    this.drawStamp(fc, clip, local / dur);
    return true;
  }

  /**
   * The score stamp.
   *
   * ZERO blurred draws, and zero gradients. Every element here was one or the
   * other before the rebrand:
   *
   *  - The lower third was a vertical alpha gradient of the background colour.
   *    A gradient is out on its own, and now that the background colour IS
   *    paper it was also fading white into white over a paper replay — an
   *    expensive full-width fill for no visible result.
   *  - The score carried `glow: 40`, the single widest blur radius in the app.
   *    It is now the house score treatment from games/base.ts: flat brand fill,
   *    hard ink shadow straight down. The shadow, not the halo, is what makes a
   *    brand colour readable on paper.
   *  - The pill and the playhead track were translucent fills; both are now
   *    flat — paper and grid respectively.
   *
   * What replaces the gradient is a flat paper band with a single hard ink rule
   * along its top: the same "full-bleed flat card" the Runner's HUD band uses,
   * so the two screens a player sees back-to-back agree with each other.
   */
  private drawStamp(fc: FrameContext, clip: Clip, progress: number): void {
    const { ctx, v } = fc;
    const m = clip.meta;

    const barH = vh(v, 22);
    const barY = v.height - barH;
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(0, barY, v.width, barH);
    ctx.fillStyle = COLORS.ink;
    ctx.fillRect(0, barY, v.width, vh(v, STROKE.base));
    ctx.restore();

    // '<INSTANT REPLAY>' sticker pill, top-left, with a flat red record dot.
    // The dot used to pulse via `withAlpha(red, 0.6 + sin)`, which is a brand
    // colour at varying opacity — the label already says what it is.
    //
    // The pill is MEASURED from its label rather than given a fixed 26vh, for
    // the same reason `fitText` exists: the type size is a proportion of an
    // unknown TV's height, so a hardcoded width is a guess that is wrong at
    // some resolution. It was already clipping the closing bracket at 1080p.
    const label = '<INSTANT REPLAY>';
    const labelSize = vh(v, 1.9);
    const labelTrack = '0.14em';
    const pillH = vh(v, 4.4);
    const pillX = vh(v, 3);
    const pillY = vh(v, 3);

    ctx.save();
    ctx.letterSpacing = labelTrack;
    const labelW = measureText(ctx, label, labelSize, WEIGHT.bold, FONTS.body);
    ctx.restore();
    // Dot gutter on the left, matching padding on the right.
    const pillW = pillH + labelW + pillH * 0.45;

    stickerPill(ctx, v, pillX, pillY, pillW, pillH, {
      fill: COLORS.paper,
      outline: COLORS.ink,
      outlineWidth: vh(v, STROKE.base),
      shadow: vh(v, SHADOW.base),
    });
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLORS.red;
    ctx.beginPath();
    ctx.arc(pillX + pillH * 0.58, pillY + pillH / 2, vh(v, 0.9), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    drawText(ctx, label, pillX + pillH, pillY + pillH / 2, {
      size: labelSize,
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      align: 'left',
      letterSpacing: labelTrack,
    });

    // Kicker above the score. Muted, because `textDim` resolves to ink now and
    // a secondary line set in ink competes with the number it belongs to.
    drawText(ctx, m.label, v.width / 2, v.height - vh(v, 15), {
      size: vh(v, 3),
      color: COLORS.muted,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: '0.26em',
    });

    drawTabularNumber(ctx, String(m.score), v.width / 2, v.height - vh(v, 8), {
      size: vh(v, 11),
      color: m.color,
      weight: WEIGHT.black,
      letterSpacing: TRACK.number,
      shadow: vh(v, SHADOW.lifted),
    });

    if (m.initials) {
      drawText(ctx, m.initials, v.width - vh(v, 4), v.height - vh(v, 8), {
        size: vh(v, 5),
        color: COLORS.ink,
        align: 'right',
        letterSpacing: '0.12em',
      });
    }

    // Playhead: grid track, flat brand fill. Same two-part construction as
    // `progressBar`, minus the rounding, because it is full-bleed.
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLORS.grid;
    ctx.fillRect(0, v.height - vh(v, 0.6), v.width, vh(v, 0.6));
    ctx.fillStyle = m.color;
    ctx.fillRect(0, v.height - vh(v, 0.6), v.width * Math.max(0, Math.min(1, progress)), vh(v, 0.6));
    ctx.restore();
  }

  /* ---------------- measurement ---------------- */

  stats(): HighlightStats {
    const atlasW = this.cols * this.config.width;
    const atlasH = this.rows * this.config.height;
    return {
      grabs: this.grabs,
      avgGrabMs: this.grabs ? this.grabTotal / this.grabs : 0,
      maxGrabMs: this.grabMax,
      amortisedMsPerFrame: this.framesSeen ? this.grabTotal / this.framesSeen : 0,
      framesSeen: this.framesSeen,
      bytes: 2 * atlasW * atlasH * 4,
      frames: this.frames,
      buffered: this.buffered,
      atlas: { width: atlasW, height: atlasH, cols: this.cols, rows: this.rows },
      enabled: this.enabled,
      skipped: this.skipped,
      shedLevel: this.shedLevel,
      shedMeanMs: this.shedMeanMs,
    };
  }

  resetStats(): void {
    this.grabs = 0;
    this.grabTotal = 0;
    this.grabMax = 0;
    this.framesSeen = 0;
    this.skipped = 0;
  }

  getConfig(): HighlightConfig {
    return { ...this.config };
  }
}

export const highlights = new Highlights();
