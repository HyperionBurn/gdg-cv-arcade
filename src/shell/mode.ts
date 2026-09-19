/**
 * "How many playing?" — one screen, two cards, between the menu and the game.
 *
 * WHY IT EXISTS, given the machine can already count. Everything about the
 * number of players is detected: the menu tiles carry a seat badge, the
 * waiting screen names the capacity, the countdown re-resolves the roster
 * every frame and invites a late friend in. Two people who step up together
 * get a versus round with no decision to make.
 *
 * The one thing the camera cannot know is INTENT. Two friends stand side by
 * side, one wants a solo run for the board, the other is watching from inside
 * the play zone — that is a versus round to the tracker and a ruined turn to
 * them, and the only fix available today is folklore ("step back off the
 * tape") that nothing on screen ever says. See `meta/mode.ts`.
 *
 * SO IT ASKS ONE QUESTION AND IT ASKS IT CHEAPLY.
 *
 *  - Two cards, each a third of the screen wide. The whole reason a mis-select
 *    costs so much on the menu is seven small targets; two enormous ones are
 *    the easiest dwell in the app, so this runs at the FAST dwell rather than
 *    the deliberate one.
 *  - It answers itself. `DEFAULT_SEC` of no decision takes the open option —
 *    which is what the machine would have done anyway — so a confused player
 *    or an empty room costs the queue a fixed, small amount and never stalls.
 *  - It never appears for a game that cannot do both. There is no such game
 *    today, and if one lands the screen must not offer a choice of one.
 *
 * The vocabulary is per game, because "multiplayer" means different things on
 * a split screen and in a six-lane race, and a screen that says the wrong one
 * is worse than no screen.
 */

import { isSimEnabled } from '../core/simulator';
import { PoseTracker, type TrackedPlayer } from '../core/tracker';
import { vision } from '../core/vision';
import { camera } from '../core/camera';
import { audio } from '../engine/audio';
import {
  decorShape,
  drawText,
  fitText,
  graphPaper,
  roundRect,
  stickerCard,
  transition,
  vh,
  wipe,
} from '../engine/draw';
import { Projection } from '../engine/projection';
import { drawPose, SKELETON_STYLES } from '../engine/skeleton';
import {
  COLORS,
  DUR,
  EASE,
  FONTS,
  RADIUS,
  SAFE,
  SHADOW,
  STROKE,
  TRACK,
  TYPE,
  WEIGHT,
  dur,
  ramp,
} from './theme';
import { GAME_SEATS, gameColor } from '../meta/games';
import { setPlayMode, type PlayMode } from '../meta/mode';
import { MENU_TILES } from './menu';
import { tournament } from '../meta/tournament';
import type { GameId } from '../meta/leaderboard';
import { DWELL, HoverCursor, type HoverTarget } from './hover';
import { router } from './router';
import type { FrameContext, Screen } from './screen';

/* ------------------------------------------------------------------ */
/* Handoff                                                             */
/* ------------------------------------------------------------------ */

let pendingGame: GameId | null = null;

/** Called by the menu before routing here. */
export function setPendingGame(id: GameId): void {
  pendingGame = id;
}

export function takePendingGame(): GameId | null {
  const g = pendingGame;
  pendingGame = null;
  return g;
}

/**
 * Does this game have a question worth asking?
 *
 * A one-seat game does not, and a screen that offers a choice of one is worse
 * than no screen at all — it is a delay dressed as agency.
 */
export function modeScreenApplies(id: GameId): boolean {
  // NEITHER DOES A BRACKET MATCH. A tournament match is by definition a versus
  // round: the marshal has called two names, the crowd is watching, and the
  // bracket only advances from a `playerCount === 2` round. Asking the pair how
  // many are playing is a delay in front of an audience AND a way to break the
  // bracket — one hover on JUST ME and the match is played, won, and silently
  // not reported, with no diagnosis available short of reading the source.
  if (tournament.active && tournament.game === id) return false;
  return (GAME_SEATS[id] ?? 1) > 1;
}

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/**
 * Seconds before the screen answers itself with the open option.
 *
 * THIS IS A THROUGHPUT CEILING, NOT A PACE. The screen costs every turn
 * whatever a player spends on it, so the worst case has to be small and fixed.
 * 5s is two comfortable dwells plus the time to read six words, and a player
 * who is still deciding after that gets the mode the machine would have picked
 * for them anyway — which is the SAME outcome, just without the wait.
 */
const DEFAULT_SEC = 5;

/** Nobody in frame for this long and there is nothing to decide. */
const ABANDONED_SEC = 2.5;

/** Same figure as `GameBase`; see the guard in `updateTracking`. */
const VISION_STALE_MS = 1500;

interface Choice {
  mode: PlayMode;
  title: string;
  blurb: string;
}

/**
 * The words, per game shape.
 *
 * "MULTIPLAYER" and "VERSUS" are not synonyms here: a split screen is two
 * people racing each other and a six-lane Red Light is a group surviving
 * together. Using one word for both would make one of the two screens lie.
 */
function choicesFor(id: GameId): [Choice, Choice] {
  const seats = GAME_SEATS[id] ?? 2;
  // SHORT ENOUGH NOT TO BE SHRUNK. `fitText` scales a long line down to fit
  // the card, and the whole reason the menu blurb is held at 2.4vh is that
  // shrink-to-fit is how the most important sentence on a screen ends up
  // unreadable from three metres. Four words each, so nothing has to shrink.
  const solo: Choice = { mode: 'solo', title: 'JUST ME', blurb: 'ONE PLAYER, ONE SCORE' };
  if (seats > 2) {
    return [solo, { mode: 'open', title: 'ALL OF US', blurb: `UP TO ${seats} IN ONE RACE` }];
  }
  return [solo, { mode: 'open', title: 'VERSUS', blurb: 'SPLIT SCREEN, ONE WINNER' }];
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

export class ModeScreen implements Screen {
  readonly id = 'mode';
  onExit?: (next: string) => void;

  /** Public so the dev harness can drive it, exactly like the menu's. */
  readonly cursor = new HoverCursor(DWELL.fast);

  private tracker = new PoseTracker({ maxPlayers: 1, mirrored: true, filterPreset: 'cosmetic' });
  private proj: Projection | null = null;
  private player: TrackedPlayer | null = null;

  private targets: HoverTarget[] = [];
  private lastFrameId = -1;
  private enterTime = 0;
  private elapsed = 0;
  private awayTime = 0;

  private game: GameId = 'sixtyseven';
  private choices: [Choice, Choice] = choicesFor('sixtyseven');
  private chosen: PlayMode | null = null;

  /** See the note on AttractScreen.exiting — the router cannot fade for us. */
  private exiting: string | null = null;
  private exitTime = 0;

  async mount(): Promise<void> {
    audio.init();
    const handoff = takePendingGame();
    if (handoff) this.game = handoff;
    this.choices = choicesFor(this.game);

    if (!isSimEnabled()) {
      await vision.start({ mode: 'pose', numPoses: 1, poseModel: 'lite' });
    }
  }

  render(fc: FrameContext): void {
    const { ctx, v } = fc;
    if (this.enterTime === 0) this.enterTime = fc.time;
    this.elapsed += fc.dt;

    this.updateTracking(fc);
    this.layout(fc);

    graphPaper(ctx, v);
    this.drawDecor(fc);
    this.drawBackdrop(fc);

    const state = this.cursor.update(fc, this.chosen ? null : this.player, this.targets);
    if (state.committed) this.commit(state.committed);

    // THE SCREEN ANSWERS ITSELF. Two ways off it that do not need a decision:
    // nobody is there, or nobody has decided. Both take the open option, which
    // is what the machine would have done without this screen at all — so the
    // failure mode of asking is never worse than not asking.
    this.awayTime = this.player ? 0 : this.awayTime + fc.dt;
    if (!this.chosen && (this.elapsed >= DEFAULT_SEC || this.awayTime >= ABANDONED_SEC)) {
      this.choose('open', false);
    }

    this.drawHeader(fc);
    this.drawCards(fc, state.hovered, state.progress);
    this.cursor.draw(fc);
    this.drawDeadline(fc);

    const span = dur(DUR.base);
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

  unmount(): void {
    this.cursor.reset();
  }

  /* ---------------- choosing ---------------- */

  private commit(id: string): void {
    const choice = this.choices.find((c) => `mode:${c.mode}` === id);
    if (choice) this.choose(choice.mode, true);
  }

  private choose(mode: PlayMode, deliberate: boolean): void {
    if (this.chosen) return;
    this.chosen = mode;
    setPlayMode(mode);
    if (deliberate) audio.play('select', mode === 'solo' ? 0.9 : 1.15);

    // Straight out. There is no payoff to show here and the player has already
    // been told what they picked by the card lighting up under their hand.
    this.leave(router.has(this.game) ? this.game : 'menu');
  }

  private leave(next: string): void {
    if (this.exiting) return;
    this.exiting = next;
    this.exitTime = 0;
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

    // Stale vision means nobody — same guard as the menu and `GameBase`. A
    // wedged worker would otherwise leave a frozen body here forever, and the
    // abandon timer is the only exit that does not need a decision.
    if (fc.vision && fc.now - fc.vision.captureTime > VISION_STALE_MS) {
      if (this.player) {
        this.player = null;
        this.tracker.reset();
      }
      return;
    }

    if (!fc.vision || fc.vision.frameId === this.lastFrameId) return;
    this.lastFrameId = fc.vision.frameId;
    this.tracker.update(fc.vision.poses, fc.time);
    this.player = this.tracker.getPrimary();
  }

  /* ---------------- layout ---------------- */

  private layout(fc: FrameContext): void {
    const { v } = fc;
    this.targets = [];

    const top = vh(v, 30);
    const h = vh(v, 44);
    // A third of the width each, with a gutter far wider than the menu's. Two
    // targets this big cannot be mis-selected, which is why they take the fast
    // dwell: the cost of a wrong pick here is one hover of the other card.
    const w = Math.min(vh(v, 52), v.width * 0.34);
    const gap = Math.min(vh(v, 8), v.width * 0.06);
    const left = (v.width - (w * 2 + gap)) / 2;

    for (let i = 0; i < this.choices.length; i++) {
      this.targets.push({
        id: `mode:${this.choices[i]!.mode}`,
        x: left + i * (w + gap),
        y: top,
        w,
        h,
        dwell: DWELL.fast,
      });
    }
  }

  /* ---------------- drawing ---------------- */

  private drawBackdrop(fc: FrameContext): void {
    const { ctx, v } = fc;
    // The same live skeleton the menu uses, for the same reason: it is what
    // makes the hand cursor comprehensible without a word of instruction.
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

  private drawDecor(fc: FrameContext): void {
    const { ctx, v } = fc;
    decorShape(ctx, 'circle', v.width * 0.04, v.height * 0.1, vh(v, 2.2), COLORS.yellow, 0);
    decorShape(ctx, 'triangle', v.width * 0.96, v.height * 0.11, vh(v, 2.6), COLORS.green, 11);
    decorShape(ctx, 'blob', v.width * 0.05, v.height * 0.93, vh(v, 2.6), COLORS.blue, -8);
    decorShape(ctx, 'halfCircle', v.width * 0.95, v.height * 0.93, vh(v, 2.4), COLORS.red, 6);
  }

  private drawHeader(fc: FrameContext): void {
    const { ctx, v } = fc;
    const t = EASE.out(ramp(fc.time - this.enterTime, DUR.base));
    const tile = MENU_TILES.find((x) => x.id === this.game);
    const title = '<HOW MANY PLAYING?>';

    drawText(ctx, tile?.title ?? this.game.toUpperCase(), v.width / 2, vh(v, 10), {
      size: vh(v, TYPE.label),
      color: gameColor(this.game),
      font: FONTS.body,
      weight: WEIGHT.bold,
      knockout: true,
      letterSpacing: '0.3em',
      alpha: t,
    });
    drawText(ctx, title, v.width / 2, vh(v, 17), {
      size: fitText(ctx, title, v.width - vh(v, SAFE * 2), vh(v, TYPE.title)),
      color: COLORS.ink,
      weight: WEIGHT.black,
      // Ink glyphs take a PAPER KNOCKOUT and never an ink shadow — the shadow
      // is the same word filled again one offset down, which reads as doubled.
      knockout: true,
      letterSpacing: TRACK.h1,
      alpha: t,
    });
    drawText(ctx, 'HOLD YOUR HAND OVER ONE', v.width / 2, vh(v, 23.6), {
      size: vh(v, TYPE.label),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: '0.24em',
      alpha: t,
    });
  }

  private drawCards(fc: FrameContext, hovered: string | null, progress: number): void {
    const { ctx, v } = fc;
    const radius = vh(v, RADIUS.card);
    const accent = gameColor(this.game);

    for (const target of this.targets) {
      const choice = this.choices.find((c) => `mode:${c.mode}` === target.id);
      if (!choice) continue;

      const isHovered = hovered === target.id;
      const picked = this.chosen === choice.mode;
      // Same lift the menu tiles use — real geometry rather than a colour
      // change, which is what survives being read from the back of a queue.
      const lift = picked ? vh(v, SHADOW.base) : isHovered ? -vh(v, 0.9) : 0;
      const drop = picked ? 0 : isHovered ? vh(v, SHADOW.lifted + 0.9) : vh(v, SHADOW.base);
      const ty = target.y + lift;

      stickerCard(ctx, v, target.x, ty, target.w, target.h, {
        fill: COLORS.paper,
        outline: COLORS.ink,
        outlineWidth: vh(v, isHovered || picked ? STROKE.thick : STROKE.base),
        shadow: drop,
        shadowColor: COLORS.ink,
      });

      // Accent bar in the GAME's colour, so the screen is visibly still about
      // the thing they just chose rather than a new place they have arrived.
      ctx.save();
      roundRect(ctx, target.x, ty, target.w, target.h, radius);
      ctx.clip();
      ctx.fillStyle = accent;
      ctx.fillRect(target.x, ty, target.w, vh(v, 1.6));

      // Dwell fill: a flat yellow wash left to right, the menu's treatment.
      const fill = picked ? 1 : isHovered ? progress : 0;
      if (fill > 0) {
        ctx.fillStyle = COLORS.yellow;
        ctx.fillRect(target.x, ty, target.w * Math.min(1, fill), target.h);
      }
      ctx.restore();

      ctx.save();
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = vh(v, isHovered || picked ? STROKE.thick : STROKE.base);
      roundRect(ctx, target.x, ty, target.w, target.h, radius);
      ctx.stroke();
      ctx.restore();

      const cx = target.x + target.w / 2;
      const inner = target.w - vh(v, 6);

      drawText(ctx, choice.title, cx, ty + target.h * 0.4, {
        size: fitText(ctx, choice.title, inner, vh(v, 6.4)),
        color: COLORS.ink,
        weight: WEIGHT.black,
        letterSpacing: TRACK.h2,
      });
      drawText(ctx, choice.blurb, cx, ty + target.h * 0.62, {
        size: fitText(ctx, choice.blurb, inner, vh(v, 2.6), WEIGHT.medium, FONTS.body),
        color: COLORS.ink,
        font: FONTS.body,
        weight: WEIGHT.medium,
        letterSpacing: TRACK.body,
      });
    }
  }

  /**
   * The self-answer clock, shown only once it is close.
   *
   * A bar counting down from the first frame would read as pressure on a
   * screen whose whole point is that there is no pressure — the default is the
   * same thing the machine would have done. It appears with about a second and
   * a half to go, which is long enough to register and too short to rush.
   */
  private drawDeadline(fc: FrameContext): void {
    const { ctx, v } = fc;
    if (this.chosen) return;
    const remain = DEFAULT_SEC - this.elapsed;
    if (remain > 1.6) return;

    drawText(ctx, `<${this.choices[1].title} IN ${Math.max(1, Math.ceil(remain))}>`, v.width / 2, vh(v, 82), {
      size: vh(v, 2.4),
      color: COLORS.ink,
      font: FONTS.mono,
      weight: WEIGHT.bold,
      letterSpacing: '0.1em',
    });
  }
}
