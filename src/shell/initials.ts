/**
 * ARCADE INITIALS — the thing that turns a score into a leaderboard entry.
 *
 * PLAN.md §4: "Arcade initials, 3 letters, hand-hover grid. Keyboard-free,
 * ~4 seconds, and people enjoy it." And, immediately after: factions, "the
 * highest-leverage feature in the doc", which is picked here too.
 *
 * The hard constraint on this screen is not aesthetic, it is throughput.
 * PLAN.md §1: "A queue of strangers. Hard 60s turn cap." A player who freezes
 * in front of a letter grid because they cannot decide on three letters is
 * holding up everyone behind them, and nobody on the stall can reach over and
 * fix it without touching the laptop. So:
 *
 *  - The third letter auto-advances. No confirm step for the common case.
 *  - A known faction is skipped entirely, with a one-hover way to change it.
 *  - There is a HARD deadline. It submits whatever is on screen and leaves.
 *    This is not a nicety; it is the only thing standing between one indecisive
 *    player and a stalled queue.
 *
 * Handoff: a game finishing its results sequence calls `setPendingScore(...)`
 * and routes here. Kept as module state rather than a constructor argument
 * because `router` builds screens from a zero-argument factory and
 * ARCHITECTURE.md forbids editing main.ts to special-case this one.
 */

import { isSimEnabled } from '../core/simulator';
import { PoseTracker, type TrackedPlayer } from '../core/tracker';
import { camera } from '../core/camera';
import { vision } from '../core/vision';
import { audio } from '../engine/audio';
import {
  decorShape,
  drawTabularNumber,
  drawText,
  fitText,
  graphPaper,
  labelPill,
  measureTabularNumber,
  progressBar,
  roundRect,
  stickerCard,
  stickerPill,
  transition,
  vh,
  wipe,
} from '../engine/draw';
import { Juice } from '../engine/juice';
import { ParticleSystem, BURST } from '../engine/particles';
import { Projection } from '../engine/projection';
import { drawPose, SKELETON_STYLES } from '../engine/skeleton';
import { FACTIONS, leaderboard, type GameId, type RankResult } from '../meta/leaderboard';
import { MENU_TILES } from './menu';
import {
  COLORS,
  DUR,
  EASE,
  FONTS,
  RADIUS,
  SAFE,
  SHADOW,
  SPACE,
  STROKE,
  TRACK,
  TYPE,
  WEIGHT,
  dur,
  factionColor,
  factionSplit,
  idlePulse,
  ramp,
} from './theme';
import { DWELL, HoverCursor, fitTextSize, type HoverTarget } from './hover';
import { router } from './router';
import type { FrameContext, Screen } from './screen';

/* ------------------------------------------------------------------ */
/* Handoff                                                             */
/* ------------------------------------------------------------------ */

export interface PendingScore {
  gameId: GameId;
  score: number;
  /** Screen to route to once submitted. Defaults to the menu. */
  next?: string;
  /**
   * Which seat this score came from, when the round was a versus one.
   *
   * ONLY THE WINNER ENTERS INITIALS (see `GameBase.finishRound`: two name
   * entries per turn would double the slowest part of the flow). That is the
   * right call and it leaves one small hole — two people walk off a split
   * screen and one keyboard appears, with nothing on it saying whose name it
   * wants. They will sort it out socially, but it costs one line to not make
   * them.
   */
  slot?: number;
}

let pending: PendingScore | null = null;

/** Called by a game before routing to 'initials'. */
export function setPendingScore(p: PendingScore): void {
  pending = p;
}

/** Consumed by the screen on mount. Clearing it stops a stale score re-submitting. */
export function takePendingScore(): PendingScore | null {
  const p = pending;
  pending = null;
  return p;
}

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const GRID_COLS = 7;
const GRID_ROWS = 4;
const MAX_INITIALS = 3;

/**
 * Hard ceiling from mount to auto-submit, in seconds.
 *
 * Target is "under 8 seconds total" — 3 letters at the fast dwell plus travel
 * lands around 5–6s for someone who knows what they want. 16s is deliberately
 * well past that: it is not a pace-setter, it is the backstop for a player who
 * has stopped participating. Shrink it after the Sept 22 stranger playtest if
 * real entry times say it can be.
 */
const HARD_DEADLINE_SEC = 16;
/** The countdown only becomes visible this close to the deadline. */
const COUNTDOWN_VISIBLE_SEC = 8;
/**
 * Nobody in frame for this long means they walked away. Submit and clear the
 * screen rather than burning the full deadline staring at an empty room.
 */
const ABANDONED_SEC = 3.5;
/**
 * How long a returning player's remembered faction is shown before it commits
 * itself.
 *
 * The picker is not skipped for them, it is PRE-ANSWERED. Skipping it outright
 * was the first shape of this fix and it took away the only place a player can
 * change sides — somebody who joined ENGINEERING on day one and switched
 * course would have been stuck there for the rest of the event with no route
 * back to the question.
 *
 * Hovering anything cancels the countdown, so the moment a player shows any
 * interest in the screen it stops hurrying them. 1.6s is long enough to read
 * six words and short enough that a queue does not feel it.
 */
const FACTION_CONFIRM_SEC = 1.6;
/**
 * Age at which a vision frame stops counting as evidence that anyone is there.
 * Same figure as `GameBase`; see the guard in `updateTracking`.
 */
const VISION_STALE_MS = 1500;
/**
 * How long the confirmation flourish holds before routing on.
 *
 * Now `DUR.hold` from the theme, so the one "a result is on screen" duration
 * in the app is defined in one place. It was 2.6s here and 2.6s by coincidence
 * elsewhere; coincidence is not a design system.
 */

type Phase = 'letters' | 'faction' | 'done';

/** Flat decorative shapes, corners only — this screen is dense with targets. */
const DECOR: Array<{ kind: 'triangle' | 'circle' | 'blob' | 'halfCircle'; x: number; y: number; r: number; c: string; tilt: number }> = [
  { kind: 'triangle', x: 0.03, y: 0.06, r: 2.2, c: COLORS.green, tilt: -11 },
  { kind: 'circle', x: 0.97, y: 0.07, r: 2.0, c: COLORS.blue, tilt: 0 },
  { kind: 'blob', x: 0.035, y: 0.94, r: 2.4, c: COLORS.yellow, tilt: 8 },
  { kind: 'halfCircle', x: 0.965, y: 0.94, r: 2.2, c: COLORS.red, tilt: -6 },
];

export class InitialsScreen implements Screen {
  readonly id = 'initials';
  onExit?: (next: string) => void;

  /** Public for the dev console, the operator panel, and headless tests. */
  readonly cursor = new HoverCursor(DWELL.fast);

  private tracker = new PoseTracker({ maxPlayers: 1, mirrored: true, filterPreset: 'cosmetic' });
  private proj: Projection | null = null;
  private particles = new ParticleSystem();
  private juice = new Juice();
  private player: TrackedPlayer | null = null;

  private gameId: GameId = 'sixtyseven';
  private score = 0;
  private next = 'menu';

  private phase: Phase = 'letters';
  private letters: string[] = [];
  private faction: string | null = null;
  /** The winning seat of a versus round, or null for a solo one. */
  private winnerSlot: number | null = null;
  /**
   * Seconds left on the auto-confirm for a remembered faction, or -1 when
   * there is no countdown running (a new player, or one who has started
   * reaching for a tile).
   */
  private factionHold = -1;
  /** True once the letters are settled and only the faction step remains. */
  private awaitingFaction = false;

  private targets: HoverTarget[] = [];
  private elapsed = 0;
  private awayTime = 0;
  private doneTime = 0;
  /** Last whole second the auto-submit countdown sounded on. */
  private lastDeadlineTick = -1;
  private result: RankResult | null = null;
  private submitted = false;
  private lastFrameId = -1;
  private enterTime = 0;
  /** See the note on AttractScreen.exiting — the router cannot transition. */
  private exiting: string | null = null;
  private exitTime = 0;

  /**
   * Give the screen its score directly. Equivalent to `setPendingScore`, for
   * callers that hold the instance (tests, the operator console).
   */
  setScore(gameId: GameId, score: number, next = 'menu'): void {
    this.gameId = gameId;
    this.score = score;
    this.next = next;
  }

  /** What has been entered so far. Padded for display, never for storage. */
  get initials(): string {
    return this.letters.join('');
  }

  /** The rank the submission landed at. Null until it is submitted. */
  get rankResult(): RankResult | null {
    return this.result;
  }

  async mount(): Promise<void> {
    audio.init();

    const handoff = takePendingScore();
    if (handoff) {
      this.gameId = handoff.gameId;
      this.score = handoff.score;
      this.next = handoff.next ?? 'menu';
      this.winnerSlot = handoff.slot ?? null;
    }

    // NOT `getLastFaction()`. That is one value for the whole kiosk, so
    // defaulting to it credited every player after the first to whichever
    // faction the first person picked — see `factionFor`. The faction is
    // resolved in `settleLetters` instead, once we know WHOSE score this is.
    this.faction = null;

    if (!isSimEnabled()) {
      await vision.start({ mode: 'pose', numPoses: 1, poseModel: 'lite' });
    }

    window.addEventListener('keydown', this.onKey);
  }

  unmount(): void {
    this.particles.clear();
    window.removeEventListener('keydown', this.onKey);
  }

  /**
   * OPERATOR KEYBOARD. A-Z types, Backspace deletes, Enter submits.
   *
   * The companion to the mouse override on the hand cursor, and requested with
   * it: "the [operator] should still be able to press back/forth, click any
   * buttons or type etc". Spelling a name three dwells at a time is the right
   * interaction for a player standing three metres away and the wrong one for a
   * marshal fixing a typo with a laptop in front of them.
   *
   * Bound as a field so `removeEventListener` gets the same reference — a fresh
   * arrow function per call silently leaks a listener per turn, and this screen
   * mounts on every single turn of the event.
   *
   * Routed through `commit()` rather than touching `letters` directly, so a
   * typed letter fires exactly the same particles, audio, auto-advance and
   * latch handling as a dwelled one, and there is only one path to keep right.
   */
  private onKey = (e: KeyboardEvent): void => {
    if (this.phase === 'done' || e.metaKey || e.ctrlKey || e.altKey) return;

    // Where to throw the confirmation particles. The cursor's last position if
    // there is one, so a marshal typing while a player is still pointing sees
    // the burst at the hand rather than in a corner.
    const at = this.cursor.last;
    const x = at.present ? at.x : 0;
    const y = at.present ? at.y : 0;

    // `layout()` is not called here on purpose: it runs on every render frame,
    // and it needs a FrameContext this handler does not have.
    if (e.key === 'Backspace') {
      e.preventDefault();
      this.commit('key:DEL', x, y);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      this.commit('key:OK', x, y);
      return;
    }
    if (this.phase !== 'letters') return;
    const k = e.key.toUpperCase();
    if (k.length === 1 && k >= 'A' && k <= 'Z') {
      e.preventDefault();
      this.commit(`key:${k}`, x, y);
    }
  };

  render(fc: FrameContext): void {
    const { ctx, v } = fc;
    const dt = this.juice.beginFrame(fc.dt);

    this.updateTracking(fc);
    this.elapsed += fc.dt;
    if (this.enterTime === 0) this.enterTime = fc.time;

    if (this.phase !== 'done') {
      this.awayTime = this.player ? 0 : this.awayTime + fc.dt;
      if (this.elapsed >= HARD_DEADLINE_SEC || this.awayTime >= ABANDONED_SEC) this.finish();
    }

    this.layout(fc);

    graphPaper(ctx, v);
    this.drawDecor(fc);
    this.drawBackdrop(fc);

    const state =
      this.phase === 'done'
        ? this.cursor.last
        : this.cursor.update(fc, this.player, this.targets);

    if (state.committed) {
      this.commit(state.committed, state.x, state.y);
      // A commit can change the phase or re-enable DEL/OK, so the hit set is
      // stale the instant it lands. Rebuild before anything draws from it.
      this.layout(fc);
    }

    this.drawScoreLine(fc);

    if (this.phase === 'letters') {
      this.drawSlots(fc);
      this.drawGrid(fc, state.hovered, state.progress);
      this.drawFactionLine(fc, state.hovered, state.progress);
    } else if (this.phase === 'faction') {
      // The remembered faction confirms itself, unless the player reaches for
      // the screen — any hover means they are considering it, and hurrying
      // somebody who is mid-decision is how you get the wrong answer.
      if (this.factionHold >= 0) {
        if (state.hovered) this.factionHold = -1;
        else {
          this.factionHold -= fc.dt;
          if (this.factionHold <= 0) {
            this.factionHold = -1;
            this.finish();
          }
        }
      }
      this.drawFactionPicker(fc, state.hovered, state.progress);
    } else {
      this.drawDone(fc);
    }

    this.particles.update(dt);
    this.particles.draw(ctx);
    // No drawGlow(): a second 'screen'-composite pass over every particle is
    // both a see-through surface the brand forbids and the most expensive
    // optional thing on the screen.

    if (this.phase !== 'done') {
      this.cursor.draw(fc);
      this.drawDeadline(fc);
    }

    this.juice.drawOverlays(ctx, v);

    const span = dur(DUR.base);
    if (this.phase === 'done') {
      this.doneTime += fc.dt;
      if (this.doneTime > DUR.hold && !this.exiting) {
        // NEVER LEAVE TOWARD A SCREEN THAT DOES NOT EXIST.
        //
        // `next` arrives from `setPendingScore` as a free-form string, and
        // `router.go` warns and silently returns on an unknown id — so this
        // screen re-armed every DUR.base seconds and retried the same dead id
        // forever, with no fallback. `GameBase.finishRound` already uses the
        // safe idiom; this is the same one.
        this.exiting =
          router.has(this.next) ? this.next : router.firstAvailable('menu', 'attract') ?? 'attract';
        this.exitTime = 0;
      }
    }
    if (this.exiting) {
      this.exitTime += fc.dt;
      if (this.exitTime >= span) {
        const next = this.exiting;
        this.exiting = null;
        this.onExit?.(next);
      }
    }
    const tr = transition(fc.time - this.enterTime, this.exiting ? this.exitTime : null, span);
    wipe(ctx, v, tr.t, tr.mode);
  }

  /** Flat shapes at the corners, clear of every readable run. */
  private drawDecor(fc: FrameContext): void {
    const { ctx, v } = fc;
    for (const d of DECOR) {
      decorShape(ctx, d.kind, d.x * v.width, d.y * v.height, vh(v, d.r), d.c, d.tilt);
    }
  }
  /* ---------------- tracking ---------------- */

  private updateTracking(fc: FrameContext): void {
    const cam = camera.getState();
    const camW = cam.width || 1280;
    const camH = cam.height || 720;
    if (!this.proj) {
      this.proj = new Projection(fc.v, {
        cameraWidth: camW,
        cameraHeight: camH,
        fit: 'cover',
        mirrored: true,
      });
    } else {
      this.proj.update(fc.v, { cameraWidth: camW, cameraHeight: camH });
    }

    // STALE VISION MEANS NOBODY. Without this the tracker is never stepped
    // again after the worker dies, so `player` stays non-null and
    // `awayTime` — which is `this.player ? 0 : awayTime + dt` — never
    // accumulates. ABANDONED_SEC then cannot fire and only the 16s
    // HARD_DEADLINE_SEC recovers the screen: the right outcome by the wrong
    // mechanism, at a cost of 12.5s of queue time per abandoned turn.
    if (fc.vision && fc.now - fc.vision.captureTime > VISION_STALE_MS) {
      if (this.player) {
        this.player = null;
        this.tracker.reset();
      }
      return;
    }

    if (!fc.vision || fc.vision.frameId === this.lastFrameId) return;
    this.lastFrameId = fc.vision.frameId;

    // No `setOptions({ aspect })`: the tracker follows the live camera aspect
    // by itself, and passing one explicitly would pin it away from that.
    this.tracker.update(fc.vision.poses, fc.time);
    this.player = this.tracker.getPrimary();
  }

  /* ---------------- layout ---------------- */

  private layout(fc: FrameContext): void {
    this.targets = [];
    if (this.phase === 'letters') this.layoutGrid(fc);
    else if (this.phase === 'faction') this.layoutFactions(fc);
  }

  /**
   * What the OK key says right now.
   *
   * SKIP while the entry is empty, OK once there is something to confirm. Same
   * key, same place, same one dwell — the word just stops lying about what
   * pressing it will do. A player who does not care about the board gets off
   * this screen in 0.95s instead of 16, which at a stall is a whole extra turn
   * every few players.
   *
   * It still SUBMITS: `settleLetters` pads what is there, so an empty entry is
   * stored exactly as the hard deadline would have stored it. The score is
   * never lost, only the name.
   */
  private keyLabel(key: string): string {
    return key === 'OK' && this.letters.length === 0 ? 'SKIP' : key;
  }

  /** A–Z plus DEL and OK, 7 x 4. Every cell is the same size, so the grid is
   *  predictable and nobody has to hunt for the delete key. */
  private layoutGrid(fc: FrameContext): void {
    const { v } = fc;
    const top = vh(v, 38);
    const bottom = vh(v, 84);
    const gap = vh(v, 1);
    const side = vh(v, 6);

    const cellW = (v.width - side * 2 - gap * (GRID_COLS - 1)) / GRID_COLS;
    const cellH = (bottom - top - gap * (GRID_ROWS - 1)) / GRID_ROWS;

    const keys = [...LETTERS, 'DEL', 'OK'];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === undefined) continue;
      const col = i % GRID_COLS;
      const row = Math.floor(i / GRID_COLS);
      this.targets.push({
        id: `key:${key}`,
        x: side + col * (cellW + gap),
        y: top + row * (cellH + gap),
        w: cellW,
        h: cellH,
        // OK IS NEVER DISABLED. See `keyLabel`.
        //
        // It used to need a letter before it would light up, which left a
        // player who did not want a leaderboard entry with no way off this
        // screen at all — they had to stand and wait out the 16s deadline, or
        // walk out of frame and hope, with a queue watching them do either.
        // The exit existed; it was simply not offered.
        enabled: key === 'DEL' ? this.letters.length > 0 : true,
        dwell: DWELL.fast,
      });
    }

    // "Allow changing it" — one target, sitting where the current faction is
    // already printed, so it costs nothing when nobody wants it.
    if (this.faction) {
      const w = v.width * 0.3;
      this.targets.push({
        id: 'change-faction',
        x: (v.width - w) / 2,
        y: vh(v, 86),
        w,
        h: vh(v, 7),
        dwell: DWELL.standard,
      });
    }
  }

  private layoutFactions(fc: FrameContext): void {
    const { v } = fc;
    const cols = 3;
    const rows = Math.ceil(FACTIONS.length / cols);
    const top = vh(v, 30);
    const bottom = vh(v, 84);
    const gap = vh(v, 2);
    const side = vh(v, 8);

    const cellW = (v.width - side * 2 - gap * (cols - 1)) / cols;
    const cellH = (bottom - top - gap * (rows - 1)) / rows;

    for (let i = 0; i < FACTIONS.length; i++) {
      const name = FACTIONS[i];
      if (name === undefined) continue;
      const col = i % cols;
      const row = Math.floor(i / cols);
      this.targets.push({
        id: `faction:${name}`,
        x: side + col * (cellW + gap),
        y: top + row * (cellH + gap),
        w: cellW,
        h: cellH,
        dwell: DWELL.standard,
      });
    }
  }

  /* ---------------- input ---------------- */

  private commit(id: string, x: number, y: number): void {
    if (id.startsWith('key:')) {
      const key = id.slice(4);
      if (key === 'DEL') {
        this.letters.pop();
        this.juice.shake(0.08);
        // NO `cursor.reset()` HERE. It is documented for a PHASE change, and
        // DEL is not one — only the DEL/OK enable flags change, and `layout()`
        // already rebuilds those on the line after every commit.
        //
        // `reset()` wipes `latchedId` as well as the state, so it did two
        // unwanted things at once: the next frame took the cursor's
        // absent -> present branch and restamped `acquiredAt`, imposing a
        // fresh 0.45s settle grace on a hand that had not moved; and with the
        // latch gone, a hand left resting on DEL auto-repeated it about once
        // a second and ate the whole entry. Every letter key leaves the latch
        // alone and needs a deliberate move-away to re-arm; DEL now matches.
        return;
      }
      if (key === 'OK') {
        // SKIP MEANS SKIP, NOT "SKIP THE LETTERS".
        //
        // `settleLetters` advances to the faction picker, which is the right
        // next step for somebody who typed a name and wrong for somebody who
        // declined to. Asking a player who just said they do not want to be on
        // the board which team to put them on is a second dwell for nothing,
        // and it is the dwell a queue is waiting through.
        //
        // Submits exactly as the 16s deadline would have: same padded entry,
        // same score, same everything except sixteen seconds.
        if (this.letters.length === 0) this.finish();
        else this.settleLetters();
        return;
      }
      if (this.letters.length < MAX_INITIALS) {
        this.letters.push(key);
        BURST.splat(this.particles, x, y, COLORS.blueBright, 0.5);
        this.juice.impact(0.35, COLORS.blue);
        // Auto-advance on the third letter. The confirm step is what makes
        // arcade initials feel slow, and DEL already covers a mistake.
        if (this.letters.length >= MAX_INITIALS) this.settleLetters();
      }
      return;
    }

    if (id === 'change-faction') {
      this.awaitingFaction = false;
      this.phase = 'faction';
      this.cursor.reset();
      return;
    }

    if (id.startsWith('faction:')) {
      this.faction = id.slice(8);
      leaderboard.setLastFaction(this.faction);
      BURST.celebrate(this.particles, x, y, [COLORS.yellow, COLORS.text], 0.7);
      this.juice.impact(0.6, COLORS.yellow);
      if (this.awaitingFaction || this.letters.length >= MAX_INITIALS) this.finish();
      else {
        this.phase = 'letters';
        this.cursor.reset();
      }
    }
  }

  /** Letters are done. Pick a faction, or confirm the one on file. */
  private settleLetters(): void {
    // A repeat player is somebody whose initials are already on a board, and
    // what they skip is being ASKED a question they have already answered —
    // not the ability to answer it differently. Their faction arrives
    // pre-selected with a short countdown; everybody else picks from cold,
    // which on day one is nearly everyone and is the only way the totals mean
    // anything by day two.
    if (!this.faction) {
      const known = leaderboard.factionFor(this.letters.join(''));
      if (known) {
        this.faction = known;
        this.factionHold = FACTION_CONFIRM_SEC;
      }
    }

    this.awaitingFaction = true;
    this.phase = 'faction';
    this.cursor.reset();
  }

  /**
   * Submit and hold the result. Idempotent — the deadline, the abandon timer
   * and an OK hover can all race here, and submitting twice would double-count
   * a score into the faction totals.
   */
  private finish(): void {
    if (this.submitted) return;
    this.submitted = true;

    const entered = this.letters.join('');
    const initials = entered.length > 0 ? entered : 'AAA';

    // REACH `done` NO MATTER WHAT `submit` DOES.
    //
    // The latch above is set before this call and the phase change was set
    // after it, so anything thrown out of `submit` left the screen latched in
    // the 'letters' phase forever: `main.ts` swallows the exception to keep the
    // render loop alive, the next frame calls `finish()` again, and the latch
    // returns immediately. The hard deadline, the abandon timer AND an OK
    // hover all become no-ops at once, and there is no other exit — the kiosk
    // renders "SAVING IN 0" under a red bar until somebody reloads it.
    //
    // That is the exact stalled queue HARD_DEADLINE_SEC exists to prevent, and
    // it defeated it. `leaderboard.save()` now isolates its listeners, which
    // removes the reachable trigger; this removes the class.
    try {
      this.result = leaderboard.submit(this.gameId, this.score, initials, this.faction);
    } catch (err) {
      console.error('[initials] submit failed', err);
      this.result = null;
    }

    // What the BOARD holds, which after sanitising is not always what was
    // typed: a deadline-triggered "W" is stored as "W--". Showing the raw
    // entry here meant the payoff sticker and the leaderboard a few seconds
    // later disagreed about the player's own name.
    this.letters = (this.result?.storedInitials ?? initials).split('');

    this.phase = 'done';
    this.doneTime = 0;
    this.cursor.reset();

    if (this.result?.isRecord) {
      this.juice.celebrate(COLORS.yellow);
      audio.play('record');
    } else {
      this.juice.impact(0.8, COLORS.blue);
      audio.play('select');
    }
  }

  /* ---------------- drawing ---------------- */

  private drawBackdrop(fc: FrameContext): void {
    const { ctx, v } = fc;
    // Graph-paper weight, flat. See the equivalent note in menu.ts: this screen
    // is a wall of targets, so a mid-grey figure behind them reads as a fault
    // rather than as a person. At the grid weight it belongs to the paper.
    if (this.player && this.proj) {
      drawPose(ctx, this.player.landmarks, this.proj, {
        ...SKELETON_STYLES.attract,
        color: COLORS.grid,
        alpha: 1,
        glow: 0,
        lineWidth: vh(v, 1.2),
      });
    }
  }

  /**
   * The score, and what it is worth.
   *
   * During the FACTION step the whole block shrinks and the "put your name on
   * it" line disappears. Two competing calls to action on one screen is one
   * too many, and at that moment the question on screen is a different one.
   */
  private drawScoreLine(fc: FrameContext): void {
    const { ctx, v } = fc;
    const tile = MENU_TILES.find((t) => t.id === this.gameId);
    const color = tile?.color ?? COLORS.blue;
    // The score recedes for every phase except the one where it is the reason
    // the player is here. On the faction step the question is the headline; on
    // the done step the RANK is, and two 9vh numbers arguing with each other is
    // how a payoff screen stops having a payoff.
    const compact = this.phase !== 'letters';

    const title =
      this.winnerSlot === null
        ? (tile?.title ?? this.gameId.toUpperCase())
        : `${tile?.title ?? this.gameId.toUpperCase()} · PLAYER ${this.winnerSlot + 1} WINS`;
    drawText(ctx, title, v.width / 2, vh(v, compact ? 5 : 5.6), {
      size: vh(v, TYPE.label),
      maxWidth: v.width - vh(v, SAFE * 4),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: '0.3em',
    });

    // The score is a NUMBER: tabular, so it does not shuffle sideways as it is
    // re-rendered, and so it sits on the same rhythm as every other figure in
    // the app.
    const line = this.score.toLocaleString('en-US');
    const size = vh(v, compact ? TYPE.heading : TYPE.score);
    drawTabularNumber(ctx, line, v.width / 2, vh(v, compact ? 10 : 12), {
      size,
      color,
      weight: WEIGHT.black,
      shadow: vh(v, compact ? SHADOW.base : SHADOW.lifted),
      letterSpacing: TRACK.number,
    });

    if (this.phase !== 'letters') return;

    const preview = leaderboard.previewRank(this.gameId, this.score);
    const note = preview.isRecord
      ? '<NEW BEST!>'
      : preview.rank !== null
        ? `<THAT IS #${preview.rank}!>`
        : '<NICE ONE!>';
    labelPill(ctx, v, v.width / 2, vh(v, 18.6), note, vh(v, 5.2), {
      size: vh(v, TYPE.label),
      fill: preview.isRecord ? COLORS.yellow : COLORS.paper,
      color: COLORS.ink,
      shadow: vh(v, SHADOW.base),
      tilt: preview.isRecord ? -6 : 0,
    });
  }

  /**
   * The three big boxes. The whole screen is a machine for filling these, so
   * they are the largest thing on it after the score.
   */
  private drawSlots(fc: FrameContext): void {
    const { ctx, v } = fc;
    const boxW = vh(v, 12);
    const boxH = vh(v, 14);
    const gap = vh(v, SPACE.md);
    const totalW = boxW * MAX_INITIALS + gap * (MAX_INITIALS - 1);
    const startX = (v.width - totalW) / 2;
    const y = vh(v, 24);

    for (let i = 0; i < MAX_INITIALS; i++) {
      const x = startX + i * (boxW + gap);
      const letter = this.letters[i];
      const isNext = i === this.letters.length && this.phase === 'letters';

      // The next slot is the one to fill, so it is the only yellow thing here.
      // The blink is on FILL, not opacity — a see-through highlight is off
      // brand, and `idlePulse` freezes it under prefers-reduced-motion.
      const beat = idlePulse(fc.time, 6, 1);
      stickerCard(ctx, v, x, y, boxW, boxH, {
        radius: vh(v, RADIUS.inner),
        fill: isNext && beat > 0.5 ? COLORS.yellow : COLORS.paper,
        outlineWidth: vh(v, isNext ? STROKE.thick : STROKE.base),
        shadow: vh(v, letter ? SHADOW.lifted : SHADOW.base),
      });

      if (letter) {
        drawText(ctx, letter, x + boxW / 2, y + boxH / 2, {
          size: vh(v, 9),
          color: COLORS.ink,
          weight: WEIGHT.black,
          letterSpacing: TRACK.h1,
        });
      } else if (isNext) {
        // A solid ink caret sitting on the baseline of the empty box.
        ctx.save();
        ctx.fillStyle = COLORS.ink;
        ctx.fillRect(x + boxW * 0.22, y + boxH * 0.72, boxW * 0.56, vh(v, 0.9));
        ctx.restore();
      }
    }
  }

  private drawGrid(fc: FrameContext, hovered: string | null, progress: number): void {
    const { ctx, v } = fc;
    const radius = vh(v, RADIUS.inner);

    for (const target of this.targets) {
      if (!target.id.startsWith('key:')) continue;
      const key = target.id.slice(4);
      const isHovered = hovered === target.id;
      const disabled = target.enabled === false;
      const special = key === 'DEL' || key === 'OK';

      // At most two brand colours on this component: OK is green, DEL is red,
      // and every letter key is plain paper-and-ink. A 28-key grid where each
      // key carried a colour would be exactly the noise the palette rules are
      // there to prevent.
      // Green means "this confirms what you typed". While the key says SKIP
      // there is nothing to confirm, so it takes the neutral action colour
      // instead — a green SKIP reads as the recommended choice, and it is not.
      const accent =
        key === 'OK'
          ? this.letters.length === 0
            ? COLORS.yellow
            : COLORS.green
          : key === 'DEL'
            ? COLORS.red
            : COLORS.yellow;
      const fill = disabled ? COLORS.paper : special ? accent : COLORS.paper;

      const drop = disabled ? 0 : isHovered ? vh(v, SHADOW.lifted) : vh(v, SHADOW.base);
      const ty = target.y + (isHovered && !disabled ? -vh(v, 0.2) : 0);

      stickerCard(ctx, v, target.x, ty, target.w, target.h, {
        radius,
        fill,
        outline: disabled ? COLORS.muted : COLORS.ink,
        outlineWidth: vh(v, isHovered ? STROKE.thick : STROKE.base),
        shadow: drop,
        shadowColor: disabled ? COLORS.muted : COLORS.ink,
      });

      if (!disabled && isHovered && progress > 0) {
        // Flat dwell wash, clipped to the key. hover.ts's `drawDwellFill`
        // paints a translucent colour in 'screen' blend mode, which is both a
        // see-through brand colour and a literal no-op on white — 'screen'
        // leaves paper unchanged, so on the new background the old fill was
        // invisible.
        ctx.save();
        roundRect(ctx, target.x, ty, target.w, target.h, radius);
        ctx.clip();
        ctx.fillStyle = special ? COLORS.ink : COLORS.yellow;
        ctx.globalAlpha = 1;
        ctx.fillRect(target.x, ty, target.w * progress, target.h);
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = COLORS.ink;
        ctx.lineWidth = vh(v, STROKE.thick);
        roundRect(ctx, target.x, ty, target.w, target.h, radius);
        ctx.stroke();
        ctx.restore();
      }

      const dwellInverted = isHovered && progress > 0.5;
      const label = this.keyLabel(key);
      const size = special
        ? fitTextSize(ctx, label, target.w * 0.72, vh(v, 3.4), WEIGHT.black, FONTS.body)
        : vh(v, 4.8);
      drawText(ctx, label, target.x + target.w / 2, ty + target.h / 2, {
        size,
        color: disabled
          ? COLORS.muted
          : special && dwellInverted
            ? COLORS.paper
            : COLORS.ink,
        font: FONTS.body,
        weight: WEIGHT.black,
        letterSpacing: special ? TRACK.pill : TRACK.h2,
      });
    }
  }

  private drawFactionLine(fc: FrameContext, hovered: string | null, progress: number): void {
    const { ctx, v } = fc;
    const target = this.targets.find((t) => t.id === 'change-faction');
    if (!target || !this.faction) return;

    const isHovered = hovered === 'change-faction';

    stickerPill(ctx, v, target.x, target.y, target.w, target.h, {
      fill: COLORS.paper,
      outlineWidth: vh(v, isHovered ? STROKE.base : STROKE.thin),
      shadow: isHovered ? vh(v, SHADOW.lifted) : 0,
    });

    if (isHovered && progress > 0) {
      ctx.save();
      roundRect(ctx, target.x, target.y, target.w, target.h, target.h / 2);
      ctx.clip();
      ctx.fillStyle = COLORS.yellow;
      ctx.fillRect(target.x, target.y, target.w * progress, target.h);
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = vh(v, STROKE.base);
      roundRect(ctx, target.x, target.y, target.w, target.h, target.h / 2);
      ctx.stroke();
      ctx.restore();
    }

    const label = `PLAYING FOR ${this.faction} · HOVER TO CHANGE`;
    drawText(ctx, label, target.x + target.w / 2, target.y + target.h / 2, {
      size: fitTextSize(ctx, label, target.w - vh(v, SPACE.lg), vh(v, TYPE.label), WEIGHT.bold, FONTS.body),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: TRACK.pill,
    });
  }

  private drawFactionPicker(fc: FrameContext, hovered: string | null, progress: number): void {
    const { ctx, v } = fc;
    const radius = vh(v, RADIUS.card);
    // Two different questions, and they must not look like the same one. A
    // returning player is being asked to CONFIRM; asking "who are you playing
    // for?" over an answer that is already ticking down reads as a screen that
    // has not noticed it knows.
    const confirming = this.factionHold >= 0;
    const title = confirming
      ? `<STILL PLAYING FOR ${this.faction ?? ''}?>`
      : '<WHO ARE YOU PLAYING FOR?>';

    drawText(ctx, title, v.width / 2, vh(v, 21), {
      size: vh(v, TYPE.title),
      maxWidth: v.width - vh(v, SAFE * 4),
      color: COLORS.ink,
      weight: WEIGHT.black,
      // Ink glyphs: paper knockout, never an ink shadow — the shadow is the
      // same word filled again one offset down, which reads as doubled text.
      knockout: true,
      letterSpacing: TRACK.h1,
    });

    if (confirming) {
      drawText(ctx, 'HOVER ANOTHER TO SWITCH', v.width / 2, vh(v, 25.4), {
        size: vh(v, TYPE.label),
        color: COLORS.ink,
        font: FONTS.body,
        weight: WEIGHT.bold,
        letterSpacing: TRACK.pill,
      });
      // A bar, not a number. Nobody reads a countdown they did not ask for;
      // everybody understands a bar running out.
      progressBar(
        ctx,
        v.width * 0.33,
        // The tile grid starts at 30vh (`layoutFactions`), so this sits in the
        // 3vh of clear space between the sub-line and the first card.
        vh(v, 27.4),
        v.width * 0.34,
        vh(v, 0.8),
        1 - Math.max(0, this.factionHold) / FACTION_CONFIRM_SEC,
        COLORS.blue,
        0
      );
    }

    const totals = new Map(leaderboard.getFactionTotals().map((f) => [f.name, f.total]));
    const anyScored = [...totals.values()].some((t) => t > 0);

    for (const target of this.targets) {
      if (!target.id.startsWith('faction:')) continue;
      const name = target.id.slice(8);
      const index = FACTIONS.indexOf(name as (typeof FACTIONS)[number]);
      const color = factionColor(index);
      const isHovered = hovered === target.id;
      const isCurrent = this.faction === name;

      const drop = isHovered ? vh(v, SHADOW.lifted) : vh(v, SHADOW.base);
      const ty = target.y + (isHovered ? -vh(v, 0.2) : 0);

      stickerCard(ctx, v, target.x, ty, target.w, target.h, {
        radius,
        fill: COLORS.paper,
        outlineWidth: vh(v, isHovered || isCurrent ? STROKE.thick : STROKE.base),
        shadow: drop,
      });

      // Faction colour as a full-width accent bar, exactly as the menu tiles
      // do it — six identical outlined boxes carry no identity at all, and
      // these are the teams the whole meta-game runs on.
      ctx.save();
      roundRect(ctx, target.x, ty, target.w, target.h, radius);
      ctx.clip();

      const barH = vh(v, 1.6);
      const split = factionSplit(index);
      if (split) {
        // A faction with no colour of its own gets all four — which is also
        // what "OTHER" means. The alternative was falling through to `muted`,
        // this kit's DISABLED colour, and nobody picks the option that looks
        // switched off.
        const seg = target.w / split.length;
        for (let i = 0; i < split.length; i++) {
          ctx.fillStyle = split[i]!;
          ctx.fillRect(target.x + seg * i, ty, seg + 1, barH);
        }
      } else {
        ctx.fillStyle = color;
        ctx.fillRect(target.x, ty, target.w, barH);
      }
      if (isHovered && progress > 0) {
        ctx.fillStyle = COLORS.yellow;
        ctx.fillRect(target.x, ty, target.w * progress, target.h);
      }
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = vh(v, isHovered || isCurrent ? STROKE.thick : STROKE.base);
      roundRect(ctx, target.x, ty, target.w, target.h, radius);
      ctx.stroke();
      ctx.restore();

      const cx = target.x + target.w / 2;
      drawText(ctx, name, cx, ty + target.h * 0.4, {
        size: vh(v, TYPE.subhead),
        maxWidth: target.w - vh(v, SPACE.lg),
        color: COLORS.ink,
        weight: WEIGHT.black,
        letterSpacing: TRACK.h2,
      });

      // EMPTY STATE. On day 1 every faction reads "0 PTS", six times, which is
      // six lines of nothing. Until somebody scores, the row says what is
      // actually true and useful instead.
      const total = totals.get(name) ?? 0;
      if (anyScored) {
        drawTabularNumber(ctx, `${total.toLocaleString('en-US')} PTS`, cx, ty + target.h * 0.64, {
          size: vh(v, TYPE.label),
          color: COLORS.ink,
          font: FONTS.body,
          weight: WEIGHT.black,
          letterSpacing: TRACK.number,
        });
      } else {
        // Not a placeholder in the kit's sense — it is the ANSWER to "how is
        // this faction doing", on the screen where a player picks one. It has
        // to be as readable as the score it stands in for.
        drawText(ctx, 'NO POINTS YET', cx, ty + target.h * 0.64, {
          size: vh(v, TYPE.label),
          color: COLORS.ink,
          font: FONTS.body,
          weight: WEIGHT.bold,
          letterSpacing: TRACK.pill,
        });
      }

      if (isCurrent) {
        labelPill(ctx, v, cx, ty + target.h * 0.85, 'YOURS', vh(v, 3.6), {
          size: vh(v, TYPE.micro),
          fill: COLORS.yellow,
          color: COLORS.ink,
          shadow: 0,
        });
      }
    }
  }

  /**
   * THE PAYOFF.
   *
   * The rank is the news; the initials are not — the player typed those ten
   * seconds ago. The old layout had the initials at 20vh and the rank at 7vh,
   * which is the hierarchy exactly backwards. The rank now leads.
   */
  private drawDone(fc: FrameContext): void {
    const { ctx, v } = fc;
    const pop = EASE.spring(ramp(this.doneTime, DUR.slow));
    const r = this.result;
    const headline = r?.isRecord ? '<NEW BEST!>' : r?.rank !== null && r ? `<#${r.rank}>` : '<SAVED!>';
    const accent = r?.isRecord ? COLORS.yellow : COLORS.blue;

    ctx.save();
    ctx.translate(v.width / 2, vh(v, 36));
    ctx.scale(pop, pop);
    drawText(ctx, headline, 0, 0, {
      size: vh(v, TYPE.hero),
      maxWidth: v.width - vh(v, SAFE * 4),
      color: accent,
      weight: WEIGHT.black,
      shadow: vh(v, SHADOW.lifted),
      letterSpacing: TRACK.display,
    });
    ctx.restore();

    // The initials, as a sticker. Smaller than the rank and clearly the label
    // for it rather than the headline.
    const name = this.letters.join('');
    labelPill(ctx, v, v.width / 2, vh(v, 55), name, vh(v, 12), {
      size: vh(v, 7),
      fill: COLORS.paper,
      color: COLORS.ink,
      shadow: vh(v, SHADOW.lifted),
      outlineWidth: vh(v, STROKE.thick),
      letterSpacing: TRACK.h1,
      padRatio: 0.5,
    });

    if (!r) return;

    if (!r.isRecord && r.pointsToNext !== null && r.nextRank !== null) {
      drawTabularNumber(ctx, `${r.pointsToNext} OFF #${r.nextRank}`, v.width / 2, vh(v, 68), {
        size: vh(v, TYPE.body),
        color: COLORS.ink,
        font: FONTS.body,
        weight: WEIGHT.black,
        letterSpacing: TRACK.number,
      });
    }

    // AGAINST YOUR OWN PREVIOUS RUN.
    //
    // `submit()` has always computed `personalBest` — the best score already on
    // this board under these initials, measured before this entry is added —
    // and nothing in the app ever read it. It costs nothing, it is the only
    // number here that belongs to this player rather than to the room, and
    // PLAN.md frames day two as "more competitive against day one", which is
    // precisely a returning player typing the same three letters.
    //
    // Only appears for someone who has played this game under these initials
    // before, so it is silent for the majority who have not.
    if (r.personalBest !== null) {
      const beat = this.score > r.personalBest;
      const line = beat ? `BEAT YOUR ${r.personalBest}` : `YOUR BEST ${r.personalBest}`;
      drawTabularNumber(ctx, line, v.width / 2, vh(v, 73.5), {
        size: vh(v, TYPE.label),
        color: COLORS.ink,
        font: FONTS.body,
        weight: WEIGHT.black,
        letterSpacing: TRACK.number,
        // Green hard shadow only when they actually beat it — the brand's way
        // of colouring a moment without putting colour into the letterforms.
        ...(beat ? { shadow: vh(v, SHADOW.base), shadowColor: COLORS.green } : {}),
      });
    }

    if (this.faction) {
      const line = `+${this.score.toLocaleString('en-US')} FOR ${this.faction}`;
      const size = Math.min(
        vh(v, TYPE.subhead),
        fitText(ctx, line, v.width - vh(v, SAFE * 6), vh(v, TYPE.subhead), WEIGHT.black, FONTS.body)
      );
      const w = measureTabularNumber(ctx, line, size, WEIGHT.black, FONTS.body) + vh(v, SPACE.xl);
      const h = vh(v, 6.4);
      // 82, not 78: the personal-best line above needs clearance, and the
      // deadline countdown does not start until 100 - SAFE - 5, so there is
      // room. Verified on screen — at 78 the pill's top edge cut through
      // "BEAT YOUR 180".
      stickerPill(ctx, v, (v.width - w) / 2, vh(v, 82) - h / 2, w, h, {
        fill: COLORS.green,
        shadow: vh(v, SHADOW.base),
      });
      drawTabularNumber(ctx, line, v.width / 2, vh(v, 82), {
        size,
        color: COLORS.ink,
        font: FONTS.body,
        weight: WEIGHT.black,
        letterSpacing: TRACK.number,
      });
    }
  }

  /**
   * The auto-submit countdown. Hidden until it is close, because a timer
   * running the whole time makes people rush and pick worse letters — and
   * because most players will never get near it.
   */
  private drawDeadline(fc: FrameContext): void {
    const { ctx, v } = fc;
    const remaining = Math.max(0, HARD_DEADLINE_SEC - this.elapsed);
    if (remaining > COUNTDOWN_VISIBLE_SEC) return;

    const t = remaining / COUNTDOWN_VISIBLE_SEC;
    const urgent = remaining < 4;

    // Tick the last few seconds, like the round countdown does. A red bar
    // silently draining is the one warning in the app that asked a player to be
    // watching the exact corner of the screen it happens to be in.
    const secs = Math.ceil(remaining);
    if (urgent && secs !== this.lastDeadlineTick) {
      this.lastDeadlineTick = secs;
      if (secs > 0) audio.play('tick', 1 + (4 - secs) * 0.12);
    }
    const w = v.width * 0.4;

    progressBar(ctx, (v.width - w) / 2, vh(v, 100 - SAFE - 1.6), w, vh(v, 1.4), t, urgent ? COLORS.red : COLORS.blue);

    drawTabularNumber(ctx, `SAVING IN ${Math.ceil(remaining)}`, v.width / 2, vh(v, 100 - SAFE - 5), {
      size: vh(v, TYPE.label),
      color: urgent ? COLORS.red : COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.black,
      letterSpacing: TRACK.number,
    });
  }
}
