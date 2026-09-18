/**
 * ATTRACT MODE — the foot-traffic engine.
 *
 * PLAN.md §6: "live silhouette of whoever walks past, rendered with a
 * glow/trail shader, faction totals, scrolling leaderboard. This is the
 * foot-traffic engine. It runs whenever nobody's playing, which is most of
 * the time."
 *
 * This screen has one job and it is not a gameplay job: make a stranger who
 * was walking past stop walking. Everything here is aimed at the two seconds
 * where they glance at the TV out of the corner of their eye:
 *
 *  - They see THEMSELVES, glowing, before they understand why. Nothing else on
 *    a stall does that, and it is the entire hook.
 *  - The call to action reacts the instant they are detected, which converts
 *    "that's a nice screensaver" into "that is responding to me".
 *  - Faction totals give a reason to care about a score they have not set yet.
 *    PLAN.md §4 calls factions "the highest-leverage feature in the doc"
 *    because they turn a solo number into a team stake.
 *
 * PLAN.md §9 also lists "nobody approaches" as a medium risk whose mitigation
 * is literally this screen, so it runs for hours and has to stay cheap: there
 * is a frame-budget watchdog at the bottom of this file that sheds trail
 * length and particle density rather than letting the stall stutter.
 */

import { MotionEnergy } from '../core/gestures';
import { isSimEnabled } from '../core/simulator';
import { PoseTracker, type TrackedPlayer } from '../core/tracker';
import { camera } from '../core/camera';
import { vision } from '../core/vision';
import { audio } from '../engine/audio';
import {
  clearFrame,
  decorShape,
  drawTabularNumber,
  drawText,
  fitText,
  graphPaper,
  labelPill,
  measureTabularNumber,
  measureText,
  roundRect,
  rankedRow,
  stickerCard,
  transition,
  vh,
  wipe,
} from '../engine/draw';
import { Juice } from '../engine/juice';
import { Projection } from '../engine/projection';
import { drawPose, SKELETON_STYLES } from '../engine/skeleton';
import { FACTIONS, leaderboard } from '../meta/leaderboard';
import { MENU_TILES, isTileAvailable, type MenuTile } from './menu';
import {
  COLORS,
  DUR,
  EASE,
  FONTS,
  PLAYER_COLORS,
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
  textColor,
  ramp,
  idlePulse,
  prefersReducedMotion,
} from './theme';
import type { FrameContext, Screen } from './screen';

/** Seconds a person must hold reasonably still before we take them to the menu. */
const HOLD_STILL_SEC = 1.1;
/**
 * Someone who has been standing in frame this long goes to the menu whether or
 * not they held still. A confused person fidgeting in front of the camera must
 * never be stuck on the attract screen.
 */
const PRESENCE_FORCE_SEC = 6;
/** Mean per-frame landmark displacement, in body units, that counts as still. */
const STILL_ENTER = 0.030;
const STILL_EXIT = 0.055;
/** Seconds each game's leaderboard holds the rail before it cycles. */
const RAIL_CYCLE_SEC = 5;
const RAIL_FADE_SEC = 0.45;
/**
 * Places shown on the rail.
 *
 * Fixed, and always drawn — an empty place is a dim numeral and a rule rather
 * than nothing. On the morning of day 1 every board is empty, and a card
 * containing one line of text and sixty percent void does not read as "be the
 * first", it reads as "this machine is broken". Five ghost places read as five
 * places waiting to be taken, which is the same information and the opposite
 * feeling.
 */
const RAIL_ROWS = 5;

/**
 * THE SILHOUETTE TRAIL AND THE AMBIENT PARTICLES ARE GONE.
 *
 * PLAN.md §6 asked for a "glow/trail shader" and §5a for drifting embers, and
 * both were built. Neither survives the brand: a motion trail is a stack of
 * see-through copies and an ember is a fading translucent dot, and DESIGN.md
 * rules out see-through colour outright.
 *
 * What replaces them is better anyway. The figure is now drawn as a STICKER —
 * flat brand colour with a hard ink shadow offset straight down — which is the
 * kit's signature move applied to a live human being, reads far harder at 3m
 * than a glow ever did on a TV, and costs two strokes per person instead of
 * five plus a particle system.
 *
 * Decorative flat shapes near the edges carry the playfulness the embers used
 * to, at a fixed cost of six fills a frame.
 */
const DECOR: Array<{ kind: 'triangle' | 'circle' | 'halfCircle' | 'capsule' | 'blob'; x: number; y: number; r: number; c: string; tilt: number }> = [
  // Corners and the strip above the fold only. DESIGN.md: "Keep clear of
  // readable text" — and on this screen the only genuinely free space is the
  // four corners, because the left column, the rail and the faction band
  // between them use everything else.
  { kind: 'triangle', x: 0.028, y: 0.035, r: 2.4, c: COLORS.red, tilt: -9 },
  { kind: 'blob', x: 0.5, y: 0.038, r: 2.6, c: COLORS.green, tilt: 7 },
  { kind: 'circle', x: 0.026, y: 0.955, r: 2.2, c: COLORS.blue, tilt: 0 },
  { kind: 'halfCircle', x: 0.974, y: 0.955, r: 2.4, c: COLORS.yellow, tilt: 6 },
];

export class AttractScreen implements Screen {
  readonly id = 'attract';
  onExit?: (next: string) => void;

  private tracker = new PoseTracker({
    maxPlayers: 4,
    mirrored: true,
    // Cosmetic only. Heavy smoothing — jitter is very visible on a big TV and
    // nothing here is a gameplay threshold.
    filterPreset: 'cosmetic',
  });
  private proj: Projection | null = null;
  private juice = new Juice();

  private players: TrackedPlayer[] = [];
  private motion = new Map<number, MotionEnergy>();
  /** Last windowed motion value per track, recorded on inference frames only. */
  private energy = new Map<number, number>();

  private lastFrameId = -1;
  private presenceTime = 0;
  private stillTime = 0;
  private wasPresent = false;
  /** 0..1, snaps to 1 the frame a person appears and eases back down. */
  private detectPulse = 0;

  private railIndex = 0;
  private railTime = 0;
  private enterTime = 0;
  /**
   * Set the moment this screen decides to leave; counts up until the wipe has
   * fully covered. The router swaps screens on a single frame and neither it
   * nor main.ts may be touched, so a screen wipes itself out and the next one
   * wipes itself in.
   */
  private exiting: string | null = null;
  private exitTime = 0;

  private budgetStrikes = 0;
  /** Dropped by the frame-budget watchdog before anything a player needs. */
  private showGrid = true;

  async mount(): Promise<void> {
    audio.init();
    // AMBIENT BED. This is the screen PLAN.md says runs most of the time, and
    // measured over six simulated seconds with nobody in frame it made exactly
    // zero audio calls — silence, from the one surface whose entire job is to
    // pull someone over from across a loud hall. PLAN.md §5's own brief is
    // "weight the mix low — bass thumps carry through crowd noise", and the
    // adaptive arpeggiator that does it already exists; it was simply never
    // started here.
    //
    // Slow (96bpm against a round's 126) and held at low intensity, so it reads
    // as the stall having a pulse rather than as a game already in progress —
    // and so that starting a round is still an audible gear change.
    audio.startMusic(96);
    audio.setMusicIntensity(0.22);
    if (!isSimEnabled()) {
      // Four poses: the point is to light up a whole group walking past, not
      // just the one person nearest the camera.
      await vision.start({ mode: 'pose', numPoses: 4, poseModel: 'lite' });
    }
  }

  unmount(): void {
    this.motion.clear();
    // The menu and every game start their own music; leaving this running
    // would layer two arpeggiators at different tempos.
    audio.stopMusic();
  }

  /**
   * The one place the screen's geometry is decided.
   *
   * Recomputed per frame because the TV's resolution is not known ahead of
   * time and the operator may toggle fullscreen mid-event. Everything is
   * expressed against `SAFE` (TV overscan) and the SPACE scale, so the same
   * code lands correctly at 16:9, 4:3 and 21:9 instead of at one of them.
   */
  private frame(v: FrameContext['v']): {
    colX: number;
    colW: number;
    railX: number;
    railW: number;
    railY: number;
    railH: number;
    bandY: number;
  } {
    const safe = vh(v, SAFE);
    // The rail wants a third of a 16:9 screen, but on a 4:3 TV a third is too
    // narrow for "67 SPEED DUEL" plus a five-digit score, so it also has a
    // hard floor in vh. Width-relative alone breaks at one aspect or the other.
    const railW = Math.max(vh(v, 44), Math.min(v.width * 0.32, vh(v, 62)));
    const railX = v.width - safe - railW;
    const colX = safe + vh(v, SPACE.md);
    return {
      colX,
      colW: railX - colX - vh(v, SPACE.xl),
      railX,
      railW,
      railY: vh(v, SAFE + 3.5),
      railH: vh(v, 78) - vh(v, SAFE + 3.5),
      bandY: vh(v, 81),
    };
  }

  render(fc: FrameContext): void {
    const { ctx, v } = fc;
    if (this.enterTime === 0) this.enterTime = fc.time;

    const dt = this.juice.beginFrame(fc.dt);
    this.watchFrameBudget(fc.dt);
    this.ensureProjection(fc);
    this.updateTracking(fc);
    this.updatePresence(fc);

    const box = this.frame(v);

    if (this.showGrid) graphPaper(ctx, v);
    else clearFrame(ctx, v);
    this.drawDecor(fc);

    this.juice.pushTransform(ctx, v, 0.5);
    this.drawSilhouettes(fc, box);
    this.juice.popTransform(ctx);

    this.drawCallToAction(fc, box);
    this.drawLeaderboardRail(fc, dt, box);
    this.drawFactionBand(fc, box);

    // Enter / exit wipe. DUR.base is the brand's 220ms; `dur()` collapses it to
    // an instant cut under prefers-reduced-motion.
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

  /**
   * Flat decorative shapes near the edges — DESIGN.md's "playful tilted
   * collages at the edges". Fixed positions, fixed tilts, no drift: shape
   * drift is an 8–10s loop in the kit, and on a screen that runs unattended
   * for eight hours next to a live camera feed it is motion nobody asked for.
   * They are placed clear of every text run and clear of the rail.
   */
  private drawDecor(fc: FrameContext): void {
    const { ctx, v } = fc;
    for (const d of DECOR) {
      decorShape(ctx, d.kind, d.x * v.width, d.y * v.height, vh(v, d.r), d.c, d.tilt);
    }
  }

  /** Begin the wipe out. Idempotent — several timers can race to leave. */
  private leave(next: string): void {
    if (this.exiting) return;
    this.exiting = next;
    this.exitTime = 0;
  }

  /* ---------------- tracking and presence ---------------- */

  private ensureProjection(fc: FrameContext): void {
    const cam = camera.getState();
    const camW = cam.width || 1280;
    const camH = cam.height || 720;
    if (!this.proj) {
      this.proj = new Projection(fc.v, {
        cameraWidth: camW,
        cameraHeight: camH,
        // 'cover' — the silhouette is a backdrop and letterbox bars would kill
        // the full-bleed look this screen depends on.
        fit: 'cover',
        mirrored: true,
      });
    } else {
      this.proj.update(fc.v, { cameraWidth: camW, cameraHeight: camH });
    }
  }

  private updateTracking(fc: FrameContext): void {
    if (!fc.vision || fc.vision.frameId === this.lastFrameId) return;
    this.lastFrameId = fc.vision.frameId;
    this.players = this.tracker.update(fc.vision.poses, fc.time);

    const live = new Set<number>();
    for (const p of this.players) {
      live.add(p.id);

      let energy = this.motion.get(p.id);
      if (!energy) {
        energy = new MotionEnergy();
        this.motion.set(p.id, energy);
      }
      // MotionEnergy diffs consecutive RAW samples, so it must only be stepped
      // on genuinely new inference frames — feeding it the same frame twice
      // reads as perfect stillness, and a person walking past would be taken
      // straight into the menu.
      this.energy.set(p.id, energy.update(p));
    }

    for (const id of [...this.motion.keys()]) if (!live.has(id)) this.motion.delete(id);
    for (const id of [...this.energy.keys()]) if (!live.has(id)) this.energy.delete(id);
  }

  /**
   * "When a person is detected and holds still briefly, transition to the
   * menu." Held still, not posed: asking a stranger to perform a gesture
   * before they know what the thing is loses them.
   */
  private updatePresence(fc: FrameContext): void {
    const primary = this.tracker.getPrimary();
    const present = !!primary;

    if (present && !this.wasPresent) {
      // The instant reaction. This is the single most important frame on this
      // screen — it is the moment a passer-by learns the TV can see them.
      this.detectPulse = 1;
      this.juice.flash(COLORS.blueBright, 0.22, 3.5);
      this.juice.shake(0.12);
      audio.play('whoosh');
      this.presenceTime = 0;
      this.stillTime = 0;
    }
    this.wasPresent = present;
    this.detectPulse = Math.max(0, this.detectPulse - fc.dt * 1.2);

    if (!present || !primary) {
      this.presenceTime = 0;
      this.stillTime = 0;
      return;
    }

    this.presenceTime += fc.dt;

    // No sample yet means "assume moving" — never assume stillness we have not
    // measured, or the first frame of a detection would trip the transition.
    const value = this.energy.get(primary.id) ?? 1;
    // Hysteresis by hand rather than via Hysteresis so the still/moving gate
    // and the accumulated hold time stay in one place.
    const stillNow = this.stillTime > 0 ? value < STILL_EXIT : value < STILL_ENTER;

    if (stillNow && this.presenceTime > 0.35) this.stillTime += fc.dt;
    else this.stillTime = Math.max(0, this.stillTime - fc.dt * 2);

    if (this.stillTime >= HOLD_STILL_SEC || this.presenceTime >= PRESENCE_FORCE_SEC) {
      if (!this.exiting) audio.play('go');
      this.leave('menu');
    }
  }

  /* ---------------- drawing ---------------- */

  /**
   * THE SILHOUETTE, AS A STICKER.
   *
   * This is the entire hook of the screen — a stranger sees THEMSELVES on the
   * TV before they understand why — so it is the one thing that had to survive
   * the rebrand intact, and the brand turns out to suit it better than the
   * neon did.
   *
   * Each person is drawn twice: once offset straight down in flat ink, once in
   * place in their flat brand colour. That is the kit's signature sticker
   * treatment applied to a live human being. It is completely flat, has no
   * blur and no transparency, and on a white ground it reads harder at three
   * metres than a glowing wireframe on black ever did on a cheap panel.
   *
   * Two strokes per person, down from five plus a particle system.
   */
  private drawSilhouettes(fc: FrameContext, box: ReturnType<AttractScreen['frame']>): void {
    const { ctx, v } = fc;
    const proj = this.proj;
    if (!proj) return;

    const lineWidth = vh(v, 1.5);
    const drop = vh(v, SHADOW.lifted);

    // Figures stop at the horizon rule.
    //
    // They are flat brand colours now, and the faction row underneath is also
    // flat brand colours — a blue player's leg running behind the word
    // ENGINEERING rendered in the same blue is unreadable. Clipping makes the
    // horizon rule mean something (the figures stand on it) and guarantees the
    // band always sits on clean paper.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, v.width, box.bandY);
    ctx.clip();

    for (const player of this.players) {
      const color = PLAYER_COLORS[Math.max(0, player.slot) % PLAYER_COLORS.length] ?? COLORS.blue;

      // Hard shadow: same figure, straight down, flat ink, zero blur.
      ctx.save();
      ctx.translate(0, drop);
      drawPose(ctx, player.landmarks, proj, {
        ...SKELETON_STYLES.attract,
        color: COLORS.ink,
        alpha: 1,
        glow: 0,
        lineWidth,
      });
      ctx.restore();

      // The figure itself. `glow: 0` means drawPose takes its single flat
      // stroke path — no halo passes, no alpha ramp.
      drawPose(ctx, player.landmarks, proj, {
        ...SKELETON_STYLES.attract,
        color,
        alpha: 1,
        glow: 0,
        lineWidth,
      });
    }
    ctx.restore();
  }

  /**
   * The left column: brand lockup, the call to action in code brackets, and an
   * explicit three-step explanation of what is about to happen.
   *
   * Everything is left-aligned on one axis. A shared edge is what makes four
   * unrelated lines read as one block of information from across a hall;
   * centring each line on its own width does the opposite, and it was leaving
   * the lower half of this column completely empty.
   */
  private drawCallToAction(fc: FrameContext, box: ReturnType<AttractScreen['frame']>): void {
    const { ctx, v } = fc;
    const detected = this.players.length > 0;
    const intro = EASE.out(ramp(fc.time - this.enterTime, DUR.slow));
    const x = box.colX;

    // Header pill, per DESIGN.md's "Header pill" component. Straight, not
    // tilted — it is readable content, not decoration.
    const kicker = 'GDG ON CAMPUS UOBD';
    const kickerH = vh(v, 4.6);
    const kickerW =
      measureText(ctx, kicker, vh(v, TYPE.label), WEIGHT.bold, FONTS.body) + kickerH * 1.24;
    labelPill(ctx, v, x + kickerW / 2, vh(v, 11), kicker, kickerH, {
      size: vh(v, TYPE.label),
      fill: COLORS.paper,
      color: COLORS.ink,
      shadow: vh(v, SHADOW.base),
      alpha: intro,
    });

    // THE CALL TO ACTION, in code brackets. DESIGN.md: display headlines are
    // bracketed capitals.
    //
    // The idle breathing is on SCALE, never on alpha. Alpha-pulsing this line
    // took it to 24% opacity for a third of every cycle, which on a bright hall
    // floor means the one line that has to be readable is routinely invisible —
    // and a see-through brand colour is off-brand besides. It now breathes by a
    // couple of percent of size, and stops dead under reduced motion.
    const breathe = detected ? 1 : idlePulse(fc.time, 2.2, 1);
    const punch = 1 + EASE.spring(this.detectPulse) * 0.14 + (detected ? 0 : breathe * 0.015);
    const cta = '<STEP IN TO PLAY>';
    const size = fitText(ctx, cta, box.colW * 0.99, vh(v, 10.5));
    const ctaY = vh(v, 25);

    ctx.save();
    ctx.translate(x, ctaY);
    ctx.scale(punch, punch);
    drawText(ctx, cta, 0, 0, {
      size,
      // ALWAYS ink, never a brand colour. The thing behind this headline is a
      // living human being rendered as a flat brand colour, and a blue
      // headline landing on the blue player is invisible. Detection is already
      // signalled by the scale punch and by the step list becoming the ring.
      color: COLORS.ink,
      weight: WEIGHT.black,
      align: 'left',
      // The brand's only shadow: hard, ink, straight down, zero blur.
      shadow: vh(v, SHADOW.lifted),
      letterSpacing: TRACK.display,
      alpha: intro,
    });
    ctx.restore();

    drawText(ctx, 'NO CONTROLLER. JUST MOVE.', x, ctaY + size * 0.62 + vh(v, SPACE.md), {
      size: vh(v, TYPE.subhead),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.extrabold,
      align: 'left',
      letterSpacing: TRACK.h2,
      alpha: intro,
    });

    // Ink rule. Separates "what this is" from "what you do", and gives the
    // column a second horizontal anchor so the block below it does not float.
    const ruleY = vh(v, 41);
    ctx.save();
    ctx.globalAlpha = intro;
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = vh(v, STROKE.base);
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(x, ruleY);
    ctx.lineTo(x + Math.min(box.colW, vh(v, 46)), ruleY);
    ctx.stroke();
    ctx.restore();

    this.drawSteps(fc, box, intro, detected);
  }

  /**
   * 1 STAND IN FRAME · 2 HOLD STILL · 3 PICK A GAME.
   *
   * This block is doing two jobs. It fills the bottom half of the column,
   * which was previously dead space that made the whole screen look
   * unfinished — but more importantly it teaches the entry gesture BEFORE a
   * stranger is standing in front of the camera. The hold-still ring used to
   * be the first time anyone learned that holding still was the thing to do,
   * which is too late: by then they are already being watched by their
   * friends, and a confused three seconds is the difference between playing
   * and walking on.
   *
   * Once someone IS detected the same slot becomes the live ring, so the
   * layout never reflows and the steps never argue with the thing they were
   * explaining.
   */
  private drawSteps(
    fc: FrameContext,
    box: ReturnType<AttractScreen['frame']>,
    intro: number,
    detected: boolean
  ): void {
    const { ctx, v } = fc;
    const x = box.colX;
    const top = vh(v, 48.5);
    const step = vh(v, 9.5);

    if (detected) {
      this.drawHoldRing(fc, x + vh(v, 6), top + step * 0.55);
      return;
    }

    const steps: Array<[string, string, string]> = [
      ['1', 'STAND IN FRAME', COLORS.blue],
      ['2', 'HOLD STILL', COLORS.yellow],
      ['3', 'PICK A GAME', COLORS.green],
    ];

    for (let i = 0; i < steps.length; i++) {
      const entry = steps[i];
      if (!entry) continue;
      const [numeral, label, color] = entry;
      // Staggered entrance. Collapses to "all at once" under reduced motion,
      // because `intro` is already 1 on the first frame.
      const t = EASE.out(Math.min(1, Math.max(0, (intro - i * 0.12) / 0.7)));
      if (t <= 0) continue;
      const y = top + i * step;
      const r = vh(v, 2.9);

      // Round numbered badge, exactly the ranked-list badge shape. Flat brand
      // fill, ink outline, hard shadow — a sticker.
      ctx.save();
      ctx.globalAlpha = t;
      ctx.shadowBlur = 0;
      ctx.fillStyle = COLORS.ink;
      ctx.beginPath();
      ctx.arc(x + r, y + vh(v, SHADOW.base), r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x + r, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = vh(v, STROKE.base);
      ctx.stroke();
      ctx.restore();

      drawTabularNumber(ctx, numeral, x + r, y, {
        size: vh(v, TYPE.subhead),
        color: COLORS.ink,
        font: FONTS.body,
        weight: WEIGHT.black,
        letterSpacing: TRACK.number,
        alpha: t,
      });
      drawText(ctx, label, x + r * 2 + vh(v, SPACE.md), y, {
        size: vh(v, TYPE.subhead),
        color: COLORS.ink,
        font: FONTS.body,
        weight: WEIGHT.extrabold,
        align: 'left',
        letterSpacing: TRACK.h2,
        alpha: t,
      });
    }

    const games = MENU_TILES.filter(isTileAvailable).length;
    drawText(ctx, `${games} GAMES · 60 SECONDS · ONE SCORE`, x, top + step * 2 + vh(v, SPACE.xl), {
      size: vh(v, TYPE.label),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      align: 'left',
      letterSpacing: TRACK.pill,
      alpha: intro,
    });
  }

  /**
   * The "hold still" progress ring, shown only once a person is in frame.
   *
   * Sits in the same slot the step list occupied, at the same left axis, so a
   * person walking into frame sees the block they were reading turn into the
   * thing it described rather than the layout jumping.
   *
   * The ring is NOT suppressed under reduced motion: it is a dwell timer, and
   * a progress indicator that does not progress is a broken control, not a
   * calm one.
   */
  private drawHoldRing(fc: FrameContext, cx: number, cy: number): void {
    const { ctx, v } = fc;
    const t = Math.min(1, this.stillTime / HOLD_STILL_SEC);
    const r = vh(v, 5.8);
    const ring = vh(v, 1.3);

    ctx.save();
    ctx.shadowBlur = 0;

    // Hard shadow disc, then a paper disc with an ink outline: a round sticker.
    ctx.fillStyle = COLORS.ink;
    ctx.beginPath();
    ctx.arc(cx, cy + vh(v, SHADOW.base), r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.paper;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = vh(v, STROKE.base);
    ctx.stroke();

    // Track and fill, both flat.
    ctx.lineCap = 'butt';
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = ring;
    ctx.beginPath();
    ctx.arc(cx, cy, r - ring * 0.9, 0, Math.PI * 2);
    ctx.stroke();

    if (t > 0) {
      ctx.strokeStyle = COLORS.green;
      ctx.beginPath();
      ctx.arc(cx, cy, r - ring * 0.9, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    drawTabularNumber(ctx, `${Math.round(t * 100)}`, cx, cy, {
      size: vh(v, TYPE.body),
      color: t > 0 ? COLORS.ink : COLORS.muted,
      font: FONTS.body,
      weight: WEIGHT.black,
      letterSpacing: TRACK.number,
    });

    drawText(ctx, t > 0 ? '<HOLD IT>' : '<STAND STILL>', cx + r + vh(v, SPACE.md), cy - vh(v, 1.7), {
      size: vh(v, TYPE.heading),
      // Ink for the same reason as the headline — one of the players may be
      // the green one. The green lives in the ring fill, which sits inside a
      // paper disc and so always has contrast.
      color: COLORS.ink,
      align: 'left',
      weight: WEIGHT.black,
      shadow: vh(v, SHADOW.base),
      letterSpacing: TRACK.h1,
    });
    drawText(ctx, 'AND THE MENU OPENS', cx + r + vh(v, SPACE.md), cy + vh(v, 3.4), {
      size: vh(v, TYPE.label),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      align: 'left',
      letterSpacing: TRACK.pill,
    });
  }

  /**
   * Scrolling leaderboard, one game at a time, as the brand's ranked list.
   *
   * A seven-column table is unreadable from 3m; one game filling a whole card
   * is not, and cycling adds the motion that catches a passing eye.
   */
  private drawLeaderboardRail(
    fc: FrameContext,
    dt: number,
    box: ReturnType<AttractScreen['frame']>
  ): void {
    const { ctx, v } = fc;

    // Only games you can actually walk up and play. Giving five seconds of the
    // rail's cycle — a seventh of the screen's whole attention budget — to a
    // board for a game that says COMING SOON is five seconds spent advertising
    // something nobody can do.
    const shown = MENU_TILES.filter(isTileAvailable);
    const tiles: readonly MenuTile[] = shown.length > 0 ? shown : MENU_TILES;

    this.railTime += dt;
    if (this.railTime > RAIL_CYCLE_SEC) {
      this.railTime = 0;
      this.railIndex = this.railIndex + 1;
    }
    this.railIndex %= tiles.length;

    const tile = tiles[this.railIndex];
    if (!tile) return;

    // Slide in, hold — position only. The old version cross-faded the whole
    // card, which is a see-through surface and off-brand; a card that moves is
    // flat at every instant and reads better besides.
    const reduced = prefersReducedMotion();
    const inT = EASE.out(Math.min(1, this.railTime / RAIL_FADE_SEC));
    const slide = reduced ? 0 : (1 - inT) * vh(v, 3.5);

    const { railX: x, railW: w, railY: y, railH: h } = box;
    const pad = vh(v, SPACE.md);

    stickerCard(ctx, v, x, y, w, h, {
      fill: COLORS.paper,
      outlineWidth: vh(v, STROKE.thick),
      shadow: vh(v, SHADOW.lifted),
    });

    ctx.save();
    roundRect(ctx, x, y, w, h, vh(v, RADIUS.card));
    ctx.clip();
    ctx.translate(0, slide);

    const cx = x + w / 2;

    drawText(ctx, 'HIGH SCORES', cx, y + vh(v, 4.8), {
      size: vh(v, TYPE.label),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: '0.3em',
    });

    drawText(ctx, tile.title, cx, y + vh(v, 10.6), {
      size: fitText(ctx, tile.title, w - pad * 2, vh(v, TYPE.heading)),
      // Same rule: the Runner tile is yellow, so its rail heading was
        // invisible once per cycle.
        color: textColor(tile.color),
      weight: WEIGHT.black,
      shadow: vh(v, SHADOW.base),
      letterSpacing: TRACK.h1,
    });

    // Rows fill the card exactly, so the card is never mostly empty and never
    // overflows — the two failure modes a fixed row height has at the extremes
    // of a leaderboard that starts at zero entries and ends at five.
    const rows = leaderboard.getTop(tile.id, RAIL_ROWS);
    const footerH = vh(v, 8);
    const rowTop = y + vh(v, 15);
    const slot = (y + h - footerH - rowTop) / RAIL_ROWS;
    const rowH = slot * 0.8;

    for (let i = 0; i < RAIL_ROWS; i++) {
      const row = rows[i];
      rankedRow(ctx, v, x + pad, rowTop + i * slot + (slot - rowH) / 2, w - pad * 2, rowH, {
        rank: i + 1,
        name: row?.initials,
        value: row ? row.score.toLocaleString('en-US') : undefined,
        accent: i === 0 && row ? COLORS.ink : undefined,
      });
    }

    // Footer. Carries the empty-state message without stealing the rows'
    // space, so the card looks identical whether the board has 0 entries or 5.
    const open = RAIL_ROWS - rows.length;
    if (open > 0) {
      const label = rows.length === 0 ? 'BE THE FIRST!' : `${open} PLACE${open === 1 ? '' : 'S'} OPEN`;
      labelPill(ctx, v, cx, y + h - footerH * 0.52, label, vh(v, 5), {
        size: vh(v, TYPE.label),
        fill: COLORS.yellow,
        color: COLORS.ink,
        shadow: vh(v, SHADOW.base),
        // Badges are decoration in the kit's language, so this one gets a tilt.
        tilt: -6,
      });
    }

    ctx.restore();

    // Cycle progress — a flat bar so people know another game is coming.
    ctx.save();
    roundRect(ctx, x, y, w, h, vh(v, RADIUS.card));
    ctx.clip();
    ctx.fillStyle = tile.color;
    const p = Math.min(1, this.railTime / RAIL_CYCLE_SEC);
    const barH = vh(v, 0.9);
    const edge = vh(v, STROKE.thick);
    ctx.fillRect(x + edge, y + h - barH - edge, (w - edge * 2) * p, barH);
    ctx.restore();
  }

  /**
   * PLAN.md §4, verbatim: "Engineering 4,820 · CS 4,190 · Business 3,050".
   *
   * "This is the highest-leverage feature in the doc. It converts a solo score
   * into a team stake, it makes people drag their friends over to close a gap,
   * and it's a running narrative across both days."
   */
  private drawFactionBand(fc: FrameContext, box: ReturnType<AttractScreen['frame']>): void {
    const { ctx, v } = fc;
    const y = box.bandY;

    // Ink rule rather than a translucent band. The graph paper continues
    // underneath, which is what the brand's "abundant white space" wants.
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = vh(v, STROKE.base);
    ctx.beginPath();
    ctx.moveTo(vh(v, SAFE), y);
    ctx.lineTo(v.width - vh(v, SAFE), y);
    ctx.stroke();
    ctx.restore();

    const totals = factionStandings();
    const scored = totals.some((f) => f.total > 0);

    // The label carries the empty state. On the morning of day 1 a row reading
    // "ENGINEERING 0 · CS 0 · BUSINESS 0 · MEDIA 0" under the words FACTION
    // TOTALS says "nothing happens here"; the same row under PICK A SIDE says
    // "these are the sides and they are all tied". Same pixels, opposite
    // message, and no extra line competing for a 19vh band.
    drawText(ctx, scored ? 'FACTION TOTALS' : '<PICK A SIDE>', v.width / 2, y + vh(v, 4.4), {
      size: vh(v, TYPE.label),
      color: scored ? COLORS.ink : COLORS.blue,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: '0.3em',
    });

    // Laid out as measured segments so each faction keeps its own colour, and
    // sized from the whole line so it can never overflow at any aspect ratio.
    //
    // Tabular figures: this row is four numbers side by side, re-rendered every
    // frame, so proportional digits would make the whole band shuffle sideways
    // every time a score lands.
    const parts = totals.map((f) => `${f.name} ${f.total.toLocaleString('en-US')}`);
    const sep = '  ·  ';
    const line = parts.join(sep);
    const maxW = v.width - vh(v, SAFE * 2 + SPACE.lg);
    const size = fitText(ctx, line, maxW, vh(v, TYPE.heading), WEIGHT.black, FONTS.body);
    const sepW = measureTabularNumber(ctx, sep, size, WEIGHT.black, FONTS.body);
    const widths = parts.map((part) => measureTabularNumber(ctx, part, size, WEIGHT.black, FONTS.body));
    const total = widths.reduce((a, b) => a + b, 0) + sepW * (parts.length - 1);
    let cursor = (v.width - total) / 2;
    const rowY = y + vh(v, 11.5);

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const entry = totals[i];
      const partW = widths[i];
      if (part === undefined || entry === undefined || partW === undefined) continue;
      const lead = i === 0 && scored;
      // A faction keeps its own colour even when it is winning. Recolouring
      // the leader would cost it its identity AND collide with whichever
      // faction is actually that colour. The leader is already obvious from
      // being first and from carrying the hard shadow.
      drawTabularNumber(ctx, part, cursor, rowY, {
        size,
        // THE YELLOW RULE: a faction colour can be flat yellow, which is
      // ~1.7:1 on paper and simply gone at 3m. textColor() falls back to ink.
      color: scored ? textColor(entry.color) : COLORS.muted,
        font: FONTS.body,
        weight: WEIGHT.black,
        align: 'left',
        shadow: lead ? vh(v, SHADOW.base) : 0,
        letterSpacing: TRACK.number,
      });
      cursor += partW;

      if (i < parts.length - 1) {
        drawText(ctx, sep, cursor, rowY, {
          size,
          color: COLORS.muted,
          font: FONTS.body,
          weight: WEIGHT.black,
          align: 'left',
        });
        cursor += sepW;
      }
    }
  }

  /**
   * PLAN.md §2's frame-budget watchdog, scoped to this screen.
   *
   * There is almost nothing left for it to shed. The two things it used to
   * give up — particle density and silhouette trail length — were both removed
   * by the rebrand (see the note by DECOR), and what remains is flat fills and
   * a two-stroke figure per person. The grid is the only optional thing on the
   * screen, so that is what goes, and it goes silently: the paper stays paper.
   *
   * Attract runs for hours on a laptop that gets hot, and it is the screen
   * nobody is watching closely enough to notice a missing background rule.
   */
  private watchFrameBudget(dt: number): void {
    if (dt > 1 / 45) {
      this.budgetStrikes++;
      if (this.budgetStrikes > 12) {
        this.budgetStrikes = 0;
        this.showGrid = false;
      }
    } else {
      this.budgetStrikes = Math.max(0, this.budgetStrikes - 1);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Faction standings, padded out with the configured factions so a fresh board
 * still shows the mechanic. A band reading "ENGINEERING 0 · CS 0" tells a
 * passer-by there is a side to pick; an empty band tells them nothing.
 */
function factionStandings(): Array<{ name: string; total: number; color: string }> {
  const live = leaderboard.getFactionTotals();
  const seen = new Set(live.map((f) => f.name));
  const out = live.map((f) => ({
    name: shortFaction(f.name),
    total: f.total,
    color: factionColor(FACTIONS.indexOf(f.name as (typeof FACTIONS)[number])),
  }));
  for (const name of FACTIONS) {
    if (out.length >= 4) break;
    if (seen.has(name)) continue;
    out.push({ name: shortFaction(name), total: 0, color: factionColor(FACTIONS.indexOf(name)) });
  }
  return out.slice(0, 4);
}

/** PLAN.md §4 writes this row as "CS", not "COMPUTER SCI". */
const FACTION_SHORT: Record<string, string> = {
  'COMPUTER SCI': 'CS',
};

function shortFaction(name: string): string {
  const mapped = FACTION_SHORT[name];
  if (mapped) return mapped;
  if (name.length <= 11) return name;
  return name
    .split(/\s+/)
    .map((w) => w.charAt(0))
    .join('');
}


