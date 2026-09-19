/**
 * FRUIT NINJA — "the crowd-puller".
 *
 * PLAN.md §3: hands are blades, slice fruit, bombs for drama. Best spectacle on
 * the roster — blade trails and particle juice read beautifully from across a
 * hall, so this is the game that pulls the next person into the queue.
 *
 * Built on real polygon geometry (games/geometry.ts): every fruit is a convex
 * polygon, and a slice splits it along the ACTUAL line your hand travelled,
 * producing two halves with correct shape and inherited physics. That is the
 * difference between "the fruit disappeared" and "I cut that".
 *
 * BRAND: every fruit is a STICKER. Flat brand fill, chunky ink outline, hard
 * shadow straight down, zero blur — the same object as a menu tile or a rank
 * badge, just convex and airborne. The halves keep the outline, so a cut fruit
 * still reads as two stickers rather than two coloured smudges.
 *
 * The bomb is the one object on the roster drawn in SOLID INK. On white paper,
 * among four bright flat colours, a black blob is the most emphatic "no" the
 * brand owns — and it needs no blur to say it.
 *
 * Blades come from pose wrists, not hand landmarks — see core/blades.ts for why.
 */

import { BladeTracker, drawBladeTrail, type Blade } from '../core/blades';
import { POSE } from '../core/types';
import type { TrackedPlayer } from '../core/tracker';
import { GameBase, type SlotRect } from './base';
import {
  makeBlob,
  polygonCentroid,
  splitConvexPolygon,
  segmentCrossesPolygon,
  transformPolygon,
  type Point,
} from './geometry';
import { BURST } from '../engine/particles';
import { audio } from '../engine/audio';
import {
  drawTabularNumber,
  measureTabularNumber,
  stickerPill,
  vh,
} from '../engine/draw';
import type { Viewport } from '../engine/draw';
import { COLORS, FONTS, SHADOW, STROKE, TRACK, WEIGHT } from '../shell/theme';
import { GAME_COLORS } from '../meta/games';
import type { FrameContext } from '../shell/screen';

type BodyKind = 'fruit' | 'bomb';

interface Body {
  kind: BodyKind;
  /** Local-space convex polygon, centred on the origin. */
  poly: Point[];
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  radius: number;
  color: string;
  slot: number;
  /** Halves only: fade-out timer. Whole bodies have life = Infinity. */
  life: number;
  isHalf: boolean;
}

interface Splat {
  x: number;
  y: number;
  r: number;
  color: string;
  life: number;
  seed: number;
}

/** Gravity in screen-heights per second squared — resolution independent. */
const GRAVITY = 1.55;
/** Slices within this window chain into a combo. */
const COMBO_WINDOW_MS = 700;
/** Seconds removed by a bomb. See the note on bombs below. */
const BOMB_TIME_PENALTY = 8;

/**
 * Ceiling on the TOTAL seconds one round may lose to bombs.
 *
 * The time penalty exists, in this file's own words, because it "keeps the
 * round length predictable for the queue (which was the reason for the timer in
 * the first place)". Uncapped it does the exact opposite. MEASURED, five full
 * 45-second solo rounds played by the simulator's swipe:
 *
 *   bombs hit      9      5      3      4      4
 *   round lasted  19.0s  21.5s  22.0s  23.5s  17.5s
 *
 * Under half the advertised turn, every time, and the variation between turns
 * is larger than the turn that is left. Someone who steps up, swings through
 * four bombs and is handed back to the queue after seventeen seconds has not
 * had a go — and PLAN.md §11 asks for failure that is funny, not failure that
 * takes the turn away.
 *
 * 12s is a quarter of the round: the first bomb still bites a full eight
 * seconds, which is the laugh, and the floor under a turn is 33 of the 45
 * seconds no matter how badly it goes. Past the cap a bomb still costs the
 * combo and still costs BOMB_STUN_MS of dead blades, so it never becomes free.
 */
const BOMB_TIME_BUDGET_SEC = 12;
/** Seconds a juice splat survives. It fades out at the end — see drawSplats. */
const SPLAT_DECAY = 0.4;
/** Hard ceiling on splats. Paper has to stay the majority of the screen. */
const MAX_SPLATS = 16;

/**
 * The four brand colours, flat, and nothing else.
 *
 * This list previously carried `redBright` and `greenBright` as well — which
 * are the same two hexes again, so a third of the fruit were duplicates bought
 * at the price of implying a second palette.
 */
const FRUIT_COLORS = [COLORS.red, COLORS.yellow, COLORS.green, COLORS.blue] as const;

/**
 * SOLO: keep the locked body while its TORSO is still at least this fraction of
 * the nearest body's. See `inPlay`.
 *
 * TORSO HEIGHT, NOT BOUNDING-BOX AREA. `scale.unit` is the only measurement
 * here that means "how far away is this person"; a bbox also grows when the
 * arms come out, so ranking by area hands a solo round to whoever is WAVING
 * HARDEST rather than to whoever is nearest. MEASURED, two identical bodies at
 * the same distance, one motionless and one swiping (180 frames, realistic
 * noise):
 *
 *                       scale.unit          bbox area
 *   motionless player   0.2158              0.0998
 *   swiping bystander   0.2156              0.2157   <- 2.16x, same distance
 *
 * The first version of this lock used `area` and therefore picked the
 * bystander every time, which is worse than the bug it was fixing.
 *
 * `unit` is also far quieter: ±0.9% over the same 180 frames. A bystander
 * standing one step further back measures 0.76 of the player. 0.9 sits well
 * clear of the noise and well clear of a genuinely nearer body, so the lock
 * only ever moves when someone has really taken the front.
 */
const SOLO_LOCK_KEEP = 0.9;

/**
 * Wrists must be at least this far apart (torso units) for the left/right
 * exchange test to mean anything — with the hands together the question is
 * undefined and the answer does not matter. Matches `BladeTracker`'s own gate.
 */
const SWAP_APART_TORSOS = 0.35;

/**
 * How far the apparent wrist displacement must SPIKE above this body's own
 * recent displacement before an exchange is believed.
 *
 * WITHOUT THIS THE TEST FIRES ON ORDINARY SWIPING. Both fists sweeping in
 * antiphase cross each other twice per cycle, and on the frame where the
 * separation happens to be about twice the per-frame step, each wrist lands
 * almost exactly where the other one was — which is algebraically
 * indistinguishable from a label swap. MEASURED against the simulator's own
 * latch flag as ground truth, 1200 frames per row:
 *
 *   condition          real flips   exchange test fires   of those, FALSE
 *   idle                    10               10                 0
 *   pump 1.4Hz              10               10                 0
 *   pump 4.5Hz               2                2                 0
 *   swipe 2.2Hz              3               27                25
 *   hostile idle             7                7                 0
 *   hostile swipe 2.2Hz      9               28                22
 *
 * 47 false positives, all of them during exactly the motion this game is made
 * of — and each one costs a quarter-second of blade. So the test also has to
 * see the displacement SPIKE: a real exchange makes both wrists appear to jump
 * the whole distance between them at once, where a crossing sweep is just the
 * speed they were already travelling at.
 *
 *   stay / recent-baseline    false positives      real exchanges
 *   idle                      -                    116 - 223
 *   pump 1.4Hz                -                    10.8 - 22.6
 *   swipe 2.2Hz               1.09 - 1.77          10.2, 10.9  (one at 0.46)
 *   hostile swipe             max 2.02             8.2 - 11.7  (three at ~2)
 *
 * 3.0 is an order of magnitude clear of every false positive measured (max
 * 2.02) and keeps 37 of the 41 real exchanges. The four it gives up all happen
 * mid-swipe, where the player is already swinging and a phantom sweep is worth
 * about what their own swing was worth anyway — the exploit that matters is
 * the motionless one, and there detection is 17 of 17.
 */
const SWAP_STAY_SPIKE = 3;

/**
 * Seconds of blade output discarded after MediaPipe exchanges this body's
 * left/right labels.
 *
 * THE BUG THIS EXISTS FOR, AND WHY IT IS NOT FIXED WHERE IT BELONGS.
 *
 * `BladeTracker.labelsExchanged` already tries to catch a label swap — but it
 * compares `player.landmarks`, which is the ONE EURO FILTERED array. On the
 * frame the labels exchange the filtered wrist has barely moved, so the test
 * can never fire, and the blade instead GLIDES across the body as the filter
 * catches up. MEASURED, one swap event, 60fps, `body` preset:
 *
 *   frame   raw x   filtered x   blade speed (screen-heights/s)   reacquired
 *   58      0.557   0.557        0.007                            no
 *   59      0.443   0.542        1.540                            no      <- swap
 *   60      0.443   0.530        1.314                            no
 *   ...
 *   71      0.443   0.467        0.292                            no
 *   72      0.444   0.464        0.254                            no      <- inert
 *
 * Thirteen consecutive frames (0.22s) of a fast, "genuine", never-reacquired
 * blade sweeping a cutting segment clean across the player's body. Over a
 * 15s round that scored 45 POINTS FROM A MOTIONLESS PLAYER with nothing but
 * `limbSwap` enabled (0/5/10/15/45 across trials), and 73-239 in Rhythm Punch.
 * `labelsExchanged` fired 0 times in 900 such frames.
 *
 * The real fix is six lines in core/blades.ts (read `player.raw` there, and
 * hold the reacquire until the filter has settled) and is reported to the lead.
 * This is the same test done from the game, on RAW landmarks, where it works.
 * It costs nothing once blades.ts is fixed — it simply stops firing.
 *
 * 0.25s covers the measured 0.22s settle with a frame to spare. One Euro's
 * convergence is set by its time constant (~0.16s at the `body` preset's 1Hz
 * floor), not by the frame rate, so this holds at 30fps too.
 */
const SWAP_SETTLE_SEC = 0.25;

/**
 * Milliseconds a slot's blades are dead after that slot eats a bomb.
 *
 * THE PENALTY THAT IS ALWAYS PAID, and in versus the only one. The clock is
 * SHARED between the two halves, so `timeLeft -= 8` took eight seconds of
 * scoring away from the opponent for a mistake they did not make — measured
 * over full 2P rounds, three bombs on one side cut 24s off a 45s round for
 * both players. Confirmed fixed: 2 bombs on slot 0 now cost the shared clock
 * 0.0s.
 *
 * It is also what stops a bomb becoming free in solo once BOMB_TIME_BUDGET_SEC
 * is spent.
 *
 * 1.2s is long enough to be visibly a penalty and to read from the queue, and
 * short enough that it is the joke rather than the end of the turn — roughly
 * one and a half fruit arcs at the end-of-round spawn rate.
 */
const BOMB_STUN_MS = 1200;

/**
 * Half the width of the band fruit is thrown through, in TORSO UNITS either
 * side of the player's own body centre.
 *
 * FRUIT USED TO BE THROWN AT A FRACTION OF THE SLOT RECT, which is a piece of
 * screen and has nothing to do with where a person's arms can go. Nobody stands
 * dead centre of their half — and in versus, two people politely leaving each
 * other room both stand off-centre, in the SAME direction relative to their own
 * half.
 *
 * MEASURED, 2P, both bodies pushed off-centre by the simulator's `edgeBias`
 * (6 rounds each, 10s, identical play on both sides):
 *
 *   spawn relative to      fruit sliced, slot 0   slot 1
 *   the slot rect          13.0                   6.6     <- 2x, same input
 *   the slot rect, edgeBias disabled
 *                          11.2                   11.3
 *
 * So the 2x gap was entirely "one player happened to be standing nearer the
 * middle of their own half". That is not a skill difference, and in a versus
 * game shown side by side on a TV it is the only thing the crowd is judging.
 *
 * 1.45 torso units is between a comfortable reach (~1.25, the figure Rhythm
 * Punch uses for its outer targets) and a full stretch (shoulder half-width
 * ~0.5 plus an arm of ~1.07 = ~1.57, from the T-pose note in core/gestures.ts).
 * Fruit Ninja is the one game on the roster that WANTS a big swing, so it sits
 * at the top of the comfortable range rather than the middle of it — and the
 * fruit then arcs and drifts outward from there anyway.
 *
 * VERIFIED WHERE IT IS ACTUALLY SLICEABLE, not merely where it spawns, because
 * the drift above is the part that could put it out of reach. Measured over a
 * full solo round, every fruit's furthest offset from the player's own body
 * centre while inside the vertical band a standing player's hands cover
 * (0.18-0.62 of screen height), in torso units:
 *
 *   n = 160   p10 0.14   p50 0.56   p90 1.10   max 1.42
 *   beyond a comfortable reach (1.25):  3.1%
 *   beyond a full stretch (1.57):       0%
 *
 * So the drift does not defeat the band. A playtester reported "I legit
 * couldn't reach most" of the fruit — that was against the OLD placement,
 * which threw at a fraction of the slot rect and had nothing to do with where
 * a person's arms can go. Re-measure this table if the arc or the drift
 * changes; it is the only thing standing between the band and that report.
 */
const REACH_HALF_TORSOS = 1.45;

export class FruitNinjaGame extends GameBase {
  private blades = new BladeTracker();
  private bodies: Body[] = [];
  private splats: Splat[] = [];

  private points = [0, 0];
  private sliced = [0, 0];
  private combo = [0, 0];
  private lastSliceAt = [0, 0];
  private bombsHit = [0, 0];

  private spawnTimer = 0;
  private seed = 1;
  private stunUntil = [0, 0];
  /** Seconds this round has already lost to bombs. See BOMB_TIME_BUDGET_SEC. */
  private bombSeconds = 0;
  /** Screen-space body centre and torso size per slot. See REACH_HALF_TORSOS. */
  private bodyX: Array<number | null> = [null, null];
  private bodyUnit = [0, 0];

  /** Tracker id of the body this solo round belongs to. See `inPlay`. */
  private soloLock = -1;
  /**
   * Previous frame's RAW wrists plus this body's recent per-frame displacement
   * baseline, per tracker id. `step < 0` means "not seeded yet".
   */
  private rawWrists = new Map<
    number,
    { lx: number; ly: number; rx: number; ry: number; step: number }
  >();
  /** `fc.now` until which this body's blades are fiction. See `bladeBodies`. */
  private swapUntil = new Map<number, number>();

  constructor() {
    super({
      gameId: 'fruitninja',
      title: 'FRUIT NINJA',
      tagline: '<SLICE THE FRUIT — DODGE THE BOMBS>',
      visionMode: 'pose',
      maxPlayers: 2,
      roundSeconds: 45,
      color: GAME_COLORS.fruitninja,
      supportsVersus: true,
    });
  }

  protected onStart(): void {
    this.bodies = [];
    this.splats = [];
    this.points = [0, 0];
    this.sliced = [0, 0];
    this.combo = [0, 0];
    this.lastSliceAt = [0, 0];
    this.bombsHit = [0, 0];
    this.spawnTimer = 0.6;
    this.seed = 1;
    this.stunUntil = [0, 0];
    this.bombSeconds = 0;
    this.bodyX = [null, null];
    this.bodyUnit = [0, 0];
    // Per-round, not per-mount: a second round must not inherit the first
    // round's locked body, its stale raw wrists or a stun that never expired.
    // Latched state surviving `onStart` is this codebase's recurring bug class.
    this.soloLock = -1;
    this.rawWrists.clear();
    this.swapUntil.clear();
    this.blades.reset();
  }

  protected scoreFor(slot: number): number {
    return this.points[slot] ?? 0;
  }

  protected primaryLabel(): string {
    return 'SCORE';
  }

  /* ---------------- whose body is this? ---------------- */

  /**
   * THE BODIES A SOLO ROUND IS ALLOWED TO BE PLAYED BY: exactly one.
   *
   * `playerCount` is frozen when the round starts, but the TRACKER keeps
   * running at `maxPlayers` — so a friend leaning into frame mid-round is a
   * second confirmed `TrackedPlayer` in a round that still believes it is solo.
   * Every one of the four games on this track then read input from BOTH bodies.
   *
   * MEASURED, player standing completely still while a bystander plays for 10s:
   *   Fruit Ninja 45, Balloon Pop 42, Rhythm Punch 72, 67 Speed 178.
   *
   * 67 Speed is the worst of those because both bodies drove the same
   * `RepCounter`: its solo control scored 91 for the same play, so the
   * interleaving nearly DOUBLED the count. At a club fair somebody standing
   * behind the player waving is a certainty, and "my score went up while I was
   * standing still" is indistinguishable from a broken game.
   *
   * Locking to the NEAREST body — biggest torso — is the same rule the
   * crowd-rejection gate is built on: nearest to the camera is the person
   * actually playing. See SOLO_LOCK_KEEP for why it is torso and not bbox.
   */
  private inPlay(players: TrackedPlayer[]): TrackedPlayer[] {
    if (players.length <= 1) {
      this.soloLock = players[0]?.id ?? -1;
      return players;
    }

    // ONE BODY PER SLOT, the NEAREST one — biggest torso, not biggest bbox.
    // See SOLO_LOCK_KEEP. In a solo round every body maps to slot 0, so this
    // reduces to "the player, not the person behind them"; in versus it also
    // covers the transient where the tracker has two bodies reporting the same
    // slot, which credits one half's input to both.
    const best = new Map<number, TrackedPlayer>();
    for (const p of players) {
      const slot = this.slotOf(p);
      const held = best.get(slot);
      if (!held || p.scale.unit > held.scale.unit) best.set(slot, p);
    }

    // Hysteresis on the solo lock, for the same reason every gate in
    // core/gestures.ts has one: two people at the same distance measure within
    // a percent of each other and a bare comparison hands the round back and
    // forth 30 times a second, which reads as the game ignoring you. Ties go to
    // whoever the tracker saw first, which is the person who started the round.
    if (this.playerCount === 1) {
      const top = best.get(0)!;
      const held = players.find((p) => p.id === this.soloLock);
      if (held && held.scale.unit >= top.scale.unit * SOLO_LOCK_KEEP) best.set(0, held);
      this.soloLock = best.get(0)!.id;
    }

    return [...best.values()];
  }

  /**
   * Of those, the ones whose blades are not currently fiction.
   *
   * See SWAP_SETTLE_SEC. A body dropped here simply is not passed to
   * `BladeTracker.update`, which is the supported way to say "this hand is not
   * observable right now": its blades go invisible, so nothing scores off them
   * and nothing draws them in a place the hand is not, and when the body comes
   * back the tracker's own `wasHidden` path snaps cleanly instead of sweeping
   * the gap.
   */
  private bladeBodies(players: TrackedPlayer[], now: number): TrackedPlayer[] {
    const live = new Set<number>();
    const out: TrackedPlayer[] = [];

    for (const p of players) {
      live.add(p.id);
      const lw = p.raw[POSE.LEFT_WRIST];
      const rw = p.raw[POSE.RIGHT_WRIST];
      const unit = p.scale.unit;

      if (lw && rw && unit > 0) {
        const prev = this.rawWrists.get(p.id);
        let step = prev?.step ?? -1;

        if (prev) {
          // Isotropic: landmark x is normalised by frame WIDTH and y by HEIGHT,
          // so x has to be scaled by the aspect before the two can be combined
          // or compared against a torso height. (ARCHITECTURE.md; the same
          // correction LaneDetector and TPoseDetector needed.)
          const a = p.scale.aspect;
          const d = (ax: number, ay: number, bx: number, by: number): number =>
            Math.hypot((ax - bx) * a, ay - by) / unit;

          const apart = d(prev.lx, prev.ly, prev.rx, prev.ry);
          const stay = d(lw.x, lw.y, prev.lx, prev.ly) + d(rw.x, rw.y, prev.rx, prev.ry);
          const swap = d(lw.x, lw.y, prev.rx, prev.ry) + d(rw.x, rw.y, prev.lx, prev.ly);

          const exchanged =
            step >= 0 &&
            apart >= SWAP_APART_TORSOS &&
            swap < stay * 0.5 &&
            stay >= Math.max(1e-3, step) * SWAP_STAY_SPIKE;

          if (exchanged) this.swapUntil.set(p.id, now + SWAP_SETTLE_SEC * 1000);

          // The baseline deliberately EXCLUDES the spike frame. Folding a swap
          // into it lifts it by an order of magnitude, and the next swap a
          // second later would then be measured against the last one and go
          // unnoticed. ~10-frame time constant: long enough to be a baseline,
          // short enough to follow a player winding up.
          if (step < 0) step = stay;
          else if (!exchanged) step = step * 0.9 + stay * 0.1;
        }

        this.rawWrists.set(p.id, { lx: lw.x, ly: lw.y, rx: rw.x, ry: rw.y, step });
      }

      if (now >= (this.swapUntil.get(p.id) ?? 0)) out.push(p);
    }

    // A kiosk runs for hours; ids never repeat, so these maps would grow for
    // the whole event.
    for (const id of this.rawWrists.keys()) {
      if (!live.has(id)) {
        this.rawWrists.delete(id);
        this.swapUntil.delete(id);
      }
    }

    return out;
  }

  /** The slot a blade or body scores into. Solo is ALWAYS slot 0 — see below. */
  private slotOf(of: { slot: number }): number {
    return this.playerCount > 1 ? Math.max(0, Math.min(1, of.slot)) : 0;
  }

  /* ---------------- simulation ---------------- */

  protected onTick(fc: FrameContext, players: TrackedPlayer[], dt: number): void {
    if (!this.proj) return;

    const mine = this.inPlay(players);
    const project = (nx: number, ny: number) => this.proj!.point({ x: nx, y: ny });
    const blades = this.blades.update(this.bladeBodies(mine, fc.now), project, dt, fc.now);

    this.updateAnchors(mine);

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawn(fc);
      // Ramps from a lazy lob at the start to a steady stream by the end, so
      // the round builds instead of running flat.
      const progress = 1 - this.timeLeft / this.roundTotal;
      this.spawnTimer = (0.95 - progress * 0.55) * (this.playerCount > 1 ? 0.75 : 1);
    }

    this.stepBodies(fc, dt);
    this.resolveSlices(fc, blades);
    this.expireCombos(fc.now);

    for (let i = this.splats.length - 1; i >= 0; i--) {
      const s = this.splats[i]!;
      s.life -= dt * SPLAT_DECAY;
      if (s.life <= 0) this.splats.splice(i, 1);
    }
  }

  /**
   * Where each slot's player is standing, smoothed, in screen pixels.
   *
   * Heavily eased for the same reason Rhythm Punch eases its lane anchor: a
   * throw line that twitches with tracking noise scatters fruit unpredictably,
   * and the player has no way to tell that from bad luck.
   */
  private updateAnchors(players: readonly TrackedPlayer[]): void {
    if (!this.proj) return;
    for (const p of players) {
      const ls = p.landmarks[POSE.LEFT_SHOULDER];
      const rs = p.landmarks[POSE.RIGHT_SHOULDER];
      if (!ls || !rs || !p.scale.valid) continue;

      const slot = this.slotOf(p);
      const cx = this.proj.x((ls.x + rs.x) / 2);
      const unit = this.proj.len(p.scale.unit);

      const heldX = this.bodyX[slot] ?? null;
      this.bodyX[slot] = heldX === null ? cx : heldX + (cx - heldX) * 0.1;
      const heldU = this.bodyUnit[slot] || unit;
      this.bodyUnit[slot] = heldU + (unit - heldU) * 0.1;
    }
  }

  /**
   * The horizontal band this slot's fruit is thrown through, in screen pixels.
   * Centred on the body when one is anchored, always clamped inside the slot.
   * See REACH_HALF_TORSOS.
   */
  private reachBand(slot: number, rect: SlotRect, radius: number): { min: number; max: number } {
    const lo = rect.x + radius;
    const hi = rect.x + rect.width - radius;

    const cx = this.bodyX[slot] ?? null;
    const unit = this.bodyUnit[slot] ?? 0;
    if (cx === null || unit <= 0) {
      return { min: rect.x + rect.width * 0.18, max: rect.x + rect.width * 0.82 };
    }

    const half = unit * REACH_HALF_TORSOS;
    // Shift rather than shrink at the edge of a slot, so a player standing off
    // to one side still gets a full spread — all of it on the side they can
    // reach.
    let min = cx - half;
    let max = cx + half;
    if (min < lo) {
      max = Math.min(hi, max + (lo - min));
      min = lo;
    }
    if (max > hi) {
      min = Math.max(lo, min - (max - hi));
      max = hi;
    }
    return { min: Math.min(min, max), max: Math.max(min, max) };
  }

  private spawn(fc: FrameContext): void {
    const { v } = fc;
    for (let slot = 0; slot < this.playerCount; slot++) {
      const rect = this.slotRect(v, slot);
      const progress = 1 - this.timeLeft / this.roundTotal;

      // Never in the first few seconds — a bomb before the player has worked
      // out the game is pure punishment.
      const bombChance = this.timeLeft > this.roundTotal - 6 ? 0 : 0.1 + progress * 0.12;
      const count = 1 + (Math.random() < 0.3 + progress * 0.3 ? 1 : 0);

      for (let i = 0; i < count; i++) {
        const isBomb = Math.random() < bombChance;
        const radius = v.height * (isBomb ? 0.045 : 0.05 + Math.random() * 0.022);

        // Thrown through the PLAYER's reach, not through a fraction of the
        // slot — see REACH_HALF_TORSOS.
        const band = this.reachBand(slot, rect, radius);
        const x = band.min + Math.random() * (band.max - band.min);
        const y = v.height + radius * 2;

        // Aim the arc so the apex lands in the upper-middle of the slot: that
        // is where hands naturally are, and it keeps fruit off the HUD.
        const apex = v.height * (0.2 + Math.random() * 0.16);
        const rise = y - apex;
        const vy = -Math.sqrt(2 * GRAVITY * v.height * rise) / v.height;
        // Drift back toward the player, not toward the middle of their half.
        // The two are the same thing only for someone standing dead centre of
        // their slot, which nobody does.
        const home = this.bodyX[slot] ?? rect.centerX;
        const towardHome = (home - x) / rect.width;
        const vx = (towardHome * 0.45 + (Math.random() - 0.5) * 0.28) * v.height * 0.55;

        this.bodies.push({
          kind: isBomb ? 'bomb' : 'fruit',
          poly: makeBlob(radius, isBomb ? 10 : 9, this.seed++),
          x,
          y,
          vx,
          vy: vy * v.height,
          angle: Math.random() * Math.PI * 2,
          spin: (Math.random() - 0.5) * 3.4,
          radius,
          color: isBomb
            ? COLORS.ink
            : FRUIT_COLORS[Math.floor(Math.random() * FRUIT_COLORS.length)]!,
          slot,
          life: Infinity,
          isHalf: false,
        });
      }
    }
  }

  private stepBodies(fc: FrameContext, dt: number): void {
    const { v } = fc;
    const g = GRAVITY * v.height;

    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i]!;
      b.vy += g * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.angle += b.spin * dt;

      if (b.isHalf) {
        b.life -= dt;
        b.vx *= 0.995;
      }

      const offscreen = b.y - b.radius > v.height + v.height * 0.1;
      if (offscreen || b.life <= 0) this.bodies.splice(i, 1);
    }
  }

  private resolveSlices(fc: FrameContext, blades: Blade[]): void {
    for (const blade of blades) {
      if (!blade.active) continue;
      // A blade that SNAPPED rather than travelled has no swipe to test. Its
      // segment is fiction — a returning dropout, or MediaPipe exchanging this
      // player's left/right labels when they turn side-on. Measured: a resting
      // hand scored while the labels flickered.
      if (blade.reacquired) continue;

      // SOLO ROUNDS SCORE INTO SLOT 0, WHOEVER THE TRACKER THINKS YOU ARE.
      //
      // The tracker re-sorts slots by screen position every frame while
      // `playerCount` stays frozen for the round, so a bystander standing to
      // the player's left silently makes the PLAYER slot 1. Every slice then
      // credited `points[1]`, which nothing displays, while `scoreFor(0)` — the
      // number on screen and the one submitted to the leaderboard — sat still.
      // The player is cutting fruit, watching halves fly, and scoring zero.
      //
      // Same root cause as the Balloon Pop arm-line bug: a solo game must not
      // index anything by a slot that can move underneath it.
      const slot = this.slotOf(blade);

      // Blades are dead for a moment after this slot eats a bomb. See
      // BOMB_STUN_MS — the versus penalty, which costs the opponent nothing.
      if (fc.now < (this.stunUntil[slot] ?? 0)) continue;

      // Everything this blade cut in THIS frame — a single fast swipe through
      // three fruit must register as a 3-chain, not three separate slices.
      const cutThisSwipe: Body[] = [];

      for (let i = this.bodies.length - 1; i >= 0; i--) {
        const b = this.bodies[i]!;
        if (b.isHalf) continue;
        // In versus, you can only cut your own half's fruit.
        if (this.playerCount > 1 && b.slot !== slot) continue;

        const world = transformPolygon(b.poly, b.x, b.y, b.angle);
        const p1 = { x: blade.px, y: blade.py };
        const p2 = { x: blade.x, y: blade.y };
        if (!segmentCrossesPolygon(p1, p2, world)) continue;

        this.bodies.splice(i, 1);
        cutThisSwipe.push(b);

        if (b.kind === 'bomb') this.detonate(fc, b, slot);
        else this.sliceFruit(fc, b, world, p1, p2);
      }

      if (cutThisSwipe.length > 0) {
        const fruit = cutThisSwipe.filter((b) => b.kind === 'fruit');
        if (fruit.length > 0) this.awardSlice(fc, slot, fruit, blade);
      }
    }
  }

  /** Splits the fruit along the real blade line and spawns two halves. */
  private sliceFruit(
    fc: FrameContext,
    b: Body,
    world: Point[],
    p1: Point,
    p2: Point
  ): void {
    const { v } = fc;
    const halves = splitConvexPolygon(world, p1, p2);

    // Separation is perpendicular to the cut, so the halves fall apart along
    // the line you actually swung through.
    const cutAngle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const nx = -Math.sin(cutAngle);
    const ny = Math.cos(cutAngle);
    const push = v.height * 0.16;

    if (halves) {
      halves.forEach((half, idx) => {
        const c = polygonCentroid(half);
        const dir = idx === 0 ? 1 : -1;
        this.bodies.push({
          kind: 'fruit',
          poly: half.map((p) => ({ x: p.x - c.x, y: p.y - c.y })),
          x: c.x,
          y: c.y,
          vx: b.vx + nx * push * dir,
          vy: b.vy + ny * push * dir - v.height * 0.05,
          angle: 0,
          spin: b.spin + dir * 2.6,
          radius: b.radius * 0.6,
          color: b.color,
          slot: b.slot,
          life: 1.4,
          isHalf: true,
        });
      });
    }

    BURST.splat(this.particles, b.x, b.y, b.color, b.radius / (v.height * 0.05));
    // Ink, not white. The playfield is paper now — white sparks on white are a
    // particle budget spent on nothing.
    BURST.spark(this.particles, b.x, b.y, cutAngle, COLORS.ink, 0.6);

    this.splats.push({
      x: b.x,
      y: b.y,
      r: b.radius * 1.1,
      color: b.color,
      life: 1,
      seed: this.seed++,
    });
    if (this.splats.length > MAX_SPLATS) this.splats.shift();
  }

  /**
   * BOMBS COST TIME, THEY DO NOT END THE ROUND.
   *
   * PLAN.md §3 originally had a bomb end the run. Deliberate deviation: at a
   * stall, someone who steps up, swings once and hits a bomb at four seconds
   * has had their turn taken away, feels cheated, and the crowd gets no show.
   * A time penalty keeps the round length predictable for the queue (which was
   * the reason for the timer in the first place) and turns the bomb into the
   * biggest laugh in the game rather than the end of it.
   *
   * PLAN.md §11: "failure should be funny, never punishing."
   *
   * IN VERSUS THE CLOCK IS NOT YOURS TO SPEND. `timeLeft` is one shared round
   * clock, so the time penalty was charged to BOTH players — measured, three
   * bombs on one side took 24s off a 45s round for the opponent as well, for a
   * mistake they did not make. There the penalty is a per-slot blade stun
   * instead: same joke, same lost combo, and it lands only on the person who
   * swung at a bomb. See BOMB_STUN_MS.
   */
  private detonate(fc: FrameContext, b: Body, slot: number): void {
    const { v } = fc;
    this.bombsHit[slot] = (this.bombsHit[slot] ?? 0) + 1;
    this.combo[slot] = 0;

    // Always. In versus it is the whole penalty; in solo it is what keeps a
    // bomb costing something after the clock budget is gone.
    this.stunUntil[slot] = fc.now + BOMB_STUN_MS;

    const spend =
      this.playerCount > 1
        ? 0
        : Math.min(BOMB_TIME_PENALTY, BOMB_TIME_BUDGET_SEC - this.bombSeconds);
    if (spend > 0) {
      this.bombSeconds += spend;
      this.timeLeft = Math.max(0.6, this.timeLeft - spend);
    }

    audio.play('bomb');
    this.juice.shake(0.75);
    this.juice.hitStop(110);
    this.juice.flash(COLORS.red, 0.6, 3);
    this.juice.chromatic(6);

    this.particles.emit({
      x: b.x,
      y: b.y,
      count: 70,
      color: COLORS.red,
      speed: v.height * 0.9,
      speedVariance: v.height * 0.7,
      size: 7,
      life: 0.9,
      gravity: v.height * 0.8,
      drag: 0.93,
      streak: true,
    });
    // Ink debris rather than yellow: two brand colours per component, and the
    // red already carries the alarm. Ink also reads on paper; yellow does not.
    this.particles.emit({
      x: b.x,
      y: b.y,
      count: 30,
      color: COLORS.ink,
      speed: v.height * 0.5,
      size: 10,
      life: 0.5,
      gravity: 0,
      drag: 0.9,
    });

    this.popups.spawn(
      spend > 0 ? `-${Math.round(spend)}s` : '<BLADES OUT!>',
      b.x,
      b.y,
      COLORS.red,
      vh(v, spend > 0 ? 6 : 4.4),
      1.2
    );
  }

  private awardSlice(fc: FrameContext, slot: number, fruit: Body[], blade: Blade): void {
    const { v } = fc;
    const chain = fruit.length;

    // COMBO COUNTS MULTI-CUTS, NOT SLICES.
    //
    // It used to increment on every slice, and with a 700ms window that is
    // trivially easy to keep alive by mashing. Measured over full rounds:
    // narrow-fast spam scored 225 against 390 for deliberate wide slicing —
    // and at the combo cap a single fruit was worth 55 against 75 for a
    // 2-chain, so mindless mashing earned ~75% of what the "impressive move"
    // earned. The thing the game is supposed to reward was barely rewarded.
    //
    // Now only a genuine chain (2+ fruit in one swipe) raises the combo. A
    // single slice still REFRESHES the window, so a good run is not punished
    // for the occasional lone fruit — it just does not climb.
    const prevCombo = this.combo[slot] ?? 0;
    const combo = chain >= 2 ? prevCombo + 1 : prevCombo;
    this.combo[slot] = combo;
    this.lastSliceAt[slot] = fc.now;
    this.sliced[slot] = (this.sliced[slot] ?? 0) + chain;

    // Multi-cut in one swipe is worth far more than the same fruit cut singly —
    // that is the skill the game rewards and the thing worth showing off.
    const base = 10 * chain;
    const chainBonus = chain > 1 ? base * (chain - 1) : 0;
    const comboBonus = Math.min(combo - 1, 9) * 5 * chain;
    const gained = base + chainBonus + comboBonus;

    this.points[slot] = (this.points[slot] ?? 0) + gained;
    this.scores[slot]?.set(this.points[slot]!);

    // Rising pitch with the combo. PLAN.md §5: highest-value audio investment.
    audio.play('slice', 0.9 + Math.min(1.1, combo * 0.09 + (chain - 1) * 0.18));
    this.juice.shake(0.06 + Math.min(0.18, chain * 0.05 + combo * 0.01));
    if (chain > 1) this.juice.hitStop(26 * chain);

    const cx = fruit.reduce((s, f) => s + f.x, 0) / chain;
    const cy = fruit.reduce((s, f) => s + f.y, 0) / chain;

    // Every popup is ink. PopupLayer still blurs its own fill (engine/juice.ts,
    // not ours), and flat yellow type on white paper is the one brand pairing
    // that disappears at three metres.
    // THE CHAIN IS THE THING PEOPLE CAME FOR. Playtest: "they love combo
    // chains." So the ESCALATION is what gets the budget — every extra fruit in
    // one swipe has to look and sound bigger than the last, from the back of
    // the queue, without anyone reading a number.
    //
    // The SCORING IS DELIBERATELY UNTOUCHED. It was measured and argued for
    // above, the leaderboard is live across two days, and there is nothing
    // wrong with it — what was missing is that a 2-chain and a 5-chain got the
    // same word, the same size and the same flash.
    if (chain > 1) {
      // A word beats a number at 3m: you read "TRIPLE" in one glance, where
      // "3 CHAIN" is two tokens and a unit.
      const CHAIN_WORDS = ['', '', '<DOUBLE!>', '<TRIPLE!>', '<QUAD!>', '<FIVE!>'];
      const word = CHAIN_WORDS[chain] ?? `<${chain} CHAIN!>`;
      const big = Math.min(chain, 6);
      this.popups.spawn(word, cx, cy - vh(v, 4), COLORS.ink, vh(v, 4.2 + big * 0.7), 1.1 + big * 0.06);
      this.juice.flash(COLORS.yellow, 0.1 + big * 0.05, 6);
      // Past a triple it stops being a slice and becomes an event: confetti in
      // all four brand colours, the app's own "that was special" gesture.
      if (chain >= 3) this.celebrateAt(cx, cy);
    }
    if (combo >= 3) {
      this.popups.spawn(`x${combo}`, blade.x, blade.y - vh(v, 3), COLORS.ink, vh(v, 3.6));
    }
    this.popups.spawn(`+${gained}`, cx, cy, COLORS.ink, vh(v, 3.4));
  }

  private expireCombos(now: number): void {
    for (let slot = 0; slot < this.playerCount; slot++) {
      if (now - (this.lastSliceAt[slot] ?? 0) > COMBO_WINDOW_MS) this.combo[slot] = 0;
    }
  }

  /* ---------------- rendering ---------------- */

  protected onRender(fc: FrameContext, _players: TrackedPlayer[]): void {
    const { ctx, v } = fc;

    this.drawSplats(ctx);

    for (const b of this.bodies) this.drawBody(ctx, b, v);

    // The trail is INK in both solo and versus. On paper it reads as a pen
    // stroke, which is exactly the brand; and in versus each player is already
    // confined to their own half, so a colour is not what disambiguates them.
    // (Yellow — PLAYER_COLORS[0] — on white paper is invisible at 3m.)
    const maxWidth = vh(v, 1.5);
    for (const blade of this.blades.all) {
      drawBladeTrail(ctx, blade, COLORS.ink, maxWidth);
    }
  }

  /**
   * A body as a sticker: hard ink shadow straight down, flat fill, chunky ink
   * outline. Three fills and a stroke, no shadow state, no blur.
   */
  private drawBody(ctx: CanvasRenderingContext2D, b: Body, v: Viewport): void {
    const world = transformPolygon(b.poly, b.x, b.y, b.angle);
    if (world.length < 3) return;

    // The one permitted use of alpha: fading a WHOLE element out over time.
    // Not a tint — a half at full life is the same flat colour as the fruit it
    // came from.
    const alpha = b.isHalf ? Math.min(1, b.life / 0.5) : 1;
    const stroke = vh(v, b.isHalf ? STROKE.thin : STROKE.base);
    const drop = vh(v, b.isHalf ? SHADOW.none : SHADOW.base);

    const path = (dy: number): void => {
      ctx.beginPath();
      ctx.moveTo(world[0]!.x, world[0]!.y + dy);
      for (let i = 1; i < world.length; i++) ctx.lineTo(world[i]!.x, world[i]!.y + dy);
      ctx.closePath();
    };

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowBlur = 0;
    ctx.lineJoin = 'round';

    if (drop > 0) {
      ctx.fillStyle = COLORS.ink;
      path(drop);
      ctx.fill();
    }

    ctx.fillStyle = b.color;
    path(0);
    ctx.fill();

    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = stroke;
    path(0);
    ctx.stroke();

    if (b.kind === 'bomb') this.drawBombMark(ctx, b, v);

    ctx.restore();
  }

  /**
   * What makes a bomb unmistakable with no blur at all.
   *
   * Solid ink body (drawn by drawBody), a flat red warning ring, and a paper ✕
   * struck through it. Ink-on-paper against four bright flat fruit is already
   * the strongest contrast the palette can make; the ring is the single brand
   * colour this component is allowed, and red is the brand's own "closed".
   *
   * The ✕ is two stroked lines rather than a glyph, so it cannot depend on
   * Archivo carrying U+2715 and it stays crisp at any TV resolution.
   */
  private drawBombMark(ctx: CanvasRenderingContext2D, b: Body, v: Viewport): void {
    const ring = b.radius * 1.34;
    const arm = b.radius * 0.44;

    ctx.save();
    ctx.shadowBlur = 0;
    ctx.lineCap = 'round';

    ctx.strokeStyle = COLORS.red;
    ctx.lineWidth = vh(v, STROKE.thick);
    ctx.beginPath();
    ctx.arc(b.x, b.y, ring, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = COLORS.paper;
    ctx.lineWidth = Math.max(2, b.radius * 0.22);
    ctx.beginPath();
    ctx.moveTo(b.x - arm, b.y - arm);
    ctx.lineTo(b.x + arm, b.y + arm);
    ctx.moveTo(b.x + arm, b.y - arm);
    ctx.lineTo(b.x - arm, b.y + arm);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Persistent juice on the screen. PLAN.md §3.
   *
   * Flat fruit colour at FULL opacity — the old version drew every splat at
   * 20% and under, which is a tint of a brand colour. Instead they are smaller,
   * capped at MAX_SPLATS, and fade out only in their last moments, which is
   * alpha used as a fade over time rather than as a colour treatment.
   */
  private drawSplats(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.shadowBlur = 0;
    for (const s of this.splats) {
      ctx.globalAlpha = Math.min(1, s.life * 3);
      ctx.fillStyle = s.color;
      const blobs = 5;
      for (let i = 0; i < blobs; i++) {
        const a = (i / blobs) * Math.PI * 2 + s.seed;
        const d = s.r * (0.3 + ((Math.sin(s.seed * 12.9 + i * 78.2) + 1) / 2) * 0.9);
        const rr = s.r * (0.22 + ((Math.sin(s.seed * 4.1 + i * 33.7) + 1) / 2) * 0.3);
        ctx.beginPath();
        ctx.arc(s.x + Math.cos(a) * d, s.y + Math.sin(a) * d, rr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /**
   * A number in a sticker pill, with tabular digits.
   *
   * See the identical note in games/sixtyseven.ts: `labelPill` sets its label
   * in proportional figures, so a live counter jitters sideways as it changes.
   * This belongs in engine/draw.ts as a shared `numberPill`.
   */
  private numberPill(
    ctx: CanvasRenderingContext2D,
    v: Viewport,
    cx: number,
    cy: number,
    text: string,
    h: number,
    fill: string
  ): void {
    const size = h * 0.5;
    const w = measureTabularNumber(ctx, text, size, WEIGHT.black, FONTS.body) + h * 0.8;

    stickerPill(ctx, v, cx - w / 2, cy - h / 2, w, h, {
      fill,
      outline: COLORS.ink,
      outlineWidth: vh(v, STROKE.base),
      shadow: vh(v, SHADOW.base),
    });
    drawTabularNumber(ctx, text, cx, cy, {
      size,
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.black,
      letterSpacing: TRACK.number,
    });
  }

  protected onRenderHud(fc: FrameContext, slot: number, rect: SlotRect): void {
    const { ctx, v } = fc;
    const combo = this.combo[slot] ?? 0;
    const sliced = this.sliced[slot] ?? 0;
    const stunned = fc.now < (this.stunUntil[slot] ?? 0);

    // A dead blade with no explanation reads as a broken game, which is the one
    // thing a stall cannot afford. Red, where the combo pill would be, so the
    // player is already looking at it.
    if (stunned) {
      this.numberPill(
        ctx,
        v,
        rect.centerX,
        this.hudBottom(v) + vh(v, 3.2),
        'BLADES OUT',
        vh(v, 4.6),
        COLORS.red
      );
    }

    if (!stunned && combo >= 2) {
      // A yellow action pill, straight — it carries a number, so DESIGN.md
      // says it does not tilt. The scale pulse is motion, not a colour change,
      // and it is the only thing left of the old blurred yellow glow.
      const pulse = 1 + Math.sin(fc.time * 14) * 0.06;
      ctx.save();
      // BELOW the HUD band, not through it. At 27vh this 4.6vh pill spans
      // 24.7-29.3 and the chase line sits at 26 — so the live "thing to beat",
      // which PLAN.md §2 calls the whole addiction mechanic, was covered by
      // the combo badge exactly when the player was doing well enough to earn
      // one. Anchored to `hudBottom()` so it tracks the band rather than
      // duplicating a number that has already drifted once.
      ctx.translate(rect.centerX, this.hudBottom(v) + vh(v, 3.2));
      ctx.scale(pulse, pulse);
      this.numberPill(ctx, v, 0, 0, `COMBO x${combo}`, vh(v, 4.6), COLORS.yellow);
      ctx.restore();
    }

    drawTabularNumber(ctx, `${sliced} SLICED`, rect.centerX, v.height - vh(v, 3), {
      size: vh(v, 2),
      color: COLORS.ink,
      font: FONTS.body,
      weight: WEIGHT.bold,
      letterSpacing: TRACK.pill,
    });
  }
}
