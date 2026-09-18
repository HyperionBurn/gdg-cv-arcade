/**
 * Shared round lifecycle for every game.
 *
 * PLAN.md §6 defines one flow: countdown → play → score slam → rank reveal →
 * faction contribution → initials → "wave to play again". Seven games
 * implementing that separately would be seven chances to get the queue
 * behaviour subtly wrong, so it lives here once.
 *
 * Also enforces the two hard stall rules from PLAN.md §1:
 *   - hard turn cap, no lives-based rounds
 *   - idle timeout back to attract when nobody is in frame
 *
 * Subclasses implement only what makes their game different: onStart, onTick,
 * onRender, and a score per slot.
 */

import { PoseTracker, type TrackedPlayer } from '../core/tracker';
import { vision } from '../core/vision';
import { camera } from '../core/camera';
import { isSimEnabled } from '../core/simulator';
import type { VisionMode } from '../core/types';
import { Projection } from '../engine/projection';
import { Juice, RollingNumber, PopupLayer } from '../engine/juice';
import { ParticleSystem, BURST } from '../engine/particles';
import { audio } from '../engine/audio';
import { clearFrame, drawText, vh, progressBar, roundRect, graphPaper } from '../engine/draw';
import {
  COLORS,
  PLAYER_COLORS,
  FONTS,
  EASE,
  SHADOW,
  STROKE,
  textColor,
  dur,
  ramp,
  idlePulse,
} from '../shell/theme';
import { leaderboard, type GameId, type RankResult } from '../meta/leaderboard';
import { tunables } from '../meta/tunables';
import { ghosts, drawGhost, type GhostPlayback } from '../meta/ghosts';
import { highlights } from '../meta/highlights';
import { tournament, isTournamentGame } from '../meta/tournament';
import { setPendingScore } from '../shell/initials';
import { router } from '../shell/router';
import type { Screen, FrameContext } from '../shell/screen';

export type RoundState = 'waiting' | 'gathering' | 'countdown' | 'playing' | 'results';

export interface GameConfig {
  gameId: GameId;
  title: string;
  /** One line, shown during the countdown. Must explain the game completely. */
  tagline: string;
  visionMode: VisionMode;
  maxPlayers: number;
  roundSeconds: number;
  color: string;
  /** Show the split-screen divider and per-slot HUD when 2 players are present. */
  supportsVersus: boolean;
  /**
   * Hold a lobby for this many seconds before starting, so more people can
   * join. 0 or absent starts as soon as someone is in frame.
   *
   * Essential for party games. Without it the countdown fires the instant ONE
   * player is confirmed — which for a six-player game means it starts while
   * everyone else is still shuffling into frame, and the whole reason the game
   * is on the roster is lost.
   */
  gatherSeconds?: number;
  /**
   * Everyone present plays together on one shared screen — no split, no slots.
   * `playerCount` then tracks however many are actually in frame.
   */
  partyMode?: boolean;
  /**
   * Draw the ghost as a translucent SKELETON as well as a score line.
   *
   * Off for games with their own 3D camera. The ghost silhouette is projected
   * from camera space, so over the Runner's perspective track it renders as a
   * large grey figure straddling the whole playfield — two incompatible spaces
   * composited on top of each other. Those games still race the ghost; they
   * just do it through the score line, which is the part that carries the
   * information anyway.
   *
   * Defaults to true.
   */
  ghostSilhouette?: boolean;
  /**
   * Put the HUD on a solid paper shelf with a hard ink rule, and shrink it to
   * fit above that rule.
   *
   * FOR GAMES WHOSE PLAYFIELD OWNS THE WHOLE SCREEN. Pose Match is the case
   * that forced it: the wall is a full-opacity ink plane that scales from
   * `WALL_SPAN * S_FAR` to wider than the viewport, and by the halfway point of
   * its approach its top edge has left the screen — so for most of every wall's
   * life the ink plane is behind the entire HUD band. Blue score on ink is
   * 2.3:1; muted grey label on ink is worse.
   *
   * The three fixes that DON'T work, so nobody retries them:
   *  - Cap the wall's growth below `hudBottom()`. The hole is 42% of the plane
   *    and centred at 0.58H, so at impact its TOP edge is at 0.20H — above the
   *    default 0.30H band. Capping the plane cuts the silhouette the player is
   *    supposed to copy, which is the entire game.
   *  - Move the HUD sideways. At impact the plane is 1.8x the viewport width.
   *    There is no horizontal clear space.
   *  - Fade the HUD while a wall is close. It would be faded for most of the
   *    round, which is just deleting the HUD with extra steps.
   *
   * A shelf is the arcade answer: the playfield slides UNDER a header, which
   * reads as depth rather than as a collision, and the header is paper, so
   * every HUD colour is back on its designed background.
   *
   * WHY THE BAND IS 15.8vh AND NOT MORE. A shelf occludes whatever is behind
   * it, and in Pose Match that is the PLAYER — the thing they are checking
   * their own shape against. Measured against the simulator's 3m framing, a
   * standing head tops out around 22vh and fully raised fingertips around
   * 21.6vh; several poses on the roster put the arms straight up. 15.8 keeps
   * ~6vh of clearance over that, which is the margin a taller player or one
   * standing closer to the camera eats into. It also clears the hole's top edge
   * at impact (20.2vh) with room to spare.
   */
  hudShelf?: boolean;
}

/**
 * Vertical HUD layout, in vh. Two presets: the default, and the compact one
 * used with `hudShelf`. Every number the HUD positions itself with lives here
 * so that `hudBottom()` cannot drift out of agreement with what is drawn.
 */
interface HudMetrics {
  barY: number;
  barH: number;
  clockY: number;
  clockSize: number;
  statY: number;
  statSize: number;
  labelY: number;
  labelSize: number;
  chaseY: number;
  /** Multiplier on the chase line's several context-dependent sizes. */
  chaseScale: number;
  /**
   * Lay the clock, the score and the chase line out as ONE ROW — clock flush
   * left, score centred in the slot, chase flush right — instead of stacking
   * them down the middle.
   *
   * A shelf is short by definition, and stacking five elements into 19.8vh
   * costs the score 40% of its height and pushes the label to 1.5vh, which
   * TYPE.micro reserves for operator text nobody has to read. The stacked
   * layout only ever used the centre column; going wide buys back the vertical
   * space for free, and the score ends up at 9vh — within 2vh of the full HUD's
   * 11 — instead of 6.8.
   */
  inlineRow?: boolean;
  /** `hudBottom()`. Must clear the lowest thing above, with margin. */
  bottom: number;
}

const HUD_FULL: HudMetrics = {
  barY: 3, barH: 1.1,
  clockY: 7.5, clockSize: 3.6,
  statY: 16, statSize: 11,
  labelY: 23, labelSize: 1.9,
  chaseY: 26, chaseScale: 1,
  bottom: 30,
};

/**
 * Compact, and laid out across the band rather than down it. The score gives
 * up 2vh; the label and the chase line keep their full size.
 */
const HUD_SHELF: HudMetrics = {
  barY: 2.0, barH: 0.85,
  clockY: 8.6, clockSize: 3.0,
  statY: 8.6, statSize: 8.2,
  labelY: 14.3, labelSize: 1.9,
  chaseY: 8.6, chaseScale: 0.85,
  inlineRow: true,
  bottom: 15.8,
};

/** Frames a player must be absent before we end their round. */
const PLAYER_LOST_GRACE_SEC = 2.5;
/** PLAN.md §6: idle timeout back to attract. */
const IDLE_TIMEOUT_SEC = 20;
const COUNTDOWN_SEC = 3.2;
/** Lobby ends early once this many have joined and held still briefly. */
const GATHER_SETTLE_SEC = 1.2;
/**
 * How long the lobby waits after the LAST person joins before giving up on
 * more arriving.
 *
 * `gatherSeconds` alone was a flat hold: a solo stranger stepping up to Red
 * Light — the only game with a lobby — sat through all 10 seconds of "1 PLAYER
 * READY / STARTING IN 10..9..8" before anything happened. That is a sixth of
 * their turn spent watching a number, alone, at a stall built around a moving
 * queue, and nobody was ever going to join them.
 *
 * Waiting on STABILITY instead gets both cases right: every new arrival resets
 * the clock, so a group trickling in keeps the doors open for as long as they
 * keep coming, and a lone player is off the hook in under three seconds.
 * `gatherSeconds` stays as the hard ceiling.
 */
const GATHER_STABLE_SEC = 2.6;
const RESULTS_SEC = 7;
/**
 * Shorter results hold once the player has actually walked off.
 *
 * The 7s hold exists so a turn is PREDICTABLE, and so the person who just
 * played gets to read their rank. Neither reason survives them leaving. Timed
 * end to end, the old unconditional hold put ~13.3s between a round ending and
 * the menu being usable again, and ~17.7s before the next person was actually
 * playing — past the point where a queue at a stall starts breaking up.
 *
 * `RESULTS_EMPTY_GRACE_SEC` is there because tracking drops a stationary body
 * for a frame or two fairly often, and cutting someone's own results short
 * while they are still standing there reading them is a worse bug than the one
 * being fixed.
 */
const RESULTS_ABANDONED_SEC = 2.6;
const RESULTS_EMPTY_GRACE_SEC = 0.9;

/**
 * Entrance fade on the pre-play lifecycle screens.
 *
 * `enter()` is a pure assignment — `state = x; stateTime = 0` — so
 * waiting -> gathering -> countdown were hard cuts, frame-stepped and
 * confirmed: one `tick(1)` apart, a full lobby composition is replaced by a
 * completely different one with no intermediate frame. That fires on every
 * turn, for every game, for every stranger, and it is the highest-frequency
 * motion gap in the app.
 *
 * A fade and not a `wipe()`. The shell's screen-level wipes are right for
 * screen-level navigation, but four 0.22s wipes inside a single turn would add
 * most of a second of dead time to a handover we have just spent effort
 * shortening — and these are not different screens, they are the same screen
 * changing its mind. countdown -> playing is deliberately excluded: `enter`
 * already fires `juice.flash` there, which is a louder and better marker than
 * a fade.
 *
 * Via `ramp`, so it is already 1 on frame one under reduced motion rather than
 * a very fast 0.
 */
const STATE_ENTER_SEC = 0.2;

export abstract class GameBase implements Screen {
  readonly id: string;
  onExit?: (next: string) => void;

  protected tracker: PoseTracker;
  protected proj: Projection | null = null;
  protected juice = new Juice();
  protected particles = new ParticleSystem();
  protected popups = new PopupLayer();
  protected scores: RollingNumber[] = [];

  protected state: RoundState = 'waiting';
  protected stateTime = 0;
  /** Seconds remaining in the round. */
  protected timeLeft = 0;
  protected players: TrackedPlayer[] = [];
  protected playerCount = 1;

  private lastFrameId = -1;
  private idleTime = 0;
  private lostTime = 0;
  private results: Array<{ slot: number; score: number; rank: RankResult }> = [];
  private lastCountdownTick = -1;
  /** Highest headcount seen this lobby, and when it last went up. */
  private gatherPeak = 0;
  private gatherLastJoin = 0;
  /**
   * Latched once the ghost race is out of reach, so the chase line can fall
   * back to the leaderboard instead. LATCHED rather than recomputed each
   * frame, because the deficit crosses any threshold repeatedly and the line
   * would flicker between two different messages.
   */
  private ghostRaceLost = false;
  /** Continuous seconds with nobody in frame, during results only. */
  private resultsEmptyTime = 0;
  /** stateTime at which the results panel first drew. -1 until it has. */
  private panelStart = -1;
  private frameBudgetStrikes = 0;
  /**
   * The best previous solo run, replayed alongside the live player.
   * PLAN.md §4: "turns a solo run into a race."
   */
  private ghost: GhostPlayback | null = null;

  constructor(protected config: GameConfig) {
    this.id = config.gameId;
    this.tracker = new PoseTracker({
      maxPlayers: config.maxPlayers,
      mirrored: true,
    });
    for (let i = 0; i < config.maxPlayers; i++) this.scores.push(new RollingNumber(10));
  }

  /* ---------------- subclass hooks ---------------- */

  /** Reset game state for a new round. */
  protected abstract onStart(playerCount: number): void;
  /** Simulate. `dt` already has hit-stop and slow-mo applied. */
  protected abstract onTick(fc: FrameContext, players: TrackedPlayer[], dt: number): void;
  /** Draw the world. HUD is drawn by the base afterwards. */
  protected abstract onRender(fc: FrameContext, players: TrackedPlayer[]): void;
  /** Final score for a slot. */
  protected abstract scoreFor(slot: number): number;

  /** Optional: draw behind everything (backdrops, camera feed). */
  protected onRenderBackground?(fc: FrameContext): void;
  /** Optional: extra HUD per slot. */
  protected onRenderHud?(fc: FrameContext, slot: number, rect: SlotRect): void;
  /** Optional: what the big number during play should read. Defaults to score. */
  protected primaryStat(slot: number): string {
    return String(this.scoreFor(slot));
  }
  protected primaryLabel(): string {
    return 'SCORE';
  }

  /* ---------------- lifecycle ---------------- */

  async mount(): Promise<void> {
    // In sim mode the simulator feeds poses directly; starting MediaPipe would
    // just spin up a worker with no camera behind it.
    if (!isSimEnabled()) {
      await vision.start({
        mode: this.config.visionMode,
        numPoses: this.config.maxPlayers,
        numHands: this.config.maxPlayers * 2,
      });
    }
    this.tracker.setOptions({ maxPlayers: this.config.maxPlayers });
    this.enter('waiting');
    audio.init();
  }

  unmount(): void {
    // An abandoned round must not be saved as the run to beat.
    ghosts.cancel();
    audio.stopMusic();
    this.particles.clear();
    this.popups.clear();
  }

  protected enter(state: RoundState): void {
    this.state = state;
    this.stateTime = 0;

    if (state === 'countdown') {
      this.lastCountdownTick = -1;
    }
    if (state === 'gathering') {
      this.gatherPeak = 0;
      this.gatherLastJoin = 0;
    }
    if (state === 'playing') {
      // roundScale lets a marshal shorten every round when the queue backs up.
      this.timeLeft = this.config.roundSeconds * tunables.get('game.roundScale', 1);
      for (const s of this.scores) s.reset(0);
      this.results = [];
      this.onStart(this.playerCount);

      // Ghosts are a solo mechanic — in versus the opponent IS the ghost, and
      // a third translucent body on screen would just be noise.
      this.ghost = null;
      this.ghostRaceLost = false;
      ghosts.cancel();
      if (this.playerCount === 1) {
        this.ghost = ghosts.load(this.config.gameId);
        ghosts.record(this.config.gameId);
      }

      audio.play('go');
      audio.startMusic(126);
      this.juice.flash(this.config.color, 0.3, 5);
    }
    if (state === 'results') {
      this.resultsEmptyTime = 0;
      this.panelStart = -1;
      // Gameplay popups do not belong on the summary. A 67 Speed milestone
      // ("200") was caught floating directly over the final score ("203") —
      // the last rep of a round fires a popup with ~0.9s of life left, and the
      // results screen arrives well inside that. It was always wrong and the
      // new paper knockout made it unmissable.
      this.popups.clear();
      audio.stopMusic();
      this.finaliseResults();
    }
    if (state === 'waiting') {
      this.idleTime = 0;
      this.tracker.reset();
    }
  }

  private finaliseResults(): void {
    this.results = [];
    for (let slot = 0; slot < this.playerCount; slot++) {
      const score = this.scoreFor(slot);
      // Preview only — the real submit happens after initials entry, which is
      // a later milestone. Showing the rank immediately is what creates the
      // "2 off third" retry hook.
      const rank = leaderboard.previewRank(this.config.gameId, score);
      this.results.push({ slot, score, rank });
      this.scores[slot]?.set(score);
    }

    const best = this.results.reduce((a, b) => (b.score > a.score ? b : a), this.results[0]!);

    if (this.playerCount === 1) ghosts.finish(this.scoreFor(0));
    else ghosts.cancel();

    if (best && best.score > 0) {
      highlights.captureIfWorthy(this.config.gameId, best.score, {
        color: this.config.color,
      });
    }

    // A live bracket owns the result of a versus round.
    if (
      this.playerCount === 2 &&
      tournament.active &&
      isTournamentGame(this.config.gameId) &&
      tournament.game === this.config.gameId
    ) {
      // Returns false on a dead heat — the match is NOT advanced and the pair
      // replays. Coin-tossing a tie in front of a crowd is indefensible.
      tournament.reportCurrent(this.scoreFor(0), this.scoreFor(1));
    }

    if (best && best.rank.isRecord && best.score > 0) {
      this.juice.celebrate(COLORS.yellow);
      audio.play('record');
    } else {
      this.juice.impact(0.6, this.config.color);
    }
  }

  /* ---------------- frame ---------------- */

  render(fc: FrameContext): void {
    const { ctx, v } = fc;
    const dt = this.juice.beginFrame(fc.dt);
    this.stateTime += fc.dt;

    this.watchFrameBudget(fc.dt);
    this.ensureProjection(v);
    this.updateTracking(fc);

    clearFrame(ctx, v);
    this.onRenderBackground?.(fc);

    this.juice.pushTransform(ctx, v);

    // The pre-play screens fade in; see STATE_ENTER_SEC. Set on the context
    // around the whole tick rather than threaded through every draw call.
    const enterT = ramp(this.stateTime, STATE_ENTER_SEC);

    switch (this.state) {
      case 'waiting':
        ctx.save();
        ctx.globalAlpha = enterT;
        this.tickWaiting(fc);
        ctx.restore();
        break;
      case 'gathering':
        ctx.save();
        ctx.globalAlpha = enterT;
        this.tickGathering(fc);
        ctx.restore();
        break;
      case 'countdown':
        ctx.save();
        ctx.globalAlpha = enterT;
        this.tickCountdown(fc);
        ctx.restore();
        break;
      case 'playing':
        this.drawGhostPose(fc);
        this.tickPlaying(fc, dt);
        break;
      case 'results':
        this.tickResults(fc);
        break;
    }

    this.particles.update(dt);
    this.popups.update(dt);
    this.particles.draw(ctx);
    this.particles.drawGlow(ctx);
    this.popups.draw(ctx, FONTS.display);

    this.juice.popTransform(ctx);
    this.juice.drawOverlays(ctx, v);
  }

  /**
   * PLAN.md §2: "Frame budget watchdog: auto-drop particle density and effect
   * quality if we miss frame time." Three consecutive slow frames sheds
   * quality; sustained good frames earn it back.
   */
  private watchFrameBudget(dt: number): void {
    // Both branches clamp to the operator's cap. Without this, PANIC's quality
    // drop silently decays back to full over ~16s as the watchdog earns credit
    // back — the cap would persist in storage while nothing honoured it.
    const cap = tunables.get('fx.qualityCap', 1);

    if (dt > 1 / 45) {
      this.frameBudgetStrikes++;
      if (this.frameBudgetStrikes > 12) {
        this.particles.quality = Math.min(cap, Math.max(0.25, this.particles.quality - 0.25));
        this.frameBudgetStrikes = 0;
      }
    } else {
      this.frameBudgetStrikes = Math.max(0, this.frameBudgetStrikes - 1);
      if (this.frameBudgetStrikes === 0 && this.particles.quality < cap) {
        this.particles.quality = Math.min(cap, this.particles.quality + 0.0008);
      }
    }
    if (this.particles.quality > cap) this.particles.quality = cap;

    // How the frame-budget watchdog throttles highlight capture.
    highlights.setQuality(this.particles.quality);
  }

  private ensureProjection(v: FrameContext['v']): void {
    const cam = camera.getState();
    if (!this.proj) {
      this.proj = new Projection(v, {
        cameraWidth: cam.width || 1280,
        cameraHeight: cam.height || 720,
        fit: 'cover',
        mirrored: true,
      });
    } else {
      this.proj.update(v, {
        cameraWidth: cam.width || 1280,
        cameraHeight: cam.height || 720,
      });
    }
  }

  private updateTracking(fc: FrameContext): void {
    if (!fc.vision || fc.vision.frameId === this.lastFrameId) return;
    this.lastFrameId = fc.vision.frameId;

    // Landmark space is anisotropic (x normalised by width, y by height), so
    // the tracker needs the real aspect to measure bodies correctly.
    const cam = camera.getState();
    if (cam.width > 0 && cam.height > 0) {
      this.tracker.setOptions({ aspect: cam.width / cam.height });
    }
    this.players = this.tracker.update(fc.vision.poses, fc.time);
  }

  /* ---------------- states ---------------- */

  /** How many of the people in frame this game will actually play with. */
  private resolvePlayerCount(present: number): number {
    if (this.config.partyMode) return Math.max(1, Math.min(present, this.config.maxPlayers));
    if (this.config.supportsVersus) return Math.min(Math.max(present, 1), 2);
    return 1;
  }

  private tickWaiting(fc: FrameContext): void {
    const { ctx, v } = fc;
    const present = this.players.length;

    if (present > 0) {
      this.idleTime = 0;
      this.playerCount = this.resolvePlayerCount(present);
      // Party games hold a lobby so the rest of the group can get in frame.
      this.enter((this.config.gatherSeconds ?? 0) > 0 ? 'gathering' : 'countdown');
      return;
    }

    this.idleTime += fc.dt;
    if (this.idleTime > tunables.get('game.idleTimeoutSec', IDLE_TIMEOUT_SEC)) this.onExit?.('attract');

    const pulse = 0.6 + idlePulse(fc.time, 2.4, 1) * 0.4;
    drawText(ctx, this.config.title, v.width / 2, v.height * 0.4, {
      size: vh(v, 9),
      color: this.config.color,
      shadow: vh(v, SHADOW.lifted),
            letterSpacing: '0.03em',
    });
    drawText(ctx, '<STEP INTO THE FRAME>', v.width / 2, v.height * 0.56, {
      size: vh(v, 3.4),
      color: COLORS.text,
      alpha: pulse,
      font: FONTS.body,
      weight: 600,
      letterSpacing: '0.18em',
    });
    drawText(ctx, this.config.tagline, v.width / 2, v.height * 0.66, {
      size: vh(v, 2.2),
      color: COLORS.muted,
      font: FONTS.body,
      weight: 400,
    });
  }

  /**
   * The lobby. Counts people in, and starts when the timer runs out or the
   * game is full.
   *
   * Deliberately shows the joining count as the headline: it tells the people
   * already in frame that more are welcome, and it tells the queue that this
   * is the game you play WITH people, which is the whole pitch.
   */
  private tickGathering(fc: FrameContext): void {
    const { ctx, v } = fc;
    const present = this.players.length;
    const total = this.config.gatherSeconds ?? 0;

    if (present === 0) {
      this.enter('waiting');
      return;
    }

    this.playerCount = this.resolvePlayerCount(present);

    const elapsed = this.stateTime;
    const full = present >= this.config.maxPlayers;

    // Every arrival reopens the window. Only counts people JOINING — someone
    // stepping out of frame must not shorten the wait for everyone still in it.
    if (present > this.gatherPeak) {
      this.gatherPeak = present;
      this.gatherLastJoin = elapsed;
    }

    // The earlier of "nobody has joined for a while" and the hard ceiling.
    const deadline = Math.min(total, this.gatherLastJoin + GATHER_STABLE_SEC);

    // A full lobby still gets a moment to settle, so the last person to step in
    // isn't mid-stride when the countdown starts.
    if (elapsed >= deadline || (full && elapsed >= GATHER_SETTLE_SEC)) {
      this.enter('countdown');
      return;
    }

    const remain = Math.max(0, deadline - elapsed);
    const pulse = 0.65 + idlePulse(fc.time, 3, 1) * 0.35;

    drawText(ctx, String(present), v.width / 2, v.height * 0.33, {
      size: vh(v, 16),
      color: this.config.color,
          });
    drawText(
      ctx,
      present === 1 ? 'PLAYER READY' : 'PLAYERS READY',
      v.width / 2,
      v.height * 0.47,
      {
        size: vh(v, 3),
        color: COLORS.text,
        font: FONTS.body,
        weight: 700,
        letterSpacing: '0.2em',
      }
    );
    drawText(ctx, `STEP IN — UP TO ${this.config.maxPlayers} CAN PLAY`, v.width / 2, v.height * 0.56, {
      size: vh(v, 2.4),
      color: COLORS.muted,
      font: FONTS.body,
      weight: 500,
      alpha: pulse,
    });

    progressBar(
      ctx, v.width * 0.25, v.height * 0.66, v.width * 0.5, vh(v, 1.2),
      1 - remain / Math.max(0.001, deadline), this.config.color, 14
    );
    drawText(ctx, `<STARTING IN ${Math.ceil(remain)}>`, v.width / 2, v.height * 0.73, {
      size: vh(v, 2.2),
      color: COLORS.muted,
      font: FONTS.mono,
      weight: 600,
      letterSpacing: '0.1em',
    });
  }

  private tickCountdown(fc: FrameContext): void {
    const { ctx, v } = fc;

    if (this.players.length === 0) {
      this.enter('waiting');
      return;
    }

    const remaining = COUNTDOWN_SEC - this.stateTime;
    if (remaining <= 0) {
      this.enter('playing');
      return;
    }

    const n = Math.ceil(remaining - 0.2);
    if (n !== this.lastCountdownTick && n > 0) {
      this.lastCountdownTick = n;
      audio.play('tick', 1 + (3 - n) * 0.15);
      this.juice.shake(0.08);
    }

    // POP IN BIG, SETTLE TO FULL SIZE — and hold there.
    //
    // This did the exact opposite of what its own comment claimed. `frac` is
    // just elapsed time within the current digit's one-second window, so the
    // old `ctx.scale(2 - scale, ...)` put the digit at 1.0x for the single
    // frame it appeared, shrank it to 0.6x over the next third of a second,
    // and held it at 0.6x for the remaining two thirds. The largest, most
    // important element in the app — the thing the whole room reads from 3m —
    // spent most of its life at 12vh instead of the 20vh it asks for, and the
    // motion read as a retreat rather than a landing.
    const frac = 1 - ((remaining - 0.2) % 1);
    // `dur` collapses the pop to zero under reduced motion, which leaves the
    // digit at a steady full size — exactly what that setting asks for.
    const popSec = dur(0.333);
    const scale = 1 + 0.4 * (1 - EASE.out(popSec <= 0 ? 1 : Math.min(1, frac / popSec)));

    ctx.save();
    ctx.translate(v.width / 2, v.height * 0.45);
    ctx.scale(scale, scale);
    drawText(ctx, n > 0 ? String(n) : 'GO', 0, 0, {
      size: vh(v, 20),
      color: this.config.color,
      shadow: vh(v, SHADOW.lifted),
          });
    ctx.restore();

    drawText(ctx, this.config.tagline, v.width / 2, v.height * 0.74, {
      size: vh(v, 3),
      color: COLORS.text,
      font: FONTS.body,
      weight: 600,
    });

    if (this.playerCount === 2) {
      drawText(ctx, '<VERSUS>', v.width / 2, v.height * 0.2, {
        size: vh(v, 4),
        color: COLORS.ink,
        shadow: vh(v, SHADOW.base),
        shadowColor: COLORS.yellow,
        letterSpacing: '0.3em',
      });
    }
  }

  private tickPlaying(fc: FrameContext, dt: number): void {
    this.timeLeft -= dt;

    // End when the clock runs out, or when the player leaves for long enough
    // that they're clearly gone rather than briefly occluded.
    if (this.players.length === 0) {
      this.lostTime += fc.dt;
      if (this.lostTime > PLAYER_LOST_GRACE_SEC) {
        this.enter('results');
        return;
      }
    } else {
      this.lostTime = 0;
    }

    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.enter('results');
      return;
    }

    // Music intensity tracks the clock so the round builds toward its end.
    const progress = 1 - this.timeLeft / this.config.roundSeconds;
    audio.setMusicIntensity(progress);

    if (this.playerCount === 1) {
      ghosts.sample(
        this.config.roundSeconds - this.timeLeft,
        this.scoreFor(0),
        this.players[0]?.landmarks ?? null
      );
    }

    this.onTick(fc, this.players, dt);
    this.onRender(fc, this.players);

    for (const s of this.scores) s.update(fc.dt);
    this.drawHud(fc);
  }

  /**
   * The previous best run, replayed translucent behind the live player.
   * Drawn before onRender so it can never occlude the thing being played.
   */
  private drawGhostPose(fc: FrameContext): void {
    if (!this.ghost || !this.proj) return;
    if (this.config.ghostSilhouette === false) return;
    const pose = this.ghost.poseAt(this.config.roundSeconds - this.timeLeft);
    if (pose) drawGhost(fc.ctx, this.proj, pose, { color: COLORS.muted });
  }

  private tickResults(fc: FrameContext): void {
    const { ctx, v } = fc;
    for (const s of this.scores) s.update(fc.dt);

    // Instant replay, if this run earned one.
    //
    // THE REPLAY LIVES INSIDE THE RESULTS WINDOW — it never extends it.
    //
    // The first version returned early while the replay was playing, which put
    // the round-advance check behind it. `play()` defaults to two loops of an
    // ~8s clip, so a good run held the results screen for ~16s instead of 7 and
    // the turn simply never ended. Measured: still on 'results' after 7.5s of
    // extra ticking, replay still going.
    //
    // At a stall that is not a cosmetic bug. Every second here is a second the
    // queue is not moving, and the whole reason RESULTS_SEC exists is that the
    // turn length has to be predictable.
    //
    // One loop, and the advance check below runs unconditionally.
    const t = ramp(this.stateTime, 0.5);
    const versus = this.playerCount === 2 && !this.config.partyMode;

    // BACKDROP FIRST, THEN THE REPLAY ON TOP OF IT.
    //
    // These were the other way round: the replay was rendered and then this
    // full-screen paper rect was painted straight over it, reaching full alpha
    // at 0.5s. So a replay was visible for half a second and then erased — and
    // because `showedReplay` also suppresses the results panel, what remained
    // for the rest of the clip was a blank sheet of paper. The one reward in
    // the app for a top-five run showed nothing at all.
    ctx.save();
    // Opaque paper, faded in by alpha on the whole layer rather than a
    // see-through fill — DESIGN.md forbids transparent colour.
    ctx.globalAlpha = t;
    ctx.fillStyle = COLORS.paper;
    ctx.fillRect(0, 0, v.width, v.height);
    ctx.globalAlpha = 1;
    ctx.restore();

    const replaying =
      highlights.isPlaying ||
      (this.stateTime < 0.2 && highlights.hasClip() && highlights.play(fc.now, 1));
    const showedReplay = replaying && highlights.render(fc);

    if (!showedReplay) {
      // Fade keyed to when the PANEL starts, not when results did. After a
      // replay finishes mid-window `stateTime` is already well past 0.5, so the
      // panel would otherwise snap in at full opacity with no entrance at all.
      if (this.panelStart < 0) this.panelStart = this.stateTime;
      const pt = ramp(this.stateTime - this.panelStart, 0.5);
      if (versus) this.drawVersusResults(fc, pt);
      else this.drawSoloResults(fc, pt);
    }

    // Nobody left to read it? Then stop holding the screen.
    this.resultsEmptyTime = this.players.length === 0 ? this.resultsEmptyTime + fc.dt : 0;
    const abandoned =
      this.stateTime >= RESULTS_ABANDONED_SEC && this.resultsEmptyTime >= RESULTS_EMPTY_GRACE_SEC;

    // Unconditional. Nothing drawn above may hold the queue up.
    if (this.stateTime > RESULTS_SEC || abandoned) {
      highlights.stop();
      this.finishRound();
    } else if (!showedReplay) {
      const remain = Math.ceil(RESULTS_SEC - this.stateTime);
      drawText(ctx, `NEXT PLAYER IN ${remain}`, v.width / 2, v.height * 0.93, {
        size: vh(v, 2),
        color: COLORS.muted,
        font: FONTS.mono,
        weight: 500,
        letterSpacing: '0.1em',
      });
    }
  }

  /**
   * End of the results screen. A score worth putting on the board goes to
   * initials entry; anything else loops straight back to waiting so the queue
   * never stalls behind a prompt nobody wants to answer.
   */
  private finishRound(): void {
    // In versus only the winner goes on the board. Two initials entries per
    // turn would double the slowest part of the flow, and the loser already
    // got the thing that mattered — losing in front of their friend.
    const best = this.results.reduce(
      (a, b) => (b.score > a.score ? b : a),
      this.results[0] ?? { slot: 0, score: 0, rank: null as never }
    );

    // A zero means they walked off or never engaged. Never make the next player
    // in the queue wait behind an entry prompt nobody wants to answer.
    if (best.score > 0 && router.has('initials')) {
      setPendingScore({
        gameId: this.config.gameId,
        score: best.score,
        next: router.firstAvailable('menu', 'attract') ?? this.config.gameId,
      });
      this.onExit?.('initials');
      return;
    }

    const next = router.firstAvailable('attract');
    if (next) this.onExit?.(next);
    else this.enter('waiting');
  }

  private drawSoloResults(fc: FrameContext, t: number): void {
    const { ctx, v } = fc;
    const r = this.results[0];
    if (!r) return;

    const pop = EASE.back(ramp(this.stateTime, 0.6));

    drawText(ctx, this.primaryLabel(), v.width / 2, v.height * 0.26, {
      size: vh(v, 2.6),
      color: COLORS.muted,
      font: FONTS.body,
      weight: 600,
      letterSpacing: '0.24em',
      alpha: t,
    });

    ctx.save();
    ctx.translate(v.width / 2, v.height * 0.42);
    ctx.scale(pop, pop);
    drawText(ctx, String(this.scores[0]?.value ?? r.score), 0, 0, {
      size: vh(v, 18),
      color: this.config.color,
      shadow: vh(v, SHADOW.lifted),
          });
    ctx.restore();

    if (this.stateTime > 0.8) {
      this.drawRankLine(fc, r.rank, v.height * 0.62);
    }
  }

  private drawVersusResults(fc: FrameContext, t: number): void {
    const { ctx, v } = fc;
    const a = this.results[0];
    const b = this.results[1];
    if (!a || !b) return;

    const winner = a.score === b.score ? -1 : a.score > b.score ? 0 : 1;
    const pop = EASE.back(ramp(this.stateTime, 0.6));

    for (let slot = 0; slot < 2; slot++) {
      const res = slot === 0 ? a : b;
      const cx = slot === 0 ? v.width * 0.27 : v.width * 0.73;
      const color = PLAYER_COLORS[slot]!;
      const won = winner === slot;

      drawText(ctx, `PLAYER ${slot + 1}`, cx, v.height * 0.26, {
        size: vh(v, 2.4),
        font: FONTS.body,
        weight: 600,
        letterSpacing: '0.2em',
        alpha: t,
        ...(won
          ? this.playerTextStyle(color, vh(v, SHADOW.base))
          : { color: COLORS.muted }),
      });

      ctx.save();
      ctx.translate(cx, v.height * 0.42);
      const s = won ? pop : pop * 0.82;
      ctx.scale(s, s);
      drawText(ctx, String(this.scores[slot]?.value ?? res.score), 0, 0, {
        size: vh(v, 14),
        color: won ? color : COLORS.muted,
        shadow: won ? vh(v, SHADOW.lifted) : 0,
              });
      ctx.restore();

      if (won && this.stateTime > 0.7) {
        drawText(ctx, '<WINNER>', cx, v.height * 0.58, {
          size: vh(v, 3.6),
          color: COLORS.ink,
          shadow: vh(v, SHADOW.base),
          shadowColor: COLORS.yellow,
          letterSpacing: '0.2em',
        });
      }
    }

    if (winner === -1 && this.stateTime > 0.7) {
      drawText(ctx, '<DEAD HEAT>', v.width / 2, v.height * 0.58, {
        size: vh(v, 3.6),
        color: COLORS.ink,
        shadow: vh(v, SHADOW.base),
        shadowColor: COLORS.yellow,
        letterSpacing: '0.2em',
      });
    }

    ctx.save();
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(v.width / 2, v.height * 0.2);
    ctx.lineTo(v.width / 2, v.height * 0.66);
    ctx.stroke();
    ctx.restore();

    const best = winner === 1 ? b : a;
    if (this.stateTime > 1) this.drawRankLine(fc, best.rank, v.height * 0.74);
  }

  /**
   * PLAN.md §4: "#4 TODAY — 2 OFF THIRD. That line sells more retries than the
   * score does."
   */
  private drawRankLine(fc: FrameContext, rank: RankResult, y: number): void {
    const { ctx, v } = fc;

    if (rank.isFirst) {
      // Nobody has played this game yet. "NEW RECORD" would be a lie, and
      // "#1 of 1" is joyless — being first is its own thing worth celebrating.
      const pulse = 0.75 + idlePulse(fc.time, 7, 1) * 0.25;
      drawText(ctx, '<FIRST ON THE BOARD>', v.width / 2, y, {
        size: vh(v, 4.6),
        color: COLORS.ink,
        alpha: pulse,
        letterSpacing: '0.04em',
        shadow: vh(v, SHADOW.base),
        shadowColor: COLORS.yellow,
      });
      return;
    }

    if (rank.isRecord) {
      const pulse = 0.75 + idlePulse(fc.time, 7, 1) * 0.25;
      // THE YELLOW RULE: yellow is a surface, never text on paper (1.7:1).
      // Ink letterforms with a yellow hard shadow keep the action colour
      // present without asking anyone to read #FBBC04 from 3m.
      drawText(ctx, '<NEW RECORD>', v.width / 2, y, {
        size: vh(v, 5.5),
        color: COLORS.ink,
        shadow: vh(v, SHADOW.lifted),
        shadowColor: COLORS.yellow,
        alpha: pulse,
        letterSpacing: '0.16em',
      });
      return;
    }

    if (rank.rank === null) {
      // OFF THE BOARD, BUT SAY BY HOW MUCH.
      //
      // This used to print a flat "NOT IN THE TOP 10 — N PLAYED" and return,
      // never looking at `pointsToNext`/`nextRank` — which `previewRank` has
      // already computed and which are non-null precisely here. So a player who
      // missed the board by ONE point and a player who missed it by four
      // hundred got the identical, deflating sentence.
      //
      // That matters more than it looks, because it only starts happening once
      // a board has ten entries — which for the queue eater is most of day one
      // and nearly all of day two. In other words the near-miss line, which
      // PLAN.md §2 stakes the entire design on ("near-misses are the addiction,
      // not wins"), was visible only during each game's first ten plays and
      // then switched itself off for the rest of the event.
      if (rank.pointsToNext !== null) {
        // A gap you could close on the next go is the whole point; say it
        // louder. Mirrors the `close` treatment on the live chase line.
        const near = rank.pointsToNext <= 10;
        drawText(ctx, `${rank.pointsToNext} OFF THE BOARD`, v.width / 2, y, {
          size: vh(v, near ? 5.4 : 4.4),
          color: COLORS.ink,
          shadow: vh(v, SHADOW.base),
          shadowColor: COLORS.yellow,
          letterSpacing: '0.1em',
        });
        drawText(ctx, `${rank.total} PLAYED`, v.width / 2, y + vh(v, 4.4), {
          size: vh(v, 2.2),
          color: COLORS.muted,
          font: FONTS.body,
          weight: 600,
          letterSpacing: '0.1em',
        });
        return;
      }

      drawText(ctx, `NOT IN THE TOP 10 — ${rank.total} PLAYED`, v.width / 2, y, {
        size: vh(v, 2.4),
        color: COLORS.muted,
        font: FONTS.body,
        weight: 600,
        letterSpacing: '0.1em',
      });
      return;
    }

    const ordinal = ['', 'FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH', 'NINTH', 'TENTH'];
    drawText(ctx, `#${rank.rank}`, v.width / 2, y, {
      size: vh(v, 6),
      color: this.config.color,
          });

    if (rank.pointsToNext !== null && rank.nextRank !== null) {
      drawText(
        ctx,
        `${rank.pointsToNext} OFF ${ordinal[rank.nextRank] ?? `#${rank.nextRank}`}`,
        v.width / 2,
        y + vh(v, 5),
        {
          size: vh(v, 2.8),
          color: COLORS.ink,
          shadow: vh(v, SHADOW.base),
          shadowColor: COLORS.yellow,
          font: FONTS.display,
          weight: 800,
          letterSpacing: '0.12em',
        }
      );
    }
  }

  /* ---------------- HUD ---------------- */

  protected slotRect(v: FrameContext['v'], slot: number): SlotRect {
    if (this.playerCount < 2) {
      return { x: 0, y: 0, width: v.width, height: v.height, centerX: v.width / 2 };
    }

    // Party games share one screen — there are no per-player columns to carve,
    // so every slot gets the full width and the game draws its own lanes.
    //
    // Previously this hardcoded two halves and returned the RIGHT half for every
    // slot >= 1. Invisible today only because Red Light's primaryStat ignores
    // the slot and redraws an identical string on top of itself six times; the
    // moment a 3+ player game drew anything slot-specific it would have stacked
    // unreadable garbage in one spot.
    if (this.config.partyMode) {
      return { x: 0, y: 0, width: v.width, height: v.height, centerX: v.width / 2 };
    }

    const half = v.width / 2;
    const x = slot === 0 ? 0 : half;
    return { x, y: 0, width: half, height: v.height, centerX: x + half / 2 };
  }

  /**
   * Bottom of the HUD band, in logical px. Nothing that rises may start above
   * this. The band is: timer (3vh), clock (7.5), score (16), label (23),
   * chase line (26) — so 30 clears it with a margin.
   */
  protected hudBottom(v: FrameContext['v']): number {
    return vh(v, this.hudMetrics().bottom);
  }

  private hudMetrics(): HudMetrics {
    return this.config.hudShelf ? HUD_SHELF : HUD_FULL;
  }

  /**
   * A player's identity colour, made safe for LETTERFORMS on paper.
   *
   * `PLAYER_COLORS[0]` is yellow, which is 1.7:1 on paper — the brand kit's
   * one hard colour rule, and simply gone at 3m. Every versus game routes its
   * score through here, so in a two-player round player one's score was yellow
   * text on white: the single most important number on their half of the
   * screen, invisible from the queue. The versus results screen had it too, on
   * the WINNER's name specifically, since the loser's is muted.
   *
   * The fix is the brand's own, already used on the record-pace line below:
   * ink letterforms with the identity colour as the hard shadow. Legibility
   * comes from ink, identity survives in the shadow, and nothing turns into a
   * generic black number. Colours that already pass (blue, green, red, ink)
   * are returned untouched with the default ink shadow.
   */
  private playerTextStyle(
    preferred: string,
    shadow: number
  ): { color: string; shadow: number; shadowColor?: string } {
    const safe = textColor(preferred);
    // The shadow is what carries the identity in the fallback case, so it is
    // NOT optional here — `drawText` skips the shadow pass entirely when the
    // offset is absent, which would have left a plain ink number.
    return safe === preferred
      ? { color: safe, shadow }
      : { color: safe, shadow, shadowColor: preferred };
  }

  private drawHud(fc: FrameContext): void {
    const { ctx, v } = fc;
    const m = this.hudMetrics();
    // Keep rising popups out of the HUD. One assignment per frame here beats
    // every game remembering the arithmetic at every spawn site.
    this.popups.floorY = this.hudBottom(v);

    // The shelf, if this game asked for one. Paper plate, then the same grid
    // the background uses clipped into it — so the band reads as the SAME
    // surface as the rest of the screen with the playfield passing behind it,
    // not as a grey box someone dropped on top. Hard ink rule, no blur: the
    // edge is what sells "in front".
    if (this.config.hudShelf) {
      const y = vh(v, m.bottom);
      ctx.save();
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.rect(0, 0, v.width, y);
      ctx.clip();
      graphPaper(ctx, v);
      ctx.restore();

      ctx.save();
      ctx.shadowBlur = 0;
      ctx.fillStyle = COLORS.ink;
      ctx.fillRect(0, y, v.width, Math.max(2, vh(v, STROKE.thick)));
      ctx.restore();
    }

    // Timer across the very top — visible from anywhere in the queue.
    const t = this.timeLeft / this.config.roundSeconds;
    const barH = vh(v, m.barH);
    const urgent = this.timeLeft <= 5;
    progressBar(
      ctx, vh(v, 3), vh(v, m.barY), v.width - vh(v, 6), barH,
      t, urgent ? COLORS.red : this.config.color, urgent ? 22 : 12
    );

    drawText(
      ctx,
      this.timeLeft.toFixed(1),
      m.inlineRow ? vh(v, 3) : v.width / 2,
      vh(v, m.clockY),
      {
        size: vh(v, m.clockSize),
        color: urgent ? COLORS.red : COLORS.muted,
        font: FONTS.mono,
        weight: 700,
        align: m.inlineRow ? 'left' : 'center',
      }
    );

    // Party games have one shared HUD, not one per player.
    const hudSlots = this.config.partyMode ? 1 : this.playerCount;
    for (let slot = 0; slot < hudSlots; slot++) {
      const rect = this.slotRect(v, slot);
      const color = this.playerCount > 1 ? PLAYER_COLORS[slot]! : this.config.color;

      drawText(ctx, this.primaryStat(slot), rect.centerX, vh(v, m.statY), {
        size: vh(v, m.statSize),
        // Balloon Pop's balloons stay poppable above the shoulder line, so they
        // rise straight through this band and cannot be culled. Free on paper.
        knockout: true,
        ...this.playerTextStyle(color, vh(v, SHADOW.base)),
      });
      drawText(ctx, this.primaryLabel(), rect.centerX, vh(v, m.labelY), {
        size: vh(v, m.labelSize),
        knockout: true,
        color: COLORS.muted,
        font: FONTS.body,
        weight: 600,
        letterSpacing: '0.24em',
      });

      this.drawChaseLine(fc, slot, rect);
      this.onRenderHud?.(fc, slot, rect);
    }

    if (this.playerCount === 2) {
      ctx.save();
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 2;
      ctx.setLineDash([12, 10]);
      ctx.beginPath();
      ctx.moveTo(v.width / 2, vh(v, this.config.hudShelf ? m.bottom : 10));
      ctx.lineTo(v.width / 2, v.height);
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * The live "what you're chasing" line, shown DURING play.
   *
   * PLAN.md §2: "The score to beat is on screen during play. Near-misses are
   * the addiction, not wins." A rank revealed only at the end tells you how you
   * did; a target visible while you play is what makes someone push in the last
   * five seconds, and what makes them step straight back on afterwards.
   *
   * Every game gets this for free, so none of them has to remember to do it.
   */
  private drawChaseLine(fc: FrameContext, slot: number, rect: SlotRect): void {
    const { ctx, v } = fc;
    const m = this.hudMetrics();
    const chase = (size: number): number => vh(v, size * m.chaseScale);
    // Flush to the slot's right edge in a row layout, centred otherwise.
    const chaseX = m.inlineRow ? rect.x + rect.width - vh(v, 3) : rect.centerX;
    const chaseAlign = m.inlineRow ? ('right' as const) : ('center' as const);
    const score = this.scoreFor(slot);

    if (this.config.partyMode) return;

    // In versus the opponent IS the target — a leaderboard line would just be
    // noise next to the person standing beside you.
    if (this.playerCount === 2) {
      const other = this.scoreFor(slot === 0 ? 1 : 0);
      const diff = score - other;
      if (diff === 0) return;
      drawText(ctx, diff > 0 ? `LEADING BY ${diff}` : `DOWN BY ${-diff}`, chaseX, vh(v, m.chaseY), {
        size: chase(2.2),
        align: chaseAlign,
        color: diff > 0 ? COLORS.green : COLORS.red,
        font: FONTS.body,
        weight: 700,
        letterSpacing: '0.1em',
      });
      return;
    }

    // A ghost beats a leaderboard line: "3 AHEAD OF YOUR BEST" is a race you
    // can see, where "12 TO #4" is an abstraction.
    //
    // UNTIL IT DOESN'T. This branch ran unconditionally whenever a ghost had
    // loaded, so a player having an off round against a strong personal best
    // watched "106 BEHIND BEST" in red for a minute while an entirely reachable
    // "1 TO #3" sat uncalled on the leaderboard beside it. A race you have
    // visibly lost is the opposite of a chase line.
    //
    // Once the gap is out of reach the ghost line is retired for the rest of
    // the round and the board takes over.
    if (this.ghost && !this.ghostRaceLost) {
      const target = this.ghost.scoreAt(this.config.roundSeconds - this.timeLeft);
      const diff = score - target;
      const ahead = diff >= 0;

      if (!ahead && -diff > Math.max(8, target * 0.45)) {
        this.ghostRaceLost = true;
      }
    }

    if (this.ghost && !this.ghostRaceLost) {
      const target = this.ghost.scoreAt(this.config.roundSeconds - this.timeLeft);
      const diff = score - target;
      const ahead = diff >= 0;
      drawText(
        ctx,
        ahead ? `${diff} AHEAD OF BEST` : `${-diff} BEHIND BEST`,
        chaseX,
        vh(v, m.chaseY),
        {
          size: chase(2.3),
          align: chaseAlign,
          color: ahead ? COLORS.green : COLORS.red,
          font: FONTS.body,
          weight: 700,
          letterSpacing: '0.1em',
        }
      );
      return;
    }

    const preview = leaderboard.previewRank(this.config.gameId, score);

    if (preview.isRecord && score > 0) {
      const pulse = 0.7 + idlePulse(fc.time, 8, 1) * 0.3;
      drawText(ctx, '<RECORD PACE>', chaseX, vh(v, m.chaseY), {
        size: chase(2.4),
        align: chaseAlign,
        color: COLORS.ink,
        shadow: vh(v, SHADOW.base),
        shadowColor: COLORS.yellow,
        alpha: pulse,
        letterSpacing: '0.14em',
      });
      return;
    }

    // NOTHING TO CHASE YET. On a virgin board `previewRank` has no next rank to
    // report, and this returned silently — leaving the reserved chase slot
    // empty for exactly the first players of the day, who are the ones with
    // least idea what the game wants from them. Name the prize instead.
    if (preview.pointsToNext === null || preview.nextRank === null) {
      drawText(ctx, '<SET THE FIRST SCORE>', chaseX, vh(v, m.chaseY), {
        size: chase(2.2),
        align: chaseAlign,
        color: COLORS.muted,
        font: FONTS.body,
        weight: 700,
        letterSpacing: '0.1em',
      });
      return;
    }

    // Closing in is the moment worth selling — brighten as the gap narrows.
    const close = preview.pointsToNext <= 5;
    drawText(
      ctx,
      `${preview.pointsToNext} TO #${preview.nextRank}`,
      chaseX,
      vh(v, m.chaseY),
      {
        size: chase(close ? 2.6 : 2.2),
        align: chaseAlign,
        color: close ? COLORS.ink : COLORS.muted,
        font: FONTS.body,
        weight: 700,
        letterSpacing: '0.1em',
      }
    );
  }

  /** Small helper subclasses use for "beat this" markers. */
  protected drawTargetMarker(fc: FrameContext, x: number, y: number, label: string): void {
    const { ctx, v } = fc;
    const w = vh(v, 18);
    const h = vh(v, 3.2);
    ctx.save();
    // Sticker, not a tint: hard ink shadow, flat yellow fill, ink outline.
    // Flat yellow can't carry text on paper (too low contrast at 3m), so the
    // yellow is the SURFACE and the label on it is ink.
    ctx.fillStyle = COLORS.ink;
    roundRect(ctx, x - w / 2, y - h / 2 + vh(v, SHADOW.base), w, h, vh(v, 0.8));
    ctx.fill();
    ctx.fillStyle = COLORS.yellow;
    roundRect(ctx, x - w / 2, y - h / 2, w, h, vh(v, 0.8));
    ctx.fill();
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = vh(v, 0.3);
    ctx.stroke();
    ctx.restore();
    drawText(ctx, label, x, y, {
      size: vh(v, 1.9),
      color: COLORS.ink,
      font: FONTS.display,
      weight: 800,
    });
  }

  protected celebrateAt(x: number, y: number): void {
    BURST.celebrate(this.particles, x, y, [COLORS.blue, COLORS.red, COLORS.yellow, COLORS.green]);
  }
}

export interface SlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
}
