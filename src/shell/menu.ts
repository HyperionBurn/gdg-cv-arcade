/**
 * Game menu. Hand-hover tiles, one per game.
 *
 * PLAN.md §6: "Hand-hover menu — dwell 1.2s. No keyboard, no mouse, no
 * operator handoff." PLAN.md §1: "someone walking past must understand the
 * game, without reading anything, before they reach the end of the table" —
 * which is why every tile carries a one-line description that fully explains
 * the mechanic, not a clever name on its own.
 *
 * The record holder sits on the tile deliberately. "the thing to beat is
 * visible during play, not only at the end" (ARCHITECTURE.md) starts here:
 * people choose the game where they think they can take the top spot.
 */

import { isSimEnabled } from '../core/simulator';
import { PoseTracker, type TrackedPlayer } from '../core/tracker';
import { vision } from '../core/vision';
import { camera } from '../core/camera';
import { audio } from '../engine/audio';
import { noteMenuTimeout } from './attract';
import {
  decorShape,
  drawTabularNumber,
  drawText,
  fitText,
  graphPaper,
  labelPill,
  measureTabularNumber,
  measureText,
  roundRect,
  stickerCard,
  transition,
  vh,
  wipe,
  wrapText,
} from '../engine/draw';
import { Projection } from '../engine/projection';
import { drawPose, SKELETON_STYLES } from '../engine/skeleton';
import { ParticleSystem, BURST } from '../engine/particles';
import { leaderboard, type GameId } from '../meta/leaderboard';
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
  idlePulse,
  ramp,
} from './theme';
import { GAME_COLORS } from '../meta/games';
import { DWELL, HoverCursor, type HoverTarget } from './hover';
import { router } from './router';
import type { FrameContext, Screen } from './screen';

export interface MenuTile {
  id: GameId;
  title: string;
  /** One line that explains the whole game. Not a tagline — an explanation. */
  blurb: string;
  color: string;
  /**
   * Feature flag. PLAN.md §3: "Feature-flag every game. Core 3 must stand
   * alone." Set false to pull a game on the day without touching anything
   * else — it goes grey and stops being selectable.
   *
   * This is NOT "is it written yet". That is answered by `isTileAvailable`,
   * which asks the router whether the screen is actually registered, so a tile
   * lights up the moment its game is wired in and can never route to a screen
   * that does not exist.
   */
  enabled: boolean;
}

/**
 * The roster from PLAN.md §3, in stall order: the core 3 first, because those
 * are the ones that must work and the ones the hype person will be pointing
 * at. Ids must match the `GameId` union in meta/leaderboard.ts.
 */
export const MENU_TILES: readonly MenuTile[] = [
  {
    id: 'sixtyseven',
    title: '67 SPEED DUEL',
    blurb: 'PUMP BOTH ARMS AS FAST AS YOU CAN',
    color: GAME_COLORS.sixtyseven,
    enabled: true,
  },
  {
    id: 'fruitninja',
    title: 'FRUIT NINJA',
    blurb: 'SWIPE YOUR HANDS TO SLICE',
    color: GAME_COLORS.fruitninja,
    enabled: true,
  },
  {
    id: 'redlight',
    title: 'RED LIGHT',
    blurb: 'MOVE ON GREEN, FREEZE ON RED',
    color: GAME_COLORS.redlight,
    enabled: true,
  },
  {
    id: 'runner',
    title: 'NEON RUNNER',
    blurb: 'STEP, JUMP AND DUCK DOWN THE TRACK',
    color: GAME_COLORS.runner,
    enabled: true,
  },
  {
    id: 'posematch',
    title: 'HOLE IN THE WALL',
    blurb: 'MATCH THE SHAPE BEFORE IT HITS YOU',
    color: GAME_COLORS.posematch,
    enabled: true,
  },
  {
    id: 'rhythm',
    title: 'RHYTHM PUNCH',
    blurb: 'PUNCH THE TARGETS ON THE BEAT',
    color: GAME_COLORS.rhythm,
    enabled: true,
  },
  {
    id: 'balloonpop',
    title: 'BALLOON POP',
    blurb: 'POP THE BALLOONS WITH YOUR HANDS',
    color: GAME_COLORS.balloonpop,
    enabled: true,
  },
];

/**
 * Is this game actually playable right now?
 *
 * Asks the router, not a hand-maintained boolean. Games are landing one at a
 * time and main.ts owns registration (ARCHITECTURE.md, "do not touch"), so the
 * register call is the single source of truth: a tile lights up the moment its
 * game is wired in, and the menu can never route to a screen that does not
 * exist and leave the stall staring at an unresponsive tile.
 */
export function isTileAvailable(tile: MenuTile): boolean {
  return tile.enabled && router.list().includes(tile.id);
}

/** PLAN.md §6: "Idle timeout back to attract after 20s." */
const IDLE_TIMEOUT_SEC = 20;
/**
 * Seconds a tracked body may stand here without ever raising a hand.
 *
 * `idleTime` only counts ABSENCE, so someone standing in frame with their arms
 * down reset it every frame and the menu had no exit at all: measured at a full
 * 60 simulated seconds with a player present and motionless, `idleTime` pinned
 * at 0 the whole way. Attract forces a decision after 6s of non-compliant
 * presence and initials has a 16s hard deadline; this was the one screen a
 * confused person could occupy indefinitely with a queue behind them.
 *
 * Bailing to attract rather than picking something for them is deliberate:
 * attract is the screen that TEACHES the gesture, with the big step-in prompt
 * and the live skeleton. Someone who has not worked out how to point at a tile
 * needs that, not a game they did not choose.
 *
 * Generous on purpose — seven tiles is a real decision, and reading them from
 * 3m takes a while.
 */
const PRESENCE_STALL_SEC = 32;

/**
 * Absolute ceiling on one visit to this screen, regardless of presence.
 *
 * PRESENCE_STALL_SEC above closed the arms-DOWN case and left the arms-UP one
 * open, which is the more common way a stranger stalls: hand raised, waving at
 * the screen, moving too much to ever complete a 1.2s dwell. Every frame of
 * that resets `idleTime` (a player is present) AND `stalledTime` (a wrist is
 * raised), so both timers sit at zero and the screen can be occupied
 * indefinitely with a queue behind it — the exact failure PRESENCE_STALL_SEC's
 * comment claims was fixed.
 *
 * 75s is well past any honest decision: the two timers above are 20s and 32s,
 * and a person who genuinely wants to play has committed a tile long before
 * this. It only ever fires on someone who is stuck, and bailing to attract is
 * the right answer for them too — attract is the screen that teaches the
 * gesture.
 */
const MENU_HARD_CAP_SEC = 75;

/**
 * Age at which a vision frame stops counting as evidence that anyone is there.
 * Same figure as `GameBase`; see the guard in `updateTracking`.
 */
const VISION_STALE_MS = 1500;

/** Tiles per row, top row first. 4 + 3 keeps every tile large and centred. */
const ROW_SIZES = [4, 3] as const;

/**
 * Tile top and bottom, in vh. Fixed rather than derived from width, so the
 * internal layout below lands identically at 16:9, 4:3 and 21:9 — only the
 * tile WIDTH changes with aspect, and every text run is fitted to it.
 */
const GRID_TOP = 22;
const GRID_BOTTOM = 87;

/**
 * Vertical positions inside a tile, in vh from its top edge.
 *
 * Named and absolute rather than fractions of the tile height. Fractions were
 * leaving a dead band in the middle of every tile and crowding the record
 * against the bottom edge, because the pleasant proportion at one tile height
 * is not the pleasant proportion at another.
 */
const TILE = {
  accentH: 1.6,
  title: 8.8,
  blurb: 14.8,
  rule: 20,
  recordLabel: 23.6,
  recordValue: 27.6,
  badgeCy: 25.4,
  badgeH: 5.6,
} as const;

/** Flat decorative shapes, well clear of the grid and of every text run. */
const DECOR: Array<{ kind: 'triangle' | 'circle' | 'blob' | 'halfCircle'; x: number; y: number; r: number; c: string; tilt: number }> = [
  { kind: 'circle', x: 0.035, y: 0.09, r: 2.2, c: COLORS.yellow, tilt: 0 },
  { kind: 'triangle', x: 0.963, y: 0.1, r: 2.6, c: COLORS.green, tilt: 11 },
  { kind: 'blob', x: 0.05, y: 0.95, r: 2.6, c: COLORS.blue, tilt: -8 },
  { kind: 'halfCircle', x: 0.95, y: 0.95, r: 2.4, c: COLORS.red, tilt: 6 },
];

/**
 * Playable games first, then anything flagged COMING SOON.
 *
 * A dead tile in the middle of the grid is a hole a player's eye falls into,
 * and the middle of row two is the single most looked-at cell after the first.
 * Unavailable games keep their place in `MENU_TILES` — the id order is the
 * leaderboard rail's cycle order — and are only moved for layout.
 */
function tilesInDisplayOrder(): MenuTile[] {
  const live: MenuTile[] = [];
  const soon: MenuTile[] = [];
  for (const t of MENU_TILES) (isTileAvailable(t) ? live : soon).push(t);
  return [...live, ...soon];
}

/** Wrap every tile's blurb at one shared size. Used twice: measure, then fit. */
function wrapAll(
  ctx: CanvasRenderingContext2D,
  size: number,
  inner: number
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of MENU_TILES) {
    out.set(t.id, wrapText(ctx, t.blurb, inner, size, WEIGHT.medium, FONTS.body, 2));
  }
  return out;
}

export class MenuScreen implements Screen {
  readonly id = 'menu';
  onExit?: (next: string) => void;

  /** Public so the dev console and the future operator panel can drive it. */
  readonly cursor = new HoverCursor(DWELL.deliberate);

  private tracker = new PoseTracker({ maxPlayers: 1, mirrored: true, filterPreset: 'cosmetic' });
  private proj: Projection | null = null;
  private particles = new ParticleSystem();
  private player: TrackedPlayer | null = null;

  private targets: HoverTarget[] = [];
  private lastFrameId = -1;
  private idleTime = 0;
  /** Seconds present but never raising a hand. See PRESENCE_STALL_SEC. */
  private stalledTime = 0;
  private enterTime = 0;
  private launching: string | null = null;
  private launchAt = 0;
  /** See the note on AttractScreen.exiting — the router cannot fade for us. */
  private exiting: string | null = null;
  private exitTime = 0;

  async mount(): Promise<void> {
    audio.init();
    // KEEP THE STALL'S PULSE. Attract stops its ambient bed on unmount,
    // reasoning that "the menu and every game start their own music" — which
    // is true of games and was never true here. A player could stand at the
    // menu for up to PRESENCE_STALL_SEC in total silence, in a hall where the
    // low end is the only part of the mix that carries. Same tempo and
    // intensity as attract, so crossing between them is seamless.
    audio.startMusic(96);
    audio.setMusicIntensity(0.22);
    if (!isSimEnabled()) {
      await vision.start({ mode: 'pose', numPoses: 1, poseModel: 'lite' });
    }
  }

  unmount(): void {
    this.particles.clear();
    // A game sets its own tempo; leaving this running would layer two.
    audio.stopMusic();
  }

  render(fc: FrameContext): void {
    const { ctx, v } = fc;
    if (this.enterTime === 0) this.enterTime = fc.time;

    this.updateTracking(fc);
    this.layout(fc);

    graphPaper(ctx, v);
    this.drawDecor(fc);
    this.drawBackdrop(fc);

    const state = this.cursor.update(fc, this.launching ? null : this.player, this.targets);

    // Idle timeout. Only the absence of a PLAYER counts — a cursor that has
    // lost its wrist for a moment is not an empty stall.
    if (this.player) this.idleTime = 0;
    else this.idleTime += fc.dt;

    // Present, but never reaching for anything. `state.present` is false
    // whenever no wrist is raised and trustworthy, which is exactly the
    // "standing there not knowing what to do" case.
    //
    // Deliberately NOT also requiring `this.player` to be non-null. Measured
    // over 1800 frames with a body standing still, the tracker drops it for 18
    // of them — scattered single-frame gaps — and gating on the player reset
    // this timer on every one, so a 32s patience threshold was never reached in
    // a 30s test. Only an actual REACH clears it now; absence counts toward the
    // stall too, which changes nothing in practice because `idleTime` fires
    // twelve seconds earlier for a genuinely empty stall.
    if (state.present) this.stalledTime = 0;
    else this.stalledTime += fc.dt;

    // The hard cap ignores `launching` as well: once that latch is set it is
    // never cleared, so gating every exit on it leaves a failed launch with no
    // way off this screen at all.
    const cappedOut = fc.time - this.enterTime > MENU_HARD_CAP_SEC;
    const unengaged = this.stalledTime > PRESENCE_STALL_SEC;
    const empty = this.idleTime > IDLE_TIMEOUT_SEC;

    if (!this.exiting && (cappedOut || (!this.launching && (empty || unengaged)))) {
      // Tell attract this BODY did not engage, so it holds longer before
      // putting the menu back up. See BOUNCE_COOLDOWN_SEC.
      //
      // Only on the paths where there actually was a body. `idleTime` firing
      // means the stall is EMPTY, and charging the next visitor — who may
      // arrive five seconds later — a 3x bounce penalty for the previous
      // person having walked away is backwards.
      if (unengaged || cappedOut) noteMenuTimeout();
      this.leave('attract');
    }

    if (state.committed) this.commit(fc, state.committed, state.x, state.y);

    this.drawTiles(fc, state.hovered, state.progress);
    this.drawHeader(fc);

    this.particles.update(fc.dt);
    this.particles.draw(ctx);
    // No drawGlow(): it is a second pass in 'screen' composite mode over every
    // live particle, which is both a see-through surface the brand forbids and
    // the single most expensive optional thing on this screen.

    if (!this.exiting) this.cursor.draw(fc);
    this.drawFooter(fc);

    // Brief hold on the chosen tile so the selection is seen before the screen
    // changes. A menu that vanishes the instant you commit leaves people
    // unsure whether they picked the thing they meant to.
    //
    // `launching` stays set through the wipe so the chosen tile keeps its
    // pressed state all the way out; `leave` is idempotent.
    const span = dur(DUR.base);
    if (this.launching && fc.time - this.launchAt > DUR.fast) this.leave(this.launching);

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

  private leave(next: string): void {
    if (this.exiting) return;
    this.exiting = next;
    this.exitTime = 0;
  }

  /** Flat shapes at the corners. Fixed, untilted where they sit near text. */
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

    // STALE VISION MEANS NOBODY. This is the worst strand in the shell.
    //
    // The tracker is only stepped on a NEW frameId, so a dead or wedged vision
    // worker leaves `this.player` pointing at a frozen body forever. On this
    // screen that disables BOTH exits at once: `idleTime` is pinned at 0 by
    // the non-null player, and if the frozen landmarks happen to have a wrist
    // up, `hover.sample` keeps returning a point so `state.present` pins
    // `stalledTime` at 0 as well. The menu then sits there until somebody
    // notices and reloads the page. Same guard as `GameBase.updateTracking`.
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

  /**
   * Rebuilt every frame: the TV's resolution is not known ahead of time and
   * the operator may toggle fullscreen mid-event.
   */
  private layout(fc: FrameContext): void {
    const { v } = fc;
    const top = vh(v, GRID_TOP);
    const bottom = vh(v, GRID_BOTTOM);
    // THE GUTTER IS THE ONLY THING BETWEEN PICKING A GAME AND PICKING THE
    // WRONG GAME, AND IT WAS 2.2vh.
    //
    // Reported from the playtest: "sens is low for selecting, might pick the
    // wrong game." A wrong pick costs a whole turn out of a moving queue, so
    // it is much worse than no pick at all.
    //
    // The hit rect IS the visual rect, and tiles sit `gap` apart, so `gap` is
    // the entire dead band between two neighbours. At 16:9 the old numbers
    // worked out as tiles 40.7vh wide separated by 2.2vh — and the hand cursor
    // maps ±`hover.reachX` (1.7) shoulder widths across the full 177.8vh of
    // screen, so one shoulder width is 52.3vh:
    //
    //   old gutter  2.2vh = 0.042 shoulder widths ~ 1.7cm of wrist travel
    //   new gutter  4.4vh = 0.084 shoulder widths ~ 3.4cm
    //
    // Under two centimetres of hand movement separated one game from another,
    // for someone waving at a TV from three metres with a filter that lags.
    //
    // Doubling it costs almost nothing, because the cost comes out of tile
    // WIDTH and there are four of them sharing it:
    //
    //   tile   40.7 x 31.4vh  ->  39.0 x 30.3vh   (-4.1% wide, -3.5% tall)
    //
    // A 4% smaller target in exchange for a 100% wider miss margin, and the
    // miss now lands on NOTHING — where the dwell drains and the player simply
    // corrects — instead of silently arming a game they did not choose.
    //
    // Deliberately NOT the other fix that gets suggested here, enlarging hit
    // rects past their visual rects: with tiles this close together that
    // removes the dead band entirely (or overlaps it), which makes the exact
    // reported failure more likely, not less.
    const gapY = vh(v, SPACE.lg);
    // vh is the right unit for a TV (ARCHITECTURE hard rule 7) and the wrong
    // one for a HORIZONTAL gap on a narrow window: `vh` is a fraction of
    // HEIGHT, so in a tall operator window the gutter grows while the space it
    // is eating shrinks. Measured in a 476x850 pane, a 4.4vh gutter is 37px
    // against 73px-wide tiles — half the tile. Same width-relative ceiling the
    // Runner's lane indicator uses, and for the same reason: the TV never
    // reaches it, a windowed screen does.
    const gapX = Math.min(gapY, v.width * 0.035);
    const sideMargin = vh(v, SAFE + SPACE.xs);
    const rowH = (bottom - top - gapY * (ROW_SIZES.length - 1)) / ROW_SIZES.length;

    const order = tilesInDisplayOrder();
    this.targets = [];
    let index = 0;
    for (let row = 0; row < ROW_SIZES.length; row++) {
      const count = ROW_SIZES[row]!;
      const usable = v.width - sideMargin * 2;
      // Every row uses the widest row's cell width, so a short row is centred
      // rather than stretched into oversized tiles.
      const cellW = (usable - gapX * (Math.max(...ROW_SIZES) - 1)) / Math.max(...ROW_SIZES);
      const rowW = cellW * count + gapX * (count - 1);
      const startX = (v.width - rowW) / 2;
      const y = top + row * (rowH + gapY);

      for (let col = 0; col < count; col++) {
        const tile = order[index];
        index++;
        if (!tile) break;
        this.targets.push({
          id: tile.id,
          x: startX + col * (cellW + gapX),
          y,
          w: cellW,
          h: rowH,
          enabled: isTileAvailable(tile),
        });
      }
    }
  }

  /* ---------------- select ---------------- */

  private commit(fc: FrameContext, id: string, x: number, y: number): void {
    // ONE LAUNCH PER LAUNCH.
    //
    // `HoverState.committed` is documented as a one-frame edge, and on the
    // happy path it is — but `HoverCursor.update` has a LOST_GRACE_SEC branch
    // that returns THE SAME STATE OBJECT, `committed` still set, whenever the
    // wrist goes away. This screen guarantees that happens on every single
    // launch, because the line that drives the cursor passes `null` for the
    // player the moment `launching` is set:
    //
    //     this.cursor.update(fc, this.launching ? null : this.player, ...)
    //
    // So frame N commits, and frames N+1..N+18 re-deliver the same commit for
    // the full 0.3s of grace. Un-guarded that was ~18 stacked `whoosh` voices
    // and ~18 celebrate bursts per selection, and because `launchAt` was
    // restamped every one of those frames the hold before the wipe ran ~0.45s
    // instead of DUR.fast's 0.15s.
    if (this.launching) return;

    const tile = MENU_TILES.find((t) => t.id === id);
    if (!tile || !isTileAvailable(tile)) return;
    this.launching = id;
    this.launchAt = fc.time;
    BURST.celebrate(this.particles, x, y, [tile.color, COLORS.text], 0.8);
    audio.play('whoosh');
  }

  /* ---------------- drawing ---------------- */

  private drawBackdrop(fc: FrameContext): void {
    const { ctx, v } = fc;

    // The player's own skeleton behind the grid. This is what makes the hand
    // cursor comprehensible without a word of instruction: people see
    // themselves move and then see the dot move.
    //
    // Drawn in the GRID colour, not ink at 16% opacity: a real palette colour
    // instead of a see-through one, and `glow: 0` keeps drawPose on its single
    // flat-stroke path.
    //
    // Grid rather than muted, deliberately. Seven opaque cards cover most of
    // this screen, so a mid-grey figure behind them is only ever visible as
    // disconnected slivers in the gaps, which reads as a rendering fault. At
    // the graph-paper weight it reads as part of the paper and still moves
    // visibly, which is all it has to do — the hand cursor is what actually
    // teaches the control.
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

  private drawHeader(fc: FrameContext): void {
    const { ctx, v } = fc;
    const t = EASE.out(ramp(fc.time - this.enterTime, DUR.base));
    const title = '<CHOOSE YOUR GAME>';

    drawText(ctx, title, v.width / 2, vh(v, 9.5), {
      size: fitText(ctx, title, v.width - vh(v, SAFE * 2), vh(v, TYPE.title)),
      color: COLORS.ink,
      weight: WEIGHT.black,
      // Ink glyphs get a PAPER KNOCKOUT, never an ink shadow. `drawText`'s
      // shadow re-fills the same glyphs in ink one offset down, which under
      // ink letterforms is the word printed twice — reported from the
      // playtest as "text might be doubled". The knockout also does the job
      // this line actually needs, which is separating the title from the live
      // skeleton `drawBackdrop` paints behind it.
      knockout: true,
      letterSpacing: TRACK.h1,
      alpha: t,
    });
    drawText(ctx, 'HOLD YOUR HAND OVER A TILE', v.width / 2, vh(v, 16.2), {
      size: vh(v, TYPE.label),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: '0.24em',
      alpha: t,
    });
  }

  /**
   * DWELL FILL — a flat yellow wash that grows left to right across the tile.
   *
   * Replaces `drawDwellFill` from hover.ts, which paints a translucent colour
   * in 'screen' composite mode. That is a see-through brand colour twice over,
   * and on paper the 'screen' blend does nothing at all: white is the identity
   * for that operator, so the old fill was literally invisible on the new
   * background. This is flat yellow — the brand's action colour — clipped to
   * the tile, with a solid ink leading edge so the progress is readable as a
   * position and not only as an area.
   */
  private drawDwellFill(
    fc: FrameContext,
    t: HoverTarget,
    radius: number,
    progress: number
  ): void {
    if (progress <= 0) return;
    const { ctx, v } = fc;
    ctx.save();
    roundRect(ctx, t.x, t.y, t.w, t.h, radius);
    ctx.clip();
    ctx.fillStyle = COLORS.yellow;
    ctx.fillRect(t.x, t.y, t.w * progress, t.h);
    ctx.fillStyle = COLORS.ink;
    ctx.fillRect(t.x + t.w * progress - vh(v, STROKE.base), t.y, vh(v, STROKE.base), t.h);
    ctx.restore();
  }

  /**
   * PERFORMANCE AND BRAND, SAME FIX.
   *
   * This loop runs seven times a frame and used to set `shadowBlur` twice per
   * tile — once for the colour chip, once for the record line — plus a glowed
   * `drawText` for the record, which is itself two blurred fills. That is ~28
   * blurred draw calls every frame on a screen where nothing is moving, and it
   * measured 3.1ms/frame at 1080p: ten times the cost of attract mode with a
   * person standing in it.
   *
   * DESIGN.md bans blurred shadows outright, so the fix the brand demanded and
   * the fix the frame budget demanded turned out to be the same one. Every
   * tile is now a sticker: flat fill, ink outline, hard offset shadow, no blur
   * anywhere on the screen.
   *
   * Hover follows the brand's button states exactly — lifts 2px and the shadow
   * grows to 7px; pressed (committed) drops the shadow to 0 so the tile reads
   * as pushed into the page.
   */
  private drawTiles(fc: FrameContext, hovered: string | null, progress: number): void {
    const { ctx, v } = fc;
    const radius = vh(v, RADIUS.card);

    // ONE type size for the whole grid, not one per tile.
    //
    // Fitting each string independently means "RED LIGHT" renders a third
    // larger than "HOLE IN THE WALL" and the row reads as seven unrelated
    // cards at seven weights. Fitting the LONGEST string and using that size
    // everywhere costs the short titles nothing and buys a grid that reads as
    // one set — which is what lets a player scan it instead of reading it.
    const firstW = this.targets[0]?.w ?? v.width / 4;
    const inner = firstW - vh(v, SPACE.xl);
    let titleSize = vh(v, 3.6);
    for (const t of MENU_TILES) {
      titleSize = Math.min(titleSize, fitText(ctx, t.title, inner, titleSize));
    }

    // THE BLURB IS THE PRODUCT.
    //
    // ARCHITECTURE.md: legible in 3 seconds, no instructions, no sound. This
    // one line is the only thing that tells a stranger what the game IS, and it
    // was being drawn at 1.6vh — 17px on a 1080p TV, unreadable from 3m and
    // therefore not doing its job at all.
    //
    // It is held at 2.4vh and WRAPPED to two lines rather than shrunk to fit.
    // Shrinking is what put it below the legible floor in the first place, and
    // on a 4:3 panel — where the tiles are 30% narrower — shrink-to-fit would
    // put it there again.
    // Wrap first, THEN fit. `wrapText` is capped at two lines, so a long blurb
    // in a narrow tile ends up with a second line that still overruns — at 4:3
    // the tiles are 30% narrower and two blurbs ran straight out of their cards
    // into their neighbours. Measure the widest line that wrapping actually
    // produced, scale the whole grid by that overflow, and re-wrap at the new
    // size so the break lands where it should.
    let blurbSize = vh(v, 2.4);
    let blurbLines = wrapAll(ctx, blurbSize, inner);
    let widest = 0;
    for (const lines of blurbLines.values()) {
      for (const line of lines) {
        widest = Math.max(widest, measureText(ctx, line, blurbSize, WEIGHT.medium, FONTS.body));
      }
    }
    if (widest > inner) {
      blurbSize *= inner / widest;
      blurbLines = wrapAll(ctx, blurbSize, inner);
    }
    let blurbRows = 1;
    for (const lines of blurbLines.values()) blurbRows = Math.max(blurbRows, lines.length);
    const lineH = blurbSize * 1.2;

    for (const target of this.targets) {
      const tile = MENU_TILES.find((t) => t.id === target.id);
      if (!tile) continue;

      const isHovered = hovered === tile.id;
      const chosen = this.launching === tile.id;
      const active = isTileAvailable(tile);
      const color = active ? tile.color : COLORS.muted;

      // Brand button states: rest, hover LIFT, press flat. The lift is real
      // geometry, not a colour change, which is what makes it survive being
      // looked at from the back of a queue.
      //
      // The hover lift was -0.2vh against a rest state of 0, with the outline
      // going from 0.41vh to 0.54vh. Two pixels and a third of a pixel of
      // stroke, on a 1080p TV, at three metres: the player could not tell
      // which tile was armed until the dwell fill had already climbed. That is
      // half of "might pick the wrong game" — you cannot correct a mistake you
      // cannot see, and the whole point of a 1.2s dwell is that there is time
      // to correct it.
      //
      // 0.9vh of lift with a matching 1.6vh drop is an unmistakable step out
      // of the grid — roughly a tenth of a tile height of separation — and it
      // costs nothing but two numbers.
      const lift = chosen ? vh(v, SHADOW.base) : isHovered ? -vh(v, 0.9) : 0;
      const drop = chosen
        ? 0
        : isHovered
          ? vh(v, SHADOW.lifted + 0.9)
          : vh(v, SHADOW.base);
      const ty = target.y + lift;

      stickerCard(ctx, v, target.x, ty, target.w, target.h, {
        fill: COLORS.paper,
        outline: active ? COLORS.ink : COLORS.muted,
        outlineWidth: vh(v, isHovered || chosen ? STROKE.thick : STROKE.base),
        shadow: drop,
        shadowColor: active ? COLORS.ink : COLORS.muted,
      });

      // Accent bar along the top edge, full tile width.
      //
      // Replaces the small centred chip. At 3m a 36%-wide dash reads as a
      // smudge; a full-width bar reads as a colour, and colour is how a
      // returning player finds the game they wanted without reading anything.
      ctx.save();
      roundRect(ctx, target.x, ty, target.w, target.h, radius);
      ctx.clip();
      ctx.fillStyle = color;
      ctx.fillRect(target.x, ty, target.w, vh(v, TILE.accentH));
      ctx.restore();

      if (active) this.drawDwellFill(fc, { ...target, y: ty }, radius, chosen ? 1 : isHovered ? progress : 0);

      // Outline again, over the accent bar and the dwell fill, so the card
      // keeps a continuous edge.
      ctx.save();
      ctx.strokeStyle = active ? COLORS.ink : COLORS.muted;
      ctx.lineWidth = vh(v, isHovered || chosen ? STROKE.thick : STROKE.base);
      roundRect(ctx, target.x, ty, target.w, target.h, radius);
      ctx.stroke();
      ctx.restore();

      const cx = target.x + target.w / 2;

      drawText(ctx, tile.title, cx, ty + vh(v, TILE.title), {
        size: titleSize,
        color: active ? COLORS.ink : COLORS.muted,
        weight: WEIGHT.black,
        letterSpacing: TRACK.h2,
      });

      const lines = blurbLines.get(tile.id) ?? [tile.blurb];
      const blurbTop = ty + vh(v, TILE.blurb) - ((blurbRows - 1) * lineH) / 2;
      for (let i = 0; i < lines.length; i++) {
        drawText(ctx, lines[i] ?? '', cx, blurbTop + i * lineH, {
          size: blurbSize,
          color: active ? COLORS.ink : COLORS.muted,
          font: FONTS.body,
          weight: WEIGHT.medium,
          letterSpacing: TRACK.body,
        });
      }

      // Rule between "what it is" and "what to beat". Cheap, and it turns a
      // vague middle band into a deliberate two-part card.
      ctx.save();
      ctx.strokeStyle = active ? COLORS.grid : COLORS.paper;
      ctx.lineWidth = vh(v, STROKE.thin);
      ctx.beginPath();
      ctx.moveTo(cx - inner * 0.38, ty + vh(v, TILE.rule));
      ctx.lineTo(cx + inner * 0.38, ty + vh(v, TILE.rule));
      ctx.stroke();
      ctx.restore();

      if (active) this.drawRecord(fc, tile, target.x, ty, target.w);
      else this.drawComingSoon(fc, target.x, ty, target.w);
    }
  }

  private drawRecord(fc: FrameContext, tile: MenuTile, x: number, y: number, w: number): void {
    const { ctx, v } = fc;
    const best = leaderboard.getBest(tile.id);
    const cx = x + w / 2;
    const inner = w - vh(v, SPACE.xl);

    // EMPTY STATE. On the morning of day 1 every tile is in this branch, so it
    // has to look like an invitation rather than like missing data: a yellow
    // action badge at a size someone can actually read, tilted because the kit
    // tilts its badges, not two grey lines of 1.7vh mouse type.
    if (!best) {
      labelPill(ctx, v, cx, y + vh(v, TILE.badgeCy), 'BE THE FIRST!', vh(v, TILE.badgeH), {
        size: Math.min(vh(v, 2.4), fitText(ctx, 'BE THE FIRST!', inner * 0.7, vh(v, 2.4), WEIGHT.bold, FONTS.body)),
        fill: COLORS.yellow,
        color: COLORS.ink,
        shadow: vh(v, SHADOW.base),
        tilt: -7,
      });
      return;
    }

    drawText(ctx, 'RECORD', cx, y + vh(v, TILE.recordLabel), {
      size: vh(v, TYPE.micro),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: '0.3em',
    });

    // Tabular figures: seven of these are on screen at once and they must sit
    // on a common baseline grid, and the number changes between visits.
    const line = `${best.initials}  ${best.score.toLocaleString('en-US')}`;
    const size = Math.min(
      vh(v, 3.4),
      (inner / Math.max(1, measureTabularNumber(ctx, line, vh(v, 3.4), WEIGHT.black, FONTS.body))) * vh(v, 3.4)
    );
    drawTabularNumber(ctx, line, cx, y + vh(v, TILE.recordValue), {
      size,
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.black,
      letterSpacing: TRACK.number,
    });
  }

  private drawComingSoon(fc: FrameContext, x: number, y: number, w: number): void {
    const { ctx, v } = fc;
    const inner = w - vh(v, SPACE.xl);
    // Disabled: "all elements turn muted grey", and it stays straight — a
    // tilted badge reads as playful, and nothing about an unavailable game is.
    labelPill(ctx, v, x + w / 2, y + vh(v, TILE.badgeCy), 'COMING SOON', vh(v, TILE.badgeH), {
      size: Math.min(vh(v, 2.2), fitText(ctx, 'COMING SOON', inner * 0.7, vh(v, 2.2), WEIGHT.bold, FONTS.body)),
      fill: COLORS.paper,
      outline: COLORS.muted,
      color: COLORS.muted,
      shadow: 0,
    });
  }

  /**
   * One line at the bottom that answers "what do I do now" for whichever of
   * the three situations the player is actually in.
   *
   * Sits inside the TV safe area, and the two states that are PROMPTS are a
   * yellow action pill while the state that is merely status is plain type.
   * The old version pulsed alpha, which took a prompt to 10% opacity for a
   * third of every cycle; it now breathes on scale and stops dead under
   * reduced motion.
   */
  private drawFooter(fc: FrameContext): void {
    const { ctx, v } = fc;
    const y = vh(v, 100 - SAFE - 2.8);
    const breathe = idlePulse(fc.time, 2.6, 1);

    const prompt = !this.player
      ? 'STEP INTO FRAME'
      : !this.cursor.last.present
        ? 'RAISE A HAND TO POINT'
        : null;

    // WHICHEVER DEADLINE IS ACTUALLY RUNNING.
    //
    // This used to read `IDLE_TIMEOUT_SEC - this.idleTime` only, and it sat
    // BELOW an early `return` that fires whenever `this.player` is null. But
    // `idleTime` is reset to 0 on every frame a player IS present — so on the
    // one path that could reach this line, `idleTime` was always exactly 0,
    // `remaining` was always 20, `urgent` was always false, and the red
    // "RETURNING IN n" warning was unreachable dead code.
    //
    // Meanwhile the timer that does fire for a present-but-confused player is
    // `stalledTime`, which had no countdown at all: the screen simply wiped
    // out from under them mid-decision. Now the countdown tracks whichever of
    // the three is closest, and it is drawn ALONGSIDE the prompt pill rather
    // than instead of it — the prompt says what to do and the countdown says
    // how long they have, and they are never in competition.
    const remaining = Math.max(
      0,
      Math.min(
        this.player ? Infinity : IDLE_TIMEOUT_SEC - this.idleTime,
        PRESENCE_STALL_SEC - this.stalledTime,
        MENU_HARD_CAP_SEC - (fc.time - this.enterTime)
      )
    );
    const urgent = remaining < 8;

    if (prompt) {
      ctx.save();
      ctx.translate(v.width / 2, y);
      ctx.scale(1 + breathe * 0.02, 1 + breathe * 0.02);
      labelPill(ctx, v, 0, 0, prompt, vh(v, 5.4), {
        size: vh(v, TYPE.label),
        fill: COLORS.yellow,
        color: COLORS.ink,
        shadow: vh(v, SHADOW.base),
      });
      ctx.restore();

      if (urgent) {
        drawTabularNumber(ctx, `RETURNING IN ${Math.ceil(remaining)}`, v.width / 2, y - vh(v, 4.6), {
          size: vh(v, TYPE.label),
          color: COLORS.red,
          font: FONTS.body,
          weight: WEIGHT.black,
          letterSpacing: TRACK.pill,
        });
      }
      return;
    }

    if (urgent) {
      drawTabularNumber(ctx, `RETURNING IN ${Math.ceil(remaining)}`, v.width / 2, y, {
        size: vh(v, TYPE.label),
        color: COLORS.red,
        font: FONTS.body,
        weight: WEIGHT.black,
        letterSpacing: TRACK.pill,
      });
      return;
    }
    drawText(ctx, 'HOLD STILL OVER A TILE TO PICK IT', v.width / 2, y, {
      size: vh(v, TYPE.label),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: TRACK.pill,
    });
  }
}
