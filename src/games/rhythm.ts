/**
 * RHYTHM PUNCH — "the spectacle".
 *
 * PLAN.md §3: "the most visually impressive thing on the roster and the best
 * fit for a loud room — it's the one game where the hall's noise doesn't matter
 * because the rhythm is VISUAL."
 *
 * That sentence is the whole specification, and it is a stronger constraint
 * than it looks. Every other game treats "legible with sound off" as a floor to
 * clear. Here it is the entire product: a rhythm game whose rhythm cannot be
 * heard has to put the beat somewhere a person three metres away, in a hall,
 * mid-conversation, can read it. So:
 *
 *   - THE PAPER PULSES ON THE BEAT. The graph-paper rules snap from muted to
 *     ink for a sixth of a beat, every beat. A hard flicker of the whole
 *     background, readable from anywhere in the room, at the cost of one
 *     stroke call.
 *   - THE TUNNEL IS A METRONOME. One ring is born at the horizon on every beat
 *     and arrives at the strike plane exactly on that beat. Four are in flight
 *     at once, so the tempo reads as a stream of approaching objects rather
 *     than a flash you have to catch — which is what makes it legible
 *     peripherally, while the player is mostly watching their own fists.
 *   - EVERY NOTE IS TELEGRAPHED FOR A FULL BAR. Its target ring is drawn at
 *     its final resting place from the instant it spawns, and an approach ring
 *     closes onto it. WHERE to punch is known 1.9s early; only WHEN is in
 *     question.
 *   - HAND IS ENCODED THREE TIMES. Colour, side of the lane, and a chevron
 *     glyph. Colour alone fails for a colour-blind player and on a badly
 *     calibrated panel, and this game gets one chance to be understood.
 *
 * ART DIRECTION — PAPER AND INK, NOT NEON.
 *
 * PLAN.md §5a described neon on black and said "when the GDG branding md
 * lands, it's a palette swap." It has landed: BRAND.md and shell/theme.ts now
 * specify white paper, black ink, four flat brand colours, and hard ink
 * shadows with zero blur. This game is built to that, not to §5a.
 *
 * BRAND.md permits an ink playfield "only where a paper one is measurably less
 * legible at 3m" and rules out "it looked cooler dark". A paper playfield is
 * not less legible here — it is more. The depth cue in this game is scale, and
 * scale needs a hard silhouette: a flat brand-colour disc with an ink outline
 * and a hard ink shadow holds its edge at any size, where a glow on black
 * smears into its neighbours on the cheap panel a club fair will supply. The
 * shadow offset doing double duty as a depth cue is a bonus the dark version
 * could not have had. So: paper.
 *
 * Brand colours in the playfield are BLUE and RED and nothing else — they are
 * the mechanic. Everything structural is ink, muted or grid; the wall is a
 * solid ink slab, which is the most unambiguous "you cannot go through this"
 * object available and costs no brand colour at all. Green appears only on the
 * judgement label, which is a separate component.
 *
 * PERFORMANCE: no `shadowBlur` anywhere, in a loop or out of it. Under the new
 * brand that is not a trade-off — hard shadows are both the correct look and
 * roughly free, where canvas charges a blur per draw call and cost this
 * codebase 92.8ms/frame once already.
 *
 * RENDERING: Canvas 2D with faked perspective, per PLAN.md §5a. No Three.js —
 * the depth cue is scale plus a converging tunnel, and both are exact in 2D.
 */

import { BladeTracker, type Blade } from '../core/blades';
import { VerticalGestures } from '../core/gestures';
import { POSE } from '../core/types';
import type { TrackedPlayer } from '../core/tracker';
import { GameBase, type SlotRect } from './base';
import {
  generateBeatmap,
  gradeFor,
  handForSlot,
  laneXForSlot,
  GRADE_ACCURACY,
  GRADE_POINTS,
  TIMING,
  WALL_POINTS,
  type Beatmap,
  type Grade,
  type Hand,
  type Note,
  type PunchNote,
} from './beatmap';
import { BURST } from '../engine/particles';
import { audio } from '../engine/audio';
import { drawText, vh, roundRect } from '../engine/draw';
import {
  COLORS,
  FONTS,
  WEIGHT,
  TRACK,
  TYPE,
  STROKE,
  SHADOW,
  RADIUS,
  GRID_STEP,
  EASE,
} from '../shell/theme';
import { GAME_COLORS } from '../meta/games';
import { tunables } from '../meta/tunables';

/**
 * Seconds between a real fist arriving and the game seeing it. See `resolve`.
 * Live-adjustable at the stall as `rhythm.inputLatencySec`; this is the
 * fallback when the registry has not been touched.
 */
const INPUT_LATENCY_SEC = 0.067;
import type { FrameContext } from '../shell/screen';

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/**
 * 126 BPM. Not arbitrary: it is what `GameBase` already passes to
 * `audio.startMusic`, so a player wandering between games hears one tempo all
 * evening. 0.476s a beat is also a comfortable punch cadence — fast enough to
 * feel like boxing, slow enough that the chart's hardest pattern (one punch per
 * beat, alternating) is inside what a first-timer can actually do.
 */
const BPM = 126;

/**
 * Flight time from spawn to the strike plane.
 *
 * Exactly four beats — one bar. Shorter and the note is a reflex test, which
 * is the Runner's problem (README: a 0.37–0.45s window minus 0.10s of
 * detection latency, flagged as rhythm-game tight). Longer and the tunnel
 * fills: at the chart's peak of one note per beat, 1.9s already puts four
 * notes in flight per player, which is the most a person can read at 3m.
 */
const APPROACH_SEC = (60 / BPM) * 4;

/** Perspective strength. A note at spawn renders at 1/(1+DEPTH) of full size. */
const DEPTH = 3.2;

/**
 * Hit radius, in TORSO UNITS (ARCHITECTURE.md: "scale.unit is the only correct
 * denominator for a threshold"). Half a torso is a big circle — deliberately
 * larger than the drawn note, so a punch that only looks like it grazed the
 * target still counts. Position is not the skill being tested here; timing is.
 */
const HIT_RADIUS_TORSOS = 0.5;

/** Drawn note radius. Smaller than the hit radius, which is why it feels good. */
const NOTE_RADIUS_TORSOS = 0.3;

/** Horizontal half-span of a lane, in torso units. Outer targets sit at ~1.0. */
const LANE_HALF_TORSOS = 1.25;

/** Combo stops adding to the multiplier here. Caps the score at ~1.9x. */
const COMBO_CAP = 30;

const MAX_SLOTS = 2;
const TAU = Math.PI * 2;

/**
 * Hand colours are FIXED — they never become player colours, even in versus.
 *
 * In 2P the base class tints each half with PLAYER_COLORS, and it is tempting
 * to tint the notes to match. That would destroy the one mapping this game
 * cannot afford to lose. Blue means left fist in 1P, in 2P, on both halves of
 * the screen, for the whole event. Player identity lives in the HUD, where
 * nothing depends on reading it inside 200ms.
 *
 * These two are also the ONLY brand colours in the playfield, which is what
 * keeps it inside BRAND.md's two-per-component cap.
 */
const HAND_COLORS: Record<Hand, string> = { left: COLORS.blue, right: COLORS.red };

/**
 * Judgement colours. A separate component from the notes, so its own budget:
 * one brand colour (green, "success, confirmed") and neutrals for everything
 * else. `good` and `miss` are deliberately quiet — see `missNote`.
 */
const GRADE_COLORS: Record<Grade, string> = {
  perfect: COLORS.green,
  great: COLORS.ink,
  good: COLORS.muted,
};

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

type NoteStatus = 'live' | 'hit' | 'missed';

interface NoteRuntime {
  /** Per slot. */
  status: NoteStatus[];
  /**
   * Per slot: was the correct hand OUTSIDE this note's target ring last frame?
   *
   * This is the anti-passive gate, and it is gentler than a speed threshold.
   * A player parking both fists on the targets collects nothing, because the
   * hand never came from outside — but a punch that arrives and stops dead
   * still scores, which a pure speed gate would reject at exactly the moment
   * the player did the thing correctly.
   */
  armed: boolean[];
  /** Post-resolution animation, 1 → 0. */
  pop: number[];
  /** Wrong-fist feedback cooldown, per slot. */
  wrongAt: number[];
}

interface SlotState {
  score: number;
  combo: number;
  bestCombo: number;
  hits: number;
  misses: number;
  /** Sum of GRADE_ACCURACY over resolved notes. */
  accuracySum: number;
  resolved: number;

  /** Screen-space lane anchor, smoothed. */
  cx: number;
  cy: number;
  unit: number;
  anchored: boolean;

  /** Feedback animation. */
  lastGrade: Grade | 'miss' | null;
  gradeFlash: number;
  comboPulse: number;
  duckFlash: number;
  wallFlash: number;
}

function makeSlotState(): SlotState {
  return {
    score: 0,
    combo: 0,
    bestCombo: 0,
    hits: 0,
    misses: 0,
    accuracySum: 0,
    resolved: 0,
    cx: 0,
    cy: 0,
    unit: 0,
    anchored: false,
    lastGrade: null,
    gradeFlash: 0,
    comboPulse: 0,
    duckFlash: 0,
    wallFlash: 0,
  };
}

/** Dev-only introspection. See `RhythmGame.debug`. */
export interface RhythmDebug {
  songTime: number;
  beat: number;
  playerCount: number;
  hitRadiusPx: number[];
  slots: Array<{
    score: number;
    combo: number;
    bestCombo: number;
    hits: number;
    misses: number;
    accuracy: number;
  }>;
  notes: Array<{
    id: number;
    kind: 'punch' | 'wall';
    time: number;
    /** Seconds until it reaches the strike plane. Negative = already past. */
    delta: number;
    hands: Array<Hand | null>;
    status: NoteStatus[];
    /** Where to put a wrist to hit it, per slot, in normalised CAMERA space. */
    target: Array<{ x: number; y: number } | null>;
  }>;
}

/* ------------------------------------------------------------------ */
/* Drawing primitives — flat fills, hard shadows, zero blur            */
/* ------------------------------------------------------------------ */

/**
 * The brand's sticker: a flat fill, an ink outline, and a hard ink shadow
 * offset straight down with no blur. Two fills and a stroke on one path.
 *
 * The shadow offset is passed rather than taken from SHADOW directly because
 * here it scales with perspective — a near note casts a longer shadow than a
 * far one, which is a second depth cue for free and exactly what a physical
 * sticker would do.
 */
function stickerDisc(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  fill: string,
  lineWidth: number,
  shadow: number
): void {
  if (r <= 0.3) return;
  if (shadow > 0.2) {
    ctx.fillStyle = COLORS.ink;
    ctx.beginPath();
    ctx.arc(x, y + shadow, r, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  if (lineWidth > 0.2) {
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

/** Flat ellipse outline. One path, one stroke, no blur and no translucency. */
function ring(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  color: string,
  width: number
): void {
  if (rx <= 0.4 || ry <= 0.4 || width <= 0.15) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
  ctx.stroke();
}

/** Distance from a point to a segment. The swept blade path, not its tip. */
function pointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Depth as a DISCRETE token, not a fade.
 *
 * The obvious thing is to interpolate toward the paper colour with distance.
 * The brand forbids the tint and, more usefully, three hard steps read better
 * at 3m than a smooth ramp does — a viewer can see which band a ring is in
 * without comparing it to its neighbours.
 */
function depthInk(z: number): string {
  if (z > 0.62) return COLORS.grid;
  if (z > 0.3) return COLORS.muted;
  return COLORS.ink;
}

/* ------------------------------------------------------------------ */

export class RhythmGame extends GameBase {
  /**
   * Blades are POSE WRISTS, not hand landmarks — see the header of
   * core/blades.ts for why that is the only thing that works at 3m.
   *
   * The activation speed is nearly off. Fruit Ninja needs it at 0.55 to stop a
   * parked hand mowing the field; here that exploit is blocked by
   * NoteRuntime.armed instead, which is strictly more forgiving — it rejects a
   * hand that never left the target without also rejecting a punch that lands
   * and stops dead. `active` survives only as a second chance for a player
   * jabbing repeatedly inside the ring.
   */
  private blades = new BladeTracker({
    activateSpeed: 0.34,
    deactivateSpeed: 0.1,
    trailLength: 10,
  });

  /** One per slot. Reads hips against an adapting baseline — the duck. */
  private vert: VerticalGestures[] = [];

  private map: Beatmap = generateBeatmap({ seed: 1, bpm: BPM, bars: 1 });
  private runtime: NoteRuntime[] = [];
  private slots: SlotState[] = [];

  /** Seconds into the chart. Advanced by the juiced dt, like `timeLeft`. */
  private songTime = 0;
  private beatIndex = -1;
  /** 1 → 0 across one beat. Drives every pulse on screen. */
  private beatFlash = 0;
  private barFlash = 0;
  private musicHandedOff = false;

  constructor() {
    super({
      gameId: 'rhythm',
      title: 'RHYTHM PUNCH',
      // Has to explain the whole game with no second line and no sound.
      // Code brackets per BRAND.md's voice rules.
      tagline: '<BLUE = LEFT FIST · RED = RIGHT FIST · DUCK THE BLACK BARS>',
      visionMode: 'pose',
      maxPlayers: 2,
      roundSeconds: 60,
      // Yellow is the brand's "action" colour and the game's chrome colour.
      // It never appears in the playfield, which is reserved for blue and red.
      color: GAME_COLORS.rhythm,
      supportsVersus: true,
    });
  }

  /* ---------------- lifecycle ---------------- */

  protected onStart(playerCount: number): void {
    // A fresh chart every round so the second play is not the first play
    // again, but seeded — so `?seed=` reproduces one exactly for a bug report
    // or for an automated round in the simulator.
    const param = new URLSearchParams(location.search).get('seed');
    const seed = param !== null && param !== '' ? Number(param) : Math.floor(Math.random() * 1e9);

    const beatSeconds = 60 / BPM;
    const barSeconds = beatSeconds * 4;
    const leadInBeats = 6;
    // Stop charting early enough that the last note is fully hittable before
    // the clock runs out — a note the timer eats reads as a dropped input.
    const usable = this.roundTotal - leadInBeats * beatSeconds - APPROACH_SEC;
    const bars = Math.max(1, Math.floor(usable / barSeconds));

    this.map = generateBeatmap({ seed, bpm: BPM, bars, leadInBeats });

    this.runtime = this.map.notes.map(() => ({
      status: ['live', 'live'],
      // Starts armed: at spawn the player's fist is, by definition, not on a
      // target that does not exist yet.
      armed: [true, true],
      pop: [0, 0],
      wrongAt: [-99, -99],
    }));

    this.slots = [];
    this.vert = [];
    for (let i = 0; i < MAX_SLOTS; i++) {
      this.slots.push(makeSlotState());
      this.vert.push(new VerticalGestures());
    }

    this.songTime = 0;
    this.beatIndex = -1;
    this.beatFlash = 0;
    this.barFlash = 0;
    this.musicHandedOff = false;
    this.blades.reset();
    void playerCount;
  }

  protected scoreFor(slot: number): number {
    return this.slots[slot]?.score ?? 0;
  }

  protected primaryLabel(): string {
    return 'SCORE';
  }

  /** PLAN.md §5: "score counters roll, never snap." */
  protected primaryStat(slot: number): string {
    return String(this.scores[slot]?.value ?? this.scoreFor(slot));
  }

  /* ---------------- simulation ---------------- */

  protected onTick(fc: FrameContext, players: TrackedPlayer[], dt: number): void {
    if (!this.proj) return;

    // GameBase starts its own arpeggiator on `enter('playing')`, on a
    // setTimeout chain at its own phase. For six games that is fine. Here a
    // backing track drifting against a beat grid the player is WATCHING is
    // audibly wrong within about fifteen seconds, so we take the tempo over —
    // see audio.playBeat. Done on the first tick because onStart runs BEFORE
    // the base calls startMusic.
    if (!this.musicHandedOff) {
      this.musicHandedOff = true;
      audio.stopMusic(200);
    }

    this.songTime += dt;
    this.beatFlash = Math.max(0, this.beatFlash - dt / this.map.beatSeconds);
    this.barFlash = Math.max(0, this.barFlash - dt / (this.map.beatSeconds * 2));

    const beat = this.songTime / this.map.beatSeconds;
    const index = Math.floor(beat);
    if (index > this.beatIndex) {
      // Only one cue even if several beats elapsed in one frame (a GC pause, a
      // tab regaining focus). Firing the backlog would be a machine-gun burst.
      this.beatIndex = index;
      this.onBeat(index);
    }

    const project = (nx: number, ny: number) => this.proj!.point({ x: nx, y: ny });
    const blades = this.blades.update(players, project, dt, fc.now);

    this.updateAnchors(fc, players);

    for (let slot = 0; slot < this.playerCount; slot++) {
      const player = this.playerFor(players, slot);
      if (player) this.vert[slot]?.update(player, fc.now);

      const s = this.slots[slot];
      if (!s) continue;
      s.gradeFlash = Math.max(0, s.gradeFlash - dt * 1.6);
      s.comboPulse = Math.max(0, s.comboPulse - dt * 3);
      s.duckFlash = Math.max(0, s.duckFlash - dt * 2);
      s.wallFlash = Math.max(0, s.wallFlash - dt * 2.2);
    }

    for (const rt of this.runtime) {
      for (let slot = 0; slot < MAX_SLOTS; slot++) {
        if ((rt.pop[slot] ?? 0) > 0) rt.pop[slot] = Math.max(0, rt.pop[slot]! - dt * 2.4);
      }
    }

    this.resolve(fc, blades);
  }

  private onBeat(index: number): void {
    this.beatFlash = 1;
    // Downbeat of the bar, offset by the lead-in so bar 1 of the chart is bar 1
    // of the music.
    const inBar = ((index - this.map.leadInBeats) % 4 + 4) % 4;
    if (inBar === 0) this.barFlash = 1;

    const progress = 1 - this.timeLeft / this.roundTotal;
    audio.playBeat(index, progress);
  }

  /** The tracked player driving a given slot. In 1P, whoever is in frame. */
  private playerFor(players: readonly TrackedPlayer[], slot: number): TrackedPlayer | undefined {
    if (this.playerCount > 1) return players.find((p) => p.slot === slot);
    return players[0];
  }

  /**
   * Keeps each lane anchored to its player's body rather than to the screen.
   *
   * Targets are placed in TORSO UNITS from the player's own shoulder line, so
   * "outer left, high" is the same reach for someone 5'2" standing close and
   * someone 6'4" standing back — the rule every threshold in this codebase
   * follows, applied to geometry instead of to a gate. A lane fixed to the
   * middle of the screen would ask half the queue to stretch and the other
   * half to punch their own chest.
   *
   * The whole lane moves together — vanishing point, rings and targets — so
   * the perspective illusion survives the player moving about. Heavily
   * smoothed, because a tunnel that twitches with tracking noise is unreadable.
   */
  private updateAnchors(fc: FrameContext, players: readonly TrackedPlayer[]): void {
    const { v } = fc;

    for (let slot = 0; slot < this.playerCount; slot++) {
      const s = this.slots[slot];
      if (!s) continue;
      const rect = this.slotRect(v, slot);

      let tx = rect.centerX;
      let ty = v.height * 0.44;
      let tu = v.height * 0.2;

      const p = this.playerFor(players, slot);
      const ls = p?.landmarks[POSE.LEFT_SHOULDER];
      const rs = p?.landmarks[POSE.RIGHT_SHOULDER];
      if (p && this.proj && ls && rs && p.scale.valid) {
        tx = this.proj.x((ls.x + rs.x) / 2);
        ty = this.proj.y((ls.y + rs.y) / 2);
        tu = this.proj.len(p.scale.unit);
      }

      // Clamps keep the lane on screen for someone standing at the very edge of
      // frame, or tracked at an implausible size for a frame or two.
      tu = clamp(tu, v.height * 0.11, v.height * 0.3);
      const margin = Math.min(tu * LANE_HALF_TORSOS + vh(v, 3), rect.width * 0.45);
      tx = clamp(tx, rect.x + margin, rect.x + rect.width - margin);
      // Below the HUD block (score and chase line live above vh 28) and far
      // enough off the floor that low targets stay on screen.
      ty = clamp(ty, vh(v, 31) + tu * 0.9, v.height - tu * 1.1);

      if (!s.anchored) {
        s.anchored = true;
        s.cx = tx;
        s.cy = ty;
        s.unit = tu;
      } else {
        const k = 0.1;
        s.cx += (tx - s.cx) * k;
        s.cy += (ty - s.cy) * k;
        s.unit += (tu - s.unit) * k;
      }
    }
  }

  /* ---------------- geometry ---------------- */

  /** Perspective scale for a depth. z = 1 at spawn, 0 at the strike plane. */
  private scaleAt(z: number): number {
    if (z >= 0) return 1 / (1 + z * DEPTH);
    // Past the viewer: swells, and is retired by the caller shortly after.
    return Math.min(2.6, 1 - z * 2.4);
  }

  private vanishing(s: SlotState): { x: number; y: number } {
    return { x: s.cx, y: s.cy - s.unit * 0.8 };
  }

  /** Where a note comes to rest, in screen pixels. The punch target. */
  private targetPos(slot: number, laneX: number, laneY: number): { x: number; y: number } {
    const s = this.slots[slot];
    if (!s) return { x: 0, y: 0 };
    return {
      x: s.cx + laneX * s.unit * LANE_HALF_TORSOS,
      // Strike zone centred a quarter-torso below the shoulders: laneY 0.25
      // lands at shoulder height, 0.7 at mid-torso.
      y: s.cy + (0.25 + (laneY - 0.5)) * s.unit,
    };
  }

  /** Projects a resting position back along the tunnel to a depth. */
  private alongTunnel(
    slot: number,
    target: { x: number; y: number },
    scale: number
  ): { x: number; y: number } {
    const s = this.slots[slot];
    if (!s) return target;
    const vp = this.vanishing(s);
    return { x: vp.x + (target.x - vp.x) * scale, y: vp.y + (target.y - vp.y) * scale };
  }

  private hitRadius(slot: number): number {
    return (this.slots[slot]?.unit ?? 0) * HIT_RADIUS_TORSOS;
  }

  /* ---------------- judgement ---------------- */

  /**
   * JUDGEMENT ONLY — the note's drawn position still comes from the true beat.
   *
   * The fist the game tests is a FILTERED landmark (core/blades.ts, line 142:
   * a blade tip is a position, and smoothing it is correct — a jittering tip
   * would be unusable). Smoothing costs time. Cross-correlating the filtered
   * right wrist against the raw one over 600 frames of a 2Hz sweep puts One
   * Euro's `handFast` preset 4 frames behind at 60fps: 67ms, with amplitude
   * attenuated to 65.5%. A real camera adds capture and inference on top.
   *
   * 67ms would be noise in any other game here. In this one it is 61% of the
   * ±110ms perfect window, one-sided: a player punching exactly on the beat is
   * judged at +67ms, so their perfect window is effectively [-177ms, +43ms] in
   * their own frame of reference and any normal 50ms of lateness scores GREAT
   * for what was, with their hand, a PERFECT. Shifting the judgement clock
   * back by the latency re-centres it on the player rather than on the filter.
   *
   * Deliberately NOT applied to the render delta at `drawNotes` — the note must
   * cross the strike line on the beat the music plays. Only the moment the
   * game DECIDES moves.
   */
  private resolve(fc: FrameContext, blades: readonly Blade[]): void {
    const latency = tunables.get('rhythm.inputLatencySec', INPUT_LATENCY_SEC);
    for (let i = 0; i < this.runtime.length; i++) {
      const rt = this.runtime[i]!;
      const note = this.map.notes[i]!;
      const delta = note.time - this.songTime + latency;

      if (delta > APPROACH_SEC) break; // notes are time-sorted
      for (let slot = 0; slot < this.playerCount; slot++) {
        if (rt.status[slot] !== 'live') continue;
        if (note.kind === 'wall') this.resolveWall(fc, rt, slot, delta);
        else this.resolvePunch(fc, note, rt, slot, delta, blades);
      }
    }
  }

  private resolvePunch(
    fc: FrameContext,
    note: PunchNote,
    rt: NoteRuntime,
    slot: number,
    delta: number,
    blades: readonly Blade[]
  ): void {
    const hand = handForSlot(note, slot);
    const target = this.targetPos(slot, laneXForSlot(note, slot), note.y);
    const radius = this.hitRadius(slot);
    if (radius <= 0) return;

    const inWindow = Math.abs(delta) <= TIMING.good;
    const wasArmed = rt.armed[slot] ?? true;
    let stillOutside = true;
    let landed = false;
    /** Did we actually SEE the correct fist this frame? See below. */
    let sawHand = false;

    for (const blade of blades) {
      if (this.playerCount > 1 && blade.slot !== slot) continue;

      // Segment, not point. At 30fps a fast fist jumps hundreds of pixels
      // between samples and a point test tunnels straight through the target —
      // the same failure core/blades.ts documents for swipes.
      const swept = pointToSegment(target.x, target.y, blade.px, blade.py, blade.x, blade.y);

      if (blade.side !== hand) {
        // WRONG FIST. Deliberately NOT a miss and NOT a combo break: the note
        // stays live, so a player who reaches with the wrong hand can still
        // correct it inside the window. Punishing this would punish exactly
        // the confusion the colour coding exists to prevent, and it is the
        // first mistake every new player makes.
        if (inWindow && swept <= radius && fc.time - (rt.wrongAt[slot] ?? -99) > 0.6) {
          rt.wrongAt[slot] = fc.time;
          // Every other feedback moment in this file plays something. This one
          // — the first mistake every new player makes, and the one the colour
          // coding exists to prevent — was silent. Low and short: a nudge, not
          // a buzzer, because the note is still live and still winnable.
          audio.play('whiff', 0.8);
          this.popups.spawn(
            hand === 'left' ? '<LEFT!>' : '<RIGHT!>',
            target.x,
            target.y - radius,
            HAND_COLORS[hand],
            vh(fc.v, TYPE.label)
          );
        }
        continue;
      }

      sawHand = true;
      if (Math.hypot(blade.x - target.x, blade.y - target.y) <= radius * 1.25) stillOutside = false;
      if (inWindow && swept <= radius && (wasArmed || blade.active)) landed = true;
    }

    // ONLY RE-ARM FROM A HAND WE ACTUALLY SAW.
    //
    // `blades` contains visible blades only, so a wrist that drops below the
    // visibility threshold simply is not in the list — the loop never runs,
    // `stillOutside` keeps its initial `true`, and the note re-arms. A parked
    // fist that flickers therefore looks exactly like a fist that left the
    // ring and came back, which is precisely what the anti-passive gate exists
    // to detect.
    //
    // MEASURED with realistic dropouts: a player holding both fists still on
    // the targets scored 140 points without moving. The gate was not merely
    // weakened, it was inverted — dropouts were doing the punching.
    if (sawHand) rt.armed[slot] = stillOutside;

    if (landed) {
      rt.status[slot] = 'hit';
      rt.pop[slot] = 1;
      this.landPunch(fc, note, slot, target, -delta);
      return;
    }

    if (delta < -TIMING.good) {
      rt.status[slot] = 'missed';
      rt.pop[slot] = 1;
      this.missNote(fc, slot, target);
    }
  }

  private resolveWall(fc: FrameContext, rt: NoteRuntime, slot: number, delta: number): void {
    const s = this.slots[slot];
    if (!s) return;

    if (Math.abs(delta) <= TIMING.wall) {
      // `isCrouching` is the held state, not the edge. A duck started early and
      // held through the wall must count — it is what everyone does the first
      // time, and the hysteresis in VerticalGestures already stops it
      // chattering.
      if (this.vert[slot]?.isCrouching) {
        rt.status[slot] = 'hit';
        rt.pop[slot] = 1;
        this.clearWall(fc, slot);
      }
      return;
    }

    if (delta < -TIMING.wall) {
      rt.status[slot] = 'missed';
      rt.pop[slot] = 1;
      s.combo = 0;
      s.misses++;
      s.resolved++;
      s.wallFlash = 1;
      s.lastGrade = 'miss';
      s.gradeFlash = 1;
      audio.play('wallhit');
      this.juice.shake(0.32);
      this.juice.chromatic(0.4);
      const at = this.targetPos(slot, 0, 0.2);
      this.popups.spawn('<WALL!>', at.x, at.y, COLORS.red, vh(fc.v, TYPE.heading));
    }
  }

  private comboMultiplier(combo: number): number {
    return 1 + Math.min(combo, COMBO_CAP) * 0.03;
  }

  private landPunch(
    fc: FrameContext,
    note: PunchNote,
    slot: number,
    at: { x: number; y: number },
    offset: number
  ): void {
    const s = this.slots[slot];
    if (!s) return;
    const { v } = fc;

    // Inside the window by construction, but gradeFor owns the boundaries and
    // nothing here should re-state them.
    const grade = gradeFor(offset) ?? 'good';
    s.combo++;
    s.bestCombo = Math.max(s.bestCombo, s.combo);

    const gained = Math.round(GRADE_POINTS[grade] * this.comboMultiplier(s.combo));
    s.score += gained;
    s.hits++;
    s.resolved++;
    s.accuracySum += GRADE_ACCURACY[grade];
    s.lastGrade = grade;
    s.gradeFlash = 1;
    s.comboPulse = 1;
    this.scores[slot]?.set(s.score);

    const hand = handForSlot(note, slot);
    const color = HAND_COLORS[hand];

    // PLAN.md §5: "rising pitch on combo is the highest-value audio
    // investment." Capped so it stays a cue rather than a whistle.
    audio.play('punch', 0.85 + Math.min(0.9, s.combo * 0.022) + (grade === 'perfect' ? 0.2 : 0));

    // THREE GRADES, THREE WEIGHTS. This was a single on/off step — `perfect`
    // got 0.15 and hitstop, and `great` (65 pts) felt identical to `good` (35).
    // The pitch already carries the distinction; the hands did not, and the
    // hands are what a player at 3m in a loud hall is actually reading.
    const HEFT: Record<typeof grade, number> = { perfect: 1, great: 0.62, good: 0.34 };
    const heft = HEFT[grade];
    this.juice.shake(0.05 + 0.1 * heft);
    if (grade !== 'good') this.juice.hitStop(Math.round(28 * heft));

    // Sparks fire OUTWARD from the target, away from the vanishing point — the
    // note came at you and you stopped it dead.
    const vp = this.vanishing(s);
    const angle = Math.atan2(at.y - vp.y, at.x - vp.x);
    BURST.spark(this.particles, at.x, at.y, angle, color, grade === 'perfect' ? 1.3 : 0.9);
    if (grade === 'perfect') BURST.splat(this.particles, at.x, at.y, COLORS.green, 0.7);

    // Just the number here. The grade WORD is drawn once, big, at the strike
    // line by drawStrikeFeedback — printing it at the note as well meant two
    // pieces of text per hit and, at four notes a bar, a screen of overlapping
    // words exactly where the player needs to be reading target rings.
    this.popups.spawn(`+${gained}`, at.x, at.y, GRADE_COLORS[grade], vh(v, TYPE.body));

    if (s.combo > 0 && s.combo % 15 === 0) {
      this.popups.spawn(
        `<${s.combo} COMBO>`,
        at.x,
        at.y - vh(v, 5),
        COLORS.yellow,
        vh(v, TYPE.heading)
      );
      this.juice.shake(0.24);
    }
  }

  private missNote(fc: FrameContext, slot: number, at: { x: number; y: number }): void {
    const s = this.slots[slot];
    if (!s) return;
    s.combo = 0;
    s.misses++;
    s.resolved++;
    s.lastGrade = 'miss';
    s.gradeFlash = 1;

    // PLAN.md: "failure should be funny, never punishing." No shake, no flash,
    // no red wash. The note crumbles into grey dust and the combo is gone,
    // which is loss enough — and at ~1.2 notes a second a punishing miss cue
    // would dominate the round for whoever is having the worst time.
    audio.play('whiff');
    this.particles.emit({
      x: at.x,
      y: at.y,
      count: 10,
      color: COLORS.muted,
      speed: 90,
      speedVariance: 80,
      size: 3,
      life: 0.5,
      gravity: 420,
      drag: 0.92,
    });
    void fc;
  }

  private clearWall(fc: FrameContext, slot: number): void {
    const s = this.slots[slot];
    if (!s) return;

    s.combo++;
    s.bestCombo = Math.max(s.bestCombo, s.combo);
    const gained = Math.round(WALL_POINTS * this.comboMultiplier(s.combo));
    s.score += gained;
    s.hits++;
    s.resolved++;
    s.accuracySum += 1;
    s.duckFlash = 1;
    s.comboPulse = 1;
    this.scores[slot]?.set(s.score);

    audio.play('duck');
    this.juice.shake(0.2);

    const at = this.targetPos(slot, 0, 0.1);
    BURST.splat(this.particles, at.x, at.y, COLORS.green, 1.1);
    this.popups.spawn(`<DUCKED> +${gained}`, at.x, at.y, COLORS.green, vh(fc.v, TYPE.subhead));
  }

  /* ---------------- rendering ---------------- */

  /**
   * Graph paper, and the full-screen visual metronome.
   *
   * Drawn in EVERY round state — waiting, countdown, playing and results —
   * because a rhythm game whose attract state is a static title card has
   * already lost the person walking past. It runs off the frame clock when
   * nothing is playing, so the paper is beating before anyone steps in.
   *
   * THE PULSE: the major rules (every fourth line, the brand's 32px grid at a
   * 4x interval) snap from `muted` to `ink` for about a sixth of a beat, and
   * the whole grid does it together on the downbeat. Hard-edged, flat, no
   * transparency, one extra stroke call — and visible from further away than
   * anything else on the screen, which is the entire point of this game being
   * on the roster.
   */
  protected onRenderBackground(fc: FrameContext): void {
    const { ctx, v } = fc;

    ctx.save();
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(0, 0, v.width, v.height);

    const step = vh(v, GRID_STEP);
    const hair = Math.max(1, vh(v, 0.09));

    // Beat phase. During play it comes from the song clock, so grid and chart
    // are the same clock; otherwise from wall time, so attract still beats.
    const beat = this.state === 'playing'
      ? this.songTime / this.map.beatSeconds
      : fc.time * (BPM / 60);
    const frac = beat - Math.floor(beat);
    const onBeat = frac < 0.17;
    const onDownbeat = this.state === 'playing' ? this.barFlash > 0.8 : false;

    // Minor rules. One path, one stroke.
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = hair;
    ctx.beginPath();
    for (let x = 0; x <= v.width; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, v.height);
    }
    for (let y = 0; y <= v.height; y += step) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(v.width, Math.round(y) + 0.5);
    }
    ctx.stroke();

    // Major rules — these are the ones that flash.
    ctx.strokeStyle = onDownbeat ? COLORS.ink : onBeat ? COLORS.muted : COLORS.grid;
    ctx.lineWidth = hair * (onBeat ? 2.4 : 1.6);
    ctx.beginPath();
    for (let x = 0, i = 0; x <= v.width; x += step, i++) {
      if (i % 4) continue;
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, v.height);
    }
    for (let y = 0, i = 0; y <= v.height; y += step, i++) {
      if (i % 4) continue;
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(v.width, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }

  protected onRender(fc: FrameContext, _players: TrackedPlayer[]): void {
    for (let slot = 0; slot < this.playerCount; slot++) {
      const s = this.slots[slot];
      if (!s || !s.anchored) continue;
      this.drawLane(fc, slot, s);
      this.drawNotes(fc, slot, s);
      this.drawHands(fc, slot);
      this.drawStrikeFeedback(fc, slot, s);
    }
  }

  /**
   * The tunnel: the second half of the visual metronome, and the thing that
   * makes depth readable.
   *
   * A RECEDING LADDER, not a stack of rings. Two rails run from the horizon to
   * the front corners of the floor, and one rung crosses them on every beat,
   * arriving at the strike line exactly on that beat. Four rungs are in flight
   * at once, so tempo reads as a steady stream of approaching objects — which
   * is what makes it legible peripherally, while the player is mostly watching
   * their own fists.
   *
   * It was closed ellipses first, and that was wrong: six concentric ovals sat
   * on top of six target rings and read as noise rather than as depth, which is
   * the one thing this game cannot afford. A rung is a single short segment, it
   * lives on the FLOOR so it never crosses a note, and depth still reads
   * because the rungs converge. Same information, a third of the ink.
   *
   * Downbeat rungs are ink and thick, offbeats step grid → muted → ink as they
   * approach. That is what lets a player anticipate a pattern rather than
   * merely react to one.
   */
  private drawLane(fc: FrameContext, slot: number, s: SlotState): void {
    const { ctx, v } = fc;
    const vp = this.vanishing(s);
    const thin = vh(v, STROKE.thin);
    const base = vh(v, STROKE.base);

    // Front corners of the floor, below the lowest target so the ladder never
    // crosses a note.
    const half = LANE_HALF_TORSOS + 0.35;
    const floorL = this.targetPos(slot, -half, 1.25);
    const floorR = this.targetPos(slot, half, 1.25);

    ctx.save();

    // The two rails. Muted, never a brand colour — the playfield's colour
    // budget belongs entirely to the two fists.
    ctx.strokeStyle = COLORS.muted;
    ctx.lineWidth = thin;
    ctx.beginPath();
    ctx.moveTo(vp.x, vp.y);
    ctx.lineTo(floorL.x, floorL.y);
    ctx.moveTo(vp.x, vp.y);
    ctx.lineTo(floorR.x, floorR.y);
    ctx.stroke();

    // One rung per beat. -1 catches the rung that just swept under the viewer.
    const beatNow = this.songTime / this.map.beatSeconds;
    for (let k = -1; k <= 5; k++) {
      const b = Math.ceil(beatNow) + k;
      if (b < 0) continue;
      const z = (b * this.map.beatSeconds - this.songTime) / APPROACH_SEC;
      if (z > 1.08) break;
      if (z < -0.22) continue;
      const scale = this.scaleAt(z);
      const a = this.alongTunnel(slot, floorL, scale);
      const c = this.alongTunnel(slot, floorR, scale);
      const downbeat = ((b - this.map.leadInBeats) % 4 + 4) % 4 === 0;

      ctx.strokeStyle = downbeat ? COLORS.ink : depthInk(z);
      ctx.lineWidth = (downbeat ? base : thin) * Math.max(0.45, scale);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(c.x, c.y);
      ctx.stroke();
    }

    // The strike line: where everything is judged. Thick ink, with end ticks so
    // it reads as a gate rather than as one more rung, and its weight jumps on
    // the beat so the line and the tempo are visibly the same thing.
    const tick = s.unit * 0.22;
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = base * (this.beatFlash > 0.55 ? 2.4 : 1.4);
    ctx.beginPath();
    ctx.moveTo(floorL.x, floorL.y);
    ctx.lineTo(floorR.x, floorR.y);
    ctx.moveTo(floorL.x, floorL.y);
    ctx.lineTo(floorL.x, floorL.y - tick);
    ctx.moveTo(floorR.x, floorR.y);
    ctx.lineTo(floorR.x, floorR.y - tick);
    ctx.stroke();

    // A wall that landed: a hard ink frame round the whole lane for ~0.45s.
    // Flat, no wash, and it reads instantly as "that one got you".
    if (s.wallFlash > 0) {
      ctx.strokeStyle = COLORS.red;
      ctx.lineWidth = vh(v, STROKE.thick) * 2;
      const rect = this.slotRect(v, slot);
      const inset = vh(v, 1.2);
      roundRect(
        ctx,
        rect.x + inset,
        vh(v, 30),
        rect.width - inset * 2,
        v.height - vh(v, 31),
        vh(v, RADIUS.card)
      );
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawNotes(fc: FrameContext, slot: number, s: SlotState): void {
    const { ctx, v } = fc;
    const radius = this.hitRadius(slot);

    // Far to near, so nearer notes occlude further ones and the depth reads.
    const visible: Array<{ note: Note; rt: NoteRuntime; z: number }> = [];
    for (let i = 0; i < this.runtime.length; i++) {
      const note = this.map.notes[i]!;
      const rt = this.runtime[i]!;
      const z = (note.time - this.songTime) / APPROACH_SEC;
      if (z > 1.02) break;
      if (z < -0.5) continue;
      if (rt.status[slot] !== 'live' && (rt.pop[slot] ?? 0) <= 0) continue;
      visible.push({ note, rt, z });
    }
    visible.sort((a, b) => b.z - a.z);

    ctx.save();
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    for (const item of visible) {
      if (item.note.kind === 'wall') this.drawWall(ctx, v, slot, s, item.rt, item.z);
      else this.drawPunchNote(ctx, v, slot, s, item.note, item.rt, item.z, radius);
    }
    ctx.restore();
  }

  private drawPunchNote(
    ctx: CanvasRenderingContext2D,
    v: FrameContext['v'],
    slot: number,
    s: SlotState,
    note: PunchNote,
    rt: NoteRuntime,
    z: number,
    radius: number
  ): void {
    const hand = handForSlot(note, slot);
    const target = this.targetPos(slot, laneXForSlot(note, slot), note.y);
    const color = HAND_COLORS[hand];
    const status = rt.status[slot] ?? 'live';
    const pop = rt.pop[slot] ?? 0;
    const thin = vh(v, STROKE.thin);
    const base = vh(v, STROKE.base);

    if (status !== 'live') {
      // Resolution animation, in place, on RADIUS rather than on alpha — the
      // brand has no transparency to fade with, and a ring that grows and
      // stops is legible at 3m where a fade is not.
      const t = 1 - pop;
      if (status === 'hit') {
        ring(ctx, target.x, target.y, radius * (1 + t * 1.6), radius * (1 + t * 1.6), color, base * pop);
      } else {
        ring(ctx, target.x, target.y, radius * (1 - t * 0.55), radius * (1 - t * 0.55), COLORS.muted, thin);
      }
      return;
    }

    /* --- the telegraph: WHERE, known a full bar early --- */

    // Resting ring, drawn from the instant the note spawns. Thin and constant
    // for most of the flight, thickening only in the last third of a second so
    // the eye is pulled to the right place at the right time.
    //
    // It used to thicken across the whole approach, and with four notes in
    // flight that put four heavy rings on screen at once, all of them shouting
    // equally. Weight is only a cue if most things are light.
    const near = clamp(1 - z, 0, 1);
    ring(ctx, target.x, target.y, radius, radius, color, thin + base * Math.max(0, near - 0.82) * 5);

    // Approach ring, closing onto the resting ring. This is the WHEN — the
    // most legible timing cue in any rhythm game, and it works with the sound
    // off, which is the entire brief.
    //
    // Only drawn for the last ~1.1s. Over the full flight it was a second ring
    // per note from the moment it spawned, and the screen became concentric
    // circles; shown late it is unambiguous, because it is the only thing
    // moving toward a target that is about to be hit.
    if (z < 0.42 && z > -0.08) {
      const ar = radius * (1 + Math.max(0, z) * 1.9);
      ring(ctx, target.x, target.y, ar, ar, COLORS.ink, thin);
    }

    /* --- the note itself --- */

    const scale = this.scaleAt(z);
    const pos = this.alongTunnel(slot, target, scale);
    const r = s.unit * NOTE_RADIUS_TORSOS * scale;

    // The hard shadow scales with perspective, so a near note casts a longer
    // shadow than a far one. A second depth cue, free, and exactly what a
    // physical sticker would do.
    stickerDisc(ctx, pos.x, pos.y, r, color, base * Math.max(0.4, scale), vh(v, SHADOW.base) * scale);

    // A double is one two-fisted slam, so it gets a second ring. Reads as
    // "bigger" at a glance without needing a label.
    if (note.double) {
      ring(ctx, pos.x, pos.y, r * 1.45, r * 1.45, COLORS.ink, thin * Math.max(0.5, scale));
    }

    // THE GLYPH. Hand is encoded in colour, in lane side, and here — a chevron
    // pointing the way the fist travels. Colour alone is not enough for a
    // colour-blind player or a badly calibrated TV, and this game gets one
    // chance to be understood. Paper on the flat brand fill, maximum contrast.
    const dir = hand === 'left' ? -1 : 1;
    const g = r * 0.42;
    ctx.strokeStyle = COLORS.paper;
    ctx.lineWidth = Math.max(1, r * 0.2);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const off of [-g * 0.6, g * 0.5]) {
      ctx.moveTo(pos.x + off - dir * g * 0.5, pos.y - g);
      ctx.lineTo(pos.x + off + dir * g * 0.5, pos.y);
      ctx.lineTo(pos.x + off - dir * g * 0.5, pos.y + g);
    }
    ctx.stroke();
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'butt';
  }

  /**
   * A wall. Full lane width, head height, no way through except under it.
   *
   * A solid INK slab, not a brand colour. It is the one object that must read
   * as "you cannot go through this" from across the room; black on paper is
   * the highest-contrast thing available, it needs no explanation, and it
   * spends none of the playfield's two-brand-colour budget, which belongs to
   * the fists. Paper chevrons point down at the gap.
   */
  private drawWall(
    ctx: CanvasRenderingContext2D,
    v: FrameContext['v'],
    slot: number,
    s: SlotState,
    rt: NoteRuntime,
    z: number
  ): void {
    const status = rt.status[slot] ?? 'live';
    const pop = rt.pop[slot] ?? 0;
    // Sits above the shoulders and hangs to mid-torso: the gap is underneath.
    const top = this.targetPos(slot, 0, -0.55);

    if (status !== 'live') {
      // Cleared walls lift away, missed ones stay put and go red.
      const lift = status === 'hit' ? (1 - pop) * s.unit * 1.6 : 0;
      const h = s.unit * 0.9;
      ctx.fillStyle = status === 'hit' ? COLORS.green : COLORS.red;
      ctx.fillRect(s.cx - s.unit * 2, top.y - h / 2 - lift, s.unit * 4, h * pop);
      return;
    }

    const scale = this.scaleAt(z);
    const pos = this.alongTunnel(slot, top, scale);
    const halfW = s.unit * (LANE_HALF_TORSOS + 0.55) * scale;
    const halfH = s.unit * 0.55 * scale;
    const near = clamp(1 - z, 0, 1);

    // Hard shadow first, then the slab, then the outline.
    const shadow = vh(v, SHADOW.lifted) * scale;
    ctx.fillStyle = COLORS.ink;
    ctx.fillRect(pos.x - halfW, pos.y - halfH + shadow, halfW * 2, halfH * 2);
    ctx.fillStyle = z > 0.55 ? COLORS.muted : COLORS.ink;
    ctx.fillRect(pos.x - halfW, pos.y - halfH, halfW * 2, halfH * 2);

    // Chevrons pointing down at the gap — "get under it".
    ctx.strokeStyle = COLORS.paper;
    ctx.lineWidth = Math.max(1.5, halfH * 0.24);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = -2; i <= 2; i++) {
      const cx = pos.x + i * halfW * 0.4;
      ctx.moveTo(cx - halfH * 0.5, pos.y - halfH * 0.4);
      ctx.lineTo(cx, pos.y + halfH * 0.35);
      ctx.lineTo(cx + halfH * 0.5, pos.y - halfH * 0.4);
    }
    ctx.stroke();
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'butt';

    if (near > 0.45) {
      drawText(ctx, '<DUCK>', pos.x, pos.y - halfH - vh(v, 3), {
        size: vh(v, TYPE.subhead + near * 1.4),
        color: COLORS.ink,
        weight: WEIGHT.black,
        letterSpacing: TRACK.h2,
      });
    }
  }

  /**
   * The player's own fists.
   *
   * Drawn as the SAME stickers as the targets, in the same two colours. That
   * is the entire tutorial: your left hand is a blue disc, blue targets are
   * yours, nobody has to read a word.
   *
   * The trail is a row of shrinking stamps rather than a tapered ribbon —
   * flat, hard-edged and on-brand, where a ribbon needs the per-segment alpha
   * (and, in `drawBladeTrail`, the per-segment `shadowBlur`) that the brand and
   * the frame budget both rule out.
   */
  private drawHands(fc: FrameContext, slot: number): void {
    const { ctx, v } = fc;
    const r = vh(v, 2.6);
    const base = vh(v, STROKE.base);
    const shadow = vh(v, SHADOW.base);

    ctx.save();
    for (const blade of this.blades.all) {
      if (this.playerCount > 1 && blade.slot !== slot) continue;
      const color = HAND_COLORS[blade.side];

      const pts = blade.trail;
      ctx.fillStyle = color;
      for (let i = 0; i < pts.length - 1; i += 2) {
        const t = i / Math.max(1, pts.length - 1);
        const p = pts[i]!;
        const rr = r * 0.5 * t;
        if (rr <= 0.5) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr, 0, TAU);
        ctx.fill();
      }

      stickerDisc(ctx, blade.x, blade.y, r, color, base, shadow);
      // Paper core, so a fist reads differently from a target at a glance.
      ctx.fillStyle = COLORS.paper;
      ctx.beginPath();
      ctx.arc(blade.x, blade.y, r * 0.34, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /** The judgement word, at the strike plane where the player is looking. */
  private drawStrikeFeedback(fc: FrameContext, slot: number, s: SlotState): void {
    const { ctx, v } = fc;

    if (s.duckFlash > 0) {
      // A green bar under the lane: the gap you just got through.
      const at = this.targetPos(slot, 0, 1.35);
      ctx.save();
      ctx.fillStyle = COLORS.green;
      ctx.fillRect(s.cx - s.unit * 2.2, at.y, s.unit * 4.4, vh(v, 1.1) * s.duckFlash);
      ctx.restore();
    }

    if (s.gradeFlash <= 0 || !s.lastGrade) return;
    const label = s.lastGrade === 'miss' ? 'MISS' : `<${s.lastGrade.toUpperCase()}>`;
    const color = s.lastGrade === 'miss' ? COLORS.muted : GRADE_COLORS[s.lastGrade];
    const at = this.targetPos(slot, 0, 1.6);
    drawText(ctx, label, at.x, at.y, {
      size: vh(v, TYPE.body + EASE.out(s.gradeFlash) * 1.2),
      color,
      weight: WEIGHT.black,
      letterSpacing: TRACK.h2,
    });
  }

  /* ---------------- HUD ---------------- */

  protected onRenderHud(fc: FrameContext, slot: number, rect: SlotRect): void {
    const { ctx, v } = fc;
    const s = this.slots[slot];
    if (!s) return;

    const accuracy = s.resolved > 0 ? s.accuracySum / s.resolved : 1;

    // COMBO. The one number that changes fast enough to be exciting, and what
    // the multiplier is attached to. Past 15 it gets a yellow sticker pill —
    // yellow is the brand's "action" colour and this is the only place it
    // appears near the playfield.
    if (s.combo >= 2) {
      const hot = s.combo >= 15;
      const pop = 1 + EASE.out(s.comboPulse) * 0.2;
      const label = `${s.combo}x`;
      const size = vh(v, TYPE.subhead);

      ctx.save();
      ctx.translate(rect.centerX, vh(v, 29));
      ctx.scale(pop, pop);
      if (hot) {
        const w = size * 2.6;
        const h = size * 1.5;
        ctx.fillStyle = COLORS.ink;
        roundRect(ctx, -w / 2, -h / 2 + vh(v, SHADOW.base), w, h, h / 2);
        ctx.fill();
        ctx.fillStyle = COLORS.yellow;
        roundRect(ctx, -w / 2, -h / 2, w, h, h / 2);
        ctx.fill();
        ctx.strokeStyle = COLORS.ink;
        ctx.lineWidth = vh(v, STROKE.base);
        ctx.stroke();
      }
      drawText(ctx, label, 0, 0, {
        size,
        color: COLORS.ink,
        weight: WEIGHT.black,
        letterSpacing: TRACK.number,
      });
      ctx.restore();

      drawText(ctx, `COMBO ×${this.comboMultiplier(s.combo).toFixed(2)}`, rect.centerX, vh(v, 32), {
        size: vh(v, TYPE.micro),
        color: COLORS.muted,
        font: FONTS.body,
        weight: WEIGHT.bold,
        letterSpacing: TRACK.body,
      });
    }

    // Accuracy, at the foot of the lane. Third of the "hits + combo +
    // accuracy" triad, and the one a player only reads between rounds — so it
    // sits where it cannot compete with the tunnel.
    drawText(
      ctx,
      `${(accuracy * 100).toFixed(0)}%  ·  ${s.hits}/${s.hits + s.misses}`,
      rect.centerX,
      v.height - vh(v, 6.6),
      {
        size: vh(v, TYPE.label),
        color: COLORS.muted,
        font: FONTS.body,
        weight: WEIGHT.bold,
        letterSpacing: TRACK.number,
      }
    );

    this.drawBeatPips(fc, rect);
  }

  /**
   * Four pips, one bar. A redundant metronome for anyone who has not parsed
   * the tunnel yet — which is the first three seconds of the round, and per
   * ARCHITECTURE.md that is the entire budget for being understood.
   */
  private drawBeatPips(fc: FrameContext, rect: SlotRect): void {
    const { ctx, v } = fc;
    const beat = Math.floor(this.songTime / this.map.beatSeconds);
    const inBar = ((beat - this.map.leadInBeats) % 4 + 4) % 4;
    const r = vh(v, 0.85);
    const gap = vh(v, 3.2);
    const y = v.height - vh(v, 3.4);

    ctx.save();
    for (let i = 0; i < 4; i++) {
      const x = rect.centerX + (i - 1.5) * gap;
      const on = i === inBar && this.beatFlash > 0.25;
      if (on) {
        stickerDisc(ctx, x, y, r * 1.45, i === 0 ? COLORS.yellow : COLORS.ink, 0, 0);
      } else {
        ctx.fillStyle = COLORS.muted;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /* ---------------- dev introspection ---------------- */

  /**
   * Everything the simulator harness needs to assert on this game, including
   * where in CAMERA space a wrist has to be to hit a given note.
   *
   * Exists because the interesting assertions here are all spatial and
   * per-hand — "the right fist on a left-hand target scores nothing" cannot be
   * written without knowing where that target is, and the target moves with the
   * player's body by design. Computing it in the test would mean duplicating
   * the projection, the anchor smoothing and the lane geometry, which would
   * then be the thing under test rather than the game.
   *
   * Dev only. Nothing in the round loop calls it.
   */
  debug(): RhythmDebug {
    const notes: RhythmDebug['notes'] = [];

    for (let i = 0; i < this.map.notes.length; i++) {
      const note = this.map.notes[i]!;
      const rt = this.runtime[i]!;
      const hands: Array<Hand | null> = [];
      const target: Array<{ x: number; y: number } | null> = [];

      for (let slot = 0; slot < MAX_SLOTS; slot++) {
        if (note.kind === 'punch' && slot < this.playerCount && this.slots[slot]?.anchored) {
          hands.push(handForSlot(note, slot));
          const p = this.targetPos(slot, laneXForSlot(note, slot), note.y);
          target.push(this.screenToCamera(p.x, p.y));
        } else {
          hands.push(null);
          target.push(null);
        }
      }

      notes.push({
        id: note.id,
        kind: note.kind,
        time: note.time,
        delta: note.time - this.songTime,
        hands,
        status: [...rt.status],
        target,
      });
    }

    return {
      songTime: this.songTime,
      beat: this.songTime / this.map.beatSeconds,
      playerCount: this.playerCount,
      hitRadiusPx: [this.hitRadius(0), this.hitRadius(1)],
      slots: this.slots.map((s) => ({
        score: s.score,
        combo: s.combo,
        bestCombo: s.bestCombo,
        hits: s.hits,
        misses: s.misses,
        accuracy: s.resolved > 0 ? s.accuracySum / s.resolved : 1,
      })),
      notes,
    };
  }

  /** Screen pixels back to normalised camera space. The projection mirrors. */
  private screenToCamera(x: number, y: number): { x: number; y: number } {
    const r = this.proj?.rect;
    if (!r || r.width <= 0 || r.height <= 0) return { x: 0.5, y: 0.5 };
    return { x: 1 - (x - r.x) / r.width, y: (y - r.y) / r.height };
  }
}
